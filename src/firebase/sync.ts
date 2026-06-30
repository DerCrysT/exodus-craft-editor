/**
 * Firebase Sync — Granular writes + Workspace Locking
 *
 * LOCKING:
 *   workspaces/{wsKey}/__lock = { uid, displayName, since }
 *   Wer zuerst da ist, hält den Lock.
 *   onDisconnect → Lock wird automatisch freigegeben.
 *   Andere User sind read-only solange Lock aktiv ist.
 *
 * WRITES (nur vom Lock-Inhaber):
 *   nodes/{nodeId}   → einzeln schreiben/löschen
 *   edges/{edgeId}   → einzeln schreiben/löschen
 *   jsonData         → Formular-Daten
 *
 * READS (alle User):
 *   onValue auf nodes/, edges/, jsonData → sofort angezeigt
 */

import { store } from "../state/AppStore";
import { bus } from "../state/EventEmitter";
import {
  isEnabled, saveLibraryToFirebase, loadLibraryFromFirebase,
  onLibraryUpdate, getFirebaseState, subscribeLibrary, updatePresence,
} from "../firebase/service";
import {
  getDatabase, ref, set, remove, get, onValue, off,
  onDisconnect, serverTimestamp,
} from "firebase/database";
import { getApps } from "firebase/app";
import type { CraftNode, CraftEdge, WorkbenchJSON, LibraryItem } from "../types/index";

// ── DB helper ──────────────────────────────────────────────
function db() {
  const apps = getApps();
  return apps.length ? getDatabase(apps[0]) : null;
}

function fk(k: string): string {
  return k.replace(/[.#$[\]/]/g, "_");
}

function wsBase(): string {
  return `workspaces/${fk(store.currentWorkspaceKey())}`;
}

// ── State ──────────────────────────────────────────────────
let libSubscribed = false;
let libAutoSave:   ReturnType<typeof setInterval> | null = null;
let applyingRemote = false;

// Lock state
let weHoldLock   = false;
let lockWsKey    = "";   // which workspace we're locked into

// Unsubscribers
let unsubNodes: (() => void) | null = null;
let unsubEdges: (() => void) | null = null;
let unsubJson:  (() => void) | null = null;
let unsubLock:  (() => void) | null = null;

// ── Public: can we write? ──────────────────────────────────
export function canWrite(): boolean {
  return weHoldLock;
}

// ── Init ───────────────────────────────────────────────────
export function initFirebaseSync(): void {
  if (!isEnabled()) return;

  bus.on("firebase:auth", (e) => {
    const { payload } = e as { payload: unknown };
    if (payload) onLogin();
    else         onLogout();
  });

  bus.on("workspace:change", () => {
    if (!isEnabled() || !getFirebaseState().user) return;
    releaseLock().then(() => setupWorkspace());
  });

  // ── Local mutations → Firebase (only if we hold the lock) ──
  const guard = () => applyingRemote || !canWrite() || !getFirebaseState().user;

  bus.on("node:add", (e) => {
    if (guard()) return;
    const node = (e as { payload: CraftNode }).payload;
    if (node) writeNode(node);
  });

  bus.on("node:update", (e) => {
    if (guard()) return;
    const { id } = (e as { payload: { id: string } }).payload ?? {};
    if (id) { const n = store.getNode(id); if (n) writeNode(n); }
  });

  bus.on("node:move", (e) => {
    if (guard()) return;
    const { id } = (e as { payload: { id: string } }).payload ?? {};
    if (id) { const n = store.getNode(id); if (n) writeNode(n); }
  });

  bus.on("node:remove", (e) => {
    if (guard()) return;
    const { id } = (e as { payload: { id: string } }).payload ?? {};
    if (id) deleteNode(id);
  });

  bus.on("edge:add", (e) => {
    if (guard()) return;
    const edge = (e as { payload: CraftEdge }).payload;
    if (edge) writeEdge(edge);
  });

  bus.on("edge:update", (e) => {
    if (guard()) return;
    const { id } = (e as { payload: { id: string } }).payload ?? {};
    if (id) { const ed = store.getEdge(id); if (ed) writeEdge(ed); }
  });

  bus.on("edge:remove", (e) => {
    if (guard()) return;
    const { id } = (e as { payload: { id: string } }).payload ?? {};
    if (id) deleteEdge(id);
  });

  let jsonTimer: ReturnType<typeof setTimeout> | null = null;
  const schedJson = () => {
    if (guard()) return;
    if (jsonTimer) clearTimeout(jsonTimer);
    jsonTimer = setTimeout(() => writeJsonData(), 500);
  };
  bus.on("json:formUpdate", schedJson);
  bus.on("json:import", () => {
    if (guard()) return;
    schedJson();
    setTimeout(() => { writeAllNodes(); writeAllEdges(); }, 700);
  });
}

// ── Lock management ────────────────────────────────────────
async function acquireLock(): Promise<boolean> {
  const d = db();
  if (!d) return false;
  const user = getFirebaseState().user;
  if (!user) return false;

  const wsKey   = fk(store.currentWorkspaceKey());
  const lockRef = ref(d, `workspaces/${wsKey}/__lock`);

  try {
    const snap = await get(lockRef);
    if (snap.val() && snap.val().uid !== user.uid) {
      // Someone else holds the lock
      return false;
    }

    // We can take the lock
    const lockData = {
      uid:         user.uid,
      displayName: user.displayName ?? user.email ?? "Anonym",
      since:       serverTimestamp(),
    };
    await set(lockRef, lockData);

    // Auto-release when we disconnect
    onDisconnect(lockRef).remove();

    weHoldLock = true;
    lockWsKey  = wsKey;
    return true;
  } catch (e) {
    console.warn("Lock acquire failed:", e);
    return false;
  }
}

async function releaseLock(): Promise<void> {
  if (!weHoldLock || !lockWsKey) return;
  const d = db();
  if (!d) return;
  try {
    await remove(ref(d, `workspaces/${lockWsKey}/__lock`));
  } catch {}
  weHoldLock = false;
  lockWsKey  = "";
}

function watchLock(): void {
  const d = db();
  if (!d) return;
  const wsKey   = fk(store.currentWorkspaceKey());
  const lockRef = ref(d, `workspaces/${wsKey}/__lock`);

  // Unsubscribe previous lock watcher
  unsubLock?.(); unsubLock = null;

  onValue(lockRef, (snap) => {
    const lock = snap.val();
    const user = getFirebaseState().user;
    bus.emit("firebase:lock", { lock, weHoldLock, user });
  });
  unsubLock = () => off(lockRef);
}

// ── Granular writes ────────────────────────────────────────
async function writeNode(node: CraftNode): Promise<void> {
  const d = db();
  if (!d) return;
  try { await set(ref(d, `${wsBase()}/nodes/${fk(node.id)}`), JSON.parse(JSON.stringify(node))); }
  catch (e) { console.warn("writeNode:", e); }
}

async function deleteNode(id: string): Promise<void> {
  const d = db();
  if (!d) return;
  try { await remove(ref(d, `${wsBase()}/nodes/${fk(id)}`)); }
  catch (e) { console.warn("deleteNode:", e); }
}

async function writeEdge(edge: CraftEdge): Promise<void> {
  const d = db();
  if (!d) return;
  try { await set(ref(d, `${wsBase()}/edges/${fk(edge.id)}`), JSON.parse(JSON.stringify(edge))); }
  catch (e) { console.warn("writeEdge:", e); }
}

async function deleteEdge(id: string): Promise<void> {
  const d = db();
  if (!d) return;
  try { await remove(ref(d, `${wsBase()}/edges/${fk(id)}`)); }
  catch (e) { console.warn("deleteEdge:", e); }
}

async function writeJsonData(): Promise<void> {
  const d = db();
  if (!d) return;
  try { await set(ref(d, `${wsBase()}/jsonData`), JSON.parse(JSON.stringify(store.getJSON()))); }
  catch (e) { console.warn("writeJsonData:", e); }
}

export async function writeAllNodes(): Promise<void> {
  const d = db();
  if (!d) return;
  const obj = Object.fromEntries(store.getNodes().map(n => [fk(n.id), JSON.parse(JSON.stringify(n))]));
  try { await set(ref(d, `${wsBase()}/nodes`), Object.keys(obj).length ? obj : null); }
  catch (e) { console.warn("writeAllNodes:", e); }
}

export async function writeAllEdges(): Promise<void> {
  const d = db();
  if (!d) return;
  const obj = Object.fromEntries(store.getEdges().map(e => [fk(e.id), JSON.parse(JSON.stringify(e))]));
  try { await set(ref(d, `${wsBase()}/edges`), Object.keys(obj).length ? obj : null); }
  catch (e) { console.warn("writeAllEdges:", e); }
}

// ── Start / stop ───────────────────────────────────────────
async function onLogin(): Promise<void> {
  // Library
  try {
    const fbLib = await loadLibraryFromFirebase();
    if (fbLib.length > 0) {
      applyingRemote = true;
      try { store.setLibrary(fbLib, true); }
      finally { applyingRemote = false; }
    }
  } catch {}

  if (!libSubscribed) {
    libSubscribed = true;
    onLibraryUpdate((items: LibraryItem[]) => {
      if (applyingRemote) return;
      applyingRemote = true;
      try { store.setLibrary(items, true); }
      finally { applyingRemote = false; }
    });
    subscribeLibrary();
  }

  if (libAutoSave) clearInterval(libAutoSave);
  libAutoSave = setInterval(() => {
    if (!isEnabled() || !getFirebaseState().user || applyingRemote) return;
    saveLibraryToFirebase(store.getLibrary()).catch(console.warn);
  }, 30_000);

  await setupWorkspace();
}

function onLogout(): void {
  releaseLock();
  stopWorkspaceSubs();
  if (libAutoSave) { clearInterval(libAutoSave); libAutoSave = null; }
  libSubscribed = false;
}

function stopWorkspaceSubs(): void {
  unsubNodes?.(); unsubNodes = null;
  unsubEdges?.(); unsubEdges = null;
  unsubJson?.();  unsubJson  = null;
  unsubLock?.();  unsubLock  = null;
}

// ── Setup workspace: acquire lock + subscribe ──────────────
async function setupWorkspace(): Promise<void> {
  const d = db();
  if (!d || !getFirebaseState().user) return;

  stopWorkspaceSubs();

  // Try to acquire lock
  const gotLock = await acquireLock();
  weHoldLock = gotLock;

  // Watch lock changes (to show read-only banner)
  watchLock();

  // Subscribe to live data
  const nodesRef = ref(d, `${wsBase()}/nodes`);
  const edgesRef = ref(d, `${wsBase()}/edges`);
  const jsonRef  = ref(d, `${wsBase()}/jsonData`);

  // Initial load
  try {
    const [ns, es, js] = await Promise.all([get(nodesRef), get(edgesRef), get(jsonRef)]);
    applyingRemote = true;
    try {
      if (ns.val()) store.setNodesFromFirebase(Object.values(ns.val()) as CraftNode[]);
      if (es.val()) store.setEdgesFromFirebase(Object.values(es.val()) as CraftEdge[]);
      if (js.val()) store.setJSONFromFirebase(js.val() as WorkbenchJSON);
    } finally { applyingRemote = false; }
  } catch (e) { console.warn("Initial load:", e); }

  // Live subscriptions
  onValue(nodesRef, snap => {
    if (applyingRemote) return;
    applyingRemote = true;
    try { store.setNodesFromFirebase(snap.val() ? Object.values(snap.val()) : []); }
    finally { applyingRemote = false; }
  });
  unsubNodes = () => off(nodesRef);

  onValue(edgesRef, snap => {
    if (applyingRemote) return;
    applyingRemote = true;
    try { store.setEdgesFromFirebase(snap.val() ? Object.values(snap.val()) : []); }
    finally { applyingRemote = false; }
  });
  unsubEdges = () => off(edgesRef);

  onValue(jsonRef, snap => {
    if (applyingRemote || !snap.val()) return;
    applyingRemote = true;
    try { store.setJSONFromFirebase(snap.val() as WorkbenchJSON); }
    finally { applyingRemote = false; }
  });
  unsubJson = () => off(jsonRef);
}

// ── Cursor tracking ────────────────────────────────────────
let cursorThrottle: ReturnType<typeof setTimeout> | null = null;

export function initCursorTracking(canvasRoot: HTMLElement): void {
  if (!isEnabled()) return;
  canvasRoot.addEventListener("mousemove", (e: MouseEvent) => {
    if (!getFirebaseState().user) return;
    if (cursorThrottle) return;
    cursorThrottle = setTimeout(() => { cursorThrottle = null; }, 200);
    const rect = canvasRoot.getBoundingClientRect();
    const s    = store.getState().project.canvas;
    updatePresence({
      workbench:    store.getState().activeWorkbench,
      faction:      store.getState().activeFaction,
      workspaceKey: store.currentWorkspaceKey(),
      cursorX:      Math.round((e.clientX - rect.left - s.offsetX) / s.zoom),
      cursorY:      Math.round((e.clientY - rect.top  - s.offsetY) / s.zoom),
    });
  });
}

// ── Manual upload ───────────────────────────────────────────
export async function migrateLocalToFirebase(): Promise<void> {
  if (!isEnabled() || !getFirebaseState().user) return;
  await Promise.all([
    saveLibraryToFirebase(store.getLibrary()),
    writeAllNodes(),
    writeAllEdges(),
    writeJsonData(),
  ]);
  const el = document.getElementById("save-status");
  if (el) { el.textContent = "☁ Hochgeladen"; setTimeout(() => { if (el) el.textContent = "Gespeichert"; }, 2000); }
}

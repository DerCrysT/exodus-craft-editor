/**
 * Firebase Sync — Operation-based, granular writes
 *
 * Jede Änderung wird SOFORT als einzelner Firebase-Write gespeichert:
 *   add/update node    → set workspaces/{key}/nodes/{nodeId}
 *   remove node        → remove workspaces/{key}/nodes/{nodeId}
 *   add/update edge    → set workspaces/{key}/edges/{edgeId}
 *   remove edge        → remove workspaces/{key}/edges/{edgeId}
 *   json:formUpdate    → set workspaces/{key}/jsonData
 *
 * Firebase merged automatisch auf Feld-Ebene.
 * onValue auf nodes/ und edges/ feuert nur bei Änderungen.
 * Kein Blob-Overwrite, kein Guard, keine Race-Conditions.
 */

import { store } from "../state/AppStore";
import { bus } from "../state/EventEmitter";
import {
  isEnabled, saveLibraryToFirebase, loadLibraryFromFirebase,
  onLibraryUpdate, getFirebaseState, subscribeLibrary, updatePresence,
} from "../firebase/service";
import { getDatabase, ref, set, remove, get, onValue, off } from "firebase/database";
import { getApps } from "firebase/app";
import type { CraftNode, CraftEdge, WorkbenchJSON, LibraryItem } from "../types/index";

// ── DB helper ──────────────────────────────────────────────
function db() {
  const app = getApps()[0];
  return app ? getDatabase(app) : null;
}

// Firebase keys kann keine . # $ [ ] / enthalten
function fk(key: string): string {
  return key.replace(/[.#$[\]/]/g, "_");
}

function wsPath(): string {
  return `workspaces/${fk(store.currentWorkspaceKey())}`;
}

// ── State ──────────────────────────────────────────────────
let libSubscribed = false;
let libAutoSave: ReturnType<typeof setInterval> | null = null;

// Wir empfangen gerade Firebase-Daten — keine Saves auslösen
let applyingRemote = false;

// Aktive onValue-Unsubscriber
let unsubNodes: (() => void) | null = null;
let unsubEdges: (() => void) | null = null;
let unsubJson:  (() => void) | null = null;

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
    setupWorkspaceSync();
  });

  // ── Einzelne Operationen → sofort nach Firebase ────────
  bus.on("node:add", (e) => {
    if (applyingRemote) return;
    const node = (e as { payload: CraftNode }).payload;
    if (node) writeNode(node);
  });

  bus.on("node:update", (e) => {
    if (applyingRemote) return;
    const payload = (e as { payload: { id: string } }).payload;
    if (payload?.id) {
      const n = store.getNode(payload.id);
      if (n) writeNode(n);
    }
  });

  bus.on("node:move", (e) => {
    if (applyingRemote) return;
    const payload = (e as { payload: { id: string } }).payload;
    if (payload?.id) {
      const n = store.getNode(payload.id);
      if (n) writeNode(n);
    }
  });

  bus.on("node:remove", (e) => {
    if (applyingRemote) return;
    const payload = (e as { payload: { id: string } }).payload;
    if (payload?.id) deleteNode(payload.id);
  });

  bus.on("edge:add", (e) => {
    if (applyingRemote) return;
    const edge = (e as { payload: CraftEdge }).payload;
    if (edge) writeEdge(edge);
  });

  bus.on("edge:update", (e) => {
    if (applyingRemote) return;
    const payload = (e as { payload: { id: string } }).payload;
    if (payload?.id) {
      const ed = store.getEdge(payload.id);
      if (ed) writeEdge(ed);
    }
  });

  bus.on("edge:remove", (e) => {
    if (applyingRemote) return;
    const payload = (e as { payload: { id: string } }).payload;
    if (payload?.id) deleteEdge(payload.id);
  });

  // JSON (Formular-Daten) — debounced 500ms
  let jsonTimer: ReturnType<typeof setTimeout> | null = null;
  const scheduleJsonSave = () => {
    if (applyingRemote) return;
    if (!isEnabled() || !getFirebaseState().user) return;
    if (jsonTimer) clearTimeout(jsonTimer);
    jsonTimer = setTimeout(() => writeJsonData(), 500);
  };
  bus.on("json:formUpdate", scheduleJsonSave);
  bus.on("json:import",     scheduleJsonSave);

  // Beim Import: auch alle Nodes/Edges neu schreiben
  bus.on("json:import", () => {
    if (applyingRemote) return;
    setTimeout(() => writeAllNodes(), 600);
    setTimeout(() => writeAllEdges(), 600);
  });
}

// ── Granular write helpers ─────────────────────────────────
async function writeNode(node: CraftNode): Promise<void> {
  const d = db();
  if (!d || !getFirebaseState().user) return;
  try {
    await set(ref(d, `${wsPath()}/nodes/${fk(node.id)}`), JSON.parse(JSON.stringify(node)));
  } catch (e) { console.warn("writeNode failed:", e); }
}

async function deleteNode(id: string): Promise<void> {
  const d = db();
  if (!d || !getFirebaseState().user) return;
  try {
    await remove(ref(d, `${wsPath()}/nodes/${fk(id)}`));
  } catch (e) { console.warn("deleteNode failed:", e); }
}

async function writeEdge(edge: CraftEdge): Promise<void> {
  const d = db();
  if (!d || !getFirebaseState().user) return;
  try {
    await set(ref(d, `${wsPath()}/edges/${fk(edge.id)}`), JSON.parse(JSON.stringify(edge)));
  } catch (e) { console.warn("writeEdge failed:", e); }
}

async function deleteEdge(id: string): Promise<void> {
  const d = db();
  if (!d || !getFirebaseState().user) return;
  try {
    await remove(ref(d, `${wsPath()}/edges/${fk(id)}`));
  } catch (e) { console.warn("deleteEdge failed:", e); }
}

async function writeJsonData(): Promise<void> {
  const d = db();
  if (!d || !getFirebaseState().user) return;
  try {
    await set(ref(d, `${wsPath()}/jsonData`), JSON.parse(JSON.stringify(store.getJSON())));
  } catch (e) { console.warn("writeJsonData failed:", e); }
}

async function writeAllNodes(): Promise<void> {
  const d = db();
  if (!d || !getFirebaseState().user) return;
  const nodes = store.getNodes();
  const obj = Object.fromEntries(nodes.map(n => [fk(n.id), JSON.parse(JSON.stringify(n))]));
  try {
    await set(ref(d, `${wsPath()}/nodes`), Object.keys(obj).length ? obj : null);
  } catch (e) { console.warn("writeAllNodes failed:", e); }
}

async function writeAllEdges(): Promise<void> {
  const d = db();
  if (!d || !getFirebaseState().user) return;
  const edges = store.getEdges();
  const obj = Object.fromEntries(edges.map(e => [fk(e.id), JSON.parse(JSON.stringify(e))]));
  try {
    await set(ref(d, `${wsPath()}/edges`), Object.keys(obj).length ? obj : null);
  } catch (e) { console.warn("writeAllEdges failed:", e); }
}

// ── Login / Logout ─────────────────────────────────────────
async function onLogin(): Promise<void> {
  // Library
  try {
    const fbLib = await loadLibraryFromFirebase();
    if (fbLib.length > 0) {
      applyingRemote = true;
      try { store.setLibrary(fbLib, true); }
      finally { applyingRemote = false; }
    }
  } catch (e) { console.warn("Library load failed:", e); }

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

  // Library auto-save every 30s
  if (libAutoSave) clearInterval(libAutoSave);
  libAutoSave = setInterval(() => {
    if (!isEnabled() || !getFirebaseState().user || applyingRemote) return;
    saveLibraryToFirebase(store.getLibrary()).catch(console.warn);
  }, 30_000);

  await setupWorkspaceSync();
}

function onLogout(): void {
  unsubNodes?.(); unsubNodes = null;
  unsubEdges?.(); unsubEdges = null;
  unsubJson?.();  unsubJson  = null;
  if (libAutoSave) { clearInterval(libAutoSave); libAutoSave = null; }
  libSubscribed = false;
}

// ── Workspace subscription ─────────────────────────────────
async function setupWorkspaceSync(): Promise<void> {
  const d = db();
  if (!d || !isEnabled() || !getFirebaseState().user) return;

  // Alte Subscriptions stoppen
  unsubNodes?.(); unsubNodes = null;
  unsubEdges?.(); unsubEdges = null;
  unsubJson?.();  unsubJson  = null;

  const nodesRef = ref(d, `${wsPath()}/nodes`);
  const edgesRef = ref(d, `${wsPath()}/edges`);
  const jsonRef  = ref(d, `${wsPath()}/jsonData`);

  // ── Initial load ───────────────────────────────────────
  try {
    const [nSnap, eSnap, jSnap] = await Promise.all([
      get(nodesRef), get(edgesRef), get(jsonRef),
    ]);

    applyingRemote = true;
    try {
      if (nSnap.val()) {
        store.setNodesFromFirebase(Object.values(nSnap.val()) as CraftNode[]);
      }
      if (eSnap.val()) {
        store.setEdgesFromFirebase(Object.values(eSnap.val()) as CraftEdge[]);
      }
      if (jSnap.val()) {
        store.setJSONFromFirebase(jSnap.val() as WorkbenchJSON);
      }
    } finally { applyingRemote = false; }
  } catch (e) { console.warn("Initial load failed:", e); }

  // ── Live subscriptions ────────────────────────────────
  // Nodes — reagiert auf jeden einzelnen add/update/remove
  onValue(nodesRef, (snap) => {
    if (applyingRemote) return;
    applyingRemote = true;
    try {
      const nodes: CraftNode[] = snap.val()
        ? Object.values(snap.val())
        : [];
      store.setNodesFromFirebase(nodes);
    } finally { applyingRemote = false; }
  });
  unsubNodes = () => off(nodesRef);

  // Edges
  onValue(edgesRef, (snap) => {
    if (applyingRemote) return;
    applyingRemote = true;
    try {
      const edges: CraftEdge[] = snap.val()
        ? Object.values(snap.val())
        : [];
      store.setEdgesFromFirebase(edges);
    } finally { applyingRemote = false; }
  });
  unsubEdges = () => off(edgesRef);

  // JSON (Formular)
  onValue(jsonRef, (snap) => {
    if (applyingRemote) return;
    if (!snap.val()) return;
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
  try {
    await Promise.all([
      saveLibraryToFirebase(store.getLibrary()),
      writeAllNodes(),
      writeAllEdges(),
      writeJsonData(),
    ]);
    const el = document.getElementById("save-status");
    if (el) {
      el.textContent = "☁ Hochgeladen";
      setTimeout(() => { if (el) el.textContent = "Gespeichert"; }, 2000);
    }
  } catch (e) { console.error("Migration failed:", e); }
}

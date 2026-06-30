/**
 * Firebase Sync — Simple blob sync with workspace locking
 *
 * Lock-Inhaber schreibt den ganzen Workspace als JSON blob.
 * Andere User sind read-only und empfangen live updates.
 * Lock wird bei disconnect automatisch freigegeben.
 */

import { store } from "../state/AppStore";
import { bus } from "../state/EventEmitter";
import {
  isEnabled, saveLibraryToFirebase, loadLibraryFromFirebase,
  onLibraryUpdate, getFirebaseState, subscribeLibrary, updatePresence,
} from "../firebase/service";
import {
  getDatabase, ref, set, get, onValue, off,
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

// ── State ──────────────────────────────────────────────────
let libSubscribed  = false;
let libAutoSave:   ReturnType<typeof setInterval> | null = null;
let applyingRemote = false;
let weHoldLock     = false;
let lockWsKey      = "";
let saveTimer:     ReturnType<typeof setTimeout> | null = null;
let unsubWs:       (() => void) | null = null;
let unsubLock:     (() => void) | null = null;

export function canWrite(): boolean { return weHoldLock; }

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

  // Jede lokale Änderung → debounced blob save (nur wenn Lock-Inhaber)
  const schedule = () => {
    if (applyingRemote || !weHoldLock || !getFirebaseState().user) return;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(saveBlob, 1500);
  };

  bus.on("node:add",        schedule);
  bus.on("node:update",     schedule);
  bus.on("node:move",       schedule);
  bus.on("node:remove",     schedule);
  bus.on("edge:add",        schedule);
  bus.on("edge:update",     schedule);
  bus.on("edge:remove",     schedule);
  bus.on("json:formUpdate", schedule);
  bus.on("json:import",     schedule);
  bus.on("project:save",    schedule);
}

// ── Save workspace blob to Firebase ───────────────────────
async function saveBlob(): Promise<void> {
  const d = db();
  if (!d || !weHoldLock || !getFirebaseState().user) return;
  const wsKey = fk(store.currentWorkspaceKey());
  const state = store.getState().project;
  const blob = {
    nodes:    state.nodes,
    edges:    state.edges,
    jsonData: state.jsonData,
    savedAt:  new Date().toISOString(),
  };
  try {
    await set(ref(d, `workspaces/${wsKey}/data`), JSON.parse(JSON.stringify(blob)));
  } catch (e) { console.warn("saveBlob failed:", e); }
}

// ── Apply remote blob ──────────────────────────────────────
function applyBlob(blob: {
  nodes?: CraftNode[];
  edges?: CraftEdge[];
  jsonData?: WorkbenchJSON;
}): void {
  applyingRemote = true;
  try {
    if (Array.isArray(blob.nodes))   store.setNodesFromFirebase(blob.nodes);
    if (Array.isArray(blob.edges))   store.setEdgesFromFirebase(blob.edges);
    if (blob.jsonData)               store.setJSONFromFirebase(blob.jsonData);
  } finally {
    applyingRemote = false;
  }
}

// ── Lock ───────────────────────────────────────────────────
async function acquireLock(): Promise<boolean> {
  const d    = db();
  const user = getFirebaseState().user;
  if (!d || !user) return false;

  const wsKey   = fk(store.currentWorkspaceKey());
  const lockRef = ref(d, `workspaces/${wsKey}/lock`);

  try {
    const snap = await get(lockRef);
    const existing = snap.val();
    if (existing && existing.uid !== user.uid) return false; // someone else has it

    await set(lockRef, {
      uid:         user.uid,
      displayName: user.displayName ?? user.email ?? "Anonym",
      since:       serverTimestamp(),
    });
    onDisconnect(lockRef).remove();

    weHoldLock = true;
    lockWsKey  = wsKey;
    return true;
  } catch (e) {
    console.warn("acquireLock failed:", e);
    return false;
  }
}

async function releaseLock(): Promise<void> {
  if (!weHoldLock || !lockWsKey) return;
  const d = db();
  if (!d) return;
  try { await set(ref(d, `workspaces/${lockWsKey}/lock`), null); } catch {}
  weHoldLock = false;
  lockWsKey  = "";
}

function watchLock(wsKey: string): void {
  const d = db();
  if (!d) return;
  const lockRef = ref(d, `workspaces/${wsKey}/lock`);
  unsubLock?.(); unsubLock = null;

  onValue(lockRef, snap => {
    const lock = snap.val() as { uid: string; displayName: string } | null;
    const user = getFirebaseState().user;
    bus.emit("firebase:lock", { lock, weHoldLock, myUid: user?.uid });
  });
  unsubLock = () => off(lockRef);
}

// ── Workspace setup ────────────────────────────────────────
async function setupWorkspace(): Promise<void> {
  const d = db();
  if (!d || !getFirebaseState().user) return;

  // Stop previous subscription
  unsubWs?.(); unsubWs = null;

  const wsKey  = fk(store.currentWorkspaceKey());
  const dataRef = ref(d, `workspaces/${wsKey}/data`);

  // Try to get the lock
  const got = await acquireLock();
  weHoldLock = got;

  // Watch lock changes for banner
  watchLock(wsKey);

  // Initial load from Firebase
  try {
    const snap = await get(dataRef);
    if (snap.val()) {
      applyBlob(snap.val());
    }
  } catch (e) { console.warn("Initial load failed:", e); }

  // Live subscription — fires when lock-holder saves
  onValue(dataRef, snap => {
    if (applyingRemote || !snap.val()) return;
    // Lock-holder: ignore own echo (we just wrote this)
    if (weHoldLock) return;
    // Read-only users: always apply
    applyBlob(snap.val());
  });
  unsubWs = () => off(dataRef);
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
  unsubWs?.();   unsubWs   = null;
  unsubLock?.(); unsubLock = null;
  if (libAutoSave) { clearInterval(libAutoSave); libAutoSave = null; }
  if (saveTimer)   { clearTimeout(saveTimer);    saveTimer   = null; }
  libSubscribed = false;
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
  weHoldLock = true; // temporarily allow save
  await Promise.all([
    saveLibraryToFirebase(store.getLibrary()),
    saveBlob(),
  ]);
  weHoldLock = canWrite();
  const el = document.getElementById("save-status");
  if (el) {
    el.textContent = "☁ Hochgeladen";
    setTimeout(() => { if (el) el.textContent = "Gespeichert"; }, 2000);
  }
}

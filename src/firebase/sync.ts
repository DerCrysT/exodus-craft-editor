/**
 * Firebase Sync — Blob sync with workspace locking
 * Fixed: Firebase array→object conversion, lock renewal, save guards
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

// ── Helpers ────────────────────────────────────────────────
function db() {
  const apps = getApps();
  return apps.length ? getDatabase(apps[0]) : null;
}

function fk(k: string): string {
  return k.replace(/[.#$[\]/]/g, "_");
}

// Firebase stores JS arrays as {0:x, 1:y} objects — always convert back
function toArray<T>(val: unknown): T[] {
  if (!val) return [];
  if (Array.isArray(val)) return val as T[];
  // Firebase object with numeric keys
  return Object.values(val) as T[];
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

  // Local changes → save to Firebase (only if we hold the lock)
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

// ── Save blob ──────────────────────────────────────────────
// ── Save blob ──────────────────────────────────────────────
// ── Save blob ──────────────────────────────────────────────
async function saveBlob(): Promise<void> {
  const d = db();
  if (!d || !weHoldLock || !getFirebaseState().user) return;
  const wsKey = fk(store.currentWorkspaceKey());
  const state = store.getState().project;

  // Strip imageUrl from nodes — images live in the Library, not the workspace blob.
  // This keeps the blob small (imageUrl can be 100-500KB per node).
  const strippedNodes = state.nodes.map(n => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { imageUrl: _img, ...rest } = n as typeof n & { imageUrl?: string };
    return rest;
  });

  const blob = {
    nodes:     Object.fromEntries(strippedNodes.map((n, i) => [i, n])),
    edges:     Object.fromEntries(state.edges.map((e, i) => [i, e])),
    jsonData:  state.jsonData,
    savedAt:   new Date().toISOString(),
    nodeCount: state.nodes.length,
    edgeCount: state.edges.length,
  };

  const blobStr = JSON.stringify(blob);
  const blobSizeKB = Math.round(blobStr.length / 1024);

  // Firebase SDK limit: 16 MB per write
  if (blobStr.length > 15 * 1024 * 1024) {
    console.error(`Workspace blob too large: ${blobSizeKB} KB`);
    const el = document.getElementById("save-status");
    if (el) el.textContent = `⚠ Zu groß (${blobSizeKB} KB)`;
    return;
  }

  try {
    await set(ref(d, `workspaces/${wsKey}/data`), JSON.parse(blobStr));
    const el = document.getElementById("save-status");
    if (el) el.textContent = `☁ Synced (${blobSizeKB} KB)`;
  } catch (e: unknown) {
    console.error("saveBlob failed:", e);
    const el = document.getElementById("save-status");
    if (el) el.textContent = "⚠ Sync-Fehler";
  }
}

// ── Apply remote blob ──────────────────────────────────────
function applyBlob(blob: Record<string, unknown>): void {
  if (!blob) return;
  applyingRemote = true;
  try {
    const nodes = toArray<CraftNode>(blob.nodes);
    const edges  = toArray<CraftEdge>(blob.edges);
    const json   = blob.jsonData as WorkbenchJSON | undefined;

    // Restore imageUrl from local library cache (not stored in blob to save space)
    const library = store.getLibrary();
    const libMap  = new Map(library.map(item => [item.classname, item.imageUrl]));
    const nodesWithImages = nodes.map(n => ({
      ...n,
      imageUrl: n.imageUrl ?? libMap.get(n.classname) ?? undefined,
    }));

    if (nodes.length > 0 || blob.nodes !== undefined) {
      store.setNodesFromFirebase(nodesWithImages);
    }
    if (edges.length > 0 || blob.edges !== undefined) {
      store.setEdgesFromFirebase(edges);
    }
    if (json) {
      store.setJSONFromFirebase(json);
    }
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
    const snap     = await get(lockRef);
    const existing = snap.val() as { uid: string } | null;

    // Lock free or we already hold it
    if (!existing || existing.uid === user.uid) {
      await set(lockRef, {
        uid:         user.uid,
        displayName: user.displayName ?? user.email ?? "Anonym",
        since:       serverTimestamp(),
      });
      onDisconnect(lockRef).remove();
      weHoldLock = true;
      lockWsKey  = wsKey;
      return true;
    }
    return false;
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
  unsubLock?.(); unsubLock = null;

  const lockRef = ref(d, `workspaces/${wsKey}/lock`);
  onValue(lockRef, snap => {
    const lock = snap.val() as { uid: string; displayName: string } | null;
    const user = getFirebaseState().user;

    // Lock was released — try to acquire it
    if (!lock && !weHoldLock && user) {
      acquireLock().then(got => {
        if (got) {
          // Now we have write access — update banner
          bus.emit("firebase:lock", { lock: null, weHoldLock: true });
        }
      });
      return;
    }

    bus.emit("firebase:lock", { lock, weHoldLock, myUid: user?.uid });
  });
  unsubLock = () => off(lockRef);
}

// ── Workspace setup ────────────────────────────────────────
async function setupWorkspace(): Promise<void> {
  const d = db();
  if (!d || !getFirebaseState().user) return;

  unsubWs?.(); unsubWs = null;

  const wsKey   = fk(store.currentWorkspaceKey());
  const dataRef = ref(d, `workspaces/${wsKey}/data`);

  // Acquire lock
  await acquireLock();

  // Watch lock (handles lock release → auto acquire)
  watchLock(wsKey);

  // Initial load — always load what's in Firebase
  try {
    const snap = await get(dataRef);
    if (snap.val()) {
      applyBlob(snap.val() as Record<string, unknown>);
    }
  } catch (e) { console.warn("Initial load failed:", e); }

  // Live updates for read-only users
  onValue(dataRef, snap => {
    // Skip if we're applying remote data or there's nothing
    if (applyingRemote || !snap.val()) return;
    // Lock holder: don't apply own echo
    if (weHoldLock) return;
    // Read-only: apply immediately
    applyBlob(snap.val() as Record<string, unknown>);
  });
  unsubWs = () => off(dataRef);
}

// ── Login / Logout ─────────────────────────────────────────
async function onLogin(): Promise<void> {
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
  const prevLock = weHoldLock;
  weHoldLock = true;
  try {
    await Promise.all([
      saveLibraryToFirebase(store.getLibrary()),
      saveBlob(),
    ]);
  } finally {
    weHoldLock = prevLock;
  }
}

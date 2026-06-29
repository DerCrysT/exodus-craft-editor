import { store } from "../state/AppStore";
import { bus } from "../state/EventEmitter";
import {
  isEnabled, saveLibraryToFirebase, loadLibraryFromFirebase,
  saveWorkspaceToFirebase, loadWorkspaceFromFirebase,
  subscribeWorkspace, onLibraryUpdate, getFirebaseState,
  subscribeLibrary, updatePresence,
} from "../firebase/service";
import type { ExodusCraftProject, LibraryItem } from "../types/index";

// ── State ──────────────────────────────────────────────────
let unsubWorkspace: (() => void) | null = null;
let autoSyncTimer:  ReturnType<typeof setInterval> | null = null;

// Guard: prevent feedback loops when we apply Firebase data locally
let receivingFromFirebase = false;

// Track if library subscription is already registered (avoid double-subscribe)
let libSubscribed = false;

// ── Init ───────────────────────────────────────────────────
export function initFirebaseSync(): void {
  if (!isEnabled()) return;

  bus.on("firebase:auth", (e) => {
    const ev = e as { payload: unknown };
    if (ev.payload) startSync();
    else            stopSync();
  });

  bus.on("workspace:change", () => {
    if (!isEnabled() || !getFirebaseState().user) return;
    resubscribeWorkspace();
  });
}

// ── Auto-sync every 5 seconds ──────────────────────────────
function startAutoSync(): void {
  if (autoSyncTimer) clearInterval(autoSyncTimer);
  autoSyncTimer = setInterval(() => {
    if (!isEnabled() || !getFirebaseState().user) return;
    if (receivingFromFirebase) return;
    performSync();
  }, 5000);
}

async function performSync(): Promise<void> {
  try {
    await saveLibraryToFirebase(store.getLibrary());
    const wsKey = store.currentWorkspaceKey();
    await saveWorkspaceToFirebase(wsKey, store.getState().project);
  } catch (e) {
    console.warn("Auto-sync failed:", e);
  }
}

// ── Start / stop ───────────────────────────────────────────
async function startSync(): Promise<void> {
  // 1. Load library from Firebase (one-time on login)
  try {
    const fbLib = await loadLibraryFromFirebase();
    if (fbLib.length > 0) {
      receivingFromFirebase = true;
      try { store.setLibrary(fbLib, true); }
      finally { receivingFromFirebase = false; }
    }
  } catch (e) { console.warn("Library load failed:", e); }

  // 2. Subscribe to live library updates — only once, guard against double-subscribe
  if (!libSubscribed) {
    libSubscribed = true;
    onLibraryUpdate((items: LibraryItem[]) => {
      if (receivingFromFirebase) return;
      receivingFromFirebase = true;
      try { store.setLibrary(items, true); }
      finally { receivingFromFirebase = false; }
    });
    // subscribeLibrary is called here only — service.ts onAuthStateChanged does NOT call it
    // (it was removed from there to prevent double-subscription)
    subscribeLibrary();
  }

  // 3. Load and subscribe to current workspace
  await resubscribeWorkspace();

  // 4. Start 5-second auto-sync
  startAutoSync();
}

function stopSync(): void {
  if (unsubWorkspace) { unsubWorkspace(); unsubWorkspace = null; }
  if (autoSyncTimer)  { clearInterval(autoSyncTimer); autoSyncTimer = null; }
  libSubscribed = false;
}

// ── Workspace subscription ─────────────────────────────────
async function resubscribeWorkspace(): Promise<void> {
  if (!isEnabled() || !getFirebaseState().user) return;

  // Unsubscribe from previous workspace listener
  if (unsubWorkspace) { unsubWorkspace(); unsubWorkspace = null; }

  const wsKey = store.currentWorkspaceKey();

  // Load snapshot from Firebase — only apply if Firebase data is NEWER than local
  try {
    const fbProject = await loadWorkspaceFromFirebase(wsKey);
    if (fbProject) {
      const remote = fbProject as ExodusCraftProject;
      const local  = store.getState().project;
      const remoteTime = new Date(remote.meta?.updatedAt ?? 0).getTime();
      const localTime  = new Date(local.meta?.updatedAt  ?? 0).getTime();
      // Only overwrite local with Firebase data if Firebase is genuinely newer
      if (remoteTime > localTime + 2000) {
        receivingFromFirebase = true;
        try { store.loadProject(remote); }
        finally { receivingFromFirebase = false; }
      }
    }
  } catch (e) { console.warn("Workspace load failed:", e); }

  // Live subscription: apply updates from other users in real-time
  unsubWorkspace = subscribeWorkspace(wsKey, (data: unknown) => {
    if (!data || receivingFromFirebase) return;
    const remote = data as ExodusCraftProject;
    const local  = store.getState().project;
    const remoteTime = new Date(remote.meta?.updatedAt ?? 0).getTime();
    const localTime  = new Date(local.meta?.updatedAt  ?? 0).getTime();
    // Only apply if remote is at least 2 seconds newer (prevents self-echo)
    if (remoteTime > localTime + 2000) {
      receivingFromFirebase = true;
      try {
        store.loadProject(remote);
        const el = document.getElementById("save-status");
        if (el) {
          el.textContent = "↓ Teammate-Update";
          setTimeout(() => { if (el) el.textContent = "Gespeichert"; }, 3000);
        }
      } finally {
        receivingFromFirebase = false;
      }
    }
  });
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
    const cx   = (e.clientX - rect.left - s.offsetX) / s.zoom;
    const cy   = (e.clientY - rect.top  - s.offsetY) / s.zoom;

    updatePresence({
      workbench:    store.getState().activeWorkbench,
      faction:      store.getState().activeFaction,
      workspaceKey: store.currentWorkspaceKey(),
      cursorX:      Math.round(cx),
      cursorY:      Math.round(cy),
    });
  });
}

// ── Manual upload: localStorage → Firebase ─────────────────
export async function migrateLocalToFirebase(): Promise<void> {
  if (!isEnabled() || !getFirebaseState().user) return;
  try {
    await saveLibraryToFirebase(store.getLibrary());
    await saveWorkspaceToFirebase(store.currentWorkspaceKey(), store.getState().project);
    const el = document.getElementById("save-status");
    if (el) { el.textContent = "☁ Hochgeladen"; setTimeout(() => { if (el) el.textContent = "Gespeichert"; }, 2000); }
  } catch (e) {
    console.error("Migration failed:", e);
  }
}

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
let receivingFromFirebase = false;
let libSubscribed = false;

// Track which workspace we "own" during this session
// Only the owner writes — others read
let sessionId: string = Math.random().toString(36).slice(2, 8);
let lastKnownRemoteUpdatedAt = "";

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
    lastKnownRemoteUpdatedAt = ""; // reset on workspace switch
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

    const wsKey   = store.currentWorkspaceKey();
    const project = store.getState().project;

    // Always refresh updatedAt before saving so other clients know this is newer
    const updatedAt = new Date().toISOString();
    const toSave: ExodusCraftProject = {
      ...project,
      meta: { ...project.meta, updatedAt, sessionId },
    };

    await saveWorkspaceToFirebase(wsKey, toSave);
    lastKnownRemoteUpdatedAt = updatedAt;
  } catch (e) {
    console.warn("Auto-sync failed:", e);
  }
}

// ── Start / stop ───────────────────────────────────────────
async function startSync(): Promise<void> {
  // Load library
  try {
    const fbLib = await loadLibraryFromFirebase();
    if (fbLib.length > 0) {
      receivingFromFirebase = true;
      try { store.setLibrary(fbLib, true); }
      finally { receivingFromFirebase = false; }
    }
  } catch (e) { console.warn("Library load failed:", e); }

  // Subscribe to live library updates (only once)
  if (!libSubscribed) {
    libSubscribed = true;
    onLibraryUpdate((items: LibraryItem[]) => {
      if (receivingFromFirebase) return;
      receivingFromFirebase = true;
      try { store.setLibrary(items, true); }
      finally { receivingFromFirebase = false; }
    });
    subscribeLibrary();
  }

  await resubscribeWorkspace();
  startAutoSync();
}

function stopSync(): void {
  if (unsubWorkspace) { unsubWorkspace(); unsubWorkspace = null; }
  if (autoSyncTimer)  { clearInterval(autoSyncTimer); autoSyncTimer = null; }
  libSubscribed = false;
  lastKnownRemoteUpdatedAt = "";
}

// ── Workspace subscription ─────────────────────────────────
async function resubscribeWorkspace(): Promise<void> {
  if (!isEnabled() || !getFirebaseState().user) return;
  if (unsubWorkspace) { unsubWorkspace(); unsubWorkspace = null; }

  const wsKey = store.currentWorkspaceKey();

  // Initial load: take Firebase data only if it has a different sessionId
  // (i.e. was saved by someone else, not us from a previous session)
  try {
    const fbProject = await loadWorkspaceFromFirebase(wsKey);
    if (fbProject) {
      const remote = fbProject as ExodusCraftProject & { meta: { sessionId?: string } };
      const remoteSession = remote.meta?.sessionId;
      const remoteTime    = new Date(remote.meta?.updatedAt ?? 0).getTime();
      const localTime     = new Date(store.getState().project.meta?.updatedAt ?? 0).getTime();

      // Apply Firebase data only if it's from a different session AND newer
      if (remoteSession !== sessionId && remoteTime > localTime) {
        receivingFromFirebase = true;
        try {
          store.loadProject(remote);
          lastKnownRemoteUpdatedAt = remote.meta?.updatedAt ?? "";
        } finally { receivingFromFirebase = false; }
      }
    }
  } catch (e) { console.warn("Workspace load failed:", e); }

  // Live subscription — receive updates from other users
  unsubWorkspace = subscribeWorkspace(wsKey, (data: unknown) => {
    if (!data || receivingFromFirebase) return;

    const remote = data as ExodusCraftProject & { meta: { sessionId?: string } };
    const remoteSession = remote.meta?.sessionId;
    const remoteUpdatedAt = remote.meta?.updatedAt ?? "";

    // Ignore our own writes echoed back from Firebase
    if (remoteSession === sessionId) return;

    // Ignore if we've already processed this exact update
    if (remoteUpdatedAt === lastKnownRemoteUpdatedAt) return;

    const remoteTime = new Date(remoteUpdatedAt).getTime();
    const localTime  = new Date(store.getState().project.meta?.updatedAt ?? 0).getTime();

    // Only apply if remote is newer than what we have locally
    // Use a 500ms threshold to avoid rapid back-and-forth
    if (remoteTime > localTime + 500) {
      receivingFromFirebase = true;
      lastKnownRemoteUpdatedAt = remoteUpdatedAt;
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

// ── Manual upload ───────────────────────────────────────────
export async function migrateLocalToFirebase(): Promise<void> {
  if (!isEnabled() || !getFirebaseState().user) return;
  try {
    await saveLibraryToFirebase(store.getLibrary());
    await saveWorkspaceToFirebase(store.currentWorkspaceKey(), store.getState().project);
    const el = document.getElementById("save-status");
    if (el) {
      el.textContent = "☁ Hochgeladen";
      setTimeout(() => { if (el) el.textContent = "Gespeichert"; }, 2000);
    }
  } catch (e) { console.error("Migration failed:", e); }
}

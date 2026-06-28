import { store } from "../state/AppStore";
import { bus } from "../state/EventEmitter";
import {
  isEnabled, saveLibraryToFirebase, loadLibraryFromFirebase,
  saveWorkspaceToFirebase, loadWorkspaceFromFirebase,
  subscribeWorkspace, onLibraryUpdate, getFirebaseState,
  subscribeLibrary, updatePresence,
} from "../firebase/service";
import type { ExodusCraftProject, LibraryItem } from "../types/index";
import { showToast } from "../ui/toolbar/Toolbar";

// ── State ──────────────────────────────────────────────────
let unsubWorkspace: (() => void) | null = null;
let autoSyncTimer:  ReturnType<typeof setInterval> | null = null;
let receivingFromFirebase = false;

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
    // Save library
    await saveLibraryToFirebase(store.getLibrary());
    // Save current workspace
    const wsKey   = store.currentWorkspaceKey();
    const project = store.getState().project;
    await saveWorkspaceToFirebase(wsKey, project);
  } catch (e) {
    console.warn("Auto-sync failed:", e);
  }
}

// ── Start / stop ───────────────────────────────────────────
async function startSync(): Promise<void> {
  // 1. Load library
  try {
    const fbLib = await loadLibraryFromFirebase();
    if (fbLib.length > 0) {
      receivingFromFirebase = true;
      store.setLibrary(fbLib);
      receivingFromFirebase = false;
    }
  } catch (e) { console.warn("Library load failed:", e); }

  // 2. Subscribe to live library updates
  onLibraryUpdate((items: LibraryItem[]) => {
    if (receivingFromFirebase) return;
    receivingFromFirebase = true;
    store.setLibrary(items);
    receivingFromFirebase = false;
  });
  subscribeLibrary();

  // 3. Subscribe to workspace
  await resubscribeWorkspace();

  // 4. Start auto-sync every 5 seconds
  startAutoSync();
}

function stopSync(): void {
  if (unsubWorkspace)  { unsubWorkspace(); unsubWorkspace = null; }
  if (autoSyncTimer)   { clearInterval(autoSyncTimer); autoSyncTimer = null; }
}

// ── Workspace subscription ─────────────────────────────────
async function resubscribeWorkspace(): Promise<void> {
  if (!isEnabled() || !getFirebaseState().user) return;
  if (unsubWorkspace) { unsubWorkspace(); unsubWorkspace = null; }

  const wsKey = store.currentWorkspaceKey();

  // Load snapshot
  try {
    const fbProject = await loadWorkspaceFromFirebase(wsKey);
    if (fbProject) {
      receivingFromFirebase = true;
      store.loadProject(fbProject as ExodusCraftProject);
      receivingFromFirebase = false;
    }
  } catch (e) { console.warn("Workspace load failed:", e); }

  // Live subscription
  unsubWorkspace = subscribeWorkspace(wsKey, (data: unknown) => {
    if (!data || receivingFromFirebase) return;
    const remote = data as ExodusCraftProject;
    const local  = store.getState().project;
    const remoteTime = new Date(remote.meta?.updatedAt ?? 0).getTime();
    const localTime  = new Date(local.meta?.updatedAt  ?? 0).getTime();
    if (remoteTime > localTime + 1000) {
      receivingFromFirebase = true;
      store.loadProject(remote);
      receivingFromFirebase = false;
      // Quiet statusbar notification instead of loud toast
      const el = document.getElementById("save-status");
      if (el) {
        el.textContent = "↓ Teammate-Update";
        setTimeout(() => { if (el) el.textContent = "Gespeichert"; }, 3000);
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
    if (cursorThrottle) return; // throttle to ~5 updates/sec

    cursorThrottle = setTimeout(() => { cursorThrottle = null; }, 200);

    const rect = canvasRoot.getBoundingClientRect();
    const s    = store.getState().project.canvas;
    // Convert screen → canvas coordinates
    const cx = (e.clientX - rect.left - s.offsetX) / s.zoom;
    const cy = (e.clientY - rect.top  - s.offsetY) / s.zoom;

    updatePresence({
      workbench:    store.getState().activeWorkbench,
      faction:      store.getState().activeFaction,
      workspaceKey: store.currentWorkspaceKey(),
      cursorX:      Math.round(cx),
      cursorY:      Math.round(cy),
    });
  });
}

// ── Manual migration ───────────────────────────────────────
export async function migrateLocalToFirebase(): Promise<void> {
  if (!isEnabled() || !getFirebaseState().user) {
    showToast("Bitte erst anmelden", "warning");
    return;
  }
  try {
    await saveLibraryToFirebase(store.getLibrary());
    await saveWorkspaceToFirebase(store.currentWorkspaceKey(), store.getState().project);
    showToast("Lokale Daten zu Firebase hochgeladen ✓", "success");
  } catch (e) {
    showToast("Upload fehlgeschlagen", "error");
  }
}

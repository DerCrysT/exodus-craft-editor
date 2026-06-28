import { store } from "../state/AppStore";
import { bus } from "../state/EventEmitter";
import {
  isEnabled,
  saveLibraryToFirebase, loadLibraryFromFirebase,
  saveWorkspaceToFirebase, loadWorkspaceFromFirebase,
  subscribeWorkspace, onLibraryUpdate, getFirebaseState,
  subscribeLibrary,
} from "../firebase/service";
import type { ExodusCraftProject, LibraryItem } from "../types/index";
import { showToast } from "../ui/toolbar/Toolbar";

// ── State ──────────────────────────────────────────────────
let libSaveTimer:   ReturnType<typeof setTimeout> | null = null;
let wsSaveTimer:    ReturnType<typeof setTimeout> | null = null;
let unsubWorkspace: (() => void) | null = null;

// Guard: don't re-save what we just received from Firebase
let receivingFromFirebase = false;

// Track last saved content to avoid redundant writes
let lastSavedWsJson = "";
let lastSavedLibJson = "";

// ── Init ───────────────────────────────────────────────────
export function initFirebaseSync(): void {
  if (!isEnabled()) return;

  // When user logs in → start full sync
  bus.on("firebase:auth", (e) => {
    const ev = e as { payload: unknown };
    if (ev.payload) {
      startSync();
    } else {
      stopSync();
    }
  });

  // State changed locally → schedule save to Firebase (debounced)
  bus.on("state:change", () => {
    if (receivingFromFirebase) return;
    if (!isEnabled() || !getFirebaseState().user) return;
    scheduleLibrarySave();
    scheduleWorkspaceSave();
  });

  bus.on("project:save", () => {
    if (receivingFromFirebase) return;
    scheduleWorkspaceSave();
  });

  // When workspace switches → re-subscribe to new workspace in Firebase
  bus.on("workspace:change", () => {
    if (!isEnabled() || !getFirebaseState().user) return;
    resubscribeWorkspace();
  });
}

// ── Save scheduling ────────────────────────────────────────
function scheduleLibrarySave(): void {
  if (libSaveTimer) clearTimeout(libSaveTimer);
  libSaveTimer = setTimeout(async () => {
    const lib = store.getLibrary();
    const json = JSON.stringify(lib.map(i => i.classname)); // cheap hash
    if (json === lastSavedLibJson) return; // nothing changed
    lastSavedLibJson = json;
    await saveLibraryToFirebase(lib);
  }, 1500);
}

function scheduleWorkspaceSave(): void {
  if (wsSaveTimer) clearTimeout(wsSaveTimer);
  wsSaveTimer = setTimeout(async () => {
    const wsKey  = store.currentWorkspaceKey();
    const project = store.getState().project;
    const json   = JSON.stringify({ nodes: project.nodes.length, edges: project.edges.length });
    if (json === lastSavedWsJson) return; // nothing changed
    lastSavedWsJson = json;
    await saveWorkspaceToFirebase(wsKey, project);
  }, 2000);
}

// ── Start sync after login ─────────────────────────────────
async function startSync(): Promise<void> {
  // 1. Load library from Firebase and apply locally
  try {
    const fbLib = await loadLibraryFromFirebase();
    if (fbLib.length > 0) {
      receivingFromFirebase = true;
      store.setLibrary(fbLib);
      receivingFromFirebase = false;
    }
  } catch (e) {
    console.warn("Library load failed:", e);
  }

  // 2. Subscribe to live library updates from other users
  onLibraryUpdate((items: LibraryItem[]) => {
    if (receivingFromFirebase) return;
    receivingFromFirebase = true;
    store.setLibrary(items);
    receivingFromFirebase = false;
  });

  // Must call subscribeLibrary AFTER setting up the callback
  subscribeLibrary();

  // 3. Subscribe to current workspace
  await resubscribeWorkspace();
}

function stopSync(): void {
  if (unsubWorkspace) { unsubWorkspace(); unsubWorkspace = null; }
  if (libSaveTimer)   { clearTimeout(libSaveTimer);  libSaveTimer  = null; }
  if (wsSaveTimer)    { clearTimeout(wsSaveTimer);   wsSaveTimer   = null; }
  lastSavedWsJson  = "";
  lastSavedLibJson = "";
}

// ── Workspace subscription ─────────────────────────────────
async function resubscribeWorkspace(): Promise<void> {
  if (!isEnabled() || !getFirebaseState().user) return;

  // Unsubscribe from previous workspace
  if (unsubWorkspace) { unsubWorkspace(); unsubWorkspace = null; }

  const wsKey = store.currentWorkspaceKey();

  // Load current workspace snapshot from Firebase
  try {
    const fbProject = await loadWorkspaceFromFirebase(wsKey);
    if (fbProject) {
      receivingFromFirebase = true;
      store.loadProject(fbProject as ExodusCraftProject);
      receivingFromFirebase = false;
    }
  } catch (e) {
    console.warn("Workspace load failed:", e);
  }

  // Subscribe to live updates for this workspace
  unsubWorkspace = subscribeWorkspace(wsKey, (data: unknown) => {
    if (!data || receivingFromFirebase) return;

    const remote = data as ExodusCraftProject;
    const local  = store.getState().project;

    // Only apply if remote is actually newer
    const remoteTime = new Date(remote.meta?.updatedAt ?? 0).getTime();
    const localTime  = new Date(local.meta?.updatedAt  ?? 0).getTime();

    if (remoteTime > localTime + 1000) { // 1s tolerance
      receivingFromFirebase = true;
      store.loadProject(remote);
      receivingFromFirebase = false;
      showToast("Canvas von Teammate aktualisiert", "info");
    }
  });
}

// ── Manual migration: localStorage → Firebase ──────────────
export async function migrateLocalToFirebase(): Promise<void> {
  if (!isEnabled() || !getFirebaseState().user) {
    showToast("Bitte erst anmelden", "warning");
    return;
  }
  try {
    await saveLibraryToFirebase(store.getLibrary());
    await saveWorkspaceToFirebase(
      store.currentWorkspaceKey(),
      store.getState().project
    );
    showToast("Lokale Daten zu Firebase hochgeladen ✓", "success");
  } catch (e) {
    showToast("Upload fehlgeschlagen", "error");
    console.error(e);
  }
}

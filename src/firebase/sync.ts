import { store } from "../state/AppStore";
import { bus } from "../state/EventEmitter";
import {
  isEnabled, saveLibraryToFirebase, loadLibraryFromFirebase,
  saveWorkspaceToFirebase, loadWorkspaceFromFirebase,
  subscribeWorkspace, onLibraryUpdate, getFirebaseState,
} from "../firebase/service";
import type { ExodusCraftProject, LibraryItem } from "../types/index";
import { showToast } from "../ui/toolbar/Toolbar";

// ── Debounce timers ────────────────────────────────────────
let libSaveTimer:  ReturnType<typeof setTimeout> | null = null;
let wsSaveTimer:   ReturnType<typeof setTimeout> | null = null;
let unsubWorkspace: (() => void) | null = null;

// Prevent feedback loops: when we receive Firebase updates, don't re-save
let receivingFromFirebase = false;

// ── Init ───────────────────────────────────────────────────
export function initFirebaseSync(): void {
  if (!isEnabled()) return;

  // Wait for auth before starting sync
  bus.on("firebase:auth", (e) => {
    const ev = e as { payload: unknown };
    if (ev.payload) {
      // User signed in
      startSync();
    } else {
      // User signed out
      stopSync();
    }
  });

  // Library: save to Firebase whenever it changes (debounced 1s)
  bus.on("state:change", () => {
    if (receivingFromFirebase) return;
    if (!isEnabled() || !getFirebaseState().user) return;

    if (libSaveTimer) clearTimeout(libSaveTimer);
    libSaveTimer = setTimeout(() => {
      saveLibraryToFirebase(store.getLibrary()).catch(console.error);
    }, 1000);
  });

  // Workspace: save to Firebase on project save or state change (debounced 2s)
  bus.on("project:save", () => {
    if (receivingFromFirebase) return;
    scheduleSaveWorkspace();
  });
  bus.on("state:change", () => {
    if (receivingFromFirebase) return;
    scheduleSaveWorkspace();
  });

  // React to workspace switches
  bus.on("workspace:change", () => {
    resubscribeWorkspace();
  });
}

function scheduleSaveWorkspace(): void {
  if (!isEnabled() || !getFirebaseState().user) return;
  if (wsSaveTimer) clearTimeout(wsSaveTimer);
  wsSaveTimer = setTimeout(() => {
    const wsKey = store.currentWorkspaceKey();
    const project = store.getState().project;
    saveWorkspaceToFirebase(wsKey, project).catch(console.error);
  }, 2000);
}

// ── Start/stop sync ────────────────────────────────────────
async function startSync(): Promise<void> {
  // 1. Load library from Firebase
  const fbLibrary = await loadLibraryFromFirebase();
  if (fbLibrary.length > 0) {
    receivingFromFirebase = true;
    store.setLibrary(fbLibrary);
    receivingFromFirebase = false;
    showToast("Library aus Firebase geladen", "success");
  }

  // 2. Subscribe to library updates
  onLibraryUpdate((items: LibraryItem[]) => {
    receivingFromFirebase = true;
    store.setLibrary(items);
    receivingFromFirebase = false;
  });

  // 3. Subscribe to current workspace
  resubscribeWorkspace();
}

function stopSync(): void {
  if (unsubWorkspace) { unsubWorkspace(); unsubWorkspace = null; }
  if (libSaveTimer)   { clearTimeout(libSaveTimer);  libSaveTimer  = null; }
  if (wsSaveTimer)    { clearTimeout(wsSaveTimer);   wsSaveTimer   = null; }
}

async function resubscribeWorkspace(): Promise<void> {
  if (!isEnabled() || !getFirebaseState().user) return;

  if (unsubWorkspace) { unsubWorkspace(); unsubWorkspace = null; }

  const wsKey = store.currentWorkspaceKey();

  // Load current workspace from Firebase
  const fbProject = await loadWorkspaceFromFirebase(wsKey);
  if (fbProject) {
    receivingFromFirebase = true;
    store.loadProject(fbProject as ExodusCraftProject);
    receivingFromFirebase = false;
    showToast(`Workspace "${wsKey}" aus Firebase geladen`, "success");
  }

  // Subscribe to live updates for this workspace
  unsubWorkspace = subscribeWorkspace(wsKey, (data: unknown) => {
    if (!data) return;
    receivingFromFirebase = true;
    // Merge: only update if data is newer than local
    const remote = data as ExodusCraftProject;
    const local  = store.getState().project;
    const remoteTime = new Date(remote.meta?.updatedAt ?? 0).getTime();
    const localTime  = new Date(local.meta?.updatedAt  ?? 0).getTime();
    if (remoteTime > localTime) {
      store.loadProject(remote);
      showToast("Workspace von anderem User aktualisiert", "info");
    }
    receivingFromFirebase = false;
  });
}

// ── Manual migration: localStorage → Firebase ─────────────
export async function migrateLocalToFirebase(): Promise<void> {
  if (!isEnabled() || !getFirebaseState().user) {
    showToast("Bitte erst anmelden", "warning");
    return;
  }

  const lib = store.getLibrary();
  if (lib.length > 0) {
    await saveLibraryToFirebase(lib);
  }

  const wsKey  = store.currentWorkspaceKey();
  const project = store.getState().project;
  await saveWorkspaceToFirebase(wsKey, project);

  showToast("Lokale Daten zu Firebase hochgeladen ✓", "success");
}

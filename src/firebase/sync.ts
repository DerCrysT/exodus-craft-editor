/**
 * Firebase Sync — Single source of truth
 *
 * ARCHITECTURE:
 * - Firebase speichert pro Workspace genau EINEN Datensatz:
 *     workspaces/{wsKey} = { nodes, edges, jsonData, canvas }
 *
 * - Lokale Änderungen → debounced save (2s) → Firebase
 * - Firebase update von anderem User → lokaler Store wird aktualisiert
 *
 * LOOP-SCHUTZ:
 * - receivingFromFirebase = true während wir Firebase-Daten anwenden
 * - Alle save-Scheduler prüfen receivingFromFirebase am Anfang
 * - setNodesFromFirebase/setEdgesFromFirebase emittieren kein json:formUpdate
 *   und kein node:add → kein syncJSONToNodes Loop
 *
 * GLEICHZEITIGE BEARBEITUNG:
 * - Beide User schreiben in denselben Workspace-Key
 * - Firebase schickt onValue bei jeder Änderung an alle Subscriber
 * - Wir wenden Remote-Updates IMMER an (kein Timestamp-Vergleich der scheitert)
 * - ABER: wir ignorieren Echo-Updates (eigene Writes kommen zurück)
 *   via writeInProgress Flag
 */

import { store } from "../state/AppStore";
import { bus } from "../state/EventEmitter";
import {
  isEnabled, saveLibraryToFirebase, loadLibraryFromFirebase,
  onLibraryUpdate, getFirebaseState, subscribeLibrary, updatePresence,
} from "../firebase/service";
import { getDatabase, ref, set, get, onValue, off } from "firebase/database";
import { getApps } from "firebase/app";
import type { CraftNode, CraftEdge, WorkbenchJSON, LibraryItem, CanvasState } from "../types/index";

// ── Types ──────────────────────────────────────────────────
interface WorkspaceSnapshot {
  nodes:    Record<string, CraftNode>;
  edges:    Record<string, CraftEdge>;
  jsonData: WorkbenchJSON;
  canvas?:  CanvasState;
}

// ── Helpers ────────────────────────────────────────────────
function db() {
  const app = getApps()[0];
  return app ? getDatabase(app) : null;
}

function sk(key: string): string {
  return key.replace(/[.#$[\]/]/g, "_");
}

// ── State ──────────────────────────────────────────────────
let unsubWorkspace: (() => void) | null = null;
let autoSyncTimer:  ReturnType<typeof setInterval> | null = null;
let libSubscribed = false;

// True while we're applying a Firebase update to the local store.
// Prevents local change events from triggering a save back to Firebase.
let receivingFromFirebase = false;

// True while we're writing to Firebase.
// The onValue callback fires for our own writes too — we skip those.
let writeInProgress = false;

// Debounce workspace saves
let saveTimer: ReturnType<typeof setTimeout> | null = null;

// ── Init ───────────────────────────────────────────────────
export function initFirebaseSync(): void {
  if (!isEnabled()) return;

  bus.on("firebase:auth", (e) => {
    const ev = e as { payload: unknown };
    if (ev.payload) startSync();
    else            stopSync();
  });

  // When user switches workspace → unsubscribe old, subscribe new
  bus.on("workspace:change", () => {
    if (!isEnabled() || !getFirebaseState().user) return;
    subscribeToWorkspace();
  });

  // Any local change → schedule a save to Firebase
  const scheduleLocalSave = () => {
    if (receivingFromFirebase) return;
    if (!isEnabled() || !getFirebaseState().user) return;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => saveCurrentWorkspace(), 2000);
  };

  bus.on("node:add",        scheduleLocalSave);
  bus.on("node:update",     scheduleLocalSave);
  bus.on("node:remove",     scheduleLocalSave);
  bus.on("node:move",       scheduleLocalSave);
  bus.on("edge:add",        scheduleLocalSave);
  bus.on("edge:remove",     scheduleLocalSave);
  bus.on("edge:update",     scheduleLocalSave);
  bus.on("json:formUpdate", scheduleLocalSave);
  bus.on("json:import",     scheduleLocalSave);
  bus.on("project:save",    scheduleLocalSave);
}

// ── Save workspace to Firebase ─────────────────────────────
async function saveCurrentWorkspace(): Promise<void> {
  const d = db();
  if (!d || !getFirebaseState().user) return;

  const wsKey = sk(store.currentWorkspaceKey());
  const state = store.getState().project;

  const snapshot: WorkspaceSnapshot = {
    nodes:    Object.fromEntries(state.nodes.map(n => [sk(n.id), n])),
    edges:    Object.fromEntries(state.edges.map(e => [sk(e.id), e])),
    jsonData: state.jsonData,
    canvas:   state.canvas,
  };

  writeInProgress = true;
  try {
    await set(ref(d, `workspaces/${wsKey}`), snapshot);
  } catch (e) {
    console.warn("Workspace save failed:", e);
  } finally {
    // Reset after a brief delay so the echo onValue fires and is ignored
    setTimeout(() => { writeInProgress = false; }, 1000);
  }
}

// ── Apply Firebase snapshot to local store ─────────────────
function applyRemoteSnapshot(snapshot: WorkspaceSnapshot): void {
  receivingFromFirebase = true;
  try {
    const nodes: CraftNode[] = snapshot.nodes
      ? Object.values(snapshot.nodes)
      : [];
    const edges: CraftEdge[] = snapshot.edges
      ? Object.values(snapshot.edges)
      : [];

    store.setNodesFromFirebase(nodes);
    store.setEdgesFromFirebase(edges);

    if (snapshot.jsonData) {
      // setJSONFromFirebase does NOT emit json:import → no syncJSONToNodes loop
      store.setJSONFromFirebase(snapshot.jsonData);
    }
  } finally {
    receivingFromFirebase = false;
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

  await subscribeToWorkspace();

  // Library auto-save every 30s
  if (autoSyncTimer) clearInterval(autoSyncTimer);
  autoSyncTimer = setInterval(() => {
    if (!isEnabled() || !getFirebaseState().user || receivingFromFirebase) return;
    saveLibraryToFirebase(store.getLibrary()).catch(console.warn);
  }, 30_000);
}

function stopSync(): void {
  unsubWorkspace?.(); unsubWorkspace = null;
  if (autoSyncTimer) { clearInterval(autoSyncTimer); autoSyncTimer = null; }
  if (saveTimer)     { clearTimeout(saveTimer);      saveTimer     = null; }
  libSubscribed = false;
}

// ── Subscribe to workspace ─────────────────────────────────
async function subscribeToWorkspace(): Promise<void> {
  const d = db();
  if (!d || !isEnabled() || !getFirebaseState().user) return;

  // Cancel previous subscription
  unsubWorkspace?.(); unsubWorkspace = null;

  const wsKey = sk(store.currentWorkspaceKey());
  const wsRef = ref(d, `workspaces/${wsKey}`);

  // Initial load
  try {
    const snap = await get(wsRef);
    if (snap.val()) {
      applyRemoteSnapshot(snap.val() as WorkspaceSnapshot);
    }
  } catch (e) { console.warn("Initial workspace load failed:", e); }

  // Live updates from other users
  onValue(wsRef, (snapshot) => {
    // Ignore our own writes echoing back
    if (writeInProgress) return;
    if (!snapshot.val()) return;
    applyRemoteSnapshot(snapshot.val() as WorkspaceSnapshot);
  });

  unsubWorkspace = () => off(wsRef);
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
      saveCurrentWorkspace(),
    ]);
    const el = document.getElementById("save-status");
    if (el) {
      el.textContent = "☁ Hochgeladen";
      setTimeout(() => { if (el) el.textContent = "Gespeichert"; }, 2000);
    }
  } catch (e) { console.error("Migration failed:", e); }
}

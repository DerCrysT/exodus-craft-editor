/**
 * Firebase Sync — Granular Node/Edge persistence
 * 
 * Statt den ganzen Workspace als Blob zu speichern, werden
 * Nodes und Edges als einzelne Firebase-Dokumente gespeichert:
 *   workspaces/{key}/nodes/{nodeId}  = CraftNode
 *   workspaces/{key}/edges/{edgeId}  = CraftEdge
 *   workspaces/{key}/json            = WorkbenchJSON (Formular-Daten)
 *   workspaces/{key}/canvas          = CanvasState
 * 
 * Damit überschreibt kein User den anderen — Firebase merged auf Dokument-Ebene.
 */

import { store } from "../state/AppStore";
import { bus } from "../state/EventEmitter";
import {
  isEnabled, saveLibraryToFirebase, loadLibraryFromFirebase,
  subscribeWorkspace, onLibraryUpdate, getFirebaseState,
  subscribeLibrary, updatePresence,
} from "../firebase/service";
import { getDatabase, ref, set, get, onValue, off, remove } from "firebase/database";
import { initializeApp, getApps } from "firebase/app";
import { FIREBASE_CONFIG } from "./config";
import type { CraftNode, CraftEdge, WorkbenchJSON, LibraryItem } from "../types/index";

// ── Helpers ────────────────────────────────────────────────
function getDb() {
  // Reuse existing Firebase app
  const app = getApps()[0];
  if (!app) return null;
  return getDatabase(app);
}

function sanitizeKey(key: string): string {
  return key.replace(/[.#$[\]/]/g, "_");
}

// ── State ──────────────────────────────────────────────────
let unsubNodes:    (() => void) | null = null;
let unsubEdges:    (() => void) | null = null;
let unsubJson:     (() => void) | null = null;
let autoSyncTimer: ReturnType<typeof setInterval> | null = null;
let receivingFromFirebase = false;
let libSubscribed = false;

// Debounce timers for local → Firebase
let nodeSaveTimer:   ReturnType<typeof setTimeout> | null = null;
let edgeSaveTimer:   ReturnType<typeof setTimeout> | null = null;
let jsonSaveTimer:   ReturnType<typeof setTimeout> | null = null;
let canvasSaveTimer: ReturnType<typeof setTimeout> | null = null;

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

  // Listen to local changes → push to Firebase (debounced)
  bus.on("node:add",     () => scheduleNodeSave());
  bus.on("node:update",  () => scheduleNodeSave());
  bus.on("node:remove",  () => scheduleNodeSave());
  bus.on("node:move",    () => scheduleNodeSave());
  bus.on("edge:add",     () => scheduleEdgeSave());
  bus.on("edge:remove",  () => scheduleEdgeSave());
  bus.on("edge:update",  () => scheduleEdgeSave());
  bus.on("json:formUpdate", () => scheduleJsonSave());
  bus.on("json:import",  () => { scheduleNodeSave(); scheduleEdgeSave(); scheduleJsonSave(); });
}

// ── Save schedulers ────────────────────────────────────────
function scheduleNodeSave(): void {
  if (receivingFromFirebase) return;
  if (!isEnabled() || !getFirebaseState().user) return;
  if (nodeSaveTimer) clearTimeout(nodeSaveTimer);
  nodeSaveTimer = setTimeout(() => saveNodes(), 1000);
}

function scheduleEdgeSave(): void {
  if (receivingFromFirebase) return;
  if (!isEnabled() || !getFirebaseState().user) return;
  if (edgeSaveTimer) clearTimeout(edgeSaveTimer);
  edgeSaveTimer = setTimeout(() => saveEdges(), 1000);
}

function scheduleJsonSave(): void {
  if (receivingFromFirebase) return;
  if (!isEnabled() || !getFirebaseState().user) return;
  if (jsonSaveTimer) clearTimeout(jsonSaveTimer);
  jsonSaveTimer = setTimeout(() => saveJson(), 1000);
}

// ── Granular save functions ────────────────────────────────
async function saveNodes(): Promise<void> {
  const db = getDb();
  if (!db || !getFirebaseState().user) return;
  const wsKey = sanitizeKey(store.currentWorkspaceKey());
  const nodes = store.getNodes();
  try {
    // Write all current nodes as a map {nodeId: nodeData}
    const nodesObj = Object.fromEntries(
      nodes.map(n => [n.id.replace(/[.#$[\]/]/g, "_"), JSON.parse(JSON.stringify(n))])
    );
    await set(ref(db, `workspaces/${wsKey}/nodes`), nodesObj);
  } catch (e) { console.warn("Node save failed:", e); }
}

async function saveEdges(): Promise<void> {
  const db = getDb();
  if (!db || !getFirebaseState().user) return;
  const wsKey = sanitizeKey(store.currentWorkspaceKey());
  const edges = store.getEdges();
  try {
    const edgesObj = Object.fromEntries(
      edges.map(e => [e.id.replace(/[.#$[\]/]/g, "_"), JSON.parse(JSON.stringify(e))])
    );
    await set(ref(db, `workspaces/${wsKey}/edges`), edgesObj);
  } catch (e) { console.warn("Edge save failed:", e); }
}

async function saveJson(): Promise<void> {
  const db = getDb();
  if (!db || !getFirebaseState().user) return;
  const wsKey = sanitizeKey(store.currentWorkspaceKey());
  try {
    await set(ref(db, `workspaces/${wsKey}/json`), JSON.parse(JSON.stringify(store.getJSON())));
  } catch (e) { console.warn("JSON save failed:", e); }
}

// ── Start / stop ───────────────────────────────────────────
async function startSync(): Promise<void> {
  // Library
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

  await resubscribeWorkspace();

  // Library auto-save every 30s (library changes less often)
  autoSyncTimer = setInterval(() => {
    if (!isEnabled() || !getFirebaseState().user || receivingFromFirebase) return;
    saveLibraryToFirebase(store.getLibrary()).catch(console.warn);
  }, 30_000);
}

function stopSync(): void {
  unsubNodes?.(); unsubNodes = null;
  unsubEdges?.(); unsubEdges = null;
  unsubJson?.();  unsubJson  = null;
  if (autoSyncTimer) { clearInterval(autoSyncTimer); autoSyncTimer = null; }
  libSubscribed = false;
}

// ── Workspace subscription ─────────────────────────────────
async function resubscribeWorkspace(): Promise<void> {
  const db = getDb();
  if (!db || !isEnabled() || !getFirebaseState().user) return;

  // Unsubscribe previous
  unsubNodes?.(); unsubNodes = null;
  unsubEdges?.(); unsubEdges = null;
  unsubJson?.();  unsubJson  = null;

  const wsKey = sanitizeKey(store.currentWorkspaceKey());

  // ── Initial load ───────────────────────────────────────
  try {
    const [nodesSnap, edgesSnap, jsonSnap] = await Promise.all([
      get(ref(db, `workspaces/${wsKey}/nodes`)),
      get(ref(db, `workspaces/${wsKey}/edges`)),
      get(ref(db, `workspaces/${wsKey}/json`)),
    ]);

    receivingFromFirebase = true;
    try {
      if (nodesSnap.val()) {
        const nodes: CraftNode[] = Object.values(nodesSnap.val());
        store.setNodesFromFirebase(nodes);
      }
      if (edgesSnap.val()) {
        const edges: CraftEdge[] = Object.values(edgesSnap.val());
        store.setEdgesFromFirebase(edges);
      }
      if (jsonSnap.val()) {
        store.setJSON(jsonSnap.val() as WorkbenchJSON);
      }
    } finally { receivingFromFirebase = false; }
  } catch (e) { console.warn("Initial workspace load failed:", e); }

  // ── Live subscriptions ────────────────────────────────
  const nodesRef = ref(db, `workspaces/${wsKey}/nodes`);
  onValue(nodesRef, snapshot => {
    if (!snapshot.val() || receivingFromFirebase) return;
    const nodes: CraftNode[] = Object.values(snapshot.val());
    receivingFromFirebase = true;
    try { store.setNodesFromFirebase(nodes); }
    finally { receivingFromFirebase = false; }
  });
  unsubNodes = () => off(nodesRef);

  const edgesRef = ref(db, `workspaces/${wsKey}/edges`);
  onValue(edgesRef, snapshot => {
    if (!snapshot.val() || receivingFromFirebase) return;
    const edges: CraftEdge[] = Object.values(snapshot.val());
    receivingFromFirebase = true;
    try { store.setEdgesFromFirebase(edges); }
    finally { receivingFromFirebase = false; }
  });
  unsubEdges = () => off(edgesRef);

  const jsonRef = ref(db, `workspaces/${wsKey}/json`);
  onValue(jsonRef, snapshot => {
    if (!snapshot.val() || receivingFromFirebase) return;
    receivingFromFirebase = true;
    try { store.setJSON(snapshot.val() as WorkbenchJSON); }
    finally { receivingFromFirebase = false; }
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
    await Promise.all([
      saveLibraryToFirebase(store.getLibrary()),
      saveNodes(),
      saveEdges(),
      saveJson(),
    ]);
    const el = document.getElementById("save-status");
    if (el) {
      el.textContent = "☁ Hochgeladen";
      setTimeout(() => { if (el) el.textContent = "Gespeichert"; }, 2000);
    }
  } catch (e) { console.error("Migration failed:", e); }
}

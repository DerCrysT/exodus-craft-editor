import type {
  AppState,
  AppSnapshot,
  CraftNode,
  CraftEdge,
  NodeId,
  EdgeId,
  ExodusCraftProject,
  WorkbenchJSON,
  LibraryItem,
  Faction,
  WorkbenchType,
  ProjectMeta,
} from "../types/index";
import { bus } from "./EventEmitter";
import { WORKBENCH_DEFS } from "../data/workbenches";

const STORAGE_KEY = "exodus_craft_project";
const LIBRARY_KEY = "exodus_craft_library";
const MAX_UNDO = 50;

function defaultJSON(): WorkbenchJSON {
  return {
    WorkbenchesClassnames: ["Exodus_WB_Kleidung"],
    CraftCategories: [],
    m_CustomizationSetting: {
      PathToMainBackgroundImg: "",
      PathToCraftImg: "",
    },
  };
}

function defaultMeta(): ProjectMeta {
  return {
    name: "Neues Projekt",
    version: "1.0.0",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function defaultProject(): ExodusCraftProject {
  return {
    meta: defaultMeta(),
    nodes: [],
    edges: [],
    canvas: { offsetX: 0, offsetY: 0, zoom: 1 },
    openTabs: ["node-editor"],
    activeTab: "node-editor",
    jsonData: defaultJSON(),
  };
}

function defaultState(): AppState {
  return {
    project: defaultProject(),
    library: [],
    selectedNodes: new Set(),
    selectedEdge: null,
    isDirty: false,
    undoStack: [],
    redoStack: [],
    activeMode: "node",
    theme: "dark",
    activeFaction: null,
    activeWorkbench: "Kleidung",
  };
}

class AppStore {
  private state: AppState = defaultState();

  // ── Getters ──────────────────────────────────────────────

  getState(): Readonly<AppState> {
    return this.state;
  }

  getNodes(): CraftNode[] {
    return this.state.project.nodes;
  }

  getEdges(): CraftEdge[] {
    return this.state.project.edges;
  }

  getNode(id: NodeId): CraftNode | undefined {
    return this.state.project.nodes.find((n) => n.id === id);
  }

  getEdge(id: EdgeId): CraftEdge | undefined {
    return this.state.project.edges.find((e) => e.id === id);
  }

  getJSON(): WorkbenchJSON {
    return this.state.project.jsonData;
  }

  getLibrary(): LibraryItem[] {
    return this.state.library;
  }

  // ── Snapshot (Undo/Redo) ─────────────────────────────────

  private snapshot(): AppSnapshot {
    return {
      nodes: JSON.parse(JSON.stringify(this.state.project.nodes)),
      edges: JSON.parse(JSON.stringify(this.state.project.edges)),
      jsonData: JSON.parse(JSON.stringify(this.state.project.jsonData)),
      timestamp: Date.now(),
    };
  }

  private pushUndo(): void {
    this.state.undoStack.push(this.snapshot());
    if (this.state.undoStack.length > MAX_UNDO) {
      this.state.undoStack.shift();
    }
    this.state.redoStack = [];
  }

  undo(): void {
    const snap = this.state.undoStack.pop();
    if (!snap) return;
    this.state.redoStack.push(this.snapshot());
    this.applySnapshot(snap);
    bus.emit("undo");
    bus.emit("state:change");
  }

  redo(): void {
    const snap = this.state.redoStack.pop();
    if (!snap) return;
    this.state.undoStack.push(this.snapshot());
    this.applySnapshot(snap);
    bus.emit("redo");
    bus.emit("state:change");
  }

  private applySnapshot(snap: AppSnapshot): void {
    this.state.project.nodes = snap.nodes;
    this.state.project.edges = snap.edges;
    this.state.project.jsonData = snap.jsonData;
    this.state.isDirty = true;
  }

  // ── Node Operations ───────────────────────────────────────

  addNode(node: CraftNode): void {
    this.pushUndo();
    this.state.project.nodes.push(node);
    this.state.isDirty = true;
    bus.emit("node:add", node);
    bus.emit("state:change");
    this.autosave();
  }

  removeNode(id: NodeId): void {
    this.pushUndo();
    this.state.project.nodes = this.state.project.nodes.filter(
      (n) => n.id !== id
    );
    this.state.project.edges = this.state.project.edges.filter(
      (e) => e.sourceNodeId !== id && e.targetNodeId !== id
    );
    this.state.selectedNodes.delete(id);
    this.state.isDirty = true;
    bus.emit("node:remove", { id });
    bus.emit("state:change");
    this.autosave();
  }

  moveNode(id: NodeId, x: number, y: number): void {
    const node = this.state.project.nodes.find((n) => n.id === id);
    if (!node) return;
    node.position = { x, y };
    this.state.isDirty = true;
    bus.emit("node:move", { id, x, y });
  }

  // Call once at drag START (before any move) to snapshot the pre-drag state
  snapshotBeforeDrag(): void {
    this.pushUndo();
  }

  commitNodeMove(_id: NodeId): void {
    // Position already mutated via moveNode; just autosave
    this.autosave();
  }

  updateNode(id: NodeId, patch: Partial<CraftNode>): void {
    this.pushUndo();
    const node = this.state.project.nodes.find((n) => n.id === id);
    if (!node) return;
    Object.assign(node, patch);
    this.state.isDirty = true;
    bus.emit("node:update", { id, patch });
    bus.emit("state:change");
    this.autosave();
  }

  // ── Edge Operations ───────────────────────────────────────

  addEdge(edge: CraftEdge): boolean {
    // Prevent duplicate edges
    const exists = this.state.project.edges.some(
      (e) =>
        e.sourceNodeId === edge.sourceNodeId &&
        e.targetNodeId === edge.targetNodeId
    );
    if (exists) return false;
    // Prevent self-loops
    if (edge.sourceNodeId === edge.targetNodeId) return false;
    this.pushUndo();
    this.state.project.edges.push(edge);
    this.state.isDirty = true;
    bus.emit("edge:add", edge);
    bus.emit("state:change");
    this.autosave();
    return true;
  }

  removeEdge(id: EdgeId): void {
    this.pushUndo();
    this.state.project.edges = this.state.project.edges.filter(
      (e) => e.id !== id
    );
    if (this.state.selectedEdge === id) this.state.selectedEdge = null;
    this.state.isDirty = true;
    bus.emit("edge:remove", { id });
    bus.emit("state:change");
    this.autosave();
  }

  updateEdge(id: EdgeId, patch: Partial<CraftEdge>): void {
    this.pushUndo();
    const edge = this.state.project.edges.find((e) => e.id === id);
    if (!edge) return;
    Object.assign(edge, patch);
    this.state.isDirty = true;
    bus.emit("edge:update", { id, patch });
    bus.emit("state:change");
    this.autosave();
  }

  // ── Selection ─────────────────────────────────────────────

  selectNode(id: NodeId, multi = false): void {
    if (!multi) this.state.selectedNodes.clear();
    this.state.selectedNodes.add(id);
    this.state.selectedEdge = null;
    bus.emit("state:change");
  }

  deselectAll(): void {
    this.state.selectedNodes.clear();
    this.state.selectedEdge = null;
    bus.emit("state:change");
  }

  selectEdge(id: EdgeId): void {
    this.state.selectedNodes.clear();
    this.state.selectedEdge = id;
    bus.emit("state:change");
  }

  // ── JSON ──────────────────────────────────────────────────

  setJSON(data: WorkbenchJSON): void {
    this.pushUndo();
    this.state.project.jsonData = JSON.parse(JSON.stringify(data));
    this.state.isDirty = true;
    bus.emit("json:import", data);
    bus.emit("state:change");
    this.autosave();
  }

  updateJSON(patch: Partial<WorkbenchJSON>): void {
    this.pushUndo();
    Object.assign(this.state.project.jsonData, patch);
    this.state.isDirty = true;
    bus.emit("json:formUpdate");   // triggers node sync without causing import loop
    bus.emit("state:change");
    this.autosave();
  }

  // ── Library ───────────────────────────────────────────────

  setLibrary(items: LibraryItem[]): void {
    // Clean up image keys for removed items
    const newClassnames = new Set(items.map(i => i.classname));
    this.state.library.forEach(old => {
      if (!newClassnames.has(old.classname)) {
        localStorage.removeItem(`${LIBRARY_KEY}_img_${old.classname}`);
      }
    });
    this.state.library = items;
    this.saveLibrary();
    bus.emit("state:change");
  }

  addLibraryItem(item: LibraryItem): void {
    const existing = this.state.library.findIndex(
      (i) => i.classname === item.classname
    );
    if (existing >= 0) {
      this.state.library[existing] = item;
    } else {
      this.state.library.push(item);
    }
    this.saveLibrary();
    bus.emit("state:change");
  }

  // ── Project Load/Save ─────────────────────────────────────

  loadProject(project: ExodusCraftProject): void {
    this.state.project = JSON.parse(JSON.stringify(project));
    this.state.selectedNodes = new Set();
    this.state.selectedEdge = null;
    this.state.undoStack = [];
    this.state.redoStack = [];
    this.state.isDirty = false;
    bus.emit("project:load", project);
    bus.emit("state:change");
  }

  setMode(mode: "form" | "node"): void {
    this.state.activeMode = mode;
    bus.emit("mode:change", mode);
    bus.emit("state:change");
  }

  setTheme(theme: AppState["theme"]): void {
    this.state.theme = theme;
    document.documentElement.setAttribute("data-theme", theme);
    bus.emit("theme:change", theme);
  }

  // ── Workspace Key ─────────────────────────────────────────
  // Each workbench+faction combination is its own isolated workspace.

  currentWorkspaceKey(): string {
    const wb = this.state.activeWorkbench ?? "Kleidung";
    const f  = this.state.activeFaction;
    return f ? `${wb}_${f}` : wb;
  }

  private workspaceStorageKey(key: string): string {
    return `exodus_ws_${key}`;
  }

  private saveCurrentWorkspace(): void {
    const key  = this.currentWorkspaceKey();
    const data = JSON.stringify(this.state.project);
    try {
      localStorage.setItem(this.workspaceStorageKey(key), data);
    } catch {}
  }

  private loadWorkspace(key: string): void {
    try {
      const raw = localStorage.getItem(this.workspaceStorageKey(key));
      if (raw) {
        const project: ExodusCraftProject = JSON.parse(raw);
        this.loadProject(project);
      } else {
        // Fresh workspace for this wb/faction combo
        this.loadProject(this.freshWorkspaceProject(key));
      }
    } catch {
      this.loadProject(this.freshWorkspaceProject(key));
    }
  }

  private freshWorkspaceProject(key: string): ExodusCraftProject {
    const [wb, faction] = key.includes("_")
      ? [key.slice(0, key.indexOf("_")), key.slice(key.indexOf("_") + 1)]
      : [key, undefined];
    const wbClassname = faction
      ? `Exodus_WB_${wb}_${faction}`
      : `Exodus_WB_${wb}`;
    return {
      meta: {
        name: faction ? `${wb} — ${faction}` : wb,
        version: "1.0.0",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      nodes: [],
      edges: [],
      canvas: { offsetX: 0, offsetY: 0, zoom: 1 },
      openTabs: ["node-editor"],
      activeTab: "node-editor",
      jsonData: {
        WorkbenchesClassnames: [wbClassname],
        CraftCategories: [],
        m_CustomizationSetting: { PathToMainBackgroundImg: "", PathToCraftImg: "" },
      },
    };
  }

  setFaction(faction: Faction | null): void {
    // Save current workspace before switching
    this.saveCurrentWorkspace();
    this.state.activeFaction = faction;
    this.state.undoStack = [];
    this.state.redoStack = [];
    this.loadWorkspace(this.currentWorkspaceKey());
    bus.emit("workspace:change", this.currentWorkspaceKey());
  }

  setWorkbench(wb: WorkbenchType | null): void {
    // Save current workspace before switching
    this.saveCurrentWorkspace();
    this.state.activeWorkbench = wb;
    this.state.undoStack = [];
    this.state.redoStack = [];
    this.loadWorkspace(this.currentWorkspaceKey());
    bus.emit("workspace:change", this.currentWorkspaceKey());
  }

  setCanvas(canvas: Partial<ExodusCraftProject["canvas"]>): void {
    Object.assign(this.state.project.canvas, canvas);
    // No undo for canvas pan/zoom
  }

  // ── Persistence ───────────────────────────────────────────

  private autosaveTimer: ReturnType<typeof setTimeout> | null = null;

  autosave(): void {
    if (this.autosaveTimer) clearTimeout(this.autosaveTimer);
    this.autosaveTimer = setTimeout(() => {
      this.saveToStorage();
    }, 500);
  }

  saveToStorage(): void {
    try {
      // Always update timestamp so Firebase sync can compare versions
      this.state.project.meta.updatedAt = new Date().toISOString();

      const wsData = JSON.stringify(this.state.project);
      localStorage.setItem(this.workspaceStorageKey(this.currentWorkspaceKey()), wsData);
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        activeWorkbench:    this.state.activeWorkbench,
        activeFaction:      this.state.activeFaction,
        activeWorkspaceKey: this.currentWorkspaceKey(),
      }));
      this.state.isDirty = false;
      bus.emit("project:save");
    } catch (e) {
      console.error("Autosave failed:", e);
    }
  }

  loadFromStorage(): boolean {
    try {
      // Load which workspace was last active
      const metaRaw = localStorage.getItem(STORAGE_KEY);
      if (!metaRaw) return false;
      const meta = JSON.parse(metaRaw);

      // Restore active workbench/faction first
      if (meta.activeWorkbench) this.state.activeWorkbench = meta.activeWorkbench;
      if (meta.activeFaction !== undefined) this.state.activeFaction = meta.activeFaction;

      // Load library BEFORE emitting state:change
      this.loadLibraryFromStorage();

      // Load the workspace project
      const wsKey = meta.activeWorkspaceKey ?? this.currentWorkspaceKey();
      const wsRaw = localStorage.getItem(this.workspaceStorageKey(wsKey));
      if (wsRaw) {
        const project: ExodusCraftProject = JSON.parse(wsRaw);
        this.loadProject(project);
      }
      return true;
    } catch (e) {
      console.error("Load from storage failed:", e);
      return false;
    }
  }

  private saveLibrary(): void {
    try {
      // Save metadata without imageUrl (images stored separately per classname)
      const meta = this.state.library.map(item => ({
        classname:   item.classname,
        displayName: item.displayName,
        category:    item.category,
        tags:        item.tags,
        // imageUrl stored separately — do NOT include here
      }));
      localStorage.setItem(LIBRARY_KEY, JSON.stringify(meta));

      // Save each image separately under its own key to stay within 5MB limit
      this.state.library.forEach(item => {
        if (item.imageUrl) {
          try {
            localStorage.setItem(`${LIBRARY_KEY}_img_${item.classname}`, item.imageUrl);
          } catch {
            // Image too large — skip silently, item will show without image
            console.warn(`Image for ${item.classname} too large for localStorage, skipped`);
          }
        } else {
          // Clean up any stale image key
          localStorage.removeItem(`${LIBRARY_KEY}_img_${item.classname}`);
        }
      });
    } catch (e) {
      console.error("Library save failed:", e);
    }
  }

  loadLibraryFromStorage(): void {
    try {
      const raw = localStorage.getItem(LIBRARY_KEY);
      if (!raw) return;
      const meta: Array<Omit<LibraryItem, "imageUrl">> = JSON.parse(raw);
      // Restore images from their separate keys
      this.state.library = meta.map(item => ({
        ...item,
        imageUrl: localStorage.getItem(`${LIBRARY_KEY}_img_${item.classname}`) ?? undefined,
      }));
    } catch (e) {
      console.error("Library load failed:", e);
    }
  }

  exportProjectFile(): string {
    return JSON.stringify(
      {
        __type: "ExodusCraftProject",
        __version: "1.0",
        ...this.state.project,
      },
      null,
      2
    );
  }

  exportJSON(): string {
    return JSON.stringify(this.state.project.jsonData, null, 4);
  }

  getWorkbenchTools(): string[] {
    const wb = this.state.activeWorkbench;
    if (!wb) return [];
    const def = WORKBENCH_DEFS.find((d) => d.type === wb);
    return def ? def.tools.map((t) => t.classname) : [];
  }
}

export const store = new AppStore();

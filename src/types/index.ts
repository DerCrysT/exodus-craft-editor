// ============================================================
// EXODUS CRAFT EDITOR — Core Types
// ============================================================

// --- JSON Data Structure (exact mod format) ---

export interface CraftComponent {
  Classname: string;
  Amount: number;
  Destroy: boolean;
  Changehealth: number;
}

export interface CraftItem {
  Result: string;
  ResultShow: string;
  ResultCount: number;
  ComponentsDontAffectHealth: number;
  CraftType: "craft" | "disassemble" | "repair";
  RecipeName: string;
  CraftComponents: CraftComponent[];
  AttachmentsNeed: string[];
}

export interface CraftCategory {
  CategoryName: string;
  CraftItems: CraftItem[];
}

export interface CustomizationSetting {
  PathToMainBackgroundImg: string;
  PathToCraftImg: string;
}

export interface WorkbenchJSON {
  WorkbenchesClassnames: string[];
  CraftCategories: CraftCategory[];
  m_CustomizationSetting: CustomizationSetting;
}

// --- Workbench System ---

export type WorkbenchType =
  | "Kleidung"
  | "Medizin"
  | "Waffen"
  | "Werkbank"
  | "Wissenschaft";

export type Faction =
  | "Bandits"
  | "ClearSky"
  | "Digger"
  | "Duty"
  | "Ecologist"
  | "Freedom"
  | "FreeStalker"
  | "IPSF"
  | "Loner"
  | "Mercenary"
  | "Military"
  | "Monoltih"
  | "Noontide"
  | "Spark"
  | "UNISG"
  | "Warden";

export interface WorkbenchTool {
  classname: string;
  label: string;
}

export interface WorkbenchDef {
  type: WorkbenchType;
  baseClassname: string;
  tools: WorkbenchTool[];
}

// --- Node Editor Types ---

export type NodeId = string;
export type EdgeId = string;

export interface NodePosition {
  x: number;
  y: number;
}

export interface CraftNode {
  id: NodeId;
  classname: string;
  displayName: string;
  imageUrl?: string;
  position: NodePosition;
  nodeType?: "recipe" | "comment";   // default = "recipe"
  commentText?: string;              // only for comment nodes
  commentColor?: string;             // background tint for comment
  // Recipe properties (shown on node)
  recipeName?: string;
  craftType?: CraftItem["CraftType"];
  resultCount?: number;
  componentsDontAffectHealth?: number;
  attachmentsNeed?: string[];
  category?: string;
  customFlags?: Record<string, unknown>;
}

export interface CraftEdge {
  id: EdgeId;
  sourceNodeId: NodeId; // component (OUT)
  targetNodeId: NodeId; // result (IN)
  amount: number;        // CraftComponents.Amount
  destroy: boolean;
  changehealth: number;
}

// --- Canvas / Project State ---

export interface CanvasState {
  offsetX: number;
  offsetY: number;
  zoom: number;
}

export interface ProjectMeta {
  name: string;
  version: string;
  createdAt: string;
  updatedAt: string;
  faction?: Faction;
  workbench?: WorkbenchType;
}

export interface ExodusCraftProject {
  meta: ProjectMeta;
  nodes: CraftNode[];
  edges: CraftEdge[];
  canvas: CanvasState;
  openTabs: string[];
  activeTab: string;
  jsonData: WorkbenchJSON;
}

// --- Library ---

export interface LibraryItem {
  classname: string;
  displayName: string;
  imageUrl?: string;
  category?: string;
  tags?: string[];
}

// --- App State ---

export interface AppState {
  project: ExodusCraftProject;
  library: LibraryItem[];
  selectedNodes: Set<NodeId>;
  selectedEdge: EdgeId | null;
  isDirty: boolean;
  undoStack: AppSnapshot[];
  redoStack: AppSnapshot[];
  activeMode: "form" | "node";
  theme: "dark" | "light" | "soft-dark";
  activeFaction: Faction | null;
  activeWorkbench: WorkbenchType | null;
}

export interface AppSnapshot {
  nodes: CraftNode[];
  edges: CraftEdge[];
  jsonData: WorkbenchJSON;
  timestamp: number;
}

// --- Validation ---

export type ValidationSeverity = "error" | "warning" | "info";

export interface ValidationIssue {
  id: string;
  severity: ValidationSeverity;
  message: string;
  nodeId?: NodeId;
  edgeId?: EdgeId;
  recipeIndex?: number;
}

// --- Events ---

export type AppEventType =
  | "state:change"
  | "node:add"
  | "node:remove"
  | "node:move"
  | "node:update"
  | "edge:add"
  | "edge:remove"
  | "edge:update"
  | "project:load"
  | "project:save"
  | "json:import"
  | "json:export"
  | "mode:change"
  | "theme:change"
  | "validation:run"
  | "workspace:change"
  | "json:formUpdate"
  | "firebase:auth"
  | "firebase:presence"
  | "firebase:library"
  | "undo"
  | "redo";

export interface AppEvent<T = unknown> {
  type: AppEventType;
  payload?: T;
}

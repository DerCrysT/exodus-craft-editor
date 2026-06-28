import { store } from "../../state/AppStore";
import { bus } from "../../state/EventEmitter";
import type { CraftNode, CraftEdge, NodeId, EdgeId } from "../../types/index";
import { setZoomDisplay, showToast } from "../toolbar/Toolbar";
import { WORKBENCH_DEFS } from "../../data/workbenches";
import { virtualRenderer } from "./VirtualRenderer";
import { copyNodesToClipboard, getClipboard } from "../../data/clipboard";

// ── Constants ──────────────────────────────────────────────
const GRID        = 20;
const NODE_W      = 184;
const NODE_H      = 90;   // approximate
const MIN_ZOOM    = 0.12;
const MAX_ZOOM    = 3.5;
const DBL_MS      = 280;

// ── Module State ───────────────────────────────────────────
let root:           HTMLElement;
let nodesLayer:     HTMLElement;
let edgesSVG:       SVGSVGElement;
let edgesGroup:     SVGGElement;
let draftPath:      SVGPathElement;
let selBox:         HTMLElement;

let ox = 0, oy = 0, zoom = 1;

// Panning
let panning    = false;
let panX0 = 0, panY0 = 0;

// Multi-node drag — stores start position for every dragged node
interface DragOffset { nx0: number; ny0: number; }
let dragId:     NodeId | null = null;
let dragOffsets = new Map<NodeId, DragOffset>(); // all selected nodes
let dragMX0     = 0, dragMY0 = 0;
let dragMoved   = false;

// Box select
let boxing     = false;
let boxCX0     = 0, boxCY0 = 0; // canvas coords

// Draft edge
let draftSrc:  NodeId | null   = null;
let draftPort: "in" | "out" | null = null;

// Double-click detection
let lastClickId:   NodeId | null = null;
let lastClickTime  = 0;

// Edge label editing
let editingEdgeId: EdgeId | null = null;

// Edge labels HTML overlay (outside SVG transform to avoid foreignObject issues)

// Category filter
let activeCategories = new Set<string>(); // empty = show all
let focusedNodeId: string | null = null;  // Ctrl+click chain isolation

// ── Init ───────────────────────────────────────────────────
export function initNodeEditor(): void {
  root        = document.getElementById("node-editor-root")!;
  nodesLayer  = document.getElementById("canvas-nodes")!;
  edgesSVG    = document.getElementById("canvas-edges") as unknown as SVGSVGElement;
  // Allow pointer events on interactive child elements despite CSS pointer-events:none on container
  // We set this via attribute which overrides CSS in SVG
  edgesGroup  = document.getElementById("edges-group") as unknown as SVGGElement;
  draftPath   = document.getElementById("draft-edge") as unknown as SVGPathElement;
  selBox      = document.getElementById("selection-box")!;

  // Note: edge labels are now rendered as SVG elements in edgesGroup
  // so they automatically follow pan/zoom via the group transform

  // Create category filter bar
  initCategoryFilterBar();

  initZoomControls();
  initCanvasEvents();
  initDropZone();
  initAlignmentToolbar();
  initContextMenu();

  bus.on("state:change",  () => renderAll());
  bus.on("node:add",      () => renderAll());
  bus.on("node:move",     () => renderEdges());
  bus.on("node:update",   () => renderAll());
  bus.on("edge:add",      () => renderEdges());
  bus.on("edge:remove",   () => renderEdges());
  bus.on("edge:update",   () => renderEdges());
  bus.on("project:load",  () => {
    const c = store.getState().project.canvas;
    ox = c.offsetX; oy = c.offsetY; zoom = c.zoom;
    applyTransform(); renderAll();
  });

  // Defer first render until browser has computed layout
  // (prevents freeze when loading from LocalStorage on startup)
  requestAnimationFrame(() => {
    virtualRenderer.update(root.getBoundingClientRect());
    renderAll();
  });
}

// ── Transform ──────────────────────────────────────────────
function applyTransform(): void {
  nodesLayer.style.transform       = `translate(${ox}px,${oy}px) scale(${zoom})`;
  nodesLayer.style.transformOrigin = "0 0";
  edgesGroup.setAttribute("transform", `translate(${ox},${oy}) scale(${zoom})`);
  setZoomDisplay(zoom);
  store.setCanvas({ offsetX: ox, offsetY: oy, zoom });
  // Virtual culling — only for large graphs
  virtualRenderer.update(root.getBoundingClientRect());
  virtualRenderer.applyVisibility(store.getNodes(), ox, oy, zoom);
  // Reposition HTML edge labels to match new pan/zoom
  renderEdges();
  renderMinimap();
}

function snap(v: number): number { return Math.round(v / GRID) * GRID; }

function toCanvas(sx: number, sy: number): { x: number; y: number } {
  const r = root.getBoundingClientRect();
  return { x: (sx - r.left - ox) / zoom, y: (sy - r.top - oy) / zoom };
}

// ── Zoom ───────────────────────────────────────────────────
function initZoomControls(): void {
  document.getElementById("zoom-in")!   .addEventListener("click", () => doZoom(1.25));
  document.getElementById("zoom-out")!  .addEventListener("click", () => doZoom(0.8));
  document.getElementById("zoom-reset")!.addEventListener("click", () => { ox=0; oy=0; zoom=1; applyTransform(); });
}

function doZoom(factor: number, cx?: number, cy?: number): void {
  const r   = root.getBoundingClientRect();
  const px  = cx ?? r.width  / 2;
  const py  = cy ?? r.height / 2;
  const nz  = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom * factor));
  const sc  = nz / zoom;
  ox = px - sc * (px - ox);
  oy = py - sc * (py - oy);
  zoom = nz;
  applyTransform();
}

// ── Canvas Events ──────────────────────────────────────────
function initCanvasEvents(): void {
  // Wheel zoom
  root.addEventListener("wheel", e => {
    e.preventDefault();
    const r = root.getBoundingClientRect();
    doZoom(e.deltaY < 0 ? 1.1 : 0.9, e.clientX - r.left, e.clientY - r.top);
  }, { passive: false });

  root.addEventListener("mousedown", onCanvasMouseDown);
  window.addEventListener("mousemove", onWindowMouseMove);
  window.addEventListener("mouseup",   onWindowMouseUp);

  // Keyboard
  window.addEventListener("keydown", onKeyDown);
}

function onCanvasMouseDown(e: MouseEvent): void {
  const target = e.target as HTMLElement;

  // Middle mouse OR alt+left → pan
  if (e.button === 1 || (e.button === 0 && e.altKey)) {
    e.preventDefault();
    panning = true;
    panX0 = e.clientX - ox;
    panY0 = e.clientY - oy;
    root.style.cursor = "grabbing";
    return;
  }

  // SVG edge hit — hitPath or labelBg clicked directly
  const edgeDelId = (target as Element).getAttribute("data-edge-del");
  if (edgeDelId && e.button === 0) {
    e.stopPropagation();
    store.removeEdge(edgeDelId);
    return;
  }
  const edgeId = (target as Element).getAttribute("data-edge-id");
  if (edgeId && e.button === 0) {
    e.stopPropagation();
    const alreadySelected = store.getState().selectedEdge === edgeId;
    if (alreadySelected) openEdgeAmountModal(edgeId);
    else store.selectEdge(edgeId);
    return;
  }

  // Port click → start draft edge
  if (target.classList.contains("port") && e.button === 0) {
    e.stopPropagation();
    draftSrc  = target.dataset.node!;
    draftPort = target.dataset.port as "in" | "out";
    draftPath.style.display = "";
    return;
  }

  // Click on node → drag or select
  const nodeEl = target.closest<HTMLElement>(".craft-node, .comment-node");
  if (nodeEl && e.button === 0 && !target.classList.contains("port")
      && !target.classList.contains("node-action-btn")
      && !target.classList.contains("comment-edit-btn")
      && !target.classList.contains("comment-color-btn")
      && !(target as HTMLElement).closest(".comment-text[contenteditable='true']")) {
    e.stopPropagation();
    const id = nodeEl.dataset.nodeId!;

    // ── Ctrl/Cmd+click = chain isolation filter ───────────────
    // Must be checked BEFORE double-click detection
    if ((e.ctrlKey || e.metaKey) && nodeEl.classList.contains("craft-node")) {
      e.preventDefault();
      focusedNodeId = (focusedNodeId === id) ? null : id;
      updateCategoryFilterUI();
      renderAll();
      return;
    }

    // Double-click detection
    const now = Date.now();
    if (id === lastClickId && now - lastClickTime < DBL_MS) {
      lastClickId = null;
      if (nodeEl.classList.contains("craft-node")) openNodePropertiesModal(id);
      return;
    }
    lastClickId   = id;
    lastClickTime = now;

    // ── CRITICAL ORDER for multi-drag ──
    // 1. Capture offsets for ALL currently selected nodes BEFORE selectNode() runs
    //    (selectNode without shift clears selection first)
    dragOffsets.clear();
    const prevSelected = new Set(store.getState().selectedNodes);

    // If clicking an already-selected node with no shift → keep all selected for drag
    const clickedIsSelected = prevSelected.has(id);
    const idsForDrag = (clickedIsSelected && !e.shiftKey && prevSelected.size > 1)
      ? prevSelected           // keep group selected for drag
      : new Set([id]);         // just this node until selectNode runs

    idsForDrag.forEach(nid => {
      const n = store.getNode(nid);
      if (n) dragOffsets.set(nid, { nx0: n.position.x, ny0: n.position.y });
    });

    // 2. Now update selection state
    store.selectNode(id, e.shiftKey);

    // 3. Re-capture after selectNode in case shift added more
    if (e.shiftKey) {
      dragOffsets.clear();
      store.getState().selectedNodes.forEach(nid => {
        const n = store.getNode(nid);
        if (n) dragOffsets.set(nid, { nx0: n.position.x, ny0: n.position.y });
      });
    }

    dragId    = id;
    dragMoved = false;
    dragMX0   = e.clientX;
    dragMY0   = e.clientY;
    hideNodeTooltip();
    store.snapshotBeforeDrag();
    return;
  }

  // Click on edge label (SVG rect/circle handled directly in renderEdges)
  // No additional handling needed here

  // Click on any non-interactive area → box-select
  // Exclude: nodes, ports, buttons, overlays, tooltips
  const isInteractive = target.closest(
    ".craft-node, .comment-node, .port, button, input, " +
    "#node-context-menu, #node-hover-tooltip, " +
    "#category-filter-bar, #align-toolbar"
  );
  if (e.button === 0 && !isInteractive) {
    if (!e.shiftKey) store.deselectAll();
    const cp  = toCanvas(e.clientX, e.clientY);
    boxing    = true;
    boxCX0    = cp.x; boxCY0 = cp.y;
    selBox.style.display = "block";
    updateSelBoxEl(cp.x, cp.y, cp.x, cp.y);
  }
}

function onWindowMouseMove(e: MouseEvent): void {
  if (panning) {
    ox = e.clientX - panX0;
    oy = e.clientY - panY0;
    applyTransform();
    return;
  }

  if (dragId) {
    const dx = (e.clientX - dragMX0) / zoom;
    const dy = (e.clientY - dragMY0) / zoom;

    // Move ALL nodes that were selected at drag-start
    dragOffsets.forEach((offsets, nid) => {
      const nx = snap(offsets.nx0 + dx);
      const ny = snap(offsets.ny0 + dy);
      moveNodeEl(nid, nx, ny);
      store.moveNode(nid, nx, ny);
    });

    // Re-render edges AND labels so they follow the nodes in real time
    renderEdges();
    dragMoved = true;
    return;
  }

  if (boxing) {
    const cp = toCanvas(e.clientX, e.clientY);
    updateSelBoxEl(boxCX0, boxCY0, cp.x, cp.y);
    return;
  }

  if (draftSrc) {
    updateDraftEdge(e.clientX, e.clientY);
  }
}

function onWindowMouseUp(e: MouseEvent): void {
  if (panning)  { panning = false; root.style.cursor = ""; return; }

  if (dragId) {
    if (dragMoved) store.commitNodeMove(dragId);
    dragId = null; dragMoved = false; dragOffsets.clear();
    return;
  }

  if (boxing) {
    finishBoxSelect(e);
    boxing = false;
    selBox.style.display = "none";
    return;
  }

  if (draftSrc) {
    // Check if released on a port
    const target = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
    if (target?.classList.contains("port")) {
      const tgtId   = target.dataset.node!;
      const tgtPort = target.dataset.port as "in" | "out";
      if (tgtId !== draftSrc) createEdgeFromPorts(draftSrc, draftPort, tgtId, tgtPort);
    }
    cancelDraftEdge();
  }
}

function onKeyDown(e: KeyboardEvent): void {
  const tag = (e.target as HTMLElement).tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;

  const ctrl = e.ctrlKey || e.metaKey;
  const state = store.getState();

  if (e.key === "Delete" || e.key === "Backspace") {
    e.preventDefault();
    if (state.selectedEdge) { store.removeEdge(state.selectedEdge); return; }
    if (state.selectedNodes.size > 0) {
      if (state.selectedNodes.size === 1 || confirm(`${state.selectedNodes.size} Nodes löschen?`)) {
        [...state.selectedNodes].forEach(id => store.removeNode(id));
      }
    }
  }

  if (ctrl && e.key === "d") {
    e.preventDefault();
    duplicateSelected();
  }

  // Ctrl+C — copy selected nodes to clipboard
  if (ctrl && e.key === "c") {
    const ids = [...state.selectedNodes];
    if (ids.length === 0) return;
    const nodes = ids.map(id => store.getNode(id)!).filter(Boolean);
    const wsKey = store.currentWorkspaceKey();
    copyNodesToClipboard(nodes, wsKey);
    showToast(`${nodes.length} Node${nodes.length !== 1 ? "s" : ""} kopiert`, "success");
  }

  // Ctrl+V — paste clipboard nodes at offset position
  if (ctrl && e.key === "v") {
    e.preventDefault();
    const clip = getClipboard();
    if (!clip || clip.nodes.length === 0) return;

    const PASTE_OFFSET = 40;
    const newIds: string[] = [];

    clip.nodes.forEach((srcNode, i) => {
      const id = `node_paste_${Date.now()}_${i}`;
      newIds.push(id);
      const lib = store.getLibrary().find(l => l.classname === srcNode.classname);
      store.addNode({
        ...JSON.parse(JSON.stringify(srcNode)),
        id,
        imageUrl: lib?.imageUrl ?? srcNode.imageUrl,
        // Preserve category but clear attachments (target workbench may differ)
        attachmentsNeed: store.getWorkbenchTools(),
        position: {
          x: srcNode.position.x + PASTE_OFFSET,
          y: srcNode.position.y + PASTE_OFFSET,
        },
      });
    });

    // Select pasted nodes
    store.deselectAll();
    newIds.forEach(id => store.selectNode(id, true));
    showToast(`${newIds.length} Node${newIds.length !== 1 ? "s" : ""} eingefügt`, "success");
  }

  if (e.key === "f" || e.key === "F") { e.preventDefault(); fitAll(); }
  if (e.key === "Escape") {
    store.deselectAll(); cancelDraftEdge();
    if (focusedNodeId) { focusedNodeId = null; updateCategoryFilterUI(); renderAll(); }
  }

  // Arrow nudge
  if (["ArrowLeft","ArrowRight","ArrowUp","ArrowDown"].includes(e.key) && state.selectedNodes.size > 0) {
    e.preventDefault();
    const dx = e.key === "ArrowLeft" ? -GRID : e.key === "ArrowRight" ? GRID : 0;
    const dy = e.key === "ArrowUp"   ? -GRID : e.key === "ArrowDown"  ? GRID : 0;
    [...state.selectedNodes].forEach(id => {
      const n = store.getNode(id); if (!n) return;
      store.moveNode(id, n.position.x + dx, n.position.y + dy);
    });
    store.commitNodeMove([...state.selectedNodes][0]);
    renderEdges();
  }
}

// ── Drop Zone ──────────────────────────────────────────────
function initDropZone(): void {
  root.addEventListener("dragover",  e => { e.preventDefault(); e.dataTransfer!.dropEffect = "copy"; });
  root.addEventListener("drop",      e => {
    e.preventDefault();
    const classname = e.dataTransfer!.getData("application/exodus-classname");
    if (!classname) return;
    const pos = toCanvas(e.clientX, e.clientY);
    const lib = store.getLibrary().find(i => i.classname === classname);
    // displayName: use library displayName only if explicitly set and different from classname
    store.addNode(makeNode(classname, lib?.displayName, lib?.imageUrl, snap(pos.x), snap(pos.y)));
  });

  // Double-click on canvas background → quick-add
  root.addEventListener("dblclick", e => {
    const target = e.target as HTMLElement;
    if (target.closest(".craft-node") || target.closest(".port")) return;
    const pos = toCanvas(e.clientX, e.clientY);
    openQuickAddModal(snap(pos.x), snap(pos.y));
  });
}

function makeNode(classname: string, displayName?: string, imageUrl?: string, x = 100, y = 100): CraftNode {
  return {
    id: `node_${Date.now()}_${Math.random().toString(36).slice(2,6)}`,
    classname,
    displayName: displayName || classname,
    imageUrl,
    position: { x, y },
    craftType: "craft" as const,
    resultCount: 1,
    componentsDontAffectHealth: 0,
    attachmentsNeed: store.getWorkbenchTools(),
    category: store.getJSON().CraftCategories[0]?.CategoryName ?? "Allgemein",
  };
}

// ── Alignment Toolbar ──────────────────────────────────────
function initAlignmentToolbar(): void {
  // Inject alignment bar below zoom controls
  const zc = document.getElementById("zoom-controls")!;
  const bar = document.createElement("div");
  bar.id = "align-toolbar";
  bar.style.cssText = `
    position:absolute;bottom:12px;left:48px;display:flex;gap:4px;z-index:10;
  `;
  bar.innerHTML = `
    <button class="zoom-btn" id="align-left"   title="Links ausrichten (Strg+←)">⇤</button>
    <button class="zoom-btn" id="align-center" title="Horizontal zentrieren">⇔</button>
    <button class="zoom-btn" id="align-right"  title="Rechts ausrichten (Strg+→)">⇥</button>
    <button class="zoom-btn" id="align-top"    title="Oben ausrichten">⇡</button>
    <button class="zoom-btn" id="align-middle" title="Vertikal zentrieren">⇕</button>
    <button class="zoom-btn" id="align-bottom" title="Unten ausrichten">⇣</button>
    <div style="width:1px;background:var(--border);margin:3px 2px;"></div>
    <button class="zoom-btn" id="layout-auto"  title="Auto Layout (Hierarchisch)">⚙</button>
    <button class="zoom-btn" id="layout-fit"   title="Alle einpassen (F)">⊡</button>
  `;
  root.appendChild(bar);

  document.getElementById("align-left")!   .addEventListener("click", () => alignSelected("left"));
  document.getElementById("align-center")! .addEventListener("click", () => alignSelected("hcenter"));
  document.getElementById("align-right")!  .addEventListener("click", () => alignSelected("right"));
  document.getElementById("align-top")!    .addEventListener("click", () => alignSelected("top"));
  document.getElementById("align-middle")! .addEventListener("click", () => alignSelected("vcenter"));
  document.getElementById("align-bottom")! .addEventListener("click", () => alignSelected("bottom"));
  document.getElementById("layout-auto")!  .addEventListener("click", autoLayout);
  document.getElementById("layout-fit")!   .addEventListener("click", fitAll);
}

// ── Category Filter Bar ────────────────────────────────────
function initCategoryFilterBar(): void {
  const bar = document.createElement("div");
  bar.id = "category-filter-bar";
  bar.style.cssText = `
    position:absolute;top:8px;left:50%;transform:translateX(-50%);
    display:flex;align-items:center;gap:6px;z-index:20;
    background:var(--bg-elevated);border:1px solid var(--border);
    border-radius:20px;padding:4px 10px;
    box-shadow:0 2px 8px rgba(0,0,0,0.3);
    max-width:80vw;flex-wrap:wrap;justify-content:center;
  `;
  bar.innerHTML = `
    <span style="font-size:10px;color:var(--text-muted);white-space:nowrap;">Filter:</span>
    <button class="cat-filter-btn active" data-cat="__all__"
      style="padding:2px 10px;border-radius:12px;border:1px solid var(--accent);
      background:var(--accent);color:white;font-size:11px;cursor:pointer;white-space:nowrap;">
      Alle
    </button>
    <div id="cat-filter-chips" style="display:flex;gap:4px;flex-wrap:wrap;"></div>
    <button id="cat-filter-clear" title="Filter zurücksetzen"
      style="padding:2px 8px;border-radius:12px;border:1px solid var(--border);
      background:transparent;color:var(--text-muted);font-size:11px;cursor:pointer;
      display:none;">✕</button>
  `;
  root.appendChild(bar);

  // "Alle" button — also clears chain focus
  bar.querySelector("[data-cat='__all__']")!.addEventListener("click", () => {
    activeCategories.clear();
    focusedNodeId = null;
    updateCategoryFilterUI();
    renderAll();
  });

  bar.querySelector("#cat-filter-clear")!.addEventListener("click", () => {
    activeCategories.clear();
    focusedNodeId = null;
    updateCategoryFilterUI();
    renderAll();
  });

  // Rebuild chips whenever state changes
  bus.on("state:change", () => rebuildCategoryChips());
  rebuildCategoryChips();
}

function rebuildCategoryChips(): void {
  const chipsEl = document.getElementById("cat-filter-chips");
  if (!chipsEl) return;

  // Collect all unique categories from current nodes
  const cats = [...new Set(
    store.getNodes().map(n => n.category?.trim()).filter(Boolean) as string[]
  )].sort();

  chipsEl.innerHTML = "";
  cats.forEach(cat => {
    const btn = document.createElement("button");
    const isActive = activeCategories.has(cat);
    btn.className = "cat-filter-btn";
    btn.dataset.cat = cat;
    btn.style.cssText = `
      padding:2px 10px;border-radius:12px;font-size:11px;cursor:pointer;
      white-space:nowrap;transition:all 0.12s;
      border:1px solid ${isActive ? "var(--accent)" : "var(--border)"};
      background:${isActive ? "var(--accent-dim)" : "transparent"};
      color:${isActive ? "var(--accent)" : "var(--text-secondary)"};
    `;
    btn.textContent = cat;
    btn.addEventListener("click", () => {
      if (activeCategories.has(cat)) {
        activeCategories.delete(cat);
      } else {
        activeCategories.add(cat);
      }
      updateCategoryFilterUI();
      renderAll();
    });
    chipsEl.appendChild(btn);
  });

  updateCategoryFilterUI();
}

function updateCategoryFilterUI(): void {
  const bar = document.getElementById("category-filter-bar");
  if (!bar) return;

  const allBtn   = bar.querySelector("[data-cat='__all__']") as HTMLElement;
  const clearBtn = document.getElementById("cat-filter-clear") as HTMLElement;
  const hasFilter  = activeCategories.size > 0;
  const hasFocus   = focusedNodeId !== null;
  const hasAny     = hasFilter || hasFocus;

  allBtn.style.background  = hasAny ? "transparent"   : "var(--accent)";
  allBtn.style.color       = hasAny ? "var(--text-muted)" : "white";
  allBtn.style.borderColor = hasAny ? "var(--border)"  : "var(--accent)";
  clearBtn.style.display   = hasAny ? ""               : "none";

  // Show focused node indicator
  let focusIndicator = bar.querySelector<HTMLElement>("#focus-indicator");
  if (hasFocus) {
    const focusNode = store.getNode(focusedNodeId!);
    if (!focusIndicator) {
      focusIndicator = document.createElement("span");
      focusIndicator.id = "focus-indicator";
      focusIndicator.style.cssText = `
        font-size:10px;padding:2px 8px;border-radius:10px;
        background:rgba(232,168,64,0.2);color:var(--warning);
        border:1px solid var(--warning);white-space:nowrap;
      `;
      bar.insertBefore(focusIndicator, clearBtn);
    }
    focusIndicator.textContent = `⛶ ${focusNode?.classname ?? "Kette"}`;
  } else {
    focusIndicator?.remove();
  }

  bar.querySelectorAll<HTMLElement>(".cat-filter-btn[data-cat]").forEach(btn => {
    const cat = btn.dataset.cat;
    if (!cat || cat === "__all__") return;
    const isActive = activeCategories.has(cat);
    btn.style.borderColor = isActive ? "var(--accent)" : "var(--border)";
    btn.style.background  = isActive ? "var(--accent-dim)" : "transparent";
    btn.style.color       = isActive ? "var(--accent)" : "var(--text-secondary)";
  });
}

function alignSelected(mode: "left"|"right"|"hcenter"|"top"|"bottom"|"vcenter"): void {
  const ids  = [...store.getState().selectedNodes];
  if (ids.length < 2) return;
  const nodes = ids.map(id => store.getNode(id)!).filter(Boolean);

  store.snapshotBeforeDrag();

  const minX  = Math.min(...nodes.map(n => n.position.x));
  const maxX  = Math.max(...nodes.map(n => n.position.x + NODE_W));
  const minY  = Math.min(...nodes.map(n => n.position.y));
  const maxY  = Math.max(...nodes.map(n => n.position.y + NODE_H));
  const midX  = (minX + maxX) / 2;
  const midY  = (minY + maxY) / 2;

  nodes.forEach(n => {
    let nx = n.position.x, ny = n.position.y;
    if (mode === "left")    nx = minX;
    if (mode === "right")   nx = maxX - NODE_W;
    if (mode === "hcenter") nx = snap(midX - NODE_W / 2);
    if (mode === "top")     ny = minY;
    if (mode === "bottom")  ny = maxY - NODE_H;
    if (mode === "vcenter") ny = snap(midY - NODE_H / 2);
    store.moveNode(n.id, nx, ny);
  });
  store.commitNodeMove(ids[0]);
  renderAll();
}

// ── Auto Layout (Sugiyama-inspired, left→right layers) ────
function autoLayout(): void {
  const nodes  = store.getNodes();
  const edges  = store.getEdges();
  if (nodes.length === 0) return;
  store.snapshotBeforeDrag();

  // Build adjacency
  const inEdges  = new Map<string, string[]>();
  const outEdges = new Map<string, string[]>();
  nodes.forEach(n => { inEdges.set(n.id, []); outEdges.set(n.id, []); });
  edges.forEach(e => {
    outEdges.get(e.sourceNodeId)?.push(e.targetNodeId);
    inEdges.get(e.targetNodeId)?.push(e.sourceNodeId);
  });

  // Assign layers (longest path from root)
  const layer = new Map<string, number>();
  const roots  = nodes.filter(n => (inEdges.get(n.id)?.length ?? 0) === 0);
  if (roots.length === 0) {
    // No root (cycle?) — just grid layout
    nodes.forEach((n, i) => store.moveNode(n.id, snap((i % 6) * 220 + 40), snap(Math.floor(i / 6) * 140 + 40)));
    store.commitNodeMove(nodes[0].id);
    renderAll(); fitAll(); return;
  }

  const assignLayer = (id: string, l: number) => {
    layer.set(id, Math.max(layer.get(id) ?? 0, l));
    (outEdges.get(id) ?? []).forEach(nid => assignLayer(nid, l + 1));
  };
  roots.forEach(r => assignLayer(r.id, 0));

  // Group by layer
  const byLayer = new Map<number, string[]>();
  nodes.forEach(n => {
    const l = layer.get(n.id) ?? 0;
    if (!byLayer.has(l)) byLayer.set(l, []);
    byLayer.get(l)!.push(n.id);
  });

  const PAD_X = 240, PAD_Y = 140, START_X = 60, START_Y = 60;
  byLayer.forEach((ids, l) => {
    ids.forEach((id, i) => {
      store.moveNode(id, snap(START_X + l * PAD_X), snap(START_Y + i * PAD_Y));
    });
  });

  if (nodes.length > 0) store.commitNodeMove(nodes[0].id);
  renderAll();
  setTimeout(fitAll, 50);
}

// ── Fit All ────────────────────────────────────────────────
export function fitAll(): void {
  const nodes = store.getNodes();
  if (nodes.length === 0) return;
  const r   = root.getBoundingClientRect();
  const pad = 60;
  const minX = Math.min(...nodes.map(n => n.position.x)) - pad;
  const maxX = Math.max(...nodes.map(n => n.position.x + NODE_W)) + pad;
  const minY = Math.min(...nodes.map(n => n.position.y)) - pad;
  const maxY = Math.max(...nodes.map(n => n.position.y + NODE_H)) + pad;
  const nz   = Math.min((r.width / (maxX - minX)), (r.height / (maxY - minY)), 2);
  ox = (r.width  - (maxX - minX) * nz) / 2 - minX * nz;
  oy = (r.height - (maxY - minY) * nz) / 2 - minY * nz;
  zoom = nz;
  applyTransform();
}

// ── Visibility calculation ─────────────────────────────────
// Returns which node IDs should be visible given current filters.
// Both filters can be active simultaneously.
function getVisibleNodeIds(): Set<string> | null {
  const nodes = store.getNodes();
  const edges  = store.getEdges();

  // No filter active → show everything
  if (!focusedNodeId && activeCategories.size === 0) return null;

  // ── Chain focus (Ctrl+click) — full bidirectional traversal ──
  const chainFor = (startId: string): Set<string> => {
    const reachable = new Set<string>([startId]);
    const queue = [startId];
    while (queue.length) {
      const cur = queue.shift()!;
      edges.forEach(e => {
        if (e.sourceNodeId === cur && !reachable.has(e.targetNodeId)) {
          reachable.add(e.targetNodeId); queue.push(e.targetNodeId);
        }
        if (e.targetNodeId === cur && !reachable.has(e.sourceNodeId)) {
          reachable.add(e.sourceNodeId); queue.push(e.sourceNodeId);
        }
      });
    }
    return reachable;
  };

  // ── Category filter — show matched nodes + all their upstream ingredients ──
  // Upstream = source nodes of incoming edges (components), recursively
  const ingredientsOf = (startId: string): Set<string> => {
    const reachable = new Set<string>([startId]);
    const queue = [startId];
    while (queue.length) {
      const cur = queue.shift()!;
      // Only follow edges INWARD (components that feed into cur)
      edges.forEach(e => {
        if (e.targetNodeId === cur && !reachable.has(e.sourceNodeId)) {
          reachable.add(e.sourceNodeId); queue.push(e.sourceNodeId);
        }
      });
    }
    return reachable;
  };

  let visibleIds: Set<string> | null = null;

  // Chain focus
  if (focusedNodeId) {
    visibleIds = chainFor(focusedNodeId);
  }

  // Category filter
  if (activeCategories.size > 0) {
    // Find nodes that directly match the active categories
    const catMatched = nodes.filter(n =>
      n.category && activeCategories.has(n.category)
    );

    if (catMatched.length === 0) {
      // No nodes have this category — show nothing (not null, which means "all")
      return visibleIds ?? new Set<string>();
    }

    // For each matched node, include it and all its ingredients (upstream chain)
    const catVisible = new Set<string>();
    catMatched.forEach(n => {
      ingredientsOf(n.id).forEach(id => catVisible.add(id));
    });

    if (visibleIds !== null) {
      // Intersect chain focus with category result
      visibleIds = new Set([...visibleIds].filter(id => catVisible.has(id)));
      if (visibleIds.size === 0) visibleIds = catVisible; // fallback
    } else {
      visibleIds = catVisible;
    }
  }

  return visibleIds;
}

// ── Render Nodes ───────────────────────────────────────────
function renderAll(): void { renderNodes(); renderEdges(); renderMinimap(); }

function renderNodes(): void {
  const state      = store.getState();
  const allNodes   = state.project.nodes;
  const visibleIds = getVisibleNodeIds(); // null = all visible

  // Which nodes should be in the DOM right now
  const shouldRender = new Set(
    allNodes
      .filter(n => visibleIds === null || visibleIds.has(n.id) || n.nodeType === "comment")
      .map(n => n.id)
  );

  // Remove nodes that should no longer be visible (filtered out or deleted)
  [...nodesLayer.children].forEach(el => {
    const id = (el as HTMLElement).dataset.nodeId;
    if (!id) return;
    const nodeExists = allNodes.some(n => n.id === id);
    if (!nodeExists || !shouldRender.has(id)) el.remove();
  });

  // Build lookup of currently rendered nodes
  const domMap = new Map<string, HTMLElement>();
  [...nodesLayer.children].forEach(el => {
    const id = (el as HTMLElement).dataset.nodeId;
    if (id) domMap.set(id, el as HTMLElement);
  });

  // Add/update nodes that should be visible
  allNodes.forEach(node => {
    if (!shouldRender.has(node.id)) return; // filtered out

    const existing = domMap.get(node.id);
    if (existing) {
      updateNodeEl(existing, node, state.selectedNodes.has(node.id));
      // Ensure no leftover hidden styles
      existing.style.visibility    = "";
      existing.style.opacity       = "";
      existing.style.pointerEvents = "";
    } else {
      const el = buildNodeEl(node);
      nodesLayer.appendChild(el);
      updateNodeEl(el, node, state.selectedNodes.has(node.id));
    }
  });
}

function buildNodeEl(node: CraftNode): HTMLElement {
  const el = document.createElement("div");
  el.className  = node.nodeType === "comment" ? "comment-node" : "craft-node";
  el.dataset.nodeId = node.id;

  // Port events (only for recipe nodes)
  if (node.nodeType !== "comment") {
    el.addEventListener("mousedown", e => {
      const port = (e.target as HTMLElement).closest<HTMLElement>(".port");
      if (port) {
        e.stopPropagation();
        draftSrc  = port.dataset.node!;
        draftPort = port.dataset.port as "in" | "out";
        draftPath.style.display = "";
      }
    });
    el.addEventListener("mouseup", e => {
      const port = (e.target as HTMLElement).closest<HTMLElement>(".port");
      if (port && draftSrc && draftSrc !== port.dataset.node) {
        createEdgeFromPorts(draftSrc, draftPort, port.dataset.node!, port.dataset.port as "in"|"out");
        cancelDraftEdge();
        e.stopPropagation();
      }
    });
  }

  // Hover expansion tooltip
  let hoverTimer: ReturnType<typeof setTimeout> | null = null;
  el.addEventListener("mouseenter", () => {
    hoverTimer = setTimeout(() => showNodeTooltip(node.id, el), 400);
  });
  el.addEventListener("mouseleave", () => {
    if (hoverTimer) { clearTimeout(hoverTimer); hoverTimer = null; }
    hideNodeTooltip();
  });

  return el;
}

// ── Node Hover Tooltip ─────────────────────────────────────
let tooltipEl: HTMLElement | null = null;
let tooltipNodeId: NodeId | null = null;

function showNodeTooltip(id: NodeId, anchor: HTMLElement): void {
  const node = store.getNode(id);
  if (!node || node.nodeType === "comment") return;
  if (dragId) return; // don't show during drag

  hideNodeTooltip();
  tooltipNodeId = id;

  const tip = document.createElement("div");
  tip.id = "node-hover-tooltip";
  tip.style.cssText = `
    position:absolute;z-index:500;
    background:var(--bg-elevated);border:1px solid var(--accent);
    border-radius:10px;padding:0;min-width:220px;max-width:320px;
    box-shadow:0 8px 32px rgba(0,0,0,0.6);pointer-events:none;
    animation:fadeIn 0.15s ease;overflow:hidden;
  `;

  const tools = (node.attachmentsNeed ?? []).map(t => {
    const tb = t.replace("Exodus_WB_Tool_", "");
    return `<span style="font-size:10px;padding:1px 6px;border-radius:3px;
      background:var(--bg-hover);color:var(--text-secondary);">${tb}</span>`;
  }).join(" ");

  tip.innerHTML = `
    ${node.imageUrl ? `
      <div style="width:100%;background:var(--bg-base);border-bottom:1px solid var(--border);
        display:flex;align-items:center;justify-content:center;padding:16px;">
        <img src="${node.imageUrl}" style="max-width:200px;max-height:200px;
          object-fit:contain;border-radius:4px;" />
      </div>` : ""}
    <div style="padding:10px 12px;">
      <div style="font-size:13px;font-weight:700;color:var(--text-primary);margin-bottom:2px;">
        ${esc(node.classname)}
      </div>
      ${node.recipeName ? `<div style="font-size:11px;color:var(--text-muted);margin-bottom:6px;">${esc(node.recipeName)}</div>` : ""}
      ${node.category ? `<div style="font-size:11px;margin-bottom:4px;">
        <span style="color:var(--text-muted);">Kategorie:</span>
        <strong style="color:var(--text-primary);margin-left:4px;">${esc(node.category)}</strong>
      </div>` : ""}
      <div style="display:flex;gap:5px;flex-wrap:wrap;margin-bottom:${tools ? "6px" : "0"};">
        <span style="font-size:11px;padding:2px 6px;border-radius:4px;
          background:rgba(61,186,126,0.15);color:var(--success);">
          ${node.craftType ?? "craft"}
        </span>
        <span style="font-size:11px;padding:2px 6px;border-radius:4px;
          background:var(--accent-dim);color:var(--accent);">
          ×${node.resultCount ?? 1}
        </span>
      </div>
      ${tools ? `<div style="display:flex;gap:3px;flex-wrap:wrap;">${tools}</div>` : ""}
    </div>
  `;

  // Position: right of node in screen space
  const anchorRect = anchor.getBoundingClientRect();
  const rootRect   = root.getBoundingClientRect();
  const tipLeft    = anchorRect.right - rootRect.left + 10;
  const tipTop     = anchorRect.top   - rootRect.top;

  tip.style.left = `${tipLeft}px`;
  tip.style.top  = `${tipTop}px`;

  // Flip left if too close to right edge
  root.appendChild(tip);
  const tipRect = tip.getBoundingClientRect();
  if (tipRect.right > window.innerWidth - 10) {
    tip.style.left = `${anchorRect.left - rootRect.left - tipRect.width - 10}px`;
  }

  tooltipEl = tip;
}

function hideNodeTooltip(): void {
  tooltipEl?.remove();
  tooltipEl = null;
  tooltipNodeId = null;
}

function updateNodeEl(el: HTMLElement, node: CraftNode, selected: boolean): void {
  el.style.left = `${node.position.x}px`;
  el.style.top  = `${node.position.y}px`;

  // ── Comment Node ──────────────────────────────────────────
  if (node.nodeType === "comment") {
    el.className = "comment-node" + (selected ? " selected" : "");
    el.style.background = node.commentColor ?? "rgba(255,200,50,0.12)";
    el.innerHTML = `
      <div class="comment-drag-handle" title="Ziehen zum Verschieben">✎ Kommentar</div>
      <div class="comment-text" contenteditable="false"
        data-node-id="${node.id}">${esc(node.commentText ?? "Kommentar…")}</div>
      <div style="display:flex;gap:3px;padding:3px 6px;flex-wrap:wrap;">
        ${["rgba(255,200,50,0.18)","rgba(100,200,255,0.18)","rgba(150,255,150,0.18)","rgba(255,120,120,0.18)","rgba(200,150,255,0.18)"]
          .map(c => `<button class="comment-color-btn" data-color="${c}"
            style="width:14px;height:14px;border-radius:50%;background:${c};
            border:1px solid rgba(255,255,255,0.3);cursor:pointer;padding:0;"
            title="Farbe ändern"></button>`).join("")}
        <button class="comment-edit-btn" title="Text bearbeiten (oder Doppelklick)" style="margin-left:auto;background:transparent;border:none;color:rgba(255,200,50,0.6);cursor:pointer;font-size:11px;padding:1px 4px;">✎</button>
      </div>
    `;

    const textEl = el.querySelector<HTMLElement>(".comment-text")!;

    const startEdit = () => {
      textEl.contentEditable = "true";
      textEl.focus();
      // Select all text
      const range = document.createRange();
      range.selectNodeContents(textEl);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
    };

    const commitEdit = () => {
      textEl.contentEditable = "false";
      const newText = textEl.textContent?.trim() ?? "";
      if (newText !== node.commentText) {
        store.updateNode(node.id, { commentText: newText || "Kommentar…" });
      }
    };

    // Double-click on node or single click on edit button → start edit
    el.querySelector(".comment-edit-btn")!.addEventListener("click", ev => {
      ev.stopPropagation();
      startEdit();
    });

    // Blur = commit
    textEl.addEventListener("blur", () => commitEdit());

    // Enter = commit (not newline), Escape = cancel
    textEl.addEventListener("keydown", e => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
        textEl.blur(); // triggers commitEdit via blur
      }
      if (e.key === "Escape") {
        e.stopPropagation();
        textEl.textContent = node.commentText ?? "Kommentar…";
        textEl.contentEditable = "false";
      }
    });

    // Prevent text clicks from starting canvas drag
    textEl.addEventListener("mousedown", e => {
      if (textEl.contentEditable === "true") e.stopPropagation();
    });

    // Color buttons
    el.querySelectorAll<HTMLElement>(".comment-color-btn").forEach(btn => {
      btn.addEventListener("click", ev => {
        ev.stopPropagation();
        store.updateNode(node.id, { commentColor: btn.dataset.color });
      });
    });

    // The drag-handle IS the drag target — it propagates up to onCanvasMouseDown
    // which handles .comment-node the same as .craft-node
    return;
  }

  // ── Recipe Node ───────────────────────────────────────────
  el.className = "craft-node" + (selected ? " selected" : "");

  const thumb = node.imageUrl
    ? `<img class="node-thumb" src="${node.imageUrl}" alt="${esc(node.classname)}" />`
    : `<div class="node-thumb-placeholder">📦</div>`;

  const badges = [
    `<span class="node-badge craft-type-${node.craftType ?? "craft"}">${node.craftType ?? "craft"}</span>`,
    node.resultCount && node.resultCount > 1 ? `<span class="node-badge">×${node.resultCount}</span>` : "",
  ].filter(Boolean).join(" ");

  el.innerHTML = `
    <div class="node-header">
      ${thumb}
      <div class="node-title-area">
        <div class="node-classname">${esc(node.classname)}</div>
        ${node.recipeName ? `<div class="node-display-name" style="font-size:10px;color:var(--text-muted);">${esc(node.recipeName)}</div>` : ""}
      </div>
      <button class="node-action-btn" data-action="props" data-id="${node.id}" title="Eigenschaften">⚙</button>
    </div>
    <div class="node-body">
      <div class="node-meta-row">${badges}</div>
      ${node.category ? `<div class="node-meta-row"><span class="node-meta-label">Kat.</span><span class="node-meta-val">${esc(node.category)}</span></div>` : ""}
    </div>
    <div class="port port-in"  data-node="${node.id}" data-port="in"  title="Eingang"></div>
    <div class="port port-out" data-node="${node.id}" data-port="out" title="Ausgang"></div>
  `;

  el.querySelector("[data-action='props']")!.addEventListener("click", e => {
    e.stopPropagation();
    openNodePropertiesModal(node.id);
  });
}

function moveNodeEl(id: NodeId, x: number, y: number): void {
  const el = nodesLayer.querySelector<HTMLElement>(`[data-node-id="${id}"]`);
  if (el) { el.style.left = `${x}px`; el.style.top = `${y}px`; }
}

// ── Render Edges ───────────────────────────────────────────
function renderEdges(): void {
  const edges = store.getEdges();
  const state = store.getState();

  // Clear all edge SVG content (labels are now part of edgesGroup)
  edgesGroup.innerHTML = "";

  const visibleIds = getVisibleNodeIds(); // null = all visible

  edges.forEach(edge => {
    const src = store.getNode(edge.sourceNodeId);
    const tgt = store.getNode(edge.targetNodeId);
    if (!src || !tgt) return;

    // Apply visibility filter — hide edge if either node is hidden
    if (visibleIds !== null) {
      if (!visibleIds.has(edge.sourceNodeId) || !visibleIds.has(edge.targetNodeId)) return;
    }

    const sx = src.position.x + NODE_W;
    const sy = src.position.y + NODE_H / 2;
    const tx = tgt.position.x;
    const ty = tgt.position.y + NODE_H / 2;

    const isSelected = state.selectedEdge === edge.id;
    const d = cubicBezier(sx, sy, tx, ty);

    // Invisible hit area
    const hitPath = document.createElementNS("http://www.w3.org/2000/svg", "path");
    hitPath.setAttribute("d", d);
    hitPath.setAttribute("fill",           "rgba(0,0,0,0.001)");
    hitPath.setAttribute("stroke",         "rgba(0,0,0,0.001)");
    hitPath.setAttribute("stroke-width",   "14");
    hitPath.style.pointerEvents = "painted";
    hitPath.setAttribute("data-edge-id",   edge.id);
    hitPath.style.cursor = "pointer";
    hitPath.addEventListener("click", (ev) => {
      ev.stopPropagation();
      store.selectEdge(edge.id);
    });

    // Visible path
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", d);
    path.setAttribute("class", `craft-edge ${isSelected ? "selected" : ""}`);
    path.setAttribute("marker-end", "url(#arrow)");

    edgesGroup.appendChild(hitPath);
    edgesGroup.appendChild(path);

    // ── SVG Label — position at 50% of bezier, always ABOVE the edge ──
    // Use fixed t=0.5 midpoint, offset perpendicular upward
    const t = 0.5;
    const dx2 = Math.max(Math.abs(tx - sx) * 0.5, 60);
    const bx1 = sx + dx2, by1 = sy, bx2 = tx - dx2, by2 = ty;
    // Bezier midpoint
    const lx = Math.pow(1-t,3)*sx + 3*Math.pow(1-t,2)*t*bx1 + 3*(1-t)*t*t*bx2 + Math.pow(t,3)*tx;
    const ly = Math.pow(1-t,3)*sy + 3*Math.pow(1-t,2)*t*by1 + 3*(1-t)*t*t*by2 + Math.pow(t,3)*ty;
    // Tangent at t=0.5
    const tdx = -3*Math.pow(1-t,2)*sx + 3*(Math.pow(1-t,2) - 2*(1-t)*t)*bx1
              + 3*(2*(1-t)*t - t*t)*bx2 + 3*t*t*tx;
    const tdy = -3*Math.pow(1-t,2)*sy + 3*(Math.pow(1-t,2) - 2*(1-t)*t)*by1
              + 3*(2*(1-t)*t - t*t)*by2 + 3*t*t*ty;
    const tlen = Math.sqrt(tdx*tdx + tdy*tdy) || 1;
    // Normal pointing "up" in screen space (negative y = up)
    // We want the label above the curve, so we pick the normal that has negative y component
    let nx2 = -tdy / tlen, ny2 = tdx / tlen;
    if (ny2 > 0) { nx2 = -nx2; ny2 = -ny2; } // flip if pointing down
    const LABEL_OFFSET = 18;
    const labelX = lx + nx2 * LABEL_OFFSET;
    const labelY = ly + ny2 * LABEL_OFFSET;

    // Background rect
    const labelBg = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    const labelW = edge.amount >= 10 ? 28 : 22;
    labelBg.setAttribute("x",             String(labelX - labelW/2));
    labelBg.setAttribute("y",             String(labelY - 10));
    labelBg.setAttribute("width",         String(labelW));
    labelBg.setAttribute("height",        "20");
    labelBg.setAttribute("rx",            "10");
    labelBg.setAttribute("fill",          "var(--bg-elevated)");
    labelBg.setAttribute("stroke",        isSelected ? "var(--danger)" : "var(--border)");
    labelBg.setAttribute("stroke-width",  isSelected ? "2" : "1");
    labelBg.style.pointerEvents = "painted";
    labelBg.setAttribute("data-edge-id",  edge.id);
    labelBg.style.cursor = "pointer";

    // Amount text
    const labelText = document.createElementNS("http://www.w3.org/2000/svg", "text");
    labelText.setAttribute("x",            String(labelX));
    labelText.setAttribute("y",            String(labelY + 4));
    labelText.setAttribute("text-anchor",  "middle");
    labelText.setAttribute("font-size",    "10");
    labelText.setAttribute("font-weight",  "bold");
    labelText.setAttribute("font-family",  "inherit");
    labelText.style.fill         = "var(--text-primary)";
    labelText.style.pointerEvents = "none";
    labelText.textContent = `×${edge.amount}`;

    edgesGroup.appendChild(labelBg);
    edgesGroup.appendChild(labelText);

    // ── Changehealth label (below badge, only when non-zero) ──
    if (edge.changehealth !== 0) {
      const chSign  = edge.changehealth > 0 ? "+" : "";
      const chColor = edge.changehealth > 0 ? "var(--success)" : "var(--danger)";
      const chLabel = document.createElementNS("http://www.w3.org/2000/svg", "text");
      chLabel.setAttribute("x",           String(labelX));
      chLabel.setAttribute("y",           String(labelY + 22));
      chLabel.setAttribute("text-anchor", "middle");
      chLabel.setAttribute("font-size",   "9");
      chLabel.setAttribute("font-weight", "600");
      chLabel.style.fill          = chColor;
      chLabel.style.pointerEvents = "none";
      chLabel.textContent = `hp${chSign}${edge.changehealth}`;
      edgesGroup.appendChild(chLabel);
    }

    // Delete button when selected (SVG × button)
    if (isSelected) {
      const delCircle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      delCircle.setAttribute("cx",            String(labelX + labelW/2 + 8));
      delCircle.setAttribute("cy",            String(labelY));
      delCircle.setAttribute("r",             "8");
      delCircle.setAttribute("fill",          "var(--danger)");
      delCircle.style.pointerEvents = "painted";
      delCircle.setAttribute("data-edge-del", edge.id);
      delCircle.style.cursor = "pointer";

      const delX = document.createElementNS("http://www.w3.org/2000/svg", "text");
      delX.setAttribute("x",           String(labelX + labelW/2 + 8));
      delX.setAttribute("y",           String(labelY + 4));
      delX.setAttribute("text-anchor", "middle");
      delX.setAttribute("font-size",   "10");
      delX.style.fill          = "white";
      delX.style.pointerEvents = "none";
      delX.textContent = "×";

      edgesGroup.appendChild(delCircle);
      edgesGroup.appendChild(delX);
    }
  });
}

// ── Edge Amount Modal ──────────────────────────────────────
function openEdgeAmountModal(eid: EdgeId): void {
  const edge = store.getEdge(eid);
  if (!edge) return;

  const overlay = document.createElement("div");
  overlay.style.cssText = `
    position:fixed;inset:0;z-index:9999;display:flex;
    align-items:center;justify-content:center;
    background:rgba(0,0,0,0.4);
  `;
  overlay.innerHTML = `
    <div style="background:var(--bg-elevated);border:1px solid var(--accent);
      border-radius:8px;padding:16px;display:flex;flex-direction:column;
      gap:10px;min-width:200px;box-shadow:0 8px 24px rgba(0,0,0,0.5);">
      <label style="font-size:12px;font-weight:600;color:var(--text-primary);">
        Menge (Amount)
      </label>
      <input id="edge-amount-input" type="number" min="1" value="${edge.amount}"
        style="padding:6px 10px;border-radius:5px;border:1px solid var(--accent);
        background:var(--bg-base);color:var(--text-primary);font-size:14px;
        text-align:center;outline:none;width:100%;" />
      <div style="display:flex;gap:8px;">
        <button id="edge-cancel" style="flex:1;padding:6px;border-radius:5px;
          border:1px solid var(--border);background:transparent;
          color:var(--text-secondary);cursor:pointer;">Abbrechen</button>
        <button id="edge-ok" style="flex:1;padding:6px;border-radius:5px;
          border:none;background:var(--accent);color:white;
          cursor:pointer;font-weight:600;">OK</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const input = overlay.querySelector("#edge-amount-input") as HTMLInputElement;
  input.focus(); input.select();

  const commit = () => {
    const val = Math.max(1, parseInt(input.value, 10) || 1);
    store.updateEdge(eid, { amount: val });
    overlay.remove();
  };

  overlay.querySelector("#edge-ok")!.addEventListener("click", commit);
  overlay.querySelector("#edge-cancel")!.addEventListener("click", () => overlay.remove());
  input.addEventListener("keydown", e => {
    if (e.key === "Enter")  { e.preventDefault(); commit(); }
    if (e.key === "Escape") { overlay.remove(); }
    e.stopPropagation();
  });
  overlay.addEventListener("click", e => { if (e.target === overlay) overlay.remove(); });
}

function cubicBezier(x1: number, y1: number, x2: number, y2: number): string {
  const dx = Math.max(Math.abs(x2 - x1) * 0.5, 60);
  return `M${x1},${y1} C${x1+dx},${y1} ${x2-dx},${y2} ${x2},${y2}`;
}

// ── Edge Label Inline Edit ─────────────────────────────────
function startEdgeLabelEdit(eid: EdgeId, badge: HTMLElement): void {
  if (editingEdgeId === eid) return; // already editing this one
  editingEdgeId = eid;

  const edge = store.getEdge(eid);
  if (!edge) return;

  // Replace badge content with an input
  const input = document.createElement("input");
  input.type  = "number";
  input.min   = "1";
  input.value = String(edge.amount);
  input.style.cssText = `
    width:32px;height:16px;border-radius:8px;text-align:center;
    border:1px solid var(--accent);background:var(--bg-base);
    color:var(--text-primary);font-size:11px;font-weight:600;
    outline:none;padding:0;pointer-events:all;
  `;
  badge.style.pointerEvents = "all";
  badge.textContent = "";
  badge.appendChild(input);
  input.focus(); input.select();

  const commit = () => {
    const val = Math.max(1, parseInt(input.value, 10) || 1);
    store.updateEdge(eid, { amount: val });
    editingEdgeId = null;
    // renderEdges will be triggered by edge:update event
  };

  input.addEventListener("blur",    commit);
  input.addEventListener("keydown", e => {
    if (e.key === "Enter")  { e.preventDefault(); input.blur(); }
    if (e.key === "Escape") { editingEdgeId = null; renderEdges(); }
    e.stopPropagation();
  });
}

// ── Draft Edge ─────────────────────────────────────────────
function updateDraftEdge(mx: number, my: number): void {
  if (!draftSrc) return;
  const src = store.getNode(draftSrc);
  if (!src) return;

  const sx = draftPort === "out" ? src.position.x + NODE_W : src.position.x;
  const sy = src.position.y + NODE_H / 2;
  const cp = toCanvas(mx, my);
  const d  = cubicBezier(sx, sy, cp.x, cp.y);
  draftPath.setAttribute("d", d);
  draftPath.setAttribute("transform", `translate(${ox},${oy}) scale(${zoom})`);
}

function cancelDraftEdge(): void {
  draftSrc = null; draftPort = null;
  draftPath.style.display = "none";
  draftPath.setAttribute("d", "");
}

function createEdgeFromPorts(
  srcId: NodeId, srcPort: "in"|"out"|null,
  tgtId: NodeId, tgtPort: "in"|"out"
): void {
  // Always wire: out→in (source produces → target consumes)
  let source = srcId, target = tgtId;
  if (srcPort === "in") { [source, target] = [target, source]; }

  store.addEdge({
    id: `edge_${Date.now()}_${Math.random().toString(36).slice(2,5)}`,
    sourceNodeId: source,
    targetNodeId: target,
    amount: 1,
    destroy: true,
    changehealth: 0,
  });
}

// ── Box Select ─────────────────────────────────────────────
function updateSelBoxEl(cx0: number, cy0: number, cx1: number, cy1: number): void {
  // Convert canvas coords back to screen for the overlay element
  const r   = root.getBoundingClientRect();
  const sx0 = cx0 * zoom + ox + r.left;
  const sy0 = cy0 * zoom + oy + r.top;
  const sx1 = cx1 * zoom + ox + r.left;
  const sy1 = cy1 * zoom + oy + r.top;
  const l   = Math.min(sx0, sx1) - r.left;
  const t   = Math.min(sy0, sy1) - r.top;
  const w   = Math.abs(sx1 - sx0);
  const h   = Math.abs(sy1 - sy0);
  selBox.style.left = `${l}px`; selBox.style.top  = `${t}px`;
  selBox.style.width = `${w}px`; selBox.style.height = `${h}px`;
}

function finishBoxSelect(e: MouseEvent): void {
  const cp = toCanvas(e.clientX, e.clientY);
  const minX = Math.min(boxCX0, cp.x), maxX = Math.max(boxCX0, cp.x);
  const minY = Math.min(boxCY0, cp.y), maxY = Math.max(boxCY0, cp.y);

  store.getNodes().forEach(n => {
    if (n.position.x + NODE_W >= minX && n.position.x <= maxX &&
        n.position.y + NODE_H >= minY && n.position.y <= maxY) {
      store.selectNode(n.id, true);
    }
  });
}

// ── Duplicate ──────────────────────────────────────────────
function duplicateSelected(): void {
  const ids = [...store.getState().selectedNodes];
  if (ids.length === 0) return;
  ids.forEach(id => {
    const n = store.getNode(id); if (!n) return;
    store.addNode({
      ...JSON.parse(JSON.stringify(n)),
      id: `node_${Date.now()}_${Math.random().toString(36).slice(2,5)}`,
      position: { x: n.position.x + GRID * 2, y: n.position.y + GRID * 2 },
    });
  });
}

// ── Node Properties Modal ──────────────────────────────────
function openNodePropertiesModal(id: NodeId): void {
  store.selectNode(id);
  const node = store.getNode(id);
  if (!node) return;

  const wbDef = WORKBENCH_DEFS.find((d) => d.type === store.getState().activeWorkbench);
  const tools = wbDef?.tools ?? [];

  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `
    <div class="modal" style="width:560px;">
      <div class="modal-header">
        <span>Node: ${esc(node.displayName || node.classname)}</span>
        <button class="btn btn-ghost btn-icon" id="npm-close">✕</button>
      </div>
      <div class="modal-body" style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
        <div>
          <label class="field-label">Classname <span style="color:var(--text-muted);font-weight:400;text-transform:none;">(Anzeige in Werkbank)</span></label>
          <input class="field-input" id="npm-classname" value="${esc(node.classname)}" />
        </div>
        <div>
          <label class="field-label">Rezeptname</label>
          <input class="field-input" id="npm-recipename" value="${esc(node.recipeName ?? "")}" placeholder="Name des Crafting-Eintrags" />
        </div>
        <div>
          <label class="field-label">Craft Type</label>
          <select class="field-input" id="npm-crafttype">
            <option value="craft"       ${node.craftType==="craft"       ?"selected":""}>craft</option>
            <option value="disassemble" ${node.craftType==="disassemble" ?"selected":""}>disassemble</option>
            <option value="repair"      ${node.craftType==="repair"      ?"selected":""}>repair</option>
          </select>
        </div>
        <div>
          <label class="field-label">Result Count</label>
          <input class="field-input" id="npm-resultcount" type="number" min="1" value="${node.resultCount ?? 1}" />
        </div>
        <div>
          <label class="field-label">Kategorie</label>
          <input class="field-input" id="npm-category" value="${esc(node.category ?? "")}"
            list="npm-cat-list" />
          <datalist id="npm-cat-list">
            ${store.getJSON().CraftCategories.map(c => `<option value="${esc(c.CategoryName)}">`).join("")}
          </datalist>
        </div>
        <div style="grid-column:1/-1;">
          <label class="field-label">Affect Health</label>
          <select class="field-input" id="npm-health" style="width:auto;">
            <option value="0" ${(node.componentsDontAffectHealth??0)===0?"selected":""}>Ja (0)</option>
            <option value="1" ${(node.componentsDontAffectHealth??0)===1?"selected":""}>Nein (1)</option>
          </select>
        </div>
        <div style="grid-column:1/-1;">
          <label class="field-label">Benötigte Werkzeuge</label>
          <div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:4px;">
            ${tools.map((t) => `
              <label style="display:flex;align-items:center;gap:4px;font-size:12px;cursor:pointer;">
                <input type="checkbox" class="npm-attach" value="${t.classname}"
                  ${(node.attachmentsNeed ?? []).includes(t.classname) ? "checked" : ""} />
                ${t.label}
              </label>
            `).join("")}
            ${tools.length===0 ? `<span style="font-size:11px;color:var(--text-muted)">Keine Tools für diese Werkbank</span>` : ""}
          </div>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-danger btn-sm" id="npm-delete">Node löschen</button>
        <button class="btn btn-secondary" id="npm-cancel">Abbrechen</button>
        <button class="btn btn-primary"   id="npm-save">Übernehmen</button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  overlay.querySelector("#npm-close")! .addEventListener("click", close);
  overlay.querySelector("#npm-cancel")!.addEventListener("click", close);
  overlay.addEventListener("click", e => { if (e.target === overlay) close(); });

  overlay.querySelector("#npm-delete")!.addEventListener("click", () => {
    if (confirm(`Node "${node.displayName || node.classname}" löschen?`)) {
      store.removeNode(id); close();
    }
  });

  overlay.querySelector("#npm-save")!.addEventListener("click", () => {
    const attachments = [...overlay.querySelectorAll<HTMLInputElement>(".npm-attach")]
      .filter(cb => cb.checked).map(cb => cb.value);
    const newClassname = (overlay.querySelector("#npm-classname") as HTMLInputElement).value.trim();
    store.updateNode(id, {
      classname:                  newClassname,
      displayName:                newClassname, // displayName always = classname
      recipeName:                 (overlay.querySelector("#npm-recipename")  as HTMLInputElement).value.trim(),
      craftType:                  (overlay.querySelector("#npm-crafttype")   as HTMLSelectElement).value as CraftNode["craftType"],
      resultCount:                Number((overlay.querySelector("#npm-resultcount") as HTMLInputElement).value),
      componentsDontAffectHealth: Number((overlay.querySelector("#npm-health")       as HTMLSelectElement).value),
      category:                   (overlay.querySelector("#npm-category")    as HTMLInputElement).value.trim(),
      attachmentsNeed: attachments,
    });
    close();
  });
}

// ── Comment Node ───────────────────────────────────────────
function addCommentNode(x: number, y: number): void {
  const node: CraftNode = {
    id: `node_comment_${Date.now()}`,
    classname: "__comment__",
    displayName: "",
    position: { x, y },
    nodeType: "comment",
    commentText: "Kommentar…",
    commentColor: "rgba(255,200,50,0.12)",
  };
  store.addNode(node);

  // Auto-focus the text after render
  requestAnimationFrame(() => {
    const el = document.querySelector<HTMLElement>(`[data-node-id="${node.id}"] .comment-text`);
    if (el) {
      el.contentEditable = "true";
      el.focus();
      window.getSelection()?.selectAllChildren(el);
    }
  });
}

// ── Quick-Add Modal ────────────────────────────────────────
function openQuickAddModal(x: number, y: number): void {
  const lib = store.getLibrary();

  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `
    <div class="modal" style="width:380px;">
      <div class="modal-header">
        <span>Node hinzufügen</span>
        <button class="btn btn-ghost btn-icon" id="qam-close">✕</button>
      </div>
      <div class="modal-body" style="display:flex;flex-direction:column;gap:10px;">
        <div>
          <label class="field-label">Classname <span style="color:var(--text-muted);font-weight:400;text-transform:none;">(= Anzeige in Werkbank)</span></label>
          <input class="field-input" id="qam-classname" placeholder="z.B. Exodus_Jacket_Blue" list="qam-lib-list" autofocus />
          <datalist id="qam-lib-list">
            ${lib.map(i => `<option value="${esc(i.classname)}">`).join("")}
          </datalist>
        </div>
        <div>
          <label class="field-label">Rezeptname <span style="color:var(--text-muted);font-weight:400;text-transform:none;">(optional)</span></label>
          <input class="field-input" id="qam-recipename" placeholder="z.B. Blaue Jacke herstellen" />
        </div>
        <div>
          <label class="field-label">Kategorie</label>
          <input class="field-input" id="qam-category"
            value="${store.getJSON().CraftCategories[0]?.CategoryName ?? ""}"
            list="qam-cat-list" placeholder="z.B. Tops" />
          <datalist id="qam-cat-list">
            ${store.getJSON().CraftCategories.map(c => `<option value="${esc(c.CategoryName)}">`).join("")}
          </datalist>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary" id="qam-cancel">Abbrechen</button>
        <button class="btn btn-primary"   id="qam-add">Hinzufügen</button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);
  const close = () => overlay.remove();

  const cnInput       = overlay.querySelector("#qam-classname")  as HTMLInputElement;
  const recipeInput   = overlay.querySelector("#qam-recipename") as HTMLInputElement;
  const categoryInput = overlay.querySelector("#qam-category")   as HTMLInputElement;

  overlay.querySelector("#qam-close")! .addEventListener("click", close);
  overlay.querySelector("#qam-cancel")!.addEventListener("click", close);
  overlay.addEventListener("click", e => { if (e.target === overlay) close(); });

  const doAdd = () => {
    const classname = cnInput.value.trim();
    if (!classname) return;
    const item = lib.find(i => i.classname === classname);
    const node = makeNode(classname, undefined, item?.imageUrl, x, y);
    if (recipeInput.value.trim())   node.recipeName = recipeInput.value.trim();
    if (categoryInput.value.trim()) node.category   = categoryInput.value.trim();
    store.addNode(node);
    close();
  };

  overlay.querySelector("#qam-add")!.addEventListener("click", doAdd);
  cnInput.addEventListener("keydown", e => { if (e.key === "Enter") doAdd(); });
}

// ── Context Menu ───────────────────────────────────────────
function initContextMenu(): void {
  root.addEventListener("contextmenu", e => {
    e.preventDefault();
    // On Mac, Ctrl+click fires contextmenu — we use that for chain isolation, not the menu
    if (e.ctrlKey) return;
    const nodeEl = (e.target as HTMLElement).closest<HTMLElement>(".craft-node");
    showContextMenu(e.clientX, e.clientY, nodeEl?.dataset.nodeId ?? null);
  });

  document.addEventListener("click", () => {
    document.getElementById("node-context-menu")?.remove();
  });
}

function showContextMenu(mx: number, my: number, nodeId: NodeId | null): void {
  document.getElementById("node-context-menu")?.remove();

  const menu = document.createElement("div");
  menu.id = "node-context-menu";
  menu.style.cssText = `
    position:fixed;left:${mx}px;top:${my}px;z-index:9000;
    background:var(--bg-elevated);border:1px solid var(--border);
    border-radius:6px;padding:4px;min-width:180px;
    box-shadow:0 8px 24px rgba(0,0,0,0.4);
  `;

  const item = (label: string, icon: string, fn: () => void, danger = false) => {
    const el = document.createElement("div");
    el.style.cssText = `
      display:flex;align-items:center;gap:8px;padding:6px 10px;
      border-radius:4px;cursor:pointer;font-size:12px;
      color:${danger ? "var(--danger)" : "var(--text-primary)"};
    `;
    el.innerHTML = `<span>${icon}</span><span>${label}</span>`;
    el.addEventListener("mouseenter", () => el.style.background = "var(--bg-hover)");
    el.addEventListener("mouseleave", () => el.style.background = "");
    el.addEventListener("click", () => { fn(); menu.remove(); });
    return el;
  };

  const sep = () => {
    const el = document.createElement("div");
    el.style.cssText = "height:1px;background:var(--border);margin:3px 0;";
    return el;
  };

  if (nodeId) {
    menu.appendChild(item("Eigenschaften",  "⚙", () => openNodePropertiesModal(nodeId)));
    menu.appendChild(item("Duplizieren",    "⎘", () => {
      const n = store.getNode(nodeId); if (!n) return;
      store.addNode({ ...JSON.parse(JSON.stringify(n)),
        id: `node_${Date.now()}`, position: { x: n.position.x + 40, y: n.position.y + 40 } });
    }));
    menu.appendChild(sep());
    menu.appendChild(item("Node löschen",   "🗑", () => store.removeNode(nodeId), true));
  } else {
    const pos = toCanvas(mx, my);
    menu.appendChild(item("Node hinzufügen", "+", () => openQuickAddModal(snap(pos.x), snap(pos.y))));
    menu.appendChild(item("💬 Kommentar hinzufügen", "💬", () => addCommentNode(snap(pos.x), snap(pos.y))));
    menu.appendChild(item("Auto Layout",     "⚙", autoLayout));
    menu.appendChild(item("Alles einpassen", "⊡", fitAll));
    menu.appendChild(sep());
    menu.appendChild(item("Alles auswählen", "▣", () => {
      store.getNodes().forEach(n => store.selectNode(n.id, true));
    }));
    if (store.getState().selectedNodes.size > 0) {
      menu.appendChild(sep());
      menu.appendChild(item(`${store.getState().selectedNodes.size} Nodes löschen`, "🗑",
        () => { [...store.getState().selectedNodes].forEach(id => store.removeNode(id)); }, true));
    }
  }

  document.body.appendChild(menu);

  // Auto-flip if out of viewport
  const r = menu.getBoundingClientRect();
  if (r.right  > window.innerWidth)  menu.style.left = `${mx - r.width}px`;
  if (r.bottom > window.innerHeight) menu.style.top  = `${my - r.height}px`;
}

// ── Teammate Cursors ───────────────────────────────────────
// Rendered inside node-editor-root, using live canvas transform
let cursorOverlay: HTMLElement | null = null;

export function renderTeammateCursors(
  users: Map<string, { uid: string; displayName: string; color: string;
    workspaceKey: string; cursorX: number; cursorY: number }>,
  currentUid: string,
  currentWsKey: string,
): void {
  if (!cursorOverlay) {
    cursorOverlay = document.createElement("div");
    cursorOverlay.id = "cursor-overlay";
    cursorOverlay.style.cssText =
      "position:absolute;inset:0;pointer-events:none;z-index:200;overflow:visible;";
    root?.appendChild(cursorOverlay);
  }

  // Clear old cursors
  cursorOverlay.innerHTML = "";

  users.forEach(u => {
    if (u.uid === currentUid) return;
    if (u.workspaceKey !== currentWsKey) return;
    if (!u.cursorX && !u.cursorY) return;

    // Canvas → screen coords using live ox/oy/zoom
    const sx = u.cursorX * zoom + ox;
    const sy = u.cursorY * zoom + oy;

    const el = document.createElement("div");
    el.style.cssText = `
      position:absolute;left:${sx}px;top:${sy}px;
      pointer-events:none;user-select:none;
      transition:left 0.15s ease,top 0.15s ease;
      transform-origin:0 0;
    `;
    const firstName = (u.displayName || "?").split(" ")[0];
    el.innerHTML = `
      <svg width="16" height="20" viewBox="0 0 16 20" style="display:block;">
        <path d="M0 0 L0 14 L4 10 L6 17 L8 16 L6 9 L10 9 Z"
          fill="${u.color}" stroke="white" stroke-width="1.2"/>
      </svg>
      <div style="position:absolute;left:13px;top:10px;
        background:${u.color};color:white;font-size:10px;font-weight:600;
        padding:1px 5px;border-radius:3px;white-space:nowrap;
        box-shadow:0 1px 3px rgba(0,0,0,0.4);">
        ${esc(firstName)}
      </div>`;
    cursorOverlay?.appendChild(el);
  });
}
function renderMinimap(): void {
  const mc = document.getElementById("minimap") as HTMLCanvasElement;
  if (!mc) return;
  mc.width = 160; mc.height = 100;
  const ctx = mc.getContext("2d");
  if (!ctx) return;

  const nodes = store.getNodes();
  const edges = store.getEdges();
  ctx.clearRect(0, 0, 160, 100);

  if (nodes.length === 0) return;

  const pad  = 10;
  const minX = Math.min(...nodes.map(n => n.position.x));
  const maxX = Math.max(...nodes.map(n => n.position.x + NODE_W));
  const minY = Math.min(...nodes.map(n => n.position.y));
  const maxY = Math.max(...nodes.map(n => n.position.y + NODE_H));
  const rngX = maxX - minX || 1, rngY = maxY - minY || 1;
  const sc   = Math.min((160 - pad*2) / rngX, (100 - pad*2) / rngY);
  const toMX = (x: number) => (x - minX) * sc + pad;
  const toMY = (y: number) => (y - minY) * sc + pad;

  // Draw edges
  ctx.strokeStyle = "rgba(77,142,240,0.4)";
  ctx.lineWidth   = 1;
  edges.forEach(e => {
    const s = store.getNode(e.sourceNodeId), t = store.getNode(e.targetNodeId);
    if (!s || !t) return;
    ctx.beginPath();
    ctx.moveTo(toMX(s.position.x + NODE_W), toMY(s.position.y + NODE_H/2));
    ctx.lineTo(toMX(t.position.x), toMY(t.position.y + NODE_H/2));
    ctx.stroke();
  });

  // Draw nodes
  const sel = store.getState().selectedNodes;
  nodes.forEach(n => {
    ctx.fillStyle = sel.has(n.id) ? "rgba(77,142,240,0.9)" : "rgba(77,142,240,0.45)";
    ctx.fillRect(toMX(n.position.x), toMY(n.position.y), NODE_W * sc, NODE_H * sc);
  });

  // Draw viewport indicator
  const r    = root.getBoundingClientRect();
  const vpX  = (-ox / zoom - minX) * sc + pad;
  const vpY  = (-oy / zoom - minY) * sc + pad;
  const vpW  = (r.width  / zoom) * sc;
  const vpH  = (r.height / zoom) * sc;
  ctx.strokeStyle = "rgba(255,255,255,0.4)";
  ctx.lineWidth   = 1;
  ctx.strokeRect(vpX, vpY, vpW, vpH);
}

// ── Utils ──────────────────────────────────────────────────
function esc(s: string): string {
  return String(s).replace(/&/g,"&amp;").replace(/"/g,"&quot;").replace(/</g,"&lt;");
}

import { store } from "../../state/AppStore";
import type { CraftNode, CraftEdge } from "../../types/index";

// ── Types ──────────────────────────────────────────────────
interface DepNode {
  classname: string;
  displayName: string;
  depth: number;
  x: number;
  y: number;
  imageUrl?: string;
}

interface DepEdge {
  from: string;
  to: string;
  amount: number;
}

// ── Constants ──────────────────────────────────────────────
const DW = 160, DH = 56, PAD_X = 200, PAD_Y = 80;

// ── Open Modal ─────────────────────────────────────────────
export function openDependencyGraph(rootClassname?: string): void {
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.style.alignItems = "flex-start";
  overlay.style.paddingTop = "32px";

  overlay.innerHTML = `
    <div class="modal" style="width:92vw;max-width:1100px;height:80vh;display:flex;flex-direction:column;">
      <div class="modal-header">
        <span>Dependency Graph</span>
        <div style="display:flex;gap:8px;align-items:center;">
          <input id="dg-search" class="field-input" style="width:200px;"
            placeholder="Classname filtern…" value="${rootClassname ?? ""}" />
          <select id="dg-direction" class="field-input" style="width:120px;">
            <option value="ltr">Links → Rechts</option>
            <option value="rtl">Rechts → Links</option>
          </select>
          <button class="btn btn-secondary btn-sm" id="dg-fit">Einpassen</button>
          <button class="btn btn-ghost btn-icon" id="dg-close">✕</button>
        </div>
      </div>
      <div style="flex:1;position:relative;overflow:hidden;background:var(--bg-base);">
        <canvas id="dg-canvas" style="position:absolute;inset:0;width:100%;height:100%;"></canvas>
        <div id="dg-tooltip" style="
          position:absolute;pointer-events:none;display:none;
          background:var(--bg-elevated);border:1px solid var(--border);
          border-radius:5px;padding:6px 10px;font-size:11px;z-index:10;
          max-width:220px;
        "></div>
      </div>
      <div class="modal-footer" style="justify-content:space-between;">
        <div style="font-size:11px;color:var(--text-muted);" id="dg-stats"></div>
        <button class="btn btn-secondary" id="dg-close2">Schließen</button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  overlay.querySelector("#dg-close")! .addEventListener("click", close);
  overlay.querySelector("#dg-close2")!.addEventListener("click", close);
  overlay.addEventListener("click", e => { if (e.target === overlay) close(); });

  const canvas  = overlay.querySelector("#dg-canvas") as HTMLCanvasElement;
  const tooltip = overlay.querySelector("#dg-tooltip") as HTMLElement;
  const search  = overlay.querySelector("#dg-search")  as HTMLInputElement;
  const dirSel  = overlay.querySelector("#dg-direction") as HTMLSelectElement;

  const renderer = new DepGraphRenderer(canvas, tooltip);

  const rebuild = () => {
    const filter = search.value.trim().toLowerCase();
    const dir    = dirSel.value as "ltr" | "rtl";
    renderer.build(filter, dir);
    const stats  = renderer.getStats();
    const el     = overlay.querySelector("#dg-stats")!;
    el.textContent = `${stats.nodes} Nodes · ${stats.edges} Abhängigkeiten · ${stats.chains} Ketten`;
  };

  search.addEventListener("input",  rebuild);
  dirSel.addEventListener("change", rebuild);
  overlay.querySelector("#dg-fit")!.addEventListener("click", () => renderer.fitAll());

  // Wait for layout before first render
  requestAnimationFrame(() => { renderer.resize(); rebuild(); });

  const onResize = () => renderer.resize();
  window.addEventListener("resize", onResize);

  // Clean up resize listener when modal is removed
  const modalEl = overlay.querySelector(".modal") as HTMLElement;
  const resizeObserver = new MutationObserver(() => {
    if (!document.body.contains(modalEl)) {
      window.removeEventListener("resize", onResize);
      resizeObserver.disconnect();
    }
  });
  resizeObserver.observe(document.body, { childList: true, subtree: false });
}

// ── Renderer ───────────────────────────────────────────────
class DepGraphRenderer {
  private canvas:  HTMLCanvasElement;
  private ctx:     CanvasRenderingContext2D;
  private tooltip: HTMLElement;
  private nodes:   DepNode[] = [];
  private edges:   DepEdge[] = [];
  private ox = 0; private oy = 0; private zoom = 1;
  private panning = false; private px0 = 0; private py0 = 0;
  private hoveredNode: DepNode | null = null;

  constructor(canvas: HTMLCanvasElement, tooltip: HTMLElement) {
    this.canvas  = canvas;
    this.ctx     = canvas.getContext("2d")!;
    this.tooltip = tooltip;
    this.bindEvents();
  }

  resize(): void {
    const r = this.canvas.parentElement!.getBoundingClientRect();
    this.canvas.width  = r.width;
    this.canvas.height = r.height;
    this.draw();
  }

  build(filter: string, dir: "ltr" | "rtl"): void {
    const storeNodes = store.getNodes();
    const storeEdges = store.getEdges();

    // Filter nodes
    const nodeMap = new Map<string, CraftNode>();
    storeNodes.forEach(n => {
      if (!filter || n.classname.toLowerCase().includes(filter) ||
          n.displayName.toLowerCase().includes(filter)) {
        nodeMap.set(n.id, n);
      }
    });

    // If filter active, expand to include all connected nodes
    if (filter) {
      const matchedIds = new Set(nodeMap.keys());
      let changed = true;
      while (changed) {
        changed = false;
        storeEdges.forEach(e => {
          if (matchedIds.has(e.sourceNodeId) && !matchedIds.has(e.targetNodeId)) {
            const n = storeNodes.find(n => n.id === e.targetNodeId);
            if (n) { nodeMap.set(n.id, n); matchedIds.add(n.id); changed = true; }
          }
          if (matchedIds.has(e.targetNodeId) && !matchedIds.has(e.sourceNodeId)) {
            const n = storeNodes.find(n => n.id === e.sourceNodeId);
            if (n) { nodeMap.set(n.id, n); matchedIds.add(n.id); changed = true; }
          }
        });
      }
    }

    const relevantEdges = storeEdges.filter(
      e => nodeMap.has(e.sourceNodeId) && nodeMap.has(e.targetNodeId)
    );

    // Assign layers
    const layerMap = this.computeLayers(nodeMap, relevantEdges);
    const byLayer  = new Map<number, string[]>();
    nodeMap.forEach((_, id) => {
      const l = layerMap.get(id) ?? 0;
      if (!byLayer.has(l)) byLayer.set(l, []);
      byLayer.get(l)!.push(id);
    });

    const maxLayer = Math.max(0, ...[...byLayer.keys()]);

    // Build DepNodes with positions
    this.nodes = [];
    byLayer.forEach((ids, layer) => {
      const displayLayer = dir === "rtl" ? maxLayer - layer : layer;
      ids.forEach((id, i) => {
        const n = nodeMap.get(id)!;
        this.nodes.push({
          classname:   n.classname,
          displayName: n.displayName,
          imageUrl:    n.imageUrl,
          depth:       layer,
          x:           displayLayer * PAD_X + 40,
          y:           i * PAD_Y + 40,
        });
      });
    });

    // Build DepEdges
    this.edges = relevantEdges.map(e => {
      const src = nodeMap.get(e.sourceNodeId)!;
      const tgt = nodeMap.get(e.targetNodeId)!;
      return { from: src.classname, to: tgt.classname, amount: e.amount };
    });

    this.fitAll();
  }

  private computeLayers(
    nodeMap: Map<string, CraftNode>,
    edges: CraftEdge[]
  ): Map<string, number> {
    const inCount = new Map<string, number>();
    const outEdges = new Map<string, string[]>();
    nodeMap.forEach((_, id) => { inCount.set(id, 0); outEdges.set(id, []); });
    edges.forEach(e => {
      inCount.set(e.targetNodeId, (inCount.get(e.targetNodeId) ?? 0) + 1);
      outEdges.get(e.sourceNodeId)?.push(e.targetNodeId);
    });

    const layer = new Map<string, number>();
    const assign = (id: string, l: number) => {
      layer.set(id, Math.max(layer.get(id) ?? 0, l));
      (outEdges.get(id) ?? []).forEach(nid => assign(nid, l + 1));
    };
    nodeMap.forEach((_, id) => { if ((inCount.get(id) ?? 0) === 0) assign(id, 0); });

    // Nodes not reached (part of cycle) get layer 0
    nodeMap.forEach((_, id) => { if (!layer.has(id)) layer.set(id, 0); });
    return layer;
  }

  getStats() {
    const chains = this.nodes.filter(n =>
      !this.edges.some(e => e.to === n.classname)
    ).length;
    return { nodes: this.nodes.length, edges: this.edges.length, chains };
  }

  fitAll(): void {
    if (this.nodes.length === 0) { this.draw(); return; }
    const w = this.canvas.width, h = this.canvas.height;
    const minX = Math.min(...this.nodes.map(n => n.x)) - 20;
    const maxX = Math.max(...this.nodes.map(n => n.x + DW)) + 20;
    const minY = Math.min(...this.nodes.map(n => n.y)) - 20;
    const maxY = Math.max(...this.nodes.map(n => n.y + DH)) + 20;
    const nz   = Math.min(w / (maxX - minX), h / (maxY - minY), 1.5);
    this.zoom = nz;
    this.ox   = (w - (maxX - minX) * nz) / 2 - minX * nz;
    this.oy   = (h - (maxY - minY) * nz) / 2 - minY * nz;
    this.draw();
  }

  private draw(): void {
    const ctx = this.ctx;
    const w = this.canvas.width, h = this.canvas.height;
    ctx.clearRect(0, 0, w, h);

    // Background
    const bgColor = getComputedStyle(document.documentElement).getPropertyValue("--bg-base").trim();
    ctx.fillStyle = bgColor || "#0e1117";
    ctx.fillRect(0, 0, w, h);

    ctx.save();
    ctx.translate(this.ox, this.oy);
    ctx.scale(this.zoom, this.zoom);

    this.drawEdges(ctx);
    this.drawNodes(ctx);

    ctx.restore();
  }

  private drawEdges(ctx: CanvasRenderingContext2D): void {
    const nodePos = new Map<string, {x:number;y:number}>();
    this.nodes.forEach(n => nodePos.set(n.classname, { x: n.x, y: n.y }));

    const accentColor = getComputedStyle(document.documentElement)
      .getPropertyValue("--accent").trim() || "#4d8ef0";

    this.edges.forEach(e => {
      const src = nodePos.get(e.from);
      const tgt = nodePos.get(e.to);
      if (!src || !tgt) return;

      const x1 = src.x + DW, y1 = src.y + DH / 2;
      const x2 = tgt.x,      y2 = tgt.y + DH / 2;
      const dx = Math.abs(x2 - x1) * 0.5;

      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.bezierCurveTo(x1 + dx, y1, x2 - dx, y2, x2, y2);
      ctx.strokeStyle = accentColor + "88";
      ctx.lineWidth   = 1.5;
      ctx.stroke();

      // Arrow
      ctx.beginPath();
      ctx.moveTo(x2, y2);
      ctx.lineTo(x2 - 8, y2 - 4);
      ctx.lineTo(x2 - 8, y2 + 4);
      ctx.closePath();
      ctx.fillStyle = accentColor + "cc";
      ctx.fill();

      // Amount label
      if (e.amount > 1) {
        const mx = (x1 + x2) / 2, my = (y1 + y2) / 2 - 8;
        ctx.fillStyle   = accentColor;
        ctx.font        = "bold 11px sans-serif";
        ctx.textAlign   = "center";
        ctx.fillText(`×${e.amount}`, mx, my);
      }
    });
  }

  private drawNodes(ctx: CanvasRenderingContext2D): void {
    const surfaceColor = getComputedStyle(document.documentElement)
      .getPropertyValue("--bg-elevated").trim() || "#1e2636";
    const borderColor = getComputedStyle(document.documentElement)
      .getPropertyValue("--border").trim() || "#2a3448";
    const textPrimary = getComputedStyle(document.documentElement)
      .getPropertyValue("--text-primary").trim() || "#e8edf5";
    const textMuted = getComputedStyle(document.documentElement)
      .getPropertyValue("--text-muted").trim() || "#4a5a7a";
    const accentColor = getComputedStyle(document.documentElement)
      .getPropertyValue("--accent").trim() || "#4d8ef0";

    this.nodes.forEach(n => {
      const isHovered = this.hoveredNode?.classname === n.classname;

      // Card
      ctx.fillStyle   = surfaceColor;
      ctx.strokeStyle = isHovered ? accentColor : borderColor;
      ctx.lineWidth   = isHovered ? 2 : 1;
      this.roundRect(ctx, n.x, n.y, DW, DH, 6);
      ctx.fill(); ctx.stroke();

      // Icon placeholder
      ctx.fillStyle = borderColor;
      this.roundRect(ctx, n.x + 6, n.y + 6, DH - 12, DH - 12, 4);
      ctx.fill();

      // Classname
      ctx.fillStyle = textPrimary;
      ctx.font      = "bold 11px sans-serif";
      ctx.textAlign = "left";
      const labelX  = n.x + DH;
      const maxW    = DW - DH - 6;
      ctx.fillText(this.truncate(ctx, n.classname, maxW), labelX, n.y + 22);

      // Display name
      ctx.fillStyle = textMuted;
      ctx.font      = "10px sans-serif";
      ctx.fillText(this.truncate(ctx, n.displayName, maxW), labelX, n.y + 36);

      // Depth badge
      ctx.fillStyle = accentColor + "33";
      this.roundRect(ctx, n.x + DW - 24, n.y + 4, 20, 14, 3);
      ctx.fill();
      ctx.fillStyle   = accentColor;
      ctx.font        = "bold 9px sans-serif";
      ctx.textAlign   = "center";
      ctx.fillText(`L${n.depth}`, n.x + DW - 14, n.y + 14);
    });
  }

  private roundRect(ctx: CanvasRenderingContext2D, x: number, y: number,
    w: number, h: number, r: number): void {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.arcTo(x + w, y, x + w, y + r, r);
    ctx.lineTo(x + w, y + h - r);
    ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
    ctx.lineTo(x + r, y + h);
    ctx.arcTo(x, y + h, x, y + h - r, r);
    ctx.lineTo(x, y + r);
    ctx.arcTo(x, y, x + r, y, r);
    ctx.closePath();
  }

  private truncate(ctx: CanvasRenderingContext2D, text: string, maxW: number): string {
    if (ctx.measureText(text).width <= maxW) return text;
    while (text.length > 1 && ctx.measureText(text + "…").width > maxW) {
      text = text.slice(0, -1);
    }
    return text + "…";
  }

  private bindEvents(): void {
    this.canvas.addEventListener("wheel", e => {
      e.preventDefault();
      const r = this.canvas.getBoundingClientRect();
      const cx = e.clientX - r.left, cy = e.clientY - r.top;
      const f  = e.deltaY < 0 ? 1.1 : 0.9;
      const nz = Math.min(3, Math.max(0.1, this.zoom * f));
      const sc = nz / this.zoom;
      this.ox  = cx - sc * (cx - this.ox);
      this.oy  = cy - sc * (cy - this.oy);
      this.zoom = nz;
      this.draw();
    }, { passive: false });

    this.canvas.addEventListener("mousedown", e => {
      this.panning = true;
      this.px0 = e.clientX - this.ox;
      this.py0 = e.clientY - this.oy;
      this.canvas.style.cursor = "grabbing";
    });

    const onMove = (e: MouseEvent) => {
      if (this.panning) {
        this.ox = e.clientX - this.px0;
        this.oy = e.clientY - this.py0;
        this.draw();
        return;
      }
      const r  = this.canvas.getBoundingClientRect();
      // Canvas may be removed from DOM after modal close
      if (r.width === 0) return;
      const cx = (e.clientX - r.left - this.ox) / this.zoom;
      const cy = (e.clientY - r.top  - this.oy) / this.zoom;
      const hit = this.nodes.find(n =>
        cx >= n.x && cx <= n.x + DW && cy >= n.y && cy <= n.y + DH
      );
      if (hit !== this.hoveredNode) {
        this.hoveredNode = hit ?? null;
        this.draw();
      }
      if (hit) {
        this.tooltip.style.display = "block";
        this.tooltip.style.left    = `${e.clientX - r.left + 12}px`;
        this.tooltip.style.top     = `${e.clientY - r.top  + 12}px`;
        const outDeps  = this.edges.filter(ed => ed.from === hit.classname);
        const inDeps   = this.edges.filter(ed => ed.to   === hit.classname);
        this.tooltip.innerHTML = `
          <strong>${hit.classname}</strong><br/>
          <span style="color:var(--text-muted)">${hit.displayName}</span><br/>
          <span style="color:var(--text-muted)">Layer ${hit.depth}</span>
          ${inDeps.length  > 0 ? `<br/>← ${inDeps.map(e => e.from).join(", ")}` : ""}
          ${outDeps.length > 0 ? `<br/>→ ${outDeps.map(e => e.to).join(", ")}` : ""}
        `;
      } else {
        this.tooltip.style.display = "none";
      }
    };

    const onUp = () => {
      this.panning = false;
      this.canvas.style.cursor = "";
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup",   onUp);

    // Cleanup when canvas is removed from DOM (modal closed)
    const observer = new MutationObserver(() => {
      if (!document.body.contains(this.canvas)) {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup",   onUp);
        observer.disconnect();
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }
}

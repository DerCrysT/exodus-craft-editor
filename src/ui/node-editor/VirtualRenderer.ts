import type { CraftNode } from "../../types/index";

// ── Virtual Viewport Culling ───────────────────────────────
// Nodes outside the visible canvas area are hidden via CSS
// (display:none). This keeps DOM node count low for large graphs.

const NODE_W = 184;
const NODE_H = 120; // generous height to avoid pop-in
const MARGIN  = 200; // px of extra margin beyond viewport

export class VirtualRenderer {
  private canvasWidth  = 0;
  private canvasHeight = 0;

  update(containerRect: DOMRect): void {
    this.canvasWidth  = containerRect.width;
    this.canvasHeight = containerRect.height;
  }

  /** Returns which node IDs are inside the current viewport */
  getVisibleIds(nodes: CraftNode[], ox: number, oy: number, zoom: number): Set<string> {
    // Viewport in canvas-space (with margin for smooth appear)
    const vx0 = (-ox - MARGIN)         / zoom;
    const vy0 = (-oy - MARGIN)         / zoom;
    const vx1 = (this.canvasWidth  - ox + MARGIN) / zoom;
    const vy1 = (this.canvasHeight - oy + MARGIN) / zoom;

    const visible = new Set<string>();
    for (const n of nodes) {
      if (
        n.position.x + NODE_W >= vx0 &&
        n.position.x          <= vx1 &&
        n.position.y + NODE_H >= vy0 &&
        n.position.y          <= vy1
      ) {
        visible.add(n.id);
      }
    }
    return visible;
  }

  /** Apply visibility to all node DOM elements */
  applyVisibility(nodes: CraftNode[], ox: number, oy: number, zoom: number): void {
    if (nodes.length < 80) return; // only kick in for large graphs

    const visible = this.getVisibleIds(nodes, ox, oy, zoom);
    nodes.forEach(n => {
      const el = document.querySelector<HTMLElement>(`[data-node-id="${n.id}"]`);
      if (!el) return;
      const isVisible = visible.has(n.id);
      if (el.style.display === (isVisible ? "" : "none")) return; // no-op
      el.style.display = isVisible ? "" : "none";
    });
  }
}

export const virtualRenderer = new VirtualRenderer();

// ── Performance Monitor (dev helper) ──────────────────────
export class PerfMonitor {
  private frames: number[] = [];
  private lastTime = performance.now();
  private el: HTMLElement | null = null;

  start(): void {
    this.el = document.createElement("div");
    this.el.id = "perf-monitor";
    this.el.style.cssText = `
      position:fixed;bottom:32px;right:180px;z-index:9999;
      background:rgba(0,0,0,0.7);color:#0f0;font-size:10px;
      font-family:monospace;padding:4px 8px;border-radius:4px;
      pointer-events:none;display:none;
    `;
    document.body.appendChild(this.el);
    this.tick();
  }

  private tick(): void {
    const now = performance.now();
    const delta = now - this.lastTime;
    this.lastTime = now;
    this.frames.push(1000 / delta);
    if (this.frames.length > 60) this.frames.shift();

    if (this.el && this.el.style.display !== "none") {
      const avg = this.frames.reduce((a, b) => a + b, 0) / this.frames.length;
      const nodes = document.querySelectorAll(".craft-node").length;
      this.el.textContent = `${Math.round(avg)} FPS | ${nodes} nodes`;
    }

    requestAnimationFrame(() => this.tick());
  }

  toggle(): void {
    if (!this.el) return;
    this.el.style.display = this.el.style.display === "none" ? "" : "none";
  }
}

export const perfMonitor = new PerfMonitor();

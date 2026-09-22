import type { ValidationIssue } from "../../types/index";
import { focusOnNode, focusOnEdge } from "../node-editor/NodeEditor";

// Non-blocking, persistent panel (no backdrop) so the canvas stays usable
// while working through the list: click an issue → jumps to the node →
// fix it directly → hit "Neu prüfen" → keep going, one by one.

let panelEl: HTMLElement | null = null;
let currentGetIssues: (() => ValidationIssue[]) | null = null;

export function openValidationPanel(getIssues: () => ValidationIssue[]): void {
  currentGetIssues = getIssues;
  if (!panelEl) {
    panelEl = document.createElement("div");
    panelEl.id = "validation-panel";
    document.body.appendChild(panelEl);
  }
  renderPanel(getIssues());
}

export function closeValidationPanel(): void {
  panelEl?.remove();
  panelEl = null;
  currentGetIssues = null;
}

function renderPanel(issues: ValidationIssue[]): void {
  if (!panelEl) return;

  const errors   = issues.filter(i => i.severity === "error").length;
  const warnings = issues.filter(i => i.severity === "warning").length;
  const infos    = issues.filter(i => i.severity === "info").length;

  panelEl.innerHTML = `
    <div class="vp-header">
      <span>🔍 Validierung — ${issues.length === 0 ? "keine Probleme" : `${issues.length} Problem${issues.length !== 1 ? "e" : ""}`}</span>
      <div style="display:flex;gap:4px;">
        <button class="btn btn-ghost btn-icon" id="vp-refresh" title="Neu prüfen">↻</button>
        <button class="btn btn-ghost btn-icon" id="vp-close" title="Schließen">✕</button>
      </div>
    </div>
    ${issues.length > 0 ? `
      <div class="vp-summary">
        ${errors   ? `<span class="vp-badge error">✖ ${errors}</span>`     : ""}
        ${warnings ? `<span class="vp-badge warning">⚠ ${warnings}</span>` : ""}
        ${infos    ? `<span class="vp-badge info">ℹ ${infos}</span>`       : ""}
      </div>
    ` : ""}
    <div class="vp-list">
      ${issues.length === 0
        ? `<div class="vp-empty">✓ Keine Probleme gefunden</div>`
        : issues.map(issueRow).join("")}
    </div>
  `;

  panelEl.querySelector("#vp-close")!.addEventListener("click", closeValidationPanel);
  panelEl.querySelector("#vp-refresh")!.addEventListener("click", () => {
    if (currentGetIssues) renderPanel(currentGetIssues());
  });

  panelEl.querySelectorAll<HTMLElement>(".vp-item.jumpable").forEach(el => {
    el.addEventListener("click", () => {
      const nodeId = el.dataset.nodeId;
      const edgeId = el.dataset.edgeId;
      if (nodeId) focusOnNode(nodeId);
      else if (edgeId) focusOnEdge(edgeId);
    });
  });
}

function issueRow(issue: ValidationIssue): string {
  const icon     = issue.severity === "error" ? "✖" : issue.severity === "warning" ? "⚠" : "ℹ";
  const jumpable = !!(issue.nodeId || issue.edgeId);
  return `
    <div class="vp-item ${issue.severity} ${jumpable ? "jumpable" : ""}"
      ${issue.nodeId ? `data-node-id="${esc(issue.nodeId)}"` : ""}
      ${issue.edgeId ? `data-edge-id="${esc(issue.edgeId)}"` : ""}>
      <span class="vp-icon">${icon}</span>
      <span class="vp-msg">${esc(issue.message)}</span>
      ${jumpable ? `<span class="vp-jump">→</span>` : ""}
    </div>
  `;
}

function esc(s: string): string {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

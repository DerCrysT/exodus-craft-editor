import type { ValidationIssue } from "../../types/index";
import { focusOnNode, focusOnEdge } from "../node-editor/NodeEditor";
import { runPlausibilityCheck, acceptPlausibilityValue, type PlausibilityIssue } from "../../data/plausibility";

// Non-blocking, persistent panel (no backdrop) so the canvas stays usable
// while working through the list: click an issue → jumps to the node →
// fix it directly → hit "Neu prüfen" → keep going, one by one.
//
// Two tabs: "Fehler" (the existing structural validation) and
// "Plausibilität" (statistical outliers vs. comparable recipes across all
// workbenches — values you either correct or explicitly accept as fine).

let panelEl: HTMLElement | null = null;
let currentGetIssues: (() => ValidationIssue[]) | null = null;
let activeTab: "errors" | "plausibility" = "errors";

export function openValidationPanel(getIssues: () => ValidationIssue[]): void {
  currentGetIssues = getIssues;
  activeTab = "errors";
  if (!panelEl) {
    panelEl = document.createElement("div");
    panelEl.id = "validation-panel";
    document.body.appendChild(panelEl);
  }
  render();
}

export function closeValidationPanel(): void {
  panelEl?.remove();
  panelEl = null;
  currentGetIssues = null;
}

function render(): void {
  if (!panelEl) return;

  const issues = activeTab === "errors" && currentGetIssues ? currentGetIssues() : [];
  const plausibility = activeTab === "plausibility" ? runPlausibilityCheck() : [];

  const tabBtn = (id: "errors" | "plausibility", label: string, count: number) => `
    <button class="vp-tab ${activeTab === id ? "active" : ""}" data-tab="${id}">
      ${label}${count > 0 ? ` <span class="vp-tab-count">${count}</span>` : ""}
    </button>`;

  panelEl.innerHTML = `
    <div class="vp-header">
      <span>🔍 Validierung</span>
      <div style="display:flex;gap:4px;">
        <button class="btn btn-ghost btn-icon" id="vp-refresh" title="Neu prüfen">↻</button>
        <button class="btn btn-ghost btn-icon" id="vp-close" title="Schließen">✕</button>
      </div>
    </div>
    <div class="vp-tabs">
      ${tabBtn("errors", "Fehler", currentGetIssues ? currentGetIssues().length : 0)}
      ${tabBtn("plausibility", "Plausibilität", activeTab === "plausibility" ? plausibility.length : runPlausibilityCheck().length)}
    </div>
    ${activeTab === "errors" ? renderErrorsBody(issues) : renderPlausibilityBody(plausibility)}
  `;

  panelEl.querySelector("#vp-close")!.addEventListener("click", closeValidationPanel);
  panelEl.querySelector("#vp-refresh")!.addEventListener("click", render);
  panelEl.querySelectorAll<HTMLElement>(".vp-tab").forEach(btn => {
    btn.addEventListener("click", () => {
      activeTab = btn.dataset.tab as "errors" | "plausibility";
      render();
    });
  });

  if (activeTab === "errors") {
    panelEl.querySelectorAll<HTMLElement>(".vp-item.jumpable").forEach(el => {
      el.addEventListener("click", () => {
        const nodeId = el.dataset.nodeId;
        const edgeId = el.dataset.edgeId;
        if (nodeId) focusOnNode(nodeId);
        else if (edgeId) focusOnEdge(edgeId);
      });
    });
  } else {
    panelEl.querySelectorAll<HTMLElement>(".vp-pl-jump").forEach(el => {
      el.addEventListener("click", () => focusOnNode(el.dataset.nodeId!));
    });
    panelEl.querySelectorAll<HTMLElement>(".vp-pl-accept").forEach(el => {
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        acceptPlausibilityValue(el.dataset.edgeId!, Number(el.dataset.value));
        render();
      });
    });
  }
}

function renderErrorsBody(issues: ValidationIssue[]): string {
  const errors   = issues.filter(i => i.severity === "error").length;
  const warnings = issues.filter(i => i.severity === "warning").length;
  const infos    = issues.filter(i => i.severity === "info").length;
  return `
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

function renderPlausibilityBody(issues: PlausibilityIssue[]): string {
  return `
    <div style="padding:6px 12px;font-size:10px;color:var(--text-muted);border-bottom:1px solid var(--border);">
      Vergleicht Mengen/Changehealth mit dem Median über alle Werkbänke. "Akzeptieren" blendet einen Wert dauerhaft aus, solange er sich nicht ändert.
    </div>
    <div class="vp-list">
      ${issues.length === 0
        ? `<div class="vp-empty">✓ Keine auffälligen Werte gefunden</div>`
        : issues.map(plausibilityRow).join("")}
    </div>
  `;
}

function plausibilityRow(issue: PlausibilityIssue): string {
  return `
    <div class="vp-item warning" style="flex-direction:column;align-items:stretch;gap:4px;">
      <div class="vp-pl-jump" data-node-id="${esc(issue.nodeId)}" style="cursor:pointer;display:flex;gap:6px;align-items:flex-start;">
        <span class="vp-icon">⚠</span>
        <span class="vp-msg">${esc(issue.message)}</span>
      </div>
      <button class="btn btn-ghost btn-sm vp-pl-accept" data-edge-id="${esc(issue.edgeId)}"
        data-value="${issue.currentValue}" style="align-self:flex-end;">✓ Als korrekt akzeptieren</button>
    </div>
  `;
}

function esc(s: string): string {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

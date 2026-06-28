import { store } from "../../state/AppStore";
import type { WorkbenchJSON, CraftItem } from "../../types/index";
import { showToast } from "../toolbar/Toolbar";
import { downloadFile } from "../../data/jsonHandler";

// ── Types ──────────────────────────────────────────────────
export interface RestorePoint {
  id: string;
  label: string;
  timestamp: number;
  auto: boolean;
  jsonData: WorkbenchJSON;
  nodeCount: number;
  edgeCount: number;
  recipeCount: number;
}

const STORAGE_KEY = "exodus_craft_versions";
const MAX_AUTO    = 20;
const MAX_MANUAL  = 50;

// ── Storage ────────────────────────────────────────────────
function loadPoints(): RestorePoint[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

function savePoints(points: RestorePoint[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(points));
  } catch { /* storage full */ }
}

// ── Public API ─────────────────────────────────────────────
export function createRestorePoint(label?: string, auto = false): void {
  const state = store.getState();
  const points = loadPoints();

  const recipeCount = state.project.jsonData.CraftCategories
    .reduce((s, c) => s + c.CraftItems.length, 0);

  const point: RestorePoint = {
    id:          `rp_${Date.now()}_${Math.random().toString(36).slice(2,5)}`,
    label:       label ?? `Automatisch — ${new Date().toLocaleTimeString("de-DE")}`,
    timestamp:   Date.now(),
    auto,
    jsonData:    JSON.parse(JSON.stringify(state.project.jsonData)),
    nodeCount:   state.project.nodes.length,
    edgeCount:   state.project.edges.length,
    recipeCount,
  };

  points.unshift(point);

  // Trim separately: keep newest N auto + newest M manual
  const autos   = points.filter(p => p.auto)  .slice(0, MAX_AUTO);
  const manuals = points.filter(p => !p.auto) .slice(0, MAX_MANUAL);
  savePoints([...manuals, ...autos].sort((a, b) => b.timestamp - a.timestamp));

  if (!auto) showToast(`Wiederherstellungspunkt "${point.label}" erstellt`, "success");
}

// Auto-save restore point every 5 minutes
let autoTimer: ReturnType<typeof setInterval> | null = null;
export function initVersioning(): void {
  if (autoTimer) clearInterval(autoTimer);
  autoTimer = setInterval(() => {
    // Only create auto point if there's actual content
    if (store.getNodes().length > 0 || store.getJSON().CraftCategories.length > 0) {
      createRestorePoint(undefined, true);
    }
  }, 5 * 60 * 1000);
}

// ── Versioning Modal ───────────────────────────────────────
export function openVersioningModal(): void {
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.style.alignItems = "flex-start";
  overlay.style.paddingTop = "24px";

  overlay.innerHTML = `
    <div class="modal" style="width:88vw;max-width:960px;height:82vh;display:flex;flex-direction:column;">
      <div class="modal-header">
        <span>🕐 Versionsverlauf</span>
        <div style="display:flex;gap:8px;align-items:center;">
          <button class="btn btn-primary btn-sm" id="vr-create">+ Wiederherstellungspunkt</button>
          <button class="btn btn-ghost btn-icon" id="vr-close">✕</button>
        </div>
      </div>

      <div style="display:grid;grid-template-columns:300px 1fr;flex:1;overflow:hidden;">

        <!-- LEFT: Version list -->
        <div style="border-right:1px solid var(--border);display:flex;flex-direction:column;overflow:hidden;">
          <div style="padding:8px 12px;border-bottom:1px solid var(--border);display:flex;gap:6px;">
            <button class="btn btn-ghost btn-sm vr-filter active" data-filter="all">Alle</button>
            <button class="btn btn-ghost btn-sm vr-filter" data-filter="manual">Manuell</button>
            <button class="btn btn-ghost btn-sm vr-filter" data-filter="auto">Auto</button>
          </div>
          <div id="vr-list" style="flex:1;overflow-y:auto;"></div>
        </div>

        <!-- RIGHT: Diff viewer -->
        <div style="display:flex;flex-direction:column;overflow:hidden;">
          <div style="padding:8px 12px;border-bottom:1px solid var(--border);display:flex;
            align-items:center;justify-content:space-between;">
            <span style="font-size:12px;font-weight:600;" id="vr-diff-title">Diff Viewer</span>
            <div style="display:flex;gap:6px;" id="vr-diff-actions" style="display:none;">
              <button class="btn btn-secondary btn-sm" id="vr-export-point">JSON exportieren</button>
              <button class="btn btn-danger btn-sm" id="vr-restore-btn">Wiederherstellen</button>
            </div>
          </div>
          <div id="vr-diff-body" style="flex:1;overflow-y:auto;padding:12px;font-size:12px;">
            <div class="empty-state"><p>Version auswählen</p></div>
          </div>
        </div>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  overlay.querySelector("#vr-close")!.addEventListener("click", close);
  overlay.addEventListener("click", e => { if (e.target === overlay) close(); });

  let selectedPoint: RestorePoint | null = null;
  let filter: "all"|"manual"|"auto" = "all";

  // Filter buttons
  overlay.querySelectorAll<HTMLElement>(".vr-filter").forEach(btn => {
    btn.addEventListener("click", () => {
      overlay.querySelectorAll(".vr-filter").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      filter = btn.dataset.filter as "all"|"manual"|"auto";
      renderList();
    });
  });

  // Create point
  overlay.querySelector("#vr-create")!.addEventListener("click", () => {
    const label = prompt("Name für diesen Wiederherstellungspunkt:", `Manuell — ${new Date().toLocaleTimeString("de-DE")}`);
    if (label === null) return;
    createRestorePoint(label.trim() || undefined);
    renderList();
  });

  function renderList(): void {
    const points = loadPoints().filter(p =>
      filter === "all" ? true : filter === "auto" ? p.auto : !p.auto
    );
    const list = overlay.querySelector("#vr-list")!;

    if (points.length === 0) {
      list.innerHTML = `<div class="empty-state" style="padding-top:32px;"><p>Keine Versionen</p></div>`;
      return;
    }

    list.innerHTML = "";
    points.forEach(point => {
      const isSelected = selectedPoint?.id === point.id;
      const date = new Date(point.timestamp);
      const dateStr = date.toLocaleDateString("de-DE") + " " + date.toLocaleTimeString("de-DE");

      const el = document.createElement("div");
      el.style.cssText = `
        padding:10px 12px;border-bottom:1px solid var(--border);cursor:pointer;
        background:${isSelected ? "var(--accent-dim)" : "transparent"};
        border-left:3px solid ${isSelected ? "var(--accent)" : "transparent"};
        transition:background 0.1s;
      `;
      el.innerHTML = `
        <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:4px;">
          <div style="flex:1;min-width:0;">
            <div style="font-size:12px;font-weight:600;overflow:hidden;text-overflow:ellipsis;
              white-space:nowrap;color:var(--text-primary);">${esc(point.label)}</div>
            <div style="font-size:10px;color:var(--text-muted);margin-top:2px;">${dateStr}</div>
          </div>
          <span style="font-size:10px;padding:2px 6px;border-radius:10px;flex-shrink:0;
            background:${point.auto ? "var(--bg-hover)" : "var(--accent-dim)"};
            color:${point.auto ? "var(--text-muted)" : "var(--accent)"};">
            ${point.auto ? "Auto" : "Manuell"}
          </span>
        </div>
        <div style="display:flex;gap:10px;margin-top:5px;font-size:10px;color:var(--text-muted);">
          <span>📦 ${point.recipeCount} Rezepte</span>
          <span>◉ ${point.nodeCount} Nodes</span>
          <span>→ ${point.edgeCount} Verbindungen</span>
        </div>
      `;
      el.addEventListener("click", () => {
        selectedPoint = point;
        renderList();
        renderDiff(point);
      });

      list.appendChild(el);
    });
  }

  function renderDiff(point: RestorePoint): void {
    const body    = overlay.querySelector("#vr-diff-body")!;
    const title   = overlay.querySelector("#vr-diff-title")!;
    const actions = overlay.querySelector("#vr-diff-actions")!;

    title.textContent = `Vergleich: "${point.label}"`;
    (actions as HTMLElement).style.display = "flex";

    const current = store.getJSON();
    const old     = point.jsonData;

    // Compute diff
    const currentRecipes = flattenRecipes(current);
    const oldRecipes     = flattenRecipes(old);

    const added   = currentRecipes.filter(r => !oldRecipes.some(o => o.key === r.key));
    const removed = oldRecipes.filter(o => !currentRecipes.some(r => r.key === o.key));
    const changed = currentRecipes.filter(r => {
      const o = oldRecipes.find(x => x.key === r.key);
      return o && JSON.stringify(o.item) !== JSON.stringify(r.item);
    });

    body.innerHTML = `
      <div style="display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap;">
        <span style="padding:3px 8px;border-radius:4px;font-size:11px;
          background:rgba(61,186,126,0.15);color:var(--success);">
          +${added.length} hinzugefügt
        </span>
        <span style="padding:3px 8px;border-radius:4px;font-size:11px;
          background:rgba(232,92,92,0.15);color:var(--danger);">
          −${removed.length} entfernt
        </span>
        <span style="padding:3px 8px;border-radius:4px;font-size:11px;
          background:rgba(232,168,64,0.15);color:var(--warning);">
          ≠${changed.length} geändert
        </span>
      </div>

      ${added.length > 0 ? `
        <div style="margin-bottom:10px;">
          <div style="font-size:11px;font-weight:600;color:var(--success);margin-bottom:4px;">
            Hinzugefügt (${added.length})
          </div>
          ${added.map(r => diffRow(r.item, "added")).join("")}
        </div>` : ""}

      ${removed.length > 0 ? `
        <div style="margin-bottom:10px;">
          <div style="font-size:11px;font-weight:600;color:var(--danger);margin-bottom:4px;">
            Entfernt (${removed.length})
          </div>
          ${removed.map(r => diffRow(r.item, "removed")).join("")}
        </div>` : ""}

      ${changed.length > 0 ? `
        <div style="margin-bottom:10px;">
          <div style="font-size:11px;font-weight:600;color:var(--warning);margin-bottom:4px;">
            Geändert (${changed.length})
          </div>
          ${changed.map(r => {
            const o = oldRecipes.find(x => x.key === r.key)!;
            return diffRowChanged(o.item, r.item);
          }).join("")}
        </div>` : ""}

      ${added.length === 0 && removed.length === 0 && changed.length === 0
        ? `<div style="color:var(--text-muted);font-size:12px;padding:12px 0;">
            ✓ Keine Unterschiede zum aktuellen Stand
           </div>` : ""}
    `;

    // Restore button
    const restoreBtn = overlay.querySelector("#vr-restore-btn") as HTMLButtonElement;
    restoreBtn.onclick = () => {
      if (!confirm(`Stand von "${point.label}" wiederherstellen?\nDer aktuelle Stand geht verloren (Undo bleibt).`)) return;
      store.setJSON(JSON.parse(JSON.stringify(point.jsonData)));
      showToast(`Wiederhergestellt: "${point.label}"`, "success");
      close();
    };

    // Export button
    const exportBtn = overlay.querySelector("#vr-export-point") as HTMLButtonElement;
    exportBtn.onclick = () => {
      const filename = point.label.replace(/[^a-zA-Z0-9_-]/g, "_");
      downloadFile(JSON.stringify(point.jsonData, null, 4), `${filename}.json`);
    };
  }

  renderList();
}

// ── Diff helpers ───────────────────────────────────────────
interface FlatRecipe { key: string; item: CraftItem; category: string; }

function flattenRecipes(json: WorkbenchJSON): FlatRecipe[] {
  const result: FlatRecipe[] = [];
  json.CraftCategories.forEach(cat => {
    cat.CraftItems.forEach(item => {
      result.push({ key: `${cat.CategoryName}::${item.RecipeName}::${item.Result}`, item, category: cat.CategoryName });
    });
  });
  return result;
}

function diffRow(item: CraftItem, type: "added"|"removed"): string {
  const color = type === "added" ? "var(--success)" : "var(--danger)";
  const icon  = type === "added" ? "+" : "−";
  return `
    <div style="padding:5px 8px;border-radius:4px;margin-bottom:3px;font-size:11px;
      background:${type === "added" ? "rgba(61,186,126,0.08)" : "rgba(232,92,92,0.08)"};
      border-left:3px solid ${color};">
      <span style="color:${color};font-weight:700;margin-right:6px;">${icon}</span>
      <strong>${esc(item.RecipeName || item.Result)}</strong>
      <span style="color:var(--text-muted);"> — ${esc(item.Result)}</span>
      <span style="color:var(--text-muted);"> (${item.CraftComponents.length} Komp.)</span>
    </div>`;
}

function diffRowChanged(old: CraftItem, cur: CraftItem): string {
  const changes: string[] = [];
  if (old.Result !== cur.Result)           changes.push(`Result: ${old.Result} → ${cur.Result}`);
  if (old.ResultCount !== cur.ResultCount) changes.push(`Count: ${old.ResultCount} → ${cur.ResultCount}`);
  if (old.CraftType !== cur.CraftType)     changes.push(`Type: ${old.CraftType} → ${cur.CraftType}`);
  if (JSON.stringify(old.CraftComponents) !== JSON.stringify(cur.CraftComponents))
    changes.push(`Komponenten geändert`);
  if (JSON.stringify(old.AttachmentsNeed) !== JSON.stringify(cur.AttachmentsNeed))
    changes.push(`Attachments geändert`);

  return `
    <div style="padding:5px 8px;border-radius:4px;margin-bottom:3px;font-size:11px;
      background:rgba(232,168,64,0.08);border-left:3px solid var(--warning);">
      <span style="color:var(--warning);font-weight:700;margin-right:6px;">≠</span>
      <strong>${esc(cur.RecipeName || cur.Result)}</strong>
      <div style="color:var(--text-muted);margin-top:3px;padding-left:14px;">
        ${changes.map(c => `<div>${esc(c)}</div>`).join("")}
      </div>
    </div>`;
}

function esc(s: string): string {
  return String(s).replace(/&/g,"&amp;").replace(/"/g,"&quot;").replace(/</g,"&lt;");
}

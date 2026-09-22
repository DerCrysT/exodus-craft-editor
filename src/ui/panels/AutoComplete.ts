import { store } from "../../state/AppStore";
import { showToast } from "../toolbar/Toolbar";
import { buildSuggestions, recordSuggestionFeedback, type ComponentSuggestion } from "../../data/suggestionEngine";

// ── Auto-Vervollständigen ─────────────────────────────────────
// Rechtsklick auf eine frische, unverbundene Node → Vorschläge für
// Komponenten, basierend auf Häufigkeiten in vergleichbaren Rezepten
// (gleiche Tierstufe wenn vorhanden, sonst alle Werkbänke). Der Nutzer
// kann jeden Vorschlag an-/abwählen und die Menge anpassen, bevor die
// echten Nodes+Edges angelegt werden. Annahme/Ablehnung fließt als
// Lernsignal in künftige Rankings ein.

export function openAutoComplete(nodeId: string): void {
  const target = store.getNode(nodeId);
  if (!target) return;

  const result = buildSuggestions(target.classname, target.displayName || target.classname);
  if (result.suggestions.length === 0 && result.textSuggestions.length === 0) {
    showToast("Keine Vorschläge gefunden — zu wenig Vergleichsrezepte im Projekt", "warning");
    return;
  }

  const defaultChecked = (s: ComponentSuggestion): boolean =>
    s.source === "stats" && s.poolSize > 0 && s.frequency / s.poolSize >= 0.4;

  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `
    <div class="modal" style="width:620px;max-height:85vh;">
      <div class="modal-header">
        <span>🎯 Auto-Vervollständigen — ${esc(target.displayName || target.classname)}</span>
        <button class="btn btn-ghost btn-icon" id="ac-close">✕</button>
      </div>
      <div class="modal-body" style="display:flex;flex-direction:column;gap:14px;">
        <div style="font-size:11px;color:var(--text-secondary);background:var(--bg-elevated);
          border:1px solid var(--border);border-radius:5px;padding:8px 10px;">
          Vergleichspool: ${result.poolSize} Rezept${result.poolSize !== 1 ? "e" : ""}
          ${result.usedTier
            ? ` mit passender Tierstufe${result.targetTier ? ` (T${result.targetTier})` : ""}`
            : " — alle Werkbänke, kein Tier-Filter (zu wenig Vergleichsdaten oder kein Tier gesetzt)"}
        </div>

        ${result.suggestions.length > 0 ? `
        <div>
          <div class="field-label" style="margin-bottom:6px;">Vorschläge aus Vergleichsrezepten</div>
          <div id="ac-stats-list" style="display:flex;flex-direction:column;gap:6px;"></div>
        </div>` : ""}

        ${result.textSuggestions.length > 0 ? `
        <div>
          <div class="field-label" style="margin-bottom:6px;">
            Textbasierte Vorschläge <span style="color:var(--text-muted);font-weight:400;text-transform:none;">(Namensähnlichkeit, unsicherer als oben)</span>
          </div>
          <div id="ac-text-list" style="display:flex;flex-direction:column;gap:6px;"></div>
        </div>` : ""}
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary" id="ac-cancel">Abbrechen</button>
        <button class="btn btn-primary" id="ac-apply">Übernehmen</button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  overlay.querySelector("#ac-close")! .addEventListener("click", close);
  overlay.querySelector("#ac-cancel")!.addEventListener("click", close);
  overlay.addEventListener("click", e => { if (e.target === overlay) close(); });

  interface Row { s: ComponentSuggestion; wasDefaultChecked: boolean; checkboxEl: HTMLInputElement; amountEl: HTMLInputElement; destroyEl: HTMLInputElement; }
  const rows: Row[] = [];

  function buildRow(s: ComponentSuggestion): HTMLElement {
    const checked = defaultChecked(s);
    const row = document.createElement("div");
    row.style.cssText = "display:flex;align-items:center;gap:8px;padding:6px 10px;" +
      "border:1px solid var(--border);border-radius:5px;background:var(--bg-elevated);font-size:12px;";
    const confidence = s.source === "stats" ? `${s.frequency}/${s.poolSize} Rezepte` : "Namensähnlichkeit";
    row.innerHTML = `
      <input type="checkbox" class="ac-cb" ${checked ? "checked" : ""} />
      <span style="flex:1;color:var(--text-primary);">${esc(s.displayName)}</span>
      <span style="font-size:10px;color:var(--text-muted);white-space:nowrap;">${confidence}</span>
      <input type="number" class="field-input ac-amount" value="${s.amount}" min="1"
        style="width:56px;padding:3px 6px;" ${s.destroy ? "" : "disabled"} />
      <label style="display:flex;align-items:center;gap:3px;font-size:10px;color:var(--text-muted);white-space:nowrap;">
        <input type="checkbox" class="ac-destroy" ${s.destroy ? "checked" : ""} /> verbraucht
      </label>
    `;
    const checkboxEl = row.querySelector(".ac-cb")      as HTMLInputElement;
    const amountEl   = row.querySelector(".ac-amount")  as HTMLInputElement;
    const destroyEl  = row.querySelector(".ac-destroy") as HTMLInputElement;
    destroyEl.addEventListener("change", () => { amountEl.disabled = !destroyEl.checked; });
    rows.push({ s, wasDefaultChecked: checked, checkboxEl, amountEl, destroyEl });
    return row;
  }

  result.suggestions.forEach(s => overlay.querySelector("#ac-stats-list")?.appendChild(buildRow(s)));
  result.textSuggestions.forEach(s => overlay.querySelector("#ac-text-list")?.appendChild(buildRow(s)));

  overlay.querySelector("#ac-apply")!.addEventListener("click", () => {
    const NODE_W = 184, NODE_H = 100, PAD = 30;
    let placed = 0;
    let added  = 0;

    rows.forEach(r => {
      const isChecked = r.checkboxEl.checked;
      if (r.wasDefaultChecked && !isChecked) recordSuggestionFeedback(r.s.classname, "rejected");
      if (!isChecked) return;

      recordSuggestionFeedback(r.s.classname, "accepted");
      const amount  = Math.max(1, Number(r.amountEl.value) || 1);
      const destroy = r.destroyEl.checked;
      const lib = store.getLibrary().find(l => l.classname === r.s.classname);
      const newId = `node_ac_${Date.now()}_${placed}`;

      store.addNode({
        id: newId,
        classname: r.s.classname,
        displayName: r.s.displayName,
        imageUrl: lib?.imageUrl,
        position: { x: target.position.x - (NODE_W + PAD), y: target.position.y + placed * (NODE_H + 10) },
        craftType: "craft",
        resultCount: 1,
      });
      store.addEdge({
        id: `edge_ac_${Date.now()}_${placed}`,
        sourceNodeId: newId,
        targetNodeId: target.id,
        amount: destroy ? amount : 1,
        destroy,
        changehealth: destroy ? 0 : r.s.changehealth,
      });
      placed++;
      added++;
    });

    showToast(added > 0 ? `${added} Komponente${added !== 1 ? "n" : ""} hinzugefügt` : "Nichts übernommen", added > 0 ? "success" : "info");
    close();
  });
}

function esc(s: string): string {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

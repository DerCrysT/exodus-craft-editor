import { store } from "../../state/AppStore";
import type { CraftNode } from "../../types/index";
import { showToast } from "../toolbar/Toolbar";
import { WORKBENCH_DEFS } from "../../data/workbenches";

export function openMassEditModal(): void {
  const nodes = store.getNodes();
  if (nodes.length === 0) {
    showToast("Keine Nodes vorhanden", "warning");
    return;
  }

  const selected = [...store.getState().selectedNodes];
  const targets  = selected.length > 0 ? selected : nodes.map(n => n.id);

  const wbDef = WORKBENCH_DEFS.find(d => d.type === store.getState().activeWorkbench);
  const tools = wbDef?.tools ?? [];

  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `
    <div class="modal" style="width:620px;">
      <div class="modal-header">
        <span>Mass Edit — ${targets.length} Node${targets.length !== 1 ? "s" : ""}</span>
        <button class="btn btn-ghost btn-icon" id="me-close">✕</button>
      </div>
      <div class="modal-body" style="display:flex;flex-direction:column;gap:14px;">

        <div style="background:var(--accent-dim);border:1px solid var(--accent);
          border-radius:5px;padding:8px 12px;font-size:11px;color:var(--accent);">
          ℹ Nur aktivierte Felder werden auf alle ${targets.length} Nodes angewendet.
          Deaktivierte Felder bleiben unverändert.
        </div>

        <!-- Node selection list -->
        <div>
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;">
            <label class="field-label" style="margin:0;">Betroffene Nodes</label>
            <div style="display:flex;gap:6px;">
              <button class="btn btn-ghost btn-sm" id="me-sel-all">Alle</button>
              <button class="btn btn-ghost btn-sm" id="me-sel-none">Keine</button>
            </div>
          </div>
          <div id="me-node-list" style="
            max-height:140px;overflow-y:auto;border:1px solid var(--border);
            border-radius:5px;background:var(--bg-elevated);
          ">
            ${nodes.map(n => `
              <label style="display:flex;align-items:center;gap:8px;padding:5px 10px;
                border-bottom:1px solid var(--border);cursor:pointer;font-size:12px;">
                <input type="checkbox" class="me-node-cb" value="${n.id}"
                  ${targets.includes(n.id) ? "checked" : ""} />
                <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">
                  ${esc(n.displayName || n.classname)}
                </span>
                <span style="font-size:10px;color:var(--text-muted);">${esc(n.classname)}</span>
              </label>
            `).join("")}
          </div>
        </div>

        <!-- Fields to batch-edit -->
        ${massField("Craft Type", "crafttype", `
          <select class="field-input" id="me-crafttype">
            <option value="craft">craft</option>
            <option value="disassemble">disassemble</option>
            <option value="repair">repair</option>
          </select>
        `)}

        ${massField("Kategorie", "category", `
          <input class="field-input" id="me-category" placeholder="z.B. Kleidung"
            list="me-cat-list" />
          <datalist id="me-cat-list">
            ${store.getJSON().CraftCategories.map(c =>
              `<option value="${esc(c.CategoryName)}">`
            ).join("")}
          </datalist>
        `)}

        ${massField("Result Count", "resultcount", `
          <input class="field-input" id="me-resultcount" type="number" min="1" value="1" />
        `)}

        ${massField("Components Affect Health", "healthaffect", `
          <select class="field-input" id="me-healthaffect">
            <option value="0">Ja (0)</option>
            <option value="1">Nein (1)</option>
          </select>
        `)}

        ${tools.length > 0 ? massField("Werkzeuge (AttachmentsNeed)", "attachments", `
          <div style="display:flex;flex-wrap:wrap;gap:8px;">
            ${tools.map(t => `
              <label style="display:flex;align-items:center;gap:4px;font-size:12px;cursor:pointer;">
                <input type="checkbox" class="me-tool-cb" value="${t.classname}" />
                ${t.label}
              </label>
            `).join("")}
          </div>
          <div style="display:flex;gap:6px;margin-top:6px;">
            <label style="font-size:11px;display:flex;align-items:center;gap:4px;">
              <input type="radio" name="me-attach-mode" value="replace" checked />
              Ersetzen
            </label>
            <label style="font-size:11px;display:flex;align-items:center;gap:4px;">
              <input type="radio" name="me-attach-mode" value="add" />
              Hinzufügen
            </label>
            <label style="font-size:11px;display:flex;align-items:center;gap:4px;">
              <input type="radio" name="me-attach-mode" value="remove" />
              Entfernen
            </label>
          </div>
        `) : ""}

        ${massField("Classname Präfix hinzufügen", "prefix", `
          <div style="display:flex;gap:6px;">
            <input class="field-input" id="me-prefix" placeholder="z.B. Exodus_" style="flex:1;" />
            <span style="font-size:11px;color:var(--text-muted);align-self:center;">
              wird vor bestehenden Classname gesetzt
            </span>
          </div>
        `)}

        ${massField("Classname Suffix hinzufügen", "suffix", `
          <div style="display:flex;gap:6px;">
            <input class="field-input" id="me-suffix" placeholder="z.B. _V2" style="flex:1;" />
          </div>
        `)}

      </div>
      <div class="modal-footer">
        <span id="me-preview-count" style="font-size:11px;color:var(--text-muted);"></span>
        <button class="btn btn-secondary" id="me-cancel">Abbrechen</button>
        <button class="btn btn-primary"   id="me-apply">Anwenden</button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  overlay.querySelector("#me-close")! .addEventListener("click", close);
  overlay.querySelector("#me-cancel")!.addEventListener("click", close);
  overlay.addEventListener("click", e => { if (e.target === overlay) close(); });

  // Wire field toggles immediately on open
  overlay.querySelectorAll<HTMLInputElement>(".me-field-toggle").forEach(toggle => {
    const body = overlay.querySelector<HTMLElement>(`.me-field-body[data-for="${toggle.dataset.field}"]`);
    if (body) {
      body.style.opacity       = "0.4";
      body.style.pointerEvents = "none";
    }
    toggle.addEventListener("change", () => {
      if (body) {
        body.style.opacity       = toggle.checked ? "1" : "0.4";
        body.style.pointerEvents = toggle.checked ? "" : "none";
      }
      updatePreview();
    });
  });

  // Select all / none
  overlay.querySelector("#me-sel-all")!.addEventListener("click", () => {
    overlay.querySelectorAll<HTMLInputElement>(".me-node-cb").forEach(cb => cb.checked = true);
    updatePreview();
  });
  overlay.querySelector("#me-sel-none")!.addEventListener("click", () => {
    overlay.querySelectorAll<HTMLInputElement>(".me-node-cb").forEach(cb => cb.checked = false);
    updatePreview();
  });
  overlay.querySelectorAll(".me-node-cb").forEach(cb =>
    cb.addEventListener("change", updatePreview)
  );
  overlay.querySelectorAll(".me-field-toggle").forEach(cb =>
    cb.addEventListener("change", updatePreview)
  );

  updatePreview();

  // Apply
  overlay.querySelector("#me-apply")!.addEventListener("click", () => {
    applyMassEdit(overlay, nodes);
    close();
  });

  function updatePreview(): void {
    const checkedNodes = [...overlay.querySelectorAll<HTMLInputElement>(".me-node-cb")]
      .filter(cb => cb.checked).length;
    const checkedFields = [...overlay.querySelectorAll<HTMLInputElement>(".me-field-toggle")]
      .filter(cb => cb.checked).length;
    const el = overlay.querySelector("#me-preview-count")!;
    el.textContent = `${checkedNodes} Nodes · ${checkedFields} Felder werden geändert`;
  }
}

function massField(label: string, key: string, inputHtml: string): string {
  return `
    <div style="display:flex;gap:10px;align-items:flex-start;">
      <label style="display:flex;align-items:center;gap:6px;flex-shrink:0;padding-top:2px;cursor:pointer;">
        <input type="checkbox" class="me-field-toggle" data-field="${key}" />
        <span class="field-label" style="margin:0;white-space:nowrap;">${label}</span>
      </label>
      <div class="me-field-body" data-for="${key}" style="flex:1;opacity:0.4;pointer-events:none;transition:opacity 0.15s;">
        ${inputHtml}
      </div>
    </div>
  `;
}

function applyMassEdit(overlay: HTMLElement, allNodes: CraftNode[]): void {
  const targetIds = [...overlay.querySelectorAll<HTMLInputElement>(".me-node-cb")]
    .filter(cb => cb.checked).map(cb => cb.value);

  if (targetIds.length === 0) {
    showToast("Keine Nodes ausgewählt", "warning");
    return;
  }

  const enabledFields = new Set(
    [...overlay.querySelectorAll<HTMLInputElement>(".me-field-toggle")]
      .filter(cb => cb.checked).map(cb => cb.dataset.field!)
  );

  let changeCount = 0;

  targetIds.forEach(id => {
    const node = allNodes.find(n => n.id === id);
    if (!node) return;

    const patch: Partial<CraftNode> = {};

    if (enabledFields.has("crafttype")) {
      patch.craftType = (overlay.querySelector("#me-crafttype") as HTMLSelectElement).value as CraftNode["craftType"];
    }
    if (enabledFields.has("category")) {
      const v = (overlay.querySelector("#me-category") as HTMLInputElement).value.trim();
      if (v) patch.category = v;
    }
    if (enabledFields.has("resultcount")) {
      patch.resultCount = Number((overlay.querySelector("#me-resultcount") as HTMLInputElement).value);
    }
    if (enabledFields.has("healthaffect")) {
      patch.componentsDontAffectHealth = Number(
        (overlay.querySelector("#me-healthaffect") as HTMLSelectElement).value
      );
    }
    if (enabledFields.has("attachments")) {
      const selectedTools = [...overlay.querySelectorAll<HTMLInputElement>(".me-tool-cb")]
        .filter(cb => cb.checked).map(cb => cb.value);
      const mode = (overlay.querySelector<HTMLInputElement>("input[name='me-attach-mode']:checked")?.value) ?? "replace";
      if (mode === "replace") {
        patch.attachmentsNeed = selectedTools;
      } else if (mode === "add") {
        patch.attachmentsNeed = [...new Set([...(node.attachmentsNeed ?? []), ...selectedTools])];
      } else {
        patch.attachmentsNeed = (node.attachmentsNeed ?? []).filter(t => !selectedTools.includes(t));
      }
    }
    if (enabledFields.has("prefix")) {
      const v = (overlay.querySelector("#me-prefix") as HTMLInputElement).value.trim();
      if (v) patch.classname = v + node.classname;
    }
    if (enabledFields.has("suffix")) {
      const v = (overlay.querySelector("#me-suffix") as HTMLInputElement).value.trim();
      if (v) patch.classname = (patch.classname ?? node.classname) + v;
    }

    if (Object.keys(patch).length > 0) {
      store.updateNode(id, patch);
      changeCount++;
    }
  });

  showToast(`${changeCount} Node${changeCount !== 1 ? "s" : ""} aktualisiert`, "success");
}

function esc(s: string): string {
  return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

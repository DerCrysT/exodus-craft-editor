import { store } from "../../state/AppStore";
import { bus } from "../../state/EventEmitter";
import type { CraftNode, CraftEdge } from "../../types/index";
import { WORKBENCH_DEFS } from "../../data/workbenches";

export function initPropertiesPanel(): void {
  bus.on("state:change", () => renderPropertiesPanel());
  renderPropertiesPanel();
}

function renderPropertiesPanel(): void {
  const state = store.getState();
  const empty = document.getElementById("props-empty")!;
  const form = document.getElementById("props-form")!;

  if (state.selectedNodes.size === 1) {
    const id = [...state.selectedNodes][0];
    const node = store.getNode(id);
    if (node) {
      empty.style.display = "none";
      form.style.display = "";
      renderNodeForm(node, form);
      return;
    }
  }

  if (state.selectedEdge) {
    const edge = store.getEdge(state.selectedEdge);
    if (edge) {
      empty.style.display = "none";
      form.style.display = "";
      renderEdgeForm(edge, form);
      return;
    }
  }

  empty.style.display = "";
  form.style.display = "none";
  form.innerHTML = "";
}

function renderNodeForm(node: CraftNode, container: HTMLElement): void {
  const wbDef = WORKBENCH_DEFS.find(d => d.type === store.getState().activeWorkbench);
  const tools = wbDef?.tools ?? [];

  container.innerHTML = `
    <div style="padding:10px 12px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:8px;">
      <div style="flex:1;font-size:12px;font-weight:600;color:var(--text-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${node.displayName || node.classname}</div>
      <button class="btn btn-danger btn-sm btn-icon" id="pp-delete-node" title="Node löschen">🗑</button>
    </div>

    <div class="field-group">
      <label class="field-label">Classname</label>
      <input class="field-input" id="pp-classname" value="${esc(node.classname)}" />
    </div>
    <div class="field-group">
      <label class="field-label">Anzeigename</label>
      <input class="field-input" id="pp-displayname" value="${esc(node.displayName)}" />
    </div>
    <div class="field-group">
      <label class="field-label">Rezeptname</label>
      <input class="field-input" id="pp-recipename" value="${esc(node.recipeName ?? "")}" placeholder="z.B. Tuch-Gesichtsschutz" />
    </div>
    <div class="field-group">
      <label class="field-label">Craft Type</label>
      <select class="field-input" id="pp-crafttype">
        <option value="craft" ${node.craftType === "craft" ? "selected" : ""}>craft</option>
        <option value="disassemble" ${node.craftType === "disassemble" ? "selected" : ""}>disassemble</option>
        <option value="repair" ${node.craftType === "repair" ? "selected" : ""}>repair</option>
      </select>
    </div>
    <div class="field-group">
      <label class="field-label">Result Count</label>
      <input class="field-input" id="pp-resultcount" type="number" min="1" value="${node.resultCount ?? 1}" />
    </div>
    <div class="field-group">
      <label class="field-label">Components Affect Health</label>
      <select class="field-input" id="pp-healthaffect">
        <option value="0" ${(node.componentsDontAffectHealth ?? 0) === 0 ? "selected" : ""}>Ja (0)</option>
        <option value="1" ${(node.componentsDontAffectHealth ?? 0) === 1 ? "selected" : ""}>Nein (1)</option>
      </select>
    </div>
    <div class="field-group">
      <label class="field-label">Kategorie</label>
      <input class="field-input" id="pp-category" value="${esc(node.category ?? "")}" placeholder="z.B. Kleidung" />
    </div>

    <div class="panel-header" style="margin-top:4px;">Benötigte Tools</div>
    <div class="field-group" id="pp-attachments-group">
      ${tools.map(tool => `
        <label style="display:flex;align-items:center;gap:6px;padding:3px 0;font-size:12px;cursor:pointer;">
          <input type="checkbox" value="${tool.classname}"
            ${(node.attachmentsNeed ?? []).includes(tool.classname) ? "checked" : ""}
            class="pp-attachment-cb" />
          ${tool.label}
        </label>
      `).join("")}
      ${tools.length === 0 ? `<div style="font-size:11px;color:var(--text-muted);">Keine Tools für diese Werkbank</div>` : ""}
    </div>

    <div style="padding:10px 12px;">
      <button class="btn btn-primary" id="pp-apply" style="width:100%;">Übernehmen</button>
    </div>
  `;

  // Delete node
  container.querySelector("#pp-delete-node")!.addEventListener("click", () => {
    if (confirm(`Node "${node.displayName || node.classname}" löschen?`)) {
      store.removeNode(node.id);
    }
  });

  // Apply changes
  container.querySelector("#pp-apply")!.addEventListener("click", () => {
    const attachments = [...container.querySelectorAll<HTMLInputElement>(".pp-attachment-cb")]
      .filter(cb => cb.checked)
      .map(cb => cb.value);

    store.updateNode(node.id, {
      classname: (container.querySelector("#pp-classname") as HTMLInputElement).value.trim(),
      displayName: (container.querySelector("#pp-displayname") as HTMLInputElement).value.trim(),
      recipeName: (container.querySelector("#pp-recipename") as HTMLInputElement).value.trim(),
      craftType: (container.querySelector("#pp-crafttype") as HTMLSelectElement).value as CraftNode["craftType"],
      resultCount: Number((container.querySelector("#pp-resultcount") as HTMLInputElement).value),
      componentsDontAffectHealth: Number((container.querySelector("#pp-healthaffect") as HTMLSelectElement).value),
      category: (container.querySelector("#pp-category") as HTMLInputElement).value.trim(),
      attachmentsNeed: attachments,
    });
  });
}

function renderEdgeForm(edge: CraftEdge, container: HTMLElement): void {
  const srcNode = store.getNode(edge.sourceNodeId);
  const tgtNode = store.getNode(edge.targetNodeId);

  container.innerHTML = `
    <div style="padding:10px 12px;border-bottom:1px solid var(--border);">
      <div style="font-size:12px;font-weight:600;margin-bottom:4px;">Verbindung</div>
      <div style="font-size:11px;color:var(--text-muted);">
        ${srcNode?.displayName ?? srcNode?.classname ?? "?"} → ${tgtNode?.displayName ?? tgtNode?.classname ?? "?"}
      </div>
    </div>
    <div class="field-group">
      <label class="field-label">Menge (Amount)</label>
      <input class="field-input" id="pp-edge-amount" type="number" min="1" value="${edge.amount}" />
    </div>
    <div class="field-group">
      <label class="field-label">Destroy</label>
      <select class="field-input" id="pp-edge-destroy">
        <option value="true" ${edge.destroy ? "selected" : ""}>Ja</option>
        <option value="false" ${!edge.destroy ? "selected" : ""}>Nein</option>
      </select>
    </div>
    <div class="field-group">
      <label class="field-label">Change Health</label>
      <input class="field-input" id="pp-edge-health" type="number" step="0.1" value="${edge.changehealth}" />
    </div>
    <div style="padding:10px 12px;display:flex;gap:6px;">
      <button class="btn btn-primary" id="pp-edge-apply" style="flex:1">Übernehmen</button>
      <button class="btn btn-danger" id="pp-edge-delete">🗑</button>
    </div>
  `;

  container.querySelector("#pp-edge-apply")!.addEventListener("click", () => {
    store.updateEdge(edge.id, {
      amount: Number((container.querySelector("#pp-edge-amount") as HTMLInputElement).value),
      destroy: (container.querySelector("#pp-edge-destroy") as HTMLSelectElement).value === "true",
      changehealth: Number((container.querySelector("#pp-edge-health") as HTMLInputElement).value),
    });
  });

  container.querySelector("#pp-edge-delete")!.addEventListener("click", () => {
    store.removeEdge(edge.id);
  });
}

function esc(s: string): string {
  return s.replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

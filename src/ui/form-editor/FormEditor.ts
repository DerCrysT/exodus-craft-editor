import { store } from "../../state/AppStore";
import { bus } from "../../state/EventEmitter";
import type { CraftItem, CraftCategory, CraftComponent } from "../../types/index";
import { showToast } from "../toolbar/Toolbar";
import { WORKBENCH_DEFS } from "../../data/workbenches";

// updateJSON now emits json:formUpdate internally — no extra emit needed
function formUpdateJSON(patch: Parameters<typeof store.updateJSON>[0]): void {
  store.updateJSON(patch);
}

// ── State ──────────────────────────────────────────────────
let searchText = "";
let expandedItems = new Set<string>(); // key = "catIndex_itemIndex"
let selectedItems = new Set<string>();
let dragSrcCat: number | null = null;
let dragSrcItem: number | null = null;
let dragSrcType: "category" | "item" | null = null;

export function initFormEditor(): void {
  const root = document.getElementById("form-editor-root")!;
  root.innerHTML = `
    <div id="fe-toolbar" style="
      display:flex;align-items:center;gap:8px;padding:10px 16px;
      border-bottom:1px solid var(--border);background:var(--bg-surface);
      flex-shrink:0;flex-wrap:wrap;
    ">
      <input id="fe-search" class="field-input" placeholder="Suche Rezepte, Classnames…"
        style="width:220px;flex-shrink:0;" />
      <button class="btn btn-primary btn-sm" id="fe-add-category">+ Kategorie</button>
      <button class="btn btn-secondary btn-sm" id="fe-add-item">+ Rezept</button>
      <div style="flex:1"></div>
      <span id="fe-sel-count" style="font-size:11px;color:var(--text-muted);"></span>
      <button class="btn btn-secondary btn-sm" id="fe-bulk-delete" style="display:none;">🗑 Auswahl löschen</button>
      <button class="btn btn-secondary btn-sm" id="fe-expand-all">Alle aufklappen</button>
      <button class="btn btn-secondary btn-sm" id="fe-collapse-all">Alle einklappen</button>
    </div>
    <div id="fe-body" style="flex:1;overflow-y:auto;padding:12px 16px;"></div>
  `;

  root.style.flexDirection = "column";
  // display is controlled by updateModeButtons — don't set it here

  document.getElementById("fe-search")!.addEventListener("input", (e) => {
    searchText = (e.target as HTMLInputElement).value.toLowerCase();
    render();
  });

  document.getElementById("fe-add-category")!.addEventListener("click", addCategory);
  document.getElementById("fe-add-item")!.addEventListener("click", () => addItem(0));
  document.getElementById("fe-expand-all")!.addEventListener("click", () => { expandAll(); render(); });
  document.getElementById("fe-collapse-all")!.addEventListener("click", () => { expandedItems.clear(); render(); });
  document.getElementById("fe-bulk-delete")!.addEventListener("click", bulkDelete);

  bus.on("state:change", () => {
    // Don't re-render while user is typing in an input — would reset cursor
    const active = document.activeElement;
    const isTyping = active instanceof HTMLInputElement
      || active instanceof HTMLTextAreaElement
      || active instanceof HTMLSelectElement;
    if (isTyping && active.closest("#form-editor-root")) return;
    render();
  });
  bus.on("mode:change", (e) => {
    const ev = e as { payload: string };
    if (ev.payload === "form") render();
  });

  render();
}

// ── Render ──────────────────────────────────────────────────

function render(): void {
  const body = document.getElementById("fe-body");
  if (!body) return;
  const json = store.getJSON();

  // Update selection count
  const selCount = document.getElementById("fe-sel-count");
  const bulkBtn = document.getElementById("fe-bulk-delete");
  if (selCount) selCount.textContent = selectedItems.size > 0 ? `${selectedItems.size} ausgewählt` : "";
  if (bulkBtn) bulkBtn.style.display = selectedItems.size > 0 ? "" : "none";

  if (json.CraftCategories.length === 0) {
    body.innerHTML = `<div class="empty-state">
      <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
        <polyline points="14,2 14,8 20,8"/>
        <line x1="12" y1="18" x2="12" y2="12"/><line x1="9" y1="15" x2="15" y2="15"/>
      </svg>
      <p>Noch keine Kategorien.<br/>Klicke <strong>+ Kategorie</strong> um zu beginnen.</p>
    </div>`;
    return;
  }

  body.innerHTML = "";
  json.CraftCategories.forEach((cat, ci) => {
    const catEl = renderCategory(cat, ci);
    body.appendChild(catEl);
  });
}

function renderCategory(cat: CraftCategory, ci: number): HTMLElement {
  const filteredItems = searchText
    ? cat.CraftItems.filter(item =>
        item.RecipeName.toLowerCase().includes(searchText) ||
        item.Result.toLowerCase().includes(searchText) ||
        item.CraftComponents.some(c => c.Classname.toLowerCase().includes(searchText))
      )
    : cat.CraftItems;

  const wrapper = document.createElement("div");
  wrapper.style.cssText = "margin-bottom:12px;";
  wrapper.dataset.catIndex = String(ci);

  // Category header
  const header = document.createElement("div");
  header.style.cssText = `
    display:flex;align-items:center;gap:8px;padding:8px 12px;
    background:var(--bg-elevated);border:1px solid var(--border);
    border-radius:6px;cursor:pointer;user-select:none;
    margin-bottom:4px;
  `;
  header.draggable = true;

  const isExpanded = expandedItems.has(`cat_${ci}`);
  header.innerHTML = `
    <span style="color:var(--text-muted);font-size:14px;transition:transform 0.15s;
      transform:${isExpanded ? "rotate(90deg)" : "rotate(0deg)"}">▶</span>
    <span style="font-size:13px;font-weight:600;flex:1;" id="cat-name-${ci}">${cat.CategoryName || "Ohne Name"}</span>
    <span style="font-size:11px;color:var(--text-muted);">${filteredItems.length} Rezept${filteredItems.length !== 1 ? "e" : ""}</span>
    <button class="btn btn-ghost btn-sm btn-icon fe-edit-cat" data-ci="${ci}" title="Umbenennen">✎</button>
    <button class="btn btn-ghost btn-sm btn-icon fe-add-item-cat" data-ci="${ci}" title="Rezept hinzufügen">+</button>
    <button class="btn btn-danger btn-sm btn-icon fe-del-cat" data-ci="${ci}" title="Kategorie löschen">🗑</button>
  `;

  // Toggle expand
  header.addEventListener("click", (e) => {
    if ((e.target as HTMLElement).closest("button")) return;
    const key = `cat_${ci}`;
    if (expandedItems.has(key)) expandedItems.delete(key);
    else expandedItems.add(key);
    render();
  });

  // Category drag for reorder
  setupCategoryDrag(header, ci);

  wrapper.appendChild(header);

  // Buttons
  header.querySelector(".fe-edit-cat")!.addEventListener("click", (e) => {
    e.stopPropagation();
    renameCategoryInline(ci);
  });
  header.querySelector(".fe-add-item-cat")!.addEventListener("click", (e) => {
    e.stopPropagation();
    expandedItems.add(`cat_${ci}`);
    addItem(ci);
  });
  header.querySelector(".fe-del-cat")!.addEventListener("click", (e) => {
    e.stopPropagation();
    deleteCategory(ci);
  });

  // Items
  if (isExpanded) {
    const itemsContainer = document.createElement("div");
    itemsContainer.style.cssText = "padding-left:16px;display:flex;flex-direction:column;gap:4px;";
    itemsContainer.id = `cat-items-${ci}`;

    if (filteredItems.length === 0) {
      const empty = document.createElement("div");
      empty.style.cssText = "padding:8px 12px;font-size:11px;color:var(--text-muted);";
      empty.textContent = searchText ? "Keine Treffer in dieser Kategorie." : "Keine Rezepte. Klicke + um eines hinzuzufügen.";
      itemsContainer.appendChild(empty);
    } else {
      filteredItems.forEach((item, localIdx) => {
        const actualIdx = cat.CraftItems.indexOf(item);
        const itemEl = renderItem(item, ci, actualIdx);
        itemsContainer.appendChild(itemEl);
      });
    }

    // Drop zone at bottom
    const dropZone = document.createElement("div");
    dropZone.style.cssText = "height:6px;border-radius:3px;transition:background 0.1s;";
    dropZone.dataset.dropCat = String(ci);
    dropZone.dataset.dropItem = String(cat.CraftItems.length);
    setupItemDropZone(dropZone);
    itemsContainer.appendChild(dropZone);

    wrapper.appendChild(itemsContainer);
  }

  return wrapper;
}

function renderItem(item: CraftItem, ci: number, ii: number): HTMLElement {
  const key = `${ci}_${ii}`;
  const isExpanded = expandedItems.has(key);
  const isSelected = selectedItems.has(key);

  const card = document.createElement("div");
  card.className = "recipe-card" + (isSelected ? " selected" : "");
  card.dataset.catIndex = String(ci);
  card.dataset.itemIndex = String(ii);
  card.draggable = true;
  setupItemDrag(card, ci, ii);

  // Header
  const cardHeader = document.createElement("div");
  cardHeader.className = "recipe-card-header";
  cardHeader.innerHTML = `
    <input type="checkbox" class="fe-item-cb" data-key="${key}"
      ${isSelected ? "checked" : ""} style="flex-shrink:0;" />
    <span style="color:var(--text-muted);font-size:12px;transition:transform 0.15s;
      transform:${isExpanded ? "rotate(90deg)" : "rotate(0deg)"}">▶</span>
    <div style="flex:1;min-width:0;">
      <div class="recipe-card-title">${item.RecipeName || item.Result || "Unbenannt"}</div>
      <div class="recipe-card-meta">
        ${item.Result} → ×${item.ResultCount}
        &nbsp;·&nbsp; ${item.CraftComponents.length} Komp.
        &nbsp;·&nbsp; <span class="node-badge craft-type-${item.CraftType}">${item.CraftType}</span>
      </div>
    </div>
    <div style="display:flex;gap:4px;flex-shrink:0;">
      <button class="btn btn-ghost btn-sm btn-icon fe-copy-item" data-ci="${ci}" data-ii="${ii}" title="Kopieren">⎘</button>
      <button class="btn btn-ghost btn-sm btn-icon fe-move-up" data-ci="${ci}" data-ii="${ii}" title="Nach oben">↑</button>
      <button class="btn btn-ghost btn-sm btn-icon fe-move-down" data-ci="${ci}" data-ii="${ii}" title="Nach unten">↓</button>
      <button class="btn btn-danger btn-sm btn-icon fe-del-item" data-ci="${ci}" data-ii="${ii}" title="Löschen">🗑</button>
    </div>
  `;

  // Checkbox
  cardHeader.querySelector(".fe-item-cb")!.addEventListener("change", (e) => {
    e.stopPropagation();
    if ((e.target as HTMLInputElement).checked) selectedItems.add(key);
    else selectedItems.delete(key);
    render();
  });

  // Toggle expand
  cardHeader.addEventListener("click", (e) => {
    if ((e.target as HTMLElement).closest("button, input")) return;
    if (expandedItems.has(key)) expandedItems.delete(key);
    else expandedItems.add(key);
    render();
  });

  // Action buttons
  cardHeader.querySelector(".fe-copy-item")!.addEventListener("click", (e) => { e.stopPropagation(); copyItem(ci, ii); });
  cardHeader.querySelector(".fe-move-up")!.addEventListener("click", (e) => { e.stopPropagation(); moveItem(ci, ii, -1); });
  cardHeader.querySelector(".fe-move-down")!.addEventListener("click", (e) => { e.stopPropagation(); moveItem(ci, ii, 1); });
  cardHeader.querySelector(".fe-del-item")!.addEventListener("click", (e) => { e.stopPropagation(); deleteItem(ci, ii); });

  card.appendChild(cardHeader);

  // Body (expanded)
  if (isExpanded) {
    const body = renderItemBody(item, ci, ii);
    card.appendChild(body);
  }

  // Drop zone above item
  const dropZone = document.createElement("div");
  dropZone.style.cssText = "height:6px;border-radius:3px;transition:background 0.1s;";
  dropZone.dataset.dropCat = String(ci);
  dropZone.dataset.dropItem = String(ii);
  setupItemDropZone(dropZone);

  const wrapper = document.createElement("div");
  wrapper.appendChild(dropZone);
  wrapper.appendChild(card);
  return wrapper;
}

function renderItemBody(item: CraftItem, ci: number, ii: number): HTMLElement {
  const body = document.createElement("div");
  body.className = "recipe-card-body";

  const wbDef = WORKBENCH_DEFS.find(d => d.type === store.getState().activeWorkbench);
  const tools = wbDef?.tools ?? [];

  body.innerHTML = `
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px;">
      <div>
        <label class="field-label">Result Classname *</label>
        <input class="field-input fe-field" data-ci="${ci}" data-ii="${ii}" data-field="Result"
          value="${esc(item.Result)}" placeholder="z.B. Hammer" />
      </div>
      <div>
        <label class="field-label">Result Show</label>
        <input class="field-input fe-field" data-ci="${ci}" data-ii="${ii}" data-field="ResultShow"
          value="${esc(item.ResultShow)}" placeholder="Anzeigename" />
      </div>
      <div>
        <label class="field-label">Rezeptname</label>
        <input class="field-input fe-field" data-ci="${ci}" data-ii="${ii}" data-field="RecipeName"
          value="${esc(item.RecipeName)}" placeholder="z.B. Tuch-Gesichtsschutz" />
      </div>
      <div>
        <label class="field-label">Craft Type</label>
        <select class="field-input fe-field" data-ci="${ci}" data-ii="${ii}" data-field="CraftType">
          <option value="craft" ${item.CraftType === "craft" ? "selected" : ""}>craft</option>
          <option value="disassemble" ${item.CraftType === "disassemble" ? "selected" : ""}>disassemble</option>
          <option value="repair" ${item.CraftType === "repair" ? "selected" : ""}>repair</option>
        </select>
      </div>
      <div>
        <label class="field-label">Result Count</label>
        <input class="field-input fe-field" type="number" min="1" data-ci="${ci}" data-ii="${ii}" data-field="ResultCount"
          value="${item.ResultCount}" />
      </div>
      <div>
        <label class="field-label">Affect Health</label>
        <select class="field-input fe-field" data-ci="${ci}" data-ii="${ii}" data-field="ComponentsDontAffectHealth">
          <option value="0" ${item.ComponentsDontAffectHealth === 0 ? "selected" : ""}>Ja (0)</option>
          <option value="1" ${item.ComponentsDontAffectHealth === 1 ? "selected" : ""}>Nein (1)</option>
        </select>
      </div>
    </div>

    <!-- Components -->
    <div style="margin-bottom:10px;">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;">
        <label class="field-label" style="margin:0;">Komponenten</label>
        <button class="btn btn-secondary btn-sm fe-add-comp" data-ci="${ci}" data-ii="${ii}">+ Komponente</button>
      </div>
      <div id="comp-list-${ci}-${ii}">
        ${item.CraftComponents.map((comp, ki) => renderComponentRow(comp, ci, ii, ki)).join("")}
      </div>
    </div>

    <!-- Attachments -->
    <div style="margin-bottom:10px;">
      <label class="field-label">Benötigte Werkzeuge</label>
      <div style="display:flex;flex-wrap:wrap;gap:8px;">
        ${tools.map(tool => `
          <label style="display:flex;align-items:center;gap:4px;font-size:11px;cursor:pointer;">
            <input type="checkbox" class="fe-attach-cb" value="${tool.classname}"
              data-ci="${ci}" data-ii="${ii}"
              ${item.AttachmentsNeed.includes(tool.classname) ? "checked" : ""} />
            ${tool.label}
          </label>
        `).join("")}
        ${tools.length === 0 ? `<span style="font-size:11px;color:var(--text-muted);">Keine Tools für diese Werkbank</span>` : ""}
      </div>
    </div>

    <div style="display:flex;gap:6px;">
      <button class="btn btn-primary btn-sm fe-save-item" data-ci="${ci}" data-ii="${ii}">Speichern</button>
      <button class="btn btn-secondary btn-sm fe-move-cat" data-ci="${ci}" data-ii="${ii}">In andere Kategorie verschieben</button>
    </div>
  `;

  // Field change handlers
  body.querySelectorAll<HTMLInputElement | HTMLSelectElement>(".fe-field").forEach(input => {
    input.addEventListener("change", () => {
      applyFieldChange(
        Number(input.dataset.ci),
        Number(input.dataset.ii),
        input.dataset.field!,
        input.value
      );
    });
  });

  // Add component
  body.querySelector(".fe-add-comp")!.addEventListener("click", () => {
    addComponent(ci, ii);
  });

  // Save button
  body.querySelector(".fe-save-item")!.addEventListener("click", () => {
    // Gather all attachment checkboxes
    const attachments = [...body.querySelectorAll<HTMLInputElement>(".fe-attach-cb")]
      .filter(cb => cb.checked).map(cb => cb.value);
    applyFieldChange(ci, ii, "AttachmentsNeed", attachments as unknown as string);
    showToast("Rezept gespeichert", "success");
  });

  // Move to other category
  body.querySelector(".fe-move-cat")!.addEventListener("click", () => {
    moveToCategoryDialog(ci, ii);
  });

  // Component remove buttons (event delegation)
  body.querySelector(`#comp-list-${ci}-${ii}`)!.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>(".fe-del-comp");
    if (btn) {
      removeComponent(ci, ii, Number(btn.dataset.ki));
    }
  });

  // Component field changes
  body.querySelector(`#comp-list-${ci}-${ii}`)!.addEventListener("change", (e) => {
    const input = (e.target as HTMLElement).closest<HTMLInputElement>(".fe-comp-field");
    if (input) {
      const val = input.type === "checkbox" ? String(input.checked) : input.value;
      applyComponentField(ci, ii, Number(input.dataset.ki), input.dataset.field!, val);
    }
  });

  return body;
}

function renderComponentRow(comp: CraftComponent, ci: number, ii: number, ki: number): string {
  return `
    <div class="component-row" style="gap:6px;margin-bottom:4px;">
      <input class="field-input fe-comp-field" style="flex:2;" placeholder="Classname"
        value="${esc(comp.Classname)}" data-ci="${ci}" data-ii="${ii}" data-ki="${ki}" data-field="Classname" />
      <input class="field-input fe-comp-field" type="number" min="1" style="width:60px;flex:0 0 60px;"
        value="${comp.Amount}" data-ci="${ci}" data-ii="${ii}" data-ki="${ki}" data-field="Amount" />
      <label style="display:flex;align-items:center;gap:3px;font-size:11px;white-space:nowrap;flex-shrink:0;">
        <input type="checkbox" class="fe-comp-field" data-ci="${ci}" data-ii="${ii}" data-ki="${ki}" data-field="Destroy"
          ${comp.Destroy ? "checked" : ""} /> Destroy
      </label>
      <input class="field-input fe-comp-field" type="number" step="0.1" style="width:60px;flex:0 0 60px;"
        value="${comp.Changehealth}" data-ci="${ci}" data-ii="${ii}" data-ki="${ki}" data-field="Changehealth"
        title="Changehealth" />
      <button class="btn btn-danger btn-sm btn-icon fe-del-comp" data-ki="${ki}" title="Entfernen">×</button>
    </div>
  `;
}

// ── Data Mutations ─────────────────────────────────────────

function applyFieldChange(ci: number, ii: number, field: string, value: string | string[]): void {
  const json = JSON.parse(JSON.stringify(store.getJSON()));
  const item = json.CraftCategories[ci]?.CraftItems[ii];
  if (!item) return;

  switch (field) {
    case "ResultCount": item.ResultCount = Number(value); break;
    case "ComponentsDontAffectHealth": item.ComponentsDontAffectHealth = Number(value); break;
    case "AttachmentsNeed": item.AttachmentsNeed = value as unknown as string[]; break;
    default: (item as Record<string, unknown>)[field] = value;
  }

  formUpdateJSON({ CraftCategories: json.CraftCategories });
}

function applyComponentField(ci: number, ii: number, ki: number, field: string, value: string): void {
  const json = JSON.parse(JSON.stringify(store.getJSON()));
  const comp = json.CraftCategories[ci]?.CraftItems[ii]?.CraftComponents[ki];
  if (!comp) return;

  switch (field) {
    case "Amount": comp.Amount = Number(value); break;
    case "Destroy": comp.Destroy = value === "true"; break;
    case "Changehealth": comp.Changehealth = Number(value); break;
    default: comp[field] = value;
  }
  formUpdateJSON({ CraftCategories: json.CraftCategories });
}

function addCategory(): void {
  const name = prompt("Kategoriename:");
  if (!name?.trim()) return;
  const json = JSON.parse(JSON.stringify(store.getJSON()));
  const ci = json.CraftCategories.length;
  json.CraftCategories.push({ CategoryName: name.trim(), CraftItems: [] });
  formUpdateJSON({ CraftCategories: json.CraftCategories });
  expandedItems.add(`cat_${ci}`);
  showToast("Kategorie erstellt", "success");
}

function renameCategoryInline(ci: number): void {
  const json = store.getJSON();
  const current = json.CraftCategories[ci]?.CategoryName ?? "";
  const name = prompt("Neuer Name:", current);
  if (!name?.trim() || name.trim() === current) return;
  const newJson = JSON.parse(JSON.stringify(json));
  newJson.CraftCategories[ci].CategoryName = name.trim();
  formUpdateJSON({ CraftCategories: newJson.CraftCategories });
}

function deleteCategory(ci: number): void {
  const json = store.getJSON();
  const cat = json.CraftCategories[ci];
  if (!confirm(`Kategorie "${cat?.CategoryName}" und alle ${cat?.CraftItems.length} Rezepte löschen?`)) return;
  const newJson = JSON.parse(JSON.stringify(json));
  newJson.CraftCategories.splice(ci, 1);
  formUpdateJSON({ CraftCategories: newJson.CraftCategories });
  showToast("Kategorie gelöscht", "success");
}

function addItem(ci: number): void {
  const json = JSON.parse(JSON.stringify(store.getJSON()));
  if (!json.CraftCategories[ci]) return;
  const ii = json.CraftCategories[ci].CraftItems.length;
  json.CraftCategories[ci].CraftItems.push({
    Result: "",
    ResultShow: "",
    ResultCount: 1,
    ComponentsDontAffectHealth: 0,
    CraftType: "craft",
    RecipeName: "Neues Rezept",
    CraftComponents: [],
    AttachmentsNeed: store.getWorkbenchTools(),
  });
  formUpdateJSON({ CraftCategories: json.CraftCategories });
  expandedItems.add(`${ci}_${ii}`);
  showToast("Rezept hinzugefügt", "success");
}

function deleteItem(ci: number, ii: number): void {
  const json = store.getJSON();
  const item = json.CraftCategories[ci]?.CraftItems[ii];
  if (!confirm(`Rezept "${item?.RecipeName || item?.Result}" löschen?`)) return;
  const newJson = JSON.parse(JSON.stringify(json));
  newJson.CraftCategories[ci].CraftItems.splice(ii, 1);
  formUpdateJSON({ CraftCategories: newJson.CraftCategories });
  showToast("Rezept gelöscht", "success");
}

function copyItem(ci: number, ii: number): void {
  const json = JSON.parse(JSON.stringify(store.getJSON()));
  const item = json.CraftCategories[ci]?.CraftItems[ii];
  if (!item) return;
  const copy = JSON.parse(JSON.stringify(item));
  copy.RecipeName = `${copy.RecipeName} (Kopie)`;
  json.CraftCategories[ci].CraftItems.splice(ii + 1, 0, copy);
  formUpdateJSON({ CraftCategories: json.CraftCategories });
  showToast("Rezept kopiert", "success");
}

function moveItem(ci: number, ii: number, dir: -1 | 1): void {
  const json = JSON.parse(JSON.stringify(store.getJSON()));
  const items = json.CraftCategories[ci]?.CraftItems;
  if (!items) return;
  const newIdx = ii + dir;
  if (newIdx < 0 || newIdx >= items.length) return;
  [items[ii], items[newIdx]] = [items[newIdx], items[ii]];
  formUpdateJSON({ CraftCategories: json.CraftCategories });
}

function addComponent(ci: number, ii: number): void {
  const json = JSON.parse(JSON.stringify(store.getJSON()));
  json.CraftCategories[ci]?.CraftItems[ii]?.CraftComponents.push({
    Classname: "",
    Amount: 1,
    Destroy: true,
    Changehealth: 0,
  });
  formUpdateJSON({ CraftCategories: json.CraftCategories });
}

function removeComponent(ci: number, ii: number, ki: number): void {
  const json = JSON.parse(JSON.stringify(store.getJSON()));
  json.CraftCategories[ci]?.CraftItems[ii]?.CraftComponents.splice(ki, 1);
  formUpdateJSON({ CraftCategories: json.CraftCategories });
}

function moveToCategoryDialog(ci: number, ii: number): void {
  const json = store.getJSON();
  const categories = json.CraftCategories.map((c, i) => `${i}: ${c.CategoryName}`).join("\n");
  const input = prompt(`In welche Kategorie verschieben?\n${categories}\n\nIndex eingeben:`);
  if (input === null) return;
  const targetCi = Number(input);
  if (isNaN(targetCi) || targetCi === ci || !json.CraftCategories[targetCi]) {
    showToast("Ungültige Kategorie", "error");
    return;
  }
  const newJson = JSON.parse(JSON.stringify(json));
  const [item] = newJson.CraftCategories[ci].CraftItems.splice(ii, 1);
  newJson.CraftCategories[targetCi].CraftItems.push(item);
  formUpdateJSON({ CraftCategories: newJson.CraftCategories });
  showToast(`Verschoben nach "${json.CraftCategories[targetCi].CategoryName}"`, "success");
}

function bulkDelete(): void {
  if (!confirm(`${selectedItems.size} Rezepte löschen?`)) return;
  const json = JSON.parse(JSON.stringify(store.getJSON()));
  // Sort descending to splice from end
  const pairs = [...selectedItems]
    .map(k => k.split("_").map(Number))
    .sort((a, b) => b[0] - a[0] || b[1] - a[1]);
  pairs.forEach(([ci, ii]) => {
    json.CraftCategories[ci]?.CraftItems.splice(ii, 1);
  });
  selectedItems.clear();
  formUpdateJSON({ CraftCategories: json.CraftCategories });
  showToast("Gelöscht", "success");
}

function expandAll(): void {
  const json = store.getJSON();
  json.CraftCategories.forEach((cat, ci) => {
    expandedItems.add(`cat_${ci}`);
    cat.CraftItems.forEach((_, ii) => expandedItems.add(`${ci}_${ii}`));
  });
}

// ── Drag & Drop (item reorder) ─────────────────────────────

function setupItemDrag(el: HTMLElement, ci: number, ii: number): void {
  el.addEventListener("dragstart", (e) => {
    dragSrcCat = ci; dragSrcItem = ii; dragSrcType = "item";
    e.dataTransfer!.effectAllowed = "move";
  });
  el.addEventListener("dragend", () => {
    dragSrcCat = null; dragSrcItem = null; dragSrcType = null;
    document.querySelectorAll<HTMLElement>("[data-drop-item]").forEach(z => {
      z.style.background = "";
    });
  });
}

function setupCategoryDrag(el: HTMLElement, ci: number): void {
  el.addEventListener("dragstart", (e) => {
    dragSrcCat = ci; dragSrcItem = null; dragSrcType = "category";
    e.dataTransfer!.effectAllowed = "move";
  });
}

function setupItemDropZone(zone: HTMLElement): void {
  zone.addEventListener("dragover", (e) => {
    e.preventDefault();
    zone.style.background = "var(--accent)";
  });
  zone.addEventListener("dragleave", () => { zone.style.background = ""; });
  zone.addEventListener("drop", (e) => {
    e.preventDefault();
    zone.style.background = "";
    const tgtCat = Number(zone.dataset.dropCat);
    const tgtItem = Number(zone.dataset.dropItem);

    if (dragSrcType === "item" && dragSrcCat !== null && dragSrcItem !== null) {
      reorderItem(dragSrcCat, dragSrcItem, tgtCat, tgtItem);
    }
  });
}

function reorderItem(srcCat: number, srcItem: number, tgtCat: number, tgtItem: number): void {
  if (srcCat === tgtCat && srcItem === tgtItem) return;
  const json = JSON.parse(JSON.stringify(store.getJSON()));
  const srcItems = json.CraftCategories[srcCat]?.CraftItems;
  const tgtItems = json.CraftCategories[tgtCat]?.CraftItems;
  if (!srcItems || !tgtItems) return;

  const [item] = srcItems.splice(srcItem, 1);
  // Adjust target index if same array and we removed before target
  const adjustedTgt = srcCat === tgtCat && tgtItem > srcItem ? tgtItem - 1 : tgtItem;
  tgtItems.splice(adjustedTgt, 0, item);
  formUpdateJSON({ CraftCategories: json.CraftCategories });
}

// ── Utils ──────────────────────────────────────────────────

function esc(s: string): string {
  return s.replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

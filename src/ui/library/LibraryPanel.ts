import { store } from "../../state/AppStore";
import { bus } from "../../state/EventEmitter";
import type { LibraryItem } from "../../types/index";
import { showToast } from "../toolbar/Toolbar";
import { readFileAsDataURL } from "../../data/jsonHandler";

let filterText = "";

export function initLibraryPanel(): void {
  const searchInput = document.getElementById("lib-search") as HTMLInputElement;
  searchInput.addEventListener("input", () => {
    filterText = searchInput.value.toLowerCase();
    renderLibrary();
  });

  document.getElementById("lib-add-btn")!.addEventListener("click", () => {
    openAddItemModal();
  });

  bus.on("state:change", () => renderLibrary());

  // Seed only if nothing in localStorage — do NOT seed here, seed after loadFromStorage in main.ts
  renderLibrary();
}

function renderLibrary(): void {
  const list = document.getElementById("lib-list")!;
  const items = store.getLibrary().filter(item => {
    if (!filterText) return true;
    return (
      item.classname.toLowerCase().includes(filterText) ||
      item.displayName.toLowerCase().includes(filterText) ||
      (item.category ?? "").toLowerCase().includes(filterText)
    );
  });

  if (items.length === 0) {
    list.innerHTML = `<div class="empty-state" style="padding-top:32px">
      <p>Keine Items gefunden</p>
      <button class="btn btn-secondary btn-sm" onclick="document.getElementById('lib-add-btn').click()">+ Hinzufügen</button>
    </div>`;
    return;
  }

  // Group by category
  const byCategory = new Map<string, LibraryItem[]>();
  items.forEach(item => {
    const cat = item.category ?? "Ohne Kategorie";
    if (!byCategory.has(cat)) byCategory.set(cat, []);
    byCategory.get(cat)!.push(item);
  });

  list.innerHTML = "";
  byCategory.forEach((catItems, catName) => {
    const header = document.createElement("div");
    header.style.cssText = "padding:6px 12px 3px;font-size:10px;text-transform:uppercase;letter-spacing:0.06em;color:var(--text-muted);border-bottom:1px solid var(--border);";
    header.textContent = catName;
    list.appendChild(header);

    catItems.forEach(item => {
      const el = createLibraryItemEl(item);
      list.appendChild(el);
    });
  });
}

function createLibraryItemEl(item: LibraryItem): HTMLElement {
  const div = document.createElement("div");
  div.className = "lib-item";
  div.draggable = true;

  const thumb = item.imageUrl
    ? `<img src="${item.imageUrl}" class="lib-thumb" alt="${item.displayName}" />`
    : `<div class="lib-thumb" style="display:flex;align-items:center;justify-content:center;color:var(--text-muted);font-size:12px;">📦</div>`;

  div.innerHTML = `
    ${thumb}
    <div style="flex:1;min-width:0;">
      <div class="lib-name">${item.displayName}</div>
      <div class="lib-classname">${item.classname}</div>
    </div>
    <button class="btn btn-ghost btn-icon btn-sm lib-edit-btn" title="Bearbeiten" style="flex-shrink:0;opacity:0.5;">✎</button>
  `;

  div.querySelector(".lib-edit-btn")!.addEventListener("click", (e) => {
    e.stopPropagation();
    openEditItemModal(item);
  });

  // Drag: set data for node editor drop
  div.addEventListener("dragstart", (e) => {
    e.dataTransfer!.setData("application/exodus-classname", item.classname);
    e.dataTransfer!.effectAllowed = "copy";
    // Create ghost
    const ghost = document.createElement("div");
    ghost.className = "drag-ghost";
    ghost.textContent = item.classname;
    ghost.id = "lib-drag-ghost";
    document.body.appendChild(ghost);
    e.dataTransfer!.setDragImage(ghost, 0, 0);
  });

  div.addEventListener("dragend", () => {
    document.getElementById("lib-drag-ghost")?.remove();
  });

  return div;
}

// ── Modals ─────────────────────────────────────────────────

function openAddItemModal(): void {
  openItemModal(null);
}

function openEditItemModal(item: LibraryItem): void {
  openItemModal(item);
}

function openItemModal(existing: LibraryItem | null): void {
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";

  let previewUrl = existing?.imageUrl ?? "";

  overlay.innerHTML = `
    <div class="modal">
      <div class="modal-header">
        <span>${existing ? "Item bearbeiten" : "Neues Item"}</span>
        <button class="btn btn-ghost btn-icon close-btn">✕</button>
      </div>
      <div class="modal-body" style="display:flex;flex-direction:column;gap:12px;">
        <div class="field-group" style="padding:0">
          <label class="field-label">Classname *</label>
          <input class="field-input" id="modal-classname" value="${existing?.classname ?? ""}" placeholder="z.B. Rag" />
        </div>
        <div class="field-group" style="padding:0">
          <label class="field-label">Anzeigename *</label>
          <input class="field-input" id="modal-displayname" value="${existing?.displayName ?? ""}" placeholder="z.B. Lappen" />
        </div>
        <div class="field-group" style="padding:0">
          <label class="field-label">Kategorie</label>
          <input class="field-input" id="modal-category" value="${existing?.category ?? ""}" placeholder="z.B. Material" />
        </div>
        <div class="field-group" style="padding:0">
          <label class="field-label">Tags (kommagetrennt)</label>
          <input class="field-input" id="modal-tags" value="${(existing?.tags ?? []).join(", ")}" placeholder="Stoff, Verband, ..." />
        </div>
        <div class="field-group" style="padding:0">
          <label class="field-label">Bild</label>
          <div style="display:flex;gap:8px;align-items:center;">
            <div id="modal-thumb" style="width:40px;height:40px;border-radius:4px;background:var(--bg-elevated);border:1px solid var(--border);display:flex;align-items:center;justify-content:center;font-size:20px;overflow:hidden;">
              ${previewUrl ? `<img src="${previewUrl}" style="width:100%;height:100%;object-fit:contain;" />` : "📦"}
            </div>
            <button class="btn btn-secondary btn-sm" id="modal-upload-btn">Bild hochladen</button>
            ${previewUrl ? `<button class="btn btn-ghost btn-sm" id="modal-clear-img">✕ Entfernen</button>` : ""}
          </div>
          <input type="file" id="modal-img-input" accept="image/*" style="display:none" />
        </div>
      </div>
      <div class="modal-footer">
        ${existing ? `<button class="btn btn-danger btn-sm" id="modal-delete">Löschen</button>` : ""}
        <button class="btn btn-secondary" id="modal-cancel">Abbrechen</button>
        <button class="btn btn-primary" id="modal-save">Speichern</button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  const closeModal = () => overlay.remove();

  overlay.querySelector(".close-btn")!.addEventListener("click", closeModal);
  overlay.querySelector("#modal-cancel")!.addEventListener("click", closeModal);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) closeModal(); });

  // Image upload
  const imgInput = overlay.querySelector("#modal-img-input") as HTMLInputElement;
  overlay.querySelector("#modal-upload-btn")!.addEventListener("click", () => imgInput.click());
  imgInput.addEventListener("change", async () => {
    const file = imgInput.files?.[0];
    if (!file) return;
    previewUrl = await readFileAsDataURL(file);
    const thumb = overlay.querySelector("#modal-thumb") as HTMLElement;
    thumb.innerHTML = `<img src="${previewUrl}" style="width:100%;height:100%;object-fit:contain;" />`;
  });

  overlay.querySelector("#modal-clear-img")?.addEventListener("click", () => {
    previewUrl = "";
    const thumb = overlay.querySelector("#modal-thumb") as HTMLElement;
    thumb.innerHTML = "📦";
  });

  // Delete
  overlay.querySelector("#modal-delete")?.addEventListener("click", () => {
    if (!existing) return;
    const lib = store.getLibrary().filter(i => i.classname !== existing.classname);
    store.setLibrary(lib);
    showToast("Item gelöscht", "success");
    closeModal();
  });

  // Save
  overlay.querySelector("#modal-save")!.addEventListener("click", () => {
    const classname = (overlay.querySelector("#modal-classname") as HTMLInputElement).value.trim();
    const displayName = (overlay.querySelector("#modal-displayname") as HTMLInputElement).value.trim();
    const category = (overlay.querySelector("#modal-category") as HTMLInputElement).value.trim();
    const tagsRaw = (overlay.querySelector("#modal-tags") as HTMLInputElement).value.trim();

    if (!classname || !displayName) {
      showToast("Classname und Anzeigename sind Pflichtfelder", "error");
      return;
    }

    const item: LibraryItem = {
      classname,
      displayName,
      category: category || undefined,
      imageUrl: previewUrl || undefined,
      tags: tagsRaw ? tagsRaw.split(",").map(t => t.trim()).filter(Boolean) : undefined,
    };

    store.addLibraryItem(item);
    showToast(existing ? "Item aktualisiert" : "Item hinzugefügt", "success");
    closeModal();
  });
}

// ── Default seed data ───────────────────────────────────────

export function seedLibraryDefaults(): void {
  const defaults: LibraryItem[] = [
    { classname: "Rag", displayName: "Lappen", category: "Material" },
    { classname: "Rope", displayName: "Seil", category: "Material" },
    { classname: "Hammer", displayName: "Hammer", category: "Werkzeug" },
    { classname: "Bandage", displayName: "Verband", category: "Medizin" },
    { classname: "PlasticBottle", displayName: "Plastikflasche", category: "Behälter" },
    { classname: "Alcohol", displayName: "Alkohol", category: "Flüssigkeit" },
    { classname: "IronOre", displayName: "Eisenerz", category: "Ressource" },
    { classname: "WoodPlanks", displayName: "Holzbrettern", category: "Material" },
    { classname: "Nails", displayName: "Nägel", category: "Material" },
    { classname: "WireCoil", displayName: "Drahtrolle", category: "Material" },
  ];
  store.setLibrary(defaults);
}

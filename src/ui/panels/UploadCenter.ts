import { store } from "../../state/AppStore";
import type { LibraryItem } from "../../types/index";
import { showToast } from "../toolbar/Toolbar";
import { readFileAsDataURL } from "../../data/jsonHandler";

// ── Pending uploads (staged before committing) ─────────────
interface PendingUpload {
  id: string;
  file: File;
  dataUrl: string;
  classname: string;
  displayName: string;
  category: string;
  status: "pending" | "assigned" | "duplicate";
}

export function openUploadCenter(): void {
  const pending: PendingUpload[] = [];

  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.style.alignItems = "flex-start";
  overlay.style.paddingTop = "24px";

  overlay.innerHTML = `
    <div class="modal" style="width:90vw;max-width:1000px;height:85vh;display:flex;flex-direction:column;">
      <div class="modal-header">
        <span>⬆ Upload Center</span>
        <button class="btn btn-ghost btn-icon" id="uc-close">✕</button>
      </div>

      <div style="display:grid;grid-template-columns:1fr 1fr;flex:1;overflow:hidden;gap:0;">

        <!-- LEFT: Drop zone + file list -->
        <div style="display:flex;flex-direction:column;border-right:1px solid var(--border);overflow:hidden;">
          <div id="uc-dropzone" style="
            margin:12px;border:2px dashed var(--border);border-radius:8px;
            display:flex;flex-direction:column;align-items:center;justify-content:center;
            padding:24px;gap:8px;cursor:pointer;transition:border-color 0.15s,background 0.15s;
            flex-shrink:0;
          ">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" stroke-width="1.5">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
              <polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>
            </svg>
            <div style="font-size:13px;font-weight:600;color:var(--text-primary);">Bilder hier ablegen</div>
            <div style="font-size:11px;color:var(--text-muted);">PNG, JPG, WEBP — oder klicken zum Auswählen</div>
            <button class="btn btn-secondary btn-sm" id="uc-browse">Dateien auswählen</button>
            <input type="file" id="uc-file-input" multiple accept="image/*" style="display:none" />
          </div>

          <div style="padding:0 12px 6px;display:flex;align-items:center;justify-content:space-between;">
            <span style="font-size:11px;color:var(--text-muted);" id="uc-count">0 Bilder</span>
            <div style="display:flex;gap:6px;">
              <button class="btn btn-ghost btn-sm" id="uc-auto-assign">⚡ Auto-Assign</button>
              <button class="btn btn-ghost btn-sm" id="uc-clear-all">Alle entfernen</button>
            </div>
          </div>

          <div id="uc-file-list" style="flex:1;overflow-y:auto;padding:0 12px 12px;display:flex;flex-direction:column;gap:4px;">
            <div class="empty-state" style="padding-top:20px;">
              <p>Noch keine Bilder hinzugefügt</p>
            </div>
          </div>
        </div>

        <!-- RIGHT: Assignment form for selected item -->
        <div style="display:flex;flex-direction:column;overflow:hidden;">
          <div style="padding:12px;border-bottom:1px solid var(--border);font-size:11px;font-weight:600;
            text-transform:uppercase;letter-spacing:0.06em;color:var(--text-muted);">
            Zuweisung
          </div>
          <div id="uc-assign-panel" style="flex:1;overflow-y:auto;padding:12px;display:flex;flex-direction:column;gap:10px;">
            <div class="empty-state" id="uc-assign-empty">
              <p>Bild auswählen um<br/>Classname zuzuweisen</p>
            </div>
            <div id="uc-assign-form" style="display:none;flex-direction:column;gap:10px;">
              <div style="display:flex;justify-content:center;margin-bottom:4px;">
                <img id="uc-preview-img" style="max-width:120px;max-height:120px;border-radius:6px;
                  border:1px solid var(--border);object-fit:contain;background:var(--bg-elevated);" />
              </div>
              <div>
                <label class="field-label">Classname *</label>
                <input class="field-input" id="uc-classname" placeholder="z.B. Exodus_GasMask_Filter"
                  list="uc-classname-list" />
                <datalist id="uc-classname-list"></datalist>
              </div>
              <div>
                <label class="field-label">Anzeigename</label>
                <input class="field-input" id="uc-displayname" placeholder="Wird aus Library übernommen" />
              </div>
              <div>
                <label class="field-label">Kategorie</label>
                <input class="field-input" id="uc-category" placeholder="z.B. Ausrüstung"
                  list="uc-cat-list" />
                <datalist id="uc-cat-list">
                  ${store.getLibrary().map(i => i.category).filter((v,i,a) => v && a.indexOf(v)===i)
                    .map(c => `<option value="${esc(c!)}">`)
                    .join("")}
                </datalist>
              </div>
              <div style="display:flex;gap:6px;">
                <button class="btn btn-primary" id="uc-assign-btn" style="flex:1;">Zuweisen</button>
                <button class="btn btn-secondary" id="uc-skip-btn">Überspringen</button>
              </div>
              <div id="uc-assign-status" style="font-size:11px;color:var(--success);display:none;">✓ Zugewiesen</div>
            </div>
          </div>

          <!-- Bulk operations -->
          <div style="padding:12px;border-top:1px solid var(--border);display:flex;flex-direction:column;gap:8px;">
            <div style="font-size:11px;font-weight:600;text-transform:uppercase;
              letter-spacing:0.06em;color:var(--text-muted);margin-bottom:2px;">Bulk Import</div>
            <div style="font-size:11px;color:var(--text-muted);">
              Dateinamen werden automatisch als Classnames verwendet.
            </div>
            <button class="btn btn-secondary btn-sm" id="uc-bulk-from-filenames">
              📋 Classnames aus Dateinamen
            </button>
            <button class="btn btn-secondary btn-sm" id="uc-import-csv">
              📄 Classname-Liste importieren (CSV/TXT)
            </button>
            <input type="file" id="uc-csv-input" accept=".csv,.txt" style="display:none" />
          </div>
        </div>
      </div>

      <div class="modal-footer" style="justify-content:space-between;">
        <div style="font-size:11px;color:var(--text-muted);" id="uc-stats">
          0 bereit · 0 zugewiesen
        </div>
        <div style="display:flex;gap:8px;">
          <button class="btn btn-secondary" id="uc-cancel">Abbrechen</button>
          <button class="btn btn-primary" id="uc-commit">In Library speichern</button>
        </div>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  // ── Refs ──────────────────────────────────────────────────
  const dropzone      = overlay.querySelector("#uc-dropzone")       as HTMLElement;
  const fileInput     = overlay.querySelector("#uc-file-input")     as HTMLInputElement;
  const fileList      = overlay.querySelector("#uc-file-list")      as HTMLElement;
  const assignEmpty   = overlay.querySelector("#uc-assign-empty")   as HTMLElement;
  const assignForm    = overlay.querySelector("#uc-assign-form")    as HTMLElement;
  const previewImg    = overlay.querySelector("#uc-preview-img")    as HTMLImageElement;
  const classnameIn   = overlay.querySelector("#uc-classname")      as HTMLInputElement;
  const displayNameIn = overlay.querySelector("#uc-displayname")    as HTMLInputElement;
  const categoryIn    = overlay.querySelector("#uc-category")       as HTMLInputElement;
  const assignStatus  = overlay.querySelector("#uc-assign-status")  as HTMLElement;
  const classnameList = overlay.querySelector("#uc-classname-list") as HTMLDataListElement;

  let selectedId: string | null = null;

  // Populate classname datalist from library + existing nodes
  const allClassnames = [
    ...store.getLibrary().map(i => i.classname),
    ...store.getNodes().map(n => n.classname),
  ].filter((v, i, a) => a.indexOf(v) === i);
  allClassnames.forEach(cn => {
    const opt = document.createElement("option");
    opt.value = cn; classnameList.appendChild(opt);
  });

  const close = () => overlay.remove();
  overlay.querySelector("#uc-close")!  .addEventListener("click", close);
  overlay.querySelector("#uc-cancel")! .addEventListener("click", close);
  overlay.addEventListener("click", e => { if (e.target === overlay) close(); });

  // ── File input / drop ────────────────────────────────────
  overlay.querySelector("#uc-browse")!.addEventListener("click", () => fileInput.click());
  dropzone.addEventListener("click", e => {
    if ((e.target as HTMLElement).tagName !== "BUTTON") fileInput.click();
  });

  fileInput.addEventListener("change", () => {
    if (fileInput.files) addFiles(Array.from(fileInput.files));
    fileInput.value = "";
  });

  dropzone.addEventListener("dragover", e => {
    e.preventDefault();
    dropzone.style.borderColor  = "var(--accent)";
    dropzone.style.background   = "var(--accent-dim)";
  });
  dropzone.addEventListener("dragleave", () => {
    dropzone.style.borderColor  = "";
    dropzone.style.background   = "";
  });
  dropzone.addEventListener("drop", e => {
    e.preventDefault();
    dropzone.style.borderColor  = "";
    dropzone.style.background   = "";
    const files = Array.from(e.dataTransfer?.files ?? []).filter(f => f.type.startsWith("image/"));
    addFiles(files);
  });

  // ── Add files ────────────────────────────────────────────
  async function addFiles(files: File[]): Promise<void> {
    for (const file of files) {
      const dataUrl = await readFileAsDataURL(file);
      const id = `upload_${Date.now()}_${Math.random().toString(36).slice(2,5)}`;
      const baseName = file.name.replace(/\.[^.]+$/, "");
      const libMatch = store.getLibrary().find(i =>
        i.classname.toLowerCase() === baseName.toLowerCase()
      );
      pending.push({
        id, file, dataUrl,
        classname:   libMatch?.classname   ?? baseName,
        displayName: libMatch?.displayName ?? baseName,
        category:    libMatch?.category    ?? "",
        status: libMatch ? "assigned" : "pending",
      });
    }
    renderFileList();
    updateStats();
  }

  // ── Render file list ─────────────────────────────────────
  function renderFileList(): void {
    if (pending.length === 0) {
      fileList.innerHTML = `<div class="empty-state" style="padding-top:20px;"><p>Noch keine Bilder hinzugefügt</p></div>`;
      overlay.querySelector<HTMLElement>("#uc-count")!.textContent = "0 Bilder";
      return;
    }

    overlay.querySelector<HTMLElement>("#uc-count")!.textContent =
      `${pending.length} Bild${pending.length !== 1 ? "er" : ""}`;

    fileList.innerHTML = "";
    pending.forEach(item => {
      const isSelected = item.id === selectedId;
      const statusColor = item.status === "assigned" ? "var(--success)"
        : item.status === "duplicate" ? "var(--warning)" : "var(--text-muted)";
      const statusIcon  = item.status === "assigned" ? "✓"
        : item.status === "duplicate" ? "⚠" : "○";

      const el = document.createElement("div");
      el.style.cssText = `
        display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:5px;
        cursor:pointer;border:1px solid ${isSelected ? "var(--accent)" : "transparent"};
        background:${isSelected ? "var(--accent-dim)" : "transparent"};
        transition:background 0.1s;
      `;
      el.innerHTML = `
        <img src="${item.dataUrl}" style="width:32px;height:32px;object-fit:contain;
          border-radius:3px;background:var(--bg-elevated);flex-shrink:0;" />
        <div style="flex:1;min-width:0;">
          <div style="font-size:11px;font-weight:600;overflow:hidden;text-overflow:ellipsis;
            white-space:nowrap;color:var(--text-primary);">
            ${esc(item.classname || item.file.name)}
          </div>
          <div style="font-size:10px;color:var(--text-muted);">${esc(item.file.name)}</div>
        </div>
        <span style="font-size:12px;color:${statusColor};flex-shrink:0;">${statusIcon}</span>
        <button class="btn btn-ghost btn-icon btn-sm uc-remove-btn" data-id="${item.id}"
          style="flex-shrink:0;opacity:0.5;">×</button>
      `;

      el.addEventListener("click", e => {
        if ((e.target as HTMLElement).classList.contains("uc-remove-btn")) return;
        selectItem(item.id);
      });
      el.querySelector(".uc-remove-btn")!.addEventListener("click", e => {
        e.stopPropagation();
        const idx = pending.findIndex(p => p.id === item.id);
        if (idx >= 0) pending.splice(idx, 1);
        if (selectedId === item.id) { selectedId = null; showAssignEmpty(); }
        renderFileList();
        updateStats();
      });

      fileList.appendChild(el);
    });
  }

  // ── Select item for assignment ───────────────────────────
  function selectItem(id: string): void {
    selectedId = id;
    const item = pending.find(p => p.id === id);
    if (!item) return;

    assignEmpty.style.display = "none";
    assignForm.style.display  = "flex";
    assignStatus.style.display = "none";

    previewImg.src        = item.dataUrl;
    classnameIn.value     = item.classname;
    displayNameIn.value   = item.displayName;
    categoryIn.value      = item.category;

    // Auto-fill display name from library
    classnameIn.addEventListener("input", () => {
      const lib = store.getLibrary().find(l => l.classname === classnameIn.value.trim());
      if (lib && !displayNameIn.value) displayNameIn.value = lib.displayName;
    }, { once: false });

    renderFileList();
  }

  function showAssignEmpty(): void {
    assignEmpty.style.display = "";
    assignForm.style.display  = "none";
  }

  // ── Assign ───────────────────────────────────────────────
  overlay.querySelector("#uc-assign-btn")!.addEventListener("click", () => {
    const classname = classnameIn.value.trim();
    if (!classname) { showToast("Classname eingeben", "error"); return; }

    const item = pending.find(p => p.id === selectedId);
    if (!item) return;

    const isDup = pending.some(p => p.id !== item.id && p.classname === classname && p.status === "assigned");
    item.classname   = classname;
    item.displayName = displayNameIn.value.trim() || classname;
    item.category    = categoryIn.value.trim();
    item.status      = isDup ? "duplicate" : "assigned";

    assignStatus.style.display = "";
    assignStatus.textContent   = isDup ? "⚠ Classname bereits vergeben" : "✓ Zugewiesen";
    assignStatus.style.color   = isDup ? "var(--warning)" : "var(--success)";

    renderFileList();
    updateStats();

    // Auto-advance to next pending
    const nextPending = pending.find(p => p.status === "pending");
    if (nextPending) setTimeout(() => selectItem(nextPending.id), 400);
  });

  overlay.querySelector("#uc-skip-btn")!.addEventListener("click", () => {
    const nextPending = pending.find(p => p.id !== selectedId && p.status === "pending");
    if (nextPending) selectItem(nextPending.id);
    else showAssignEmpty();
  });

  // ── Auto-assign from library ─────────────────────────────
  overlay.querySelector("#uc-auto-assign")!.addEventListener("click", () => {
    let count = 0;
    pending.forEach(item => {
      if (item.status !== "pending") return;
      const baseName = item.file.name.replace(/\.[^.]+$/, "");
      const lib = store.getLibrary().find(l =>
        l.classname.toLowerCase() === baseName.toLowerCase()
      );
      if (lib) {
        item.classname   = lib.classname;
        item.displayName = lib.displayName;
        item.category    = lib.category ?? "";
        item.status      = "assigned";
        count++;
      }
    });
    renderFileList(); updateStats();
    showToast(`${count} automatisch zugewiesen`, "success");
  });

  // ── Classnames from filenames ────────────────────────────
  overlay.querySelector("#uc-bulk-from-filenames")!.addEventListener("click", () => {
    let count = 0;
    pending.forEach(item => {
      if (item.status === "assigned") return;
      const baseName = item.file.name.replace(/\.[^.]+$/, "");
      item.classname   = baseName;
      item.displayName = item.displayName || baseName;
      item.status      = "assigned";
      count++;
    });
    renderFileList(); updateStats();
    showToast(`${count} Classnames aus Dateinamen gesetzt`, "success");
  });

  // ── CSV/TXT import ───────────────────────────────────────
  overlay.querySelector("#uc-import-csv")!.addEventListener("click", () => {
    (overlay.querySelector("#uc-csv-input") as HTMLInputElement).click();
  });

  (overlay.querySelector("#uc-csv-input") as HTMLInputElement).addEventListener("change", async (e) => {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;
    const text = await file.text();
    const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    let matched = 0;
    lines.forEach(line => {
      const [classname, displayName, category] = line.split(/[,;]/).map(s => s.trim());
      if (!classname) return;
      const item = pending.find(p => p.status !== "assigned" &&
        p.file.name.replace(/\.[^.]+$/, "").toLowerCase() === classname.toLowerCase()
      ) ?? pending.find(p => p.status === "pending");
      if (item) {
        item.classname   = classname;
        item.displayName = displayName || classname;
        item.category    = category ?? "";
        item.status      = "assigned";
        matched++;
      }
    });
    renderFileList(); updateStats();
    showToast(`${matched} Einträge importiert`, "success");
    (e.target as HTMLInputElement).value = "";
  });

  // ── Clear all ────────────────────────────────────────────
  overlay.querySelector("#uc-clear-all")!.addEventListener("click", () => {
    pending.length = 0; selectedId = null;
    renderFileList(); showAssignEmpty(); updateStats();
  });

  // ── Commit to library ────────────────────────────────────
  overlay.querySelector("#uc-commit")!.addEventListener("click", () => {
    const toSave = pending.filter(p => p.status === "assigned" && p.classname);
    if (toSave.length === 0) { showToast("Keine zugewiesenen Bilder", "warning"); return; }

    toSave.forEach(item => {
      store.addLibraryItem({
        classname:   item.classname,
        displayName: item.displayName || item.classname,
        imageUrl:    item.dataUrl,
        category:    item.category || undefined,
      });
    });

    showToast(`${toSave.length} Item${toSave.length !== 1 ? "s" : ""} in Library gespeichert`, "success");
    close();
  });

  // ── Stats ────────────────────────────────────────────────
  function updateStats(): void {
    const assigned = pending.filter(p => p.status === "assigned").length;
    const total    = pending.length;
    overlay.querySelector<HTMLElement>("#uc-stats")!.textContent =
      `${total} gesamt · ${assigned} zugewiesen · ${total - assigned} ausstehend`;
  }
}

function esc(s: string): string {
  return String(s).replace(/&/g,"&amp;").replace(/"/g,"&quot;").replace(/</g,"&lt;");
}

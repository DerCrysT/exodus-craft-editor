import { store } from "../../state/AppStore";
import { bus } from "../../state/EventEmitter";
import { downloadFile, readFileAsText, parseJSON } from "../../data/jsonHandler";
import { runValidation } from "../../data/validator";
import type { ExodusCraftProject, Faction, WorkbenchType } from "../../types/index";
import { getWorkbenchClassname } from "../../data/workbenches";
import { openDependencyGraph } from "../panels/DependencyGraph";
import { openMassEditModal } from "../panels/MassEdit";
import { openUploadCenter } from "../panels/UploadCenter";
import { openVersioningModal, createRestorePoint } from "../panels/Versioning";
import { perfMonitor } from "../node-editor/VirtualRenderer";

export function initToolbar(): void {
  // ── Mode switch ──
  document.getElementById("tb-node-mode")!.addEventListener("click", () => {
    store.setMode("node");
    updateModeButtons("node");
  });
  document.getElementById("tb-form-mode")!.addEventListener("click", () => {
    store.setMode("form");
    updateModeButtons("form");
  });

  // ── Workbench ──
  const wbSelect = document.getElementById("tb-workbench") as HTMLSelectElement;
  wbSelect.addEventListener("change", () => {
    store.setWorkbench(wbSelect.value as WorkbenchType);
    syncSelectsFromState();
    refreshWorkbenchClassname();
  });

  // ── Faction ──
  const factionSelect = document.getElementById("tb-faction") as HTMLSelectElement;
  factionSelect.addEventListener("change", () => {
    store.setFaction(factionSelect.value as Faction || null);
    syncSelectsFromState();
    refreshWorkbenchClassname();
  });

  // Sync selects when workspace changes (e.g. on load from storage)
  bus.on("workspace:change", () => {
    syncSelectsFromState();
    refreshWorkbenchClassname();
  });
  bus.on("project:load", () => {
    syncSelectsFromState();
    refreshWorkbenchClassname();
    updateModeButtons(store.getState().activeMode);
  });
  // Set initial mode UI (form-editor-root starts hidden, node-editor-root visible)
  updateModeButtons(store.getState().activeMode);

  // Keep mode UI in sync whenever mode:change fires (e.g. after workspace switch)
  bus.on("mode:change", (e) => {
    const ev = e as { payload: string };
    if (ev.payload === "node" || ev.payload === "form") {
      updateModeButtons(ev.payload);
    }
  });

  // ── Undo / Redo ──
  document.getElementById("tb-undo")!.addEventListener("click", () => store.undo());
  document.getElementById("tb-redo")!.addEventListener("click", () => store.redo());

  // ── Import JSON ──
  document.getElementById("tb-import")!.addEventListener("click", () => {
    document.getElementById("import-json-input")!.click();
  });
  document.getElementById("import-json-input")!.addEventListener("change", async (e) => {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;
    const raw = await readFileAsText(file);
    try {
      // Try .exoduscraft project first
      const parsed = JSON.parse(raw);
      if (parsed.__type === "ExodusCraftProject") {
        store.loadProject(parsed as ExodusCraftProject);
        showToast("Projekt geladen", "success");
      } else {
        const json = parseJSON(raw);
        if (!json) { showToast("Ungültiges JSON-Format", "error"); return; }
        store.setJSON(json);
        showToast("JSON importiert", "success");
      }
    } catch {
      showToast("Fehler beim Parsen der Datei", "error");
    }
    (e.target as HTMLInputElement).value = "";
  });

  // ── Export JSON ──
  document.getElementById("tb-export")!.addEventListener("click", () => {
    const json = store.exportJSON();
    const wbName = store.getJSON().WorkbenchesClassnames[0] ?? "export";
    downloadFile(json, `${wbName}.json`);
    showToast("JSON exportiert", "success");
  });

  // ── Save Project ──
  document.getElementById("tb-save-project")!.addEventListener("click", () => {
    const content = store.exportProjectFile();
    const name = store.getState().project.meta.name.replace(/\s+/g, "_");
    downloadFile(content, `${name}.exoduscraft`);
    showToast("Projekt gespeichert", "success");
  });

  // ── Theme ──
  const themeSelect = document.getElementById("tb-theme") as HTMLSelectElement;
  themeSelect.addEventListener("change", () => {
    store.setTheme(themeSelect.value as "dark" | "light" | "soft-dark");
  });

  // ── Validate ──
  document.getElementById("tb-validate")!.addEventListener("click", () => {
    const state = store.getState();
    const issues = runValidation(state.project.nodes, state.project.edges, state.project.jsonData);
    renderValidationLog(issues);
    showToast(`Validierung: ${issues.length} Problem${issues.length !== 1 ? "e" : ""} gefunden`,
      issues.length === 0 ? "success" : "warning");
  });

  // ── Dependency Graph ──
  document.getElementById("tb-dep-graph")?.addEventListener("click", () => {
    openDependencyGraph();
  });

  // ── Mass Edit ──
  document.getElementById("tb-mass-edit")?.addEventListener("click", () => {
    openMassEditModal();
  });

  // ── Upload Center ──
  document.getElementById("tb-upload-center")?.addEventListener("click", () => {
    openUploadCenter();
  });

  // ── Versioning ──
  document.getElementById("tb-versioning")?.addEventListener("click", () => {
    openVersioningModal();
  });

  // ── Manual Restore Point (Ctrl+Shift+S) ──
  window.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === "S") {
      e.preventDefault();
      const label = prompt("Name für Wiederherstellungspunkt:", `Manuell — ${new Date().toLocaleTimeString("de-DE")}`);
      if (label !== null) createRestorePoint(label.trim() || undefined);
    }
    // Ctrl+Shift+P = Perf Monitor toggle
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === "P") {
      e.preventDefault();
      perfMonitor.toggle();
    }
  });

  // ── JSON copy/export in props panel ──
  document.getElementById("json-copy")?.addEventListener("click", () => {
    const text = document.getElementById("json-preview")?.textContent ?? "";
    navigator.clipboard.writeText(text).then(() => showToast("Kopiert!", "success"));
  });
  document.getElementById("json-export-btn")?.addEventListener("click", () => {
    document.getElementById("tb-export")!.dispatchEvent(new MouseEvent("click"));
  });

  // ── Props panel collapse ──
  let propsPanelCollapsed = false;
  document.getElementById("props-collapse-btn")?.addEventListener("click", () => {
    propsPanelCollapsed = !propsPanelCollapsed;
    const panel = document.getElementById("props-panel") as HTMLElement;
    const appEl = document.getElementById("app") as HTMLElement;
    const btn   = document.getElementById("props-collapse-btn") as HTMLElement;
    if (propsPanelCollapsed) {
      panel.style.display = "none";
      appEl.style.gridTemplateColumns = "260px 1fr 0px";
      btn.textContent = "⇤";
      btn.title = "Eigenschaften-Panel öffnen";
    } else {
      panel.style.display = "flex";
      appEl.style.gridTemplateColumns = "260px 1fr 280px";
      btn.textContent = "⇥";
      btn.title = "Eigenschaften-Panel einklappen";
    }
  });

  // ── JSON Vollbild ──
  document.getElementById("json-fullscreen")?.addEventListener("click", () => {
    const json = store.exportJSON();
    const overlay = document.createElement("div");
    overlay.style.cssText = `position:fixed;inset:0;z-index:9999;
      background:var(--bg-base);display:flex;flex-direction:column;`;
    overlay.innerHTML = `
      <div style="display:flex;align-items:center;gap:8px;padding:10px 16px;
        border-bottom:1px solid var(--border);background:var(--bg-surface);">
        <span style="font-size:13px;font-weight:600;flex:1;">JSON — ${
          store.getJSON().WorkbenchesClassnames[0] ?? "export"
        }</span>
        <button id="jf-copy" class="btn btn-secondary btn-sm">Kopieren</button>
        <button id="jf-export" class="btn btn-primary btn-sm">Exportieren</button>
        <button id="jf-close" class="btn btn-ghost btn-sm">✕ Schließen</button>
      </div>
      <pre style="flex:1;overflow:auto;padding:20px;font-size:12px;
        color:var(--text-secondary);white-space:pre;font-family:monospace;
        line-height:1.6;">${json.replace(/</g,"&lt;")}</pre>`;
    document.body.appendChild(overlay);
    overlay.querySelector("#jf-close")!.addEventListener("click", () => overlay.remove());
    overlay.querySelector("#jf-copy")!.addEventListener("click", () => {
      navigator.clipboard.writeText(json).then(() => showToast("Kopiert!", "success"));
    });
    overlay.querySelector("#jf-export")!.addEventListener("click", () => {
      document.getElementById("tb-export")!.dispatchEvent(new MouseEvent("click"));
    });
  });

  // ── Props tabs ──
  document.querySelectorAll("#props-tabs .tab").forEach(tab => {
    tab.addEventListener("click", () => {
      document.querySelectorAll("#props-tabs .tab").forEach(t => t.classList.remove("active"));
      tab.classList.add("active");
      const which = (tab as HTMLElement).dataset.tab;
      document.getElementById("tab-properties")!.style.display = which === "properties" ? "" : "none";
      const jsonTab = document.getElementById("tab-json")!;
      jsonTab.style.display = which === "json" ? "flex" : "none";
      if (which === "json") refreshJSONPreview();
    });
  });

  // ── Keyboard shortcuts ──
  window.addEventListener("keydown", (e) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    const ctrl = e.ctrlKey || e.metaKey;
    if (ctrl && e.key === "z" && !e.shiftKey) { e.preventDefault(); store.undo(); }
    if (ctrl && (e.key === "y" || (e.key === "z" && e.shiftKey))) { e.preventDefault(); store.redo(); }
    if (ctrl && e.key === "s") { e.preventDefault(); store.saveToStorage(); showToast("Gespeichert", "success"); }
  });

  // ── Statusbar reactivity ──
  bus.on("state:change", () => updateStatusbar());
  bus.on("project:save", () => {
    const dot = document.getElementById("save-dot")!;
    const status = document.getElementById("save-status")!;
    dot.classList.remove("dirty");
    status.textContent = "Gespeichert";
  });

  updateStatusbar();
  refreshWorkbenchClassname();
}

function syncSelectsFromState(): void {
  const state = store.getState();
  const wbSelect = document.getElementById("tb-workbench") as HTMLSelectElement;
  const factionSelect = document.getElementById("tb-faction") as HTMLSelectElement;
  if (wbSelect && state.activeWorkbench) wbSelect.value = state.activeWorkbench;
  if (factionSelect) factionSelect.value = state.activeFaction ?? "";
}

function updateModeButtons(mode: "node" | "form"): void {
  document.getElementById("tb-node-mode")!.classList.toggle("active", mode === "node");
  document.getElementById("tb-form-mode")!.classList.toggle("active", mode === "form");
  const nodeRoot = document.getElementById("node-editor-root")!;
  const formRoot = document.getElementById("form-editor-root")!;
  nodeRoot.style.display = mode === "node" ? "" : "none";
  formRoot.style.display = mode === "form" ? "flex" : "none";
  document.getElementById("sb-mode")!.textContent = mode === "node" ? "Node Editor" : "Formular Editor";
  // NOTE: do NOT emit mode:change here — would cause infinite loop
}

function refreshWorkbenchClassname(): void {
  const state = store.getState();
  const cls = getWorkbenchClassname(state.activeWorkbench ?? "Kleidung", state.activeFaction);
  document.getElementById("sb-workbench")!.textContent = cls;
  // Only update if the classname actually changed
  const currentClassnames = store.getJSON().WorkbenchesClassnames;
  if (!currentClassnames.includes(cls)) {
    store.updateJSON({ WorkbenchesClassnames: [cls] });
  }
}

export function updateStatusbar(): void {
  const state = store.getState();
  const nodes = state.project.nodes.length;
  const edges = state.project.edges.length;
  const recipes = state.project.jsonData.CraftCategories.reduce((sum, cat) => sum + cat.CraftItems.length, 0);

  document.getElementById("sb-nodes")!.textContent = `${nodes} Node${nodes !== 1 ? "s" : ""}`;
  document.getElementById("sb-edges")!.textContent = `${edges} Verbindung${edges !== 1 ? "en" : ""}`;
  document.getElementById("sb-recipes")!.textContent = `${recipes} Rezept${recipes !== 1 ? "e" : ""}`;

  const dot    = document.getElementById("save-dot")!;
  const status = document.getElementById("save-status")!;
  if (state.isDirty) {
    dot.classList.add("dirty");
    status.textContent = "Nicht gespeichert";
  } else {
    dot.classList.remove("dirty");
    if (status.textContent === "Nicht gespeichert") {
      status.textContent = "Gespeichert";
    }
  }

  refreshJSONPreview();
}

export function refreshJSONPreview(): void {
  const jsonTab = document.getElementById("tab-json");
  if (!jsonTab || jsonTab.style.display === "none") return; // not visible, skip
  const preview = document.getElementById("json-preview");
  if (!preview) return;
  preview.textContent = store.exportJSON();
}

export function setZoomDisplay(zoom: number): void {
  document.getElementById("sb-zoom")!.textContent = `${Math.round(zoom * 100)}%`;
}

// ── Validation Log ──────────────────────────────────────────

function renderValidationLog(issues: ReturnType<typeof runValidation>): void {
  const log = document.getElementById("validation-log")!;
  const container = document.getElementById("validation-items")!;

  container.innerHTML = "";
  if (issues.length === 0) {
    container.innerHTML = `<div class="log-item info">✓ Keine Probleme gefunden</div>`;
  } else {
    issues.forEach(issue => {
      const icon = issue.severity === "error" ? "✖" : issue.severity === "warning" ? "⚠" : "ℹ";
      const div = document.createElement("div");
      div.className = `log-item ${issue.severity}`;
      div.textContent = `${icon} ${issue.message}`;
      container.appendChild(div);
    });
  }
  log.classList.add("open");
  setTimeout(() => log.classList.remove("open"), 8000);
}

// ── Toast ───────────────────────────────────────────────────

let toastTimer: ReturnType<typeof setTimeout> | null = null;

export function showToast(message: string, type: "success" | "error" | "warning" | "info" = "info"): void {
  let toast = document.getElementById("app-toast");
  if (!toast) {
    toast = document.createElement("div");
    toast.id = "app-toast";
    toast.style.cssText = `
      position:fixed;bottom:40px;left:50%;transform:translateX(-50%);
      padding:8px 18px;border-radius:6px;font-size:12px;font-weight:500;
      z-index:9999;transition:opacity 0.2s;pointer-events:none;
      border:1px solid transparent;
    `;
    document.body.appendChild(toast);
  }

  const colors: Record<string, string> = {
    success: "background:rgba(61,186,126,0.15);color:var(--success);border-color:var(--success)",
    error:   "background:rgba(232,92,92,0.15);color:var(--danger);border-color:var(--danger)",
    warning: "background:rgba(232,168,64,0.15);color:var(--warning);border-color:var(--warning)",
    info:    "background:rgba(77,142,240,0.15);color:var(--accent);border-color:var(--accent)",
  };

  toast.style.cssText += colors[type] ?? colors.info;
  toast.textContent = message;
  toast.style.opacity = "1";

  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { if (toast) toast.style.opacity = "0"; }, 2500);
}

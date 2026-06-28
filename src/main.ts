import { store } from "./state/AppStore";
import { initToolbar } from "./ui/toolbar/Toolbar";
import { initLibraryPanel, seedLibraryDefaults } from "./ui/library/LibraryPanel";
import { initNodeEditor } from "./ui/node-editor/NodeEditor";
import { initPropertiesPanel } from "./ui/panels/PropertiesPanel";
import { initFormEditor } from "./ui/form-editor/FormEditor";
import { initAutoSync } from "./data/recipeSync";
import { initVersioning } from "./ui/panels/Versioning";
import { perfMonitor } from "./ui/node-editor/VirtualRenderer";

function bootstrap(): void {
  // 1. Theme
  const savedTheme = localStorage.getItem("exodus_craft_theme") ?? "dark";
  store.setTheme(savedTheme as "dark" | "light" | "soft-dark");
  const themeSelect = document.getElementById("tb-theme") as HTMLSelectElement;
  if (themeSelect) themeSelect.value = savedTheme;
  document.getElementById("tb-theme")?.addEventListener("change", (e) => {
    localStorage.setItem("exodus_craft_theme", (e.target as HTMLSelectElement).value);
  });

  // 2. Init subsystems
  initAutoSync();
  initToolbar();
  initLibraryPanel();
  initNodeEditor();
  initPropertiesPanel();
  initFormEditor();
  initVersioning();       // auto restore-point every 5 min
  perfMonitor.start();    // FPS monitor (toggle: Ctrl+Shift+P)

  // 3. Load persisted data — library is loaded inside loadFromStorage
  const loaded = store.loadFromStorage();

  // Sync toolbar dropdowns to restored state
  const wbSel = document.getElementById("tb-workbench") as HTMLSelectElement;
  const faSel = document.getElementById("tb-faction")   as HTMLSelectElement;
  const state = store.getState();
  if (wbSel && state.activeWorkbench) wbSel.value = state.activeWorkbench;
  if (faSel) faSel.value = state.activeFaction ?? "";

  // 4. Only seed defaults when nothing exists in storage at all
  if (!loaded) {
    // Seed example JSON
    store.setJSON({
      WorkbenchesClassnames: ["Exodus_WB_Kleidung"],
      CraftCategories: [
        {
          CategoryName: "Kleidung",
          CraftItems: [
            {
              Result: "Hammer",
              ResultShow: "Hammer",
              ResultCount: 1,
              ComponentsDontAffectHealth: 0,
              CraftType: "craft" as const,
              RecipeName: "Tuch-Gesichtsschutz",
              CraftComponents: [
                { Classname: "Rag", Amount: 3, Destroy: true, Changehealth: 0 },
              ],
              AttachmentsNeed: [
                "Exodus_WB_Tool_Schere",
                "Exodus_WB_Tool_Keksdose",
                "Exodus_WB_Tool_Naehmaschine",
              ],
            },
          ],
        },
      ],
      m_CustomizationSetting: { PathToMainBackgroundImg: "", PathToCraftImg: "" },
    });
    // Seed library only if also empty (first ever launch)
    if (store.getLibrary().length === 0) {
      seedLibraryDefaults();
    }
  }

  console.log("Exodus Craft Editor — bereit");
}

bootstrap();

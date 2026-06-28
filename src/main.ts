import { store } from "./state/AppStore";
import { initToolbar } from "./ui/toolbar/Toolbar";
import { initLibraryPanel, seedLibraryDefaults } from "./ui/library/LibraryPanel";
import { initNodeEditor } from "./ui/node-editor/NodeEditor";
import { initPropertiesPanel } from "./ui/panels/PropertiesPanel";
import { initFormEditor } from "./ui/form-editor/FormEditor";
import { initAutoSync } from "./data/recipeSync";
import { initVersioning } from "./ui/panels/Versioning";
import { perfMonitor } from "./ui/node-editor/VirtualRenderer";
import { initFirebase, isEnabled } from "./firebase/service";
import { initFirebaseSync, migrateLocalToFirebase } from "./firebase/sync";
import { initPresenceBar } from "./ui/panels/PresenceBar";

function bootstrap(): void {
  // 1. Theme
  const savedTheme = localStorage.getItem("exodus_craft_theme") ?? "dark";
  store.setTheme(savedTheme as "dark" | "light" | "soft-dark");
  const themeSelect = document.getElementById("tb-theme") as HTMLSelectElement;
  if (themeSelect) themeSelect.value = savedTheme;
  document.getElementById("tb-theme")?.addEventListener("change", (e) => {
    localStorage.setItem("exodus_craft_theme", (e.target as HTMLSelectElement).value);
  });

  // 2. Firebase (must be before other inits so auth state is ready)
  initFirebase();

  // 3. Init subsystems
  initAutoSync();
  initToolbar();
  initLibraryPanel();
  initNodeEditor();
  initPropertiesPanel();
  initFormEditor();
  initVersioning();
  perfMonitor.start();

  // 4. Firebase sync + presence bar
  initFirebaseSync();
  initPresenceBar();

  // 5. Migrate button (only shown when Firebase is enabled and user is logged in)
  const migrateBtn = document.getElementById("tb-migrate-firebase");
  if (migrateBtn) {
    if (isEnabled()) {
      migrateBtn.style.display = "";
      migrateBtn.addEventListener("click", () => migrateLocalToFirebase());
    }
  }

  // 6. Load persisted data (localStorage fallback when Firebase offline/not configured)
  const loaded = store.loadFromStorage();

  // Sync toolbar dropdowns to restored state
  const wbSel = document.getElementById("tb-workbench") as HTMLSelectElement;
  const faSel = document.getElementById("tb-faction")   as HTMLSelectElement;
  const appState = store.getState();
  if (wbSel && appState.activeWorkbench) wbSel.value = appState.activeWorkbench;
  if (faSel) faSel.value = appState.activeFaction ?? "";

  // 7. Seed example data on first launch
  if (!loaded) {
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
    if (store.getLibrary().length === 0) {
      seedLibraryDefaults();
    }
  }

  console.log("Exodus Craft Editor — bereit");
}

bootstrap();

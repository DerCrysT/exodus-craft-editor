# ⚙ Exodus Craft Editor

Visual crafting recipe editor for DayZ **Exodus** mod — production-ready, runs entirely in the browser, deployable on GitHub Pages.

---

## Features

### Node Editor (Hauptfeature)
- Canvas-basierter Editor à la Blender / Unreal Blueprints
- Drag & Drop aus der Library direkt in den Canvas
- Nodes verbinden per Port-Drag → erzeugt automatisch Rezepte
- Edge-Labels (Amount) inline bearbeiten per Klick
- Doppelklick / ⚙-Button → Properties Modal
- Rechtsklick Context Menu
- Pan (Alt+Drag / Mittelmaus), Zoom (Mausrad), Fit All (F)
- Box-Selektion, Mehrfachauswahl (Shift+Klick)
- **Alignment Tools** — Links/Mitte/Rechts/Oben/Mitte/Unten
- **Auto Layout** — hierarchisch, Layer-basiert
- Minimap mit Viewport-Indikator
- Pfeiltasten-Nudge für präzise Positionierung

### Formular-Editor
- Vollständige CRUD für Kategorien und Rezepte
- Drag & Drop Sortierung zwischen und innerhalb von Kategorien
- Mehrfachauswahl + Bulk-Delete
- Suche / Filter live über alle Kategorien
- Rezepte kopieren, verschieben, umordnen

### Dependency Graph
- Canvas-basierte Visualisierung aller Craft-Ketten
- Layer-Tiefe, Hover-Tooltip, Zoom/Pan
- Filter nach Classname

### Mass Edit
- Mehrere Nodes gleichzeitig bearbeiten
- Craft Type, Kategorie, Result Count, Health, Werkzeuge
- Classname Präfix/Suffix batch-setzen
- Werkzeuge: Ersetzen / Hinzufügen / Entfernen

### Werkbanksystem
| Werkbank | Tools |
|---|---|
| Kleidung | Schere, Keksdose, Nähmaschine |
| Medizin | Brenner, Mikroskop, Diagnose |
| Waffen | Schraubstock, Schleifer, Drehbank |
| Werkbank | Amboss, Bohrer, Schweißer |
| Wissenschaft | Lötkolben, Computer, Antenne |

16 Fraktionen: Badnits, ClearSky, Digger, Duty, Ecologist, Freedom, FreeStalker, IPSF, Loner, Mercenary, Military, Monoltih, Noontide, Spark, UNISG, Warden

### Upload Center
- Drag & Drop Bulk-Upload von Bildern (PNG/JPG/WEBP)
- Auto-Assign: Dateinamen → Classnames automatisch matchen
- Manuelles Zuweisen mit Vorschau + Auto-Advance zum nächsten
- CSV/TXT-Import: Classname-Liste einer Datei zuweisen
- Commit speichert alle zugewiesenen Bilder in die Library

### Versionsverlauf
- Automatische Restore-Points alle 5 Minuten
- Manuelle Restore-Points (`Ctrl+Shift+S`)
- **Diff Viewer** — zeigt Added/Removed/Changed Rezepte vs. gewählter Version
- Einzelne Versionen als JSON exportieren
- Wiederherstellen mit einem Klick

### Performance
- **Virtual Rendering** — bei 80+ Nodes werden nur sichtbare gerendert
- Viewport-Culling mit 200px Randpuffer für nahtloses Scrollen
- FPS-Monitor (Toggle: `Ctrl+Shift+P`)
- Autosave debounced (500ms)

### Validierung
- Zyklische Abhängigkeiten erkennen
- Doppelte Rezeptnamen
- Fehlende Classnames / leere Components
- Nicht verbundene Nodes

---

## Schnellstart

```bash
# 1. Abhängigkeiten installieren
npm install

# 2. Dev-Server starten (öffnet Browser automatisch)
npm run dev

# 3. Produktion bauen
npm run build

# 4. Build lokal testen
npm run preview
```

---

## GitHub Pages Deployment

### Einmalig einrichten

1. Repository auf GitHub erstellen (z.B. `exodus-craft-editor`)

2. In `vite.config.ts` die `base`-Option auf deinen Repo-Namen setzen:
   ```ts
   base: "/exodus-craft-editor/",
   ```

3. Code pushen:
   ```bash
   git init
   git add .
   git commit -m "Initial commit"
   git remote add origin https://github.com/DEIN_USER/exodus-craft-editor.git
   git push -u origin main
   ```

4. In GitHub → Settings → Pages → Source: **GitHub Actions** auswählen

5. Der nächste Push auf `main` deployed automatisch.

### URL
```
https://DEIN_USER.github.io/exodus-craft-editor/
```

---

## JSON-Format

Das Tool liest und schreibt exakt dieses Format:

```json
{
  "WorkbenchesClassnames": ["Exodus_WB_Kleidung"],
  "CraftCategories": [
    {
      "CategoryName": "Kleidung",
      "CraftItems": [
        {
          "Result": "Hammer",
          "ResultShow": "Hammer",
          "ResultCount": 1,
          "ComponentsDontAffectHealth": 0,
          "CraftType": "craft",
          "RecipeName": "Tuch-Gesichtsschutz",
          "CraftComponents": [
            { "Classname": "Rag", "Amount": 3, "Destroy": true, "Changehealth": 0.0 }
          ],
          "AttachmentsNeed": [
            "Exodus_WB_Tool_Schere",
            "Exodus_WB_Tool_Keksdose",
            "Exodus_WB_Tool_Naehmaschine"
          ]
        }
      ]
    }
  ],
  "m_CustomizationSetting": {
    "PathToMainBackgroundImg": "",
    "PathToCraftImg": ""
  }
}
```

---

## Projektformat `.exoduscraft`

Speichert zusätzlich zum JSON:
- Node-Positionen im Canvas
- Canvas-Offset und Zoom
- Geöffnete Tabs und UI-State

Team-Workflow: `.exoduscraft`-Datei teilen → alle sehen dasselbe Layout.

---

## Keyboard Shortcuts

| Shortcut | Aktion |
|---|---|
| `Ctrl+Z` | Undo |
| `Ctrl+Y` / `Ctrl+Shift+Z` | Redo |
| `Ctrl+S` | Speichern |
| `Ctrl+D` | Node(s) duplizieren |
| `F` | Alle Nodes einpassen |
| `Delete` / `Backspace` | Ausgewähltes löschen |
| `Escape` | Auswahl aufheben |
| `↑ ↓ ← →` | Node nudgen (Snap to Grid) |
| `Alt+Drag` | Canvas schwenken |
| `Ctrl+Shift+S` | Manueller Restore-Point |
| `Ctrl+Shift+P` | FPS-Monitor ein/aus |
| `Shift+Klick` | Mehrfachauswahl |

---

## Architektur

```
src/
├── types/index.ts          # Alle TypeScript-Interfaces
├── state/
│   ├── AppStore.ts         # Zentraler State + Undo/Redo + LocalStorage
│   └── EventEmitter.ts     # App-weiter Event-Bus
├── data/
│   ├── workbenches.ts      # Werkbank/Fraktions-Definitionen
│   ├── jsonHandler.ts      # JSON Parse/Normalize/Download
│   ├── validator.ts        # Zyklenerkennung + Validierung
│   └── recipeSync.ts       # Node-Graph ↔ JSON Auto-Sync
└── ui/
    ├── toolbar/Toolbar.ts
    ├── library/LibraryPanel.ts
    ├── node-editor/NodeEditor.ts
    ├── form-editor/FormEditor.ts
    └── panels/
        ├── PropertiesPanel.ts
        ├── DependencyGraph.ts
        └── MassEdit.ts
```

---

## Tech Stack

- **TypeScript** (strict mode)
- **Vite** (Build + Dev Server)
- **Vanilla DOM** (kein Framework)
- **Canvas API** (Dependency Graph, Minimap)
- **SVG** (Node-Editor Edges)
- **CSS Custom Properties** (3 Themes: Dark / Soft Dark / Light)
- **LocalStorage** (Auto-Save)

---

## Lizenz

MIT — frei nutzbar für eigene DayZ Mod-Projekte.

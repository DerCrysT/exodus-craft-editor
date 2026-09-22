# Exodus Craft Editor — Claude Code Kontext

## Projekt
Browser-basierter visueller Crafting-Rezept-Editor für die DayZ Exodus Mod (STALKER-inspiriert).
- **Stack:** Vanilla TypeScript + Vite, keine Frameworks
- **Deploy:** GitHub Pages via GitHub Actions (`git push` → automatisch live)
- **Live:** https://dercrypt.github.io/exodus-craft-editor/
- **Repo:** DerCrysT/exodus-craft-editor

## Firebase
- Projekt: `exodus-craft-editor`, Region: `europe-west1`
- Realtime Database (kein Firestore, kein Storage — Free Plan)
- Config in `src/firebase/config.ts`
- **Wichtig:** Bilder werden vor dem Firebase-Save auf 128×128px komprimiert (`src/data/imageUtils.ts`) damit das 16MB Write-Limit nicht erreicht wird

## Architektur

```
src/
  types/index.ts          — alle TypeScript-Interfaces (CraftNode, CraftEdge, WorkbenchJSON...)
  state/AppStore.ts       — zentraler Store + Undo/Redo + Workspace-System
  state/EventEmitter.ts   — app-weiter Event-Bus (bus.on / bus.emit)
  data/workbenches.ts     — 5 Werkbänke (Kleidung, Medizin, Waffen, Werkbank, Wissenschaft) + 16 Fraktionen
  data/jsonHandler.ts     — JSON Parse/Validate/Export
  data/recipeSync.ts      — Node-Canvas ↔ WorkbenchJSON bidirektionaler Sync
  data/clipboard.ts       — Ctrl+C/V via localStorage
  data/imageUtils.ts      — compressImage() 128×128px JPEG vor Firebase-Save
  firebase/config.ts      — Firebase Keys (öffentlich, by design)
  firebase/service.ts     — Auth (Email+Google), Realtime DB, Presence, Library
  firebase/sync.ts        — Workspace Locking + Blob-Sync
  ui/toolbar/Toolbar.ts   — alle Toolbar-Aktionen, Export, Mode-Switch
  ui/library/LibraryPanel.ts — Library mit Drag, Add/Edit Modal
  ui/node-editor/NodeEditor.ts — Canvas Pan/Zoom/Snap, Nodes, Edges, Quick Connect, Area-Nodes
  ui/form-editor/FormEditor.ts — Formular-Editor (alle prompt() durch DOM-Modals ersetzt)
  ui/panels/MassEdit.ts   — Batch-Bearbeitung mehrerer Nodes
  ui/panels/PresenceBar.ts — Login-Modal, Online-User-Anzeige, Lock-Banner
styles/
  layout.css              — Grid-Layout (toolbar/library/canvas/props/statusbar)
  nodes.css               — Node, Comment, Area Node CSS
```

## Firebase Sync System (`src/firebase/sync.ts`)
- **Workspace Locking:** Wer zuerst in einem Workspace ist, hält den Lock unter `workspaces/{wsKey}/lock`
- `onDisconnect` löscht Lock automatisch bei Disconnect
- Lock-Inhaber schreibt Blob nach `workspaces/{wsKey}/data` (debounced 1.5s nach Änderung)
- Read-Only User bekommen `onValue` Updates sofort
- Wenn Lock freigegeben wird → andere User übernehmen automatisch
- **Blob-Struktur:** `{ nodes: {0:..., 1:...}, edges: {0:..., 1:...}, jsonData, savedAt }`
- Nodes werden **ohne imageUrl** gespeichert (zu groß) — Bilder kommen aus der Library
- `toArray<T>()` Helper konvertiert Firebase-Objekte zurück zu Arrays (Firebase speichert Arrays als `{0:x, 1:y}`)

## Event-Bus (wichtige Events)
```
node:add / node:update / node:move / node:remove
edge:add / edge:update / edge:remove
json:formUpdate   → Form → Nodes Sync (via recipeSync)
json:import       → JSON Datei importiert
nodes:replaced    → Firebase hat Nodes gesetzt (kein Loop!)
state:change      → alles neu rendern
workspace:change  → Werkbank/Fraktion gewechselt
firebase:auth     → User eingeloggt/ausgeloggt
firebase:lock     → Workspace Lock geändert
mode:change       → Node-Editor ↔ Form-Editor
```

## CraftNode Typ (wichtige Felder)
```typescript
interface CraftNode {
  id: string;
  classname: string;
  displayName: string;
  imageUrl?: string;          // nicht in Firebase gespeichert
  position: { x, y };
  nodeType?: "recipe" | "comment" | "area";
  commentText?: string;       // Label für Comment + Area Nodes
  commentColor?: string;      // rgba(...) Hintergrundfarbe
  areaWidth?: number;         // nur area: Breite in Canvas-px
  areaHeight?: number;        // nur area: Höhe in Canvas-px
  recipeName?: string;
  craftType?: string;
  resultCount?: number;
  componentsDontAffectHealth?: number;
  attachmentsNeed?: string[];
  category?: string;
}
```

## Bekannte offene Bugs / Pending
- Edge-Pan beim Node-Drag: Richtung könnte noch falsch sein (mehrfach gefixed, bitte testen)
- Quick Connect: Port-In Klick als Trigger, Enter verbindet gehover-ten Node
- Ctrl+V: Canvas bekommt tabIndex=0 damit Keyboard-Events zuverlässig feuern; Fallback per Rechtsklick

## Deploy
```bash
git add .
git commit -m "..."
git push
# → GitHub Actions baut automatisch und deployed zu GitHub Pages
# Bei Konflikt: git pull --rebase origin main && git push
```

## Wichtige Designentscheidungen
- **Kein Framework** — vanilla TS, DOM direkt manipuliert
- **prompt()/confirm() verboten** — auf GitHub Pages geblockt nach Firebase-Redirect → alle Dialoge als DOM-Modals
- **Bilder:** komprimiert (128×128px JPEG) in Firebase Library gespeichert; Workspace-Blob ohne Bilder
- **Firebase Free Plan:** kein Storage (kostenpflichtig seit Sep 2024), kein Firestore
- **Array-Problem:** Firebase Realtime DB speichert JS-Arrays als `{0:x, 1:y}` Objekte → immer `Object.values()` oder `toArray()` beim Lesen
- **Loop-Schutz:** `applyingRemote = true` während Firebase-Daten angewendet werden; `nodes:replaced` Event statt `node:add` um syncJSONToNodes ohne Firebase-Write zu triggern

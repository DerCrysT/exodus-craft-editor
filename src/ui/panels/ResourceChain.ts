import { store } from "../../state/AppStore";
import type { CraftNode } from "../../types/index";
import { highlightClassnames, clearClassnameHighlight } from "../node-editor/NodeEditor";

// ── Resource Chain ─────────────────────────────────────────
// Right-click a node → "Benötigte Ressourcen": recursively resolves every
// component back through ITS OWN recipe (wherever that recipe lives in the
// project — components are matched by classname, not by direct edge, since
// a component's recipe is usually drawn somewhere else entirely) down to
// the raw base materials, and totals them up.
//
// Components with Destroy=false (tools, e.g. a Hammer) are never consumed:
// you only need one, so they're tracked separately with the total durability
// they lose across every craft step that uses them, instead of being
// multiplied up like a consumed material. Changehealth in the JSON is
// negative for a loss (e.g. -5 = loses 5 HP), so totals keep that sign.

interface RecipeComponent {
  classname: string;
  displayName: string;
  amount: number;
  destroy: boolean;
  changehealth: number;
}

interface RecipeInfo {
  node: CraftNode;
  components: RecipeComponent[];
}

interface ToolUse {
  classname: string;
  displayName: string;
  changehealth: number; // per single use, raw sign from the JSON
  executions: number;   // how many times this exact step (hence this tool use) happens
  craftable: boolean;
}

interface ChainNode {
  classname: string;
  displayName: string;
  amount: number;     // total quantity needed at this point in the tree
  isBase: boolean;     // no recipe found anywhere → raw/base material, must be found
  isCycle: boolean;    // classname already an ancestor → stopped to avoid infinite recursion
  children: ChainNode[];
  toolsUsed: ToolUse[]; // reusable tools consumed by THIS step's recipe
}

interface ToolTotal {
  classname: string;
  displayName: string;
  totalChangehealth: number; // raw sum, keeps sign (negative = net HP lost)
  uses: number;
  craftable: boolean;
}

// One recipe per classname: the first node found that has incoming edges
// (i.e. is the result of some recipe) wins if a classname appears more than once.
function buildRecipeMap(): Map<string, RecipeInfo> {
  const nodes  = store.getNodes();
  const edges  = store.getEdges();
  const nodeById = new Map(nodes.map(n => [n.id, n]));
  const map = new Map<string, RecipeInfo>();

  nodes.forEach(n => {
    if (n.nodeType === "comment" || n.nodeType === "area") return;
    if (!n.classname || map.has(n.classname)) return;
    const incoming = edges.filter(e => e.targetNodeId === n.id);
    if (incoming.length === 0) return;
    const components = incoming
      .map((e): RecipeComponent | null => {
        const src = nodeById.get(e.sourceNodeId);
        return src && src.classname
          ? { classname: src.classname, displayName: src.displayName || src.classname,
              amount: e.amount, destroy: e.destroy, changehealth: e.changehealth }
          : null;
      })
      .filter((c): c is RecipeComponent => c !== null);
    if (components.length > 0) map.set(n.classname, { node: n, components });
  });

  return map;
}

function resolveChain(
  classname: string,
  displayName: string,
  amount: number,
  recipeMap: Map<string, RecipeInfo>,
  path: Set<string>,
  toolTotals: Map<string, ToolTotal>,
): ChainNode {
  if (path.has(classname)) {
    return { classname, displayName, amount, isBase: false, isCycle: true, children: [], toolsUsed: [] };
  }
  const recipe = recipeMap.get(classname);
  if (!recipe) {
    return { classname, displayName, amount, isBase: true, isCycle: false, children: [], toolsUsed: [] };
  }

  // How many times must this recipe actually be executed to get `amount`
  // units (a craft can yield more than one at once via ResultCount).
  const executions = Math.max(1, Math.ceil(amount / Math.max(1, recipe.node.resultCount || 1)));

  const nextPath = new Set(path);
  nextPath.add(classname);

  const children: ChainNode[] = [];
  const toolsUsed: ToolUse[] = [];
  recipe.components.forEach(c => {
    if (c.destroy) {
      children.push(resolveChain(c.classname, c.displayName, c.amount * executions, recipeMap, nextPath, toolTotals));
    } else {
      // Reusable tool — not consumed, just takes durability damage per craft.
      const craftable = recipeMap.has(c.classname);
      toolsUsed.push({ classname: c.classname, displayName: c.displayName, changehealth: c.changehealth, executions, craftable });

      const loss = c.changehealth * executions;
      const cur = toolTotals.get(c.classname);
      if (cur) { cur.totalChangehealth += loss; cur.uses += executions; }
      else toolTotals.set(c.classname, { classname: c.classname, displayName: c.displayName, totalChangehealth: loss, uses: executions, craftable });
    }
  });

  return { classname, displayName, amount, isBase: false, isCycle: false, children, toolsUsed };
}

function collectBaseTotals(chain: ChainNode, totals: Map<string, { displayName: string; amount: number }>): void {
  if (chain.isCycle) return;
  if (chain.isBase) {
    const cur = totals.get(chain.classname);
    if (cur) cur.amount += chain.amount;
    else totals.set(chain.classname, { displayName: chain.displayName, amount: chain.amount });
    return;
  }
  chain.children.forEach(c => collectBaseTotals(c, totals));
}

function collectChainClassnames(chain: ChainNode, into: Set<string>): void {
  if (chain.isCycle) return;
  into.add(chain.classname);
  chain.children.forEach(c => collectChainClassnames(c, into));
}

function fmtHealth(raw: number): { text: string; color: string } {
  if (raw < 0) return { text: `−${Math.abs(raw)} HP`, color: "var(--danger)" };
  if (raw > 0) return { text: `+${raw} HP`, color: "var(--success)" };
  return { text: "kein HP-Effekt", color: "var(--text-muted)" };
}

// ── UI ─────────────────────────────────────────────────────

export function openResourceChain(nodeId: string): void {
  const node = store.getNode(nodeId);
  if (!node) return;

  const recipeMap  = buildRecipeMap();
  const toolTotals = new Map<string, ToolTotal>();
  const root = resolveChain(node.classname, node.displayName || node.classname, 1, recipeMap, new Set(), toolTotals);

  const totals = new Map<string, { displayName: string; amount: number }>();
  root.children.forEach(c => collectBaseTotals(c, totals));
  const sortedTotals = [...totals.values()].sort((a, b) => b.amount - a.amount);
  const sortedTools  = [...toolTotals.values()].sort((a, b) => a.totalChangehealth - b.totalChangehealth);

  // ── Canvas highlight: colour every existing node whose classname is
  // part of this chain, so it's also visible directly in the node editor
  // while the modal is open (in addition to the diagram below).
  const materialClassnames = new Set<string>();
  collectChainClassnames(root, materialClassnames);
  const highlight = new Map<string, { color: string; dashed: boolean }>();
  materialClassnames.forEach(cn => {
    if (cn === root.classname) { highlight.set(cn, { color: "var(--accent)", dashed: false }); return; }
    highlight.set(cn, { color: recipeMap.has(cn) ? "var(--success)" : "var(--warning)", dashed: false });
  });
  sortedTools.forEach(t => {
    highlight.set(t.classname, { color: t.craftable ? "var(--success)" : "var(--warning)", dashed: true });
  });
  highlightClassnames(highlight);

  const diagramSvg = renderDiagram(root);

  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.style.alignItems = "flex-start";
  overlay.style.paddingTop = "24px";
  overlay.innerHTML = `
    <div class="modal" style="width:min(1100px,95vw);max-height:90vh;">
      <div class="modal-header">
        <span>🧬 Benötigte Ressourcen — ${esc(root.displayName)}</span>
        <button class="btn btn-ghost btn-icon" id="rc-close">✕</button>
      </div>
      <div class="modal-body" style="display:flex;flex-direction:column;gap:16px;">

        <div style="display:flex;gap:12px;flex-wrap:wrap;font-size:11px;color:var(--text-secondary);
          background:var(--bg-elevated);border:1px solid var(--border);border-radius:5px;padding:8px 10px;">
          <span><span style="display:inline-block;width:10px;height:10px;border-radius:2px;
            background:var(--accent);margin-right:4px;"></span>Gewähltes Item</span>
          <span><span style="display:inline-block;width:10px;height:10px;border-radius:2px;
            background:var(--success);margin-right:4px;"></span>Craftbar</span>
          <span><span style="display:inline-block;width:10px;height:10px;border-radius:2px;
            background:var(--warning);margin-right:4px;"></span>Muss gefunden werden</span>
          <span><span style="display:inline-block;width:10px;height:6px;border:2px dashed var(--text-secondary);
            margin-right:4px;"></span>Werkzeug (nicht verbraucht)</span>
        </div>

        <div>
          <div class="field-label" style="margin-bottom:6px;">Kette als Node-Diagramm</div>
          <div style="border:1px solid var(--border);border-radius:5px;background:var(--bg-base);
            max-height:400px;overflow:auto;">
            ${diagramSvg}
          </div>
        </div>

        <div style="display:flex;gap:16px;flex-wrap:wrap;">
          <div style="flex:1;min-width:220px;">
            <div class="field-label" style="margin-bottom:6px;">Basismaterialien gesamt (müssen gefunden werden)</div>
            ${sortedTotals.length === 0
              ? `<div style="font-size:12px;color:var(--text-muted);">Keine Basismaterialien.</div>`
              : `<div style="border:1px solid var(--border);border-radius:5px;background:var(--bg-elevated);overflow:hidden;">
                  ${sortedTotals.map(t => `
                    <div style="display:flex;justify-content:space-between;gap:10px;
                      padding:6px 10px;border-bottom:1px solid var(--border);font-size:12px;">
                      <span style="color:var(--text-primary);">${esc(t.displayName)}</span>
                      <span style="font-weight:600;color:var(--warning);">×${t.amount}</span>
                    </div>
                  `).join("")}
                </div>`
            }
          </div>

          ${sortedTools.length > 0 ? `
          <div style="flex:1;min-width:260px;">
            <div class="field-label" style="margin-bottom:6px;">Werkzeuge (werden nicht verbraucht)</div>
            <div style="border:1px solid var(--border);border-radius:5px;background:var(--bg-elevated);overflow:hidden;">
              ${sortedTools.map(t => {
                const h = fmtHealth(t.totalChangehealth);
                return `
                <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;
                  padding:6px 10px;border-bottom:1px solid var(--border);font-size:12px;">
                  <span style="color:var(--text-primary);">${esc(t.displayName)}
                    <span style="font-size:10px;padding:1px 6px;border-radius:8px;margin-left:6px;
                      background:${t.craftable ? "rgba(61,186,126,0.15)" : "rgba(232,168,64,0.15)"};
                      color:${t.craftable ? "var(--success)" : "var(--warning)"};">
                      ${t.craftable ? "craftbar" : "muss gefunden werden"}
                    </span>
                  </span>
                  <span style="font-weight:600;color:${h.color};white-space:nowrap;">
                    ${h.text}
                    <span style="color:var(--text-muted);font-weight:400;">(${t.uses}× benutzt)</span>
                  </span>
                </div>`;
              }).join("")}
            </div>
          </div>` : ""}
        </div>

      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary" id="rc-close2">Schließen</button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);
  const close = () => { overlay.remove(); clearClassnameHighlight(); };
  overlay.querySelector("#rc-close")! .addEventListener("click", close);
  overlay.querySelector("#rc-close2")!.addEventListener("click", close);
  overlay.addEventListener("click", e => { if (e.target === overlay) close(); });
}

// ── Node-diagram (SVG tree) ──────────────────────────────────

type DiagramKind = "root" | "craftable" | "base" | "tool-craftable" | "tool-base" | "cycle";

interface DiagramNode {
  displayName: string;
  amountLabel: string;
  kind: DiagramKind;
  children: DiagramNode[];
}

function toDiagram(n: ChainNode, isRoot: boolean): DiagramNode {
  const kind: DiagramKind = n.isCycle ? "cycle" : isRoot ? "root" : n.isBase ? "base" : "craftable";
  const toolChildren: DiagramNode[] = n.toolsUsed.map(t => {
    const h = fmtHealth(t.changehealth * t.executions);
    return {
      displayName: t.displayName,
      amountLabel: h.text,
      kind: (t.craftable ? "tool-craftable" : "tool-base") as DiagramKind,
      children: [],
    };
  });
  return {
    displayName: n.displayName,
    amountLabel: n.isCycle ? "Zyklus" : `×${n.amount}`,
    kind,
    children: [...n.children.map(c => toDiagram(c, false)), ...toolChildren],
  };
}

const DW = 156, DH = 44, GAP_X = 56, GAP_Y = 10;

function renderDiagram(root: ChainNode): string {
  const diagram = toDiagram(root, true);

  interface Positioned { node: DiagramNode; depth: number; x: number; y: number; }
  const positioned: Positioned[] = [];
  const edges: { x1: number; y1: number; x2: number; y2: number }[] = [];
  let leafY = 0;
  let maxDepth = 0;

  function visit(n: DiagramNode, depth: number): { x: number; y: number } {
    maxDepth = Math.max(maxDepth, depth);
    const x = depth * (DW + GAP_X);
    if (n.children.length === 0) {
      const y = leafY;
      leafY += DH + GAP_Y;
      positioned.push({ node: n, depth, x, y });
      return { x, y };
    }
    const childPos = n.children.map(c => visit(c, depth + 1));
    const y = (Math.min(...childPos.map(p => p.y)) + Math.max(...childPos.map(p => p.y))) / 2;
    positioned.push({ node: n, depth, x, y });
    childPos.forEach(cp => {
      edges.push({ x1: x + DW, y1: y + DH / 2, x2: cp.x, y2: cp.y + DH / 2 });
    });
    return { x, y };
  }
  visit(diagram, 0);

  const width  = (maxDepth + 1) * (DW + GAP_X) - GAP_X + 20;
  const height = Math.max(leafY, DH) + 20;

  const colorFor = (kind: DiagramKind): string =>
    kind === "root" ? "var(--accent)"
    : kind === "cycle" ? "var(--danger)"
    : kind === "base" || kind === "tool-base" ? "var(--warning)"
    : "var(--success)";

  const edgeSvg = edges.map(e => {
    const midX = (e.x1 + e.x2) / 2;
    return `<path d="M${e.x1 + 10},${e.y1} C${midX},${e.y1} ${midX},${e.y2} ${e.x2 - 10 + 10},${e.y2}"
      fill="none" stroke="var(--border)" stroke-width="2" />`;
  }).join("");

  const nodeSvg = positioned.map(p => {
    const color  = colorFor(p.node.kind);
    const dashed = p.node.kind === "tool-craftable" || p.node.kind === "tool-base";
    const x = p.x + 10, y = p.y + 10;
    return `
      <g>
        <rect x="${x}" y="${y}" width="${DW}" height="${DH}" rx="6"
          fill="var(--bg-elevated)" stroke="${color}" stroke-width="2"
          ${dashed ? 'stroke-dasharray="5,4"' : ""} />
        <text x="${x + 10}" y="${y + 18}" font-size="11" fill="var(--text-primary)"
          style="font-weight:600;">${escXml(truncate(p.node.displayName, 20))}</text>
        <text x="${x + 10}" y="${y + 33}" font-size="10" fill="${color}">${escXml(p.node.amountLabel)}</text>
      </g>`;
  }).join("");

  return `
    <svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"
      xmlns="http://www.w3.org/2000/svg" style="display:block;">
      ${edgeSvg}
      ${nodeSvg}
    </svg>`;
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

function escXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function esc(s: string): string {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

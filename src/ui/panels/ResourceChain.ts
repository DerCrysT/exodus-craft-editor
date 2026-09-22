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
//
// A classname can have more than one recipe in the project (several ways to
// obtain the same item) — the user can pick which one to use per classname,
// and everything (totals, diagram, highlight) recomputes in place.

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

// All recipes per classname — several node instances can produce the same
// classname via different component sets (several ways to obtain it).
function buildRecipeCandidates(): Map<string, RecipeInfo[]> {
  const nodes  = store.getNodes();
  const edges  = store.getEdges();
  const nodeById = new Map(nodes.map(n => [n.id, n]));
  const map = new Map<string, RecipeInfo[]>();

  nodes.forEach(n => {
    if (n.nodeType === "comment" || n.nodeType === "area") return;
    if (!n.classname) return;
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
    if (components.length === 0) return;
    const list = map.get(n.classname) ?? [];
    list.push({ node: n, components });
    map.set(n.classname, list);
  });

  return map;
}

function recipeLabel(recipe: RecipeInfo): string {
  return recipe.node.recipeName?.trim() || recipe.components.map(c => c.displayName).join(" + ");
}

function resolveChain(
  classname: string,
  displayName: string,
  amount: number,
  getRecipe: (cn: string) => RecipeInfo | undefined,
  hasRecipe: (cn: string) => boolean,
  path: Set<string>,
  toolTotals: Map<string, ToolTotal>,
): ChainNode {
  if (path.has(classname)) {
    return { classname, displayName, amount, isBase: false, isCycle: true, children: [], toolsUsed: [] };
  }
  const recipe = getRecipe(classname);
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
      children.push(resolveChain(c.classname, c.displayName, c.amount * executions, getRecipe, hasRecipe, nextPath, toolTotals));
    } else {
      // Reusable tool — not consumed, just takes durability damage per craft.
      const craftable = hasRecipe(c.classname);
      toolsUsed.push({ classname: c.classname, displayName: c.displayName, changehealth: c.changehealth, executions, craftable });

      const loss = c.changehealth * executions;
      const cur = toolTotals.get(c.classname);
      if (cur) { cur.totalChangehealth += loss; cur.uses += executions; }
      else toolTotals.set(c.classname, { classname: c.classname, displayName: c.displayName, totalChangehealth: loss, uses: executions, craftable });
    }
  });

  return { classname, displayName, amount, isBase: false, isCycle: false, children, toolsUsed };
}

function collectTotals(
  chain: ChainNode, isRoot: boolean,
  base: Map<string, { displayName: string; amount: number }>,
  intermediate: Map<string, { displayName: string; amount: number }>,
): void {
  if (chain.isCycle) return;
  if (!isRoot) {
    const target = chain.isBase ? base : intermediate;
    const cur = target.get(chain.classname);
    if (cur) cur.amount += chain.amount;
    else target.set(chain.classname, { displayName: chain.displayName, amount: chain.amount });
  }
  chain.children.forEach(c => collectTotals(c, false, base, intermediate));
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
  const maybeRootNode = store.getNode(nodeId);
  if (!maybeRootNode) return;
  const rootNode: CraftNode = maybeRootNode;

  const recipeCandidates = buildRecipeCandidates();
  const selectedIndex = new Map<string, number>(); // classname -> chosen candidate index
  const hasRecipe = (cn: string) => (recipeCandidates.get(cn)?.length ?? 0) > 0;
  const getRecipe = (cn: string): RecipeInfo | undefined => {
    const candidates = recipeCandidates.get(cn);
    if (!candidates || candidates.length === 0) return undefined;
    const idx = Math.min(selectedIndex.get(cn) ?? 0, candidates.length - 1);
    return candidates[idx];
  };
  // Default the root's own classname to the exact node instance that was
  // right-clicked, not just "whichever recipe happens to be first".
  const rootCandidates = recipeCandidates.get(rootNode.classname);
  const rootIdx = rootCandidates?.findIndex(r => r.node.id === rootNode.id) ?? -1;
  if (rootIdx >= 0) selectedIndex.set(rootNode.classname, rootIdx);

  let fullscreen = false;

  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.style.alignItems = "flex-start";
  overlay.style.paddingTop = "24px";
  overlay.innerHTML = `
    <div class="modal" id="rc-modal" style="display:flex;flex-direction:column;">
      <div class="modal-header">
        <span id="rc-title"></span>
        <div style="display:flex;gap:4px;">
          <button class="btn btn-ghost btn-icon" id="rc-fullscreen" title="Vollbild">⛶</button>
          <button class="btn btn-ghost btn-icon" id="rc-close" title="Schließen">✕</button>
        </div>
      </div>
      <div class="modal-body" id="rc-body" style="display:flex;flex-direction:column;gap:16px;flex:1;"></div>
      <div class="modal-footer">
        <button class="btn btn-secondary" id="rc-close2">Schließen</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const modalEl = overlay.querySelector("#rc-modal") as HTMLElement;
  const titleEl = overlay.querySelector("#rc-title") as HTMLElement;
  const bodyEl  = overlay.querySelector("#rc-body")  as HTMLElement;

  const applySize = () => {
    modalEl.style.width      = fullscreen ? "98vw" : "min(1100px,95vw)";
    modalEl.style.height     = fullscreen ? "94vh" : "";
    modalEl.style.maxHeight  = fullscreen ? "94vh" : "90vh";
  };

  function render(): void {
    const toolTotals = new Map<string, ToolTotal>();
    const root = resolveChain(
      rootNode.classname, rootNode.displayName || rootNode.classname, 1,
      getRecipe, hasRecipe, new Set(), toolTotals,
    );

    const baseTotals = new Map<string, { displayName: string; amount: number }>();
    const intermediateTotals = new Map<string, { displayName: string; amount: number }>();
    collectTotals(root, true, baseTotals, intermediateTotals);
    const sortedBase  = [...baseTotals.values()].sort((a, b) => b.amount - a.amount);
    const sortedInter = [...intermediateTotals.values()].sort((a, b) => b.amount - a.amount);
    const sortedTools = [...toolTotals.values()].sort((a, b) => a.totalChangehealth - b.totalChangehealth);

    // Canvas highlight — colour every existing node whose classname is part
    // of this chain, so it's also visible directly in the node editor.
    const materialClassnames = new Set<string>();
    collectChainClassnames(root, materialClassnames);
    const highlight = new Map<string, { color: string; dashed: boolean }>();
    materialClassnames.forEach(cn => {
      if (cn === root.classname) { highlight.set(cn, { color: "var(--accent)", dashed: false }); return; }
      highlight.set(cn, { color: hasRecipe(cn) ? "var(--success)" : "var(--warning)", dashed: false });
    });
    sortedTools.forEach(t => {
      highlight.set(t.classname, { color: t.craftable ? "var(--success)" : "var(--warning)", dashed: true });
    });
    highlightClassnames(highlight);

    // Alternative recipes: every classname used in the chain that has more
    // than one candidate recipe in the project.
    const ambiguous = [...new Set([...materialClassnames, ...toolTotals.keys()])]
      .filter(cn => (recipeCandidates.get(cn)?.length ?? 0) > 1);

    titleEl.textContent = `🧬 Benötigte Ressourcen — ${root.displayName}`;
    applySize();

    const diagramSvg = renderDiagram(root);

    bodyEl.innerHTML = `
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

      ${ambiguous.length > 0 ? `
      <div>
        <div class="field-label" style="margin-bottom:6px;">Alternative Rezepte</div>
        <div style="display:flex;flex-direction:column;gap:6px;">
          ${ambiguous.map(cn => {
            const candidates = recipeCandidates.get(cn)!;
            const idx = Math.min(selectedIndex.get(cn) ?? 0, candidates.length - 1);
            return `
            <label style="display:flex;align-items:center;gap:8px;font-size:12px;">
              <span style="min-width:140px;color:var(--text-primary);">${esc(cn)}</span>
              <select class="field-input rc-recipe-select" data-classname="${esc(cn)}" style="flex:1;">
                ${candidates.map((c, i) => `<option value="${i}" ${i === idx ? "selected" : ""}>${esc(recipeLabel(c))}</option>`).join("")}
              </select>
            </label>`;
          }).join("")}
        </div>
      </div>` : ""}

      <div>
        <div class="field-label" style="margin-bottom:6px;">Kette als Node-Diagramm</div>
        <div style="border:1px solid var(--border);border-radius:5px;background:var(--bg-base);
          max-height:${fullscreen ? "60vh" : "400px"};overflow:auto;">
          ${diagramSvg}
        </div>
      </div>

      <div style="display:flex;gap:16px;flex-wrap:wrap;">
        <div style="flex:1;min-width:220px;">
          <div class="field-label" style="margin-bottom:6px;">Basismaterialien gesamt (müssen gefunden werden)</div>
          ${sortedBase.length === 0
            ? `<div style="font-size:12px;color:var(--text-muted);">Keine Basismaterialien.</div>`
            : `<div style="border:1px solid var(--border);border-radius:5px;background:var(--bg-elevated);overflow:hidden;">
                ${sortedBase.map(t => `
                  <div style="display:flex;justify-content:space-between;gap:10px;
                    padding:6px 10px;border-bottom:1px solid var(--border);font-size:12px;">
                    <span style="color:var(--text-primary);">${esc(t.displayName)}</span>
                    <span style="font-weight:600;color:var(--warning);">×${t.amount}</span>
                  </div>
                `).join("")}
              </div>`
          }
        </div>

        <div style="flex:1;min-width:220px;">
          <div class="field-label" style="margin-bottom:6px;">Zwischenprodukte gesamt (craftbar)</div>
          ${sortedInter.length === 0
            ? `<div style="font-size:12px;color:var(--text-muted);">Keine Zwischenprodukte in der Kette.</div>`
            : `<div style="border:1px solid var(--border);border-radius:5px;background:var(--bg-elevated);overflow:hidden;">
                ${sortedInter.map(t => `
                  <div style="display:flex;justify-content:space-between;gap:10px;
                    padding:6px 10px;border-bottom:1px solid var(--border);font-size:12px;">
                    <span style="color:var(--text-primary);">${esc(t.displayName)}</span>
                    <span style="font-weight:600;color:var(--success);">×${t.amount}</span>
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
    `;

    bodyEl.querySelectorAll<HTMLSelectElement>(".rc-recipe-select").forEach(sel => {
      sel.addEventListener("change", () => {
        selectedIndex.set(sel.dataset.classname!, Number(sel.value));
        render();
      });
    });
  }

  render();

  const close = () => { overlay.remove(); clearClassnameHighlight(); };
  overlay.querySelector("#rc-close")! .addEventListener("click", close);
  overlay.querySelector("#rc-close2")!.addEventListener("click", close);
  overlay.querySelector("#rc-fullscreen")!.addEventListener("click", () => { fullscreen = !fullscreen; render(); });
  overlay.addEventListener("click", e => { if (e.target === overlay) close(); });
}

// ── Node-diagram (SVG tree) ──────────────────────────────────
// The finished item is on the RIGHT, its components fan out to the left —
// matching the direction components → result already used in the main
// node editor canvas.

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
  const pairs: { parent: Positioned; child: Positioned }[] = [];
  let leafY = 0;
  let maxDepth = 0;

  // First pass: assign depth + y (top-down x comes later, once maxDepth is known).
  function visit(n: DiagramNode, depth: number): Positioned {
    maxDepth = Math.max(maxDepth, depth);
    if (n.children.length === 0) {
      const y = leafY;
      leafY += DH + GAP_Y;
      const p: Positioned = { node: n, depth, x: 0, y };
      positioned.push(p);
      return p;
    }
    const childPs = n.children.map(c => visit(c, depth + 1));
    const y = (Math.min(...childPs.map(p => p.y)) + Math.max(...childPs.map(p => p.y))) / 2;
    const p: Positioned = { node: n, depth, x: 0, y };
    positioned.push(p);
    childPs.forEach(cp => pairs.push({ parent: p, child: cp }));
    return p;
  }
  visit(diagram, 0);

  // Second pass: mirror depth so the root (depth 0) ends up on the right,
  // components fan out to the left — same direction as the main canvas.
  positioned.forEach(p => { p.x = (maxDepth - p.depth) * (DW + GAP_X); });

  const width  = (maxDepth + 1) * (DW + GAP_X) - GAP_X + 20;
  const height = Math.max(leafY, DH) + 20;

  const colorFor = (kind: DiagramKind): string =>
    kind === "root" ? "var(--accent)"
    : kind === "cycle" ? "var(--danger)"
    : kind === "base" || kind === "tool-base" ? "var(--warning)"
    : "var(--success)";

  // Parent sits to the right of its child now: connect the parent's LEFT
  // edge to the child's RIGHT edge.
  const edgeSvg = pairs.map(({ parent, child }) => {
    const x1 = parent.x + 10;
    const y1 = parent.y + 10 + DH / 2;
    const x2 = child.x + 10 + DW;
    const y2 = child.y + 10 + DH / 2;
    const midX = (x1 + x2) / 2;
    return `<path d="M${x1},${y1} C${midX},${y1} ${midX},${y2} ${x2},${y2}"
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

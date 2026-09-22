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
// (Changehealth) they lose across every craft step that uses them, instead
// of being multiplied up like a consumed material.

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

interface ChainNode {
  classname: string;
  displayName: string;
  amount: number;    // total quantity needed at this point in the tree
  isBase: boolean;    // no recipe found anywhere → raw/base material, must be found
  isCycle: boolean;   // classname already an ancestor → stopped to avoid infinite recursion
  children: ChainNode[];
}

interface ToolUsage {
  classname: string;
  displayName: string;
  totalChangehealth: number;
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
  tools: Map<string, ToolUsage>,
): ChainNode {
  if (path.has(classname)) {
    return { classname, displayName, amount, isBase: false, isCycle: true, children: [] };
  }
  const recipe = recipeMap.get(classname);
  if (!recipe) {
    return { classname, displayName, amount, isBase: true, isCycle: false, children: [] };
  }

  // How many times must this recipe actually be executed to get `amount`
  // units (a craft can yield more than one at once via ResultCount).
  const executions = Math.max(1, Math.ceil(amount / Math.max(1, recipe.node.resultCount || 1)));

  const nextPath = new Set(path);
  nextPath.add(classname);

  const children: ChainNode[] = [];
  recipe.components.forEach(c => {
    if (c.destroy) {
      children.push(resolveChain(c.classname, c.displayName, c.amount * executions, recipeMap, nextPath, tools));
    } else {
      // Reusable tool — not consumed, just takes durability damage per craft.
      const loss = c.changehealth * executions;
      const cur = tools.get(c.classname);
      if (cur) { cur.totalChangehealth += loss; cur.uses += executions; }
      else tools.set(c.classname, {
        classname: c.classname, displayName: c.displayName,
        totalChangehealth: loss, uses: executions,
        craftable: recipeMap.has(c.classname),
      });
    }
  });

  return { classname, displayName, amount, isBase: false, isCycle: false, children };
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

// ── UI ─────────────────────────────────────────────────────

export function openResourceChain(nodeId: string): void {
  const node = store.getNode(nodeId);
  if (!node) return;

  const recipeMap = buildRecipeMap();
  const tools = new Map<string, ToolUsage>();
  const root = resolveChain(node.classname, node.displayName || node.classname, 1, recipeMap, new Set(), tools);

  const totals = new Map<string, { displayName: string; amount: number }>();
  root.children.forEach(c => collectBaseTotals(c, totals));
  const sortedTotals = [...totals.values()].sort((a, b) => b.amount - a.amount);
  const sortedTools  = [...tools.values()].sort((a, b) => b.totalChangehealth - a.totalChangehealth);

  // ── Canvas highlight: colour every existing node whose classname is
  // part of this chain, green light on the map style, so the chain is
  // visible directly in the node editor while the modal is open.
  const materialClassnames = new Set<string>();
  collectChainClassnames(root, materialClassnames);
  const highlight = new Map<string, { color: string; dashed: boolean }>();
  materialClassnames.forEach(cn => {
    if (cn === root.classname) { highlight.set(cn, { color: "var(--accent)", dashed: false }); return; }
    const isBaseCn = !recipeMap.has(cn);
    highlight.set(cn, { color: isBaseCn ? "var(--warning)" : "var(--success)", dashed: false });
  });
  sortedTools.forEach(t => {
    highlight.set(t.classname, { color: t.craftable ? "var(--success)" : "var(--warning)", dashed: true });
  });
  highlightClassnames(highlight);

  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `
    <div class="modal" style="width:560px;max-height:85vh;">
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
          <div class="field-label" style="margin-bottom:6px;">Basismaterialien gesamt (müssen gefunden werden)</div>
          ${sortedTotals.length === 0
            ? `<div style="font-size:12px;color:var(--text-muted);">Keine Basismaterialien — alle Zutaten sind bereits selbst craftbar oder es gibt keine Komponenten.</div>`
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
        <div>
          <div class="field-label" style="margin-bottom:6px;">Werkzeuge (werden nicht verbraucht)</div>
          <div style="border:1px solid var(--border);border-radius:5px;background:var(--bg-elevated);overflow:hidden;">
            ${sortedTools.map(t => `
              <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;
                padding:6px 10px;border-bottom:1px solid var(--border);font-size:12px;">
                <span style="color:var(--text-primary);">${esc(t.displayName)}
                  <span style="font-size:10px;padding:1px 6px;border-radius:8px;margin-left:6px;
                    background:${t.craftable ? "rgba(61,186,126,0.15)" : "rgba(232,168,64,0.15)"};
                    color:${t.craftable ? "var(--success)" : "var(--warning)"};">
                    ${t.craftable ? "craftbar" : "muss gefunden werden"}
                  </span>
                </span>
                <span style="font-weight:600;color:${t.totalChangehealth > 0 ? "var(--danger)" : "var(--text-muted)"};white-space:nowrap;">
                  ${t.totalChangehealth > 0 ? `−${t.totalChangehealth} HP` : "kein HP-Verlust"}
                  <span style="color:var(--text-muted);font-weight:400;">(${t.uses}× benutzt)</span>
                </span>
              </div>
            `).join("")}
          </div>
        </div>` : ""}

        <div>
          <div class="field-label" style="margin-bottom:6px;">Vollständige Kette</div>
          <div style="border:1px solid var(--border);border-radius:5px;background:var(--bg-elevated);
            max-height:280px;overflow-y:auto;padding:6px 0;">
            <div style="padding:4px 10px;font-size:12px;font-weight:600;color:var(--text-primary);">
              ×${root.amount} ${esc(root.displayName)}
            </div>
            ${root.children.map(c => renderChainRow(c, 1)).join("") ||
              `<div style="padding:4px 10px 8px 28px;font-size:11px;color:var(--text-muted);">Kein Rezept mit Komponenten hinterlegt</div>`}
          </div>
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

function renderChainRow(node: ChainNode, depth: number): string {
  const indent = 10 + depth * 18;
  const color  = node.isCycle ? "var(--danger)" : node.isBase ? "var(--warning)" : "var(--success)";
  const icon   = node.isCycle ? "🔁" : node.isBase ? "▪" : "⚙";
  const note   = node.isCycle ? ` <span style="color:var(--danger);">(Zyklus — Abbruch)</span>` : "";
  const badge  = node.isCycle ? "" : `
    <span style="font-size:9px;padding:0 5px;border-radius:7px;
      background:${node.isBase ? "rgba(232,168,64,0.15)" : "rgba(61,186,126,0.15)"};
      color:${node.isBase ? "var(--warning)" : "var(--success)"};">
      ${node.isBase ? "finden" : "craftbar"}
    </span>`;
  return `
    <div style="padding:3px 10px 3px ${indent}px;font-size:11px;color:${color};display:flex;gap:6px;align-items:center;">
      <span>${icon}</span>
      <span style="font-weight:600;">×${node.amount}</span>
      <span style="color:var(--text-primary);">${esc(node.displayName)}</span>
      ${badge}${note}
    </div>
    ${node.children.map(c => renderChainRow(c, depth + 1)).join("")}
  `;
}

function esc(s: string): string {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

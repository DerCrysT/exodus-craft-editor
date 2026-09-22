import { store } from "../../state/AppStore";
import type { CraftNode } from "../../types/index";

// ── Resource Chain ─────────────────────────────────────────
// Right-click a node → "Benötigte Ressourcen": recursively resolves every
// component back through ITS OWN recipe (wherever that recipe lives in the
// project — components are matched by classname, not by direct edge, since
// a component's recipe is usually drawn somewhere else entirely) down to
// the raw base materials, and totals them up.

interface RecipeInfo {
  node: CraftNode;
  components: { classname: string; displayName: string; amount: number }[];
}

interface ChainNode {
  classname: string;
  displayName: string;
  amount: number;    // total quantity needed at this point in the tree
  isBase: boolean;    // no recipe found anywhere → raw/base material
  isCycle: boolean;   // classname already an ancestor → stopped to avoid infinite recursion
  children: ChainNode[];
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
      .map(e => {
        const src = nodeById.get(e.sourceNodeId);
        return src ? { classname: src.classname, displayName: src.displayName || src.classname, amount: e.amount } : null;
      })
      .filter((c): c is RecipeInfo["components"][number] => c !== null && !!c.classname);
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
): ChainNode {
  if (path.has(classname)) {
    return { classname, displayName, amount, isBase: false, isCycle: true, children: [] };
  }
  const recipe = recipeMap.get(classname);
  if (!recipe) {
    return { classname, displayName, amount, isBase: true, isCycle: false, children: [] };
  }
  const nextPath = new Set(path);
  nextPath.add(classname);
  const children = recipe.components.map(c =>
    resolveChain(c.classname, c.displayName, c.amount * amount, recipeMap, nextPath)
  );
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

// ── UI ─────────────────────────────────────────────────────

export function openResourceChain(nodeId: string): void {
  const node = store.getNode(nodeId);
  if (!node) return;

  const recipeMap = buildRecipeMap();
  const root = resolveChain(node.classname, node.displayName || node.classname, 1, recipeMap, new Set());

  const totals = new Map<string, { displayName: string; amount: number }>();
  root.children.forEach(c => collectBaseTotals(c, totals));
  const sortedTotals = [...totals.values()].sort((a, b) => b.amount - a.amount);

  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `
    <div class="modal" style="width:520px;max-height:80vh;">
      <div class="modal-header">
        <span>🧬 Benötigte Ressourcen — ${esc(root.displayName)}</span>
        <button class="btn btn-ghost btn-icon" id="rc-close">✕</button>
      </div>
      <div class="modal-body" style="display:flex;flex-direction:column;gap:16px;">

        <div>
          <div class="field-label" style="margin-bottom:6px;">Basismaterialien gesamt</div>
          ${sortedTotals.length === 0
            ? `<div style="font-size:12px;color:var(--text-muted);">Keine Komponenten gefunden — für keine Zutat existiert ein eigenes Rezept.</div>`
            : `<div style="border:1px solid var(--border);border-radius:5px;background:var(--bg-elevated);overflow:hidden;">
                ${sortedTotals.map(t => `
                  <div style="display:flex;justify-content:space-between;gap:10px;
                    padding:6px 10px;border-bottom:1px solid var(--border);font-size:12px;">
                    <span style="color:var(--text-primary);">${esc(t.displayName)}</span>
                    <span style="font-weight:600;color:var(--accent);">×${t.amount}</span>
                  </div>
                `).join("")}
              </div>`
          }
        </div>

        <div>
          <div class="field-label" style="margin-bottom:6px;">Vollständige Kette</div>
          <div style="border:1px solid var(--border);border-radius:5px;background:var(--bg-elevated);
            max-height:320px;overflow-y:auto;padding:6px 0;">
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
  const close = () => overlay.remove();
  overlay.querySelector("#rc-close")! .addEventListener("click", close);
  overlay.querySelector("#rc-close2")!.addEventListener("click", close);
  overlay.addEventListener("click", e => { if (e.target === overlay) close(); });
}

function renderChainRow(node: ChainNode, depth: number): string {
  const indent = 10 + depth * 18;
  const color  = node.isCycle ? "var(--danger)" : node.isBase ? "var(--text-secondary)" : "var(--text-primary)";
  const icon   = node.isCycle ? "🔁" : node.isBase ? "▪" : "⚙";
  const note   = node.isCycle ? ` <span style="color:var(--danger);">(Zyklus — Abbruch)</span>` : "";
  return `
    <div style="padding:3px 10px 3px ${indent}px;font-size:11px;color:${color};display:flex;gap:6px;align-items:baseline;">
      <span>${icon}</span>
      <span style="font-weight:600;">×${node.amount}</span>
      <span>${esc(node.displayName)}</span>
      ${note}
    </div>
    ${node.children.map(c => renderChainRow(c, depth + 1)).join("")}
  `;
}

function esc(s: string): string {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

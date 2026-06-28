import type { CraftNode, CraftEdge, WorkbenchJSON, CraftItem, CraftCategory } from "../types/index";
import { store } from "../state/AppStore";
import { bus } from "../state/EventEmitter";

let syncing = false; // re-entrancy guard

/**
 * Converts the current node graph into WorkbenchJSON CraftCategories.
 * Each node that has at least one incoming edge becomes a recipe Result.
 * Each incoming edge's source node becomes a CraftComponent.
 */
export function syncNodesToJSON(): void {
  if (syncing) return;
  const nodes = store.getNodes();
  const edges = store.getEdges();
  const json = store.getJSON();

  if (nodes.length === 0) return;

  // Build adjacency: targetNodeId → list of (sourceNode, edge)
  // Skip comment nodes — they are canvas annotations only
  const incoming = new Map<string, Array<{ node: CraftNode; edge: CraftEdge }>>();
  nodes.filter(n => n.nodeType !== "comment").forEach(n => incoming.set(n.id, []));
  edges.forEach(e => {
    incoming.get(e.targetNodeId)?.push({ node: store.getNode(e.sourceNodeId)!, edge: e });
  });

  // Group result nodes by category
  const byCategory = new Map<string, CraftItem[]>();

  nodes.forEach(resultNode => {
    const components = incoming.get(resultNode.id) ?? [];
    if (components.length === 0) return; // no inputs = not a result

    const category = resultNode.category || "Allgemein";
    if (!byCategory.has(category)) byCategory.set(category, []);

    const item: CraftItem = {
      Result: resultNode.classname,
      ResultShow: resultNode.displayName || resultNode.classname,
      ResultCount: resultNode.resultCount ?? 1,
      ComponentsDontAffectHealth: resultNode.componentsDontAffectHealth ?? 0,
      CraftType: resultNode.craftType ?? "craft",
      RecipeName: resultNode.recipeName || resultNode.displayName || resultNode.classname,
      CraftComponents: components.filter(c => c.node).map(c => ({
        Classname: c.node.classname,
        Amount: c.edge.amount,
        Destroy: c.edge.destroy,
        Changehealth: c.edge.changehealth,
      })),
      AttachmentsNeed: resultNode.attachmentsNeed ?? [],
    };

    byCategory.get(category)!.push(item);
  });

  const newCategories: CraftCategory[] = [];
  byCategory.forEach((items, name) => {
    newCategories.push({ CategoryName: name, CraftItems: items });
  });

  // Preserve categories that have items not in the graph (manual form entries)
  const graphResultClassnames = new Set(nodes.map(n => n.classname));
  json.CraftCategories.forEach(cat => {
    const manualItems = cat.CraftItems.filter(item => !graphResultClassnames.has(item.Result));
    if (manualItems.length > 0) {
      const existing = newCategories.find(c => c.CategoryName === cat.CategoryName);
      if (existing) {
        existing.CraftItems.push(...manualItems);
      } else {
        newCategories.push({ CategoryName: cat.CategoryName, CraftItems: manualItems });
      }
    }
  });

  syncing = true;
  store.updateJSON({ CraftCategories: newCategories });
  syncing = false;
}

let _nodeCounter = 0;

/**
 * Syncs WorkbenchJSON → Node canvas.
 * - Creates nodes for new CraftItems/Components not yet in canvas.
 * - Updates existing nodes (recipeName, craftType, resultCount etc.) if they already exist.
 * Called when form editor makes changes.
 */
export function syncJSONToNodes(json: WorkbenchJSON): void {
  if (syncing) return;
  syncing = true;

  try {
    const existingNodes = store.getNodes();
    const byClassname   = new Map(existingNodes.map(n => [n.classname, n]));

    // Proper overlap check: test rect against all existing node rects
    const NODE_W = 184, NODE_H = 100, PAD = 16;
    const occupiedRects = existingNodes
      .filter(n => n.nodeType !== "comment")
      .map(n => ({ x: n.position.x, y: n.position.y }));

    const overlaps = (x: number, y: number): boolean =>
      occupiedRects.some(r =>
        x < r.x + NODE_W + PAD && x + NODE_W + PAD > r.x &&
        y < r.y + NODE_H + PAD && y + NODE_H + PAD > r.y
      );

    // Find a free grid position with no overlap
    const STEP_X = NODE_W + PAD, STEP_Y = NODE_H + PAD;
    const PER_ROW = 5;
    let slotIdx = 0;

    const getFreePos = (): { x: number; y: number } => {
      while (true) {
        const col = slotIdx % PER_ROW;
        const row = Math.floor(slotIdx / PER_ROW);
        slotIdx++;
        const x = col * STEP_X + 40;
        const y = row * STEP_Y + 40;
        if (!overlaps(x, y)) {
          occupiedRects.push({ x, y }); // mark as taken
          return { x, y };
        }
      }
    };

    const newId = () => `node_form_${Date.now()}_${++_nodeCounter}`;

    // ── Pass 1: ensure all result + component nodes exist ────
    json.CraftCategories.forEach(cat => {
      cat.CraftItems.forEach(item => {
        // Skip incomplete items (no Result classname yet — still being edited in form)
        if (!item.Result || !item.Result.trim()) return;

        const existing = byClassname.get(item.Result);
        if (existing) {
          store.updateNode(existing.id, {
            recipeName:                 item.RecipeName,
            craftType:                  item.CraftType,
            resultCount:                item.ResultCount,
            componentsDontAffectHealth: item.ComponentsDontAffectHealth,
            attachmentsNeed:            item.AttachmentsNeed,
            category:                   cat.CategoryName,
          });
        } else {
          const lib = store.getLibrary().find(l => l.classname === item.Result);
          const pos = getFreePos();
          const id  = newId();
          store.addNode({
            id, classname: item.Result, displayName: item.Result,
            imageUrl: lib?.imageUrl, position: pos,
            craftType: item.CraftType, resultCount: item.ResultCount,
            componentsDontAffectHealth: item.ComponentsDontAffectHealth,
            recipeName: item.RecipeName, attachmentsNeed: item.AttachmentsNeed,
            category: cat.CategoryName,
          });
          byClassname.set(item.Result, store.getNode(id)!);
        }

        item.CraftComponents.forEach(comp => {
          if (!byClassname.has(comp.Classname)) {
            const lib = store.getLibrary().find(l => l.classname === comp.Classname);
            const pos = getFreePos();
            const id  = newId();
            store.addNode({
              id, classname: comp.Classname, displayName: comp.Classname,
              imageUrl: lib?.imageUrl, position: pos,
              craftType: "craft", resultCount: 1,
            });
            byClassname.set(comp.Classname, store.getNode(id)!);
          }
        });
      });
    });

    // ── Pass 2: ensure all edges exist ───────────────────────
    // Re-read nodes after all addNode calls
    const freshNodes = store.getNodes();
    const nodeById   = new Map(freshNodes.map(n => [n.id, n]));
    const byClassnameId = new Map(freshNodes.map(n => [n.classname, n.id]));

    // Build set of existing edges (src→tgt)
    const existingEdges = new Set(
      store.getEdges().map(e => `${e.sourceNodeId}→${e.targetNodeId}`)
    );

    json.CraftCategories.forEach(cat => {
      cat.CraftItems.forEach(item => {
        const resultNodeId = byClassnameId.get(item.Result);
        if (!resultNodeId) return;

        item.CraftComponents.forEach(comp => {
          const compNodeId = byClassnameId.get(comp.Classname);
          if (!compNodeId) return;

          // Edge goes: component (source/OUT) → result (target/IN)
          const edgeKey = `${compNodeId}→${resultNodeId}`;
          if (!existingEdges.has(edgeKey)) {
            store.addEdge({
              id:           `edge_form_${Date.now()}_${++_nodeCounter}`,
              sourceNodeId: compNodeId,
              targetNodeId: resultNodeId,
              amount:       comp.Amount,
              destroy:      comp.Destroy,
              changehealth: comp.Changehealth,
            });
            existingEdges.add(edgeKey);
          }
        });
      });
    });

  } finally {
    syncing = false;
  }
}

// Auto-sync: whenever nodes/edges change, update JSON
export function initAutoSync(): void {
  bus.on("node:add",    () => syncNodesToJSON());
  bus.on("node:update", () => syncNodesToJSON());
  bus.on("edge:add",    () => syncNodesToJSON());
  bus.on("edge:remove", () => syncNodesToJSON());
  bus.on("node:remove", () => syncNodesToJSON());

  // JSON changed from Form Editor → create missing nodes in canvas
  // syncing guard prevents the loop: node:add→syncNodesToJSON→updateJSON→json:formUpdate→syncJSONToNodes→node:add
  bus.on("json:formUpdate", () => {
    if (syncing) return;
    syncJSONToNodes(store.getJSON());
  });

  // JSON file import → create nodes
  bus.on("json:import", (e) => {
    const json = (e as { payload: WorkbenchJSON }).payload;
    if (json) syncJSONToNodes(json);
  });
}

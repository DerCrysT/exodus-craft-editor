import type { CraftNode, CraftEdge, WorkbenchJSON, ValidationIssue } from "../types/index";

let issueCounter = 0;
function nextId(): string { return `v_${++issueCounter}`; }

export function runValidation(
  nodes: CraftNode[],
  edges: CraftEdge[],
  json: WorkbenchJSON
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  // 1. Missing classnames on nodes
  nodes.forEach(n => {
    if (!n.classname) {
      issues.push({ id: nextId(), severity: "error", message: `Node "${n.id}": Classname fehlt`, nodeId: n.id });
    }
    if (!n.displayName) {
      issues.push({ id: nextId(), severity: "warning", message: `Node "${n.classname}": Anzeigename fehlt`, nodeId: n.id });
    }
  });

  // 2. Broken edges
  const nodeIds = new Set(nodes.map(n => n.id));
  edges.forEach(e => {
    if (!nodeIds.has(e.sourceNodeId)) {
      issues.push({ id: nextId(), severity: "error", message: `Edge ${e.id}: Quellnode "${e.sourceNodeId}" nicht gefunden`, edgeId: e.id });
    }
    if (!nodeIds.has(e.targetNodeId)) {
      issues.push({ id: nextId(), severity: "error", message: `Edge ${e.id}: Zielnode "${e.targetNodeId}" nicht gefunden`, edgeId: e.id });
    }
    if (e.amount < 1) {
      issues.push({ id: nextId(), severity: "warning", message: `Edge ${e.id}: Amount sollte >= 1 sein`, edgeId: e.id });
    }
  });

  // 3. Cycle detection (DFS)
  const cycles = detectCycles(nodes, edges);
  cycles.forEach(cycle => {
    issues.push({ id: nextId(), severity: "error", message: `Zyklische Abhängigkeit: ${cycle.join(" → ")}` });
  });

  // 4. Unreachable nodes (no edges at all)
  if (nodes.length > 1) {
    const connected = new Set<string>();
    edges.forEach(e => { connected.add(e.sourceNodeId); connected.add(e.targetNodeId); });
    nodes.forEach(n => {
      if (!connected.has(n.id)) {
        issues.push({ id: nextId(), severity: "info", message: `Node "${n.classname || n.id}": Nicht verbunden`, nodeId: n.id });
      }
    });
  }

  // 5. JSON: duplicate RecipeNames
  const seen = new Set<string>();
  json.CraftCategories.forEach(cat => {
    cat.CraftItems.forEach((item, i) => {
      const key = item.RecipeName.trim().toLowerCase();
      if (key && seen.has(key)) {
        issues.push({ id: nextId(), severity: "warning", message: `Doppelter Rezeptname: "${item.RecipeName}" (Kategorie ${cat.CategoryName})`, recipeIndex: i });
      }
      seen.add(key);
    });
  });

  // 6. JSON: empty result classnames
  json.CraftCategories.forEach(cat => {
    cat.CraftItems.forEach((item, i) => {
      if (!item.Result) {
        issues.push({ id: nextId(), severity: "error", message: `Rezept ${i} in "${cat.CategoryName}": Result-Classname fehlt`, recipeIndex: i });
      }
      item.CraftComponents.forEach((comp, ci) => {
        if (!comp.Classname) {
          issues.push({ id: nextId(), severity: "error", message: `Rezept "${item.RecipeName}" Komponente ${ci}: Classname fehlt`, recipeIndex: i });
        }
      });
    });
  });

  return issues;
}

function detectCycles(nodes: CraftNode[], edges: CraftEdge[]): string[][] {
  const adj = new Map<string, string[]>();
  nodes.forEach(n => adj.set(n.id, []));
  edges.forEach(e => {
    if (adj.has(e.sourceNodeId)) {
      adj.get(e.sourceNodeId)!.push(e.targetNodeId);
    }
  });

  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<string, number>();
  const parent = new Map<string, string>();
  nodes.forEach(n => color.set(n.id, WHITE));

  const cycles: string[][] = [];
  const nodeMap = new Map(nodes.map(n => [n.id, n]));

  function dfs(u: string): void {
    color.set(u, GRAY);
    for (const v of (adj.get(u) ?? [])) {
      if (color.get(v) === GRAY) {
        // Found cycle — trace back
        const cycle: string[] = [];
        let cur = u;
        while (cur !== v) {
          cycle.unshift(nodeMap.get(cur)?.classname ?? cur);
          cur = parent.get(cur) ?? v;
        }
        cycle.unshift(nodeMap.get(v)?.classname ?? v);
        cycle.push(nodeMap.get(v)?.classname ?? v);
        cycles.push(cycle);
      } else if (color.get(v) === WHITE) {
        parent.set(v, u);
        dfs(v);
      }
    }
    color.set(u, BLACK);
  }

  nodes.forEach(n => {
    if (color.get(n.id) === WHITE) dfs(n.id);
  });

  return cycles;
}

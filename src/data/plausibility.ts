import { store } from "../state/AppStore";
import { collectAllRecipeInfos, median } from "./suggestionEngine";

// ── Plausibilitäts-Check ──────────────────────────────────────
// Vergleicht jede Kante im aktuell offenen Projekt mit dem Median-Wert,
// den dieselbe Komponente über ALLE Werkbänke hinweg sonst hat, und
// meldet starke Ausreißer (>3x oder <1/3 des Medians). Akzeptierte
// Ausreißer werden je Kante+Wert gemerkt, damit sie nicht erneut
// gemeldet werden, solange sich der Wert nicht wieder ändert.

export interface PlausibilityIssue {
  id: string;
  edgeId: string;
  nodeId: string; // target node, zum Hinspringen
  message: string;
  currentValue: number;
  medianValue: number;
  sampleSize: number;
}

const ACCEPTED_KEY = "exodus_plausibility_accepted";

function loadAccepted(): Record<string, number> {
  try { return JSON.parse(localStorage.getItem(ACCEPTED_KEY) ?? "{}"); } catch { return {}; }
}
function saveAccepted(data: Record<string, number>): void {
  try { localStorage.setItem(ACCEPTED_KEY, JSON.stringify(data)); } catch { /* ignore */ }
}

export function acceptPlausibilityValue(edgeId: string, value: number): void {
  const data = loadAccepted();
  data[edgeId] = value;
  saveAccepted(data);
}

function isAccepted(accepted: Record<string, number>, edgeId: string, value: number): boolean {
  return accepted[edgeId] === value;
}

const MIN_SAMPLE = 3;
const OUTLIER_FACTOR = 3;

export function runPlausibilityCheck(): PlausibilityIssue[] {
  const nodes = store.getNodes();
  const edges = store.getEdges();
  const nodeById = new Map(nodes.map(n => [n.id, n]));
  const accepted = loadAccepted();

  const amountsByClassname = new Map<string, number[]>();
  const healthByClassname  = new Map<string, number[]>();
  collectAllRecipeInfos().forEach(info => {
    info.components.forEach(c => {
      if (c.destroy) {
        const arr = amountsByClassname.get(c.classname) ?? [];
        arr.push(c.amount);
        amountsByClassname.set(c.classname, arr);
      } else {
        const arr = healthByClassname.get(c.classname) ?? [];
        arr.push(Math.abs(c.changehealth));
        healthByClassname.set(c.classname, arr);
      }
    });
  });

  const issues: PlausibilityIssue[] = [];

  edges.forEach(e => {
    const src = nodeById.get(e.sourceNodeId);
    const tgt = nodeById.get(e.targetNodeId);
    if (!src || !tgt) return; // reported separately by runValidation

    if (e.destroy) {
      const samples = amountsByClassname.get(src.classname);
      if (!samples || samples.length < MIN_SAMPLE) return;
      const med = median(samples);
      if (med <= 0) return;
      const isOutlier = e.amount > med * OUTLIER_FACTOR || e.amount < med / OUTLIER_FACTOR;
      if (isOutlier && !isAccepted(accepted, e.id, e.amount)) {
        issues.push({
          id: `pl_${e.id}`, edgeId: e.id, nodeId: tgt.id,
          message: `${src.displayName || src.classname} → ${tgt.displayName || tgt.classname}: Menge ×${e.amount} weicht stark vom Median ×${med} ab (${samples.length} Vergleichswerte)`,
          currentValue: e.amount, medianValue: med, sampleSize: samples.length,
        });
      }
    } else {
      const samples = healthByClassname.get(src.classname);
      if (!samples || samples.length < MIN_SAMPLE) return;
      const med = median(samples);
      if (med <= 0) return;
      const abs = Math.abs(e.changehealth);
      const isOutlier = abs > med * OUTLIER_FACTOR || abs < med / OUTLIER_FACTOR;
      if (isOutlier && !isAccepted(accepted, e.id, e.changehealth)) {
        issues.push({
          id: `pl_${e.id}`, edgeId: e.id, nodeId: tgt.id,
          message: `${src.displayName || src.classname} (Werkzeug) → ${tgt.displayName || tgt.classname}: Changehealth ${e.changehealth} weicht stark vom Median ±${med} ab (${samples.length} Vergleichswerte)`,
          currentValue: e.changehealth, medianValue: med, sampleSize: samples.length,
        });
      }
    }
  });

  return issues;
}

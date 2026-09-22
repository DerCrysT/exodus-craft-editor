import { store } from "../state/AppStore";
import type { CraftNode, CraftEdge, LibraryItem } from "../types/index";

// ── Auto-Vervollständigen: Vorschlags-Engine ─────────────────
// Schaut sich ALLE Rezepte über ALLE Werkbänke/Fraktionen hinweg an
// (nicht nur den aktuell geladenen Workspace — dafür werden alle
// "exodus_ws_*" localStorage-Keys gelesen), zählt pro Zielkategorie
// (Tierstufe, falls gesetzt) wie oft welche Komponente vorkommt, und
// schlägt die häufigsten vor. Lernt aus Annahme/Ablehnung über Zeit.

interface RecipeComponent {
  classname: string;
  displayName: string;
  amount: number;
  destroy: boolean;
  changehealth: number;
}

export interface RecipeInfo {
  resultClassname: string;
  components: RecipeComponent[];
}

export interface ComponentSuggestion {
  classname: string;
  displayName: string;
  amount: number;
  destroy: boolean;
  changehealth: number;
  frequency: number;   // wie viele Vergleichsrezepte diese Komponente nutzen
  poolSize: number;     // Größe des Vergleichspools
  source: "stats" | "text";
}

// ── All-workspace data collection ────────────────────────────

function extractRecipeInfos(nodes: CraftNode[], edges: CraftEdge[]): RecipeInfo[] {
  const nodeById = new Map(nodes.map(n => [n.id, n]));
  const infos: RecipeInfo[] = [];
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
    if (components.length > 0) infos.push({ resultClassname: n.classname, components });
  });
  return infos;
}

// Reads every workbench/faction workspace from localStorage, plus the live
// (possibly not-yet-autosaved) state of the currently active one.
export function collectAllRecipeInfos(): RecipeInfo[] {
  const infos: RecipeInfo[] = [];
  const currentKey = `exodus_ws_${store.currentWorkspaceKey()}`;

  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key || !key.startsWith("exodus_ws_") || key === currentKey) continue;
    try {
      const raw = localStorage.getItem(key);
      if (!raw) continue;
      const project = JSON.parse(raw) as { nodes?: CraftNode[]; edges?: CraftEdge[] };
      infos.push(...extractRecipeInfos(project.nodes ?? [], project.edges ?? []));
    } catch { /* skip corrupt entry */ }
  }

  infos.push(...extractRecipeInfos(store.getNodes(), store.getEdges()));
  return infos;
}

// ── Tier lookup ───────────────────────────────────────────────

export function getLibraryTier(classname: string): number | undefined {
  return store.getLibrary().find(i => i.classname === classname)?.tier;
}

// ── Pool selection (tier fallback chain) ─────────────────────

const MIN_POOL = 3;

function selectPool(allInfos: RecipeInfo[], targetTier: number | undefined): { pool: RecipeInfo[]; usedTier: boolean } {
  if (targetTier != null) {
    const sameTier = allInfos.filter(i => getLibraryTier(i.resultClassname) === targetTier);
    if (sameTier.length >= MIN_POOL) return { pool: sameTier, usedTier: true };

    const nearTier = allInfos.filter(i => {
      const t = getLibraryTier(i.resultClassname);
      return t != null && Math.abs(t - targetTier) <= 1;
    });
    if (nearTier.length >= MIN_POOL) return { pool: nearTier, usedTier: true };
  }
  return { pool: allInfos, usedTier: false };
}

export function median(nums: number[]): number {
  if (nums.length === 0) return 0;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

// ── Learned feedback (accept/reject) ──────────────────────────
// Simple global weighting per component classname: if a suggestion keeps
// getting rejected in favour of something else, push it down the ranking;
// if it keeps getting accepted, push it up.

const FEEDBACK_KEY = "exodus_suggestion_feedback";
interface FeedbackEntry { accepted: number; rejected: number; }

function loadFeedback(): Record<string, FeedbackEntry> {
  try { return JSON.parse(localStorage.getItem(FEEDBACK_KEY) ?? "{}"); } catch { return {}; }
}
function saveFeedback(data: Record<string, FeedbackEntry>): void {
  try { localStorage.setItem(FEEDBACK_KEY, JSON.stringify(data)); } catch { /* ignore */ }
}

export function recordSuggestionFeedback(classname: string, kind: "accepted" | "rejected"): void {
  const data = loadFeedback();
  const entry = data[classname] ?? { accepted: 0, rejected: 0 };
  entry[kind]++;
  data[classname] = entry;
  saveFeedback(data);
}

function feedbackMultiplier(classname: string): number {
  const entry = loadFeedback()[classname];
  if (!entry) return 1;
  const total = entry.accepted + entry.rejected;
  if (total === 0) return 1;
  const ratio = entry.accepted / total; // 0..1
  return 0.3 + ratio * 1.2; // consistently rejected → ~0.3x, consistently accepted → ~1.5x
}

// ── Statistics-based suggestions ─────────────────────────────

export interface SuggestionResult {
  suggestions: ComponentSuggestion[];
  textSuggestions: ComponentSuggestion[];
  poolSize: number;
  usedTier: boolean;
  targetTier: number | undefined;
}

export function buildSuggestions(targetClassname: string, targetDisplayName: string): SuggestionResult {
  const allInfos  = collectAllRecipeInfos().filter(i => i.resultClassname !== targetClassname);
  const targetTier = getLibraryTier(targetClassname);
  const { pool, usedTier } = selectPool(allInfos, targetTier);

  const map = new Map<string, { displayName: string; amounts: number[]; destroyTrue: number; destroyFalse: number; changehealths: number[] }>();
  pool.forEach(info => {
    info.components.forEach(c => {
      let e = map.get(c.classname);
      if (!e) { e = { displayName: c.displayName, amounts: [], destroyTrue: 0, destroyFalse: 0, changehealths: [] }; map.set(c.classname, e); }
      e.amounts.push(c.amount);
      if (c.destroy) e.destroyTrue++; else { e.destroyFalse++; e.changehealths.push(c.changehealth); }
    });
  });

  const statSuggestions: ComponentSuggestion[] = [...map.entries()].map(([classname, e]) => ({
    classname,
    displayName: e.displayName,
    amount: median(e.amounts) || 1,
    destroy: e.destroyTrue >= e.destroyFalse,
    changehealth: e.changehealths.length ? median(e.changehealths) : 0,
    frequency: e.amounts.length,
    poolSize: pool.length,
    source: "stats" as const,
  }))
    .sort((a, b) => (b.frequency * feedbackMultiplier(b.classname)) - (a.frequency * feedbackMultiplier(a.classname)))
    .slice(0, 8);

  const covered = new Set(statSuggestions.map(s => s.classname));
  const textSuggestions = textMatches(targetClassname, targetDisplayName, covered)
    .map(t => ({
      classname: t.classname, displayName: t.displayName,
      amount: 1, destroy: true, changehealth: 0,
      frequency: 0, poolSize: pool.length,
      source: "text" as const,
    }));

  return { suggestions: statSuggestions, textSuggestions, poolSize: pool.length, usedTier, targetTier };
}

// ── Text-similarity fallback ──────────────────────────────────
// No live AI here (static site, no backend) — this is a plain keyword
// overlap heuristic. Reasonably effective as long as displaynames are
// consistently in one language, but it can't bridge e.g. a German
// displayname against an English-only classname the way real semantic
// matching could.

function tokenize(s: string): string[] {
  return s
    .replace(/^Exodus_(Crafting_|WB_)?/i, "")
    .split(/[_\s]+|(?=[A-ZÄÖÜ][a-zäöüß])/)
    .map(t => t.toLowerCase())
    .filter(t => t.length > 2);
}

function textMatches(targetClassname: string, targetDisplayName: string, exclude: Set<string>): { classname: string; displayName: string; score: number }[] {
  const targetTokens = new Set([...tokenize(targetClassname), ...tokenize(targetDisplayName)]);
  if (targetTokens.size === 0) return [];

  const results: { classname: string; displayName: string; score: number }[] = [];
  store.getLibrary().forEach((item: LibraryItem) => {
    if (item.classname === targetClassname || exclude.has(item.classname)) return;
    const itemTokens = new Set([
      ...tokenize(item.classname), ...tokenize(item.displayName),
      ...(item.tags ?? []).flatMap(tokenize),
    ]);
    let overlap = 0;
    itemTokens.forEach(t => { if (targetTokens.has(t)) overlap++; });
    if (overlap > 0) results.push({ classname: item.classname, displayName: item.displayName, score: overlap });
  });

  return results.sort((a, b) => b.score - a.score).slice(0, 5);
}

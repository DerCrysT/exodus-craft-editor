import type { CraftNode } from "../types/index";

// ── Clipboard ──────────────────────────────────────────────
// Stored in localStorage so it persists across workspace/faction switches
// and reloads. Also kept in memory as a fallback in case localStorage is
// blocked (private browsing, strict site-data settings, etc.) — without
// this, copy/paste would silently do nothing on such browsers even though
// the "kopiert" toast still shows.
const CLIPBOARD_KEY = "exodus_node_clipboard";

export interface ClipboardEntry {
  nodes: CraftNode[];
  timestamp: number;
  sourceWorkspace: string;
}

let memoryClipboard: ClipboardEntry | null = null;

export function copyNodesToClipboard(nodes: CraftNode[], workspace: string): void {
  const entry: ClipboardEntry = {
    nodes: nodes.map(n => ({ ...JSON.parse(JSON.stringify(n)) })),
    timestamp: Date.now(),
    sourceWorkspace: workspace,
  };
  memoryClipboard = entry;
  try {
    localStorage.setItem(CLIPBOARD_KEY, JSON.stringify(entry));
  } catch {}
}

export function getClipboard(): ClipboardEntry | null {
  try {
    const raw = localStorage.getItem(CLIPBOARD_KEY);
    if (raw) return JSON.parse(raw);
  } catch {}
  return memoryClipboard;
}

export function clearClipboard(): void {
  memoryClipboard = null;
  try {
    localStorage.removeItem(CLIPBOARD_KEY);
  } catch {}
}

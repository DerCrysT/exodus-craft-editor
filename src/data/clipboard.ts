import type { CraftNode } from "../types/index";

// ── Clipboard ──────────────────────────────────────────────
// Stored in localStorage so it persists across workspace/faction switches
const CLIPBOARD_KEY = "exodus_node_clipboard";

export interface ClipboardEntry {
  nodes: CraftNode[];
  timestamp: number;
  sourceWorkspace: string;
}

export function copyNodesToClipboard(nodes: CraftNode[], workspace: string): void {
  const entry: ClipboardEntry = {
    nodes: nodes.map(n => ({ ...JSON.parse(JSON.stringify(n)) })),
    timestamp: Date.now(),
    sourceWorkspace: workspace,
  };
  try {
    localStorage.setItem(CLIPBOARD_KEY, JSON.stringify(entry));
  } catch {}
}

export function getClipboard(): ClipboardEntry | null {
  try {
    const raw = localStorage.getItem(CLIPBOARD_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function clearClipboard(): void {
  localStorage.removeItem(CLIPBOARD_KEY);
}

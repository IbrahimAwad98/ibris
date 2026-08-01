// Pure session-restore planning; persistence wiring lives in tabs-store.
import type { SidebarTab } from "../state/ui-store";
import type { FitMode } from "../state/viewer-store";

/** Everything needed to put a document back the way the user left it.
 * Rotation is deliberately absent since M3: it is a document *edit*
 * (command stack + sidecar), not view state. */
export interface SavedView {
  scale: number;
  fitMode: FitMode;
  page: number;
  /** Display-space points below the top of `page`. */
  yPt: number;
  sidebarOpen: boolean;
  sidebarTab: SidebarTab;
}

export interface RecentEntry {
  path: string;
  title: string;
  pageCount: number;
  /** Data URL, captured from the first page preview when available. */
  thumbnail?: string;
  lastOpened: number;
  /** Set when the file could not be found at its last known path. */
  missing?: boolean;
}

export interface SavedSession {
  paths: string[];
  activeIndex: number;
  viewByPath: Record<string, SavedView>;
  recents: RecentEntry[];
}

export const MAX_RECENTS = 10;

/** Newest first, deduped by path, capped at MAX_RECENTS. */
export function pushRecent(
  recents: RecentEntry[],
  entry: RecentEntry,
): RecentEntry[] {
  return [entry, ...recents.filter((r) => r.path !== entry.path)].slice(
    0,
    MAX_RECENTS,
  );
}

/**
 * Reconciles a saved session with per-path open results. Missing files drop
 * out of the tab list, the active index moves to the nearest surviving
 * neighbour (preferring the left), and matching recents are flagged missing.
 * `activeIndex` is -1 when nothing survived.
 */
export function planRestore(
  saved: SavedSession,
  results: ("ok" | "missing")[],
): { paths: string[]; activeIndex: number; recents: RecentEntry[] } {
  const paths = saved.paths.filter((_, i) => results[i] === "ok");
  const missingPaths = new Set(
    saved.paths.filter((_, i) => results[i] !== "ok"),
  );

  let activeIndex = -1;
  const last = Math.min(saved.activeIndex, saved.paths.length - 1);
  for (let i = 0; i <= last; i++) {
    if (results[i] === "ok") activeIndex++;
  }
  if (activeIndex === -1 && paths.length > 0) activeIndex = 0;

  const recents = saved.recents.map((r) =>
    missingPaths.has(r.path) ? { ...r, missing: true } : r,
  );
  return { paths, activeIndex, recents };
}

import { create } from "zustand";
import { closeDocument, setActiveDocument } from "../ipc/pdf";
import { useSearchStore, type SearchState } from "./search-store";
import { useUiStore, type SidebarTab } from "./ui-store";
import {
  invalidateOpen,
  useViewerStore,
  type ViewerState,
} from "./viewer-store";

export interface Tab {
  id: string;
  path: string;
  title: string;
}

type ViewerSnapshot = Pick<
  ViewerState,
  | "docId"
  | "pages"
  | "previews"
  | "error"
  | "scale"
  | "fitMode"
  | "rotationDoc"
  | "rotationByPage"
  | "currentPage"
  | "scrollYPt"
>;

type SearchSnapshot = Pick<
  SearchState,
  "query" | "caseSensitive" | "wholeWord" | "results" | "currentIndex"
>;

interface TabSnapshot {
  viewer: ViewerSnapshot;
  search: SearchSnapshot;
  sidebar: { open: boolean; tab: SidebarTab };
}

// In-memory only: previews are ImageBitmaps, which cannot be serialised.
// Session persistence keeps a separate plain-data view state per path.
const snapshots = new Map<string, TabSnapshot>();

export interface TabsState {
  tabs: Tab[];
  activeTabId: string | null;
  /** Opens a path in a new tab, or activates the tab that already has it. */
  openTab: (path: string) => Promise<void>;
  activateTab: (id: string) => void;
  closeTab: (id: string) => Promise<void>;
  nextTab: () => void;
  prevTab: () => void;
}

function basename(path: string): string {
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return path.slice(i + 1) || path;
}

function takeSnapshot(): TabSnapshot {
  const v = useViewerStore.getState();
  const s = useSearchStore.getState();
  const u = useUiStore.getState();
  return {
    viewer: {
      docId: v.docId,
      pages: v.pages,
      previews: v.previews,
      error: v.error,
      scale: v.scale,
      fitMode: v.fitMode,
      rotationDoc: v.rotationDoc,
      rotationByPage: v.rotationByPage,
      currentPage: v.currentPage,
      scrollYPt: v.scrollYPt,
    },
    search: {
      query: s.query,
      caseSensitive: s.caseSensitive,
      wholeWord: s.wholeWord,
      results: s.results,
      currentIndex: s.currentIndex,
    },
    sidebar: { open: u.sidebarOpen, tab: u.sidebarTab },
  };
}

function applySnapshot(snap: TabSnapshot): void {
  invalidateOpen();
  useViewerStore.setState({
    ...snap.viewer,
    zoomAnchor: null,
    scrollTarget: null,
  });
  const pos = snap.viewer.scrollYPt;
  useViewerStore
    .getState()
    .scrollToPage(pos?.page ?? snap.viewer.currentPage, pos?.yPt, true);
  useSearchStore.setState((s) => ({
    ...snap.search,
    searching: false,
    // Aborts any in-flight search loop still writing for the old tab.
    generation: s.generation + 1,
  }));
  useUiStore.setState({
    sidebarOpen: snap.sidebar.open,
    sidebarTab: snap.sidebar.tab,
  });
  void setActiveDocument(snap.viewer.docId).catch(() => undefined);
  // Refill a preview pass that was cut short by switching away.
  void useViewerStore.getState().resumePreviews();
}

/** Opens `path` into the viewer, then flags it visible to the engine —
 * unless the user has already switched to another tab meanwhile. */
async function openIntoViewer(tabId: string, path: string): Promise<void> {
  await useViewerStore.getState().openPath(path);
  if (useTabsStore.getState().activeTabId === tabId) {
    void setActiveDocument(useViewerStore.getState().docId).catch(
      () => undefined,
    );
  }
}

export const useTabsStore = create<TabsState>((set, get) => ({
  tabs: [],
  activeTabId: null,

  openTab: async (path) => {
    const { tabs, activeTabId, activateTab } = get();
    const existing = tabs.find((t) => t.path === path);
    if (existing) {
      activateTab(existing.id);
      return;
    }
    if (activeTabId !== null) snapshots.set(activeTabId, takeSnapshot());
    const tab: Tab = { id: crypto.randomUUID(), path, title: basename(path) };
    set({ tabs: [...tabs, tab], activeTabId: tab.id });
    useSearchStore.getState().clear(); // fresh tab, fresh search
    await openIntoViewer(tab.id, path);
  },

  activateTab: (id) => {
    const { tabs, activeTabId } = get();
    const tab = tabs.find((t) => t.id === id);
    if (!tab || id === activeTabId) return;
    if (activeTabId !== null) snapshots.set(activeTabId, takeSnapshot());
    set({ activeTabId: id });
    const snap = snapshots.get(id);
    if (snap) applySnapshot(snap);
    if (!snap || (snap.viewer.docId === null && snap.viewer.error === null)) {
      // The tab never finished opening (switched away mid-open, and the
      // superseded open closed its own doc). Reopen from the path.
      void openIntoViewer(id, tab.path);
    }
  },

  closeTab: async (id) => {
    const { tabs, activeTabId } = get();
    const idx = tabs.findIndex((t) => t.id === id);
    if (idx === -1) return;
    const remaining = tabs.filter((t) => t.id !== id);

    if (id !== activeTabId) {
      const docId = snapshots.get(id)?.viewer.docId ?? null;
      snapshots.delete(id);
      set({ tabs: remaining });
      if (docId !== null) await closeDocument(docId).catch(() => undefined);
      return;
    }

    snapshots.delete(id);
    const neighbour = remaining[Math.min(idx, remaining.length - 1)];
    if (!neighbour) {
      set({ tabs: [], activeTabId: null });
      useSearchStore.getState().clear();
      void setActiveDocument(null).catch(() => undefined);
      await useViewerStore.getState().close(); // resets and closes the doc
      return;
    }

    const docId = useViewerStore.getState().docId;
    set({ tabs: remaining, activeTabId: neighbour.id });
    const snap = snapshots.get(neighbour.id);
    if (snap) applySnapshot(snap);
    if (!snap || (snap.viewer.docId === null && snap.viewer.error === null)) {
      void openIntoViewer(neighbour.id, neighbour.path);
    }
    if (docId !== null) await closeDocument(docId).catch(() => undefined);
  },

  nextTab: () => {
    const { tabs, activeTabId, activateTab } = get();
    if (tabs.length < 2) return;
    const i = tabs.findIndex((t) => t.id === activeTabId);
    activateTab(tabs[(i + 1) % tabs.length].id);
  },

  prevTab: () => {
    const { tabs, activeTabId, activateTab } = get();
    if (tabs.length < 2) return;
    const i = tabs.findIndex((t) => t.id === activeTabId);
    activateTab(tabs[(i - 1 + tabs.length) % tabs.length].id);
  },
}));

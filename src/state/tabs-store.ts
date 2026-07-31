import { create } from "zustand";
import { persist } from "zustand/middleware";
import { closeDocument, setActiveDocument } from "../ipc/pdf";
import {
  cancelSidecarWrite,
  flushSidecarWrite,
  loadEditState,
  scheduleSidecarWrite,
} from "./annotation-io";
import {
  useDocumentStore,
  type DocumentSnapshot,
} from "./document-store";
import type { FileFingerprint } from "../ipc/sidecar";
import {
  planRestore,
  pushRecent,
  type RecentEntry,
  type SavedView,
} from "../lib/session";
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
  document: DocumentSnapshot;
  fingerprint: FileFingerprint | null;
}

// In-memory only: previews are ImageBitmaps, which cannot be serialised.
// Session persistence keeps a separate plain-data view state per path.
const snapshots = new Map<string, TabSnapshot>();

export interface TabsState {
  tabs: Tab[];
  activeTabId: string | null;
  /** Per-document view state keyed by file path; persisted. */
  viewByPath: Record<string, SavedView>;
  /** Recently opened documents, newest first; persisted. */
  recents: RecentEntry[];
  /** Guards restoreSession against running twice (StrictMode, re-mounts). */
  restored: boolean;
  /** Unsaved-changes flag per tab id; kept current by a store subscription.
   * Session-local, never persisted. */
  dirtyTabs: Record<string, boolean>;
  /** Close with an unsaved-changes prompt when needed. */
  requestCloseTab: (id: string) => void;
  /** Opens a path in a new tab, or activates the tab that already has it. */
  openTab: (path: string) => Promise<void>;
  activateTab: (id: string) => void;
  closeTab: (id: string) => Promise<void>;
  nextTab: () => void;
  prevTab: () => void;
  /** Writes the active tab's live view state into viewByPath. */
  saveActiveView: () => void;
  /** Drops an entry from the recents list. */
  removeRecent: (path: string) => void;
  /** Reopens the persisted tab set, dropping files that no longer exist. */
  restoreSession: () => Promise<void>;
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
    document: useDocumentStore.getState().snapshot(),
    fingerprint: useDocumentStore.getState().fingerprint,
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
  useDocumentStore.getState().restore(snap.document, snap.fingerprint);
  void setActiveDocument(snap.viewer.docId).catch(() => undefined);
  // Refill a preview pass that was cut short by switching away.
  void useViewerStore.getState().resumePreviews();
}

/** The active tab's live view state, ready for viewByPath. */
function currentSavedView(): SavedView {
  const v = useViewerStore.getState();
  const u = useUiStore.getState();
  return {
    scale: v.scale,
    fitMode: v.fitMode,
    page: v.scrollYPt?.page ?? v.currentPage,
    yPt: v.scrollYPt?.yPt ?? 0,
    sidebarOpen: u.sidebarOpen,
    sidebarTab: u.sidebarTab,
  };
}

/** Puts a freshly opened document back the way the user left it. */
function applySavedView(view: SavedView): void {
  const pageCount = useViewerStore.getState().pages.length;
  // The file may have changed since it was last open; keep the page valid.
  const page = Math.min(view.page, Math.max(0, pageCount - 1));
  useViewerStore.setState({
    scale: view.scale,
    fitMode: view.fitMode,
    currentPage: page,
    scrollYPt: { page, yPt: view.yPt },
  });
  useViewerStore.getState().scrollToPage(page, view.yPt, true);
  useUiStore.setState({
    sidebarOpen: view.sidebarOpen,
    sidebarTab: view.sidebarTab,
  });
}

/** Opens `path` into the viewer, then flags it visible to the engine —
 * unless the user has already switched to another tab meanwhile. */
async function openIntoViewer(tabId: string, path: string): Promise<void> {
  useDocumentStore.getState().reset();
  await useViewerStore.getState().openPath(path);
  if (useTabsStore.getState().activeTabId === tabId) {
    void setActiveDocument(useViewerStore.getState().docId).catch(
      () => undefined,
    );
    if (useViewerStore.getState().docId !== null) {
      // Fingerprint + crash-recovery sidecar for the edit state, then an
      // identity page order unless the sidecar restored a structure.
      await loadEditState(path);
      useDocumentStore
        .getState()
        .initStructure(useViewerStore.getState().pages.length);
    }
  }
}

export const useTabsStore = create<TabsState>()(
  persist(
    (set, get) => ({
      tabs: [],
      activeTabId: null,
      viewByPath: {},
      recents: [],
      restored: false,
      dirtyTabs: {},

      requestCloseTab: (id) => {
        const { dirtyTabs, activeTabId, activateTab, closeTab } = get();
        const dirty =
          id === activeTabId
            ? useDocumentStore.getState().isDirty()
            : (dirtyTabs[id] ?? false);
        if (!dirty) {
          void closeTab(id);
          return;
        }
        // The prompt saves via the active document store, so the tab must
        // be the active one before the modal opens.
        if (id !== activeTabId) activateTab(id);
        useUiStore.getState().setClosePrompt(id);
      },

      openTab: async (path) => {
        const { tabs, activeTabId, activateTab, saveActiveView } = get();
        const existing = tabs.find((t) => t.path === path);
        if (existing) {
          activateTab(existing.id);
          return;
        }
        if (activeTabId !== null) {
          const prev = tabs.find((t) => t.id === activeTabId);
          if (prev) flushSidecarWrite(prev.path);
          saveActiveView();
          snapshots.set(activeTabId, takeSnapshot());
        }
        const tab: Tab = {
          id: crypto.randomUUID(),
          path,
          title: basename(path),
        };
        set({ tabs: [...tabs, tab], activeTabId: tab.id });
        useSearchStore.getState().clear(); // fresh tab, fresh search
        await openIntoViewer(tab.id, path);

        const viewer = useViewerStore.getState();
        if (viewer.docId === null) return; // open failed; error shows in-tab
        set({
          recents: pushRecent(get().recents, {
            path,
            title: tab.title,
            pageCount: viewer.pages.length,
            thumbnail: get().recents.find((r) => r.path === path)?.thumbnail,
            lastOpened: Date.now(),
          }),
        });
        const saved = get().viewByPath[path];
        if (saved && get().activeTabId === tab.id) applySavedView(saved);
      },

      activateTab: (id) => {
        const { tabs, activeTabId, saveActiveView } = get();
        const tab = tabs.find((t) => t.id === id);
        if (!tab || id === activeTabId) return;
        if (activeTabId !== null) {
          const prev = tabs.find((t) => t.id === activeTabId);
          if (prev) flushSidecarWrite(prev.path);
          saveActiveView();
          snapshots.set(activeTabId, takeSnapshot());
        }
        set({ activeTabId: id });
        const snap = snapshots.get(id);
        if (snap) applySnapshot(snap);
        if (
          !snap ||
          (snap.viewer.docId === null && snap.viewer.error === null)
        ) {
          // The tab never finished opening (switched away mid-open, and the
          // superseded open closed its own doc). Reopen from the path.
          void openIntoViewer(id, tab.path);
        }
      },

      closeTab: async (id) => {
        const { tabs, activeTabId, saveActiveView } = get();
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

        saveActiveView(); // remember where the user was for next open
        snapshots.delete(id);
        cancelSidecarWrite();
        const neighbour = remaining[Math.min(idx, remaining.length - 1)];
        if (!neighbour) {
          set({ tabs: [], activeTabId: null });
          useDocumentStore.getState().reset();
          useSearchStore.getState().clear();
          void setActiveDocument(null).catch(() => undefined);
          await useViewerStore.getState().close(); // resets and closes the doc
          return;
        }

        const docId = useViewerStore.getState().docId;
        set({ tabs: remaining, activeTabId: neighbour.id });
        const snap = snapshots.get(neighbour.id);
        if (snap) applySnapshot(snap);
        if (
          !snap ||
          (snap.viewer.docId === null && snap.viewer.error === null)
        ) {
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

      saveActiveView: () => {
        const { tabs, activeTabId } = get();
        const tab = tabs.find((t) => t.id === activeTabId);
        if (!tab || useViewerStore.getState().docId === null) return;
        set({
          viewByPath: { ...get().viewByPath, [tab.path]: currentSavedView() },
        });
      },

      removeRecent: (path) =>
        set({ recents: get().recents.filter((r) => r.path !== path) }),

      restoreSession: async () => {
        if (get().restored) return;
        set({ restored: true });
        const stored = get().tabs;
        if (stored.length === 0) return;
        const activeIdx = Math.max(
          0,
          stored.findIndex((t) => t.id === get().activeTabId),
        );
        // Stored records have no snapshots or documents behind them; tabs
        // re-enter through openTab as their files prove to still exist.
        set({ tabs: [], activeTabId: null });

        const results: ("ok" | "missing")[] = [];
        for (const t of stored) {
          await get().openTab(t.path);
          if (useViewerStore.getState().docId !== null) {
            results.push("ok");
          } else {
            results.push("missing");
            const zombie = get().activeTabId;
            if (zombie !== null) await get().closeTab(zombie);
          }
        }

        const plan = planRestore(
          {
            paths: stored.map((t) => t.path),
            activeIndex: activeIdx,
            viewByPath: get().viewByPath,
            recents: get().recents,
          },
          results,
        );
        set({ recents: plan.recents });
        const target = get().tabs[plan.activeIndex];
        if (target) get().activateTab(target.id);
      },
    }),
    {
      name: "ibris-session",
      partialize: (s) => ({
        tabs: s.tabs,
        activeTabId: s.activeTabId,
        viewByPath: s.viewByPath,
        recents: s.recents,
      }),
    },
  ),
);

// WebView2 skips beforeunload on several shutdown paths (process kill, crash,
// updater restart), so the unload write in App.tsx is best-effort only. The
// durable path is here: any view-state change persists on a trailing debounce.
// Recents thumbnails: captured from the page-0 preview bitmap once per open
// (fresh bitmap per open, so a changed first page refreshes the thumbnail).
const capturedPreviews = new WeakSet<ImageBitmap>();
useViewerStore.subscribe((state, prev) => {
  if (state.previews === prev.previews) return;
  const bmp = state.previews.get(0);
  if (!bmp || capturedPreviews.has(bmp)) return;
  const { tabs, activeTabId, recents } = useTabsStore.getState();
  const tab = tabs.find((t) => t.id === activeTabId);
  if (!tab || !recents.some((r) => r.path === tab.path)) return;
  capturedPreviews.add(bmp);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = bmp.width;
    canvas.height = bmp.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.drawImage(bmp, 0, 0);
    const thumbnail = canvas.toDataURL("image/jpeg", 0.7);
    useTabsStore.setState({
      recents: recents.map((r) =>
        r.path === tab.path ? { ...r, thumbnail } : r,
      ),
    });
  } catch {
    // Canvas or storage-quota failure: the card falls back to a placeholder.
  }
});

// A theme switch changes what every preview should look like: wipe them
// (current tab and stored snapshots) and re-render for the new theme.
// Tiles need no sweep — their cache keys carry the invert bit.
useUiStore.subscribe((state, prev) => {
  if (state.resolvedTheme === prev.resolvedTheme) return;
  for (const snap of snapshots.values()) {
    snap.viewer.previews = new Map();
  }
  useViewerStore.setState({ previews: new Map() });
  void useViewerStore.getState().resumePreviews();
});

// Any command-stack change schedules a crash-recovery sidecar write for
// the active tab's document (M2-PLAN §2) and keeps its dirty flag current.
useDocumentStore.subscribe((state, prev) => {
  const stackChanged =
    state.commands !== prev.commands || state.cursor !== prev.cursor;
  const dirtyChanged =
    stackChanged || state.savedCursor !== prev.savedCursor;
  if (!dirtyChanged) return;
  const { tabs, activeTabId, dirtyTabs } = useTabsStore.getState();
  const tab = tabs.find((t) => t.id === activeTabId);
  if (!tab) return;
  if (stackChanged) scheduleSidecarWrite(tab.path);
  const dirty = state.cursor !== state.savedCursor;
  if ((dirtyTabs[tab.id] ?? false) !== dirty) {
    useTabsStore.setState({ dirtyTabs: { ...dirtyTabs, [tab.id]: dirty } });
  }
});

const VIEW_SAVE_DEBOUNCE_MS = 500;
let viewSaveTimer: ReturnType<typeof setTimeout> | undefined;
useViewerStore.subscribe((state, prev) => {
  if (
    state.scrollYPt === prev.scrollYPt &&
    state.scale === prev.scale &&
    state.fitMode === prev.fitMode
  ) {
    return;
  }
  clearTimeout(viewSaveTimer);
  viewSaveTimer = setTimeout(
    () => useTabsStore.getState().saveActiveView(),
    VIEW_SAVE_DEBOUNCE_MS,
  );
});

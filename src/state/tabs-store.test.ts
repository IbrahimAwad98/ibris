import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../ipc/sidecar", () => ({
  fileFingerprint: vi.fn().mockResolvedValue(null),
  sidecarRead: vi.fn().mockResolvedValue(null),
  sidecarWrite: vi.fn().mockResolvedValue(undefined),
  sidecarDelete: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../ipc/dialog", () => ({
  pickPdf: vi.fn().mockResolvedValue(null),
  pickSavePath: vi.fn().mockResolvedValue(null),
  askUser: vi.fn().mockResolvedValue(true),
}));
vi.mock("../ipc/pdf", () => ({
  openDocument: vi.fn(),
  renderPage: vi.fn().mockRejectedValue(new Error("no previews in tests")),
  closeDocument: vi.fn().mockResolvedValue(undefined),
  setActiveDocument: vi.fn().mockResolvedValue(undefined),
  cancelRender: vi.fn().mockResolvedValue(undefined),
  searchRange: vi.fn().mockResolvedValue([]),
  nextRequestId: (() => {
    let n = 0;
    return () => ++n;
  })(),
}));

import { closeDocument, openDocument, setActiveDocument } from "../ipc/pdf";
import { addAnnotation, useDocumentStore } from "./document-store";
import { useSearchStore } from "./search-store";
import { useTabsStore } from "./tabs-store";
import { useUiStore } from "./ui-store";
import { DEFAULT_SCALE, useViewerStore } from "./viewer-store";

const mockOpen = vi.mocked(openDocument);
const mockClose = vi.mocked(closeDocument);
const mockSetActive = vi.mocked(setActiveDocument);

let nextDocId: number;

beforeEach(() => {
  nextDocId = 100;
  mockOpen.mockReset();
  mockClose.mockClear();
  mockSetActive.mockClear();
  mockOpen.mockImplementation(async () => ({
    docId: nextDocId++,
    pageCount: 3,
    pages: Array.from({ length: 3 }, () => ({ width: 612, height: 792 })),
    annotations: [],
    form: { formType: "none", fields: [] },
  }));
  useTabsStore.setState({
    tabs: [],
    activeTabId: null,
    restored: false,
    viewByPath: {},
    recents: [],
  });
  useViewerStore.setState({
    docId: null,
    pages: [],
    previews: new Map(),
    error: null,
    scale: DEFAULT_SCALE,
    fitMode: null,
    zoomAnchor: null,
    currentPage: 0,
    scrollTarget: null,
  });
  useDocumentStore.getState().reset();
  useSearchStore.setState({
    query: "",
    results: [],
    searching: false,
    currentIndex: -1,
    caseSensitive: false,
    wholeWord: false,
  });
  useUiStore.setState({ sidebarOpen: false, sidebarTab: "thumbnails" });
});

function tabIds(): string[] {
  return useTabsStore.getState().tabs.map((t) => t.id);
}

describe("opening", () => {
  it("opens tabs, activates the newest, and never closes the previous doc", async () => {
    await useTabsStore.getState().openTab("C:\\docs\\a.pdf");
    await useTabsStore.getState().openTab("C:\\docs\\b.pdf");

    const s = useTabsStore.getState();
    expect(s.tabs.map((t) => t.title)).toEqual(["a.pdf", "b.pdf"]);
    expect(s.activeTabId).toBe(s.tabs[1].id);
    expect(useViewerStore.getState().docId).toBe(101);
    expect(mockClose).not.toHaveBeenCalled();
  });

  it("re-activates instead of duplicating an already-open path", async () => {
    await useTabsStore.getState().openTab("C:\\docs\\a.pdf");
    await useTabsStore.getState().openTab("C:\\docs\\b.pdf");
    await useTabsStore.getState().openTab("C:\\docs\\a.pdf");

    const s = useTabsStore.getState();
    expect(s.tabs).toHaveLength(2);
    expect(s.activeTabId).toBe(s.tabs[0].id);
    expect(useViewerStore.getState().docId).toBe(100);
  });

  it("declares the visible document to the engine on every activation", async () => {
    await useTabsStore.getState().openTab("C:\\docs\\a.pdf");
    expect(mockSetActive).toHaveBeenLastCalledWith(100);

    await useTabsStore.getState().openTab("C:\\docs\\b.pdf");
    expect(mockSetActive).toHaveBeenLastCalledWith(101);

    useTabsStore.getState().activateTab(tabIds()[0]);
    expect(mockSetActive).toHaveBeenLastCalledWith(100);
  });
});

describe("per-tab state", () => {
  it("keeps zoom, rotation, search and sidebar per tab", async () => {
    await useTabsStore.getState().openTab("C:\\docs\\a.pdf");
    useViewerStore.getState().setScale(2.5);
    useViewerStore.getState().rotateDoc();
    useSearchStore.setState({ query: "alpha" });
    useUiStore.setState({ sidebarOpen: true, sidebarTab: "search" });

    await useTabsStore.getState().openTab("C:\\docs\\b.pdf");
    expect(useViewerStore.getState().scale).toBe(DEFAULT_SCALE);
    // Rotation is a document edit now — the fresh tab has none.
    expect(useDocumentStore.getState().rotations).toEqual({});
    expect(useSearchStore.getState().query).toBe("");

    useTabsStore.getState().activateTab(tabIds()[0]);
    expect(useViewerStore.getState().scale).toBe(2.5);
    expect(useDocumentStore.getState().rotations).toEqual({ 0: 90, 1: 90, 2: 90 });
    expect(useSearchStore.getState().query).toBe("alpha");
    expect(useUiStore.getState().sidebarOpen).toBe(true);
    expect(useUiStore.getState().sidebarTab).toBe("search");
  });

  it("keeps the command stack and dirty state per tab", async () => {
    await useTabsStore.getState().openTab("C:\\docs\\a.pdf");
    useDocumentStore.getState().execute(
      addAnnotation({
        id: "n1",
        kind: "note",
        pageIndex: 0,
        at: { x: 1, y: 2 },
        contents: "per-tab",
        color: "#ffcc00",
        opacity: 1,
        author: "t",
        createdAt: 1,
        modifiedAt: 1,
      }),
    );
    expect(useDocumentStore.getState().isDirty()).toBe(true);

    await useTabsStore.getState().openTab("C:\\docs\\b.pdf");
    expect(useDocumentStore.getState().annotations["n1"]).toBeUndefined();
    expect(useDocumentStore.getState().isDirty()).toBe(false);

    useTabsStore.getState().activateTab(tabIds()[0]);
    expect(useDocumentStore.getState().annotations["n1"]).toMatchObject({
      contents: "per-tab",
    });
    expect(useDocumentStore.getState().isDirty()).toBe(true);
  });

  it("restores the tab's exact position via a scroll target on activation", async () => {
    await useTabsStore.getState().openTab("C:\\docs\\a.pdf");
    useViewerStore.setState({
      currentPage: 2,
      scrollYPt: { page: 2, yPt: 123.4 },
    });
    await useTabsStore.getState().openTab("C:\\docs\\b.pdf");

    useTabsStore.getState().activateTab(tabIds()[0]);
    const target = useViewerStore.getState().scrollTarget;
    expect(target?.page).toBe(2);
    expect(target?.yPt).toBeCloseTo(123.4);
    expect(target?.exact).toBe(true);
  });
});

describe("closing", () => {
  it("closing the active tab activates a neighbour and closes its doc", async () => {
    await useTabsStore.getState().openTab("C:\\docs\\a.pdf");
    await useTabsStore.getState().openTab("C:\\docs\\b.pdf");
    await useTabsStore.getState().openTab("C:\\docs\\c.pdf");
    useTabsStore.getState().activateTab(tabIds()[1]);

    await useTabsStore.getState().closeTab(tabIds()[1]);

    const s = useTabsStore.getState();
    expect(s.tabs.map((t) => t.title)).toEqual(["a.pdf", "c.pdf"]);
    expect(useViewerStore.getState().docId).toBe(102);
    expect(mockClose).toHaveBeenCalledWith(101);
  });

  it("closing a background tab leaves the active one untouched", async () => {
    await useTabsStore.getState().openTab("C:\\docs\\a.pdf");
    await useTabsStore.getState().openTab("C:\\docs\\b.pdf");

    await useTabsStore.getState().closeTab(tabIds()[0]);

    expect(useTabsStore.getState().tabs).toHaveLength(1);
    expect(useViewerStore.getState().docId).toBe(101);
    expect(mockClose).toHaveBeenCalledWith(100);
  });

  it("closing the last tab returns to the empty state", async () => {
    await useTabsStore.getState().openTab("C:\\docs\\a.pdf");
    await useTabsStore.getState().closeTab(tabIds()[0]);

    const s = useTabsStore.getState();
    expect(s.tabs).toHaveLength(0);
    expect(s.activeTabId).toBeNull();
    expect(useViewerStore.getState().docId).toBeNull();
    expect(mockClose).toHaveBeenCalledWith(100);
    expect(mockSetActive).toHaveBeenLastCalledWith(null);
  });
});

describe("session restore", () => {
  it("reopens stored tabs, drops missing files, and applies saved views", async () => {
    mockOpen.mockImplementation(async (path: string) => {
      if (path.includes("gone")) {
        throw { kind: "FileNotFound", path };
      }
      return {
        docId: nextDocId++,
        pageCount: 3,
        pages: Array.from({ length: 3 }, () => ({ width: 612, height: 792 })),
        annotations: [],
        form: { formType: "none", fields: [] },
      };
    });
    useTabsStore.setState({
      tabs: [
        { id: "t1", path: "C:\\docs\\a.pdf", title: "a.pdf" },
        { id: "t2", path: "C:\\docs\\gone.pdf", title: "gone.pdf" },
        { id: "t3", path: "C:\\docs\\c.pdf", title: "c.pdf" },
      ],
      activeTabId: "t2",
      viewByPath: {
        "C:\\docs\\a.pdf": {
          scale: 3,
          fitMode: null,
          page: 1,
          yPt: 50,
          sidebarOpen: true,
          sidebarTab: "outline",
        },
      },
      recents: [
        {
          path: "C:\\docs\\gone.pdf",
          title: "gone.pdf",
          pageCount: 3,
          lastOpened: 1,
        },
      ],
    });

    await useTabsStore.getState().restoreSession();

    const s = useTabsStore.getState();
    expect(s.tabs.map((t) => t.title)).toEqual(["a.pdf", "c.pdf"]);
    // The missing active tab healed to its left neighbour, a.pdf...
    expect(s.activeTabId).toBe(s.tabs[0].id);
    // ...whose saved view state came back with it.
    expect(useViewerStore.getState().scale).toBe(3);
    expect(useUiStore.getState().sidebarTab).toBe("outline");
    const missingRecent = s.recents.find((r) => r.path.includes("gone"));
    expect(missingRecent?.missing).toBe(true);
  });

  it("records a recent entry when a document opens", async () => {
    await useTabsStore.getState().openTab("C:\\docs\\a.pdf");
    const r = useTabsStore.getState().recents;
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({
      path: "C:\\docs\\a.pdf",
      title: "a.pdf",
      pageCount: 3,
    });
  });

  it("removes a recent entry by path", async () => {
    await useTabsStore.getState().openTab("C:\\docs\\a.pdf");
    useTabsStore.getState().removeRecent("C:\\docs\\a.pdf");
    expect(useTabsStore.getState().recents).toHaveLength(0);
  });
});

describe("debounced view persistence", () => {
  // WebView2 skips beforeunload on several shutdown paths (process kill,
  // crash, update); the position must be persisted while the user scrolls,
  // not only at unload.
  it("persists scroll position without beforeunload ever firing", async () => {
    await useTabsStore.getState().openTab("C:\\docs\\a.pdf");
    vi.useFakeTimers();
    try {
      useViewerStore.setState({ scrollYPt: { page: 2, yPt: 99 } });
      expect(
        useTabsStore.getState().viewByPath["C:\\docs\\a.pdf"],
      ).toBeUndefined();

      vi.advanceTimersByTime(600);
      const view = useTabsStore.getState().viewByPath["C:\\docs\\a.pdf"];
      expect(view?.page).toBe(2);
      expect(view?.yPt).toBe(99);
    } finally {
      vi.useRealTimers();
    }
  });

  it("persists zoom changes the same way", async () => {
    // Rotation is a document edit since M3 and travels via the command
    // stack + sidecar, not the view state.
    await useTabsStore.getState().openTab("C:\\docs\\a.pdf");
    vi.useFakeTimers();
    try {
      useViewerStore.getState().setScale(2.75);
      vi.advanceTimersByTime(600);
      const view = useTabsStore.getState().viewByPath["C:\\docs\\a.pdf"];
      expect(view?.scale).toBe(2.75);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("cycling", () => {
  it("next and previous tab wrap around", async () => {
    await useTabsStore.getState().openTab("C:\\docs\\a.pdf");
    await useTabsStore.getState().openTab("C:\\docs\\b.pdf");
    await useTabsStore.getState().openTab("C:\\docs\\c.pdf");

    useTabsStore.getState().nextTab();
    expect(useTabsStore.getState().activeTabId).toBe(tabIds()[0]);
    useTabsStore.getState().prevTab();
    expect(useTabsStore.getState().activeTabId).toBe(tabIds()[2]);
  });
});

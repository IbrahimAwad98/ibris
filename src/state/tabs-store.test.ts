import { beforeEach, describe, expect, it, vi } from "vitest";

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
  }));
  useTabsStore.setState({ tabs: [], activeTabId: null });
  useViewerStore.setState({
    docId: null,
    pages: [],
    previews: new Map(),
    error: null,
    scale: DEFAULT_SCALE,
    fitMode: null,
    zoomAnchor: null,
    rotationDoc: 0,
    rotationByPage: {},
    currentPage: 0,
    scrollTarget: null,
  });
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
    expect(useViewerStore.getState().rotationDoc).toBe(0);
    expect(useSearchStore.getState().query).toBe("");

    useTabsStore.getState().activateTab(tabIds()[0]);
    expect(useViewerStore.getState().scale).toBe(2.5);
    expect(useViewerStore.getState().rotationDoc).toBe(90);
    expect(useSearchStore.getState().query).toBe("alpha");
    expect(useUiStore.getState().sidebarOpen).toBe(true);
    expect(useUiStore.getState().sidebarTab).toBe("search");
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

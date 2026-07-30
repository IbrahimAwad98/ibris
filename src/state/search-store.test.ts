import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SearchMatch } from "../ipc/pdf";

vi.mock("../ipc/pdf", () => ({
  searchRange: vi.fn(),
  cancelRender: vi.fn().mockResolvedValue(undefined),
  nextRequestId: (() => {
    let n = 0;
    return () => ++n;
  })(),
  closeDocument: vi.fn().mockResolvedValue(undefined),
  openDocument: vi.fn(),
  renderPage: vi.fn(),
}));

import { searchRange } from "../ipc/pdf";
import { useSearchStore } from "./search-store";
import { useViewerStore } from "./viewer-store";

const mockSearch = vi.mocked(searchRange);

function match(pageIndex: number): SearchMatch {
  return {
    pageIndex,
    rects: [{ x: 10, y: 20, width: 30, height: 10 }],
    context: `context on page ${pageIndex}`,
  };
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  mockSearch.mockReset();
  useViewerStore.setState({
    docId: 1,
    pages: Array.from({ length: 25 }, () => ({ width: 612, height: 792 })),
  });
  useSearchStore.setState({
    query: "",
    results: [],
    searching: false,
    currentIndex: -1,
    caseSensitive: false,
    wholeWord: false,
  });
});

describe("streaming", () => {
  it("appends results chunk by chunk and finishes", async () => {
    // 25 pages → chunks 0-9, 10-19, 20-24.
    mockSearch
      .mockResolvedValueOnce([match(2), match(7)])
      .mockResolvedValueOnce([match(12)])
      .mockResolvedValueOnce([match(21)]);

    const done = useSearchStore.getState().start("fox");
    await flush();
    // After the first chunk resolves, results are already visible.
    expect(useSearchStore.getState().results.length).toBeGreaterThanOrEqual(2);

    await done;
    const s = useSearchStore.getState();
    expect(s.results.map((r) => r.pageIndex)).toEqual([2, 7, 12, 21]);
    expect(s.searching).toBe(false);
    expect(s.currentIndex).toBe(0); // auto-selected first match
    expect(mockSearch).toHaveBeenCalledTimes(3);
    expect(mockSearch).toHaveBeenNthCalledWith(
      1,
      1,
      "fox",
      false,
      false,
      0,
      9,
      expect.any(Number),
    );
    expect(mockSearch).toHaveBeenNthCalledWith(
      3,
      1,
      "fox",
      false,
      false,
      20,
      24,
      expect.any(Number),
    );
  });

  it("a new search abandons a stale one's later chunks", async () => {
    let releaseFirst: (v: SearchMatch[]) => void = () => undefined;
    mockSearch
      .mockImplementationOnce(
        () => new Promise((resolve) => (releaseFirst = resolve)),
      )
      .mockResolvedValue([match(5)]);

    const first = useSearchStore.getState().start("old");
    await flush();
    const second = useSearchStore.getState().start("new");
    releaseFirst([match(1)]); // stale chunk resolves late
    await Promise.all([first, second]);

    const s = useSearchStore.getState();
    expect(s.query).toBe("new");
    // Only results from the "new" search survive.
    expect(s.results.every((r) => r.pageIndex === 5)).toBe(true);
  });

  it("empty query clears without searching", async () => {
    await useSearchStore.getState().start("");
    expect(mockSearch).not.toHaveBeenCalled();
    expect(useSearchStore.getState().searching).toBe(false);
  });
});

describe("stepping", () => {
  it("cycles forward and backward with wrap-around", async () => {
    mockSearch.mockResolvedValue([]);
    useSearchStore.setState({
      results: [match(1), match(2), match(3)],
      currentIndex: 0,
    });

    const { step } = useSearchStore.getState();
    step(1);
    expect(useSearchStore.getState().currentIndex).toBe(1);
    step(1);
    step(1); // wraps
    expect(useSearchStore.getState().currentIndex).toBe(0);
    step(-1); // wraps backward
    expect(useSearchStore.getState().currentIndex).toBe(2);
  });

  it("stepping navigates the viewer to the match's page", () => {
    useSearchStore.setState({
      results: [match(1), match(9)],
      currentIndex: 0,
    });
    useSearchStore.getState().step(1);
    const target = useViewerStore.getState().scrollTarget;
    expect(target?.page).toBe(9);
    expect(target?.yPt).toBe(20);
  });

  it("does nothing with no results", () => {
    useSearchStore.setState({ results: [], currentIndex: -1 });
    useSearchStore.getState().step(1);
    expect(useSearchStore.getState().currentIndex).toBe(-1);
  });
});

describe("toggles", () => {
  it("passes case sensitivity and whole-word through and restarts", async () => {
    mockSearch.mockResolvedValue([]);
    useSearchStore.setState({ query: "fox" });
    useSearchStore.getState().setCaseSensitive(true);
    await flush();
    expect(mockSearch).toHaveBeenCalledWith(
      1,
      "fox",
      true,
      false,
      expect.any(Number),
      expect.any(Number),
      expect.any(Number),
    );
  });
});

import { describe, expect, it } from "vitest";
import { pageOffsets, totalHeight, visibleRange } from "./visible-range";

// 10 uniform pages of 1000px with a 10px gap: page i spans
// [10 + 1010*i, 1010 + 1010*i].
const uniform = Array(10).fill(1000);
const GAP = 10;

describe("pageOffsets / totalHeight", () => {
  it("offsets pages by gap-then-height", () => {
    expect(pageOffsets(uniform, GAP).slice(0, 3)).toEqual([10, 1020, 2030]);
  });

  it("totals heights plus surrounding gaps", () => {
    expect(totalHeight(uniform, GAP)).toBe(10 * 1000 + 11 * GAP);
    expect(totalHeight([], GAP)).toBe(0);
  });
});

describe("visibleRange", () => {
  it("includes one screen above and below by default", () => {
    // Viewport 1000px at scrollTop 5050: window is [4050, 7050].
    const r = visibleRange(uniform, GAP, 5050, 1000);
    expect(r).toEqual({ start: 4, end: 6 });
  });

  it("clamps at the top", () => {
    const r = visibleRange(uniform, GAP, 0, 1000);
    expect(r).toEqual({ start: 0, end: 1 });
  });

  it("clamps at the bottom", () => {
    const r = visibleRange(uniform, GAP, 9100, 1000);
    expect(r.end).toBe(9);
    expect(r.start).toBe(8);
  });

  it("handles varying page heights", () => {
    // Pages: [10..110], [120..620], [630..2630], [2640..2740].
    const heights = [100, 500, 2000, 100];
    const r = visibleRange(heights, GAP, 700, 300, 0);
    expect(r).toEqual({ start: 2, end: 2 });
  });

  it("respects explicit overscan", () => {
    // Page 4 spans [4050, 5050] and only touches the window edge — excluded.
    const none = visibleRange(uniform, GAP, 5050, 1000, 0);
    expect(none).toEqual({ start: 5, end: 5 });
    const wide = visibleRange(uniform, GAP, 5050, 1000, 3000);
    expect(wide).toEqual({ start: 2, end: 8 });
  });

  it("returns an empty range for no pages", () => {
    const r = visibleRange([], GAP, 0, 1000);
    expect(r.end).toBeLessThan(r.start);
  });

  it("a page fully inside the gap window edge is excluded", () => {
    // scrollTop exactly at page 1's bottom edge + gap, zero overscan:
    // window [1010, 2010] — page 0 ends at 1010 (not > windowTop).
    const r = visibleRange(uniform, GAP, 1010, 1000, 0);
    expect(r.start).toBe(1);
  });
});

// Pure page-layout math for the virtualized viewer. Pages are stacked
// vertically with `gap` pixels above each page and after the last one.

export interface VisibleRange {
  /** First visible page index (inclusive). */
  start: number;
  /** Last visible page index (inclusive); end < start means nothing visible. */
  end: number;
}

/** Top offset of each page in layout pixels. */
export function pageOffsets(heights: readonly number[], gap: number): number[] {
  const offsets = new Array<number>(heights.length);
  let y = gap;
  for (let i = 0; i < heights.length; i++) {
    offsets[i] = y;
    y += heights[i] + gap;
  }
  return offsets;
}

/** Total scrollable height of the page stack. */
export function totalHeight(heights: readonly number[], gap: number): number {
  let sum = gap;
  for (const h of heights) sum += h + gap;
  return heights.length === 0 ? 0 : sum;
}

/**
 * Pages intersecting [scrollTop - overscan, scrollTop + viewportHeight +
 * overscan]. Overscan defaults to one full screen above and below, per the
 * rendering-pipeline spec in docs/ARCHITECTURE.md.
 */
// ponytail: linear scan per call; at hundreds of pages this is sub-µs.
// Binary search over pageOffsets if documents with 10k+ pages ever matter.
export function visibleRange(
  heights: readonly number[],
  gap: number,
  scrollTop: number,
  viewportHeight: number,
  overscan: number = viewportHeight,
): VisibleRange {
  const windowTop = scrollTop - overscan;
  const windowBottom = scrollTop + viewportHeight + overscan;

  let start = -1;
  let end = -2;
  let y = gap;
  for (let i = 0; i < heights.length; i++) {
    const top = y;
    const bottom = y + heights[i];
    if (bottom > windowTop && top < windowBottom) {
      if (start === -1) start = i;
      end = i;
    } else if (start !== -1) {
      break; // past the window; pages are in order
    }
    y = bottom + gap;
  }
  return start === -1 ? { start: 0, end: -1 } : { start, end };
}

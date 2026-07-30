import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  pageOffsets,
  totalHeight,
  visibleRange,
  type VisibleRange,
} from "../../lib/visible-range";
import { PAGE_GAP, SCALE, useViewerStore } from "../../state/viewer-store";
import { PageView } from "./PageView";

/**
 * Virtualized page stack: a spacer div at full document height, with only
 * the pages in the visible range (± one screen) mounted as absolutely
 * positioned canvases.
 */
export function PageList() {
  const pages = useViewerStore((s) => s.pages);
  const containerRef = useRef<HTMLDivElement>(null);
  const [range, setRange] = useState<VisibleRange>({ start: 0, end: -1 });

  const heights = useMemo(
    () => pages.map((p) => Math.round(p.height * SCALE)),
    [pages],
  );
  const offsets = useMemo(() => pageOffsets(heights, PAGE_GAP), [heights]);
  const total = useMemo(() => totalHeight(heights, PAGE_GAP), [heights]);

  const update = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const next = visibleRange(heights, PAGE_GAP, el.scrollTop, el.clientHeight);
    setRange((prev) =>
      prev.start === next.start && prev.end === next.end ? prev : next,
    );
  }, [heights]);

  useEffect(() => {
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, [update]);

  const rafPending = useRef(false);
  const onScroll = useCallback(() => {
    if (rafPending.current) return;
    rafPending.current = true;
    requestAnimationFrame(() => {
      rafPending.current = false;
      update();
    });
  }, [update]);

  const views = [];
  for (let i = range.start; i <= range.end && i < pages.length; i++) {
    views.push(
      <PageView
        key={i}
        pageIndex={i}
        top={offsets[i]}
        width={Math.round(pages[i].width * SCALE)}
        height={heights[i]}
      />,
    );
  }

  return (
    <div
      ref={containerRef}
      onScroll={onScroll}
      style={{ position: "absolute", inset: 0, overflowY: "auto" }}
    >
      <div style={{ position: "relative", height: total }}>{views}</div>
    </div>
  );
}

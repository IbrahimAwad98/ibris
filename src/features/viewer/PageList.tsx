import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { displaySize } from "../../lib/coords";
import {
  pageOffsets,
  totalHeight,
  visibleRange,
  type VisibleRange,
} from "../../lib/visible-range";
import { anchorScroll, fitPageScale, fitWidthScale, zoomIn, zoomOut } from "../../lib/zoom";
import { useDocumentStore } from "../../state/document-store";
import {
  PAGE_GAP,
  pageOrderOf,
  pageRotation,
  useViewerStore,
} from "../../state/viewer-store";
import { sweepInFlight } from "./page-cache";
import { PageView } from "./PageView";

/**
 * Virtualized, zoomable, rotatable page stack. Scrolls both axes; zoom is
 * anchored (wheel: cursor, keyboard/toolbar: viewport centre).
 */
export function PageList() {
  const docId = useViewerStore((s) => s.docId);
  const pages = useViewerStore((s) => s.pages);
  const scale = useViewerStore((s) => s.scale);
  const fitMode = useViewerStore((s) => s.fitMode);
  const docOrder = useDocumentStore((s) => s.pageOrder);
  const docRotations = useDocumentStore((s) => s.rotations);
  const setScale = useViewerStore((s) => s.setScale);
  const setCurrentPage = useViewerStore((s) => s.setCurrentPage);

  const containerRef = useRef<HTMLDivElement>(null);
  const [range, setRange] = useState<VisibleRange>({ start: 0, end: -1 });
  const [, setScrollTick] = useState(0); // re-render on scroll for viewRect props
  const lastScroll = useRef({ left: 0, top: 0 });
  const prevScale = useRef(scale);

  // View slot → source page. Identity until the document store has
  // structure; guarded against a stale order referencing missing pages.
  const order = useMemo(
    () =>
      (docOrder ?? pages.map((_, i) => i)).filter((src) => src < pages.length),
    [docOrder, pages],
  );
  const rotations = useMemo(
    () => order.map((src) => docRotations[src] ?? (0 as const)),
    [order, docRotations],
  );
  const dispSizes = useMemo(
    () => order.map((src, i) => displaySize(pages[src], scale, rotations[i])),
    [order, pages, scale, rotations],
  );
  const heights = useMemo(() => dispSizes.map((s) => s.height), [dispSizes]);
  const offsets = useMemo(() => pageOffsets(heights, PAGE_GAP), [heights]);
  const total = useMemo(() => totalHeight(heights, PAGE_GAP), [heights]);
  const innerWidth = useMemo(
    () => Math.max(0, ...dispSizes.map((s) => s.width)) + 2 * PAGE_GAP,
    [dispSizes],
  );

  const update = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    lastScroll.current = { left: el.scrollLeft, top: el.scrollTop };
    const next = visibleRange(heights, PAGE_GAP, el.scrollTop, el.clientHeight);
    setRange((prev) =>
      prev.start === next.start && prev.end === next.end ? prev : next,
    );
    setScrollTick((t) => t + 1);
    if (next.end >= next.start) {
      // Topmost page whose bottom is below the viewport top.
      let current = next.start;
      for (let i = next.start; i <= next.end; i++) {
        if (offsets[i] + heights[i] > el.scrollTop) {
          current = i;
          break;
        }
      }
      setCurrentPage(current);
      const scale = useViewerStore.getState().scale;
      useViewerStore.setState({
        scrollYPt: {
          page: current,
          yPt: (el.scrollTop - offsets[current]) / scale,
        },
      });
    }
  }, [heights, offsets, setCurrentPage]);

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

  // Cursor-anchored wheel zoom; non-passive so preventDefault sticks.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      const bounds = el.getBoundingClientRect();
      const anchor = { x: e.clientX - bounds.left, y: e.clientY - bounds.top };
      const current = useViewerStore.getState().scale;
      const next = e.deltaY < 0 ? zoomIn(current) : zoomOut(current);
      if (next !== current) setScale(next, { anchor });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [setScale]);

  // Keyboard zoom/fit shortcuts live in the command registry (shell).

  // Navigation requests (thumbnails, outline, search) land here.
  const scrollTarget = useViewerStore((s) => s.scrollTarget);
  useEffect(() => {
    const el = containerRef.current;
    if (!el || !scrollTarget) return;
    const { page, yPt, exact } = scrollTarget;
    if (page < 0 || page >= offsets.length) return;
    // Exact targets carry display-space offsets (tab/session restore) and
    // land verbatim; search-match targets carry PDF-space offsets, only
    // meaningful unrotated, and bias down a third for context.
    const withinPage =
      yPt !== undefined && (exact || rotations[page] === 0) ? yPt * scale : 0;
    const bias = yPt !== undefined && !exact ? el.clientHeight / 3 : 0;
    el.scrollTop = Math.max(0, offsets[page] + withinPage - bias);
    update();
  }, [scrollTarget, offsets, rotations, scale, update]);

  // Apply the anchored scroll correction after a scale change, before paint.
  useLayoutEffect(() => {
    const el = containerRef.current;
    const old = prevScale.current;
    if (!el || old === scale) return;
    prevScale.current = scale;
    // Everything queued belongs to the old scale now.
    sweepInFlight(() => true);
    const anchor = useViewerStore.getState().zoomAnchor ?? {
      x: el.clientWidth / 2,
      y: el.clientHeight / 2,
    };
    const next = anchorScroll(lastScroll.current, anchor, old, scale);
    el.scrollLeft = next.left;
    el.scrollTop = next.top;
    update();
  }, [scale, update]);

  // Fit modes re-derive scale when the viewport or rotation changes.
  useEffect(() => {
    if (!fitMode) return;
    const el = containerRef.current;
    if (!el) return;
    const recompute = () => {
      const s = useViewerStore.getState();
      const pt = s.pages[pageOrderOf(s)[s.currentPage]];
      if (!pt) return;
      const rot = pageRotation(s, s.currentPage);
      const target =
        fitMode === "width"
          ? fitWidthScale(el.clientWidth, pt, rot, PAGE_GAP)
          : fitPageScale(
              { width: el.clientWidth, height: el.clientHeight },
              pt,
              rot,
              PAGE_GAP,
            );
      if (target !== s.scale) setScale(target, { fitMode });
    };
    recompute();
    window.addEventListener("resize", recompute);
    return () => window.removeEventListener("resize", recompute);
  }, [fitMode, rotations, setScale]);

  if (docId === null) return null;

  const el = containerRef.current;
  const viewportW = el?.clientWidth ?? 0;
  const viewportH = el?.clientHeight ?? 0;

  const effectiveWidth = Math.max(innerWidth, viewportW);
  const views = [];
  for (let i = range.start; i <= range.end && i < order.length; i++) {
    const src = order[i];
    const left = Math.max(PAGE_GAP, (effectiveWidth - dispSizes[i].width) / 2);
    views.push(
      <PageView
        key={src}
        docId={docId}
        pageIndex={src}
        top={offsets[i]}
        left={left}
        pagePt={pages[src]}
        scale={scale}
        rotation={rotations[i]}
        viewRect={{
          x: lastScroll.current.left - left,
          y: lastScroll.current.top - offsets[i],
          width: viewportW,
          height: viewportH,
        }}
      />,
    );
  }

  return (
    <div
      ref={containerRef}
      onScroll={onScroll}
      style={{ position: "absolute", inset: 0, overflow: "auto" }}
    >
      <div
        style={{
          position: "relative",
          height: total,
          width: innerWidth,
          minWidth: "100%",
        }}
      >
        {views}
      </div>
    </div>
  );
}

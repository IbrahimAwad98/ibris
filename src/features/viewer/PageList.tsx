import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { displaySize } from "../../lib/coords";
import {
  pageOffsets,
  totalHeight,
  visibleRange,
  type VisibleRange,
} from "../../lib/visible-range";
import { anchorScroll, fitPageScale, fitWidthScale, zoomIn, zoomOut } from "../../lib/zoom";
import { PAGE_GAP, pageRotation, useViewerStore } from "../../state/viewer-store";
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
  const rotationDoc = useViewerStore((s) => s.rotationDoc);
  const rotationByPage = useViewerStore((s) => s.rotationByPage);
  const setScale = useViewerStore((s) => s.setScale);
  const setCurrentPage = useViewerStore((s) => s.setCurrentPage);

  const containerRef = useRef<HTMLDivElement>(null);
  const [range, setRange] = useState<VisibleRange>({ start: 0, end: -1 });
  const [, setScrollTick] = useState(0); // re-render on scroll for viewRect props
  const lastScroll = useRef({ left: 0, top: 0 });
  const prevScale = useRef(scale);

  const rotations = useMemo(
    () =>
      pages.map(
        (_, i) =>
          (((rotationDoc + (rotationByPage[i] ?? 0)) % 360) as 0 | 90 | 180 | 270),
      ),
    [pages, rotationDoc, rotationByPage],
  );
  const dispSizes = useMemo(
    () => pages.map((p, i) => displaySize(p, scale, rotations[i])),
    [pages, scale, rotations],
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

  // Keyboard zoom and fit shortcuts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.ctrlKey) return;
      const el = containerRef.current;
      const s = useViewerStore.getState();
      const centre = el
        ? { x: el.clientWidth / 2, y: el.clientHeight / 2 }
        : { x: 0, y: 0 };
      const currentPt = s.pages[s.currentPage];
      if (!currentPt) return;
      const rot = pageRotation(s, s.currentPage);
      switch (e.key) {
        case "=":
        case "+":
          e.preventDefault();
          setScale(zoomIn(s.scale), { anchor: centre });
          break;
        case "-":
          e.preventDefault();
          setScale(zoomOut(s.scale), { anchor: centre });
          break;
        case "0":
          e.preventDefault();
          if (el)
            setScale(
              fitPageScale(
                { width: el.clientWidth, height: el.clientHeight },
                currentPt,
                rot,
                PAGE_GAP,
              ),
              { fitMode: "page", anchor: centre },
            );
          break;
        case "1":
          e.preventDefault();
          setScale(1, { anchor: centre });
          break;
        case "2":
          e.preventDefault();
          if (el)
            setScale(fitWidthScale(el.clientWidth, currentPt, rot, PAGE_GAP), {
              fitMode: "width",
              anchor: centre,
            });
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setScale]);

  // Navigation requests (thumbnails, outline, search) land here.
  const scrollTarget = useViewerStore((s) => s.scrollTarget);
  useEffect(() => {
    const el = containerRef.current;
    if (!el || !scrollTarget) return;
    const { page, yPt } = scrollTarget;
    if (page < 0 || page >= offsets.length) return;
    const withinPage =
      yPt !== undefined && rotations[page] === 0 ? yPt * scale : 0;
    el.scrollTop = Math.max(
      0,
      offsets[page] + withinPage - (yPt !== undefined ? el.clientHeight / 3 : 0),
    );
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
      const pt = s.pages[s.currentPage];
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
  }, [fitMode, rotationDoc, rotationByPage, setScale]);

  if (docId === null) return null;

  const el = containerRef.current;
  const viewportW = el?.clientWidth ?? 0;
  const viewportH = el?.clientHeight ?? 0;

  const effectiveWidth = Math.max(innerWidth, viewportW);
  const views = [];
  for (let i = range.start; i <= range.end && i < pages.length; i++) {
    const left = Math.max(PAGE_GAP, (effectiveWidth - dispSizes[i].width) / 2);
    views.push(
      <PageView
        key={i}
        docId={docId}
        pageIndex={i}
        top={offsets[i]}
        left={left}
        pagePt={pages[i]}
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

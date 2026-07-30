// Pure zoom math: cursor-anchored scroll adjustment and fit-mode scales.

import type { Rotation, Size } from "./coords";
import { displaySize } from "./coords";

export const MIN_SCALE = 0.1;
export const MAX_SCALE = 8.0;
/** Multiplicative step for wheel/keyboard zoom. */
export const ZOOM_STEP = 1.1;

export function clampScale(scale: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
}

export function zoomIn(scale: number): number {
  return clampScale(scale * ZOOM_STEP);
}

export function zoomOut(scale: number): number {
  return clampScale(scale / ZOOM_STEP);
}

export interface ScrollPos {
  left: number;
  top: number;
}

/**
 * New scroll position that keeps the content under `anchor` (viewport
 * coordinates, relative to the scroll container's top-left) stationary when
 * scale changes from `oldScale` to `newScale`. Derivation: the content
 * coordinate under the anchor is (scroll + anchor); content coordinates
 * scale linearly with zoom, so the new scroll is that coordinate scaled,
 * minus the anchor again.
 */
export function anchorScroll(
  scroll: ScrollPos,
  anchor: { x: number; y: number },
  oldScale: number,
  newScale: number,
): ScrollPos {
  const ratio = newScale / oldScale;
  return {
    left: (scroll.left + anchor.x) * ratio - anchor.x,
    top: (scroll.top + anchor.y) * ratio - anchor.y,
  };
}

/** Scale at which the page's displayed width fills the viewport width. */
export function fitWidthScale(
  viewportWidth: number,
  pagePt: Size,
  rotation: Rotation,
  marginPx: number,
): number {
  const displayed = displaySize(pagePt, 1, rotation).width;
  return clampScale((viewportWidth - 2 * marginPx) / displayed);
}

/** Scale at which the whole page fits inside the viewport. */
export function fitPageScale(
  viewport: Size,
  pagePt: Size,
  rotation: Rotation,
  marginPx: number,
): number {
  const displayed = displaySize(pagePt, 1, rotation);
  return clampScale(
    Math.min(
      (viewport.width - 2 * marginPx) / displayed.width,
      (viewport.height - 2 * marginPx) / displayed.height,
    ),
  );
}

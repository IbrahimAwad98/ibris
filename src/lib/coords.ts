// The three coordinate systems from docs/ARCHITECTURE.md:
//   PDF space     — points, origin bottom-left of the page
//   page space    — device pixels at the current scale, origin top-left of
//                   the *unrotated* page (what the engine renders)
//   display space — device pixels, origin top-left of the page as displayed
//                   (rotation applied); screen space is display space minus
//                   scroll, handled by the DOM
// All conversions live here. Never convert inline in a component.

export type Rotation = 0 | 90 | 180 | 270;

export interface Point {
  x: number;
  y: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Unrotated page size in device pixels at `scale` (pagePt in points). */
export function pageDeviceSize(pagePt: Size, scale: number): Size {
  return {
    width: Math.round(pagePt.width * scale),
    height: Math.round(pagePt.height * scale),
  };
}

/** Displayed size: rotation swaps the axes for 90/270. */
export function displaySize(pagePt: Size, scale: number, rotation: Rotation): Size {
  const s = pageDeviceSize(pagePt, scale);
  return rotation === 90 || rotation === 270
    ? { width: s.height, height: s.width }
    : s;
}

/** PDF point (pt, bottom-left origin) → unrotated page device pixels. */
export function pdfToPage(p: Point, pagePt: Size, scale: number): Point {
  return { x: p.x * scale, y: (pagePt.height - p.y) * scale };
}

/** Unrotated page device pixels → PDF point. */
export function pageToPdf(p: Point, pagePt: Size, scale: number): Point {
  return { x: p.x / scale, y: pagePt.height - p.y / scale };
}

/** Unrotated page pixels → display pixels under a clockwise rotation. */
export function pageToDisplay(
  p: Point,
  pagePt: Size,
  scale: number,
  rotation: Rotation,
): Point {
  const { width: w, height: h } = pageDeviceSize(pagePt, scale);
  switch (rotation) {
    case 0:
      return { x: p.x, y: p.y };
    case 90:
      return { x: h - p.y, y: p.x };
    case 180:
      return { x: w - p.x, y: h - p.y };
    case 270:
      return { x: p.y, y: w - p.x };
  }
}

/** Display pixels → unrotated page pixels (inverse of pageToDisplay). */
export function displayToPage(
  p: Point,
  pagePt: Size,
  scale: number,
  rotation: Rotation,
): Point {
  const { width: w, height: h } = pageDeviceSize(pagePt, scale);
  switch (rotation) {
    case 0:
      return { x: p.x, y: p.y };
    case 90:
      return { x: p.y, y: h - p.x };
    case 180:
      return { x: w - p.x, y: h - p.y };
    case 270:
      return { x: w - p.y, y: p.x };
  }
}

/** Axis-aligned rect in display space → covering rect in unrotated page space. */
export function displayRectToPageRect(
  r: Rect,
  pagePt: Size,
  scale: number,
  rotation: Rotation,
): Rect {
  const a = displayToPage({ x: r.x, y: r.y }, pagePt, scale, rotation);
  const b = displayToPage(
    { x: r.x + r.width, y: r.y + r.height },
    pagePt,
    scale,
    rotation,
  );
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) };
}

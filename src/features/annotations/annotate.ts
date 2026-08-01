// Annotation creation: fills identity/style from the tool store and turns
// text selections into markup quads. Command execution happens here so the
// UI layers stay thin.
import type { Annotation } from "../../lib/annotations";
import type { Rect, Rotation, Size } from "../../lib/coords";
import { displayRectToPageRect } from "../../lib/coords";
import { addAnnotation, useDocumentStore } from "../../state/document-store";
import { activeSettings, useToolStore } from "../../state/tool-store";

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never;

/** An annotation minus everything the tool store fills in. */
export type AnnotationGeometry = DistributiveOmit<
  Annotation,
  "id" | "pageIndex" | "color" | "opacity" | "author" | "createdAt" | "modifiedAt"
>;

/** Builds a full annotation from geometry + the active tool settings and
 * pushes it onto the command stack. */
export function createAnnotation(
  pageIndex: number,
  geometry: AnnotationGeometry,
): void {
  const { author } = useToolStore.getState();
  const settings = activeSettings();
  const now = Date.now();
  const annotation = {
    id: crypto.randomUUID(),
    pageIndex,
    color: settings.color,
    opacity: settings.opacity,
    author: author || "Ibris user",
    createdAt: now,
    modifiedAt: now,
    ...geometry,
  } as Annotation;
  useDocumentStore.getState().execute(addAnnotation(annotation));
}

/**
 * The current text selection as markup quads on one page, in page points
 * (unrotated, top-left origin). Empty when the selection misses the page.
 */
export function selectionQuads(
  pageEl: HTMLElement,
  pagePt: Size,
  scale: number,
  rotation: Rotation,
): Rect[] {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return [];
  const pageBounds = pageEl.getBoundingClientRect();
  const quads: Rect[] = [];
  for (let i = 0; i < sel.rangeCount; i++) {
    for (const r of sel.getRangeAt(i).getClientRects()) {
      if (r.width < 1 || r.height < 1) continue;
      // Clip to this page.
      if (
        r.right < pageBounds.left ||
        r.left > pageBounds.right ||
        r.bottom < pageBounds.top ||
        r.top > pageBounds.bottom
      ) {
        continue;
      }
      const display = {
        x: r.left - pageBounds.left,
        y: r.top - pageBounds.top,
        width: r.width,
        height: r.height,
      };
      const device = displayRectToPageRect(display, pagePt, scale, rotation);
      quads.push({
        x: device.x / scale,
        y: device.y / scale,
        width: device.width / scale,
        height: device.height / scale,
      });
    }
  }
  return quads;
}

/** Converts the selection into a markup annotation on this page (if any
 * of it lies there) and clears the selection afterwards. */
export function markupFromSelection(
  pageEl: HTMLElement,
  pageIndex: number,
  pagePt: Size,
  scale: number,
  rotation: Rotation,
  kind: "highlight" | "underline" | "strikeout",
): boolean {
  const quads = selectionQuads(pageEl, pagePt, scale, rotation);
  if (quads.length === 0) return false;
  createAnnotation(pageIndex, { kind, quads });
  return true;
}

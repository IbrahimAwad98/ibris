// The annotation model. Pure data — no React, no Tauri.
//
// All geometry is in page points relative to the page's visible box with a
// top-left origin, the same convention as every other IPC geometry
// (decision 009). Conversion to PDF space happens once, in Rust, at save.

import type { Rect } from "./coords";

export interface Point {
  x: number;
  y: number;
}

export type AnnotationId = string;

export type StampName = "approved" | "rejected" | "draft" | "confidential";

interface AnnotationBase {
  id: AnnotationId;
  pageIndex: number;
  /** #rrggbb */
  color: string;
  /** 0..1 */
  opacity: number;
  author: string;
  createdAt: number;
  modifiedAt: number;
}

export type Annotation = AnnotationBase &
  (
    | { kind: "highlight" | "underline" | "strikeout"; quads: Rect[] }
    | { kind: "ink"; strokes: Point[][]; strokeWidth: number }
    | { kind: "note"; at: Point; contents: string }
    | { kind: "rect" | "ellipse"; rect: Rect; strokeWidth: number; fill?: string }
    | { kind: "line" | "arrow"; from: Point; to: Point; strokeWidth: number }
    | { kind: "stamp"; rect: Rect; stamp: StampName }
  );

/** The annotation shifted by (dx, dy) points; used by drag-to-move. */
export function translateAnnotation(a: Annotation, dx: number, dy: number): Annotation {
  const pt = (p: Point): Point => ({ x: p.x + dx, y: p.y + dy });
  const rc = (r: Rect): Rect => ({ ...r, x: r.x + dx, y: r.y + dy });
  switch (a.kind) {
    case "highlight":
    case "underline":
    case "strikeout":
      return { ...a, quads: a.quads.map(rc) };
    case "ink":
      return { ...a, strokes: a.strokes.map((s) => s.map(pt)) };
    case "note":
      return { ...a, at: pt(a.at) };
    case "rect":
    case "ellipse":
      return { ...a, rect: rc(a.rect) };
    case "line":
    case "arrow":
      return { ...a, from: pt(a.from), to: pt(a.to) };
    case "stamp":
      return { ...a, rect: rc(a.rect) };
  }
}

/** Human label for the undo history, e.g. "Add highlight". */
export function annotationNoun(a: Annotation): string {
  switch (a.kind) {
    case "strikeout":
      return "strikethrough";
    case "ink":
      return "ink stroke";
    case "rect":
      return "rectangle";
    default:
      return a.kind;
  }
}

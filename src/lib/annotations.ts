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
    | {
        kind: "shape";
        shape: "rect" | "ellipse";
        rect: Rect;
        strokeWidth: number;
        fill?: string;
      }
    | {
        kind: "shape";
        shape: "line" | "arrow";
        from: Point;
        to: Point;
        strokeWidth: number;
      }
    | { kind: "stamp"; rect: Rect; stamp: StampName }
  );

/** Human label for the undo history, e.g. "Add highlight". */
export function annotationNoun(a: Annotation): string {
  switch (a.kind) {
    case "highlight":
      return "highlight";
    case "underline":
      return "underline";
    case "strikeout":
      return "strikethrough";
    case "ink":
      return "ink stroke";
    case "note":
      return "note";
    case "shape":
      return a.shape === "rect"
        ? "rectangle"
        : a.shape === "ellipse"
          ? "ellipse"
          : a.shape;
    case "stamp":
      return "stamp";
  }
}

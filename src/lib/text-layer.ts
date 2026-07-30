// Pure positioning math for the selectable text layer. Rotation never
// appears here: the text layer lives inside the same CSS-transformed
// container as the canvas, so these values are always in unrotated page
// device pixels and rotation applies structurally.

import type { TextRun } from "../ipc/pdf";

export interface RunStyle {
  left: number;
  top: number;
  fontSize: number;
  targetWidth: number;
}

/** Position and size of one run's span at the given scale. */
export function runStyle(run: TextRun, scale: number): RunStyle {
  return {
    left: run.x * scale,
    top: run.y * scale,
    fontSize: run.height * scale,
    targetWidth: run.width * scale,
  };
}

/**
 * Horizontal stretch that makes browser-measured text occupy exactly the
 * width PDFium reported (the pdf.js approach). Falls back to 1 when the
 * measurement is degenerate.
 */
export function scaleXFor(targetWidth: number, measuredWidth: number): number {
  if (!(measuredWidth > 0) || !(targetWidth > 0)) return 1;
  return targetWidth / measuredWidth;
}

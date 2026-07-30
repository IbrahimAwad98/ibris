import { describe, expect, it } from "vitest";
import { pageToDisplay, type Rotation } from "./coords";
import { highlightStyle, runStyle, scaleXFor } from "./text-layer";

const RUN = { text: "hello", x: 72, y: 68, width: 300, height: 24 };

describe("runStyle", () => {
  it("scales all geometry linearly with zoom", () => {
    const at1 = runStyle(RUN, 1);
    expect(at1).toEqual({ left: 72, top: 68, fontSize: 24, targetWidth: 300 });

    const at3 = runStyle(RUN, 3);
    expect(at3.left).toBe(at1.left * 3);
    expect(at3.top).toBe(at1.top * 3);
    expect(at3.fontSize).toBe(at1.fontSize * 3);
    expect(at3.targetWidth).toBe(at1.targetWidth * 3);
  });

  it("takes no rotation input — rotation is the container transform's job", () => {
    // The invariant behind "selection survives rotation": the text layer's
    // own math is rotation-blind by construction.
    expect(runStyle.length).toBe(2);
  });
});

describe("highlightStyle stays glued to the character box", () => {
  // The regression that motivated this file: highlights that pass a
  // same-formula comparison can still be wrong if either layer re-flips or
  // re-rotates. The invariant that matters: a highlight for a char box must
  // land on the same on-screen pixels as that box itself, at every zoom and
  // rotation, with the rotator's transform applied to both.
  const PAGE = { width: 612, height: 792 };
  // Known char box (top-left-origin page points, as the engine emits).
  const CHAR_BOX = { x: 122, y: 68.4, width: 73.2, height: 27.1 };
  const SCALES = [1, 2.42, 5];
  const ROTATIONS: Rotation[] = [0, 90, 180, 270];

  it("matches the char box corner-for-corner at every zoom and rotation", () => {
    for (const scale of SCALES) {
      const h = highlightStyle(CHAR_BOX, scale);

      // Where the char box itself sits in unrotated device pixels.
      expect(h.left).toBeCloseTo(CHAR_BOX.x * scale, 5);
      expect(h.top).toBeCloseTo(CHAR_BOX.y * scale, 5);
      expect(h.width).toBeCloseTo(CHAR_BOX.width * scale, 5);
      expect(h.height).toBeCloseTo(CHAR_BOX.height * scale, 5);

      for (const rotation of ROTATIONS) {
        // On screen, the rotator maps both the highlight div and the char
        // box through the same transform. Corner-map both; they must agree.
        const corners = [
          { x: h.left, y: h.top },
          { x: h.left + h.width, y: h.top + h.height },
        ];
        const expected = [
          { x: CHAR_BOX.x * scale, y: CHAR_BOX.y * scale },
          {
            x: (CHAR_BOX.x + CHAR_BOX.width) * scale,
            y: (CHAR_BOX.y + CHAR_BOX.height) * scale,
          },
        ];
        for (let i = 0; i < corners.length; i++) {
          const got = pageToDisplay(corners[i], PAGE, scale, rotation);
          const want = pageToDisplay(expected[i], PAGE, scale, rotation);
          expect(got.x, `scale ${scale} rot ${rotation}`).toBeCloseTo(want.x, 4);
          expect(got.y, `scale ${scale} rot ${rotation}`).toBeCloseTo(want.y, 4);
        }
      }
    }
  });

  it("carries no rotation parameter — the rotator owns rotation", () => {
    expect(highlightStyle.length).toBe(2);
  });
});

describe("scaleXFor", () => {
  it("stretches measured text to the PDF-reported width", () => {
    expect(scaleXFor(300, 200)).toBeCloseTo(1.5);
    expect(scaleXFor(200, 300)).toBeCloseTo(2 / 3);
  });

  it("falls back to 1 on degenerate measurements", () => {
    expect(scaleXFor(300, 0)).toBe(1);
    expect(scaleXFor(0, 200)).toBe(1);
    expect(scaleXFor(300, NaN)).toBe(1);
  });
});

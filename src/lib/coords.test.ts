import { describe, expect, it } from "vitest";
import {
  displayRectToPageRect,
  displaySize,
  displayToPage,
  pageToDisplay,
  pageToPdf,
  pdfToPage,
  type Rotation,
} from "./coords";

// Letter page: 612x792pt. At scale 2 the unrotated device size is 1224x1584.
const PAGE = { width: 612, height: 792 };
const SCALE = 2;
const ROTATIONS: Rotation[] = [0, 90, 180, 270];

describe("pdf <-> page", () => {
  it("flips the Y axis and scales", () => {
    // PDF origin is bottom-left; page origin is top-left.
    expect(pdfToPage({ x: 0, y: 0 }, PAGE, SCALE)).toEqual({ x: 0, y: 1584 });
    expect(pdfToPage({ x: 72, y: 700 }, PAGE, SCALE)).toEqual({ x: 144, y: 184 });
  });

  it("round-trips", () => {
    const p = { x: 123.5, y: 456.25 };
    const back = pageToPdf(pdfToPage(p, PAGE, SCALE), PAGE, SCALE);
    expect(back.x).toBeCloseTo(p.x);
    expect(back.y).toBeCloseTo(p.y);
  });
});

describe("page <-> display", () => {
  it("maps the top-left corner correctly under each rotation", () => {
    const corner = { x: 0, y: 0 };
    // 90cw: top-left goes to top-right of the rotated layout.
    expect(pageToDisplay(corner, PAGE, SCALE, 0)).toEqual({ x: 0, y: 0 });
    expect(pageToDisplay(corner, PAGE, SCALE, 90)).toEqual({ x: 1584, y: 0 });
    expect(pageToDisplay(corner, PAGE, SCALE, 180)).toEqual({ x: 1224, y: 1584 });
    expect(pageToDisplay(corner, PAGE, SCALE, 270)).toEqual({ x: 0, y: 1224 });
  });

  it("display size swaps axes at 90/270 only", () => {
    expect(displaySize(PAGE, SCALE, 0)).toEqual({ width: 1224, height: 1584 });
    expect(displaySize(PAGE, SCALE, 90)).toEqual({ width: 1584, height: 1224 });
    expect(displaySize(PAGE, SCALE, 180)).toEqual({ width: 1224, height: 1584 });
    expect(displaySize(PAGE, SCALE, 270)).toEqual({ width: 1584, height: 1224 });
  });

  it("round-trips at every rotation", () => {
    const p = { x: 300, y: 500 };
    for (const r of ROTATIONS) {
      const back = displayToPage(pageToDisplay(p, PAGE, SCALE, r), PAGE, SCALE, r);
      expect(back, `rotation ${r}`).toEqual(p);
    }
  });
});

describe("displayRectToPageRect", () => {
  it("is identity at rotation 0", () => {
    const r = { x: 10, y: 20, width: 100, height: 200 };
    expect(displayRectToPageRect(r, PAGE, SCALE, 0)).toEqual(r);
  });

  it("maps a corner rect at 90cw back to the page's bottom-left region", () => {
    // Display top-left corner rect at 90cw came from the page's bottom-left.
    const r = { x: 0, y: 0, width: 100, height: 50 };
    const mapped = displayRectToPageRect(r, PAGE, SCALE, 90);
    expect(mapped).toEqual({ x: 0, y: 1484, width: 50, height: 100 });
  });

  it("preserves area dimensions swapped at 270", () => {
    const r = { x: 40, y: 60, width: 100, height: 50 };
    const mapped = displayRectToPageRect(r, PAGE, SCALE, 270);
    expect(mapped.width).toBe(50);
    expect(mapped.height).toBe(100);
  });
});

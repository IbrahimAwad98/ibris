import { describe, expect, it } from "vitest";
import {
  MAX_SCALE,
  MIN_SCALE,
  anchorScroll,
  clampScale,
  fitPageScale,
  fitWidthScale,
  zoomIn,
  zoomOut,
} from "./zoom";

const PAGE = { width: 612, height: 792 };

describe("clamp and steps", () => {
  it("clamps to the 10%-800% range", () => {
    expect(clampScale(0.01)).toBe(MIN_SCALE);
    expect(clampScale(50)).toBe(MAX_SCALE);
    expect(clampScale(1.5)).toBe(1.5);
  });

  it("zoomIn/zoomOut are inverses inside the range", () => {
    expect(zoomOut(zoomIn(1.5))).toBeCloseTo(1.5);
  });

  it("steps stop at the bounds", () => {
    expect(zoomIn(MAX_SCALE)).toBe(MAX_SCALE);
    expect(zoomOut(MIN_SCALE)).toBe(MIN_SCALE);
  });
});

describe("anchorScroll", () => {
  it("keeps the content point under the anchor stationary", () => {
    const scroll = { left: 1000, top: 3000 };
    const anchor = { x: 400, y: 250 };
    const oldScale = 2;
    const newScale = 3;

    // Content coordinate under the anchor, in scale-1 units.
    const contentX = (scroll.left + anchor.x) / oldScale;
    const contentY = (scroll.top + anchor.y) / oldScale;

    const next = anchorScroll(scroll, anchor, oldScale, newScale);

    expect((next.left + anchor.x) / newScale).toBeCloseTo(contentX);
    expect((next.top + anchor.y) / newScale).toBeCloseTo(contentY);
  });

  it("is identity when scale does not change", () => {
    const scroll = { left: 123, top: 456 };
    expect(anchorScroll(scroll, { x: 10, y: 20 }, 2, 2)).toEqual(scroll);
  });
});

describe("fit scales", () => {
  it("fit-width fills the viewport width minus margins", () => {
    // 1024 viewport, 8px margins: (1024-16)/612 ≈ 1.647
    const s = fitWidthScale(1024, PAGE, 0, 8);
    expect(s * 612).toBeCloseTo(1008);
  });

  it("fit-width uses rotated width at 90 degrees", () => {
    const s = fitWidthScale(1024, PAGE, 90, 8);
    expect(s * 792).toBeCloseTo(1008);
  });

  it("fit-page is limited by the tighter dimension", () => {
    // 1000x800 viewport: height is the constraint for a portrait page.
    const s = fitPageScale({ width: 1000, height: 800 }, PAGE, 0, 0);
    expect(s * 792).toBeCloseTo(800);
    expect(s * 612).toBeLessThan(1000);
  });

  it("fit results are clamped", () => {
    const s = fitPageScale({ width: 30, height: 30 }, PAGE, 0, 0);
    expect(s).toBe(MIN_SCALE);
  });
});

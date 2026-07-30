import { describe, expect, it } from "vitest";
import { runStyle, scaleXFor } from "./text-layer";

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

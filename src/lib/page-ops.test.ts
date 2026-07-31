import { describe, expect, it } from "vitest";
import { moveSlots, removeSlots } from "./page-ops";

describe("moveSlots", () => {
  it("moves a single slot forward and back", () => {
    // insertAt is "before this slot"; length means the end.
    expect(moveSlots([0, 1, 2, 3], [1], 4)).toEqual([0, 2, 3, 1]);
    expect(moveSlots([0, 1, 2, 3], [1], 3)).toEqual([0, 2, 1, 3]);
    expect(moveSlots([0, 1, 2, 3], [3], 0)).toEqual([3, 0, 1, 2]);
  });

  it("moves a contiguous block keeping its order", () => {
    expect(moveSlots([0, 1, 2, 3, 4], [1, 2], 5)).toEqual([0, 3, 4, 1, 2]);
  });

  it("moves a non-contiguous selection as one block", () => {
    expect(moveSlots([0, 1, 2, 3, 4], [0, 2], 4)).toEqual([1, 3, 0, 2, 4]);
  });

  it("dropping onto the selection is a no-op", () => {
    expect(moveSlots([0, 1, 2], [1], 1)).toEqual([0, 1, 2]);
    expect(moveSlots([0, 1, 2], [1], 2)).toEqual([0, 1, 2]);
  });
});

describe("removeSlots", () => {
  it("removes the selected view slots", () => {
    expect(removeSlots([5, 6, 7], [0, 2])).toEqual([6]);
  });

  it("never removes every page", () => {
    expect(removeSlots([5, 6], [0, 1])).toEqual([5, 6]);
  });
});

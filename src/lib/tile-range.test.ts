import { describe, expect, it } from "vitest";
import { TILE_SIZE, visibleTiles } from "./tile-range";

// 1224x1584 page at scale 2 → 3x4 tile grid (ceil(1224/512)=3, ceil(1584/512)=4).
const PAGE = { width: 1224, height: 1584 };

describe("visibleTiles", () => {
  it("covers the whole grid when the visible rect is the whole page", () => {
    const tiles = visibleTiles(PAGE, { x: 0, y: 0, width: 1224, height: 1584 }, 0);
    expect(tiles).toHaveLength(12);
    expect(tiles[0]).toEqual({ tx: 0, ty: 0 });
    expect(tiles[11]).toEqual({ tx: 2, ty: 3 });
  });

  it("returns a single tile for a small rect inside one tile, no overscan", () => {
    const tiles = visibleTiles(PAGE, { x: 10, y: 10, width: 100, height: 100 }, 0);
    expect(tiles).toEqual([{ tx: 0, ty: 0 }]);
  });

  it("overscan pulls in neighbouring tiles", () => {
    const tiles = visibleTiles(
      PAGE,
      { x: 10, y: 10, width: 100, height: 100 },
      TILE_SIZE,
    );
    expect(tiles).toEqual([
      { tx: 0, ty: 0 },
      { tx: 1, ty: 0 },
      { tx: 0, ty: 1 },
      { tx: 1, ty: 1 },
    ]);
  });

  it("a rect exactly on a tile boundary does not include the next tile", () => {
    // Right edge at exactly 512: tile 1 starts at 512, edge pixel 511 is last.
    const tiles = visibleTiles(PAGE, { x: 0, y: 0, width: 512, height: 512 }, 0);
    expect(tiles).toEqual([{ tx: 0, ty: 0 }]);
  });

  it("clamps to the page grid at the far edge", () => {
    const tiles = visibleTiles(
      PAGE,
      { x: 1100, y: 1500, width: 500, height: 500 },
      0,
    );
    expect(tiles).toEqual([{ tx: 2, ty: 2 }, { tx: 2, ty: 3 }]);
  });

  it("returns empty when there is no intersection", () => {
    expect(visibleTiles(PAGE, { x: 5000, y: 0, width: 100, height: 100 }, 0)).toEqual(
      [],
    );
    expect(
      visibleTiles(PAGE, { x: -500, y: -500, width: 100, height: 100 }, 0),
    ).toEqual([]);
  });

  it("handles a page smaller than one tile", () => {
    const tiles = visibleTiles(
      { width: 300, height: 200 },
      { x: 0, y: 0, width: 300, height: 200 },
      0,
    );
    expect(tiles).toEqual([{ tx: 0, ty: 0 }]);
  });
});

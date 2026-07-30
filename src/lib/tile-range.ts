// Which 512px tiles of an (unrotated) page intersect a visible rect.

import type { Rect, Size } from "./coords";

export const TILE_SIZE = 512;

export interface TileCoord {
  tx: number;
  ty: number;
}

/**
 * Tiles of a page (device pixels, unrotated space) intersecting `visible`
 * (same space), expanded by `overscanPx` on every side. Returns row-major
 * order. Empty when there is no intersection.
 */
export function visibleTiles(
  pageSize: Size,
  visible: Rect,
  overscanPx: number = TILE_SIZE / 2,
): TileCoord[] {
  const left = visible.x - overscanPx;
  const top = visible.y - overscanPx;
  const right = visible.x + visible.width + overscanPx;
  const bottom = visible.y + visible.height + overscanPx;

  const maxTx = Math.ceil(pageSize.width / TILE_SIZE) - 1;
  const maxTy = Math.ceil(pageSize.height / TILE_SIZE) - 1;

  const txStart = Math.max(0, Math.floor(left / TILE_SIZE));
  const txEnd = Math.min(maxTx, Math.floor((right - 1) / TILE_SIZE));
  const tyStart = Math.max(0, Math.floor(top / TILE_SIZE));
  const tyEnd = Math.min(maxTy, Math.floor((bottom - 1) / TILE_SIZE));

  const tiles: TileCoord[] = [];
  for (let ty = tyStart; ty <= tyEnd; ty++) {
    for (let tx = txStart; tx <= txEnd; tx++) {
      tiles.push({ tx, ty });
    }
  }
  return tiles;
}

/** Cache / in-flight key for one tile. Scale is part of the identity. */
export function tileKey(
  docId: number,
  pageIndex: number,
  scale: number,
  tx: number,
  ty: number,
): string {
  return `${docId}:${pageIndex}@${scale}/${tx},${ty}`;
}

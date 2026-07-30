import { useEffect, useLayoutEffect, useRef } from "react";
import { nextRequestId, renderTile } from "../../ipc/pdf";
import type { Rect, Rotation, Size } from "../../lib/coords";
import {
  displayRectToPageRect,
  displaySize,
  pageDeviceSize,
} from "../../lib/coords";
import { TILE_SIZE, tileKey, visibleTiles } from "../../lib/tile-range";
import { useViewerStore } from "../../state/viewer-store";
import {
  clearInFlight,
  isInFlight,
  markInFlight,
  sweepInFlight,
  tileCache,
} from "./page-cache";
import { SearchHighlights } from "./SearchHighlights";
import { TextLayer } from "./TextLayer";

interface PageViewProps {
  docId: number;
  pageIndex: number;
  top: number;
  left: number;
  pagePt: Size;
  scale: number;
  rotation: Rotation;
  /** Viewport rect in display-page coordinates (may extend past the page). */
  viewRect: Rect;
}

/**
 * One page as a tile compositor. The canvas holds the *unrotated* page at
 * device scale; rotation is a CSS transform on the canvas so the coming
 * text layer can share the exact same transform and never drift. The
 * low-res preview draws first, tiles composite on top as they arrive.
 */
// ponytail: the canvas covers the full page at device scale (~124 MB of GPU
// at 800% for a letter page, 1-2 pages mounted). Swap to a viewport-sized
// canvas if memory profiling ever objects.
export function PageView({
  docId,
  pageIndex,
  top,
  left,
  pagePt,
  scale,
  rotation,
  viewRect,
}: PageViewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawnTiles = useRef<Set<string>>(new Set());

  const unrot = pageDeviceSize(pagePt, scale);
  const disp = displaySize(pagePt, scale, rotation);
  const preview = useViewerStore((s) => s.previews.get(pageIndex));

  // Reset pass: runs when the canvas identity changes (scale/doc/page).
  // Setting width/height clears the canvas; start from the preview.
  useLayoutEffect(() => {
    drawnTiles.current.clear();
    const ctx = canvasRef.current?.getContext("2d");
    if (!ctx) return;
    drawUnderlay(ctx, unrot, useViewerStore.getState().previews.get(pageIndex));
  }, [docId, pageIndex, scale, unrot.width, unrot.height]);

  // A preview arriving late only fills a canvas that has no tiles yet.
  useEffect(() => {
    const ctx = canvasRef.current?.getContext("2d");
    if (ctx && preview && drawnTiles.current.size === 0) {
      drawUnderlay(ctx, unrot, preview);
    }
  }, [preview, unrot.width, unrot.height]);

  // Tile pass: request what the viewport needs, cancel what it no longer does.
  useEffect(() => {
    const ctx = canvasRef.current?.getContext("2d");
    if (!ctx) return;

    const pageRect = displayRectToPageRect(viewRect, pagePt, scale, rotation);
    const needed = visibleTiles(unrot, pageRect);
    const neededKeys = new Set(
      needed.map((t) => tileKey(docId, pageIndex, scale, t.tx, t.ty)),
    );

    // Abandon queued tiles of this page+scale that scrolled out of relevance.
    const prefix = `${docId}:${pageIndex}@${scale}/`;
    sweepInFlight((key) => key.startsWith(prefix) && !neededKeys.has(key));

    for (const t of needed) {
      const key = tileKey(docId, pageIndex, scale, t.tx, t.ty);
      if (drawnTiles.current.has(key)) continue;

      const cached = tileCache.get(key);
      if (cached) {
        ctx.putImageData(cached, t.tx * TILE_SIZE, t.ty * TILE_SIZE);
        drawnTiles.current.add(key);
        continue;
      }
      if (isInFlight(key)) continue;

      const requestId = nextRequestId();
      markInFlight(key, requestId);
      renderTile(
        docId,
        pageIndex,
        scale,
        {
          x: t.tx * TILE_SIZE,
          y: t.ty * TILE_SIZE,
          width: TILE_SIZE,
          height: TILE_SIZE,
        },
        requestId,
      )
        .then((tilePage) => {
          clearInFlight(key);
          const img = new ImageData(tilePage.data, tilePage.width, tilePage.height);
          tileCache.set(key, img);
          // Only paint if this canvas still shows the same doc/page/scale.
          const c = canvasRef.current;
          if (c && !drawnTiles.current.has(key)) {
            const liveCtx = c.getContext("2d");
            if (liveCtx) {
              liveCtx.putImageData(img, t.tx * TILE_SIZE, t.ty * TILE_SIZE);
              drawnTiles.current.add(key);
            }
          }
        })
        .catch(() => clearInFlight(key));
    }
  }, [docId, pageIndex, scale, rotation, viewRect.x, viewRect.y, viewRect.width, viewRect.height]);

  // Unmount: abandon anything still queued for this page, at any scale.
  useEffect(() => {
    const prefix = `${docId}:${pageIndex}@`;
    return () => sweepInFlight((key) => key.startsWith(prefix));
  }, [docId, pageIndex]);

  return (
    <div
      style={{
        position: "absolute",
        top,
        left,
        width: disp.width,
        height: disp.height,
        boxShadow: "0 2px 8px rgba(0, 0, 0, 0.35)",
        background: "#fff",
      }}
    >
      {/* The rotator: canvas, text layer, and highlights share this single
          transform, so they can never drift apart under zoom or rotation. */}
      <div
        style={{
          position: "absolute",
          width: unrot.width,
          height: unrot.height,
          left: (disp.width - unrot.width) / 2,
          top: (disp.height - unrot.height) / 2,
          transform: `rotate(${rotation}deg)`,
          transformOrigin: "center",
        }}
      >
        <canvas
          ref={canvasRef}
          width={unrot.width}
          height={unrot.height}
          style={{ position: "absolute", inset: 0 }}
        />
        <TextLayer docId={docId} pageIndex={pageIndex} scale={scale} />
        <SearchHighlights pageIndex={pageIndex} scale={scale} />
      </div>
    </div>
  );
}

function drawUnderlay(
  ctx: CanvasRenderingContext2D,
  unrot: Size,
  preview: ImageBitmap | undefined,
) {
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, unrot.width, unrot.height);
  if (preview) {
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(preview, 0, 0, unrot.width, unrot.height);
  }
}

import { useEffect, useRef } from "react";
import { cancelRender, nextRequestId, renderPage } from "../../ipc/pdf";
import { SCALE, useViewerStore } from "../../state/viewer-store";
import { cacheKey, sharpCache } from "./page-cache";

interface PageViewProps {
  pageIndex: number;
  top: number;
  width: number;
  height: number;
}

/**
 * One page canvas. Draws whatever is best available immediately — cached
 * sharp bitmap, else the low-res preview stretched to size — then requests
 * the sharp render and swaps it in. Leaving the visible range unmounts the
 * component, which cancels the in-flight request.
 */
export function PageView({ pageIndex, top, width, height }: PageViewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const hasSharp = useRef(false);
  const docId = useViewerStore((s) => s.docId);
  const preview = useViewerStore((s) => s.previews.get(pageIndex));

  useEffect(() => {
    hasSharp.current = false;
    const ctx = canvasRef.current?.getContext("2d");
    if (!ctx || docId === null) return;

    const key = cacheKey(docId, pageIndex, SCALE);
    const cached = sharpCache.get(key);
    if (cached) {
      ctx.putImageData(cached, 0, 0);
      hasSharp.current = true;
      return;
    }

    drawPlaceholder(ctx, width, height, useViewerStore.getState().previews.get(pageIndex));

    let alive = true;
    const requestId = nextRequestId();
    renderPage(docId, pageIndex, SCALE, requestId)
      .then((page) => {
        const img = new ImageData(page.data, page.width, page.height);
        sharpCache.set(key, img);
        if (alive) {
          ctx.putImageData(img, 0, 0);
          hasSharp.current = true;
        }
      })
      .catch(() => {
        // Cancelled (page scrolled away) or transient — placeholder stands.
      });
    return () => {
      alive = false;
      void cancelRender(requestId).catch(() => undefined);
    };
  }, [docId, pageIndex, width, height]);

  // A preview arriving after mount only upgrades a still-blank placeholder.
  useEffect(() => {
    const ctx = canvasRef.current?.getContext("2d");
    if (ctx && preview && !hasSharp.current) {
      drawImageSmooth(ctx, preview, width, height);
    }
  }, [preview, width, height]);

  return (
    <canvas
      ref={canvasRef}
      width={width}
      height={height}
      style={{
        position: "absolute",
        top,
        left: "50%",
        transform: "translateX(-50%)",
        background: "#fff",
        boxShadow: "0 2px 8px rgba(0, 0, 0, 0.35)",
      }}
    />
  );
}

function drawPlaceholder(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  preview: ImageBitmap | undefined,
) {
  if (preview) {
    drawImageSmooth(ctx, preview, width, height);
  } else {
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, width, height);
  }
}

function drawImageSmooth(
  ctx: CanvasRenderingContext2D,
  bitmap: ImageBitmap,
  width: number,
  height: number,
) {
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bitmap, 0, 0, width, height);
}

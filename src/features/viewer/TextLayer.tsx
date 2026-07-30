import { useEffect, useMemo, useState } from "react";
import { extractText, type TextRun } from "../../ipc/pdf";
import { runStyle, scaleXFor } from "../../lib/text-layer";

/** Extracted runs per doc:page — tiny data, kept for the session. */
const textCache = new Map<string, TextRun[]>();

interface TextLayerProps {
  docId: number;
  pageIndex: number;
  scale: number;
}

/**
 * Transparent selectable text over the canvas. Must be rendered inside the
 * page's rotated container ("rotator") so zoom and rotation apply
 * structurally — nothing here knows about either beyond multiplying by
 * scale.
 */
export function TextLayer({ docId, pageIndex, scale }: TextLayerProps) {
  const cacheKey = `${docId}:${pageIndex}`;
  const [runs, setRuns] = useState<TextRun[] | null>(
    () => textCache.get(cacheKey) ?? null,
  );

  useEffect(() => {
    const cached = textCache.get(cacheKey);
    if (cached) {
      setRuns(cached);
      return;
    }
    let alive = true;
    extractText(docId, pageIndex)
      .then((t) => {
        textCache.set(cacheKey, t.runs);
        if (alive) setRuns(t.runs);
      })
      .catch(() => undefined); // no text layer is a soft failure
    return () => {
      alive = false;
    };
  }, [cacheKey, docId, pageIndex]);

  const measurer = useMemo(
    () => document.createElement("canvas").getContext("2d"),
    [],
  );

  if (!runs) return null;

  return (
    <div
      className="textlayer"
      style={{
        position: "absolute",
        inset: 0,
        overflow: "hidden",
        lineHeight: 1,
      }}
    >
      {runs.map((run, i) => {
        const s = runStyle(run, scale);
        let measured = s.targetWidth;
        if (measurer) {
          measurer.font = `${s.fontSize}px sans-serif`;
          measured = measurer.measureText(run.text).width;
        }
        return (
          <span
            key={i}
            style={{
              position: "absolute",
              left: s.left,
              top: s.top,
              fontSize: s.fontSize,
              fontFamily: "sans-serif",
              whiteSpace: "pre",
              color: "transparent",
              transformOrigin: "0 0",
              transform: `scaleX(${scaleXFor(s.targetWidth, measured)})`,
              cursor: "text",
            }}
          >
            {run.text}
          </span>
        );
      })}
    </div>
  );
}

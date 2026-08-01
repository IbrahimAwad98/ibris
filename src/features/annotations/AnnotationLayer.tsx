import { useRef, useState } from "react";
import type { Annotation } from "../../lib/annotations";
import { translateAnnotation } from "../../lib/annotations";
import type { Size } from "../../lib/coords";
import {
  modifyAnnotation,
  useDocumentStore,
} from "../../state/document-store";
import { useToolStore } from "../../state/tool-store";
import { useUiStore } from "../../state/ui-store";
import { AnnotationShape } from "./AnnotationShape";

interface Props {
  pageIndex: number;
  pagePt: Size;
  scale: number;
}

/**
 * SVG overlay drawing this page's annotations in point coordinates.
 * Highlights live in a separate blending SVG (multiply on paper, screen on
 * inverted paper) so text stays legible underneath them.
 */
export function AnnotationLayer({ pageIndex, pagePt, scale }: Props) {
  const annotations = useDocumentStore((s) => s.annotations);
  const tool = useToolStore((s) => s.tool);
  const selectedId = useToolStore((s) => s.selectedId);
  const setSelectedId = useToolStore((s) => s.setSelectedId);
  const dark = useUiStore((s) => s.resolvedTheme === "dark");
  const execute = useDocumentStore((s) => s.execute);

  const drag = useRef<{ id: string; startX: number; startY: number } | null>(null);
  const [delta, setDelta] = useState<{ id: string; dx: number; dy: number } | null>(null);

  const pageAnnots = Object.values(annotations).filter(
    (a) => a.pageIndex === pageIndex,
  );
  const highlights = pageAnnots.filter((a) => a.kind === "highlight");
  const others = pageAnnots.filter((a) => a.kind !== "highlight");

  const svgProps = {
    width: pagePt.width * scale,
    height: pagePt.height * scale,
    viewBox: `0 0 ${pagePt.width} ${pagePt.height}`,
    style: { position: "absolute", inset: 0, pointerEvents: "none" } as const,
  };

  const startDrag = (a: Annotation, e: React.PointerEvent) => {
    if (tool !== "select") return;
    e.stopPropagation();
    setSelectedId(a.id);
    drag.current = { id: a.id, startX: e.clientX, startY: e.clientY };
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
  };

  const moveDrag = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    setDelta({
      id: d.id,
      dx: (e.clientX - d.startX) / scale,
      dy: (e.clientY - d.startY) / scale,
    });
  };

  const endDrag = () => {
    const d = drag.current;
    drag.current = null;
    if (!d || !delta || (Math.abs(delta.dx) < 0.5 && Math.abs(delta.dy) < 0.5)) {
      setDelta(null);
      return;
    }
    const before = useDocumentStore.getState().annotations[d.id];
    if (before) {
      const after = {
        ...translateAnnotation(before, delta.dx, delta.dy),
        modifiedAt: Date.now(),
      };
      execute(modifyAnnotation(before, after));
    }
    setDelta(null);
  };

  const renderGroup = (a: Annotation) => {
    const moved =
      delta && delta.id === a.id ? translateAnnotation(a, delta.dx, delta.dy) : a;
    return (
      <g
        key={a.id}
        style={{
          pointerEvents: tool === "select" ? "auto" : "none",
          cursor: tool === "select" ? "move" : undefined,
        }}
        onPointerDown={(e) => startDrag(a, e)}
        onPointerMove={moveDrag}
        onPointerUp={endDrag}
      >
        <AnnotationShape annotation={moved} selected={a.id === selectedId} />
      </g>
    );
  };

  // Note: drag rotation support is deliberately absent — the layer sits in
  // the rotator, so pointer deltas are display-space. Dragging on a rotated
  // page moves along rotated axes; acceptable for M2 and on the checklist.
  return (
    <>
      <svg {...svgProps} style={{ ...svgProps.style, mixBlendMode: dark ? "screen" : "multiply" }}>
        {highlights.map(renderGroup)}
      </svg>
      <svg {...svgProps}>{others.map(renderGroup)}</svg>
    </>
  );
}

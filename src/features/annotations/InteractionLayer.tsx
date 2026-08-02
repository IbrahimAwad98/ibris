import { useRef, useState } from "react";
import type { Rotation, Size } from "../../lib/coords";
import { displayToPage } from "../../lib/coords";
import { activeSettings, useToolStore } from "../../state/tool-store";
import { addRedaction, useDocumentStore } from "../../state/document-store";
import { AnnotationShape } from "./AnnotationShape";
import { RedactionHatch, RedactionMarkShape } from "./RedactionLayer";
import { createAnnotation } from "./annotate";
import type { Annotation } from "../../lib/annotations";

interface Props {
  pageIndex: number;
  pagePt: Size;
  scale: number;
  rotation: Rotation;
  /** The page's outer (untransformed) element, for screen→page mapping. */
  outerRef: React.RefObject<HTMLDivElement | null>;
}

interface Pt {
  x: number;
  y: number;
}

const DRAW_TOOLS = new Set([
  "ink",
  "rect",
  "ellipse",
  "line",
  "arrow",
  "note",
  "stamp",
  "redact",
]);

/** Captures pointer input for the drawing tools and previews the shape
 * being created; each completed gesture becomes one command. */
export function InteractionLayer({ pageIndex, pagePt, scale, rotation, outerRef }: Props) {
  const tool = useToolStore((s) => s.tool);
  const stampKind = useToolStore((s) => s.stamp);
  const [stroke, setStroke] = useState<Pt[] | null>(null);
  const [dragFrom, setDragFrom] = useState<Pt | null>(null);
  const [dragTo, setDragTo] = useState<Pt | null>(null);
  const [noteAt, setNoteAt] = useState<Pt | null>(null);
  const noteText = useRef("");

  if (!DRAW_TOOLS.has(tool)) return null;

  const toPagePt = (e: { clientX: number; clientY: number }): Pt => {
    const outer = outerRef.current?.getBoundingClientRect();
    const display = {
      x: e.clientX - (outer?.left ?? 0),
      y: e.clientY - (outer?.top ?? 0),
    };
    const device = displayToPage(display, pagePt, scale, rotation);
    return { x: device.x / scale, y: device.y / scale };
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || noteAt) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const p = toPagePt(e);
    if (tool === "ink") setStroke([p]);
    else if (tool === "note") {
      noteText.current = "";
      setNoteAt(p);
    } else if (tool === "stamp") {
      createAnnotation(pageIndex, {
        kind: "stamp",
        stamp: stampKind,
        rect: { x: p.x - 45, y: p.y - 18, width: 90, height: 36 },
      });
    } else {
      setDragFrom(p);
      setDragTo(p);
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (stroke) {
      const p = toPagePt(e);
      const last = stroke[stroke.length - 1];
      if (Math.hypot(p.x - last.x, p.y - last.y) > 0.7) setStroke([...stroke, p]);
    } else if (dragFrom) {
      setDragTo(toPagePt(e));
    }
  };

  const onPointerUp = () => {
    const settings = activeSettings();
    if (stroke) {
      if (stroke.length > 1) {
        createAnnotation(pageIndex, {
          kind: "ink",
          strokes: [stroke],
          strokeWidth: settings.strokeWidth,
        });
      }
      setStroke(null);
    } else if (dragFrom && dragTo) {
      const dx = Math.abs(dragTo.x - dragFrom.x);
      const dy = Math.abs(dragTo.y - dragFrom.y);
      if (dx > 2 || dy > 2) {
        if (tool === "redact") {
          // A pending, undoable mark — nothing touches the file until the
          // user confirms a save (M5).
          useDocumentStore.getState().execute(
            addRedaction({
              id: crypto.randomUUID(),
              pageIndex,
              rect: {
                x: Math.min(dragFrom.x, dragTo.x),
                y: Math.min(dragFrom.y, dragTo.y),
                width: dx,
                height: dy,
              },
            }),
          );
        } else if (tool === "rect" || tool === "ellipse") {
          createAnnotation(pageIndex, {
            kind: tool,
            rect: {
              x: Math.min(dragFrom.x, dragTo.x),
              y: Math.min(dragFrom.y, dragTo.y),
              width: dx,
              height: dy,
            },
            strokeWidth: settings.strokeWidth,
          });
        } else if (tool === "line" || tool === "arrow") {
          createAnnotation(pageIndex, {
            kind: tool,
            from: dragFrom,
            to: dragTo,
            strokeWidth: settings.strokeWidth,
          });
        }
      }
      setDragFrom(null);
      setDragTo(null);
    }
  };

  const commitNote = () => {
    if (noteAt && noteText.current.trim()) {
      createAnnotation(pageIndex, {
        kind: "note",
        at: noteAt,
        contents: noteText.current.trim(),
      });
    }
    setNoteAt(null);
  };

  const preview = previewAnnotation(tool, stroke, dragFrom, dragTo);

  return (
    <div
      style={{ position: "absolute", inset: 0, cursor: "crosshair", touchAction: "none" }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    >
      {preview && (
        <svg
          width={pagePt.width * scale}
          height={pagePt.height * scale}
          viewBox={`0 0 ${pagePt.width} ${pagePt.height}`}
          style={{ position: "absolute", inset: 0, pointerEvents: "none" }}
        >
          <AnnotationShape annotation={preview} selected={false} />
        </svg>
      )}
      {tool === "redact" && dragFrom && dragTo && (
        <svg
          width={pagePt.width * scale}
          height={pagePt.height * scale}
          viewBox={`0 0 ${pagePt.width} ${pagePt.height}`}
          style={{ position: "absolute", inset: 0, pointerEvents: "none" }}
        >
          <RedactionHatch id="redact-hatch-preview" />
          <RedactionMarkShape
            rect={{
              x: Math.min(dragFrom.x, dragTo.x),
              y: Math.min(dragFrom.y, dragTo.y),
              width: Math.abs(dragTo.x - dragFrom.x),
              height: Math.abs(dragTo.y - dragFrom.y),
            }}
            hatchId="redact-hatch-preview"
          />
        </svg>
      )}
      {noteAt && (
        <textarea
          autoFocus
          className="note-editor"
          style={{ left: noteAt.x * scale + 24, top: noteAt.y * scale }}
          placeholder="Note…  (Esc cancels)"
          onChange={(e) => {
            noteText.current = e.currentTarget.value;
          }}
          onBlur={commitNote}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Escape") {
              noteText.current = "";
              setNoteAt(null);
            } else if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              commitNote();
            }
          }}
        />
      )}
    </div>
  );
}

function previewAnnotation(
  tool: string,
  stroke: Pt[] | null,
  dragFrom: Pt | null,
  dragTo: Pt | null,
): Annotation | null {
  const settings = activeSettings();
  const base = {
    id: "preview",
    pageIndex: -1,
    color: settings.color,
    opacity: settings.opacity,
    author: "",
    createdAt: 0,
    modifiedAt: 0,
  };
  if (stroke && stroke.length > 1) {
    return { ...base, kind: "ink", strokes: [stroke], strokeWidth: settings.strokeWidth };
  }
  if (dragFrom && dragTo) {
    if (tool === "rect" || tool === "ellipse") {
      return {
        ...base,
        kind: tool,
        rect: {
          x: Math.min(dragFrom.x, dragTo.x),
          y: Math.min(dragFrom.y, dragTo.y),
          width: Math.abs(dragTo.x - dragFrom.x),
          height: Math.abs(dragTo.y - dragFrom.y),
        },
        strokeWidth: settings.strokeWidth,
      };
    }
    if (tool === "line" || tool === "arrow") {
      return {
        ...base,
        kind: tool,
        from: dragFrom,
        to: dragTo,
        strokeWidth: settings.strokeWidth,
      };
    }
  }
  return null;
}

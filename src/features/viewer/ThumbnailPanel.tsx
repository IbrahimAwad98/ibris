import { useEffect, useRef, useState } from "react";
import { moveSlots, removeSlots } from "../../lib/page-ops";
import { appCommands } from "../shell/commands";
import { setPageOrder, useDocumentStore } from "../../state/document-store";
import { useUiStore } from "../../state/ui-store";
import { useViewerStore } from "../../state/viewer-store";

// Registry commands surfaced here so they exist outside the palette.
const PAGE_COMMAND_IDS = [
  "insert-pages",
  "extract-page",
  "split-doc",
  "merge-pdfs",
];

/** Thumbnail sidebar: click to navigate, ctrl/shift multi-select, drag to
 * reorder (a command), delete selection (a command). */
export function ThumbnailPanel() {
  const pages = useViewerStore((s) => s.pages);
  const docOrder = useDocumentStore((s) => s.pageOrder);
  const inserts = useDocumentStore((s) => s.inserts);
  const currentPage = useViewerStore((s) => s.currentPage);
  const scrollToPage = useViewerStore((s) => s.scrollToPage);
  const execute = useDocumentStore((s) => s.execute);

  const [selected, setSelected] = useState<number[]>([]);
  const [dropAt, setDropAt] = useState<number | null>(null);
  const lastClick = useRef(0);

  const order = (docOrder ?? pages.map((_, i) => i)).filter((src) =>
    src >= 0 ? src < pages.length : -src - 1 < inserts.length,
  );

  // Structure changes (reorder/delete/undo) invalidate slot selections.
  useEffect(() => setSelected([]), [docOrder]);

  const onClick = (i: number, e: React.MouseEvent) => {
    if (e.ctrlKey) {
      setSelected((sel) =>
        sel.includes(i) ? sel.filter((s) => s !== i) : [...sel, i],
      );
    } else if (e.shiftKey) {
      const [a, b] = [Math.min(lastClick.current, i), Math.max(lastClick.current, i)];
      setSelected(Array.from({ length: b - a + 1 }, (_, k) => a + k));
      return; // keep the anchor
    } else {
      setSelected([i]);
      scrollToPage(i);
    }
    lastClick.current = i;
  };

  const onDrop = () => {
    if (dropAt === null || selected.length === 0) return;
    const next = moveSlots(order, selected, dropAt);
    setDropAt(null);
    if (next.some((src, i) => src !== order[i])) {
      const n = selected.length;
      execute(
        setPageOrder(order, next, n === 1 ? "Move page" : `Move ${n} pages`),
      );
    }
  };

  const deleteSelected = () => {
    if (selected.length === 0) return;
    const next = removeSlots(order, selected);
    if (next.length === order.length) return; // refused (last page)
    execute(
      setPageOrder(
        order,
        next,
        selected.length === 1 ? "Delete page" : `Delete ${selected.length} pages`,
      ),
    );
  };

  const pageCmds = appCommands().filter((c) =>
    PAGE_COMMAND_IDS.includes(c.id),
  );

  return (
    <div style={{ padding: 8 }}>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 4,
          paddingBottom: 8,
          borderBottom: "1px solid var(--border-deep)",
          marginBottom: 8,
        }}
      >
        {pageCmds.map((c) => (
          <button
            key={c.id}
            className="btn-secondary"
            style={{ fontSize: 11, padding: "3px 8px", textAlign: "left" }}
            disabled={!(c.enabled?.() ?? true)}
            onClick={() => c.run()}
          >
            {c.label}
          </button>
        ))}
      </div>
      {selected.length > 0 && (
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            fontSize: 11,
            color: "var(--text-dim)",
            padding: "0 2px 8px",
          }}
        >
          <span>{selected.length} selected</span>
          <button
            className="btn-secondary"
            style={{ padding: "2px 8px", fontSize: 11 }}
            disabled={selected.length >= order.length}
            title="Delete selected pages"
            onClick={deleteSelected}
          >
            Delete
          </button>
        </div>
      )}
      {order.map((src, i) => (
        <Thumbnail
          key={src}
          pageIndex={src}
          insertedFrom={
            src < 0
              ? (inserts[-src - 1]?.path.split(/[\\/]/).pop() ?? "file")
              : undefined
          }
          label={i + 1}
          active={i === currentPage}
          selected={selected.includes(i)}
          dropBefore={dropAt === i}
          onClick={(e) => onClick(i, e)}
          onDragStart={() => {
            if (!selected.includes(i)) setSelected([i]);
          }}
          onDragOver={(e) => {
            e.preventDefault();
            const r = e.currentTarget.getBoundingClientRect();
            setDropAt(e.clientY < r.top + r.height / 2 ? i : i + 1);
          }}
          onDrop={onDrop}
          onDragEnd={() => setDropAt(null)}
        />
      ))}
      {dropAt === order.length && <div className="thumb-drop-line" />}
    </div>
  );
}

function Thumbnail({
  pageIndex,
  insertedFrom,
  label,
  active,
  selected,
  dropBefore,
  onClick,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
}: {
  /** Source page (previews are keyed by it); negative for inserts. */
  pageIndex: number;
  /** Set for placeholder pages inserted from another file. */
  insertedFrom?: string;
  /** 1-based position in the current view order. */
  label: number;
  active: boolean;
  selected: boolean;
  dropBefore: boolean;
  onClick: (e: React.MouseEvent) => void;
  onDragStart: () => void;
  onDragOver: (e: React.DragEvent) => void;
  onDrop: () => void;
  onDragEnd: () => void;
}) {
  const preview = useViewerStore((s) => s.previews.get(pageIndex));
  const dark = useUiStore((s) => s.resolvedTheme === "dark");
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    // Previews render pre-inverted in dark mode; match their paper colour.
    ctx.fillStyle = dark ? "#000" : "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (preview) {
      ctx.drawImage(preview, 0, 0, canvas.width, canvas.height);
    }
  }, [preview, dark]);

  return (
    <div
      draggable
      onClick={onClick}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
      style={{
        marginBottom: 10,
        cursor: "pointer",
        textAlign: "center",
        borderTop: dropBefore
          ? "2px solid var(--accent-soft)"
          : "2px solid transparent",
        background: selected ? "var(--bg-active)" : "transparent",
        borderRadius: 4,
        paddingTop: 4,
      }}
    >
      <canvas
        ref={canvasRef}
        width={108}
        height={140}
        style={{
          width: "80%",
          border: active
            ? "2px solid var(--accent-soft)"
            : "2px solid transparent",
          background: dark ? "#000" : "#fff",
        }}
      />
      <div style={{ fontSize: 11, opacity: 0.7 }}>
        {label}
        {insertedFrom !== undefined && (
          <span title={`inserted from ${insertedFrom}; renders after save`}>
            {" "}
            + {insertedFrom}
          </span>
        )}
      </div>
    </div>
  );
}

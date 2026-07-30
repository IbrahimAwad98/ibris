import { useCallback, useEffect, useRef, useState } from "react";
import { getOutline, type OutlineNode } from "../../ipc/pdf";
import { navigateToMatch, useSearchStore } from "../../state/search-store";
import { useUiStore, type SidebarTab } from "../../state/ui-store";
import { useViewerStore } from "../../state/viewer-store";

/** Collapsible, resizable sidebar: thumbnails, outline, search results. */
export function Sidebar() {
  const width = useUiStore((s) => s.sidebarWidth);
  const tab = useUiStore((s) => s.sidebarTab);
  const setTab = useUiStore((s) => s.setSidebarTab);
  const setWidth = useUiStore((s) => s.setSidebarWidth);

  const docId = useViewerStore((s) => s.docId);
  const [outline, setOutline] = useState<OutlineNode[]>([]);
  useEffect(() => {
    if (docId === null) {
      setOutline([]);
      return;
    }
    let alive = true;
    getOutline(docId)
      .then((o) => alive && setOutline(o))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [docId]);

  // Drag-resize via a right-edge handle.
  const dragging = useRef(false);
  const onHandleDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      dragging.current = true;
      const startX = e.clientX;
      const startWidth = width;
      const onMove = (ev: MouseEvent) =>
        setWidth(startWidth + (ev.clientX - startX));
      const onUp = () => {
        dragging.current = false;
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [width, setWidth],
  );

  const tabs: { id: SidebarTab; label: string }[] = [
    { id: "thumbnails", label: "Pages" },
    ...(outline.length > 0
      ? [{ id: "outline" as SidebarTab, label: "Outline" }]
      : []),
    { id: "search", label: "Search" },
  ];

  return (
    <div
      style={{
        width,
        flexShrink: 0,
        display: "flex",
        flexDirection: "column",
        background: "#2a2a2e",
        borderRight: "1px solid #55555c",
        position: "relative",
        userSelect: "none",
      }}
    >
      <div style={{ display: "flex", borderBottom: "1px solid #55555c" }}>
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            style={{
              flex: 1,
              padding: "8px 4px",
              fontSize: 12,
              background: tab === t.id ? "#3a3a40" : "transparent",
              color: "#ececec",
              border: "none",
              borderBottom:
                tab === t.id ? "2px solid #6a9fff" : "2px solid transparent",
              cursor: "pointer",
            }}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div style={{ flex: 1, overflowY: "auto" }}>
        {tab === "thumbnails" && <ThumbnailList />}
        {tab === "outline" && <OutlineList nodes={outline} depth={0} />}
        {tab === "search" && <SearchPanel />}
      </div>
      <div
        onMouseDown={onHandleDown}
        style={{
          position: "absolute",
          right: -3,
          top: 0,
          bottom: 0,
          width: 6,
          cursor: "col-resize",
          zIndex: 10,
        }}
      />
    </div>
  );
}

// ponytail: all thumbnails render as small canvases with no windowing —
// ~300 tiny canvases is fine; virtualize if 1000+-page docs ever hitch.
function ThumbnailList() {
  const pages = useViewerStore((s) => s.pages);
  const currentPage = useViewerStore((s) => s.currentPage);
  const scrollToPage = useViewerStore((s) => s.scrollToPage);

  return (
    <div style={{ padding: 8 }}>
      {pages.map((_, i) => (
        <Thumbnail
          key={i}
          pageIndex={i}
          active={i === currentPage}
          onClick={() => scrollToPage(i)}
        />
      ))}
    </div>
  );
}

function Thumbnail({
  pageIndex,
  active,
  onClick,
}: {
  pageIndex: number;
  active: boolean;
  onClick: () => void;
}) {
  const preview = useViewerStore((s) => s.previews.get(pageIndex));
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (preview) {
      ctx.drawImage(preview, 0, 0, canvas.width, canvas.height);
    }
  }, [preview]);

  return (
    <div
      onClick={onClick}
      style={{ marginBottom: 10, cursor: "pointer", textAlign: "center" }}
    >
      <canvas
        ref={canvasRef}
        width={108}
        height={140}
        style={{
          width: "80%",
          border: active ? "2px solid #6a9fff" : "2px solid transparent",
          background: "#fff",
        }}
      />
      <div style={{ fontSize: 11, opacity: 0.7 }}>{pageIndex + 1}</div>
    </div>
  );
}

function OutlineList({ nodes, depth }: { nodes: OutlineNode[]; depth: number }) {
  const scrollToPage = useViewerStore((s) => s.scrollToPage);
  return (
    <div style={{ padding: depth === 0 ? 8 : 0 }}>
      {nodes.map((node, i) => (
        <div key={i}>
          <div
            onClick={() =>
              node.pageIndex !== null && scrollToPage(node.pageIndex)
            }
            style={{
              padding: "4px 8px",
              paddingLeft: 8 + depth * 16,
              fontSize: 13,
              cursor: node.pageIndex !== null ? "pointer" : "default",
              opacity: node.pageIndex !== null ? 1 : 0.5,
            }}
          >
            {node.title}
          </div>
          {node.children.length > 0 && (
            <OutlineList nodes={node.children} depth={depth + 1} />
          )}
        </div>
      ))}
    </div>
  );
}

function SearchPanel() {
  const query = useSearchStore((s) => s.query);
  const results = useSearchStore((s) => s.results);
  const searching = useSearchStore((s) => s.searching);
  const currentIndex = useSearchStore((s) => s.currentIndex);
  const caseSensitive = useSearchStore((s) => s.caseSensitive);
  const wholeWord = useSearchStore((s) => s.wholeWord);
  const start = useSearchStore((s) => s.start);
  const step = useSearchStore((s) => s.step);
  const setCaseSensitive = useSearchStore((s) => s.setCaseSensitive);
  const setWholeWord = useSearchStore((s) => s.setWholeWord);

  const [input, setInput] = useState(query);
  const inputRef = useRef<HTMLInputElement>(null);
  const focusNonce = useUiStore((s) => s.searchFocusNonce);
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [focusNonce]);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div style={{ padding: 8, borderBottom: "1px solid #55555c" }}>
        <input
          ref={inputRef}
          value={input}
          placeholder="Search document…"
          onChange={(e) => {
            setInput(e.currentTarget.value);
            void start(e.currentTarget.value);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              step(e.shiftKey ? -1 : 1);
            }
          }}
          style={{
            width: "100%",
            padding: 6,
            background: "#1e1e22",
            color: "#ececec",
            border: "1px solid #55555c",
            borderRadius: 4,
            boxSizing: "border-box",
          }}
        />
        <div style={{ display: "flex", gap: 12, marginTop: 6, fontSize: 12 }}>
          <label style={{ cursor: "pointer" }}>
            <input
              type="checkbox"
              checked={caseSensitive}
              onChange={(e) => setCaseSensitive(e.currentTarget.checked)}
            />{" "}
            Case
          </label>
          <label style={{ cursor: "pointer" }}>
            <input
              type="checkbox"
              checked={wholeWord}
              onChange={(e) => setWholeWord(e.currentTarget.checked)}
            />{" "}
            Whole word
          </label>
          <span style={{ marginLeft: "auto", opacity: 0.7 }}>
            {results.length > 0
              ? `${currentIndex + 1} / ${results.length}`
              : searching
                ? "searching…"
                : query
                  ? "0 results"
                  : ""}
            {searching && results.length > 0 ? "+" : ""}
          </span>
        </div>
      </div>
      <div style={{ flex: 1, overflowY: "auto" }}>
        {results.map((match, i) => (
          <div
            key={i}
            onClick={() => {
              useSearchStore.setState({ currentIndex: i });
              navigateToMatch(match);
            }}
            style={{
              padding: "6px 10px",
              fontSize: 12,
              cursor: "pointer",
              background: i === currentIndex ? "#3a3a40" : "transparent",
              borderBottom: "1px solid #38383e",
            }}
          >
            <div style={{ opacity: 0.6, marginBottom: 2 }}>
              Page {match.pageIndex + 1}
            </div>
            <div
              style={{
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {match.context}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

import { useUiStore } from "../../state/ui-store";
import { pageRotation, useViewerStore } from "../../state/viewer-store";
import { zoomIn, zoomOut, fitPageScale, fitWidthScale } from "../../lib/zoom";
import { PAGE_GAP } from "../../state/viewer-store";

const btn: React.CSSProperties = {
  background: "#2f2f34",
  color: "#ececec",
  border: "1px solid #55555c",
  borderRadius: 4,
  padding: "4px 10px",
  cursor: "pointer",
  fontSize: 13,
};

/** Zoom, fit, and rotation controls. Keyboard equivalents live in PageList. */
export function Toolbar() {
  const scale = useViewerStore((s) => s.scale);
  const currentPage = useViewerStore((s) => s.currentPage);
  const pageCount = useViewerStore((s) => s.pages.length);
  const setScale = useViewerStore((s) => s.setScale);
  const rotateDoc = useViewerStore((s) => s.rotateDoc);
  const rotatePage = useViewerStore((s) => s.rotatePage);

  const viewerEl = () =>
    document.querySelector<HTMLDivElement>("[data-viewer-area]");

  const fit = (mode: "width" | "page") => {
    const el = viewerEl();
    const s = useViewerStore.getState();
    const pt = s.pages[s.currentPage];
    if (!el || !pt) return;
    const rot = pageRotation(s, s.currentPage);
    const target =
      mode === "width"
        ? fitWidthScale(el.clientWidth, pt, rot, PAGE_GAP)
        : fitPageScale(
            { width: el.clientWidth, height: el.clientHeight },
            pt,
            rot,
            PAGE_GAP,
          );
    setScale(target, { fitMode: mode });
  };

  const toggleSidebar = useUiStore((s) => s.toggleSidebar);

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "6px 12px",
        background: "#242428",
        borderBottom: "1px solid #55555c",
        userSelect: "none",
      }}
    >
      <button style={btn} onClick={toggleSidebar} title="Toggle sidebar">
        ☰
      </button>
      <button style={btn} onClick={() => setScale(zoomOut(scale))} title="Zoom out (Ctrl+-)">
        −
      </button>
      <span style={{ minWidth: 48, textAlign: "center", fontSize: 13 }}>
        {Math.round(scale * 100)}%
      </span>
      <button style={btn} onClick={() => setScale(zoomIn(scale))} title="Zoom in (Ctrl+=)">
        +
      </button>
      <button style={btn} onClick={() => fit("width")} title="Fit width (Ctrl+2)">
        Fit width
      </button>
      <button style={btn} onClick={() => fit("page")} title="Fit page (Ctrl+0)">
        Fit page
      </button>
      <div style={{ width: 1, alignSelf: "stretch", background: "#55555c" }} />
      <button style={btn} onClick={() => rotatePage(currentPage)} title="Rotate current page">
        ⟳ Page
      </button>
      <button style={btn} onClick={rotateDoc} title="Rotate document">
        ⟳ All
      </button>
      <span style={{ marginLeft: "auto", fontSize: 13, opacity: 0.7 }}>
        Page {Math.min(currentPage + 1, pageCount)} / {pageCount}
      </span>
    </div>
  );
}

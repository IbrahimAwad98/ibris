import { useDocumentStore } from "../../state/document-store";
import { useUiStore } from "../../state/ui-store";
import { useViewerStore } from "../../state/viewer-store";
import { fitTo, zoomInCentred, zoomOutCentred } from "./view-actions";

const btn: React.CSSProperties = {
  background: "var(--bg-raised)",
  color: "var(--text)",
  border: "1px solid var(--border)",
  borderRadius: 4,
  padding: "4px 10px",
  cursor: "pointer",
  fontSize: 13,
};

/** Zoom, fit, and rotation controls. Keyboard equivalents live in the
 * command registry (features/shell/commands.ts). */
export function Toolbar() {
  const scale = useViewerStore((s) => s.scale);
  const currentPage = useViewerStore((s) => s.currentPage);
  const sourceCount = useViewerStore((s) => s.pages.length);
  const orderCount = useDocumentStore((s) => s.pageOrder?.length);
  const pageCount = orderCount ?? sourceCount;
  const rotateDoc = useViewerStore((s) => s.rotateDoc);
  const rotatePage = useViewerStore((s) => s.rotatePage);
  const toggleSidebar = useUiStore((s) => s.toggleSidebar);

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "6px 12px",
        background: "var(--bg-chrome)",
        borderBottom: "1px solid var(--border)",
        userSelect: "none",
      }}
    >
      <button style={btn} onClick={toggleSidebar} title="Toggle sidebar (Ctrl+B)">
        ☰
      </button>
      <button style={btn} onClick={zoomOutCentred} title="Zoom out (Ctrl+-)">
        −
      </button>
      <span style={{ minWidth: 48, textAlign: "center", fontSize: 13 }}>
        {Math.round(scale * 100)}%
      </span>
      <button style={btn} onClick={zoomInCentred} title="Zoom in (Ctrl+=)">
        +
      </button>
      <button style={btn} onClick={() => fitTo("width")} title="Fit width (Ctrl+1)">
        Fit width
      </button>
      <button style={btn} onClick={() => fitTo("page")} title="Fit page (Ctrl+2)">
        Fit page
      </button>
      <div
        style={{ width: 1, alignSelf: "stretch", background: "var(--border)" }}
      />
      <button style={btn} onClick={() => rotatePage(currentPage)} title="Rotate current page">
        ⟳ Page
      </button>
      <button style={btn} onClick={rotateDoc} title="Rotate document">
        ⟳ All
      </button>
      <span style={{ marginLeft: "auto", fontSize: 13, opacity: 0.7 }}>
        Page {Math.min(currentPage + 1, pageCount)} / {pageCount}
      </span>
      <button
        style={btn}
        onClick={useUiStore.getState().toggleTheme}
        title="Toggle light/dark theme"
      >
        ◐
      </button>
    </div>
  );
}

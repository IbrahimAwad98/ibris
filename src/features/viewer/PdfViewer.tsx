import { useEffect, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { EmptyState } from "../shell/EmptyState";
import { useTabsStore } from "../../state/tabs-store";
import { useUiStore } from "../../state/ui-store";
import { useViewerStore } from "../../state/viewer-store";
import { PageList } from "./PageList";
import { Sidebar } from "./Sidebar";
import { Toolbar } from "./Toolbar";

/** Document host: the empty state until a tab exists, then the viewer. */
export function PdfViewer() {
  const docId = useViewerStore((s) => s.docId);
  const error = useViewerStore((s) => s.error);
  const hasTabs = useTabsStore((s) => s.tabs.length > 0);
  const openTab = useTabsStore((s) => s.openTab);
  const sidebarOpen = useUiStore((s) => s.sidebarOpen);
  const focusSearch = useUiStore((s) => s.focusSearch);
  const [dragging, setDragging] = useState(false);

  // Ctrl+F opens the sidebar's search tab and focuses the input.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key.toLowerCase() === "f") {
        e.preventDefault();
        focusSearch();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [focusSearch]);

  useEffect(() => {
    const unlisten = getCurrentWebview().onDragDropEvent((event) => {
      const { payload } = event;
      setDragging(payload.type === "enter" || payload.type === "over");
      if (payload.type === "drop") {
        const pdf = payload.paths.find((p) => p.toLowerCase().endsWith(".pdf"));
        if (pdf) void openTab(pdf);
      }
    });
    return () => {
      void unlisten.then((f) => f());
    };
  }, [openTab]);

  let content;
  if (docId !== null) {
    content = (
      <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
        <Toolbar />
        <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
          {sidebarOpen && <Sidebar />}
          <div data-viewer-area style={{ position: "relative", flex: 1 }}>
            <PageList />
          </div>
        </div>
      </div>
    );
  } else if (!hasTabs) {
    content = <EmptyState />;
  } else {
    // A tab exists but no document is behind it: open failed or in flight.
    content = (
      <div
        style={{
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {error && <p style={{ color: "var(--error)" }}>{error}</p>}
      </div>
    );
  }

  return (
    <div style={{ height: "100%" }}>
      {content}
      {dragging && (
        <div className="drop-overlay">
          <span>Drop to open</span>
        </div>
      )}
    </div>
  );
}

import { useEffect, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { AnnotationToolbar } from "../annotations/AnnotationToolbar";
import { MarkupListener } from "../annotations/MarkupListener";
import { EmptyState } from "../shell/EmptyState";
import { useTabsStore } from "../../state/tabs-store";
import { useUiStore } from "../../state/ui-store";
import { useViewerStore } from "../../state/viewer-store";
import { PageList } from "./PageList";
import { Sidebar } from "./Sidebar";
import { Toolbar } from "./Toolbar";

/** Honest signposting for XFA: Ibris renders the static page content but
 * does not execute XFA form logic — saying so beats rendering it wrong. */
function XfaBanner() {
  const formType = useViewerStore((s) => s.docForm.formType);
  if (formType !== "xfa") return null;
  return (
    <div
      style={{
        padding: "6px 12px",
        fontSize: 12,
        background: "var(--bg-panel)",
        color: "var(--text-dim)",
        borderBottom: "1px solid var(--border)",
      }}
    >
      This document uses an XFA form, which Ibris does not support. Pages
      are shown as static content; form fields cannot be filled.
    </div>
  );
}

/** Document host: the empty state until a tab exists, then the viewer. */
export function PdfViewer() {
  const docId = useViewerStore((s) => s.docId);
  const error = useViewerStore((s) => s.error);
  const hasTabs = useTabsStore((s) => s.tabs.length > 0);
  const openTab = useTabsStore((s) => s.openTab);
  const sidebarOpen = useUiStore((s) => s.sidebarOpen);
  const [dragging, setDragging] = useState(false);

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
        <AnnotationToolbar />
        <XfaBanner />
        <MarkupListener />
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

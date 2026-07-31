import { useEffect, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { useTabsStore } from "../../state/tabs-store";
import { useUiStore } from "../../state/ui-store";
import { useViewerStore } from "../../state/viewer-store";
import { PageList } from "./PageList";
import { Sidebar } from "./Sidebar";
import { Toolbar } from "./Toolbar";

/** Document host: drag-drop / path entry until a document is open. */
export function PdfViewer() {
  const docId = useViewerStore((s) => s.docId);
  const error = useViewerStore((s) => s.error);
  const openTab = useTabsStore((s) => s.openTab);
  const sidebarOpen = useUiStore((s) => s.sidebarOpen);
  const focusSearch = useUiStore((s) => s.focusSearch);
  const [pathInput, setPathInput] = useState("");

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
      if (event.payload.type === "drop") {
        const pdf = event.payload.paths.find((p) =>
          p.toLowerCase().endsWith(".pdf"),
        );
        if (pdf) void openTab(pdf);
      }
    });
    return () => {
      void unlisten.then((f) => f());
    };
  }, [openTab]);

  if (docId !== null) {
    return (
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
  }

  return (
    <div
      style={{
        height: "100%",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 16,
      }}
    >
      <p>Drop a PDF here to open it</p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (pathInput.trim()) void openTab(pathInput.trim());
        }}
        style={{ display: "flex", gap: 8 }}
      >
        <input
          value={pathInput}
          onChange={(e) => setPathInput(e.currentTarget.value)}
          placeholder="…or paste a file path"
          style={{ width: 320, padding: 6 }}
        />
        <button type="submit">Open</button>
      </form>
      {error && <p style={{ color: "#ff8a80" }}>{error}</p>}
    </div>
  );
}

import { useEffect, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { useViewerStore } from "../../state/viewer-store";
import { PageList } from "./PageList";

/** Document host: drag-drop / path entry until a document is open. */
export function PdfViewer() {
  const docId = useViewerStore((s) => s.docId);
  const error = useViewerStore((s) => s.error);
  const openPath = useViewerStore((s) => s.openPath);
  const [pathInput, setPathInput] = useState("");

  // Dev convenience: VITE_OPEN_PDF=<path> npm run dev auto-opens a file.
  useEffect(() => {
    const devPath = import.meta.env.VITE_OPEN_PDF as string | undefined;
    if (devPath) void openPath(devPath);
  }, [openPath]);

  useEffect(() => {
    const unlisten = getCurrentWebview().onDragDropEvent((event) => {
      if (event.payload.type === "drop") {
        const pdf = event.payload.paths.find((p) =>
          p.toLowerCase().endsWith(".pdf"),
        );
        if (pdf) void openPath(pdf);
      }
    });
    return () => {
      void unlisten.then((f) => f());
    };
  }, [openPath]);

  if (docId !== null) return <PageList />;

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
          if (pathInput.trim()) void openPath(pathInput.trim());
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

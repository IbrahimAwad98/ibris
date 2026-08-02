import type { StampName } from "../../lib/annotations";
import { useDocumentStore } from "../../state/document-store";
import { useToolStore, type Tool } from "../../state/tool-store";

const TOOLS: { id: Tool; label: string; title: string }[] = [
  { id: "select", label: "Select", title: "Select and move annotations" },
  { id: "highlight", label: "Highlight", title: "Highlight selected text" },
  { id: "underline", label: "Underline", title: "Underline selected text" },
  { id: "strikeout", label: "Strike", title: "Strike through selected text" },
  { id: "ink", label: "Ink", title: "Freehand pen" },
  { id: "note", label: "Note", title: "Place a text note" },
  { id: "rect", label: "Rect", title: "Draw a rectangle" },
  { id: "ellipse", label: "Ellipse", title: "Draw an ellipse" },
  { id: "line", label: "Line", title: "Draw a line" },
  { id: "arrow", label: "Arrow", title: "Draw an arrow" },
  { id: "stamp", label: "Stamp", title: "Place a stamp" },
  {
    id: "redact",
    label: "Redact",
    title:
      "Mark a region for redaction — content is permanently removed when you save",
  },
  {
    id: "edit-text",
    label: "Edit text",
    title:
      "Edit a text line in place (only characters the document's font already contains)",
  },
];

const STAMPS: StampName[] = ["approved", "rejected", "draft", "confidential"];

/** Second toolbar row: annotation tools and the active tool's settings. */
export function AnnotationToolbar() {
  const tool = useToolStore((s) => s.tool);
  const settings = useToolStore((s) => s.settings[s.tool]);
  const author = useToolStore((s) => s.author);
  const stamp = useToolStore((s) => s.stamp);
  const setTool = useToolStore((s) => s.setTool);
  const updateSettings = useToolStore((s) => s.updateSettings);
  const pendingRedactions = useDocumentStore(
    (s) => Object.keys(s.redactions).length,
  );

  const showWidth = ["ink", "rect", "ellipse", "line", "arrow"].includes(tool);
  const showOpacity = tool === "highlight";

  return (
    <div className="annot-toolbar">
      {TOOLS.map((t) => (
        <button
          key={t.id}
          className={tool === t.id ? "annot-tool active" : "annot-tool"}
          title={t.title}
          onClick={() => setTool(t.id)}
        >
          {t.label}
        </button>
      ))}
      {pendingRedactions > 0 && (
        <span className="redact-pending-note" role="status">
          {pendingRedactions === 1
            ? "1 region marked for redaction"
            : `${pendingRedactions} regions marked for redaction`}
          {" — content is permanently removed when you save"}
        </span>
      )}
      {tool !== "select" && tool !== "redact" && tool !== "edit-text" && (
        <span className="annot-settings">
          <input
            type="color"
            value={settings.color}
            title="Colour"
            onChange={(e) => updateSettings({ color: e.currentTarget.value })}
          />
          {showOpacity && (
            <input
              type="range"
              min={0.15}
              max={1}
              step={0.05}
              value={settings.opacity}
              title="Opacity"
              onChange={(e) =>
                updateSettings({ opacity: Number(e.currentTarget.value) })
              }
            />
          )}
          {showWidth && (
            <input
              type="number"
              min={0.5}
              max={20}
              step={0.5}
              value={settings.strokeWidth}
              title="Stroke width (pt)"
              className="annot-width"
              onChange={(e) =>
                updateSettings({ strokeWidth: Number(e.currentTarget.value) })
              }
            />
          )}
          {tool === "stamp" && (
            <select
              value={stamp}
              onChange={(e) =>
                useToolStore
                  .getState()
                  .setStamp(e.currentTarget.value as StampName)
              }
            >
              {STAMPS.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          )}
          <input
            type="text"
            value={author}
            placeholder="Author"
            title="Annotation author"
            className="annot-author"
            onChange={(e) => useToolStore.getState().setAuthor(e.currentTarget.value)}
          />
        </span>
      )}
    </div>
  );
}

import { useDocumentStore } from "../../state/document-store";

/** The undo history: every command label, clickable to jump the document
 * to that point in time. */
export function HistoryPanel() {
  const commands = useDocumentStore((s) => s.commands);
  const cursor = useDocumentStore((s) => s.cursor);
  const savedCursor = useDocumentStore((s) => s.savedCursor);
  const jumpTo = useDocumentStore((s) => s.jumpTo);

  return (
    <div style={{ padding: 4 }}>
      <div
        className={cursor === 0 ? "history-row current" : "history-row"}
        onClick={() => jumpTo(0)}
      >
        <span>Opened document</span>
        {savedCursor === 0 && <span className="history-saved">saved</span>}
      </div>
      {commands.map((cmd, i) => (
        <div
          key={cmd.id}
          className={
            "history-row" +
            (cursor === i + 1 ? " current" : "") +
            (i >= cursor ? " undone" : "")
          }
          onClick={() => jumpTo(i + 1)}
        >
          <span>{cmd.label}</span>
          {savedCursor === i + 1 && <span className="history-saved">saved</span>}
        </div>
      ))}
      {commands.length === 0 && (
        <div className="history-empty">No changes yet</div>
      )}
    </div>
  );
}

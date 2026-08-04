// In-place text editing (M6a). Clicking a text object with the edit-text
// tool opens an inline editor primed with its current text; confirming
// runs the engine's glyph gate (a dry run — refusals name the missing
// characters verbatim) and records an undoable edit-text command. The
// file is only touched at save, where the engine re-checks everything and
// verifies the result before the atomic rename.
//
// Pending edits render as opaque paper-coloured patches over the object —
// the FormLayer pattern — with a dashed amber outline marking them as
// not-yet-saved. Hard M6a boundaries (M6-PLAN §2): no reflow — the
// patch covers only the object's own box; one object at a time; the
// overlay font is not the document font, so the patch is close, not
// WYSIWYG.
import { useEffect, useRef, useState } from "react";
import { checkTextEdit, listTextObjects, type TextObjectInfo } from "../../ipc/pdf";
import { showError } from "../../ipc/dialog";
import { saveErrorMessage } from "../../lib/pdf-error";
import {
  editText,
  textEditKey,
  useDocumentStore,
  type TextEditEntry,
} from "../../state/document-store";
import { useTabsStore } from "../../state/tabs-store";
import { useToolStore } from "../../state/tool-store";

interface Props {
  docId: number;
  /** Source (engine) page index. */
  pageIndex: number;
  scale: number;
}

export function EditTextLayer({ docId, pageIndex, scale }: Props) {
  const tool = useToolStore((s) => s.tool);
  const textEdits = useDocumentStore((s) => s.textEdits);
  const [objects, setObjects] = useState<TextObjectInfo[] | null>(null);
  const [editing, setEditing] = useState<TextObjectInfo | null>(null);
  const draft = useRef("");

  const active = tool === "edit-text";

  // The object list is fetched when the tool activates and cached until
  // the page identity changes; page content only changes via save, which
  // rebase-reloads the document (new docId).
  useEffect(() => {
    setObjects(null);
    setEditing(null);
    if (!active) return;
    let stale = false;
    listTextObjects(docId, pageIndex)
      .then((list) => {
        if (!stale) setObjects(list);
      })
      .catch(() => undefined); // page without readable text: nothing to edit
    return () => {
      stale = true;
    };
  }, [active, docId, pageIndex]);

  const pending = Object.values(textEdits).filter(
    (e) => e.pageIndex === pageIndex,
  );
  if (!active && pending.length === 0) return null;

  const entryFor = (o: TextObjectInfo): TextEditEntry | undefined =>
    textEdits[textEditKey(pageIndex, o.objectIndex)];

  const onClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!objects || editing) return;
    const box = e.currentTarget.getBoundingClientRect();
    const x = (e.clientX - box.left) / scale;
    const y = (e.clientY - box.top) / scale;
    const hit = objects.find(
      (o) =>
        x >= o.x - 2 &&
        x <= o.x + o.width + 2 &&
        y >= o.y - 2 &&
        y <= o.y + o.height + 2,
    );
    if (!hit) return;
    draft.current = entryFor(hit)?.text ?? hit.text;
    setEditing(hit);
  };

  const confirm = async () => {
    const o = editing;
    setEditing(null);
    if (!o) return;
    const value = draft.current;
    const key = textEditKey(pageIndex, o.objectIndex);
    const before = entryFor(o) ?? null;
    const execute = useDocumentStore.getState().execute;

    if (value === (before?.text ?? o.text)) return; // nothing changed
    if (value === o.text) {
      // Typed back the file's own text: drop the pending edit entirely.
      execute(editText(key, before, null));
      return;
    }
    const path = activePath();
    if (path === null) return;
    try {
      // The glyph gate, at confirm time — refusal names the characters.
      await checkTextEdit(path, pageIndex, o.objectIndex, value);
    } catch (err) {
      void showError(saveErrorMessage(err), "Cannot edit this text");
      return;
    }
    execute(
      editText(key, before, {
        pageIndex,
        objectIndex: o.objectIndex,
        original: o.text,
        text: value,
        rect: { x: o.x, y: o.y, width: o.width, height: o.height },
      }),
    );
  };

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        pointerEvents: active ? "auto" : "none",
        cursor: active ? "text" : undefined,
      }}
      onClick={onClick}
    >
      {/* Pending patches: opaque over the stale bitmap text (FormLayer
          pattern), dashed amber = not yet saved. */}
      {pending.map((p) => (
        <div
          key={textEditKey(p.pageIndex, p.objectIndex)}
          title="Edited — applies when you save"
          style={{
            position: "absolute",
            left: p.rect.x * scale,
            top: p.rect.y * scale,
            width: p.rect.width * scale,
            height: p.rect.height * scale,
            background: "var(--bg-panel)",
            color: "var(--text)",
            outline: "1px dashed #b58900",
            fontSize: p.rect.height * scale * 0.78,
            lineHeight: `${p.rect.height * scale}px`,
            whiteSpace: "pre",
            overflow: "visible",
            boxSizing: "border-box",
          }}
        >
          {p.text}
        </div>
      ))}
      {active && editing && (
        <textarea
          autoFocus
          defaultValue={draft.current}
          spellCheck={false}
          style={{
            position: "absolute",
            left: editing.x * scale,
            top: editing.y * scale,
            width: Math.max(editing.width * scale + 40, 120),
            height: Math.max(editing.height * scale + 8, 24),
            fontSize: Math.max(editing.height * scale * 0.78, 11),
            lineHeight: 1.2,
            background: "var(--bg-panel)",
            color: "var(--text)",
            border: "1px solid #b58900",
            resize: "none",
            whiteSpace: "pre",
            boxSizing: "border-box",
          }}
          onChange={(e) => {
            draft.current = e.currentTarget.value;
          }}
          onBlur={() => void confirm()}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Escape") {
              setEditing(null);
            } else if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void confirm();
            }
          }}
        />
      )}
    </div>
  );
}

function activePath(): string | null {
  const { tabs, activeTabId } = useTabsStore.getState();
  return tabs.find((t) => t.id === activeTabId)?.path ?? null;
}

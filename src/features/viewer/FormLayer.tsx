// Interactive AcroForm fields as HTML controls over the page (M4). The
// controls are opaque and paper-coloured: they are the single visual
// source of truth for field values, covering whatever stale appearance
// the page bitmap shows underneath. Values live in the document store
// (set-field commands — undoable); unedited fields show the file value.
//
// Tab order: fields render in widget enumeration order, so DOM order is
// the PDF's widget order per page. (The /Tabs page key is not honoured;
// tabbing across unmounted virtualised pages is not possible.)
import type { FormFieldInfo } from "../../ipc/pdf";
import {
  setField,
  useDocumentStore,
  type FieldState,
} from "../../state/document-store";
import { useViewerStore } from "../../state/viewer-store";

interface FormLayerProps {
  /** Source (engine) page index. */
  pageIndex: number;
  scale: number;
}

export function FormLayer({ pageIndex, scale }: FormLayerProps) {
  const form = useViewerStore((s) => s.docForm);
  const fieldValues = useDocumentStore((s) => s.fieldValues);
  const flatten = useDocumentStore((s) => s.flattenForms);
  if (form.formType !== "acroform") return null;

  const fields = form.fields.filter(
    (f) => f.pageIndex === pageIndex && f.kind !== "other",
  );
  if (fields.length === 0) return null;

  return (
    <div style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
      {fields.map((f) => (
        <Field
          key={`${f.name}:${f.kid}`}
          field={f}
          scale={scale}
          state={fieldValues[f.name]}
          disabled={f.readOnly || flatten}
        />
      ))}
    </div>
  );
}

function execute(field: FormFieldInfo, current: FieldState | undefined, after: FieldState) {
  useDocumentStore
    .getState()
    .execute(
      setField(field.name, current ?? null, after, `Fill ${field.name}`),
    );
}

function Field({
  field,
  scale,
  state,
  disabled,
}: {
  field: FormFieldInfo;
  scale: number;
  state: FieldState | undefined;
  disabled: boolean;
}) {
  const box: React.CSSProperties = {
    position: "absolute",
    left: field.rect.x * scale,
    top: field.rect.y * scale,
    width: field.rect.width * scale,
    height: field.rect.height * scale,
    pointerEvents: disabled ? "none" : "auto",
    boxSizing: "border-box",
    fontSize: Math.max(9, 12 * scale),
    background: "var(--bg-panel)",
    color: "var(--text)",
    border: "1px solid var(--border)",
    opacity: disabled ? 0.6 : 1,
  };

  switch (field.kind) {
    case "text": {
      const value =
        state?.kind === "text" ? state.value : field.value;
      const onChange = (v: string) =>
        execute(field, state, { kind: "text", value: v });
      return field.multiline ? (
        <textarea
          style={{ ...box, resize: "none" }}
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
        />
      ) : (
        <input
          type="text"
          style={box}
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
        />
      );
    }
    case "checkbox": {
      const checked =
        state?.kind === "checkbox" ? state.checked : field.checked;
      return (
        <input
          type="checkbox"
          style={{ ...box, accentColor: "var(--accent-soft)" }}
          checked={checked}
          disabled={disabled}
          onChange={(e) =>
            execute(field, state, { kind: "checkbox", checked: e.target.checked })
          }
        />
      );
    }
    case "radio": {
      const checked =
        state?.kind === "radio" ? state.kid === field.kid : field.checked;
      return (
        <input
          type="radio"
          name={`pdf-radio-${field.name}`}
          style={{ ...box, accentColor: "var(--accent-soft)" }}
          checked={checked}
          disabled={disabled}
          onChange={() =>
            execute(field, state, { kind: "radio", kid: field.kid })
          }
        />
      );
    }
    case "combo":
    case "list": {
      const selectedLabel =
        state?.kind === "choice"
          ? (field.options[state.indices[0] ?? -1] ?? "")
          : field.value;
      return (
        <select
          style={box}
          size={field.kind === "list" ? Math.max(2, field.options.length) : 1}
          value={selectedLabel}
          disabled={disabled}
          onChange={(e) => {
            const idx = field.options.indexOf(e.target.value);
            if (idx >= 0)
              execute(field, state, { kind: "choice", indices: [idx] });
          }}
        >
          {field.options.map((label, i) => (
            <option key={`${i}-${label}`} value={label}>
              {label}
            </option>
          ))}
        </select>
      );
    }
    default:
      return null;
  }
}

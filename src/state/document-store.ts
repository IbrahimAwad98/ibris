// The command stack — the central invariant of the editor (CLAUDE.md rule
// 5, decision 004): every document change is an invertible command record.
// Records are plain data (JSON-safe) so the whole stack can be written to a
// crash-recovery sidecar; behaviour lives in the switch tables below, keyed
// by record type, and every type must have an inverse to compile.
//
// Page structure (M3) is a *source-page indirection*: `pageOrder[i]` is the
// engine page shown in view slot i, and `rotations` is keyed by source
// page. Annotations reference source pages, so reordering moves them with
// their page by construction; deleting a page hides it (and its
// annotations) from the order — the save pipeline materialises the final
// structure.
import { create } from "zustand";
import type { Annotation, AnnotationId } from "../lib/annotations";
import { annotationNoun } from "../lib/annotations";
import type { Rotation } from "../lib/coords";
import type { FieldWrite } from "../ipc/pdf";
import type { FileFingerprint } from "../ipc/sidecar";

/** A form field's edited state, keyed by field name in `fieldValues`.
 * The wire shape minus the name. */
export type FieldState = FieldWrite extends infer W
  ? W extends { name: string }
    ? Omit<W, "name">
    : never
  : never;

/**
 * A page pulled in from another PDF (M3 insert-from-file). It exists only
 * in the model until save materialises it — the viewer shows a
 * placeholder. Referenced from `pageOrder` by negative entries:
 * slot value -(k+1) means `inserts[k]` (own pages are >= 0).
 */
export interface InsertedPage {
  path: string;
  pageIndex: number;
  /** Page size in points, for placeholder layout. */
  width: number;
  height: number;
}

/**
 * A region marked for redaction but not yet applied (M5). Purely a pending
 * mark until save: the file on disk is untouched, the mark is undoable, and
 * the engine applies-and-verifies it only when the user confirms a save.
 * Geometry is page points, top-left origin, keyed to *source* pages —
 * the same conventions as annotations and the RedactRegion wire shape.
 */
export interface PendingRedaction {
  id: string;
  pageIndex: number;
  rect: { x: number; y: number; width: number; height: number };
}

/**
 * A pending in-place text edit (M6a), keyed in `textEdits` by
 * `"<pageIndex>:<objectIndex>"`. Nothing touches the file until save;
 * the engine re-verifies `original` and the glyph gate then.
 */
export interface TextEditEntry {
  pageIndex: number;
  objectIndex: number;
  /** The object's text in the file — the engine refuses a stale edit. */
  original: string;
  /** The replacement text (already glyph-checked at confirm time). */
  text: string;
  /** Object bounds in page points (top-left), for the pending overlay. */
  rect: { x: number; y: number; width: number; height: number };
}

/** The `textEdits` key for a page/object pair. */
export const textEditKey = (pageIndex: number, objectIndex: number): string =>
  `${pageIndex}:${objectIndex}`;

/** The pageOrder entry referencing `inserts[k]`. */
export const insertRef = (k: number): number => -(k + 1);
/** Inverse of {@link insertRef}; null for ordinary source pages. */
export const insertIndexOf = (src: number): number | null =>
  src < 0 ? -src - 1 : null;

export type CommandRecord =
  | {
      id: string;
      label: string;
      type: "add-annotation";
      payload: { annotation: Annotation };
    }
  | {
      id: string;
      label: string;
      type: "remove-annotation";
      payload: { annotation: Annotation };
    }
  | {
      id: string;
      label: string;
      type: "modify-annotation";
      payload: { before: Annotation; after: Annotation };
    }
  | {
      id: string;
      label: string;
      type: "set-page-order";
      payload: { before: number[]; after: number[] };
    }
  | {
      id: string;
      label: string;
      type: "rotate-pages";
      payload: {
        before: Record<number, Rotation>;
        after: Record<number, Rotation>;
      };
    }
  | {
      id: string;
      label: string;
      type: "set-field";
      /** null = the field's baseline (file) value. */
      payload: {
        name: string;
        before: FieldState | null;
        after: FieldState | null;
      };
    }
  | {
      id: string;
      label: string;
      type: "flatten-forms";
      payload: { before: boolean; after: boolean };
    }
  | {
      id: string;
      label: string;
      type: "edit-text";
      /** null = no pending edit for this object (the file's own text). */
      payload: {
        key: string;
        before: TextEditEntry | null;
        after: TextEditEntry | null;
      };
    }
  | {
      id: string;
      label: string;
      type: "add-redaction";
      payload: { redaction: PendingRedaction };
    }
  | {
      id: string;
      label: string;
      type: "remove-redaction";
      payload: { redaction: PendingRedaction };
    }
  | {
      id: string;
      label: string;
      type: "insert-pages";
      /** `after` references `pages` via insertRef(base + i). Undo swaps
       * the orders; the registered pages stay (unreferenced entries are
       * harmless and redo re-references them). */
      payload: {
        before: number[];
        after: number[];
        base: number;
        pages: InsertedPage[];
      };
    };

type Annotations = Record<AnnotationId, Annotation>;

/** The state commands operate on. */
interface EditCore {
  annotations: Annotations;
  /** View slot → source (engine) page index, or a negative insertRef;
   * null before a doc is loaded. */
  pageOrder: number[] | null;
  /** Rotation per *source* page; missing = 0. Saved into the file. */
  rotations: Record<number, Rotation>;
  /** Pages inserted from other files, referenced by negative pageOrder
   * entries. Append-only within a session; save materialises them. */
  inserts: InsertedPage[];
  /** Edited form field values by field name; absent = file value (M4). */
  fieldValues: Record<string, FieldState>;
  /** Flatten fields + annotations into page content at the next save. */
  flattenForms: boolean;
  /** Regions marked for redaction, pending until a confirmed save (M5). */
  redactions: Record<string, PendingRedaction>;
  /** Pending in-place text edits by `textEditKey` (M6a). */
  textEdits: Record<string, TextEditEntry>;
}

function applyRecord(core: EditCore, record: CommandRecord): EditCore {
  switch (record.type) {
    case "add-annotation": {
      const a = record.payload.annotation;
      return { ...core, annotations: { ...core.annotations, [a.id]: a } };
    }
    case "remove-annotation": {
      const annotations = { ...core.annotations };
      delete annotations[record.payload.annotation.id];
      return { ...core, annotations };
    }
    case "modify-annotation": {
      const a = record.payload.after;
      return { ...core, annotations: { ...core.annotations, [a.id]: a } };
    }
    case "set-page-order":
      return { ...core, pageOrder: record.payload.after };
    case "rotate-pages":
      return {
        ...core,
        rotations: { ...core.rotations, ...record.payload.after },
      };
    case "set-field": {
      const fieldValues = { ...core.fieldValues };
      if (record.payload.after === null) {
        delete fieldValues[record.payload.name];
      } else {
        fieldValues[record.payload.name] = record.payload.after;
      }
      return { ...core, fieldValues };
    }
    case "flatten-forms":
      return { ...core, flattenForms: record.payload.after };
    case "edit-text": {
      const textEdits = { ...core.textEdits };
      if (record.payload.after === null) {
        delete textEdits[record.payload.key];
      } else {
        textEdits[record.payload.key] = record.payload.after;
      }
      return { ...core, textEdits };
    }
    case "add-redaction": {
      const r = record.payload.redaction;
      return { ...core, redactions: { ...core.redactions, [r.id]: r } };
    }
    case "remove-redaction": {
      const redactions = { ...core.redactions };
      delete redactions[record.payload.redaction.id];
      return { ...core, redactions };
    }
    case "insert-pages": {
      // Registration is idempotent (fixed positions), so redo after undo
      // and inverted records replay safely.
      const inserts = [...core.inserts];
      record.payload.pages.forEach((p, i) => {
        inserts[record.payload.base + i] = p;
      });
      return { ...core, inserts, pageOrder: record.payload.after };
    }
  }
}

/** The record that undoes `record`. Total by construction: adding a
 * command type without an inverse fails to compile. */
function invertRecord(record: CommandRecord): CommandRecord {
  switch (record.type) {
    case "add-annotation":
      return { ...record, type: "remove-annotation" };
    case "remove-annotation":
      return { ...record, type: "add-annotation" };
    case "add-redaction":
      return { ...record, type: "remove-redaction" };
    case "remove-redaction":
      return { ...record, type: "add-redaction" };
    case "modify-annotation":
    case "set-page-order":
    case "rotate-pages":
    case "set-field":
    case "edit-text":
    case "flatten-forms":
      return {
        ...record,
        payload: {
          ...record.payload,
          before: record.payload.after,
          after: record.payload.before,
        },
      } as CommandRecord;
    case "insert-pages":
      return {
        ...record,
        payload: {
          ...record.payload,
          before: record.payload.after,
          after: record.payload.before,
        },
      };
  }
}

/** Undo depth cap; the oldest record ages out beyond this (decision 004:
 * memory is bounded by capping stack depth). The annotation itself
 * survives — only its undoability is lost. */
export const MAX_STACK = 500;

/** savedCursor value meaning "the saved state is no longer on the stack"
 * (aged out or truncated) — the document stays dirty until the next save. */
const SAVED_UNREACHABLE = -1;

/** Everything a tab snapshot or sidecar needs to put the stack back. */
export interface DocumentSnapshot extends EditCore {
  commands: CommandRecord[];
  cursor: number;
  savedCursor: number;
  savedIds: string[];
}

export interface DocumentState extends DocumentSnapshot {
  /** The on-disk identity captured at open; save checks it for conflicts. */
  fingerprint: FileFingerprint | null;
  execute: (record: CommandRecord) => void;
  undo: () => void;
  redo: () => void;
  /** Undoes/redoes until the cursor sits at `target` (history panel). */
  jumpTo: (target: number) => void;
  canUndo: () => boolean;
  canRedo: () => boolean;
  isDirty: () => boolean;
  /** Identity page order for a freshly opened doc (no-op when a sidecar
   * already restored a structure). */
  initStructure: (pageCount: number) => void;
  /** Records a completed save: the cursor position and the /NM ids now
   * living in the file, plus the file's fresh fingerprint. */
  markSaved: (savedIds: string[], fingerprint: FileFingerprint | null) => void;
  reset: () => void;
  /** Puts back a snapshot/sidecar state verbatim (annotations are already
   * materialised at `cursor`; commands are only the undo window). */
  restore: (snapshot: DocumentSnapshot, fingerprint: FileFingerprint | null) => void;
  snapshot: () => DocumentSnapshot;
}

function core(state: DocumentState): EditCore {
  return {
    annotations: state.annotations,
    pageOrder: state.pageOrder,
    rotations: state.rotations,
    inserts: state.inserts,
    fieldValues: state.fieldValues,
    flattenForms: state.flattenForms,
    redactions: state.redactions,
    textEdits: state.textEdits,
  };
}

export const useDocumentStore = create<DocumentState>((set, get) => ({
  annotations: {},
  pageOrder: null,
  rotations: {},
  inserts: [],
  fieldValues: {},
  flattenForms: false,
  redactions: {},
  textEdits: {},
  commands: [],
  cursor: 0,
  savedCursor: 0,
  savedIds: [],
  fingerprint: null,

  execute: (record) => {
    const { commands, cursor, savedCursor } = get();
    let nextCommands = [...commands.slice(0, cursor), record];
    // Executing past an undo discards the redo tail; a saved state that
    // lived in that tail is gone for good.
    let nextSaved = savedCursor > cursor ? SAVED_UNREACHABLE : savedCursor;
    if (nextCommands.length > MAX_STACK) {
      nextCommands = nextCommands.slice(1);
      nextSaved = nextSaved <= 0 ? SAVED_UNREACHABLE : nextSaved - 1;
    }
    set({
      ...applyRecord(core(get()), record),
      commands: nextCommands,
      cursor: nextCommands.length,
      savedCursor: nextSaved,
    });
  },

  undo: () => {
    const { commands, cursor } = get();
    if (cursor === 0) return;
    const record = commands[cursor - 1];
    set({
      ...applyRecord(core(get()), invertRecord(record)),
      cursor: cursor - 1,
    });
  },

  redo: () => {
    const { commands, cursor } = get();
    if (cursor >= commands.length) return;
    set({
      ...applyRecord(core(get()), commands[cursor]),
      cursor: cursor + 1,
    });
  },

  jumpTo: (target) => {
    const clamped = Math.max(0, Math.min(target, get().commands.length));
    while (get().cursor > clamped) get().undo();
    while (get().cursor < clamped) get().redo();
  },

  canUndo: () => get().cursor > 0,
  canRedo: () => get().cursor < get().commands.length,
  isDirty: () => get().cursor !== get().savedCursor,

  initStructure: (pageCount) => {
    if (get().pageOrder !== null) return;
    set({ pageOrder: Array.from({ length: pageCount }, (_, i) => i) });
  },

  markSaved: (savedIds, fingerprint) =>
    set({ savedCursor: get().cursor, savedIds, fingerprint }),

  reset: () =>
    set({
      annotations: {},
      pageOrder: null,
      rotations: {},
      inserts: [],
      fieldValues: {},
      flattenForms: false,
      redactions: {},
      textEdits: {},
      commands: [],
      cursor: 0,
      savedCursor: 0,
      savedIds: [],
      fingerprint: null,
    }),

  restore: (snapshot, fingerprint) => set({ ...snapshot, fingerprint }),

  snapshot: () => {
    const {
      annotations,
      pageOrder,
      rotations,
      inserts,
      fieldValues,
      flattenForms,
      redactions,
      textEdits,
      commands,
      cursor,
      savedCursor,
      savedIds,
    } = get();
    return {
      annotations,
      pageOrder,
      rotations,
      inserts,
      fieldValues,
      flattenForms,
      redactions,
      textEdits,
      commands,
      cursor,
      savedCursor,
      savedIds,
    };
  },
}));

// ---- Command factories -------------------------------------------------

export function addAnnotation(annotation: Annotation): CommandRecord {
  return {
    id: crypto.randomUUID(),
    type: "add-annotation",
    label: `Add ${annotationNoun(annotation)}`,
    payload: { annotation },
  };
}

export function removeAnnotation(annotation: Annotation): CommandRecord {
  return {
    id: crypto.randomUUID(),
    type: "remove-annotation",
    label: `Delete ${annotationNoun(annotation)}`,
    payload: { annotation },
  };
}

export function modifyAnnotation(
  before: Annotation,
  after: Annotation,
): CommandRecord {
  return {
    id: crypto.randomUUID(),
    type: "modify-annotation",
    label: `Edit ${annotationNoun(after)}`,
    payload: { before, after },
  };
}

export function setPageOrder(
  before: number[],
  after: number[],
  label: string,
): CommandRecord {
  return {
    id: crypto.randomUUID(),
    type: "set-page-order",
    label,
    payload: { before, after },
  };
}

/** Command for pages pulled in from another file. `after` must reference
 * `pages` via insertRef(base + i); `base` is the inserts length at build
 * time so registration lands at fixed positions. */
export function insertPages(
  before: number[],
  after: number[],
  base: number,
  pages: InsertedPage[],
  label: string,
): CommandRecord {
  return {
    id: crypto.randomUUID(),
    type: "insert-pages",
    label,
    payload: { before, after, base, pages },
  };
}

/** Form field edit; `before` null = the field's file value (M4). */
export function setField(
  name: string,
  before: FieldState | null,
  after: FieldState | null,
  label: string,
): CommandRecord {
  return {
    id: crypto.randomUUID(),
    type: "set-field",
    label,
    payload: { name, before, after },
  };
}

/** Pending in-place text edit for one object (M6a); `after` null reverts
 * the object to its file text. */
export function editText(
  key: string,
  before: TextEditEntry | null,
  after: TextEditEntry | null,
): CommandRecord {
  return {
    id: crypto.randomUUID(),
    type: "edit-text",
    label: after === null ? "Revert text edit" : "Edit text",
    payload: { key, before, after },
  };
}

/** Marks a region for redaction — a pending, undoable mark; nothing is
 * removed until the user confirms a save (M5). */
export function addRedaction(redaction: PendingRedaction): CommandRecord {
  return {
    id: crypto.randomUUID(),
    type: "add-redaction",
    label: "Mark region for redaction",
    payload: { redaction },
  };
}

/** Removes a pending redaction mark (M5). */
export function removeRedaction(redaction: PendingRedaction): CommandRecord {
  return {
    id: crypto.randomUUID(),
    type: "remove-redaction",
    label: "Unmark redaction region",
    payload: { redaction },
  };
}

/** Toggles flatten-at-save for form fields and annotations (M4). */
export function setFlattenForms(before: boolean, after: boolean): CommandRecord {
  return {
    id: crypto.randomUUID(),
    type: "flatten-forms",
    label: after ? "Flatten form and annotations" : "Cancel flatten",
    payload: { before, after },
  };
}

/** `before` MUST hold an explicit entry (0 included) for every page in
 * `after` — apply/invert merge these records over `rotations`, so a
 * missing key would survive undo. */
export function rotatePages(
  before: Record<number, Rotation>,
  after: Record<number, Rotation>,
  label: string,
): CommandRecord {
  return {
    id: crypto.randomUUID(),
    type: "rotate-pages",
    label,
    payload: { before, after },
  };
}

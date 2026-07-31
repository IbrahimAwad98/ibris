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
import type { FileFingerprint } from "../ipc/sidecar";

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
    };

type Annotations = Record<AnnotationId, Annotation>;

/** The state commands operate on. */
interface EditCore {
  annotations: Annotations;
  /** View slot → source (engine) page index; null before a doc is loaded. */
  pageOrder: number[] | null;
  /** Rotation per *source* page; missing = 0. Saved into the file. */
  rotations: Record<number, Rotation>;
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
    case "modify-annotation":
    case "set-page-order":
    case "rotate-pages":
      return {
        ...record,
        payload: {
          before: record.payload.after,
          after: record.payload.before,
        },
      } as CommandRecord;
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
  };
}

export const useDocumentStore = create<DocumentState>((set, get) => ({
  annotations: {},
  pageOrder: null,
  rotations: {},
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
      commands,
      cursor,
      savedCursor,
      savedIds,
    } = get();
    return {
      annotations,
      pageOrder,
      rotations,
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

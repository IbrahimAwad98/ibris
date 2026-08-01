// The command stack — the central invariant of the editor (CLAUDE.md rule
// 5, decision 004): every document change is an invertible command record.
// Records are plain data (JSON-safe) so the whole stack can be written to a
// crash-recovery sidecar; behaviour lives in the switch tables below, keyed
// by record type, and every type must have an inverse to compile.
import { create } from "zustand";
import type { Annotation, AnnotationId } from "../lib/annotations";
import { annotationNoun } from "../lib/annotations";
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
    };

type Annotations = Record<AnnotationId, Annotation>;

function applyRecord(annotations: Annotations, record: CommandRecord): Annotations {
  switch (record.type) {
    case "add-annotation": {
      const a = record.payload.annotation;
      return { ...annotations, [a.id]: a };
    }
    case "remove-annotation": {
      const next = { ...annotations };
      delete next[record.payload.annotation.id];
      return next;
    }
    case "modify-annotation": {
      const a = record.payload.after;
      return { ...annotations, [a.id]: a };
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
    case "modify-annotation":
      return {
        ...record,
        payload: {
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
export interface DocumentSnapshot {
  annotations: Annotations;
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
  /** Records a completed save: the cursor position and the /NM ids now
   * living in the file, plus the file's fresh fingerprint. */
  markSaved: (savedIds: string[], fingerprint: FileFingerprint | null) => void;
  reset: () => void;
  /** Puts back a snapshot/sidecar state verbatim (annotations are already
   * materialised at `cursor`; commands are only the undo window). */
  restore: (snapshot: DocumentSnapshot, fingerprint: FileFingerprint | null) => void;
  snapshot: () => DocumentSnapshot;
}

export const useDocumentStore = create<DocumentState>((set, get) => ({
  annotations: {},
  commands: [],
  cursor: 0,
  savedCursor: 0,
  savedIds: [],
  fingerprint: null,

  execute: (record) => {
    const { annotations, commands, cursor, savedCursor } = get();
    let nextCommands = [...commands.slice(0, cursor), record];
    // Executing past an undo discards the redo tail; a saved state that
    // lived in that tail is gone for good.
    let nextSaved = savedCursor > cursor ? SAVED_UNREACHABLE : savedCursor;
    if (nextCommands.length > MAX_STACK) {
      nextCommands = nextCommands.slice(1);
      nextSaved = nextSaved <= 0 ? SAVED_UNREACHABLE : nextSaved - 1;
    }
    set({
      annotations: applyRecord(annotations, record),
      commands: nextCommands,
      cursor: nextCommands.length,
      savedCursor: nextSaved,
    });
  },

  undo: () => {
    const { annotations, commands, cursor } = get();
    if (cursor === 0) return;
    const record = commands[cursor - 1];
    set({
      annotations: applyRecord(annotations, invertRecord(record)),
      cursor: cursor - 1,
    });
  },

  redo: () => {
    const { annotations, commands, cursor } = get();
    if (cursor >= commands.length) return;
    set({
      annotations: applyRecord(annotations, commands[cursor]),
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
  markSaved: (savedIds, fingerprint) =>
    set({ savedCursor: get().cursor, savedIds, fingerprint }),

  reset: () =>
    set({
      annotations: {},
      commands: [],
      cursor: 0,
      savedCursor: 0,
      savedIds: [],
      fingerprint: null,
    }),

  restore: (snapshot, fingerprint) => set({ ...snapshot, fingerprint }),

  snapshot: () => {
    const { annotations, commands, cursor, savedCursor, savedIds } = get();
    return { annotations, commands, cursor, savedCursor, savedIds };
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

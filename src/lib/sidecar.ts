// The crash-recovery sidecar format (M2-PLAN §2). Pure: IO lives in
// src/ipc/sidecar.ts, wiring in the stores.
import type { Annotation, AnnotationId } from "./annotations";
import type { CommandRecord } from "../state/document-store";
import type { FileFingerprint } from "../ipc/sidecar";

export interface SidecarState {
  annotations: Record<AnnotationId, Annotation>;
  /** View slot → source page; null only for never-initialised state. */
  pageOrder: number[] | null;
  rotations: Record<number, 0 | 90 | 180 | 270>;
  commands: CommandRecord[];
  cursor: number;
  savedCursor: number;
  /** /NM ids our previous saves wrote into the file. */
  savedIds: string[];
}

interface SidecarFile extends SidecarState {
  version: 1;
  fingerprint: FileFingerprint;
}

export function serializeSidecar(
  fingerprint: FileFingerprint,
  state: SidecarState,
): string {
  const file: SidecarFile = { version: 1, fingerprint, ...state };
  return JSON.stringify(file);
}

/**
 * Parses a sidecar and validates it against the file's current
 * fingerprint. Returns null — meaning "discard" — for garbage, unknown
 * versions, or a fingerprint mismatch (the document changed outside a
 * crash; replaying commands against different content is worse than
 * losing them).
 */
export function parseSidecar(
  contents: string,
  current: FileFingerprint | null,
): SidecarState | null {
  if (current === null) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(contents);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const file = raw as Partial<SidecarFile>;
  if (file.version !== 1) return null;
  if (
    file.fingerprint?.size !== current.size ||
    file.fingerprint?.mtimeMs !== current.mtimeMs
  ) {
    return null;
  }
  if (
    typeof file.annotations !== "object" ||
    file.annotations === null ||
    !Array.isArray(file.commands) ||
    typeof file.cursor !== "number" ||
    typeof file.savedCursor !== "number" ||
    !Array.isArray(file.savedIds) ||
    !Array.isArray(file.pageOrder) ||
    typeof file.rotations !== "object" ||
    file.rotations === null
  ) {
    return null;
  }
  return {
    annotations: file.annotations,
    pageOrder: file.pageOrder,
    rotations: file.rotations,
    commands: file.commands,
    cursor: file.cursor,
    savedCursor: file.savedCursor,
    savedIds: file.savedIds,
  };
}

// Wires the document store to disk: sidecar crash recovery and the save
// pipeline (M2-PLAN §§2-3, 5). Paths come in as arguments — this module
// never reaches into the tab shell.
import { askUser } from "../ipc/dialog";
import { saveAnnotated } from "../ipc/pdf";
import {
  fileFingerprint,
  sidecarDelete,
  sidecarRead,
  sidecarWrite,
} from "../ipc/sidecar";
import { parseSidecar, serializeSidecar } from "../lib/sidecar";
import { useDocumentStore } from "./document-store";

/** Restores the edit state for a freshly opened document: a sidecar with
 * a matching fingerprint brings crashed edits back; anything else starts
 * clean (and a stale sidecar is deleted). */
export async function loadEditState(path: string): Promise<void> {
  const store = useDocumentStore.getState();
  store.reset();
  const fp = await fileFingerprint(path).catch(() => null);
  const contents = await sidecarRead(path).catch(() => null);
  if (contents !== null) {
    const state = parseSidecar(contents, fp);
    if (state) {
      store.restore(state, fp);
      return;
    }
    void sidecarDelete(path).catch(() => undefined);
  }
  useDocumentStore.setState({ fingerprint: fp });
}

const SIDECAR_DEBOUNCE_MS = 2000;
let sidecarTimer: ReturnType<typeof setTimeout> | undefined;

function writeNow(path: string): void {
  const s = useDocumentStore.getState();
  if (!s.isDirty()) return; // clean stacks need no recovery file
  void sidecarWrite(
    path,
    serializeSidecar(s.fingerprint ?? { size: 0, mtimeMs: 0 }, s.snapshot()),
  ).catch(() => undefined);
}

/** Schedules a debounced sidecar write for the active document. */
export function scheduleSidecarWrite(path: string): void {
  clearTimeout(sidecarTimer);
  sidecarTimer = setTimeout(() => {
    sidecarTimer = undefined;
    writeNow(path);
  }, SIDECAR_DEBOUNCE_MS);
}

/** Runs a pending write immediately. Call *before* hydrating another tab —
 * the document store still holds the state belonging to `path`. */
export function flushSidecarWrite(path: string): void {
  if (sidecarTimer === undefined) return;
  clearTimeout(sidecarTimer);
  sidecarTimer = undefined;
  writeNow(path);
}

/** Cancels any pending sidecar write (tab closed). */
export function cancelSidecarWrite(): void {
  clearTimeout(sidecarTimer);
  sidecarTimer = undefined;
}

/**
 * Saves the active document's annotations to `path`. Returns true when a
 * save happened. On a disk conflict (file changed since open), asks
 * before overwriting — the alternative for the user is Save As.
 */
export async function saveDocument(path: string): Promise<boolean> {
  const s = useDocumentStore.getState();
  const now = await fileFingerprint(path).catch(() => null);
  const opened = s.fingerprint;
  if (
    opened !== null &&
    (now === null ||
      now.size !== opened.size ||
      now.mtimeMs !== opened.mtimeMs)
  ) {
    const overwrite = await askUser(
      "This file was changed on disk while it was open. Overwriting will replace those changes with your version.",
      "File changed on disk",
      "Overwrite",
    );
    if (!overwrite) return false;
  }
  await saveToPath(path, path);
  return true;
}

/** Saves the current annotations onto `target` (Save As when target
 * differs from the open document's path). */
export async function saveToPath(openPath: string, target: string): Promise<void> {
  const s = useDocumentStore.getState();
  const annotations = Object.values(s.annotations);
  const ourIds = [
    ...new Set([...s.savedIds, ...annotations.map((a) => a.id)]),
  ];
  await saveAnnotated(target, annotations, ourIds);
  const fresh = await fileFingerprint(target).catch(() => null);
  if (target === openPath) {
    useDocumentStore
      .getState()
      .markSaved(annotations.map((a) => a.id), fresh);
    cancelSidecarWrite();
    void sidecarDelete(openPath).catch(() => undefined);
  }
}

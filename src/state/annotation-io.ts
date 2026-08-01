// Wires the document store to disk: sidecar crash recovery and the save
// pipeline (M2-PLAN §§2-3, 5; M3 page structure). Paths come in as
// arguments — this module never reaches into the tab shell.
import { askUser } from "../ipc/dialog";
import {
  closeDocument,
  saveDocument as ipcSaveDocument,
  setActiveDocument,
  type FieldWrite,
} from "../ipc/pdf";
import type { FieldState } from "./document-store";
import {
  fileFingerprint,
  sidecarDelete,
  sidecarRead,
  sidecarWrite,
} from "../ipc/sidecar";
import { parseSidecar, serializeSidecar } from "../lib/sidecar";
import { useDocumentStore } from "./document-store";
import { useViewerStore } from "./viewer-store";

/** Restores the edit state for a freshly opened document: a sidecar with
 * a matching fingerprint brings crashed edits back; otherwise our own
 * saved annotations recovered from the file seed the store (clean, with
 * an empty command stack — they are the saved state). A stale sidecar is
 * deleted. */
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
  const reopened = useViewerStore.getState().docAnnotations;
  if (reopened.length > 0) {
    store.restore(
      {
        annotations: Object.fromEntries(reopened.map((a) => [a.id, a])),
        pageOrder: null,
        rotations: {},
        inserts: [],
        fieldValues: {},
        flattenForms: false,
        commands: [],
        cursor: 0,
        savedCursor: 0,
        savedIds: reopened.map((a) => a.id),
      },
      fp,
    );
    return;
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

/**
 * Writes the pages in the given *view slots* — with their rotations and
 * annotations as currently shown, saved or not — to a new file. Backs the
 * extract-page and split commands; never touches the open document.
 */
export async function saveSubset(
  openPath: string,
  target: string,
  slots: number[],
): Promise<void> {
  const s = useDocumentStore.getState();
  const sourceCount = useViewerStore.getState().pages.length;
  const order = s.pageOrder ?? Array.from({ length: sourceCount }, (_, i) => i);
  const subset = slots
    .map((slot) => order[slot])
    .filter((src): src is number => src !== undefined);
  const rotations = Object.entries(s.rotations)
    .map(([src, deg]) => [Number(src), deg] as [number, number])
    .filter(([src, deg]) => deg % 360 !== 0 && subset.includes(src));
  const annotations = Object.values(s.annotations);
  const ourIds = [
    ...new Set([...s.savedIds, ...annotations.map((a) => a.id)]),
  ];
  // The engine drops annotations whose page is not in the order and
  // remaps the rest, so the whole set can be passed as-is.
  await ipcSaveDocument(
    openPath,
    target,
    subset,
    rotations,
    annotations,
    ourIds,
    s.inserts.map((p) => ({ path: p.path, pageIndex: p.pageIndex })),
    fieldWrites(s.fieldValues),
    false,
  );
}

/** The store's edited fields as the wire shape (name folded back in). */
function fieldWrites(values: Record<string, FieldState>): FieldWrite[] {
  return Object.entries(values).map(
    ([name, v]) => ({ ...v, name }) as FieldWrite,
  );
}

/** Saves the current structure + annotations onto `target` (Save As when
 * target differs from the open document's path). */
export async function saveToPath(openPath: string, target: string): Promise<void> {
  const s = useDocumentStore.getState();
  const sourceCount = useViewerStore.getState().pages.length;
  const order = s.pageOrder ?? Array.from({ length: sourceCount }, (_, i) => i);
  const rotations = Object.entries(s.rotations)
    .map(([src, deg]) => [Number(src), deg] as [number, number])
    .filter(([, deg]) => deg % 360 !== 0);
  const fields = fieldWrites(s.fieldValues);
  const structural =
    rotations.length > 0 ||
    order.length !== sourceCount ||
    order.some((src, i) => src !== i) ||
    // Field values and flatten change page content on disk; the viewer
    // must reload so the bitmap matches, which is the rebase path.
    fields.length > 0 ||
    s.flattenForms;

  const annotations = Object.values(s.annotations);
  const ourIds = [
    ...new Set([...s.savedIds, ...annotations.map((a) => a.id)]),
  ];
  await ipcSaveDocument(
    openPath,
    target,
    order,
    rotations,
    annotations,
    ourIds,
    s.inserts.map((p) => ({ path: p.path, pageIndex: p.pageIndex })),
    fields,
    s.flattenForms,
  );
  const fresh = await fileFingerprint(target).catch(() => null);
  if (target !== openPath) return;

  cancelSidecarWrite();
  void sidecarDelete(openPath).catch(() => undefined);

  if (!structural) {
    useDocumentStore
      .getState()
      .markSaved(annotations.map((a) => a.id), fresh);
    return;
  }

  // A structural save changes what page indexes mean on disk, so the open
  // document is rebased: annotations remap source→final, order becomes
  // identity, rotations are baked in, and — deliberately — the undo
  // history resets (undoing a materialised reorder against a reloaded
  // document has no meaningful base to return to).
  const remapped = Object.fromEntries(
    annotations
      .filter((a) => order.includes(a.pageIndex))
      .map((a) => {
        const next = { ...a, pageIndex: order.indexOf(a.pageIndex) };
        return [next.id, next];
      }),
  );
  useDocumentStore.getState().restore(
    {
      annotations: remapped,
      pageOrder: null,
      rotations: {},
      inserts: [], // materialised into the file by this save
      fieldValues: {}, // baked into the file by this save
      flattenForms: false,
      commands: [],
      cursor: 0,
      savedCursor: 0,
      savedIds: Object.keys(remapped),
    },
    fresh,
  );
  // Reload the viewer so the engine document matches the new disk file;
  // the superseded engine document must be closed by us (the tab shell
  // deliberately never closes documents on openPath).
  const oldDocId = useViewerStore.getState().docId;
  await useViewerStore.getState().openPath(target);
  useDocumentStore
    .getState()
    .initStructure(useViewerStore.getState().pages.length);
  const newDocId = useViewerStore.getState().docId;
  void setActiveDocument(newDocId).catch(() => undefined);
  if (oldDocId !== null) void closeDocument(oldDocId).catch(() => undefined);
}

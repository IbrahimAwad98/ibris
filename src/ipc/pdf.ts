// The only module allowed to call invoke(). Components and stores go
// through these typed wrappers exclusively.
import { invoke } from "@tauri-apps/api/core";
import type { Annotation } from "../lib/annotations";

export interface PageSizePt {
  width: number;
  height: number;
}

export interface OpenedDocument {
  docId: number;
  pageCount: number;
  pages: PageSizePt[];
  /** Our own saved annotations, recovered from the file and suppressed in
   * the viewing document so they render via the SVG overlay instead. */
  annotations: Annotation[];
}

export type PdfError =
  | { kind: "FileNotFound"; path: string }
  | { kind: "PasswordRequired" }
  | { kind: "Corrupt"; detail: string }
  | { kind: "Unsupported"; feature: string }
  | { kind: "Io"; detail: string }
  | { kind: "Cancelled" }
  | { kind: "Internal"; detail: string };

export interface RenderedPage {
  width: number;
  height: number;
  /** Tightly packed RGBA8, ready for ImageData. */
  data: Uint8ClampedArray;
}

let requestCounter = 0;

/** Fresh id to hand to renderPage / cancelRender. */
export function nextRequestId(): number {
  requestCounter += 1;
  return requestCounter;
}

export async function openDocument(path: string): Promise<OpenedDocument> {
  return invoke<OpenedDocument>("open_document", { path });
}

/** Renders one page; the payload is u32 LE width, u32 LE height, then RGBA8. */
export async function renderPage(
  docId: number,
  pageIndex: number,
  scale: number,
  invert: boolean,
  requestId: number,
): Promise<RenderedPage> {
  const buf = await invoke<ArrayBuffer>("render_page", {
    docId,
    pageIndex,
    scale,
    invert,
    requestId,
  });
  const view = new DataView(buf);
  return {
    width: view.getUint32(0, true),
    height: view.getUint32(4, true),
    data: new Uint8ClampedArray(buf, 8),
  };
}

export interface TileRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Renders one tile of a page; same payload layout as renderPage. */
export async function renderTile(
  docId: number,
  pageIndex: number,
  scale: number,
  tile: TileRect,
  invert: boolean,
  requestId: number,
): Promise<RenderedPage> {
  const buf = await invoke<ArrayBuffer>("render_tile", {
    docId,
    pageIndex,
    scale,
    tileX: tile.x,
    tileY: tile.y,
    tileWidth: tile.width,
    tileHeight: tile.height,
    invert,
    requestId,
  });
  const view = new DataView(buf);
  return {
    width: view.getUint32(0, true),
    height: view.getUint32(4, true),
    data: new Uint8ClampedArray(buf, 8),
  };
}

export async function cancelRender(requestId: number): Promise<void> {
  await invoke("cancel_render", { requestId });
}

/** One IPC round trip to abandon a whole batch of queued renders. */
export async function cancelRenders(requestIds: number[]): Promise<void> {
  if (requestIds.length === 0) return;
  await invoke("cancel_renders", { requestIds });
}

/** One run of text sharing a baseline; geometry in top-left-origin points. */
export interface TextRun {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PageText {
  runs: TextRun[];
}

export interface MatchRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SearchMatch {
  pageIndex: number;
  rects: MatchRect[];
  context: string;
}

export interface OutlineNode {
  title: string;
  pageIndex: number | null;
  children: OutlineNode[];
}

export async function extractText(
  docId: number,
  pageIndex: number,
): Promise<PageText> {
  return invoke<PageText>("extract_text", { docId, pageIndex });
}

/** Searches one page range; stream a document by calling successive ranges. */
export async function searchRange(
  docId: number,
  query: string,
  caseSensitive: boolean,
  wholeWord: boolean,
  fromPage: number,
  toPage: number,
  requestId: number,
): Promise<SearchMatch[]> {
  return invoke<SearchMatch[]>("search_range", {
    docId,
    query,
    caseSensitive,
    wholeWord,
    fromPage,
    toPage,
    requestId,
  });
}

export async function getOutline(docId: number): Promise<OutlineNode[]> {
  return invoke<OutlineNode[]>("get_outline", { docId });
}

export async function closeDocument(docId: number): Promise<void> {
  await invoke("close_document", { docId });
}

/** Hints the engine which document is visible; its queued work runs first. */
export async function setActiveDocument(docId: number | null): Promise<void> {
  await invoke("set_active_document", { docId });
}

/** A page pulled from another file, referenced by negative `order`
 * entries: order value -(k+1) means inserts[k]. */
export interface InsertSource {
  path: string;
  pageIndex: number;
}

/**
 * Applies page structure and annotations to the file at `srcPath`, writing
 * the result to `destPath` (same path = in-place save; a subset order and
 * a different path = extraction). `order` is the final page sequence as
 * source indexes — negative entries reference `inserts` (pages imported
 * from other files); `rotations` are extra clockwise degrees per source
 * page. `ourIds` are every /NM id the app has written for this document —
 * they are deleted before writing, making saves idempotent. The wire
 * shape of an annotation matches `Annotation` in lib/annotations.
 */
export async function saveDocument(
  srcPath: string,
  destPath: string,
  order: number[],
  rotations: [number, number][],
  annotations: unknown[],
  ourIds: string[],
  inserts: InsertSource[] = [],
): Promise<void> {
  await invoke("save_document", {
    srcPath,
    destPath,
    order,
    rotations,
    annotations,
    ourIds,
    inserts,
  });
}

/** Concatenates whole files into a new document at `destPath`. */
export async function mergeDocuments(
  paths: string[],
  destPath: string,
): Promise<void> {
  await invoke("merge_documents", { paths, destPath });
}

// The only module allowed to call invoke(). Components and stores go
// through these typed wrappers exclusively.
import { invoke } from "@tauri-apps/api/core";

export interface PageSizePt {
  width: number;
  height: number;
}

export interface OpenedDocument {
  docId: number;
  pageCount: number;
  pages: PageSizePt[];
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
  requestId: number,
): Promise<RenderedPage> {
  const buf = await invoke<ArrayBuffer>("render_page", {
    docId,
    pageIndex,
    scale,
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

export async function closeDocument(docId: number): Promise<void> {
  await invoke("close_document", { docId });
}

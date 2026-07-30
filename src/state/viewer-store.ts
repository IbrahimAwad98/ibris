import { create } from "zustand";
import {
  closeDocument,
  nextRequestId,
  openDocument,
  renderPage,
  type PageSizePt,
} from "../ipc/pdf";

/** Hardcoded zoom for M1a: 1 PDF point → 1.5 canvas pixels. */
export const SCALE = 1.5;
/** Gap between pages in layout pixels. */
export const PAGE_GAP = 16;
/** Preview bitmaps are this many pixels wide regardless of page size. */
const PREVIEW_WIDTH_PX = 108;

export interface ViewerState {
  docId: number | null;
  pages: PageSizePt[];
  /** Low-res page bitmaps, kept for the lifetime of the document. */
  previews: ReadonlyMap<number, ImageBitmap>;
  error: string | null;
  openPath: (path: string) => Promise<void>;
  close: () => Promise<void>;
}

export const useViewerStore = create<ViewerState>((set, get) => ({
  docId: null,
  pages: [],
  previews: new Map<number, ImageBitmap>(),
  error: null,

  openPath: async (path: string) => {
    const previous = get().docId;
    if (previous !== null) {
      await closeDocument(previous).catch(() => undefined);
    }
    set({ docId: null, pages: [], previews: new Map(), error: null });

    let doc;
    try {
      doc = await openDocument(path);
    } catch (e: unknown) {
      set({ error: describeOpenError(e) });
      return;
    }
    set({ docId: doc.docId, pages: doc.pages });

    // Progressive pass: one low-res render per page, sequentially, so sharp
    // viewport renders interleave into the engine queue between previews.
    for (let i = 0; i < doc.pages.length; i++) {
      if (get().docId !== doc.docId) return; // document was closed/replaced
      const scale = PREVIEW_WIDTH_PX / doc.pages[i].width;
      try {
        const page = await renderPage(doc.docId, i, scale, nextRequestId());
        const bitmap = await createImageBitmap(
          new ImageData(page.data, page.width, page.height),
        );
        if (get().docId !== doc.docId) return;
        set((state) => {
          const previews = new Map(state.previews);
          previews.set(i, bitmap);
          return { previews };
        });
      } catch {
        // A failed preview leaves a blank placeholder; the sharp render
        // will still be attempted when the page scrolls into view.
      }
    }
  },

  close: async () => {
    const { docId } = get();
    set({ docId: null, pages: [], previews: new Map(), error: null });
    if (docId !== null) {
      await closeDocument(docId).catch(() => undefined);
    }
  },
}));

function describeOpenError(e: unknown): string {
  if (typeof e === "object" && e !== null && "kind" in e) {
    switch ((e as { kind: string }).kind) {
      case "FileNotFound":
        return "That file could not be found.";
      case "PasswordRequired":
        return "This document is password protected. Password support is coming later.";
      case "Corrupt":
        return "This document is damaged and could not be opened.";
      case "Unsupported":
        return "This document uses a feature Ibris does not support yet.";
      case "Io":
        return "The file could not be read.";
      default:
        return "Something went wrong opening this document.";
    }
  }
  return "Something went wrong opening this document.";
}

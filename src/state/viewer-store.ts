import { create } from "zustand";
import {
  closeDocument,
  nextRequestId,
  openDocument,
  renderPage,
  type PageSizePt,
} from "../ipc/pdf";

import type { Rotation } from "../lib/coords";
import { clampScale } from "../lib/zoom";

/** Gap between pages in layout pixels. */
export const PAGE_GAP = 16;
/** Preview bitmaps are this many pixels wide regardless of page size. */
const PREVIEW_WIDTH_PX = 108;
/** Initial zoom before any fit mode is chosen. */
export const DEFAULT_SCALE = 1.5;

export type FitMode = "width" | "page" | null;

export interface ViewerState {
  docId: number | null;
  pages: PageSizePt[];
  /** Low-res page bitmaps, kept for the lifetime of the document. */
  previews: ReadonlyMap<number, ImageBitmap>;
  error: string | null;
  scale: number;
  fitMode: FitMode;
  /** Anchor (viewport coords) for the pending scale change; consumed by PageList. */
  zoomAnchor: { x: number; y: number } | null;
  rotationDoc: Rotation;
  rotationByPage: Readonly<Record<number, Rotation>>;
  /** Topmost visible page, kept current by PageList. */
  currentPage: number;
  /** Pending navigation, consumed by PageList. yPt is a page-top offset in points. */
  scrollTarget: { page: number; yPt?: number; nonce: number } | null;
  openPath: (path: string) => Promise<void>;
  close: () => Promise<void>;
  setScale: (
    scale: number,
    opts?: { fitMode?: FitMode; anchor?: { x: number; y: number } },
  ) => void;
  rotateDoc: () => void;
  rotatePage: (pageIndex: number) => void;
  setCurrentPage: (pageIndex: number) => void;
  scrollToPage: (page: number, yPt?: number) => void;
}

/** Effective rotation of a page: document rotation plus its own. */
export function pageRotation(state: ViewerState, pageIndex: number): Rotation {
  return ((state.rotationDoc + (state.rotationByPage[pageIndex] ?? 0)) %
    360) as Rotation;
}

export const useViewerStore = create<ViewerState>((set, get) => ({
  docId: null,
  pages: [],
  previews: new Map<number, ImageBitmap>(),
  error: null,
  scale: DEFAULT_SCALE,
  fitMode: null,
  zoomAnchor: null,
  rotationDoc: 0,
  rotationByPage: {},
  currentPage: 0,
  scrollTarget: null,

  setScale: (scale, opts) => {
    // Quantised so tile-cache keys stay stable across float drift.
    const next = Math.round(clampScale(scale) * 10000) / 10000;
    set({
      scale: next,
      fitMode: opts?.fitMode ?? null,
      zoomAnchor: opts?.anchor ?? null,
    });
  },

  rotateDoc: () =>
    set((s) => ({ rotationDoc: ((s.rotationDoc + 90) % 360) as Rotation })),

  rotatePage: (pageIndex) =>
    set((s) => ({
      rotationByPage: {
        ...s.rotationByPage,
        [pageIndex]: (((s.rotationByPage[pageIndex] ?? 0) + 90) % 360) as Rotation,
      },
    })),

  setCurrentPage: (pageIndex) =>
    get().currentPage === pageIndex ? undefined : set({ currentPage: pageIndex }),

  scrollToPage: (page, yPt) =>
    set((s) => ({
      scrollTarget: { page, yPt, nonce: (s.scrollTarget?.nonce ?? 0) + 1 },
    })),

  openPath: async (path: string) => {
    const previous = get().docId;
    if (previous !== null) {
      await closeDocument(previous).catch(() => undefined);
    }
    set({
      docId: null,
      pages: [],
      previews: new Map(),
      error: null,
      rotationDoc: 0,
      rotationByPage: {},
      currentPage: 0,
      zoomAnchor: null,
    });

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
    set({
      docId: null,
      pages: [],
      previews: new Map(),
      error: null,
      rotationDoc: 0,
      rotationByPage: {},
      currentPage: 0,
      zoomAnchor: null,
    });
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

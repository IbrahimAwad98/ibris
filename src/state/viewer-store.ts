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
  /**
   * Live scroll position, written by PageList on scroll: display-space
   * points below the top of `page`. Snapshotted per tab and per session.
   */
  scrollYPt: { page: number; yPt: number } | null;
  /**
   * Pending navigation, consumed by PageList. yPt is a page-top offset in
   * points; `exact` restores it verbatim (tab/session restore) instead of
   * biasing a third of the viewport down like search-match navigation.
   */
  scrollTarget: {
    page: number;
    yPt?: number;
    exact?: boolean;
    nonce: number;
  } | null;
  openPath: (path: string) => Promise<void>;
  /** Renders low-res previews for any page that still lacks one. */
  resumePreviews: () => Promise<void>;
  close: () => Promise<void>;
  setScale: (
    scale: number,
    opts?: { fitMode?: FitMode; anchor?: { x: number; y: number } },
  ) => void;
  rotateDoc: () => void;
  rotatePage: (pageIndex: number) => void;
  setCurrentPage: (pageIndex: number) => void;
  scrollToPage: (page: number, yPt?: number, exact?: boolean) => void;
}

/**
 * Bumped whenever the viewer is pointed at a different document (open,
 * close, or a tab hydrate). In-flight openPath/resumePreviews work checks
 * it after every await and abandons itself when superseded.
 */
let openNonce = 0;

/** Invalidates any in-flight open or preview pass; the tab shell calls
 * this before swapping the viewer's state to another document. */
export function invalidateOpen(): void {
  openNonce += 1;
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
  scrollYPt: null,
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

  scrollToPage: (page, yPt, exact) =>
    set((s) => ({
      scrollTarget: {
        page,
        yPt,
        exact,
        nonce: (s.scrollTarget?.nonce ?? 0) + 1,
      },
    })),

  openPath: async (path: string) => {
    // The tab shell owns document lifecycle: opening here never closes the
    // previously shown document — it may belong to another tab.
    openNonce += 1;
    const nonce = openNonce;
    set({
      docId: null,
      pages: [],
      previews: new Map(),
      error: null,
      scale: DEFAULT_SCALE,
      fitMode: null,
      rotationDoc: 0,
      rotationByPage: {},
      currentPage: 0,
      scrollYPt: null,
      zoomAnchor: null,
      scrollTarget: null,
    });

    let doc;
    try {
      doc = await openDocument(path);
    } catch (e: unknown) {
      if (nonce === openNonce) set({ error: describeOpenError(e) });
      return;
    }
    if (nonce !== openNonce) {
      // Superseded while opening (tab switch); nobody owns this doc now.
      await closeDocument(doc.docId).catch(() => undefined);
      return;
    }
    set({ docId: doc.docId, pages: doc.pages });
    await get().resumePreviews();
  },

  // Progressive pass: one low-res render per page, sequentially, so sharp
  // viewport renders interleave into the engine queue between previews.
  // Also re-run on tab activation to refill a pass that was cut short.
  resumePreviews: async () => {
    const nonce = openNonce;
    const { docId, pages } = get();
    if (docId === null) return;
    for (let i = 0; i < pages.length; i++) {
      if (nonce !== openNonce) return; // superseded by another open/hydrate
      if (get().previews.has(i)) continue;
      const scale = PREVIEW_WIDTH_PX / pages[i].width;
      try {
        const page = await renderPage(docId, i, scale, nextRequestId());
        const bitmap = await createImageBitmap(
          new ImageData(page.data, page.width, page.height),
        );
        if (nonce !== openNonce) return;
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
    openNonce += 1;
    const { docId } = get();
    set({
      docId: null,
      pages: [],
      previews: new Map(),
      error: null,
      scale: DEFAULT_SCALE,
      fitMode: null,
      rotationDoc: 0,
      rotationByPage: {},
      currentPage: 0,
      scrollYPt: null,
      zoomAnchor: null,
      scrollTarget: null,
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

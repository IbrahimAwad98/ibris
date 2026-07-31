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
import { rotatePages, useDocumentStore } from "./document-store";
import { useUiStore } from "./ui-store";

/** Gap between pages in layout pixels. */
export const PAGE_GAP = 16;
/** Preview bitmaps are this many pixels wide regardless of page size. */
const PREVIEW_WIDTH_PX = 108;
/** Initial zoom before any fit mode is chosen. */
export const DEFAULT_SCALE = 1.5;

export type FitMode = "width" | "page" | null;

export interface ViewerState {
  docId: number | null;
  /** Source-page sizes, indexed by *engine* page. View order and rotation
   * live in the document store (M3: they are document edits). */
  pages: PageSizePt[];
  /** Low-res page bitmaps keyed by source page, kept for the document's
   * lifetime — reordering never invalidates them. */
  previews: ReadonlyMap<number, ImageBitmap>;
  error: string | null;
  scale: number;
  fitMode: FitMode;
  /** Anchor (viewport coords) for the pending scale change; consumed by PageList. */
  zoomAnchor: { x: number; y: number } | null;
  /** Topmost visible page as a *view slot*, kept current by PageList. */
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

/** The current view order: view slot → source page. Identity until the
 * document store has structure. */
export function pageOrderOf(state: ViewerState): number[] {
  return (
    useDocumentStore.getState().pageOrder ??
    state.pages.map((_, i) => i)
  );
}

/** Effective rotation of the page in view slot `viewIndex`. */
export function pageRotation(state: ViewerState, viewIndex: number): Rotation {
  const src = pageOrderOf(state)[viewIndex];
  if (src === undefined) return 0;
  return useDocumentStore.getState().rotations[src] ?? 0;
}

export const useViewerStore = create<ViewerState>((set, get) => ({
  docId: null,
  pages: [],
  previews: new Map<number, ImageBitmap>(),
  error: null,
  scale: DEFAULT_SCALE,
  fitMode: null,
  zoomAnchor: null,
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

  // Rotation is a document edit (undoable, saved into the file), not view
  // state — these actions produce commands on the document stack.
  rotateDoc: () => {
    const order = pageOrderOf(get());
    const rotations = useDocumentStore.getState().rotations;
    const before: Record<number, Rotation> = {};
    const after: Record<number, Rotation> = {};
    for (const src of order) {
      before[src] = rotations[src] ?? 0;
      after[src] = ((before[src] + 90) % 360) as Rotation;
    }
    useDocumentStore
      .getState()
      .execute(rotatePages(before, after, "Rotate document"));
  },

  rotatePage: (viewIndex) => {
    const src = pageOrderOf(get())[viewIndex];
    if (src === undefined) return;
    const current = useDocumentStore.getState().rotations[src] ?? 0;
    useDocumentStore.getState().execute(
      rotatePages(
        { [src]: current },
        { [src]: ((current + 90) % 360) as Rotation },
        `Rotate page ${viewIndex + 1}`,
      ),
    );
  },

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
    // Deliberately not awaited: openPath resolves on metadata so callers
    // (tab open, session restore) aren't gated on a full preview pass.
    void get().resumePreviews();
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
      // Previews underlay the tiles, so they must match the tile theme.
      const invert = useUiStore.getState().resolvedTheme === "dark";
      try {
        const page = await renderPage(docId, i, scale, invert, nextRequestId());
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

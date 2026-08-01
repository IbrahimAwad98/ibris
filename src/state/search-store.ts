import { create } from "zustand";
import {
  cancelRender,
  nextRequestId,
  searchRange,
  type SearchMatch,
} from "../ipc/pdf";
import { pageOrderOf, useViewerStore } from "./viewer-store";

/** Pages per engine request: small enough that first results are ~instant. */
const CHUNK_PAGES = 10;

export interface SearchState {
  query: string;
  caseSensitive: boolean;
  wholeWord: boolean;
  results: SearchMatch[];
  searching: boolean;
  /** Index into results of the current match; -1 when none. */
  currentIndex: number;
  generation: number;
  start: (query: string) => Promise<void>;
  setCaseSensitive: (v: boolean) => void;
  setWholeWord: (v: boolean) => void;
  step: (dir: 1 | -1) => void;
  clear: () => void;
}

let pendingRequestId: number | null = null;

export const useSearchStore = create<SearchState>((set, get) => ({
  query: "",
  caseSensitive: false,
  wholeWord: false,
  results: [],
  searching: false,
  currentIndex: -1,
  generation: 0,

  setCaseSensitive: (v) => {
    set({ caseSensitive: v });
    void get().start(get().query);
  },
  setWholeWord: (v) => {
    set({ wholeWord: v });
    void get().start(get().query);
  },

  start: async (query: string) => {
    const generation = get().generation + 1;
    if (pendingRequestId !== null) {
      void cancelRender(pendingRequestId).catch(() => undefined);
      pendingRequestId = null;
    }
    set({
      generation,
      query,
      results: [],
      currentIndex: -1,
      searching: query.length > 0,
    });
    if (query.length === 0) return;

    const viewer = useViewerStore.getState();
    const { docId } = viewer;
    const pageCount = viewer.pages.length;
    if (docId === null || pageCount === 0) {
      set({ searching: false });
      return;
    }
    const { caseSensitive, wholeWord } = get();

    for (let from = 0; from < pageCount; from += CHUNK_PAGES) {
      if (get().generation !== generation) return; // superseded
      const to = Math.min(from + CHUNK_PAGES - 1, pageCount - 1);
      const requestId = nextRequestId();
      pendingRequestId = requestId;
      let chunk: SearchMatch[];
      try {
        chunk = await searchRange(
          docId,
          query,
          caseSensitive,
          wholeWord,
          from,
          to,
          requestId,
        );
      } catch {
        chunk = []; // Cancelled or transient; superseded searches bail above
      }
      if (get().generation !== generation) return;
      if (chunk.length > 0) {
        set((s) => ({
          results: [...s.results, ...chunk],
          // Auto-select the first match as soon as it exists.
          currentIndex: s.currentIndex === -1 ? 0 : s.currentIndex,
        }));
      }
    }
    if (get().generation === generation) {
      pendingRequestId = null;
      set({ searching: false });
    }
  },

  step: (dir) => {
    const { results, currentIndex } = get();
    if (results.length === 0) return;
    const next =
      (currentIndex + dir + results.length * 2) % results.length;
    set({ currentIndex: next });
    navigateToMatch(results[next]);
  },

  clear: () => {
    set((s) => ({
      generation: s.generation + 1,
      query: "",
      results: [],
      currentIndex: -1,
      searching: false,
    }));
  },
}));

export function navigateToMatch(match: SearchMatch): void {
  const rect = match.rects[0];
  const viewer = useViewerStore.getState();
  // Matches carry source page indexes; scroll targets are view slots.
  const viewIndex = pageOrderOf(viewer).indexOf(match.pageIndex);
  if (viewIndex === -1) return; // the page was deleted from the view
  viewer.scrollToPage(viewIndex, rect ? rect.y : undefined);
}

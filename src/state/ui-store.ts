import { create } from "zustand";
import { persist } from "zustand/middleware";

export type SidebarTab = "thumbnails" | "outline" | "search";

export interface UiState {
  sidebarOpen: boolean;
  sidebarTab: SidebarTab;
  sidebarWidth: number;
  /** Bumped by Ctrl+F so the search input can grab focus. */
  searchFocusNonce: number;
  toggleSidebar: () => void;
  setSidebarTab: (tab: SidebarTab) => void;
  setSidebarWidth: (width: number) => void;
  focusSearch: () => void;
}

export const useUiStore = create<UiState>()(
  persist(
    (set) => ({
      sidebarOpen: false,
      sidebarTab: "thumbnails",
      sidebarWidth: 240,
      searchFocusNonce: 0,
      toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
      setSidebarTab: (tab) => set({ sidebarTab: tab }),
      setSidebarWidth: (width) =>
        set({ sidebarWidth: Math.min(480, Math.max(160, width)) }),
      focusSearch: () =>
        set((s) => ({
          sidebarOpen: true,
          sidebarTab: "search",
          searchFocusNonce: s.searchFocusNonce + 1,
        })),
    }),
    {
      name: "ibris-ui",
      partialize: (s) => ({
        sidebarOpen: s.sidebarOpen,
        sidebarTab: s.sidebarTab,
        sidebarWidth: s.sidebarWidth,
      }),
    },
  ),
);

import { create } from "zustand";
import { persist } from "zustand/middleware";

export type SidebarTab = "thumbnails" | "outline" | "search";
export type ThemePreference = "system" | "light" | "dark";

/** What "system" currently means; defaults dark where matchMedia is absent. */
function systemTheme(): "light" | "dark" {
  return typeof matchMedia !== "undefined" &&
    matchMedia("(prefers-color-scheme: light)").matches
    ? "light"
    : "dark";
}

/** The theme actually in effect for a given preference. */
export function resolveTheme(pref: ThemePreference): "light" | "dark" {
  return pref === "system" ? systemTheme() : pref;
}

export interface UiState {
  sidebarOpen: boolean;
  sidebarTab: SidebarTab;
  sidebarWidth: number;
  /** Persisted preference; "system" follows the OS. */
  theme: ThemePreference;
  /** What is actually in effect right now; kept current by App. */
  resolvedTheme: "light" | "dark";
  /** Bumped by Ctrl+F so the search input can grab focus. */
  searchFocusNonce: number;
  /** Command palette overlay; "goto" is the Ctrl+G page-number mode. */
  paletteMode: "commands" | "goto" | null;
  openPalette: (mode: "commands" | "goto") => void;
  closePalette: () => void;
  toggleSidebar: () => void;
  setSidebarTab: (tab: SidebarTab) => void;
  setSidebarWidth: (width: number) => void;
  setTheme: (theme: ThemePreference) => void;
  /** Flips to the opposite of whatever is currently in effect. */
  toggleTheme: () => void;
  focusSearch: () => void;
}

export const useUiStore = create<UiState>()(
  persist(
    (set) => ({
      sidebarOpen: false,
      sidebarTab: "thumbnails",
      sidebarWidth: 240,
      theme: "system",
      resolvedTheme: resolveTheme("system"),
      searchFocusNonce: 0,
      paletteMode: null,
      openPalette: (mode) => set({ paletteMode: mode }),
      closePalette: () => set({ paletteMode: null }),
      toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
      setSidebarTab: (tab) => set({ sidebarTab: tab }),
      setSidebarWidth: (width) =>
        set({ sidebarWidth: Math.min(480, Math.max(160, width)) }),
      setTheme: (theme) => set({ theme }),
      toggleTheme: () =>
        set((s) => ({
          theme: resolveTheme(s.theme) === "dark" ? "light" : "dark",
        })),
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
        theme: s.theme,
      }),
    },
  ),
);

// Active annotation tool and its persisted settings.
import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { StampName } from "../lib/annotations";

export type Tool =
  | "select"
  | "highlight"
  | "underline"
  | "strikeout"
  | "ink"
  | "note"
  | "rect"
  | "ellipse"
  | "line"
  | "arrow"
  | "stamp";

export interface ToolSettings {
  color: string;
  opacity: number;
  strokeWidth: number;
}

const DEFAULTS: Record<Tool, ToolSettings> = {
  select: { color: "#ffd400", opacity: 1, strokeWidth: 2 },
  highlight: { color: "#ffd400", opacity: 0.4, strokeWidth: 2 },
  underline: { color: "#2e7d32", opacity: 1, strokeWidth: 2 },
  strikeout: { color: "#c62828", opacity: 1, strokeWidth: 2 },
  ink: { color: "#c62828", opacity: 1, strokeWidth: 2.5 },
  note: { color: "#ffd400", opacity: 1, strokeWidth: 2 },
  rect: { color: "#c62828", opacity: 1, strokeWidth: 2 },
  ellipse: { color: "#c62828", opacity: 1, strokeWidth: 2 },
  line: { color: "#c62828", opacity: 1, strokeWidth: 2 },
  arrow: { color: "#c62828", opacity: 1, strokeWidth: 2 },
  stamp: { color: "#2e7d32", opacity: 1, strokeWidth: 2 },
};

export interface ToolState {
  tool: Tool;
  /** Per-tool settings so a yellow highlighter and a red pen coexist. */
  settings: Record<Tool, ToolSettings>;
  author: string;
  stamp: StampName;
  /** Selected annotation id (select tool). */
  selectedId: string | null;
  setTool: (tool: Tool) => void;
  updateSettings: (patch: Partial<ToolSettings>) => void;
  setAuthor: (author: string) => void;
  setStamp: (stamp: StampName) => void;
  setSelectedId: (id: string | null) => void;
}

export const useToolStore = create<ToolState>()(
  persist(
    (set, get) => ({
      tool: "select",
      settings: DEFAULTS,
      author: "",
      stamp: "approved",
      selectedId: null,
      setTool: (tool) => set({ tool, selectedId: null }),
      updateSettings: (patch) =>
        set({
          settings: {
            ...get().settings,
            [get().tool]: { ...get().settings[get().tool], ...patch },
          },
        }),
      setAuthor: (author) => set({ author }),
      setStamp: (stamp) => set({ stamp }),
      setSelectedId: (selectedId) => set({ selectedId }),
    }),
    {
      name: "ibris-tools",
      partialize: (s) => ({
        settings: s.settings,
        author: s.author,
        stamp: s.stamp,
      }),
      merge: (persisted, current) => {
        // Deep-merge settings so new tools added later keep their defaults.
        const p = (persisted ?? {}) as Partial<ToolState>;
        return {
          ...current,
          ...p,
          settings: { ...current.settings, ...(p.settings ?? {}) },
        };
      },
    },
  ),
);

/** The active tool's settings. */
export function activeSettings(): ToolSettings {
  const s = useToolStore.getState();
  return s.settings[s.tool];
}

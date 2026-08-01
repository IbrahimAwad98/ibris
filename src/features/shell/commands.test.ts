import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../ipc/pdf", () => ({
  openDocument: vi.fn(),
  renderPage: vi.fn().mockRejectedValue(new Error("no previews in tests")),
  closeDocument: vi.fn().mockResolvedValue(undefined),
  setActiveDocument: vi.fn().mockResolvedValue(undefined),
  cancelRender: vi.fn().mockResolvedValue(undefined),
  cancelRenders: vi.fn().mockResolvedValue(undefined),
  searchRange: vi.fn().mockResolvedValue([]),
  nextRequestId: () => 1,
}));
vi.mock("../../ipc/dialog", () => ({
  pickPdf: vi.fn().mockResolvedValue(null),
  pickSavePath: vi.fn().mockResolvedValue(null),
  askUser: vi.fn().mockResolvedValue(true),
}));
vi.mock("../../ipc/sidecar", () => ({
  fileFingerprint: vi.fn().mockResolvedValue(null),
  sidecarRead: vi.fn().mockResolvedValue(null),
  sidecarWrite: vi.fn().mockResolvedValue(undefined),
  sidecarDelete: vi.fn().mockResolvedValue(undefined),
}));

import { useUiStore } from "../../state/ui-store";
import {
  appCommands,
  commandBindings,
  filterCommands,
  handleShortcut,
} from "./commands";

const STANDARD_IDS = [
  "open",
  "close-tab",
  "next-tab",
  "prev-tab",
  "find",
  "goto-page",
  "zoom-in",
  "zoom-out",
  "zoom-reset",
  "fit-width",
  "fit-page",
  "rotate-page",
  "rotate-doc",
  "toggle-sidebar",
  "toggle-theme",
  "palette",
];

beforeEach(() => {
  useUiStore.setState({ paletteMode: null, theme: "dark" });
});

describe("registry consistency", () => {
  it("has every standard command", () => {
    const ids = appCommands().map((c) => c.id);
    for (const id of STANDARD_IDS) {
      expect(ids).toContain(id);
    }
  });

  it("has unique ids and non-empty labels", () => {
    const cmds = appCommands();
    expect(new Set(cmds.map((c) => c.id)).size).toBe(cmds.length);
    for (const c of cmds) {
      expect(c.label.length).toBeGreaterThan(0);
    }
  });

  it("never binds one shortcut to two commands", () => {
    const all = appCommands().flatMap(commandBindings);
    expect(new Set(all).size).toBe(all.length);
  });
});

describe("palette reachability", () => {
  it("an empty query lists every command", () => {
    expect(filterCommands(appCommands(), "")).toHaveLength(
      appCommands().length,
    );
  });

  it("every command is findable by its own label", () => {
    for (const cmd of appCommands()) {
      const hits = filterCommands(appCommands(), cmd.label);
      expect(hits.map((c) => c.id)).toContain(cmd.id);
    }
  });
});

describe("dispatch", () => {
  function press(key: string, mods: Partial<KeyboardEvent> = {}) {
    return handleShortcut({
      key,
      ctrlKey: mods.ctrlKey ?? false,
      shiftKey: mods.shiftKey ?? false,
      altKey: mods.altKey ?? false,
      preventDefault: () => undefined,
    });
  }

  it("Ctrl+K toggles the palette", () => {
    expect(press("k", { ctrlKey: true })).toBe(true);
    expect(useUiStore.getState().paletteMode).toBe("commands");
    press("k", { ctrlKey: true });
    expect(useUiStore.getState().paletteMode).toBeNull();
  });

  it("Ctrl+Shift+L flips the theme", () => {
    press("L", { ctrlKey: true, shiftKey: true });
    expect(useUiStore.getState().theme).toBe("light");
  });

  it("ignores chords that belong to no command", () => {
    expect(press("k")).toBe(false);
    expect(press("q", { ctrlKey: true })).toBe(false);
  });

  it("does not run commands whose enabled() is false", () => {
    // No tabs open: close-tab must not fire.
    expect(press("w", { ctrlKey: true })).toBe(false);
  });
});

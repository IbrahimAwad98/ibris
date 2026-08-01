import { describe, expect, it } from "vitest";
import { mergePersistedToolState, useToolStore } from "./tool-store";

describe("tool store rehydration", () => {
  it("ignores a stale persisted `tool` key (the Underline-on-launch bug)", () => {
    const current = useToolStore.getState();
    const merged = mergePersistedToolState(
      // What an older dev build left in localStorage: the whole state,
      // including keys that were never meant to persist.
      {
        tool: "underline",
        selectedId: "ghost",
        author: "me",
        stamp: "draft",
        settings: { highlight: { color: "#123456", opacity: 0.5, strokeWidth: 1 } },
      },
      current,
    );
    expect(merged.tool).toBe("select");
    expect(merged.selectedId).toBeNull();
    expect(merged.author).toBe("me");
    expect(merged.stamp).toBe("draft");
    expect(merged.settings.highlight.color).toBe("#123456");
    // Tools absent from the persisted blob keep their defaults.
    expect(merged.settings.ink).toEqual(current.settings.ink);
  });

  it("keeps defaults when nothing was persisted", () => {
    const current = useToolStore.getState();
    const merged = mergePersistedToolState(undefined, current);
    expect(merged.tool).toBe(current.tool);
    expect(merged.settings).toEqual(current.settings);
  });
});

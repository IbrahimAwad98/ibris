import { describe, expect, it } from "vitest";
import { eventMatches, parseShortcut } from "./shortcuts";

function key(
  k: string,
  mods: Partial<{ ctrl: boolean; shift: boolean; alt: boolean }> = {},
) {
  return {
    key: k,
    ctrlKey: mods.ctrl ?? false,
    shiftKey: mods.shift ?? false,
    altKey: mods.alt ?? false,
  };
}

describe("parseShortcut", () => {
  it("parses modifiers case-insensitively", () => {
    expect(parseShortcut("Ctrl+Shift+Tab")).toEqual({
      ctrl: true,
      shift: true,
      alt: false,
      key: "tab",
    });
    expect(parseShortcut("ctrl+alt+x")).toEqual({
      ctrl: true,
      shift: false,
      alt: true,
      key: "x",
    });
  });

  it("treats the last token as the key even when it is + or =", () => {
    expect(parseShortcut("Ctrl+=").key).toBe("=");
    expect(parseShortcut("Ctrl++").key).toBe("+");
    expect(parseShortcut("Ctrl+-").key).toBe("-");
  });

  it("parses named keys", () => {
    expect(parseShortcut("Ctrl+PageDown").key).toBe("pagedown");
  });
});

describe("eventMatches", () => {
  it("matches key and exact modifier set", () => {
    const p = parseShortcut("Ctrl+K");
    expect(eventMatches(p, key("k", { ctrl: true }))).toBe(true);
    expect(eventMatches(p, key("K", { ctrl: true }))).toBe(true);
    expect(eventMatches(p, key("k"))).toBe(false);
    expect(eventMatches(p, key("k", { ctrl: true, shift: true }))).toBe(false);
    expect(eventMatches(p, key("k", { ctrl: true, alt: true }))).toBe(false);
  });

  it("requires shift when the shortcut names it", () => {
    const p = parseShortcut("Ctrl+Shift+L");
    expect(eventMatches(p, key("L", { ctrl: true, shift: true }))).toBe(true);
    expect(eventMatches(p, key("l", { ctrl: true }))).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import {
  MAX_RECENTS,
  planRestore,
  pushRecent,
  type RecentEntry,
  type SavedSession,
} from "./session";

function recent(path: string, lastOpened = 0): RecentEntry {
  return { path, title: path, pageCount: 1, lastOpened };
}

function session(
  paths: string[],
  activeIndex: number,
  recents: RecentEntry[] = [],
): SavedSession {
  return { paths, activeIndex, viewByPath: {}, recents };
}

describe("planRestore", () => {
  it("is the identity when every file opened", () => {
    const plan = planRestore(session(["a", "b", "c"], 1), ["ok", "ok", "ok"]);
    expect(plan.paths).toEqual(["a", "b", "c"]);
    expect(plan.activeIndex).toBe(1);
  });

  it("shifts the active index left past dropped tabs", () => {
    const plan = planRestore(session(["a", "b", "c"], 2), [
      "missing",
      "ok",
      "ok",
    ]);
    expect(plan.paths).toEqual(["b", "c"]);
    expect(plan.activeIndex).toBe(1);
  });

  it("moves a missing active tab to its left neighbour", () => {
    const plan = planRestore(session(["a", "b", "c"], 1), [
      "ok",
      "missing",
      "ok",
    ]);
    expect(plan.paths).toEqual(["a", "c"]);
    expect(plan.activeIndex).toBe(0);
  });

  it("falls back to the first survivor when nothing is left of the active", () => {
    const plan = planRestore(session(["a", "b"], 0), ["missing", "ok"]);
    expect(plan.paths).toEqual(["b"]);
    expect(plan.activeIndex).toBe(0);
  });

  it("yields an empty session when every file is missing", () => {
    const plan = planRestore(session(["a", "b"], 1), ["missing", "missing"]);
    expect(plan.paths).toEqual([]);
    expect(plan.activeIndex).toBe(-1);
  });

  it("flags recents whose file went missing and leaves the rest alone", () => {
    const plan = planRestore(
      session(["a", "b"], 0, [recent("b"), recent("z")]),
      ["ok", "missing"],
    );
    expect(plan.recents).toEqual([
      { ...recent("b"), missing: true },
      recent("z"),
    ]);
  });
});

describe("pushRecent", () => {
  it("puts the newest entry first and dedupes by path", () => {
    const out = pushRecent([recent("a", 1), recent("b", 2)], recent("b", 3));
    expect(out.map((r) => r.path)).toEqual(["b", "a"]);
    expect(out[0].lastOpened).toBe(3);
  });

  it("caps the list", () => {
    let recents: RecentEntry[] = [];
    for (let i = 0; i < MAX_RECENTS + 5; i++) {
      recents = pushRecent(recents, recent(`p${i}`, i));
    }
    expect(recents).toHaveLength(MAX_RECENTS);
    expect(recents[0].path).toBe(`p${MAX_RECENTS + 4}`);
  });
});

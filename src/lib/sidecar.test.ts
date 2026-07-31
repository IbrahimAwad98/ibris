import { describe, expect, it } from "vitest";
import type { Annotation } from "./annotations";
import { parseSidecar, serializeSidecar } from "./sidecar";

const fp = { size: 1234, mtimeMs: 999 };

function note(id: string): Annotation {
  return {
    id,
    kind: "note",
    pageIndex: 0,
    at: { x: 1, y: 2 },
    contents: "x",
    color: "#ffcc00",
    opacity: 1,
    author: "t",
    createdAt: 1,
    modifiedAt: 1,
  };
}

const state = {
  annotations: { n1: note("n1") },
  commands: [],
  cursor: 0,
  savedCursor: 0,
  savedIds: [],
};

describe("sidecar round trip", () => {
  it("serialises and parses back with a matching fingerprint", () => {
    const wire = serializeSidecar(fp, state);
    const parsed = parseSidecar(wire, fp);
    expect(parsed?.annotations["n1"]).toMatchObject({ contents: "x" });
  });

  it("rejects a stale fingerprint", () => {
    const wire = serializeSidecar(fp, state);
    expect(parseSidecar(wire, { size: 1234, mtimeMs: 1000 })).toBeNull();
    expect(parseSidecar(wire, { size: 999, mtimeMs: 999 })).toBeNull();
    expect(parseSidecar(wire, null)).toBeNull();
  });

  it("rejects unknown versions and garbage", () => {
    const wire = serializeSidecar(fp, state).replace('"version":1', '"version":2');
    expect(parseSidecar(wire, fp)).toBeNull();
    expect(parseSidecar("not json {", fp)).toBeNull();
    expect(parseSidecar("{}", fp)).toBeNull();
  });
});

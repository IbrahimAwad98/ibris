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
  pageOrder: [0, 1, 2],
  rotations: {},
  inserts: [],
  fieldValues: {},
  flattenForms: false,
  redactions: {
    r1: { id: "r1", pageIndex: 0, rect: { x: 1, y: 2, width: 30, height: 10 } },
  },
  textEdits: {
    "0:3": {
      pageIndex: 0,
      objectIndex: 3,
      original: "Hello world",
      text: "Held word",
      rect: { x: 1, y: 2, width: 30, height: 10 },
    },
  },
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
    // Pending redaction marks survive a crash — as pending marks only;
    // nothing about them touches the file until a confirmed save.
    expect(parsed?.redactions["r1"]).toMatchObject({ pageIndex: 0 });
    expect(parsed?.textEdits["0:3"]).toMatchObject({ text: "Held word" });
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

describe("forward compatibility", () => {
  it("parses an older sidecar without inserts, field, redaction, or edit keys", () => {
    const wire = serializeSidecar(fp, state);
    const legacy = JSON.parse(wire) as Record<string, unknown>;
    delete legacy["inserts"];
    delete legacy["fieldValues"];
    delete legacy["flattenForms"];
    delete legacy["redactions"];
    delete legacy["textEdits"];
    const parsed = parseSidecar(JSON.stringify(legacy), fp);
    expect(parsed).not.toBeNull();
    expect(parsed?.inserts).toEqual([]);
    expect(parsed?.fieldValues).toEqual({});
    expect(parsed?.flattenForms).toBe(false);
    expect(parsed?.redactions).toEqual({});
    expect(parsed?.textEdits).toEqual({});
  });
});

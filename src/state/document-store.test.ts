import { beforeEach, describe, expect, it } from "vitest";
import type { Annotation } from "../lib/annotations";
import {
  addAnnotation,
  addRedaction,
  insertPages,
  insertRef,
  MAX_STACK,
  modifyAnnotation,
  removeAnnotation,
  removeRedaction,
  rotatePages,
  setField,
  setFlattenForms,
  setPageOrder,
  useDocumentStore,
} from "./document-store";

function makeNote(
  id: string,
  contents = "hello",
): Extract<Annotation, { kind: "note" }> {
  return {
    id,
    kind: "note",
    pageIndex: 0,
    at: { x: 10, y: 20 },
    contents,
    color: "#ffcc00",
    opacity: 1,
    author: "test",
    createdAt: 1,
    modifiedAt: 1,
  };
}

beforeEach(() => {
  useDocumentStore.getState().reset();
});

describe("reopened annotations (M2-PLAN §8)", () => {
  it("a reopened annotation is deletable and undo restores it intact", () => {
    // The seed loadEditState performs from engine-recovered annotations:
    // clean stack, savedIds covering everything already in the file.
    const reopened = makeNote("saved-1", "from the file");
    useDocumentStore.getState().restore(
      {
        annotations: { "saved-1": reopened },
        pageOrder: null,
        rotations: {},
        inserts: [],
        fieldValues: {},
        flattenForms: false,
        redactions: {},
        commands: [],
        cursor: 0,
        savedCursor: 0,
        savedIds: ["saved-1"],
      },
      { size: 100, mtimeMs: 1 },
    );
    expect(useDocumentStore.getState().isDirty()).toBe(false);

    useDocumentStore.getState().execute(removeAnnotation(reopened));
    expect(useDocumentStore.getState().annotations["saved-1"]).toBeUndefined();
    expect(useDocumentStore.getState().isDirty()).toBe(true);
    // savedIds must survive the delete: the next save still has to remove
    // the annotation from the file on disk.
    expect(useDocumentStore.getState().savedIds).toEqual(["saved-1"]);

    useDocumentStore.getState().undo();
    expect(useDocumentStore.getState().annotations["saved-1"]).toEqual(reopened);
    expect(useDocumentStore.getState().isDirty()).toBe(false);
  });
});

describe("page reorder (M3)", () => {
  it("reorder then undo restores the order and keeps annotations on their pages", () => {
    const s = useDocumentStore.getState();
    s.initStructure(3);
    const note = { ...makeNote("n1"), pageIndex: 2 };
    s.execute(addAnnotation(note));

    useDocumentStore
      .getState()
      .execute(setPageOrder([0, 1, 2], [2, 0, 1], "Reorder pages"));
    // Annotations reference *source* pages, so the reorder moves them with
    // their page by construction — the record must not touch them.
    expect(useDocumentStore.getState().pageOrder).toEqual([2, 0, 1]);
    expect(useDocumentStore.getState().annotations["n1"]?.pageIndex).toBe(2);

    useDocumentStore.getState().undo();
    expect(useDocumentStore.getState().pageOrder).toEqual([0, 1, 2]);
    expect(useDocumentStore.getState().annotations["n1"]).toEqual(note);

    useDocumentStore.getState().redo();
    expect(useDocumentStore.getState().pageOrder).toEqual([2, 0, 1]);
    expect(useDocumentStore.getState().annotations["n1"]).toEqual(note);
  });
});

describe("insert pages from file (M3)", () => {
  it("insert, undo, redo keeps the order and the registered pages consistent", () => {
    const s = useDocumentStore.getState();
    s.initStructure(2);
    const page = { path: "C:\\docs\\other.pdf", pageIndex: 0, width: 612, height: 792 };
    s.execute(
      insertPages([0, 1], [0, insertRef(0), 1], 0, [page], "Insert page"),
    );
    expect(useDocumentStore.getState().pageOrder).toEqual([0, -1, 1]);
    expect(useDocumentStore.getState().inserts).toEqual([page]);

    useDocumentStore.getState().undo();
    expect(useDocumentStore.getState().pageOrder).toEqual([0, 1]);

    useDocumentStore.getState().redo();
    expect(useDocumentStore.getState().pageOrder).toEqual([0, -1, 1]);
    expect(useDocumentStore.getState().inserts).toEqual([page]);
  });
});

describe("form fields (M4)", () => {
  it("set-field round-trips through undo back to the file value", () => {
    const s = useDocumentStore.getState();
    s.execute(
      setField("name", null, { kind: "text", value: "Ibrahim" }, "Fill name"),
    );
    expect(useDocumentStore.getState().fieldValues["name"]).toEqual({
      kind: "text",
      value: "Ibrahim",
    });

    useDocumentStore.getState().undo();
    // Undo to null removes the entry: the field shows its file value.
    expect(useDocumentStore.getState().fieldValues["name"]).toBeUndefined();

    useDocumentStore.getState().redo();
    expect(useDocumentStore.getState().fieldValues["name"]).toEqual({
      kind: "text",
      value: "Ibrahim",
    });
  });

  it("flatten toggles and inverts", () => {
    useDocumentStore.getState().execute(setFlattenForms(false, true));
    expect(useDocumentStore.getState().flattenForms).toBe(true);
    useDocumentStore.getState().undo();
    expect(useDocumentStore.getState().flattenForms).toBe(false);
  });
});

describe("pending redactions (M5)", () => {
  const region = {
    id: "r1",
    pageIndex: 1,
    rect: { x: 10, y: 20, width: 100, height: 14 },
  };

  it("mark, undo, redo — a pending mark is fully undoable", () => {
    const s = useDocumentStore.getState;
    s().execute(addRedaction(region));
    expect(s().redactions["r1"]).toEqual(region);
    expect(s().isDirty()).toBe(true);

    s().undo();
    expect(s().redactions["r1"]).toBeUndefined();
    expect(s().isDirty()).toBe(false);

    s().redo();
    expect(s().redactions["r1"]).toEqual(region);
  });

  it("unmark round-trips through undo with the full region", () => {
    const s = useDocumentStore.getState;
    s().execute(addRedaction(region));
    s().execute(removeRedaction(region));
    expect(s().redactions["r1"]).toBeUndefined();

    s().undo();
    expect(s().redactions["r1"]).toEqual(region);
  });
});

describe("execute / undo / redo", () => {
  it("adds, undoes, and redoes an annotation", () => {
    const s = useDocumentStore.getState();
    s.execute(addAnnotation(makeNote("n1")));
    expect(useDocumentStore.getState().annotations["n1"]).toBeDefined();

    useDocumentStore.getState().undo();
    expect(useDocumentStore.getState().annotations["n1"]).toBeUndefined();

    useDocumentStore.getState().redo();
    expect(useDocumentStore.getState().annotations["n1"]).toBeDefined();
  });

  it("remove round-trips through undo with the full value", () => {
    const note = makeNote("n1", "important text");
    useDocumentStore.getState().execute(addAnnotation(note));
    useDocumentStore.getState().execute(removeAnnotation(note));
    expect(useDocumentStore.getState().annotations["n1"]).toBeUndefined();

    useDocumentStore.getState().undo();
    expect(useDocumentStore.getState().annotations["n1"]).toMatchObject({
      contents: "important text",
    });
  });

  it("modify captures before and after", () => {
    const before = makeNote("n1", "before");
    useDocumentStore.getState().execute(addAnnotation(before));
    const after = { ...before, contents: "after" };
    useDocumentStore.getState().execute(modifyAnnotation(before, after));
    expect(useDocumentStore.getState().annotations["n1"]).toMatchObject({
      contents: "after",
    });
    useDocumentStore.getState().undo();
    expect(useDocumentStore.getState().annotations["n1"]).toMatchObject({
      contents: "before",
    });
    useDocumentStore.getState().redo();
    expect(useDocumentStore.getState().annotations["n1"]).toMatchObject({
      contents: "after",
    });
  });

  it("executing after undo truncates the redo tail", () => {
    useDocumentStore.getState().execute(addAnnotation(makeNote("n1")));
    useDocumentStore.getState().execute(addAnnotation(makeNote("n2")));
    useDocumentStore.getState().undo();
    useDocumentStore.getState().execute(addAnnotation(makeNote("n3")));

    const s = useDocumentStore.getState();
    expect(s.commands).toHaveLength(2);
    expect(s.canRedo()).toBe(false);
    expect(s.annotations["n2"]).toBeUndefined();
    expect(s.annotations["n3"]).toBeDefined();
  });

  it("undo/redo at the ends are no-ops", () => {
    useDocumentStore.getState().undo();
    useDocumentStore.getState().redo();
    expect(useDocumentStore.getState().cursor).toBe(0);
  });
});

describe("dirty tracking", () => {
  it("is dirty exactly when cursor differs from savedCursor", () => {
    const s = useDocumentStore.getState;
    expect(s().isDirty()).toBe(false);
    s().execute(addAnnotation(makeNote("n1")));
    expect(s().isDirty()).toBe(true);
    s().markSaved(["n1"], null);
    expect(s().isDirty()).toBe(false);
    s().undo();
    expect(s().isDirty()).toBe(true);
    s().redo();
    expect(s().isDirty()).toBe(false);
  });
});

describe("serialisation", () => {
  it("the stack is plain JSON and replays identically", () => {
    const note = makeNote("n1", "serialised");
    useDocumentStore.getState().execute(addAnnotation(note));
    useDocumentStore
      .getState()
      .execute(modifyAnnotation(note, { ...note, contents: "edited" }));

    const s = useDocumentStore.getState();
    const wire = JSON.parse(
      JSON.stringify({
        annotations: s.annotations,
        commands: s.commands,
        cursor: s.cursor,
      }),
    ) as {
      annotations: typeof s.annotations;
      commands: typeof s.commands;
      cursor: number;
    };

    useDocumentStore.getState().reset();
    useDocumentStore.getState().restore(
      {
        annotations: wire.annotations,
        pageOrder: null,
        rotations: {},
        inserts: [],
        fieldValues: {},
        flattenForms: false,
        redactions: {},
        commands: wire.commands,
        cursor: wire.cursor,
        savedCursor: 0,
        savedIds: [],
      },
      null,
    );
    expect(useDocumentStore.getState().annotations["n1"]).toMatchObject({
      contents: "edited",
    });
    expect(useDocumentStore.getState().isDirty()).toBe(true);
    // Undo still works across the restore boundary.
    useDocumentStore.getState().undo();
    expect(useDocumentStore.getState().annotations["n1"]).toMatchObject({
      contents: "serialised",
    });
  });
});

describe("page structure commands", () => {
  it("reorders pages and undo restores order and annotations", () => {
    const s = useDocumentStore.getState;
    s().initStructure(3);
    // Annotation on source page 2.
    s().execute(addAnnotation({ ...makeNote("n1"), pageIndex: 2 }));
    s().execute(setPageOrder([0, 1, 2], [2, 0, 1], "Move page 3 first"));

    expect(s().pageOrder).toEqual([2, 0, 1]);
    // The annotation still references source page 2 — it moved with it.
    expect(s().annotations["n1"].pageIndex).toBe(2);

    s().undo();
    expect(s().pageOrder).toEqual([0, 1, 2]);
    expect(s().annotations["n1"].pageIndex).toBe(2);
  });

  it("deleting a page is an order change; undo brings it back", () => {
    const s = useDocumentStore.getState;
    s().initStructure(3);
    s().execute(setPageOrder([0, 1, 2], [0, 2], "Delete page 2"));
    expect(s().pageOrder).toEqual([0, 2]);
    s().undo();
    expect(s().pageOrder).toEqual([0, 1, 2]);
  });

  it("rotation round-trips through undo including implicit zero", () => {
    const s = useDocumentStore.getState;
    s().initStructure(2);
    s().execute(rotatePages({ 1: 0 }, { 1: 90 }, "Rotate page 2"));
    expect(s().rotations[1]).toBe(90);
    s().execute(rotatePages({ 1: 90 }, { 1: 180 }, "Rotate page 2"));
    expect(s().rotations[1]).toBe(180);
    s().undo();
    expect(s().rotations[1]).toBe(90);
    s().undo();
    expect(s().rotations[1]).toBe(0);
  });

  it("initStructure never clobbers a restored order", () => {
    const s = useDocumentStore.getState;
    s().initStructure(3);
    s().execute(setPageOrder([0, 1, 2], [2, 1, 0], "Reverse"));
    s().initStructure(3);
    expect(s().pageOrder).toEqual([2, 1, 0]);
  });
});

describe("stack cap", () => {
  it("drops the oldest command past MAX_STACK and stays consistent", () => {
    for (let i = 0; i < MAX_STACK + 10; i++) {
      useDocumentStore.getState().execute(addAnnotation(makeNote(`n${i}`)));
    }
    const s = useDocumentStore.getState();
    expect(s.commands.length).toBe(MAX_STACK);
    // Oldest annotations survive in the document even though their
    // commands aged out of the undo stack.
    expect(Object.keys(s.annotations)).toHaveLength(MAX_STACK + 10);
    expect(s.cursor).toBe(MAX_STACK);
  });
});

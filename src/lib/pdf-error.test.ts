import { describe, expect, it } from "vitest";
import { saveErrorMessage } from "./pdf-error";

describe("saveErrorMessage", () => {
  it("passes Unsupported.feature through verbatim — the engine writes the refusal for the user", () => {
    const refusal =
      'the text under a marked region also appears in the form field "Applicant name"; ' +
      "clear or redact that field first";
    expect(saveErrorMessage({ kind: "Unsupported", feature: refusal })).toBe(
      refusal,
    );
  });

  it("maps every other kind to a specific, actionable message", () => {
    expect(
      saveErrorMessage({ kind: "FileNotFound", path: "C:\\x.pdf" }),
    ).toContain("C:\\x.pdf");
    expect(saveErrorMessage({ kind: "PasswordRequired" })).toContain(
      "password",
    );
    expect(saveErrorMessage({ kind: "Corrupt", detail: "bad xref" })).toContain(
      "bad xref",
    );
    expect(saveErrorMessage({ kind: "Io", detail: "disk full" })).toContain(
      "disk full",
    );
    expect(saveErrorMessage({ kind: "Internal", detail: "ffi" })).toContain(
      "not changed",
    );
  });

  it("never surfaces a raw non-PdfError value", () => {
    const msg = saveErrorMessage(new Error("panic at line 42"));
    expect(msg).not.toContain("panic");
    expect(msg).toContain("not changed");
  });
});

// Maps typed engine errors to the user-facing message (ARCHITECTURE.md:
// every kind gets a specific, actionable message; raw Rust strings never
// reach the user). Pure — no React, no Tauri.
import type { PdfError } from "../ipc/pdf";

function isPdfError(e: unknown): e is PdfError {
  return (
    typeof e === "object" &&
    e !== null &&
    typeof (e as { kind?: unknown }).kind === "string"
  );
}

/**
 * The message shown when a save fails. `Unsupported.feature` is passed
 * through verbatim — the engine writes those for users, naming the exact
 * channel that blocks the operation (e.g. which form field still carries
 * redacted text) and what to do about it.
 */
export function saveErrorMessage(e: unknown): string {
  if (!isPdfError(e)) {
    return "Saving failed for an unexpected reason. The file on disk was not changed.";
  }
  switch (e.kind) {
    case "FileNotFound":
      return `The file no longer exists at ${e.path}. Use Save As to write it somewhere else.`;
    case "PasswordRequired":
      return "This document is password-protected and cannot be saved.";
    case "Corrupt":
      return `The document could not be rewritten: ${e.detail}. Use Save As to keep a copy of your work.`;
    case "Unsupported":
      return e.feature;
    case "Io":
      return `The file could not be written: ${e.detail}. Check that the location is writable and has free space.`;
    case "Cancelled":
    case "Internal":
      return "Saving failed inside the PDF engine. The file on disk was not changed.";
  }
}

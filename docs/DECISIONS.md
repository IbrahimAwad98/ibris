# Decision log

Short records of structural decisions and why they were made. Append new entries;
never delete old ones. If a decision is reversed, add a new entry that supersedes
it rather than editing history.

Format: what was decided, what the alternatives were, why this one won, and what
it costs.

---

## 001 — Tauri instead of Electron or a native Windows framework

**Decided:** Tauri 2 with a React/TypeScript frontend and a Rust backend.

**Alternatives:** Electron; .NET 8 + WinUI 3; Avalonia; Qt.

**Why:** Tauri produces a ~10–15 MB installer against Electron's 150 MB+, and
ships an MSI/NSIS builder and an updater. Keeping the UI in React means UI
iteration stays fast, which matters more than anything else for this project,
since the goal is a viewer that feels better than the alternatives. WinUI 3 would
be more idiomatic on Windows but makes UI polish considerably slower and closes
the door on other platforms.

**Cost:** A Rust learning curve, and reliance on the system WebView2 runtime.

---

## 002 — PDFium as the only PDF engine

**Decided:** PDFium via the `pdfium-render` crate, called from Rust.

**Alternatives:** MuPDF; Poppler; PDF.js in the frontend; pdf-lib for writing.

**Why:** PDFium is BSD licensed, is the engine behind Chrome, and handles
malformed real-world files better than anything else available. MuPDF and Poppler
are GPL/AGPL, which would force the whole project under a copyleft licence.

**Cost:** The PDFium dynamic library must be bundled per platform, which
complicates the build. Some newer PDF features have thinner support than in
commercial SDKs.

**Explicitly rejected:** using PDF.js in the frontend "just to get started".
Two engines means two rendering behaviours, two text extraction results, and
permanent inconsistency. Accepted the slower start instead.

---

## 003 — Permissive licences only

**Decided:** Ibris is MIT licensed. Dependencies must be MIT, Apache-2.0, BSD,
ISC, or MPL-2.0. `cargo deny check licenses` runs in CI and fails the build on
violations.

**Why:** A single GPL or AGPL dependency would relicense the entire project. That
would close off commercial use by others and remove much of the point of
publishing it.

**Cost:** Some capable libraries — MuPDF, iText, Ghostscript — are permanently
off limits.

---

## 004 — Edits live on a command stack, not in the file

**Decided:** Editing operations are stored as invertible commands in memory and
applied to the PDF only on save.

**Alternatives:** Mutating the document through PDFium on every user action.

**Why:** Direct mutation makes undo/redo either impossible or dependent on
re-parsing the file after every keystroke. The command stack gives undo, redo, a
dirty flag, crash recovery, and an instant UI from one mechanism.

**Cost:** Every editing feature must be expressed as an invertible command, which
is more work per feature. Memory grows with edit history — bounded by capping the
stack depth.

---

## 005 — Fully offline, no telemetry

**Decided:** No analytics, no crash reporting to a server, no network calls except
an opt-in updater.

**Why:** PDFs routinely contain contracts, medical records, and legal documents.
A PDF reader that phones home is not trustworthy, and being obviously trustworthy
is a feature.

**Cost:** No usage data to guide prioritisation. Bug reports must come through
GitHub issues.

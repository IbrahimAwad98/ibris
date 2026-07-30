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

---

## 006 — PDFium binary from bblanchon/pdfium-binaries, pinned, non-V8

**Decided:** The Windows PDFium DLL comes from the bblanchon/pdfium-binaries
GitHub releases, pinned to an exact release tag in `scripts/get-pdfium.ps1`
(currently `chromium/7961`), using the non-V8 build.

**Alternatives:** Building PDFium from Chromium source (a multi-hour, multi-GB
toolchain of its own); the V8-enabled build; an unpinned "latest" download.

**Why:** The bblanchon builds are automated, unmodified, widely used, and what
`pdfium-render` documents. Pinning makes the fetch reproducible and keeps
future golden-image render tests stable. Non-V8 means no JavaScript engine:
Ibris never executes PDF JavaScript, and the smaller binary is a smaller
attack surface.

**Cost:** Trusting a third-party build pipeline rather than Google's own
artefacts (Google does not publish official prebuilt PDFium binaries).
Version bumps are manual.

---

## 007 — Zlib and Unicode-3.0 added to the licence allow list

**Decided:** `deny.toml` allows Zlib and Unicode-3.0 in addition to the five
families named in CLAUDE.md (MIT, Apache-2.0, BSD, ISC, MPL-2.0).

**Why:** Unavoidable in practice — `zlib-rs`/`miniz_oxide` (Zlib) and ICU
components (Unicode-3.0) sit under the standard Rust PNG/Unicode stacks.
Both are permissive, GPL-compatible, attribution-style licences with no
copyleft obligations, consistent with the intent of decision 003. The
NCSA-licensed AVIF stack, by contrast, was avoided by disabling the `image`
crate's default features rather than widening the list further.

**Cost:** The allow list and CLAUDE.md's shorthand now differ slightly; the
list in `deny.toml` is authoritative.

---

## 008 — All PDFium work on one engine thread

**Decided:** A single process-global engine thread owns every open
`PdfDocument` and executes every PDFium FFI call. Everything else reaches it
through a channel (`pdf/engine.rs`).

**Alternatives:** One worker thread per document (the original M1a design);
per-document workers plus pdfium-render's `thread_safe` feature.

**Why:** Both alternatives crash. With per-document workers, concurrent test
runs died with STATUS_ACCESS_VIOLATION; adding `thread_safe` (a lock around
each FFI call) still crashed with STATUS_ILLEGAL_INSTRUCTION under concurrent
multi-document use. PDFium is single-threaded at heart — Chrome serialises
all access too. A structural invariant (one thread, enforced by ownership)
beats a lock discipline that demonstrably leaks.

**Cost:** Rendering serialises across documents, not just within one. For a
desktop viewer, effectively no cost — but if parallel multi-document
rendering ever matters, the only real option is one process per document.

**Follow-up (M1c):** Once tabs land, background documents will contend with
the visible one on this single thread. The intended fix is a priority queue
on the engine channel favouring the visible document's requests — not
additional threads, which PDFium cannot tolerate.

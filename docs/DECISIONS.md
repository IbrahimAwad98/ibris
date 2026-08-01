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

---

## 009 — All IPC geometry is relative to the page's visible box

**Decided:** Every coordinate crossing the IPC boundary (text runs, search
rects, and anything geometric added later) is emitted relative to the page's
visible box — crop box, falling back to media box — with a top-left origin.
The conversion happens once, in `src-tauri/src/pdf/text.rs`.

**Why:** PDFium's `FPDFText_*` char boxes are in absolute page space, while
rendering maps the crop/media box to the bitmap — and that box need not
start at (0,0). Real-world documents with offset origins exist; on them,
absolute coordinates displaced every highlight and text run by the origin
(constant in points, growing with zoom in pixels).

**Consequence for fixtures:** zero-origin fixtures hide this entire class of
bug — every test passed while highlights were visibly wrong. The fixture set
must always include a non-zero-origin document (`offset-mediabox.pdf`), and
geometry features should test against it, not only against the plain
fixtures.

---

## 010 — Engine priority queue: in-place scan, not extra channels

**Decided:** The engine channel (decision 008's follow-up) is a
`Mutex<VecDeque> + Condvar` queue. Dequeue picks the first *hot* message —
one with no document (always user-initiated, e.g. `Open`) or belonging to
the active document — falling back to FIFO. The frontend declares the
visible document via `set_active_document`; `u64::MAX` is the "none"
sentinel in an `AtomicU64`.

**Alternatives:** Two `mpsc` channels (high/low); a `BinaryHeap` with
priority stamps; re-sorting the queue on tab switch.

**Why:** Two channels can't be blocked on simultaneously without polling.
A heap needs tiebreak stamps to stay FIFO within a document, and priorities
computed at enqueue time go stale the moment the user switches tabs — the
scan reads the *current* active document at dequeue, so a tab switch
instantly re-prioritises everything already queued.

**Cost:** O(n) scan per dequeue, bounded by queue depth (a viewport of
tiles plus a preview pass per tab). Background documents can be starved
while the visible one has work — exactly the intended behaviour.

---

## 011 — Dark-mode pages: engine bitmap post-pass, not CSS

**Decided:** Dark mode inverts the rendered page bitmap in Rust
(`pdf/dark.rs`): RGB → HSL, lightness flipped, hue/saturation kept, and the
device-pixel rects of embedded image objects skipped entirely. An `invert`
flag rides every render/tile request; frontend tile-cache keys carry the
bit, so a theme switch is just a cache miss.

**Alternatives:** CSS `filter: invert(1)` on the canvas (turns photos into
negatives, shifts every hue); CSS `invert(1) hue-rotate(180deg)` (repairs
hue but still negates photos and washes out saturated colour); PDFium's
`FPDF_RENDER_REVERSE_BYTE_ORDER`-style colour-scheme APIs (not exposed by
pdfium-render, and forced-colour rendering loses colour semantics rather
than flipping luminance).

**Why:** Only a per-pixel pass can both preserve hue and leave photographs
positive, and only the engine knows where image objects sit on the page.
Cost lands off the UI thread, and the invert bit in the cache key means no
special-case invalidation anywhere.

**Cost:** Roughly doubles per-tile CPU in dark mode (HSL round trip per
pixel) and re-renders everything on theme switch. Images nested inside Form
XObjects are not detected and will be inverted — recurse into form objects
if such a document shows up.

---

## 012 — Documents open from bytes, not by file path

**Decided:** `open` reads the whole PDF into memory and loads it with
`load_pdf_from_byte_vec`; PDFium never holds an OS handle on the file.

**Alternatives:** `load_pdf_from_file` (PDFium's own file loader);
opening with `FILE_SHARE_DELETE` semantics (not reachable through PDFium's
loader on Windows).

**Why:** PDFium's file loader keeps the file handle open for the lifetime
of the document. On Windows that blocks the save pipeline's atomic
temp-file rename over the file *while it is being viewed* — which is every
save. Loading from bytes releases the file at open, so save/rename always
works and external tools can touch the file (which the fingerprint check
then detects).

**Cost:** Whole-file memory residency per open tab — tens of MB for
typical documents, hundreds for scan-heavy ones. Accepted for a desktop
viewer; if it ever matters, the fallback is a custom `FPDF_FILEACCESS`
reader over a `FILE_SHARE_DELETE` handle, not PDFium's loader.

---

## 013 — Save is a raw-FFI rewrite of a fresh load, keyed by /NM

**Decided:** Save runs entirely on the engine thread against a *fresh*
`FPDF_LoadMemDocument64` of the on-disk bytes. It deletes every annotation
whose `/NM` is one of ours, rewrites all current annotations (explicit /AP
appearance streams, raw `FPDFAnnot_*` FFI), runs `FPDF_SaveAsCopy` with
`FPDF_NO_INCREMENTAL` into a temp file, and renames over the target. The
viewing document is never touched or reloaded on a non-structural save.

**Alternatives:** Mutating the viewing document and saving it (loses the
clean separation between base file and command stack; annotations would
double-render — once from the bitmap, once from the overlay — or force a
reload that destroys undo history). Incremental append (PDFium's public
save surface regenerates regardless; the flag exists but a true
incremental append is not honoured). pdfium-render's safe annotation API
(cannot create line/circle, and exposes no /NM, /CA, or /AP setters).

**Why:** Delete-by-/NM-then-write makes saves idempotent — saving twice
does not duplicate annotations. Working on a fresh load means undo
survives saves and the overlay never double-renders. Temp + same-volume
rename means a failure anywhere leaves the destination untouched.

**Cost:** Full rewrite invalidates existing digital signatures on every
save (flagged for a later milestone: warn on signed documents). Raw FFI
means manual lifetime discipline (`unsafe` blocks confined to
`pdf/annot.rs` and `pdf/save.rs`, engine thread only per decision 008).

---

## 014 — Structural saves rebase the document and reset undo history

**Decided:** After a save that changes page structure (reorder, delete,
rotate), the open document is *rebased*: the viewer reloads the new file,
annotations are remapped source→final page indexes, page order becomes
identity, rotations reset to zero, and the undo history is cleared.
Non-structural (annotation-only) saves keep the full undo history.

**Alternatives:** Keeping the undo stack across structural saves by
rewriting every stacked command's page indexes through the inverse
permutation; keeping the old engine document alive as the undo base.

**Why:** After the disk file is materialised in the new order, "undo the
reorder" has no meaningful base — the original file no longer exists, so
undoing would have to *re-reorder* the new file, and every older command
on the stack would need its page references rewritten against a document
whose indexes have changed meaning. That is a permutation-rewriting engine
bolted onto the command stack, purchasable only with new invariants that
each later feature must maintain. A save is already an explicit "commit"
gesture; resetting history at that point matches what the file on disk
can support.

**Cost:** Undo stops at the last structural save. Deliberate and visible
(the history panel empties), not a silent loss — an annotation-only save
keeps history precisely because no rebase happens.

---

## 015 — Reopened annotations: /NM prefix + IbrisData, reconstruction as the floor

**Decided:** Annotations are written with `/NM = "ibris:<uuid>"` (the
ownership marker) and an `IbrisData` private key holding the full wire
model as JSON. On open, a raw scan recovers every `ibris:`-tagged
annotation — from `IbrisData` when readable, else **reconstructed from
standard PDF keys** (QuadPoints, InkList, /Rect, /Contents, /CA, border,
/M) — and the viewing document suppresses them in memory so they render
through the editable SVG overlay instead of the page bitmap.

**Alternatives:** Trusting `IbrisData` alone (a private key any other
tool may strip on re-save — failure would be a silent regression to
read-only that looks like a bug); recognising ours by "the /NM looks
like a UUID" (Acrobat also writes GUID-shaped /NM values —
false-positives would let the app rewrite foreign annotations);
a sidecar database next to the app data (dies with the machine, and the
file must stand alone).

**Why:** Reconstruction from standard keys is the load-bearing
mechanism, because it survives every editor that preserves annotations
at all; `IbrisData` is a fidelity upgrade on top (exact colours, arrow
heads, stamp kinds). The degradation ladder is: verbatim → reconstructed
(an arrow whose IbrisData was stripped comes back as a line) → still
visible but read-only (anything unmodellable stays in the viewing
document). No rung loses content.

**Cost:** Each annotation carries a few hundred bytes of JSON. The open
path does one extra raw parse of the file. A tool that rewrites /NM
entirely turns our annotations foreign — visible, uneditable; nothing
better is possible once identity is gone.

---

## 016 — Forms: fill through PDFium's event pipeline; flatten is all-or-nothing

**Decided:** Form field values live in the command stack (`set-field`,
undoable) and are written at save by driving PDFium's form-fill
environment — focus, select-all, replace-selection, kill-focus (space
keystroke for checkboxes/radios) — on the engine thread. The viewer
overlays HTML controls (opaque, paper-coloured) over widget rects; the
page bitmap's own widget appearance is never the source of truth.
"Flatten" is a single undoable-before-save flag that bakes *all*
annotations and fields into page content via `FPDFPage_Flatten`.

**Alternatives:** Writing `/V` directly (pdfium-render's `set_value`
does this) — rejected because nothing regenerates the widget appearance
stream, so every /AP-honouring reader (PDFium itself, Edge, Preview)
keeps showing the old value; the M4 test proves regeneration by
counting rendered glyph pixels. Setting `/NeedAppearances` — PDFium
exposes no API for it. Fields-only flatten — PDFium's flatten API has
no such mode; a selective reimplementation means writing appearance
streams into content streams by hand, which is M6-grade work for a
niche gain.

**Known degradations, accepted and recorded:** (1) A structural save
(reorder/delete/insert) imports pages into a fresh document, and the
catalog `/AcroForm` registration does not survive
`FPDF_ImportPagesByIndex` — fields keep their appearance but stop being
interactive in the saved file. Values are applied to the source
document *before* import so filled state is preserved visually.
(2) Tab order follows widget enumeration order per page (the `/Tabs`
key is not honoured), and cannot cross unmounted virtualised pages.
(3) Multi-select list boxes are treated as single-select.

**Cost:** The fill path is event-driven and therefore order-sensitive;
each field costs a focus/commit round trip at save (irrelevant at
human form sizes). XFA is detected and declared unsupported rather
than approximated.

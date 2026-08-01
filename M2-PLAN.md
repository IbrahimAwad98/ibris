# M2 plan — annotations

M2 is the first milestone that writes to PDF files, so the shapes chosen here
(command model, sidecar format, save pipeline, annotation identity) outlive
the milestone. This document is the paper pass before code. If the
implementation ends up contradicting it, the plan gets corrected and the
change is noted in PROGRESS.md.

---

## 1. The Command interface

ARCHITECTURE.md sketches `Command` with `apply`/`invert` methods. Methods
cannot be serialised, and the stack must serialise for crash recovery
(section 2). So the stack stores **plain data**, and behaviour lives in a
type-keyed table:

```ts
// One entry on the undo stack. Pure data, structured-clone safe.
interface CommandRecord {
  id: string;             // uuid of the command instance
  type: CommandType;      // "add-annotation" | "modify-annotation" | ...
  label: string;          // "Highlight text" — shown in undo history
  payload: unknown;       // per-type, see below
}

// Behaviour table, one entry per CommandType:
interface CommandSpec<P> {
  apply(doc: DocumentEditState, payload: P): DocumentEditState;
  invert(payload: P): P;  // returns the payload of the inverse command
}
```

`invert` maps a payload to the payload that undoes it (swap before/after,
add↔remove). Undo = `apply(invert(payload))`. This keeps every command
invertible **by construction** — a new command type does not compile without
an inverse — and the whole stack is `JSON.stringify`-able.

`DocumentEditState` (in `documentStore`, per tab) is, for M2:

```ts
interface DocumentEditState {
  annotations: Record<AnnotationId, Annotation>;  // uuid -> value
}
```

### Annotation model

```ts
type AnnotationId = string; // uuid, becomes /NM in the PDF (section 4)

interface AnnotationBase {
  id: AnnotationId;
  pageIndex: number;
  color: string;          // #rrggbb
  opacity: number;        // 0..1
  author: string;
  createdAt: number; modifiedAt: number;
}
type Annotation = AnnotationBase & (
  | { kind: "highlight" | "underline" | "strikeout"; quads: Rect[] }
  | { kind: "ink"; strokes: Point[][]; strokeWidth: number }
  | { kind: "note"; at: Point; contents: string }
  | { kind: "shape"; shape: "rect" | "ellipse"; rect: Rect;
      strokeWidth: number; fill?: string }
  | { kind: "shape"; shape: "line" | "arrow"; from: Point; to: Point;
      strokeWidth: number }
  | { kind: "stamp"; rect: Rect; stamp: StampName }
);
```

All geometry is in **page points relative to the visible box, top-left
origin** — the same convention as every other IPC geometry (decision 009).
Conversion to PDF bottom-left space happens once, in Rust, at save.

### The three commands

Each captures everything needed to be invertible — full values, never diffs:

| Command | payload | invert |
| --- | --- | --- |
| `add-annotation` | `{ annotation }` | `remove-annotation` of the same value |
| `remove-annotation` | `{ annotation }` (full copy at removal time) | `add-annotation` |
| `modify-annotation` | `{ before, after }` (full values) | swap before/after |

Move/resize/restyle are all `modify-annotation`; there is no partial-diff
command. Cost: payloads duplicate the annotation (~1 KB each, ink strokes a
few KB) — irrelevant at a capped stack depth (500 commands).

The stack itself: `commands: CommandRecord[]`, `cursor: number` (index past
the last applied command), `savedCursor: number`. Dirty ⇔ `cursor !==
savedCursor`. Pushing while `cursor < length` truncates the redo tail —
plain linear undo, no tree.

## 2. Sidecar serialisation (crash recovery)

- **Format:** one JSON file:
  `{ version: 1, docPath, fingerprint, savedCursor, cursor, commands }`.
  A future breaking change bumps `version`; unknown versions are discarded,
  never migrated silently.
- **Where:** `<appDataDir>/sidecars/<sha256(docPath) first 16 hex>.json`
  via Tauri's path API. Not next to the PDF: users open files from
  read-only media and synced folders, and litter there is user-hostile.
- **Keyed to the document:** `fingerprint = { size, mtimeMs }` of the PDF
  captured at open. Cheap, no full-file hash on every open.
- **Stale detection:** on open, a sidecar whose `fingerprint` does not match
  the file on disk is deleted — the document changed outside a crash, and
  replaying commands against different content is worse than losing them.
  On fingerprint match, the stack is restored (commands + cursor), the
  document shows as dirty, and the user sees their edits again.
- **When written:** debounced ~2 s after any stack change; deleted on clean
  save and on clean close (cursor === savedCursor).

## 3. Save strategy

Save sends the command tail to Rust, which materialises annotations onto the
open document (PDFium annotation APIs) and writes:

| Operation | Write mode | Why |
| --- | --- | --- |
| Save / Save As (M2) | **Full rewrite via save-to-temp + atomic swap** | See below |
| Flatten / redact (later) | Full rewrite, mandatory | Incremental save appends; the "removed" content would remain recoverable in the file |

ARCHITECTURE.md prefers incremental update for Save. PDFium's public save
surface (`FPDF_SaveAsCopy` / `FPDF_SaveWithVersion`, exposed by
pdfium-render as `save_to_file`/`save_to_bytes`) performs a full
regeneration; the `FPDF_INCREMENTAL` flag is defined but not honoured as a
true incremental append. So M2 ships full rewrite — **through one
`save_document` choke point in `pdf/save.rs`**, so a later incremental path
changes one function, not the app. Consequence of full rewrite worth naming:
existing digital signatures are invalidated on save; M2 accepts this (the
alternative is not saving at all) — flagged for a later milestone to warn on
signed documents. This supersedes the "incremental where possible"
preference for M2 only; DECISIONS.md gets an entry when implementation
confirms it.

**Documents are opened from bytes, not by file path** (revised while
implementing): PDFium's file loader keeps an OS handle open, which on
Windows blocks replacing the file while it is being viewed. Reading the
file into memory and using `load_pdf_from_byte_vec` releases the handle at
open. Cost: whole-file memory residency (tens of MB for typical documents);
recorded in DECISIONS.md.

Write pipeline (revised): the save runs entirely on the engine thread
against a **fresh raw-FFI load of the on-disk file** — the viewing document
is never touched. Steps: raw-load → delete every annotation whose `/NM` is
one of our ids → write all current annotations → `FPDF_SaveAsCopy` to
`.<name>.ibris-tmp` in the target directory → close the raw document →
`rename` over the target (same-volume atomic) → `savedCursor = cursor`,
delete sidecar, refresh fingerprint. Delete-before-write makes saves
**idempotent**: the next save against the already-annotated disk file
replaces our annotations rather than duplicating them.

Consequence, deliberate: the viewing document is *not* reloaded after save,
so undo history survives saves, and our annotations keep living in the
overlay (never double-rendered by the page bitmap). Memory base + command
stack = disk state, which is exactly the document model.

## 4. Annotation writing and interoperability

Mapping (all created with PDFium `FPDFPage_CreateAnnot` via pdfium-render;
if a needed setter is missing from the safe wrapper, the crate's raw
`bindings()` FFI is used on the engine thread — still one engine):

| Tool | Subtype | Geometry carried in |
| --- | --- | --- |
| Highlight | `/Highlight` | QuadPoints (+ Rect = union) |
| Underline | `/Underline` | QuadPoints |
| Strikethrough | `/StrikeOut` | QuadPoints |
| Ink | `/Ink` | InkList (one array per stroke) |
| Note | `/Text` | Rect (icon box), /Contents, /Name /Comment |
| Rectangle | `/Square` | Rect, /IC fill |
| Ellipse | `/Circle` | Rect, /IC fill |
| Line / Arrow | `/Line` | /L endpoints; arrow = /LE [/None /OpenArrow] |
| Stamp | `/Stamp` | Rect + appearance stream |

Interop rules learned from how Acrobat/Edge/Preview actually behave:

- **Every annotation gets an explicit appearance stream (/AP /N).** Acrobat
  regenerates appearances; Edge (PDFium) and macOS Preview largely render
  what /AP says and fall back inconsistently without it. PDFium does not
  auto-generate /AP on creation, so the engine builds a content stream per
  annotation (rectangles, ellipses, lines, ink paths, highlight quads with
  `/Multiply` blend for the classic marker look, text-note icon). This is
  the main implementation cost of M2 and the main interop risk; the
  round-trip test asserts /AP presence.
- Standard keys always set: `/NM` (our uuid — identity for round-trip),
  `/T` (author), `/M` + `/CreationDate` (PDF date format), `/C` (color),
  `/CA` (opacity), `/F 4` (print flag).
- Colours as /C RGB arrays; opacity via /CA **and** baked into the /AP
  (Preview ignores /CA on some subtypes).

**Existing annotations in opened documents** are rendered by the page
bitmap (PDFium draws them during rasterisation) and are **fully read-only
in M2** — not deletable either. Revised from the earlier draft ("delete
allowed"): with the no-reload save pipeline, a deleted foreign annotation
would stay visible in the bitmap until the next save, which reads as a
broken delete. Read-only is honest; foreign-annotation editing is a later
milestone.

Round-trip verification (engine-level test): create one of each type on a
fixture, save, reopen, assert per annotation: subtype, /NM, page, geometry
(quads/rect/endpoints within 0.5 pt), color (exact), opacity. Third-party
rendering (Acrobat, Edge, Preview) cannot be verified in this environment —
manual checklist item.

## 5. Conflict handling (file changed on disk)

No file watcher in M2. The fingerprint from section 2 is checked at the two
moments that matter:

- **At save:** if the on-disk file no longer matches the fingerprint
  captured at open, the save does not proceed silently. A native dialog
  offers: **Save As…** (default), **Overwrite**, **Cancel**. Overwrite
  replays commands against the *in-memory* document (the original bytes we
  opened), so the other writer's changes are lost knowingly, not merged.
- **At close with unsaved edits:** the standard Save / Discard / Cancel
  prompt; a Save that hits a conflict falls into the flow above.

No merging, ever — two writers to one PDF is a losing game; the honest
options are the three above.

## 6. Deliberately NOT in M2

- **Editing foreign annotations** (move/restyle) — read, render, delete only.
  Regenerating arbitrary appearance streams correctly is unbounded scope.
- **Free-text (typewriter) annotations** — needs font embedding decisions;
  text notes cover the use case for now.
- **Popup replies / review workflows** (`/IRT`, status) — reader-first app.
- **Polygon/polyline/cloud shapes** — rect, ellipse, line, arrow cover M2.
- **Flatten and redaction** — later milestone; both force full rewrite and
  redaction has hard correctness requirements (content stream scrubbing).
- **Signature-preserving incremental save** — see section 3.
- **Cross-machine sidecar sync** — sidecars are local crash recovery, not a
  collaboration feature.

## 7. Build order (test-first per step)

1. Command stack core in `src/state/document-store.ts` (pure, fully
   unit-tested: push/undo/redo/truncate/dirty/serialise round-trip).
2. Sidecar persistence (pure planning + tauri fs wiring) + stale detection
   tests.
3. Rust `pdf/annot.rs`: create/enumerate/delete + /AP generation; fixture
   `annotations.pdf`; round-trip test (the M2 gate).
4. `pdf/save.rs`: temp-file save pipeline + reopen/remap; save tests.
5. Annotation SVG layer + tools (highlight from text selection reusing the
   search/selection geometry; ink; shapes; note; stamp), each: command
   first, then UI.
6. Undo history panel, dirty indicator, close prompt, tool settings
   persistence (`toolStore`, zustand persist).

# Architecture

## Overview

Ibris is a Tauri application. The frontend owns everything the user sees and all
editing state. The Rust backend owns the PDF file and every operation that touches
it. They communicate over typed Tauri commands.

```
React + TypeScript      UI, tools, keyboard, layout
        |
Document model          Command stack, undo/redo, dirty state
        |
Tauri commands (IPC)    Typed, async, serialisable
        |
Rust core               Render, text, search, pages, annotations, save
        |
PDFium                  Parsing and rasterisation
```

The one-way flow matters: the frontend never reaches past the IPC layer, and the
Rust core never knows anything about UI concepts like tools, selections, or zoom
levels. It receives coordinates and returns data.

---

## Document model and the command stack

This is the central design decision of the project.

**The open PDF is never modified in place.** When a document is opened, Rust holds
a read-only handle to it. Every edit the user makes becomes a `Command` object in a
stack held by the frontend:

```ts
interface Command {
  id: string;
  label: string;              // Shown in the undo menu: "Highlight text"
  apply(doc: DocumentState): DocumentState;
  invert(doc: DocumentState): DocumentState;
}
```

The stack gives us four things for free:

- **Undo/redo** — move the pointer up or down the stack.
- **A dirty flag** — pointer position differs from the last-saved position.
- **Crash recovery** — the stack is serialisable, so it can be written to a
  sidecar file periodically and replayed on restart.
- **Instant UI** — applying a command updates local state immediately; the
  expensive PDF write happens only on save.

On save, the stack is sent to Rust, which replays the operations against the
original document and writes a new file. Incremental save (appending an update
section rather than rewriting the file) is preferred where PDFium supports it,
because it preserves existing signatures and is much faster on large files.

**Consequence:** if you add an editing feature, the command comes first. Wiring a
button straight to a mutation is the one thing that will make this codebase
unmaintainable.

---

## Rendering pipeline

Rendering must feel instant. The strategy is tiled, cached, and progressive.

1. The viewer is a virtualised list. Only pages intersecting the viewport (plus
   one screen above and below) are considered for rendering.
2. Each visible page is requested from Rust at the current zoom level. Large pages
   are split into tiles so partial results can appear.
3. Rust renders with PDFium on a worker thread and returns an RGBA buffer. The
   frontend writes it to a canvas.
4. A low-resolution version of every page is rendered once on open and kept in
   memory. It is drawn as a placeholder while the sharp tile is being produced —
   this is what removes the white-flash-on-scroll problem that plagues most
   PDF viewers.
5. An LRU cache holds rendered tiles, bounded by memory rather than count.

Rendering requests are cancellable. Fast scrolling must cancel in-flight renders
for pages that have left the viewport, otherwise the worker queue backs up and
scrolling stutters.

### Layers on top of the canvas

Each page is a stack:

| Layer | Purpose |
| --- | --- |
| Canvas | The rasterised page |
| Text layer | Transparent positioned spans from PDFium's char boxes — enables native text selection, copy, and search highlighting |
| Annotation layer | SVG overlay for highlights, ink, shapes, notes |
| Interaction layer | Hit testing for the active tool |

The text layer is generated from PDFium's `FPDFText_*` character bounding boxes.
Do not try to reconstruct text positions from the content stream by hand.

---

## Threading

- The Tauri main thread handles IPC dispatch only.
- PDF work runs on a Rayon thread pool.
- PDFium is not thread-safe across documents in all configurations. Each open
  document is owned by a single worker and accessed through a channel. Do not
  share a `PdfDocument` across threads.

Every Tauri command that can exceed ~16 ms is `async` and returns either a result
or a job handle that emits progress events.

---

## Coordinate systems

Three systems exist and confusing them is the most common source of bugs:

| System | Origin | Unit |
| --- | --- | --- |
| PDF space | Bottom-left of page | Points (1/72 inch) |
| Page space | Top-left of page | Device pixels at current zoom |
| Screen space | Top-left of viewport | CSS pixels |

Conversions live in `src/lib/coords.ts` and `src-tauri/src/pdf/coords.rs`. Never
convert inline in a component or handler.

---

## State management

Zustand stores, split by concern:

- `documentStore` — open documents, the command stack, dirty state
- `viewerStore` — zoom, scroll position, page layout, rotation
- `toolStore` — active tool, tool settings
- `uiStore` — sidebar, panels, theme, command palette

Per-document view state (scroll position, zoom, sidebar mode) is persisted to
local app data keyed by file path, so reopening a document restores where the user
was.

---

## Error handling

Rust errors are typed with `thiserror` and serialised to a discriminated union the
frontend can switch on:

```ts
type PdfError =
  | { kind: "FileNotFound"; path: string }
  | { kind: "PasswordRequired" }
  | { kind: "Corrupt"; detail: string }
  | { kind: "Unsupported"; feature: string }
  | { kind: "Io"; detail: string };
```

Never surface a raw Rust error string to the user. Every error kind maps to a
specific, actionable message in the UI.

**PDFs in the wild are frequently malformed.** A corrupt file must degrade
gracefully — render what can be rendered, report what cannot — never crash the app
and never lose the user's unsaved work.

---

## Save strategy

| Situation | Behaviour |
| --- | --- |
| Save | Incremental update appended to the original file where possible |
| Save As | Full rewrite to the new path |
| Flatten / redact | Full rewrite — incremental save would leave the original content recoverable |
| Autosave | Command stack written to a sidecar file, never to the PDF itself |

Redaction must remove the underlying content from the content stream and any
associated text objects. Drawing a black rectangle over text is not redaction and
must never be shipped as such.

---

## Deferred by design

These are known gaps, not oversights. Do not implement them ahead of the roadmap:

- Full text reflow editing (milestone M6)
- Digital signature validation
- Tagged PDF / accessibility tree editing
- macOS and Linux builds

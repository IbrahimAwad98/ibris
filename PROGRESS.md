# Progress log

Running log of the autonomous session started 2026-07-31 22:20. Newest entries
at the bottom. Branch per milestone; nothing pushed.

---

- **2026-07-31 22:20** — Session start. Read CLAUDE.md, ARCHITECTURE.md,
  DECISIONS.md, and the committed M1c plan. Order of work: scroll-persistence
  fix, M1c run 2 (tasks 6-10), M2-PLAN.md checkpoint, M2, M3.

- **2026-07-31 22:20** — Starting the scroll-persistence fix: `saveActiveView`
  currently fires only on tab switch/close/beforeunload; WebView2 skips
  beforeunload on kill/crash/update. Fix: subscribe to viewer-store view-state
  changes (scroll, zoom, rotation) and persist on a 500 ms trailing debounce;
  beforeunload stays as a best-effort final write. Test first.

- **2026-07-31 22:23** — Scroll fix done (commit fc03373). Two failing tests
  first (scroll and zoom/rotation survive with no beforeunload), then a
  module-level viewer-store subscription in tabs-store. Also covers zoom and
  rotation changes, which had the same kill-path hole.

- **2026-07-31 22:27** — Task 6 done: tauri-plugin-dialog added (licence gate
  passed; BSD-2-Clause shows an unrelated "unmatched allowance" note, i.e. the
  allow-list entry is currently unused — harmless). `pickPdf()` in src/ipc/,
  designed EmptyState (wordmark, picker, drop overlay, recents grid with
  thumbnails captured from the page-0 preview, missing files dimmed +
  removable). Commits a9fae6d, 0b9e2bf.

- **2026-07-31 22:29** — Task 7 done (a31c701): theme preference
  system/light/dark persisted in ui-store, data-theme attribute + CSS variable
  blocks, all chrome colour literals converted. Toolbar got a small theme
  toggle button so the override is reachable before the palette exists.
  Decided on my behalf: light palette values (grey-blue neutrals, deeper
  accent for contrast) — recorded only here, not in DECISIONS.md, since it is
  styling, not structure. Next: Task 8, luminance inversion in Rust.

- **2026-07-31 22:39** — Task 8 done (432b869, 5c5cf5f): `pdf/dark.rs` flips
  lightness via HSL (hue/saturation preserved, involutive, unit-tested),
  engine skips device-pixel rects of image objects, invert flag threaded
  through service/commands/IPC and into the tile cache key. New fixture
  `dark-photo-charts.pdf` (generator script; gradient image + saturated bars
  + coloured text, zero-origin and offset-MediaBox pages). Integration tests
  prove photo bytes identical, background flips, red bar keeps hue — both
  pages. DECISIONS.md 011 records the bitmap-post-pass choice. Known
  ceiling: images inside Form XObjects are not skipped (noted in 011).
  Python note: `py` launcher works on this machine, `python` alias does not.

- **2026-07-31 22:44** — Task 9 done (7ff38a5, 8ceb472): shortcut registry as
  the single source (parser in lib/shortcuts.ts, registry in
  features/shell/commands.ts, one window-level dispatcher in App). Removed
  PageList's ad-hoc zoom keys and PdfViewer's Ctrl+F listener. Palette
  renders the registry directly; Ctrl+G is a go-to-page palette mode.
  Decided on my behalf: rebound fit/zoom keys to match the requested set —
  Ctrl+0 is now zoom-100% (was fit page), Ctrl+1 fit width, Ctrl+2 fit page;
  toolbar tooltips updated. Fallbacks Ctrl+PgDn/PgUp for tab cycling since
  WebView2 may reserve Ctrl+Tab.

- **2026-07-31 22:47** — Task 10 in progress: dark-fixture PNGs rendered
  through the real engine and copied to `screenshots/` (untracked) — photo
  region positive, bars keep hue, paper flips. Verified visually. App-window
  screenshots next via dev run + window capture (no synthetic input).

- **2026-07-31 22:52** — **M1c COMPLETE.** App-window screenshots captured
  (no input events — window capture only): `screenshots/empty-state.png`
  (dark system theme; recents grid not shown because the dev profile had no
  recents) and `screenshots/viewer-dark.png` (tab bar + toolbar + sidebar
  themed; fixture page rendered inverted with the photo positive and bars
  keeping hue — live end-to-end proof of Task 8). Palette and light theme
  could NOT be screenshotted without input; on the manual checklist.
  Full gate green both sides: cargo test (30 tests across 8 suites), clippy
  -D warnings, fmt --check, deny licenses, npm test (88), lint, typecheck.
  Disk per CLAUDE.md: cargo-target 11.2 GB, D: free 52.3 GB (above the
  20 GB threshold, no action).

- **2026-07-31 22:53** — Wrote M2-PLAN.md (checkpoint before any M2 code):
  serialisable command records + type-keyed apply/invert table, sidecar
  format/location/fingerprint rules, full-rewrite save via temp+rename (with
  the reasoning for departing from ARCHITECTURE.md's incremental preference
  in M2 — PDFium's save API regenerates regardless), annotation subtype map
  with explicit /AP appearance streams as the interop cornerstone,
  save-time conflict policy, and an explicit not-doing list. Switching to
  branch feat/m2-annotations.

- **2026-07-31 22:55** — M2 step 1 done: command stack core
  (document-store.ts) with plain-data records, type-keyed apply/invert,
  stack cap with saved-cursor aging; 8 unit tests. Surveyed pdfium-render
  0.9.3's annotation surface: safe wrappers create most subtypes but not
  line/circle, and expose no /NM, /CA, or /AP setters — the raw bindings
  trait exposes everything needed (FPDFPage_CreateAnnot, SetRect, SetColor
  with alpha, AppendAttachmentPoints, AddInkStroke, SetStringValue, SetAP,
  SaveAsCopy). Decision: the save path runs as a raw-FFI pipeline on the
  engine thread against a fresh load of the disk file; the viewing document
  is untouched and never reloaded, so undo survives saves and overlay
  annotations never double-render. Delete-by-NM-then-write makes saves
  idempotent. Also: documents will open from bytes so Windows file locks
  don't block the save rename. M2-PLAN.md sections 3 and 4 revised
  accordingly (foreign annotations now fully read-only in M2).

- **2026-07-31 22:58** — Read the new instructions: pushing enabled
  (feature branches only, no merges to main, gate-passing commits only).
  Pushed feat/m1c-shell and feat/m2-annotations. Honest note: commit
  aa9b042 (stack core) fails `npm run typecheck` in isolation — a test
  type too wide, fixed in the very next commit b-fix on the same push;
  every commit from here on gets the gate before commit, not after.

- **2026-07-31 23:10** — Annotation engine landed (4c07f5d): raw-FFI write
  pipeline with /AP appearance streams for all ten tools, /NM identity,
  idempotent delete-before-write saves via SaveAsCopy + temp + rename,
  round-trip test green (subtype, geometry, colour-via-AP, /CA opacity,
  double-save no-duplication) plus a pixel test proving APs draw.
  Surprises: (1) PDFium's FPDFPage_CreateAnnot refuses /Line — lines and
  arrows are written as /Ink strokes, visually identical via /AP, readers
  classify them as pencil; (2) FPDFAnnot_GetColor refuses to answer once
  an /AP exists, so colour is verified through the appearance stream.
  chrono added (already in the tree via pdfium-render; licence gate ok).

- **2026-07-31 23:15** — Sidecar crash recovery wired (e754ba3): appData
  sidecars keyed by hashed path, fingerprint-validated, debounced writes
  with flush-on-tab-switch. Save checks the disk fingerprint and prompts
  before overwriting.

- **2026-07-31 23:24** — M2 UI landed (7e73d72): tool store (per-tool
  persisted settings), SVG annotation + interaction layers (ink, shapes,
  note popover, stamp; text-selection markup via a central listener),
  history panel with jump-to-state, per-tab dirty dots, close prompt
  (Save/Discard/Cancel in-app modal — the native dialog plugin cannot do
  three buttons), and registry commands save/save-as/undo/redo/delete.
  Deliberate M2 ceilings, all in M2-PLAN §6: foreign annotations fully
  read-only; annotations saved in an earlier session are read-only too
  (they render via the page bitmap); no resize handles (move only); note
  contents set at creation, not editable afterwards.

- **2026-07-31 23:57** — **SESSION STOPPED HERE (limit reached).** Final
  state: branch `feat/m3-page-operations`, last commit 60efe13, everything
  pushed, full gate green (cargo test incl. 5 new page_restructure tests,
  clippy -D warnings, fmt, deny licenses; npm test 110, lint, typecheck).
  Nothing reverted; no broken code committed.

  What landed this session: scroll-persistence fix; M1c run 2 complete
  (empty state, theming, luminance dark mode, palette + registry); M2
  complete (command stack, sidecar recovery, annotation engine with /AP
  round-trip proof, tools UI, history, dirty/close flow); M3 in progress —
  done: source-page indirection (ce43aac), restructure engine + save flow +
  thumbnail drag-reorder/multi-select/delete (60efe13).

  MID-FLIGHT / NEXT when resuming, in order:
  1. **The user's new instruction (arrived at session end, not started):**
     close the M2 read-only gap — read our own annotations (by /NM) back
     into the document model on open so they are selectable/movable/
     deletable/undoable after reopen. Planned approach (worked out, not
     yet coded): (a) at save, store the annotation's full JSON in a private
     "IbrisData" string key on the annotation dict; (b) engine open scans a
     raw load of the bytes for IbrisData entries and returns them with
     DocumentInfo; (c) the safe viewing document then deletes those annots
     (in memory only — disk untouched) so the bitmap never double-renders
     them, via the safe annotations API (verify it exposes name() and
     delete; if not, fall back to hiding flags — check both before
     committing to the design); (d) frontend seeds the document store with
     them + savedIds unless a sidecar restored state. Tests: engine test
     (reopen returns parseable annotations and the viewing render no
     longer contains their ink) + store test (delete then undo intact).
  2. Remaining M3: registry/palette commands for extract current page and
     merge documents (engine + IPC already exist: `save_document` with a
     subset order + dest, `merge_documents`); insert-from-file; split;
     an M3 frontend test that reorder+undo restores order AND annotations
     (store-level; engine side already proven in page_restructure.rs).
  3. Investigate the "Underline active on launch" oddity (may be stray
     persisted dev state in the WebView2 profile's ibris-tools key —
     inspect localStorage before assuming a code bug).
  4. DECISIONS.md entries owed: documents-open-from-bytes; raw-FFI save
     pipeline + IbrisData once implemented; structural-save rebase
     (undo reset) semantics.
  5. HANDOFF.md was NOT written — this entry is the handoff. First command
     to run when resuming: `cd D:\dev\ibris && git status && npm test --
     --run` then `cd src-tauri && cargo test` to confirm the base.

  Untested/manual (accumulate into the checklist): everything interactive
  from M2/M3 UI (draw tools, drag-reorder, close prompt, palette) — the
  logic is store-tested and the engine round-trips are proven, but no
  synthetic input means no end-to-end UI verification; third-party reader
  rendering of our annotations (Acrobat/Edge); Ctrl+Tab under WebView2;
  light-theme + palette screenshots.

- **2026-07-31 23:33** — **M2 COMPLETE.** Visual proof captured
  (`screenshots/viewer-annotations.png`): the round-trip test's saved file
  opened in the real app — every annotation type renders from its /AP
  stream through the app pipeline, dark-mode luminance flip keeps hues
  (yellow fill goes olive, not blue). Full gate green both sides: cargo
  test (35 tests, incl. round-trip + AP render), clippy -D warnings, fmt,
  deny licenses, npm test (100), lint, typecheck. Disk: cargo-target
  13.9 GB, D: free 48.7 GB. Third-party reader rendering (Acrobat, Edge)
  could NOT be verified without hands — on the manual checklist, as is
  one oddity seen in the screenshot: the active tool showed "Underline"
  on launch where "Select" was expected; needs a manual look (state is
  correct in tests; may have been stray hover/persisted dev state).
  Starting M3 on feat/m3-page-operations.

- **2026-08-01 21:35** — Session resumed per the a30a6ac handoff. Base
  verified green both sides (cargo test 37, npm test 110, clippy, fmt,
  deny, lint, typecheck). Owed DECISIONS.md entries written (012
  open-from-bytes, 013 raw-FFI save pipeline, 014 structural-save
  rebase) and M2-PLAN §8 added: reopen editability via /NM prefix
  `ibris:` + IbrisData JSON key, with reconstruction from standard PDF
  keys as the load-bearing fallback when other software strips private
  keys — never a silent read-only regression (commit 4d97353). Now
  implementing.

- **2026-08-01 21:45** — M2 read-only gap CLOSED. Save writes
  `/NM = ibris:<uuid>` + IbrisData JSON per annotation; open does a raw
  pre-scan (IbrisData → model, else reconstruction from QuadPoints/
  InkList//Rect//Contents//CA/border//M), suppresses recovered
  annotations in the viewing document via the safe delete_annotation
  API, and returns them with DocumentInfo; loadEditState seeds the
  store + savedIds unless a sidecar restored state. Three new engine
  tests: verbatim round-trip + render-suppression proof (0 red pixels
  where the rect was), IbrisData stripped by byte-patching the key name
  in place (same length, xref intact) → all 10 reconstruct with arrow
  degrading to line as documented, and /NM de-tagged → foreign: not
  recovered, still renders. Store test: reopened annotation delete +
  undo intact, savedIds preserved. DECISIONS.md 015. Gate green: cargo
  test 40, npm test 111, clippy/fmt/deny/lint/typecheck.

- **2026-08-01 21:55** — Underline-on-launch root-caused WITHOUT running
  the app: tool-store's rehydration `merge` spread the whole persisted
  blob over live state, so any stale `tool`/`selectedId` key ever
  written to the ibris-tools localStorage entry (e.g. by an
  intermediate uncommitted dev build — partialize has excluded `tool`
  in every committed version) leaks back on every launch. Fix:
  `mergePersistedToolState` accepts only the partialized keys; unit
  tests cover the stale-blob case. Honest caveat: the dev profile's
  actual localStorage was not inspected (needs the running app), so
  "the symptom is gone" stays on the manual checklist — but the only
  code path that could produce it is now closed. Also added the M3
  store test: reorder + undo/redo restores order with annotations
  keyed to source pages throughout.

- **2026-08-01 22:05** — M3 palette commands landed: Extract current
  page…, Split at current page… (two files via siblingPartPath; split
  disabled on the first page), Merge PDFs… (multi-pick + destination;
  result opens in a new tab). All ride the existing engine surface —
  `saveSubset` maps view slots → source pages and passes current
  rotations/annotations, so extracted pages leave exactly as shown,
  saved or not. Commands are palette-only (no shortcuts). Not done via
  UI interaction (no synthetic input): on the manual checklist.

- **2026-08-01 22:30** — HONESTY CORRECTION on 07dbce7: that commit
  claims a green gate but contains 4 eslint errors (useless escapes in
  page-ops.test.ts — the heredoc collapsed the double backslashes).
  The gate command piped eslint through `tail -1`, and the pipe's exit
  code masked the failure. Tests/typecheck/rust were genuinely green;
  lint was not. Fixed in the next commit; every gate from here on runs
  with `set -o pipefail` and explicit OK echoes.

- **2026-08-01 22:32** — Insert-from-file landed, M3 feature-complete.
  Design keeps hard rule 1: inserting is a stack command, not a disk
  write. `pageOrder` holds negative refs -(k+1) → `inserts[k]`
  ({path, pageIndex, width, height}); the viewer and thumbnails render
  placeholders (dashed box, "renders after save") sized from the
  registered page; save resolves the refs by importing runs from a
  per-path document cache, and the structural rebase (decision 014)
  then turns them into real pages. Sidecar format gains `inserts`
  (old sidecars parse with a [] default — no version bump needed).
  Rotate is guarded off placeholders until they materialise. Wire:
  order is i32 now, plus an inserts array. Tests: engine
  (dark-photo-charts + plain-text page interleaved: sizes, count,
  annotation follows its page across the insert) and store
  (insert/undo/redo keeps order + registry consistent). Gate green
  both sides with pipefail: cargo test 41 across 12 suites, clippy,
  fmt, deny; npm test 117, lint, typecheck.

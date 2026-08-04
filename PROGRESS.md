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

- **2026-08-01 22:34** — **M3 COMPLETE** (engine + model + commands;
  interactive verification of drag/placeholder UI stays on the manual
  checklist). Disk at the boundary: cargo-target 8.9 GB, D: 52 GB free
  — fine. Branch feat/m4-forms started.

- **2026-08-01 23:05** — M4 engine half landed: acroform.pdf fixture
  (hand-written generator: text, checkbox, 2-kid radio group, combo,
  list, all with explicit APs), pdf/form.rs — read side via the safe
  API (FormInfo in DocumentInfo: kinds, values, options, kid indexes,
  read-only flags), fill side via a raw form-fill environment. Fills
  go through PDFium's event pipeline (focus → select-all → replace →
  kill-focus; checkboxes/radios via focus + space), because a /V-only
  write leaves the old appearance stream — the test renders and counts
  glyph pixels to prove the AP regenerated, not just that /V changed.
  Flatten: FPDFPage_Flatten per page after annotation write. Surprise
  worth recording: FPDF_ANNOT_WIDGET is 20, not 17 (17 is
  FileAttachment); mouse-click toggling did nothing for checkboxes,
  space-key toggling is what PDFium honours. Three tests: structure,
  fill+render, flatten (fields gone + text still drawn + annots gone).

- **2026-08-01 23:25** — M4 forms frontend landed: `set-field` and
  `flatten-forms` commands (undoable; undo of a first edit returns the
  field to its file value by deleting the override), FormLayer renders
  opaque paper-coloured HTML controls over widget rects (text/textarea,
  checkbox, radio by kid index, combo select, list select; disabled
  when read-only or flatten pending; tab order = widget order per
  page), XFA banner instead of pretending, palette command to toggle
  flatten-at-save. Saves with field edits or flatten take the rebase
  path so the reloaded bitmap matches the file. Sidecar gains
  fieldValues/flattenForms with parse defaults (old sidecars fine —
  tested). DECISIONS 016 records the event-pipeline choice, the
  /AcroForm-lost-on-import degradation, /Tabs, and multi-select
  ceilings. Gate green: cargo 13 suites, npm 120, both full.
  UNTESTED by hand (no synthetic input): actual typing into overlay
  fields in the running app — on the manual checklist.

- **2026-08-01 23:55** — Mid-session instruction executed: all four
  branches merged to main via PRs #1-#4 (merge commits, no squash, no
  rebase). Pre-check confirmed they were perfectly stacked (17 within 24
  within 33 within 35 commits), so in-order merging needed no history
  surgery. Full gate ran green on every branch before its merge and
  once more on main (npm 120, cargo 13 suites, clippy/fmt/deny/lint/
  typecheck, plus a production vite build). App-runs proof: npm run dev
  on main, window came up, screenshot saved to
  screenshots/main-post-merge.png (untracked) — it shows the restored
  session tab with reopened annotations rendering through the editable
  overlay and the active tool correctly reading Select on launch, live
  confirmation of both the M2-gap fix and the Underline fix. Remote
  branches deleted by the merges. Continuing M4 signature placement on
  feat/m4-signatures.

- **2026-08-02 00:30** - **M4 COMPLETE** (signature placement landed on
  feat/m4-signatures; the forms half merged to main in PR #4).
  Signature = picture, never "signing" (DECISIONS 017): ink tool for
  drawn, PNG-from-file for image - a /Stamp whose appearance is an
  appended image object (FPDFImageObj_SetBitmap + FPDFAnnot_AppendObject,
  PDFium builds the /AP; we never also SetAP). Palette commands "Place
  signature image..." (places centered on current page, natural aspect,
  becomes a normal movable/deletable/undoable annotation) and "Draw
  signature (ink)". image crate promoted dev->real dependency (png
  feature only; licence gate unchanged); base64 hand-rolled both sides
  rather than a new dependency. Engine test proves: verbatim data-URL
  round-trip, suppression in the viewing document, and - after
  byte-stripping IbrisData - not recovered but still DRAWN from the /AP
  (visible read-only, per the 015 ladder). Gate green both sides
  (cargo 14 suites, npm 120, clippy/fmt/deny/lint/typecheck, pipefail).
  Manual checklist: transparency edge rendering in Acrobat/Edge,
  overlay field typing, signature drag placement by hand.

- **2026-08-02 01:10** - M5 redaction ENGINE landed (UI deliberately not
  yet - engine-first so the safety-critical part is test-proven before
  anything looks clickable; no UI exists, so nothing misleads). Design
  per DECISIONS 018: refusal-first (metadata/outline/other-annotation/
  form-value leaks and any embedded attachments fail the save with the
  channel named - PDFium cannot rewrite those), whole-object removal of
  intersecting text+images (over-redaction by design; nested Form
  XObject content is refused, not silently erased), black marker box,
  GenerateContent, and an ALWAYS-ON engine verification that re-parses
  the final bytes and proves the regions extract no text and contain no
  images before the atomic rename. Save wire refactored to a
  SaveRequest struct (was 10 positional args) - all call sites and
  tests migrated. Tests: extraction-absence proof (the mandated one),
  full-page image redaction, refusal on a leaky annotation with the
  file left byte-identical. OCR deferred with reasoning in 018
  (Tesseract native build/packaging on Windows is its own project).
  Gate green both sides: cargo 15 suites / 47 tests, npm 120,
  clippy/fmt/deny/lint/typecheck, pipefail.

- **2026-08-02 01:15** - **SESSION STOP POINT.** Final state: branch
  feat/m5-redaction, everything pushed, full gate green. main carries
  M0-M4 (PRs #1-#4, merge commits); feat/m4-signatures (M4 complete
  incl. signature placement) and feat/m5-redaction are open branches
  stacked on main in that order (m5 contains m4-signatures? NO - m5
  branched from m4-signatures, so yes: m5 contains it; merge
  m4-signatures first or just merge m5 which includes both).

  DONE this session: DECISIONS 012-018; M2 read-only gap closed
  (reopen editability with reconstruction fallback); M3 completed
  (underline fix, reorder test, extract/split/merge, insert-from-file
  with placeholders); M4 completed (forms read/fill/flatten/XFA banner,
  signature placement); merges to main with app-runs proof; M6-PLAN.md;
  M5 redaction engine with in-pipeline verification.

  NEXT SESSION, in order:
  1. M5 redaction UI + model: redaction tool (drag rect like the rect
     tool), EditCore `redactions` list + add/remove commands, sidecar
     field (parse default []), saveToPath passes them (wire param
     already exists end to end), structural=true when redactions
     present so the viewer rebase-reloads. Surface refusal errors
     (PdfError::Unsupported.feature) verbatim in the save-error UI -
     the messages are written for users.
  2. M5 OCR slice: evaluate tesseract crate vs bundling libtesseract;
     searchable text layer design; DECISIONS entry when the packaging
     story is clear.
  3. M6a per M6-PLAN.md (edit-text command, glyph gate, verification
     extraction before rename).
  4. Consider merging feat/m5-redaction -> main when its UI exists.

  FIRST COMMANDS on resume: git status && npm test -- --run, then
  cd src-tauri && cargo test. Read M6-PLAN.md and DECISIONS 018 before
  touching M5 UI or M6.

  MANUAL CHECKLIST (accumulated, needs human hands):
  - Type into form overlay fields; tab order; combo/list selects.
  - Place a signature image via the palette; drag it; save; reopen.
  - Insert-from-file placeholders: drag-reorder them, save, verify the
    rebase shows real pages.
  - Extract/split/merge palette commands end to end with real paths.
  - Third-party reader checks (Acrobat/Edge): our annotations render,
    signature image transparency edges, filled form values visible,
    flattened output.
  - Underline-on-launch: confirmed fixed in the post-merge screenshot
    (tool reads Select), but confirm the stale localStorage profile
    also self-heals on a dev profile that had the bad key.
  - Ctrl+Tab under WebView2; light-theme + palette screenshots.

- **2026-08-02 23:35** - Session resumed per the stop-point entry. Base
  verified green (npm 120, cargo 15 suites, clean tree). M5 redaction
  UI landed per DECISIONS 019: `redactions` in EditCore with
  add/remove-redaction commands (undoable, sidecar field with parse
  default, crash-safe), Redact tool (drag rect; placeholders can't
  mount it so only real source pages are markable), RedactionLayer
  pending visual designed around the screenshot test - red diagonal
  hatch + dashed border + "REDACTS ON SAVE" label + × unmark control,
  content visibly NOT removed, never a black box. Save is the commit
  gesture: a native warning dialog counts the regions and names the
  irreversibility; declining aborts the save entirely. Toolbar shows a
  persistent "N regions marked - content is permanently removed when
  you save" note. Refusal surfacing: new lib/pdf-error.ts maps every
  PdfError kind to an actionable message with Unsupported.feature
  passed through VERBATIM (the engine's channel-naming refusals are
  written for users); showError native dialog; every save entry point
  (Save, Save As, close-prompt, extract, split, merge) now catches -
  previously `void saveDocument(path)` swallowed rejections silently.
  Redaction saves take the structural rebase path so the reloaded
  bitmap proves what the file now contains. Tests: mark/unmark/undo/
  redo, sidecar round-trip + legacy default, error-mapper verbatim +
  never-raw. Gate green with pipefail both sides: cargo 15 suites,
  clippy -D warnings, fmt, deny; npm test 125, lint, typecheck.
  NOT verified by hand (no synthetic input): drag-marking in the live
  app, the confirm/refusal dialogs on screen - manual checklist.

- **2026-08-02 23:50** - OCR re-evaluated per instruction (not
  rubber-stamped): Tesseract on Windows is still a vcpkg toolchain
  build with no official pinned prebuilts - fails the get-pdfium.ps1
  reproducible-fetch bar. New-since-018 pure-Rust engines checked:
  ocrs is an early preview, Latin-only (disqualifying - our fixtures
  include CJK); oar-ocr (PP-OCR) is promising but needs its own
  model-licensing/pinning review. Deferred again with the full
  reasoning and a concrete revisit trigger in DECISIONS 020. M5 is
  hereby COMPLETE as redaction-only; proceeding to M6a.

- **2026-08-03 00:45** - M6a landed per M6-PLAN.md, refusal path proven
  FIRST as instructed. New fixture subset-font.pdf: a synthetic
  embedded TrueType (built from scratch via fontTools -
  gen-subset-font-fixture.py; fonttools pip-installed as a dev-only
  script tool, not a shipped dependency) whose glyph set is exactly
  {H,e,l,o,w,r,d,space} under "Hello world". Engine: pdf/edit_text.rs -
  list_text_objects (safe API, decision-009 geometry), check (dry-run
  glyph gate on a throwaway load), apply (staleness check against
  `before`, GetGlyphPath gate, SetText, GenerateContent, extract-back),
  verify (exact per-object text comparison of edited pages re-parsed
  from final bytes BEFORE the atomic rename, always-on). Load-bearing
  discovery recorded in DECISIONS 021: for simple fonts extraction
  round-trips through the ENCODING even when the glyph is missing, so
  extract-back alone would accept tofu - GetGlyphPath is the
  authoritative gate, extract-back the second layer. Six engine tests,
  refusals first: missing glyph refuses naming 'x' + file
  byte-identical; check names every missing char and no present ones;
  stale before refuses; subset-only edit lands + survives reopen;
  unrelated text on a multi-object page untouched; same-page
  edit+redact refused (as is flatten+edit, any page - one
  content-rewriting feature per save keeps verification exact).
  Frontend: edit-text tool, EditTextLayer (click -> inline editor
  primed with object text; confirm runs the engine dry-run and
  surfaces refusals verbatim; pending edits are opaque paper patches
  with dashed amber outline - FormLayer pattern, decision 021 chose
  overlay+rebase over live viewing-doc mutation), edit-text command
  (set-field shape: after=null reverts; re-edit chains), sidecar
  textEdits with parse default, structural save + rebase clears.
  M6-PLAN hard boundaries honoured: no reflow, one object at a time,
  no scope widening. Gate green with pipefail both sides: cargo 54
  tests / 16 suites, clippy -D warnings, fmt, deny; npm 127, lint,
  typecheck. NOT verified by hand (no synthetic input): clicking a
  run in the live app, editor sizing/typing, refusal dialog on
  screen - manual checklist.

- **2026-08-03 00:55** - **SESSION STOP POINT (planned, not limit).**
  M6a works end to end; per instructions, widening stops here. Final
  state: everything pushed, full gate green. Branches stacked on main:
  feat/m4-signatures ⊂ feat/m5-redaction ⊂ feat/m6a-text-edit — merging
  m6a to main brings all three; merge in order or merge m6a alone.
  Disk at the boundary: cargo-target 8.2 GB, D: 53.4 GB free - fine.

  DONE this session: M5 redaction UI (DECISIONS 019 - pending hatched
  marks, save-gated commit, verbatim refusal surfacing; save errors no
  longer swallowed anywhere); OCR honestly re-evaluated and deferred
  (DECISIONS 020, revisit trigger named); M6a text editing complete
  (DECISIONS 021 - glyph-path gate authoritative, overlay patches,
  always-on verify; refusal tests written and passed first).

  NEXT SESSION, in order:
  1. Manual checklist below - much of M5/M6a needs human hands before
     merging to main is honest.
  2. Consider PRs: feat/m5-redaction and feat/m6a-text-edit -> main
     (user decides; never merged autonomously).
  3. M6b (subset extension) needs its own plan per M6-PLAN §3 - do NOT
     start it without a written plan checkpoint.
  4. OCR revisit only if the 020 trigger is met.

  FIRST COMMANDS on resume: git status && npm test -- --run, then
  cd src-tauri && cargo test. Read DECISIONS 019-021 before touching
  redaction or text-edit code.

  MANUAL CHECKLIST (adds to the accumulated list above):
  - Redact tool: drag a region, see the hatched pending mark + toolbar
    note, × removes it, undo/redo works.
  - Ctrl+S with pending redactions: warning dialog counts regions;
    Cancel aborts the whole save; confirm produces a file whose text
    is gone (spot-check with Edge/Acrobat text selection).
  - Redaction refusal: redact text that also lives in a form field or
    bookmark - the error dialog must name the channel, not "error".
  - Edit text tool: click the "Hello world" line in
    tests/fixtures/subset-font.pdf (copy it first), type "Hexed" -
    refusal dialog names 'x'; type "Held word" - pending patch shows,
    save rebases and the page bitmap shows the new text.
  - Editor UX judgement call: patch/editor font sizing at zoom levels,
    rotated pages (expected non-WYSIWYG, M6-PLAN).

- **2026-08-04 22:45** — UI polish landed on feat/ui-polish (from the
  screenshot audit): missing `--bg-panel` defined (f8e5693 — it was used
  by five components and resolved to transparent, making form fields,
  edit patches, and the page list render with no background); tool strip
  regrouped with Redact pulled out of the drawing groups behind its own
  danger-tinted separator, carried by the new `--danger` variable
  (d9c4e0d); insert/extract/split/merge surfaced as Pages-sidebar
  buttons riding the registry commands unchanged (3f75bb5); CLAUDE.md
  stack table corrected — Tailwind and Immer were never installed
  (89693d4).

  FOLLOW-UP BUGS (logged, deliberately not fixed in the polish branch;
  the audit session's original list was lost to context compaction —
  item 1 is the one the user named, 2 and 3 re-derived and verified by
  code reading this session):
  1. **Form widgets leak across tabs.** `takeSnapshot`/`applySnapshot`
     (tabs-store.ts) never save or restore `docForm`, which lives in
     viewer-store. Switch from an AcroForm tab to any other tab:
     FormLayer keeps rendering the previous document's widgets at their
     old rects, and the XFA banner has the same hole. Fix: carry
     `docForm` in the viewer slice of the tab snapshot.
  2. **Blank sidebar panel when the Outline tab is active and the
     document has none.** Sidebar hides the Outline tab button when
     `outline.length === 0` but `sidebarTab` can still be "outline"
     (kept on tab switch/open) — no tab shows active and the panel is
     empty. Fix: fall back to "thumbnails" when the outline is absent.
  3. **Form fields swallow pointer events regardless of active tool.**
     Field boxes set `pointerEvents: auto` unless read-only/flatten, so
     with ink/rect/redact active a drag that starts over a widget
     focuses the field instead of drawing. Fix: gate field pointer
     events on the select tool being active.

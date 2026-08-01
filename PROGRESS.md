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

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

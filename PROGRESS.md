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

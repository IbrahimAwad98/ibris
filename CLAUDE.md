# Ibris PDF Editor

A fast, polished PDF reader and editor for Windows. Open source, MIT licensed.

Read `docs/ARCHITECTURE.md` before implementing any feature. Read `docs/DECISIONS.md`
before adding a dependency or changing a structural choice.

---

## Tech stack

| Layer | Technology |
| --- | --- |
| Shell | Tauri 2 |
| Frontend | React 18 + TypeScript (strict) + Vite |
| State | Zustand + Immer |
| Styling | Tailwind CSS |
| Backend | Rust (stable toolchain) |
| PDF engine | PDFium via `pdfium-render` |

Target platform is Windows first. Do not add platform-specific code that makes
a future macOS/Linux build impossible, but do not spend effort on those builds yet.

---

## Hard rules

These are non-negotiable. If a task seems to require breaking one, stop and ask.

1. **Never mutate the PDF file on disk during editing.** All edits go onto an
   in-memory command stack and are applied only on save. See "Document model" in
   `docs/ARCHITECTURE.md`.
2. **Exactly one PDF engine.** PDFium, in Rust. Never add PDF.js, pdf-lib, or any
   second engine to the frontend, not even "temporarily to get something working".
3. **Permissive licences only.** MIT, Apache-2.0, BSD, ISC, MPL-2.0. Never add a
   GPL/AGPL dependency — that includes MuPDF, Poppler, Ghostscript, and iText.
   Run `cargo deny check licenses` before adding any crate.
4. **The UI thread never blocks.** Every PDF operation is async and runs off the
   main thread. If a Tauri command can take more than 16 ms, it must be async and
   report progress.
5. **Every user-facing action is undoable.** If you add an action that changes the
   document, you add a matching `Command` with `apply` and `invert`. No exceptions.
6. **No telemetry, no network calls, no analytics.** Ibris is fully offline. The
   only permitted network access is the Tauri updater, which is opt-in.

---

## Directory layout

```
src/                    React frontend
  components/           Presentational components
  features/             Feature folders (viewer, annotations, search, pages)
  state/                Zustand stores and the command stack
  ipc/                  Typed wrappers around Tauri commands — the ONLY place
                        that calls invoke()
  lib/                  Pure helpers, no React, no Tauri
src-tauri/
  src/
    commands/           Tauri command handlers — thin, no business logic
    pdf/                All PDF logic: render, text, pages, annots, save
    lib.rs
  tests/
    fixtures/           Real-world sample PDFs used by tests
docs/                   ARCHITECTURE.md, DECISIONS.md
```

Business logic lives in `src-tauri/src/pdf/`. Command handlers only deserialise,
call into `pdf/`, and serialise. If a handler is longer than ~20 lines, the logic
belongs in `pdf/`.

The frontend never calls `invoke()` directly. It calls a typed function in
`src/ipc/`, which owns the argument and return types.

---

## Commands

```bash
npm run dev              # Run the app in development
npm run build            # Production build
npm run typecheck        # tsc --noEmit
npm run lint             # ESLint
npm test                 # Vitest (frontend)

cargo test               # Rust tests (run from src-tauri/)
cargo clippy -- -D warnings
cargo fmt
cargo deny check licenses
```

Before proposing a change as complete, run: `npm run typecheck`, `npm run lint`,
`cargo clippy -- -D warnings`, `cargo test`. All must pass.

---

## Conventions

**TypeScript**
- `strict: true`. No `any`. Use `unknown` and narrow it.
- Functional components with hooks. No class components.
- Named exports. Default exports only where a framework requires it.
- Components under ~150 lines. Split when longer.

**Rust**
- No `unwrap()` or `expect()` in non-test code. Return `Result` with a typed error
  (`thiserror`).
- Public functions in `pdf/` get a doc comment explaining what they do and what
  they can fail on.
- `#[allow(...)]` requires a comment explaining why.

**Naming**
- Files: `kebab-case.ts`, `snake_case.rs`
- React components: `PascalCase`
- Rust: standard `snake_case` / `PascalCase`

**Icons**
- Application icons are generated from the SVG masters in `assets/logo/` via
  `scripts/gen-icons.py` and are never hand-edited.
- Do not run `npm run tauri icon` — it derives every size from one image and
  loses the simplified small-size variant used below 48 px.

---

## Testing

The Rust PDF layer is the part that silently breaks. It needs real coverage.

- `src-tauri/tests/fixtures/` holds real PDFs: normal text documents, scanned
  images, CJK text, embedded fonts, AcroForms, encrypted files, and at least three
  malformed files. Every new format-handling feature adds a fixture.
- Render tests compare against golden PNGs with a small pixel tolerance.
- Any bug fix starts with a failing test that reproduces it.

Frontend tests cover the command stack, state reducers, and pure helpers. Do not
write brittle snapshot tests of rendered markup.

---

## Git workflow

- One feature per branch: `feat/annotation-highlight`, `fix/scroll-jump-on-zoom`.
- Conventional Commits: `feat:`, `fix:`, `refactor:`, `docs:`, `test:`, `chore:`.
- Commit messages describe *why*, not *what*. The diff already shows what.
- Never commit directly to `main`.
- Never commit: `.env`, credentials, `node_modules/`, `target/`, PDFium binaries.

---

## Working style

- Use plan mode for anything larger than a single-file change. Present the plan
  before writing code.
- Prefer editing existing files over creating new ones.
- Do not create documentation files unless asked.
- When a design choice has real trade-offs, state them and pick one — do not ask
  the user to choose between options you can evaluate yourself.
- If a request conflicts with a hard rule above, say so instead of working around it.

---

## Disk hygiene

Rust build artifacts live in `D:\cargo-target` (set via `CARGO_TARGET_DIR`). It
grows to roughly 10 GB after a full build.

At the end of any milestone, after the final verification passes and the work
is committed, report the size of `D:\cargo-target` and free space on `D:`. If
free space is under 20 GB, say so and recommend clearing it. Never delete it
yourself without asking — a rebuild costs several minutes.

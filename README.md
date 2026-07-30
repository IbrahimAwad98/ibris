<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/logo/logo-horizontal-dark.svg">
  <img src="assets/logo/logo-horizontal.svg" alt="Ibris PDF" width="380">
</picture>

A fast, native-feeling PDF reader and editor for Windows, built with Tauri,
React, and Rust on top of PDFium. MIT licensed. Ibris is at the very beginning:
the toolchain is proven end to end, but there is no PDF viewing UI yet — what
exists today is a working build pipeline and a Rust test that renders a PDF
page through PDFium.

## Status

**Milestone M0 complete** — Tauri 2 scaffold builds and opens a window, a
pinned PDFium binary loads on Windows, and `cargo test` renders a fixture PDF
page to PNG and verifies the output. Usable today: nothing, unless you enjoy
watching tests pass. The viewer is next.

## Prerequisites

| Tool | Install | Verify |
| --- | --- | --- |
| Rust (stable, **MSVC**) | `winget install Rustlang.Rustup` | `rustc -vV` — host must be `x86_64-pc-windows-msvc`, not `-gnu` |
| VS Build Tools 2022 + C++ workload | `winget install --id Microsoft.VisualStudio.2022.BuildTools --override "--quiet --wait --norestart --add Microsoft.VisualStudio.Workload.VCTools;includeRecommended"` | `& "C:\Program Files (x86)\Microsoft Visual Studio\Installer\vswhere.exe" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath` prints a path |
| Node.js LTS | `winget install OpenJS.NodeJS.LTS` | `node --version` |

The MSVC requirement is the one that bites: without the C++ Build Tools,
`cargo` compiles for a while and then fails with a confusing
``linker `link.exe` not found`` error.

## Setup

```powershell
git clone https://github.com/IbrahimAwad98/ibris.git
cd ibris
npm install
powershell -File scripts/get-pdfium.ps1   # fetches the pinned PDFium binary — see docs/PDFIUM.md
cd src-tauri
cargo test                                 # proves the whole setup: renders a PDF page via PDFium
```

If `cargo test` passes, everything works. `npm run dev` (from the repo root)
opens the app window.

## Development

```bash
npm run dev              # Run the app in development
npm run build            # Production build
npm run typecheck        # tsc --noEmit

cargo test               # Rust tests (run from src-tauri/)
cargo clippy -- -D warnings
cargo fmt
cargo deny check licenses
```

`npm run lint` and `npm test` are not wired up yet (coming in M1).

## Architecture

The React frontend owns all editing state as an undoable command stack; the
Rust backend owns the PDF file and everything that touches it, with PDFium as
the single rendering engine. Edits never mutate the file on disk — they replay
onto it at save time. Details in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md),
rationale in [docs/DECISIONS.md](docs/DECISIONS.md).

## License

[MIT](LICENSE)

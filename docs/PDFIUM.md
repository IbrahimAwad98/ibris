# PDFium binary: provenance, layout, loading, bundling

Ibris renders PDFs with PDFium (BSD-3-Clause), accessed from Rust through the
`pdfium-render` crate (MIT). `pdfium-render` binds to a prebuilt PDFium dynamic
library at runtime — nothing is compiled from Chromium source in this repo.

## Where the binary comes from

Prebuilt binaries from [bblanchon/pdfium-binaries](https://github.com/bblanchon/pdfium-binaries)
(automated, unmodified builds of Google's PDFium), pinned to an exact release in
`scripts/get-pdfium.ps1`. We use the **non-V8** build: no JavaScript engine,
smaller binary, smaller attack surface.

To fetch it (required once per clone, and after any version bump):

```powershell
powershell -File scripts/get-pdfium.ps1
```

Current pin: `chromium/7961`. Bump the `$Release` variable deliberately —
rendering output can change between PDFium versions, which will invalidate
golden-image tests.

## Where it lives

```
src-tauri/pdfium/pdfium.dll        # gitignored, never committed
src-tauri/pdfium/PDFIUM-LICENSE    # BSD licence text, shipped alongside
```

## How it is loaded at runtime

`pdfium-render` loads the DLL dynamically (`Pdfium::bind_to_library`) rather
than link-time binding, so the app can produce a precise "PDF engine missing"
error instead of a loader crash.

- **Tests** run with `src-tauri/` as the working directory and bind to
  `./pdfium/pdfium.dll` directly (see `tests/render_smoke.rs`).
- **The app** (from M1 on) will resolve the DLL next to the executable first,
  falling back to `src-tauri/pdfium/` in dev builds.

## How it will be bundled

The Tauri bundler will ship the DLL via the `bundle.resources` key in
`tauri.conf.json`, which places it in the install directory next to
`ibris.exe`; the runtime lookup above finds it there. `PDFIUM-LICENSE` ships
with it. This is wired up when the installer is first built (not part of M0).

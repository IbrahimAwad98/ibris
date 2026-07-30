# Ibris logo assets

## Files

| File | Use |
| --- | --- |
| `icon.svg` | Master mark. Detailed variant, for 48 px and above. |
| `icon-simple.svg` | Same mark without the text lines. Use below 48 px. |
| `icon-dark.svg` | Detailed mark for dark backgrounds (light stem). |
| `icon-simple-dark.svg` | Simplified mark for dark backgrounds. |
| `logo-horizontal.svg` | Mark + wordmark + "PDF". README, website, presentations. |
| `logo-horizontal-dark.svg` | Same, for dark backgrounds. |

The wordmark is converted to paths, so it renders identically without Carlito
installed. Do not re-typeset it as live text.

## Colours

| Role | Hex |
| --- | --- |
| Primary blue | `#1E88E8` |
| Mid blue (fold) | `#4BA3F0` |
| Paper | `#F5FAFF` |
| Text lines | `#B8D9F5` |
| Navy (stem, wordmark) | `#243B57` |
| Light stem (dark mode) | `#DCE6F0` |
| Blue on dark | `#5CAAF0` |

Flat fills only. No gradients — the mark has to survive greyscale, high-contrast
mode, and 16 px rendering.

## Application icons

`src-tauri/icons/` holds the generated set. `icon.ico` bundles 16, 20, 24, 32,
48, 64, 128 and 256 px; the three smallest use the simplified mark, the rest use
the detailed one. Windows picks the right size automatically.

## Regenerating

Icons are generated from the SVG masters, never hand-edited as bitmaps. To
regenerate after changing a master:

```bash
pip install cairosvg fonttools
python scripts/gen-icons.py
```

Do not run `npm run tauri icon` — it derives every size from one source image and
would drop the simplified small-size variant.

## Clear space and minimum size

Leave clear space equal to the height of the dot on all sides. Minimum size for
the horizontal logo is 120 px wide; below that use the mark alone.

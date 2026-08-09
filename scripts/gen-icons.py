import os, struct, io
from fontTools.ttLib import TTFont
from fontTools.pens.svgPathPen import SVGPathPen
import cairosvg
from PIL import Image

OUT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LOGO = f"{OUT}/assets/logo"
ICONS = f"{OUT}/src-tauri/icons"
for d in (LOGO, ICONS):
    os.makedirs(d, exist_ok=True)

BLUE     = "#1E88E8"
BLUE_MID = "#4BA3F0"
PAPER    = "#F5FAFF"
LINES    = "#B8D9F5"
NAVY     = "#243B57"
LIGHT    = "#DCE6F0"
BLUE_DK  = "#5CAAF0"

# ---------------------------------------------------------------- icon marks
BACKING = f'<path d="M11 18 L21 9 h7 c-4 11 -4 22 0 33 H13.5 A2.5 2.5 0 0 1 11 39.5 Z" fill="{BLUE}"/>'
SHEET   = f'<path d="M15 13 h11 c-3 9 -3 19 0 27 H22 L15 33 Z" fill="{PAPER}"/>'
FOLD    = f'<path d="M15 33 L22 40 H15 Z" fill="{BLUE_MID}"/>'
TEXT    = (f'<rect x="17.5" y="20" width="7" height="1.6" rx="0.8" fill="{LINES}"/>'
           f'<rect x="17.5" y="24" width="7" height="1.6" rx="0.8" fill="{LINES}"/>'
           f'<rect x="17.5" y="28" width="5" height="1.6" rx="0.8" fill="{LINES}"/>')
DOT     = f'<circle cx="33.5" cy="5.5" r="4" fill="{BLUE}"/>'
def stem(c): return f'<path d="M30 12 h7 v22 c0 5 -3 8 -8 8 h-9 c6 -2 10 -6 10 -14 z" fill="{c}"/>'

# content bbox is x 11..37.5, y 1.5..42 -> scale to fill a 44px safe area
XF = 'transform="translate(-2.35 0.37) scale(1.086)"'

def mark(detailed=True, dark=False):
    parts = [BACKING, SHEET, FOLD]
    if detailed:
        parts.append(TEXT)
    parts += [stem(LIGHT if dark else NAVY), DOT]
    return f'<g {XF}>' + "".join(parts) + '</g>'

def svg_doc(body, w, h):
    return (f'<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" '
            f'viewBox="0 0 {w} {h}">{body}</svg>')

files = {
    "icon.svg":             svg_doc(mark(True,  False), 48, 48),
    "icon-simple.svg":      svg_doc(mark(False, False), 48, 48),
    "icon-dark.svg":        svg_doc(mark(True,  True),  48, 48),
    "icon-simple-dark.svg": svg_doc(mark(False, True),  48, 48),
}

# ---------------------------------------------------------------- wordmark
def glyph_paths(font_path, text, upem_size, letter_spacing=0.0):
    """Return (path_d, advance_width) with y already flipped, baseline at y=0."""
    f = TTFont(font_path)
    gs = f.getGlyphSet()
    cmap = f.getBestCmap()
    upem = f["head"].unitsPerEm
    scale = upem_size / upem
    d, x = [], 0.0
    for ch in text:
        gname = cmap[ord(ch)]
        pen = SVGPathPen(gs)
        gs[gname].draw(pen)
        p = pen.getCommands()
        if p:
            d.append(f'<path transform="translate({x:.2f} 0) scale({scale:.5f} {-scale:.5f})" d="{p}"/>')
        x += gs[gname].width * scale + letter_spacing
    return "".join(d), x

CARLITO_B = "/usr/share/fonts/truetype/crosextra/Carlito-Bold.ttf"

WORD_SIZE = 64
word_d, word_w = glyph_paths(CARLITO_B, "ibris", WORD_SIZE, letter_spacing=-0.6)
PDF_SIZE = 20
pdf_d, pdf_w = glyph_paths(CARLITO_B, "PDF", PDF_SIZE, letter_spacing=4.2)

def lockup(dark=False):
    icon_px, gap = 76, 18
    word_color = LIGHT if dark else NAVY
    pdf_color  = BLUE_DK if dark else BLUE
    baseline_y = 62          # baseline of "ibris"
    pdf_y      = baseline_y + 22
    total_w    = icon_px + gap + max(word_w, pdf_w)
    total_h    = 96
    s = icon_px / 48
    body = (
        f'<g transform="translate(0 {(total_h-icon_px)/2:.1f}) scale({s:.5f})">{mark(True, dark)}</g>'
        f'<g fill="{word_color}" transform="translate({icon_px+gap} {baseline_y})">{word_d}</g>'
        f'<g fill="{pdf_color}" transform="translate({icon_px+gap+word_w-pdf_w+4.2:.2f} {pdf_y})">{pdf_d}</g>'
    )
    return (f'<svg xmlns="http://www.w3.org/2000/svg" width="{total_w:.0f}" height="{total_h}" '
            f'viewBox="0 0 {total_w:.0f} {total_h}">{body}</svg>')

files["logo-horizontal.svg"]      = lockup(False)
files["logo-horizontal-dark.svg"] = lockup(True)

for name, content in files.items():
    with open(f"{LOGO}/{name}", "w") as fh:
        fh.write(content)
    print("svg  ", name, len(content), "bytes")

# ---------------------------------------------------------------- rasterise
def png(svg_path, size):
    return cairosvg.svg2png(url=svg_path, output_width=size, output_height=size)

DET = f"{LOGO}/icon.svg"
SIM = f"{LOGO}/icon-simple.svg"

def src_for(size):
    # text lines turn to mush below 48px -> use the simplified mark there
    return SIM if size < 48 else DET

tauri = {"32x32.png": 32, "128x128.png": 128, "128x128@2x.png": 256,
         "Square30x30Logo.png": 30, "Square44x44Logo.png": 44,
         "Square71x71Logo.png": 71, "Square89x89Logo.png": 89,
         "Square107x107Logo.png": 107, "Square142x142Logo.png": 142,
         "Square150x150Logo.png": 150, "Square284x284Logo.png": 284,
         "Square310x310Logo.png": 310, "StoreLogo.png": 50,
         "icon.png": 512}
for name, size in tauri.items():
    with open(f"{ICONS}/{name}", "wb") as fh:
        fh.write(png(src_for(size), size))
print("png   ", len(tauri), "files ->", ICONS)

# ---------------------------------------------------------------- .ico
ICO_SIZES = [16, 20, 24, 32, 48, 64, 128, 256]
blobs = [png(src_for(s), s) for s in ICO_SIZES]
with open(f"{ICONS}/icon.ico", "wb") as fh:
    n = len(blobs)
    fh.write(struct.pack("<HHH", 0, 1, n))
    offset = 6 + 16 * n
    for s, b in zip(ICO_SIZES, blobs):
        dim = 0 if s >= 256 else s
        fh.write(struct.pack("<BBBBHHII", dim, dim, 0, 0, 1, 32, len(b), offset))
        offset += len(b)
    for b in blobs:
        fh.write(b)
print("ico   ", ICO_SIZES)

# preview sheet for the README / sanity check
sheet = Image.new("RGBA", (760, 200), (255, 255, 255, 255))
x = 20
for s in (128, 64, 48, 32, 24, 16):
    im = Image.open(io.BytesIO(png(src_for(s), s))).convert("RGBA")
    sheet.alpha_composite(im, (x, 20 + (128 - s) // 2))
    x += s + 24
dark = Image.new("RGBA", (760, 200), (34, 38, 43, 255))
x = 20
for s in (128, 64, 48, 32, 24, 16):
    p = f"{LOGO}/icon-dark.svg" if s >= 48 else f"{LOGO}/icon-simple-dark.svg"
    im = Image.open(io.BytesIO(cairosvg.svg2png(url=p, output_width=s, output_height=s))).convert("RGBA")
    dark.alpha_composite(im, (x, 20 + (128 - s) // 2))
    x += s + 24
combo = Image.new("RGBA", (760, 400))
combo.paste(sheet, (0, 0)); combo.paste(dark, (0, 200))
combo.convert("RGB").save(f"{OUT}/preview-sizes.png")
print("preview-sizes.png")

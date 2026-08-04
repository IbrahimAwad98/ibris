# Generates tests/fixtures/subset-font.pdf: one page whose text
# "Hello world" is set in a fully synthetic embedded TrueType font that
# contains ONLY the glyphs H, e, l, o, w, r, d and space. Every other
# character is genuinely absent from the font program — the M6a glyph
# gate must refuse edits that need one (e.g. 'x'), and must accept edits
# that reuse the embedded set (e.g. "Held word").
#
# The font is built from scratch with fontTools (each glyph a plain
# rectangle of a distinct width) so the repo carries no third-party font
# licensing. Deterministic output: fixed timestamps, fixed ids.
#
# Run with: py scripts/gen-subset-font-fixture.py   (needs: pip install fonttools)
import io
import os

os.environ["SOURCE_DATE_EPOCH"] = "0"  # reproducible TTF timestamps

from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen

OUT = os.path.join(os.path.dirname(__file__), "..", "src-tauri", "tests",
                   "fixtures", "subset-font.pdf")

UPM = 1000
GLYPH_CHARS = "Helowrd"  # + space, handled separately
ADVANCE = 600


def build_font():
    order = [".notdef", "space"] + list(GLYPH_CHARS)
    fb = FontBuilder(UPM, isTTF=True)
    fb.setupGlyphOrder(order)
    cmap = {ord(" "): "space"}
    for c in GLYPH_CHARS:
        cmap[ord(c)] = c
    fb.setupCharacterMap(cmap)

    glyphs = {}
    for i, name in enumerate(order):
        pen = TTGlyphPen(None)
        if name not in (".notdef", "space"):
            # A solid rectangle; height varies per glyph so they are
            # visually distinct if anyone opens the fixture.
            h = 300 + 50 * i
            pen.moveTo((50, 0))
            pen.lineTo((50, h))
            pen.lineTo((550, h))
            pen.lineTo((550, 0))
            pen.closePath()
        glyphs[name] = pen.glyph()
    fb.setupGlyf(glyphs)
    fb.setupHorizontalMetrics({name: (ADVANCE, 50) for name in order})
    fb.setupHorizontalHeader(ascent=800, descent=-200)
    fb.setupNameTable({"familyName": "IbrisSubset", "styleName": "Regular"})
    fb.setupOS2(sTypoAscender=800, sTypoDescender=-200, usWinAscent=800,
                usWinDescent=200)
    fb.setupPost()
    buf = io.BytesIO()
    fb.save(buf)
    return buf.getvalue()


def pdf_bytes(ttf):
    # Widths for FirstChar 32..119: ADVANCE for encoded chars, 0 otherwise.
    first, last = 32, 119
    encoded = {ord(" ")} | {ord(c) for c in GLYPH_CHARS}
    widths = " ".join(str(ADVANCE if c in encoded else 0)
                      for c in range(first, last + 1))

    objects = {}
    objects[1] = b"<< /Type /Catalog /Pages 2 0 R >>"
    objects[2] = b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>"
    objects[3] = (b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
                  b"/Contents 4 0 R "
                  b"/Resources << /Font << /F1 5 0 R >> >> >>")
    content = b"BT /F1 24 Tf 72 700 Td (Hello world) Tj ET"
    objects[4] = (b"<< /Length %d >>\nstream\n" % len(content) + content +
                  b"\nendstream")
    objects[5] = ("<< /Type /Font /Subtype /TrueType /BaseFont /IbrisSubset "
                  "/FirstChar %d /LastChar %d /Widths [%s] "
                  "/Encoding /WinAnsiEncoding "
                  "/FontDescriptor 6 0 R >>" % (first, last, widths)).encode()
    objects[6] = (b"<< /Type /FontDescriptor /FontName /IbrisSubset /Flags 32 "
                  b"/FontBBox [0 -200 600 800] /ItalicAngle 0 /Ascent 800 "
                  b"/Descent -200 /CapHeight 700 /StemV 80 /FontFile2 7 0 R >>")
    objects[7] = (b"<< /Length %d /Length1 %d >>\nstream\n" % (len(ttf), len(ttf))
                  + ttf + b"\nendstream")

    out = bytearray(b"%PDF-1.6\n%\xc2\xa0\xc2\xa0\n")
    offsets = {}
    for num in sorted(objects):
        offsets[num] = len(out)
        out += b"%d 0 obj\n" % num
        out += objects[num]
        out += b"\nendobj\n"
    xref_at = len(out)
    count = max(objects) + 1
    out += b"xref\n0 %d\n" % count
    out += b"0000000000 65535 f \n"
    for num in range(1, count):
        out += b"%010d 00000 n \n" % offsets[num]
    out += (b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n"
            % (count, xref_at))
    return bytes(out)


ttf = build_font()
data = pdf_bytes(ttf)
with open(OUT, "wb") as f:
    f.write(data)
print("wrote %s (%d bytes, ttf %d bytes)" % (OUT, len(data), len(ttf)))

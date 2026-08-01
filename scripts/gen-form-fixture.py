# Generates tests/fixtures/acroform.pdf: one page with a text field, a
# checkbox, a two-button radio group, a combo box, and a list box, all
# with explicit appearance streams so PDFium renders them without a
# form-fill pass. Deterministic output (no dates, fixed ids).
#
# Run with: py scripts/gen-form-fixture.py
import os

OUT = os.path.join(os.path.dirname(__file__), "..", "src-tauri", "tests",
                   "fixtures", "acroform.pdf")


def stream_obj(dict_extra, data):
    d = "<< /Length %d %s >>" % (len(data), dict_extra)
    return d + "\nstream\n" + data + "\nendstream"


def form_xobject(w, h, content):
    return stream_obj(
        "/Type /XObject /Subtype /Form /BBox [0 0 %g %g]" % (w, h), content)


objects = {}  # number -> body string (without "N 0 obj/endobj")

objects[1] = "<< /Type /Catalog /Pages 3 0 R /AcroForm 2 0 R >>"
objects[2] = ("<< /Fields [7 0 R 9 0 R 14 0 R 15 0 R 17 0 R] "
              "/DR << /Font << /Helv 4 0 R >> >> "
              "/DA (/Helv 12 Tf 0 g) >>")
objects[3] = "<< /Type /Pages /Kids [5 0 R] /Count 1 >>"
objects[4] = ("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica "
              "/Encoding /WinAnsiEncoding >>")
objects[5] = ("<< /Type /Page /Parent 3 0 R /MediaBox [0 0 612 792] "
              "/Contents 6 0 R "
              "/Resources << /Font << /Helv 4 0 R >> >> "
              "/Annots [7 0 R 9 0 R 12 0 R 13 0 R 15 0 R 17 0 R] >>")
objects[6] = stream_obj("", "BT /Helv 14 Tf 72 750 Td (Form fixture) Tj ET")

# Text field ------------------------------------------------------------
objects[7] = ("<< /Type /Annot /Subtype /Widget /FT /Tx /T (name) "
              "/Rect [72 700 372 724] /F 4 "
              "/DA (/Helv 12 Tf 0 g) "
              "/MK << /BC [0 0 0] /BG [1 1 1] >> "
              "/AP << /N 8 0 R >> >>")
objects[8] = form_xobject(300, 24, "0.5 w 0 0 0 RG 0.25 0.25 299.5 23.5 re S")

# Checkbox --------------------------------------------------------------
objects[9] = ("<< /Type /Annot /Subtype /Widget /FT /Btn /T (subscribe) "
              "/Rect [72 660 88 676] /F 4 /V /Off /AS /Off "
              "/MK << /BC [0 0 0] /BG [1 1 1] >> "
              "/AP << /N << /Yes 10 0 R /Off 11 0 R >> >> >>")
objects[10] = form_xobject(
    16, 16,
    "0.5 w 0 0 0 RG 0.25 0.25 15.5 15.5 re S 1.5 w 3 8 m 7 4 l 13 12 l S")
objects[11] = form_xobject(16, 16, "0.5 w 0 0 0 RG 0.25 0.25 15.5 15.5 re S")

# Radio group (parent field 14, kid widgets 12 and 13) -------------------
on_dot = ("0.5 w 0 0 0 RG 0.25 0.25 15.5 15.5 re S "
          "8 8 m 8 8 3 0 360 arc f" )
# PDF has no arc operator; draw the dot with a filled rect instead.
on_dot = ("0.5 w 0 0 0 RG 0.25 0.25 15.5 15.5 re S 0 0 0 rg 5 5 6 6 re f")
off_box = "0.5 w 0 0 0 RG 0.25 0.25 15.5 15.5 re S"
objects[12] = ("<< /Type /Annot /Subtype /Widget /Parent 14 0 R "
               "/Rect [72 620 88 636] /F 4 /AS /Off "
               "/MK << /BC [0 0 0] /BG [1 1 1] /CA (l) >> "
               "/AP << /N << /Red %s /Off %s >> >> >>"
               % ("18 0 R", "19 0 R"))
objects[13] = ("<< /Type /Annot /Subtype /Widget /Parent 14 0 R "
               "/Rect [110 620 126 636] /F 4 /AS /Off "
               "/MK << /BC [0 0 0] /BG [1 1 1] /CA (l) >> "
               "/AP << /N << /Blue %s /Off %s >> >> >>"
               % ("18 0 R", "19 0 R"))
objects[14] = ("<< /FT /Btn /T (color) /Ff 32768 /V /Off "
               "/Kids [12 0 R 13 0 R] >>")

# Combo box (dropdown) ---------------------------------------------------
objects[15] = ("<< /Type /Annot /Subtype /Widget /FT /Ch /T (country) "
               "/Ff 131072 /Rect [72 560 200 584] /F 4 "
               "/Opt [(US) (DE) (EG)] /V (US) "
               "/DA (/Helv 12 Tf 0 g) "
               "/MK << /BC [0 0 0] /BG [1 1 1] >> "
               "/AP << /N 16 0 R >> >>")
objects[16] = form_xobject(
    128, 24,
    "0.5 w 0 0 0 RG 0.25 0.25 127.5 23.5 re S "
    "BT /Helv 12 Tf 2 7 Td (US) Tj ET")

# List box ---------------------------------------------------------------
objects[17] = ("<< /Type /Annot /Subtype /Widget /FT /Ch /T (picks) "
               "/Rect [72 480 200 540] /F 4 "
               "/Opt [(Alpha) (Beta) (Gamma)] "
               "/DA (/Helv 12 Tf 0 g) "
               "/MK << /BC [0 0 0] /BG [1 1 1] >> "
               "/AP << /N 20 0 R >> >>")

objects[18] = form_xobject(16, 16, on_dot)
objects[19] = form_xobject(16, 16, off_box)
objects[20] = form_xobject(
    128, 60, "0.5 w 0 0 0 RG 0.25 0.25 127.5 59.5 re S")

max_num = max(objects)
out = bytearray()
out += b"%PDF-1.7\n%\xc7\xec\x8f\xa2\n"
offsets = {}
for num in range(1, max_num + 1):
    offsets[num] = len(out)
    body = objects[num]
    out += ("%d 0 obj\n%s\nendobj\n" % (num, body)).encode("latin-1")

xref_at = len(out)
out += ("xref\n0 %d\n" % (max_num + 1)).encode("ascii")
out += b"0000000000 65535 f \n"
for num in range(1, max_num + 1):
    out += ("%010d 00000 n \n" % offsets[num]).encode("ascii")
out += ("trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n"
        % (max_num + 1, xref_at)).encode("ascii")

with open(os.path.abspath(OUT), "wb") as f:
    f.write(bytes(out))
print("wrote %s (%d bytes)" % (os.path.abspath(OUT), len(out)))

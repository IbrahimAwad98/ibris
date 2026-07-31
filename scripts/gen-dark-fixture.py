# Generates tests/fixtures/dark-photo-charts.pdf: a two-page fixture for
# dark-mode luminance inversion.
#   Page 1 (MediaBox origin 0,0):   an uncompressed RGB image XObject (a
#     smooth gradient standing in for a photo), three saturated chart bars,
#     and coloured text.
#   Page 2 (MediaBox origin 100,50): the same content shifted by the origin,
#     per docs/DECISIONS.md 009 - zero-origin fixtures hide origin bugs.
# ASCII-only source; writes binary PDF bytes.
import os

OUT = os.path.join(
    os.path.dirname(__file__), "..", "src-tauri", "tests", "fixtures",
    "dark-photo-charts.pdf",
)

IMG_W = 64
IMG_H = 64


def image_bytes():
    data = bytearray()
    for j in range(IMG_H):
        for i in range(IMG_W):
            data.append((i * 4) % 256)   # red ramps left to right
            data.append((j * 4) % 256)   # green ramps top to bottom
            data.append(128)             # constant blue: mid-saturation
    return bytes(data)


# Shared page body, drawn in a coordinate system whose origin is the
# page's visible-box origin. Image occupies (20,110)-(120,180) in points.
BODY = b"""q 100 0 0 70 20 110 cm /Im0 Do Q
1 0 0 rg 20 30 40 50 re f
0 0.7 0 rg 70 30 40 35 re f
0 0.2 1 rg 120 30 40 60 re f
0.8 0 0.1 rg BT /F1 14 Tf 180 60 Td (Coloured text) Tj ET
"""

CONTENT_P1 = BODY
CONTENT_P2 = b"q 1 0 0 1 100 50 cm\n" + BODY + b"Q\n"


def stream_obj(num, dict_extra, data):
    head = "%d 0 obj\n<< %s /Length %d >>\nstream\n" % (num, dict_extra, len(data))
    return head.encode("ascii") + data + b"\nendstream\nendobj\n"


def main():
    img = image_bytes()
    objects = {
        1: b"1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
        2: b"2 0 obj\n<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>\nendobj\n",
        3: (b"3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] "
            b"/Resources << /XObject << /Im0 5 0 R >> "
            b"/Font << /F1 6 0 R >> >> /Contents 7 0 R >>\nendobj\n"),
        4: (b"4 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [100 50 400 250] "
            b"/Resources << /XObject << /Im0 5 0 R >> "
            b"/Font << /F1 6 0 R >> >> /Contents 8 0 R >>\nendobj\n"),
        5: stream_obj(
            5,
            "/Type /XObject /Subtype /Image /Width %d /Height %d "
            "/ColorSpace /DeviceRGB /BitsPerComponent 8" % (IMG_W, IMG_H),
            img,
        ),
        6: (b"6 0 obj\n<< /Type /Font /Subtype /Type1 "
            b"/BaseFont /Helvetica >>\nendobj\n"),
        7: stream_obj(7, "", CONTENT_P1),
        8: stream_obj(8, "", CONTENT_P2),
    }

    out = bytearray()
    out += b"%PDF-1.4\n%\xff\xff\xff\xff\n"
    offsets = {}
    for num in sorted(objects):
        offsets[num] = len(out)
        out += objects[num]

    xref_at = len(out)
    out += ("xref\n0 %d\n" % (len(objects) + 1)).encode("ascii")
    out += b"0000000000 65535 f \n"
    for num in sorted(objects):
        out += ("%010d 00000 n \n" % offsets[num]).encode("ascii")
    out += (
        "trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n"
        % (len(objects) + 1, xref_at)
    ).encode("ascii")

    with open(OUT, "wb") as f:
        f.write(bytes(out))
    print("wrote %s (%d bytes)" % (os.path.abspath(OUT), len(out)))


if __name__ == "__main__":
    main()

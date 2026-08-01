//! Search-highlight rects must align with the *rendered* page, not merely
//! be internally consistent. A document whose CropBox/MediaBox origin is
//! not (0,0) has absolute char coordinates offset from the rendered bitmap
//! — the class of bug fixed on fix/search-highlight-offset.

use std::path::PathBuf;

use ibris_lib::pdf::service::PdfService;

fn fixture(name: &str) -> PathBuf {
    PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures")).join(name)
}

/// Bounding box of dark pixels in an RGBA buffer, in pixels.
fn ink_bbox(rgba: &[u8], width: u32) -> Option<(u32, u32, u32, u32)> {
    let (mut min_x, mut min_y, mut max_x, mut max_y) = (u32::MAX, u32::MAX, 0u32, 0u32);
    for (i, px) in rgba.chunks_exact(4).enumerate() {
        if px[0] < 128 && px[3] == 255 {
            let x = i as u32 % width;
            let y = i as u32 / width;
            min_x = min_x.min(x);
            min_y = min_y.min(y);
            max_x = max_x.max(x);
            max_y = max_y.max(y);
        }
    }
    (min_x != u32::MAX).then_some((min_x, min_y, max_x, max_y))
}

/// The match rect for a word, scaled to device pixels, must sit inside the
/// page's ink bounding box (with a small tolerance for loose glyph bounds)
/// at every zoom level. With an offset box origin the rect lands tens of
/// points away and this fails loudly.
async fn assert_rect_within_ink(fixture_name: &str, query: &str) {
    let service = PdfService::new();
    let (doc_id, _) = service
        .open(fixture(fixture_name))
        .await
        .expect("open failed");

    for (req_base, scale) in [(100u64, 1.0f32), (200, 2.42), (300, 5.0)] {
        let page = service
            .render(doc_id, 0, scale, false, req_base)
            .await
            .expect("render failed");
        let (ink_l, ink_t, ink_r, ink_b) =
            ink_bbox(&page.rgba, page.width).expect("page rendered blank");

        let hits = service
            .search(doc_id, query.into(), false, false, 0, 0, req_base + 1)
            .await
            .expect("search failed");
        assert_eq!(hits.len(), 1, "expected one match for {query}");
        let r = hits[0].rects[0];

        // Loose char boxes overhang real ink slightly; 8pt covers ascender/
        // descender slack without masking a box-origin offset (50/100pt).
        let tol = 8.0 * scale;
        let (rl, rt) = (r.x * scale, r.y * scale);
        let (rr, rb) = ((r.x + r.width) * scale, (r.y + r.height) * scale);
        assert!(
            rl >= ink_l as f32 - tol
                && rt >= ink_t as f32 - tol
                && rr <= ink_r as f32 + tol
                && rb <= ink_b as f32 + tol,
            "at {scale}x, match rect ({rl:.0},{rt:.0})-({rr:.0},{rb:.0}) lies outside \
             rendered ink ({ink_l},{ink_t})-({ink_r},{ink_b}) in {fixture_name}"
        );
    }
}

#[tokio::test]
async fn match_rect_aligns_with_ink_when_box_origin_is_offset() {
    assert_rect_within_ink("offset-mediabox.pdf", "person").await;
}

#[tokio::test]
async fn match_rect_aligns_with_ink_on_zero_origin_page() {
    assert_rect_within_ink("plain-text.pdf", "fox").await;
}

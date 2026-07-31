//! Dark-mode luminance inversion against the photo/chart fixture.
//!
//! The fixture (scripts/gen-dark-fixture.py) has an embedded RGB image (a
//! gradient standing in for a photo), saturated chart bars, and coloured
//! text — on a zero-origin page and again on an offset-MediaBox page
//! (decision 009: zero-origin fixtures hide origin bugs).

use std::path::PathBuf;

use ibris_lib::pdf::service::PdfService;

fn fixture(name: &str) -> PathBuf {
    PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures")).join(name)
}

/// Rendered at scale 1 the page is 300x200 device px. In top-left device
/// coordinates relative to the visible box (identical for both pages):
/// photo x 20..120, y 20..90; red bar x 20..60, y 120..170.
const PAGE_W: usize = 300;

fn px(rgba: &[u8], x: usize, y: usize) -> (u8, u8, u8) {
    let i = (y * PAGE_W + x) * 4;
    (rgba[i], rgba[i + 1], rgba[i + 2])
}

fn luminance((r, g, b): (u8, u8, u8)) -> f32 {
    0.2126 * f32::from(r) + 0.7152 * f32::from(g) + 0.0722 * f32::from(b)
}

async fn assert_page_inverts_correctly(page_index: u16) {
    let service = PdfService::new();
    let (doc_id, info) = service
        .open(fixture("dark-photo-charts.pdf"))
        .await
        .expect("open failed");
    assert_eq!(info.page_count, 2);

    let plain = service
        .render(doc_id, page_index, 1.0, false, 1)
        .await
        .expect("plain render failed");
    let dark = service
        .render(doc_id, page_index, 1.0, true, 2)
        .await
        .expect("dark render failed");
    assert_eq!(plain.width as usize, PAGE_W);
    assert_eq!(plain.rgba.len(), dark.rgba.len());

    // The photo interior (inset to dodge edge antialiasing) is untouched.
    for y in (25..85).step_by(5) {
        for x in (25..115).step_by(5) {
            assert_eq!(
                px(&plain.rgba, x, y),
                px(&dark.rgba, x, y),
                "photo pixel ({x},{y}) changed on page {page_index}"
            );
        }
    }

    // The page background flipped from light to dark.
    for (x, y) in [(280, 10), (10, 190), (200, 100)] {
        let before = luminance(px(&plain.rgba, x, y));
        let after = luminance(px(&dark.rgba, x, y));
        assert!(
            before > 220.0 && after < 40.0,
            "background ({x},{y}) page {page_index}: {before} -> {after}"
        );
    }

    // The red chart bar keeps red as its dominant channel.
    let (r, g, b) = px(&dark.rgba, 40, 145);
    assert!(
        r > g.saturating_add(50) && r > b.saturating_add(50),
        "red bar lost its hue on page {page_index}: ({r},{g},{b})"
    );
}

#[tokio::test]
async fn zero_origin_page_inverts_around_the_photo() {
    assert_page_inverts_correctly(0).await;
}

#[tokio::test]
async fn offset_mediabox_page_inverts_around_the_photo() {
    assert_page_inverts_correctly(1).await;
}

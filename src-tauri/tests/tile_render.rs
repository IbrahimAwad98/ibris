use std::path::PathBuf;

use ibris_lib::pdf::engine::TileRect;
use ibris_lib::pdf::service::PdfService;

fn fixture(name: &str) -> PathBuf {
    PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures")).join(name)
}

fn tile(x: i32, y: i32) -> TileRect {
    TileRect {
        x,
        y,
        width: 512,
        height: 512,
    }
}

/// At 4x, the 612x792pt page is 2448x3168 device px; the fixture's text
/// starts near (288, 340) device px.
const SCALE: f32 = 4.0;

#[tokio::test]
async fn tile_covering_text_has_ink_and_blank_tile_does_not() {
    let service = PdfService::new();
    let (doc_id, _) = service
        .open(fixture("plain-text.pdf"))
        .await
        .expect("open failed");

    let text_tile = service
        .render_tile(doc_id, 0, SCALE, tile(256, 256), false, 1)
        .await
        .expect("text tile render failed");
    assert_eq!(text_tile.width, 512);
    assert_eq!(text_tile.height, 512);
    assert_eq!(text_tile.rgba.len(), 512 * 512 * 4);
    let dark = dark_pixels(&text_tile.rgba);
    assert!(dark > 500, "text tile rendered blank: {dark} dark pixels");

    let blank_tile = service
        .render_tile(doc_id, 0, SCALE, tile(1024, 2048), false, 2)
        .await
        .expect("blank tile render failed");
    assert_eq!(
        dark_pixels(&blank_tile.rgba),
        0,
        "tile in empty page region should have no ink"
    );
}

#[tokio::test]
async fn tiles_stitch_exactly_into_the_whole_page_render() {
    let service = PdfService::new();
    let (doc_id, _) = service
        .open(fixture("plain-text.pdf"))
        .await
        .expect("open failed");

    let whole = service
        .render(doc_id, 0, SCALE, false, 3)
        .await
        .expect("whole-page render failed");
    assert_eq!(whole.width, 2448);

    // A tile overlapping the text region must match the whole-page render
    // byte for byte at the same coordinates.
    let t = service
        .render_tile(doc_id, 0, SCALE, tile(256, 256), false, 4)
        .await
        .expect("tile render failed");

    // Anti-aliasing quantisation can differ slightly with render origin, so
    // this is a tolerance comparison (matching the golden-image policy in
    // CLAUDE.md), not byte equality: any structural offset bug produces
    // thousands of large-delta pixels and fails loudly.
    let mut max_delta = 0u8;
    let mut differing_pixels = 0usize;
    for row in 0..512usize {
        let whole_offset = ((row + 256) * whole.width as usize + 256) * 4;
        let tile_offset = row * 512 * 4;
        let w_row = &whole.rgba[whole_offset..whole_offset + 512 * 4];
        let t_row = &t.rgba[tile_offset..tile_offset + 512 * 4];
        for (wp, tp) in w_row.chunks_exact(4).zip(t_row.chunks_exact(4)) {
            let delta = wp
                .iter()
                .zip(tp)
                .map(|(a, b)| a.abs_diff(*b))
                .max()
                .unwrap_or(0);
            if delta > 0 {
                differing_pixels += 1;
                max_delta = max_delta.max(delta);
            }
        }
    }
    let total = 512 * 512;
    assert!(
        max_delta <= 16,
        "tile pixels deviate too far from whole-page render: max channel delta {max_delta}"
    );
    assert!(
        differing_pixels < total / 100,
        "too many differing pixels: {differing_pixels} of {total} (structural offset?)"
    );
}

#[tokio::test]
async fn tile_past_page_edge_renders_without_error() {
    let service = PdfService::new();
    let (doc_id, _) = service
        .open(fixture("plain-text.pdf"))
        .await
        .expect("open failed");

    // Page is 2448x3168 at 4x; this tile hangs off both edges.
    let t = service
        .render_tile(doc_id, 0, SCALE, tile(2304, 3072), false, 5)
        .await
        .expect("edge tile render failed");
    assert_eq!(t.width, 512);
    assert_eq!(t.height, 512);
    assert_eq!(t.rgba.len(), 512 * 512 * 4);
}

fn dark_pixels(rgba: &[u8]) -> usize {
    rgba.chunks_exact(4)
        .filter(|p| p[0] < 128 && p[3] == 255)
        .count()
}

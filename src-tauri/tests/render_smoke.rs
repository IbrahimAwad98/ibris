use pdfium_render::prelude::*;

/// M0 smoke test: proves the pdfium binary loads on Windows and renders a
/// real page. If this fails with a binding error, run scripts/get-pdfium.ps1.
#[test]
fn renders_first_page_to_png() {
    let pdfium = Pdfium::new(
        Pdfium::bind_to_library(Pdfium::pdfium_platform_library_name_at_path("./pdfium/"))
            .expect("pdfium.dll not found in src-tauri/pdfium/ — run scripts/get-pdfium.ps1"),
    );

    let document = pdfium
        .load_pdf_from_file("tests/fixtures/plain-text.pdf", None)
        .expect("failed to load fixture PDF");

    let page = document.pages().first().expect("fixture has no pages");

    // 612x792pt letter page rendered at 2x.
    let bitmap = page
        .render_with_config(&PdfRenderConfig::new().set_target_width(1224))
        .expect("render failed");

    let image = bitmap
        .as_image()
        .expect("bitmap to image conversion failed")
        .into_rgba8();
    assert_eq!(image.width(), 1224);
    assert_eq!(image.height(), 1584);

    // Two lines of 24pt text: expect real ink, but nowhere near a black page.
    let dark = image
        .pixels()
        .filter(|p| p.0[0] < 128 && p.0[3] == 255)
        .count();
    assert!(dark > 1_000, "page rendered blank: {dark} dark pixels");
    assert!(
        dark < (1224 * 1584) / 2,
        "page rendered mostly black: {dark} dark pixels"
    );

    let out = concat!(env!("CARGO_TARGET_TMPDIR"), "/plain-text-page1.png");
    image.save(out).expect("failed to write PNG");
    assert!(
        std::fs::metadata(out).expect("PNG not written").len() > 1_000,
        "PNG suspiciously small"
    );
}

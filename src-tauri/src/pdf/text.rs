//! Text extraction and search over PDFium's character boxes.
//!
//! Everything here works from `FPDFText_*` char geometry (via pdfium-render);
//! nothing reconstructs positions from the content stream.

use pdfium_render::prelude::*;
use serde::Serialize;

use super::error::PdfError;

/// One horizontal run of text: consecutive characters sharing a baseline.
/// Geometry is in PDF points with a *top-left* origin (y measured from the
/// page top), pre-converted so the frontend positions elements directly.
#[derive(Debug, Clone, Serialize)]
pub struct TextRun {
    pub text: String,
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
}

#[derive(Debug, Clone, Serialize)]
pub struct PageText {
    pub runs: Vec<TextRun>,
}

/// A single search hit: rects cover the matched characters, one rect per
/// text line, in top-left-origin page points.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchMatch {
    pub page_index: u16,
    pub rects: Vec<MatchRect>,
    pub context: String,
}

#[derive(Debug, Clone, Copy, Serialize)]
pub struct MatchRect {
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
}

struct CharBox {
    ch: char,
    left: f32,
    top: f32, // from page top
    right: f32,
    bottom: f32,
    baseline: f32,
}

/// Origin of the page's *visible* box (crop box, falling back to media box)
/// in absolute page space. Char boxes are absolute, but the rendered bitmap
/// starts at this origin — documents with a non-(0,0) box origin exist in
/// the wild, and ignoring it offsets every rect by the origin in points.
pub(crate) fn visible_box_origin(page: &PdfPage<'_>) -> (f32, f32) {
    let boundaries = page.boundaries();
    let rect = boundaries
        .crop()
        .or_else(|_| boundaries.media())
        .map(|b| b.bounds);
    match rect {
        Ok(r) => (r.left().value, r.top().value),
        Err(_) => (0.0, page.height().value),
    }
}

fn char_boxes(page: &PdfPage<'_>) -> Vec<CharBox> {
    let (box_left, box_top) = visible_box_origin(page);
    let text = match page.text() {
        Ok(t) => t,
        Err(_) => return Vec::new(),
    };
    let mut boxes = Vec::new();
    for ch in text.chars().iter() {
        let (Some(c), Ok(bounds), Ok((_, origin_y))) =
            (ch.unicode_char(), ch.loose_bounds(), ch.origin())
        else {
            continue;
        };
        if c == '\r' || c == '\n' {
            continue;
        }
        boxes.push(CharBox {
            ch: c,
            left: bounds.left().value - box_left,
            top: box_top - bounds.top().value,
            right: bounds.right().value - box_left,
            bottom: box_top - bounds.bottom().value,
            baseline: origin_y.value,
        });
    }
    boxes
}

/// Extracts baseline-grouped text runs for one page.
pub fn extract_runs(page: &PdfPage<'_>) -> Result<PageText, PdfError> {
    let boxes = char_boxes(page);
    let mut runs: Vec<TextRun> = Vec::new();
    let mut current: Option<(String, f32, f32, f32, f32, f32)> = None; // text, l, t, r, b, baseline

    for cb in &boxes {
        match current.as_mut() {
            Some((text, l, t, r, b, baseline))
                if (cb.baseline - *baseline).abs() < 0.5 && cb.left >= *l =>
            {
                text.push(cb.ch);
                *t = t.min(cb.top);
                *r = r.max(cb.right);
                *b = b.max(cb.bottom);
            }
            _ => {
                if let Some(done) = current.take() {
                    push_run(&mut runs, done);
                }
                current = Some((
                    cb.ch.to_string(),
                    cb.left,
                    cb.top,
                    cb.right,
                    cb.bottom,
                    cb.baseline,
                ));
            }
        }
    }
    if let Some(done) = current.take() {
        push_run(&mut runs, done);
    }
    Ok(PageText { runs })
}

fn push_run(runs: &mut Vec<TextRun>, (text, l, t, r, b, _): (String, f32, f32, f32, f32, f32)) {
    if text.trim().is_empty() {
        return;
    }
    runs.push(TextRun {
        text,
        x: l,
        y: t,
        width: r - l,
        height: b - t,
    });
}

/// Searches one page for `query`. Matching is done in Rust over the page's
/// character sequence so case folding and whole-word behave identically
/// everywhere.
pub fn search_page(
    page: &PdfPage<'_>,
    page_index: u16,
    query: &str,
    case_sensitive: bool,
    whole_word: bool,
) -> Vec<SearchMatch> {
    if query.is_empty() {
        return Vec::new();
    }
    let boxes = char_boxes(page);
    let haystack: String = boxes.iter().map(|b| b.ch).collect();
    let (folded_hay, folded_query) = if case_sensitive {
        (haystack.clone(), query.to_string())
    } else {
        (haystack.to_lowercase(), query.to_lowercase())
    };

    // char-index based scan; byte offsets translated via char_indices map.
    let hay_chars: Vec<char> = folded_hay.chars().collect();
    let query_chars: Vec<char> = folded_query.chars().collect();
    let n = hay_chars.len();
    let m = query_chars.len();
    if m == 0 || n < m {
        return Vec::new();
    }

    let mut matches = Vec::new();
    let mut i = 0;
    while i + m <= n {
        if hay_chars[i..i + m] == query_chars[..] {
            let word_ok = !whole_word
                || ((i == 0 || !hay_chars[i - 1].is_alphanumeric())
                    && (i + m == n || !hay_chars[i + m].is_alphanumeric()));
            if word_ok {
                matches.push(build_match(&boxes, &haystack, page_index, i, m));
                i += m;
                continue;
            }
        }
        i += 1;
    }
    matches
}

fn build_match(
    boxes: &[CharBox],
    haystack: &str,
    page_index: u16,
    start: usize,
    len: usize,
) -> SearchMatch {
    // One rect per baseline among the matched chars.
    let mut rects: Vec<MatchRect> = Vec::new();
    let mut current: Option<(f32, f32, f32, f32, f32)> = None; // l, t, r, b, baseline
    for cb in &boxes[start..start + len] {
        match current.as_mut() {
            Some((l, t, r, b, baseline)) if (cb.baseline - *baseline).abs() < 0.5 => {
                *l = l.min(cb.left);
                *t = t.min(cb.top);
                *r = r.max(cb.right);
                *b = b.max(cb.bottom);
            }
            _ => {
                if let Some((l, t, r, b, _)) = current.take() {
                    rects.push(MatchRect {
                        x: l,
                        y: t,
                        width: r - l,
                        height: b - t,
                    });
                }
                current = Some((cb.left, cb.top, cb.right, cb.bottom, cb.baseline));
            }
        }
    }
    if let Some((l, t, r, b, _)) = current.take() {
        rects.push(MatchRect {
            x: l,
            y: t,
            width: r - l,
            height: b - t,
        });
    }

    let chars: Vec<char> = haystack.chars().collect();
    let ctx_start = start.saturating_sub(40);
    let ctx_end = (start + len + 40).min(chars.len());
    let context: String = chars[ctx_start..ctx_end].iter().collect();

    SearchMatch {
        page_index,
        rects,
        context,
    }
}

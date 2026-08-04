//! M6a: in-place text edits, glyph-gated and verified (M6-PLAN §2).
//!
//! A replacement may use only glyphs the object's font already provides —
//! PDFium's `FPDFText_SetText` cannot extend an embedded subset; a missing
//! glyph would silently render as tofu. The gate here is refusal-first:
//! `FPDFFont_GetGlyphPath` per character (the authoritative check — for
//! simple fonts with standard encodings, extraction round-trips even when
//! the glyph is missing, so extraction alone cannot detect tofu), plus an
//! extract-back comparison after the edit as a second layer. Every save
//! containing edits re-parses the final bytes and proves the edited pages'
//! text objects match expectations before the atomic rename (save.rs).

use pdfium_render::prelude::*;
use serde::{Deserialize, Serialize};

use super::error::PdfError;

/// One in-place text replacement, mirroring the IPC wire shape. `before`
/// is the object's text as the user saw it — the engine refuses if the
/// object no longer says that (the file changed since the edit was made).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextEdit {
    pub page_index: u16,
    pub object_index: u32,
    pub before: String,
    pub after: String,
}

/// One editable text object on a page, for the edit tool's hit testing.
/// Geometry in page points relative to the visible box, top-left origin
/// (decision 009).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextObjectInfo {
    pub object_index: u32,
    pub text: String,
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
}

/// Enumerates the text objects of a (viewing-document) page.
///
/// Can fail on nothing itself; objects whose bounds PDFium cannot produce
/// are skipped — they cannot be hit-tested anyway.
pub fn list_text_objects(page: &PdfPage<'_>) -> Vec<TextObjectInfo> {
    let (box_left, box_top) = super::text::visible_box_origin(page);
    page.objects()
        .iter()
        .enumerate()
        .filter_map(|(i, object)| {
            let text = object.as_text_object()?.text();
            let b = object.bounds().ok()?;
            Some(TextObjectInfo {
                object_index: i as u32,
                text,
                x: b.left().value - box_left,
                y: box_top - b.top().value,
                width: b.width().value,
                height: b.height().value,
            })
        })
        .collect()
}

// FPDF_PAGEOBJ_TEXT (fpdf_edit.h).
const OBJ_TEXT: i32 = 1;

/// A text object's string via a live textpage (UTF-16LE out).
unsafe fn object_text(
    b: &dyn PdfiumLibraryBindings,
    obj: FPDF_PAGEOBJECT,
    textpage: FPDF_TEXTPAGE,
) -> String {
    let len = b.FPDFTextObj_GetText(obj, textpage, std::ptr::null_mut(), 0);
    if len <= 2 {
        return String::new();
    }
    let mut buf = vec![0u16; (len as usize) / 2];
    b.FPDFTextObj_GetText(obj, textpage, buf.as_mut_ptr(), len);
    String::from_utf16_lossy(&buf[..buf.len().saturating_sub(1)])
}

/// The characters of `text` the font has no glyph for. Whitespace is
/// exempt — spaces are advances, not outlines, and a legitimate space
/// glyph may have an empty path.
unsafe fn missing_glyphs(b: &dyn PdfiumLibraryBindings, font: FPDF_FONT, text: &str) -> Vec<char> {
    let mut seen = Vec::new();
    let mut missing = Vec::new();
    for c in text.chars() {
        if c.is_whitespace() || seen.contains(&c) {
            continue;
        }
        seen.push(c);
        if b.FPDFFont_GetGlyphPath(font, c as u32, 12.0).is_null() {
            missing.push(c);
        }
    }
    missing
}

/// Applies one edit to a loaded page: locates the object, runs the glyph
/// gate, replaces the text, regenerates the content stream, and proves the
/// new text extracts back. `expected_before` of `None` skips the staleness
/// check (the dry-run path, which starts from the same bytes the user
/// sees).
///
/// # Safety
/// Engine thread; `page` live on this PDFium instance.
unsafe fn apply_one(
    b: &dyn PdfiumLibraryBindings,
    page: FPDF_PAGE,
    page_index: u16,
    object_index: u32,
    expected_before: Option<&str>,
    after: &str,
) -> Result<(), PdfError> {
    let count = b.FPDFPage_CountObjects(page);
    if object_index as i32 >= count {
        return Err(PdfError::Internal {
            detail: format!(
                "text edit references object {object_index} of {count} on page {}",
                page_index + 1
            ),
        });
    }
    let obj = b.FPDFPage_GetObject(page, object_index as i32);
    if obj.is_null() || b.FPDFPageObj_GetType(obj) != OBJ_TEXT {
        return Err(PdfError::Unsupported {
            feature: format!(
                "the edited object on page {} is not text in the file on disk — \
                 reopen the document and redo the edit",
                page_index + 1
            ),
        });
    }

    if let Some(expected) = expected_before {
        let textpage = b.FPDFText_LoadPage(page);
        let current = if textpage.is_null() {
            String::new()
        } else {
            let t = object_text(b, obj, textpage);
            b.FPDFText_ClosePage(textpage);
            t
        };
        if current != expected {
            return Err(PdfError::Unsupported {
                feature: format!(
                    "the text on page {} changed on disk since the edit was made \
                     (\"{current}\" instead of \"{expected}\") — reopen the \
                     document and redo the edit",
                    page_index + 1
                ),
            });
        }
    }

    // The glyph gate — the reason M6a can exist without corrupting files.
    let font = b.FPDFTextObj_GetFont(obj);
    if font.is_null() {
        return Err(PdfError::Unsupported {
            feature: format!(
                "the font of the edited text on page {} could not be loaded — \
                 this text cannot be edited",
                page_index + 1
            ),
        });
    }
    let missing = missing_glyphs(b, font, after);
    if !missing.is_empty() {
        let list = missing
            .iter()
            .map(|c| format!("'{c}'"))
            .collect::<Vec<_>>()
            .join(", ");
        return Err(PdfError::Unsupported {
            feature: format!(
                "this font's embedded subset does not contain {list} — the edit \
                 was not applied; reword it using characters already in the text, \
                 or add the text as an annotation instead"
            ),
        });
    }

    if !b.is_true(b.FPDFText_SetText_str(obj, after)) {
        return Err(PdfError::Internal {
            detail: format!("FPDFText_SetText failed on page {}", page_index + 1),
        });
    }
    if !b.is_true(b.FPDFPage_GenerateContent(page)) {
        return Err(PdfError::Internal {
            detail: format!("content regeneration failed on page {}", page_index + 1),
        });
    }

    // Second layer: the replacement must extract back exactly.
    let textpage = b.FPDFText_LoadPage(page);
    if textpage.is_null() {
        return Err(PdfError::Internal {
            detail: format!("reloading text of page {} failed", page_index + 1),
        });
    }
    let round_trip = object_text(b, obj, textpage);
    b.FPDFText_ClosePage(textpage);
    if round_trip != after {
        return Err(PdfError::Unsupported {
            feature: format!(
                "this font cannot represent the replacement text exactly \
                 (\"{round_trip}\" instead of \"{after}\") — the edit was not saved"
            ),
        });
    }
    Ok(())
}

/// Applies `edits` to `doc` (the save pipeline's fresh source load).
///
/// Fails without touching disk on: a stale `before`, a glyph missing from
/// the object's font, or PDFium refusing the rewrite.
///
/// # Safety
/// Engine thread; `doc` live on this PDFium instance.
pub unsafe fn apply(
    b: &dyn PdfiumLibraryBindings,
    doc: FPDF_DOCUMENT,
    edits: &[TextEdit],
) -> Result<(), PdfError> {
    for edit in edits {
        let page = b.FPDF_LoadPage(doc, i32::from(edit.page_index));
        if page.is_null() {
            return Err(PdfError::Internal {
                detail: format!("text edit on missing page {}", edit.page_index + 1),
            });
        }
        let result = apply_one(
            b,
            page,
            edit.page_index,
            edit.object_index,
            Some(&edit.before),
            &edit.after,
        );
        b.FPDF_ClosePage(page);
        result?;
    }
    Ok(())
}

/// Dry-runs one edit against a throwaway load of `bytes` — the edit tool's
/// pre-check, so the user learns about a missing glyph at confirm time,
/// not at save time. Nothing is written anywhere.
///
/// # Safety
/// Engine thread.
pub unsafe fn check(
    b: &dyn PdfiumLibraryBindings,
    bytes: &[u8],
    page_index: u16,
    object_index: u32,
    after: &str,
) -> Result<(), PdfError> {
    let doc = b.FPDF_LoadMemDocument64(bytes, None);
    if doc.is_null() {
        return Err(PdfError::Corrupt {
            detail: "the on-disk file could no longer be parsed".into(),
        });
    }
    let result = (|| {
        let page = b.FPDF_LoadPage(doc, i32::from(page_index));
        if page.is_null() {
            return Err(PdfError::Internal {
                detail: format!("page {} not found", page_index + 1),
            });
        }
        let r = apply_one(b, page, page_index, object_index, None, after);
        b.FPDF_ClosePage(page);
        r
    })();
    b.FPDF_CloseDocument(doc);
    result
}

/// Every text object's string on one page, in object order — the
/// verification snapshot shape.
///
/// # Safety
/// Engine thread; `doc` live on this PDFium instance.
pub unsafe fn page_object_texts(
    b: &dyn PdfiumLibraryBindings,
    doc: FPDF_DOCUMENT,
    page_index: u16,
) -> Result<Vec<String>, PdfError> {
    let page = b.FPDF_LoadPage(doc, i32::from(page_index));
    if page.is_null() {
        return Err(PdfError::Internal {
            detail: format!("page {} not found for text snapshot", page_index + 1),
        });
    }
    let textpage = b.FPDFText_LoadPage(page);
    if textpage.is_null() {
        b.FPDF_ClosePage(page);
        return Err(PdfError::Internal {
            detail: format!("text of page {} not readable", page_index + 1),
        });
    }
    let mut texts = Vec::new();
    for i in 0..b.FPDFPage_CountObjects(page) {
        let obj = b.FPDFPage_GetObject(page, i);
        if !obj.is_null() && b.FPDFPageObj_GetType(obj) == OBJ_TEXT {
            texts.push(object_text(b, obj, textpage));
        }
    }
    b.FPDFText_ClosePage(textpage);
    b.FPDF_ClosePage(page);
    Ok(texts)
}

/// The always-on verification (M6-PLAN §2): re-parses the serialised
/// bytes and proves each edited page's text objects match the expected
/// snapshot exactly — replacement present, everything else unchanged —
/// BEFORE the atomic rename. Any mismatch aborts the save; the file on
/// disk is never touched.
pub fn verify(
    b: &dyn PdfiumLibraryBindings,
    bytes: &[u8],
    pages: &[(u16, Vec<String>)],
) -> Result<(), PdfError> {
    unsafe {
        let doc = b.FPDF_LoadMemDocument64(bytes, None);
        if doc.is_null() {
            return Err(PdfError::Internal {
                detail: "text-edit verification could not parse the saved bytes".into(),
            });
        }
        let result = (|| {
            for (page_index, expected) in pages {
                let found = page_object_texts(b, doc, *page_index)?;
                if &found != expected {
                    return Err(PdfError::Internal {
                        detail: format!(
                            "text-edit verification failed on page {}: the saved \
                             file does not contain exactly the expected text — \
                             save aborted, the file on disk is untouched",
                            page_index + 1
                        ),
                    });
                }
            }
            Ok(())
        })();
        b.FPDF_CloseDocument(doc);
        result
    }
}

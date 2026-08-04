//! True redaction (M5). A black rectangle over text is not redaction —
//! the text remains in the file. This module removes the underlying
//! content and refuses outright whenever a channel it cannot scrub would
//! still leak the redacted text.
//!
//! Guarantees, in order:
//! 1. **Refusal before removal**: if the text under a redaction region
//!    also appears in document metadata, the outline, an annotation
//!    outside the regions, or a form field value — channels PDFium
//!    offers no way to rewrite — the save fails with a clear error
//!    instead of producing a file that looks redacted but leaks.
//!    Documents with embedded attachments are refused entirely
//!    (attachments can contain anything, in formats we cannot scan).
//! 2. **Whole-object removal**: every text and image object whose
//!    bounds intersect a region is removed from the content stream —
//!    over-redaction by design; partial-glyph editing does not exist in
//!    PDFium's public surface. A page whose intersecting content sits
//!    inside a nested Form XObject is refused (no API to edit inside).
//! 3. **Verification before the rename**: the final serialised bytes
//!    are re-parsed and every region re-extracted; any remaining text
//!    or intersecting image aborts the save, leaving the destination
//!    untouched. This runs in the engine, not only in tests.
//!
//! Saves are always full rewrites (decision 013), so no incremental
//! trail of the removed content survives.

use pdfium_render::prelude::*;
use serde::{Deserialize, Serialize};

use super::annot::{raw_visible_box_origin, AnnotRect, PageSpace};
use super::error::PdfError;

/// One region to redact, in page points relative to the visible box,
/// top-left origin (decision 009). Page index refers to *source* pages.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RedactRegion {
    pub page_index: u16,
    pub rect: AnnotRect,
}

// FPDF_PAGEOBJ_* (fpdf_edit.h).
const OBJ_TEXT: i32 = 1;
const OBJ_IMAGE: i32 = 3;
const OBJ_FORM: i32 = 5;

fn overlaps(a: &FS_RECTF, l: f32, bo: f32, r: f32, t: f32) -> bool {
    a.left < r && l < a.right && a.bottom < t && bo < a.top
}

/// PDF-space rects of the regions on one page.
fn page_regions(
    b: &dyn PdfiumLibraryBindings,
    page: FPDF_PAGE,
    regions: &[RedactRegion],
    page_index: u16,
) -> Vec<FS_RECTF> {
    let (box_left, box_top) = raw_visible_box_origin(b, page);
    let space = PageSpace { box_left, box_top };
    regions
        .iter()
        .filter(|r| r.page_index == page_index)
        .map(|r| space.rect(r.rect))
        .collect()
}

/// The text currently under the regions — what is being redacted.
/// Split into case-folded tokens used by the leak scan.
///
/// # Safety
/// Engine thread; `doc` live on this PDFium instance.
pub unsafe fn collect_region_text(
    b: &dyn PdfiumLibraryBindings,
    doc: FPDF_DOCUMENT,
    regions: &[RedactRegion],
) -> Result<Vec<String>, PdfError> {
    let mut tokens = Vec::new();
    let page_count = unsafe { b.FPDF_GetPageCount(doc) } as u16;
    for page_index in 0..page_count {
        let rects: Vec<&RedactRegion> = regions
            .iter()
            .filter(|r| r.page_index == page_index)
            .collect();
        if rects.is_empty() {
            continue;
        }
        unsafe {
            let page = b.FPDF_LoadPage(doc, i32::from(page_index));
            if page.is_null() {
                continue;
            }
            let pdf_rects = page_regions(b, page, regions, page_index);
            let textpage = b.FPDFText_LoadPage(page);
            if !textpage.is_null() {
                for rc in &pdf_rects {
                    let len = b.FPDFText_GetBoundedText(
                        textpage,
                        f64::from(rc.left),
                        f64::from(rc.top),
                        f64::from(rc.right),
                        f64::from(rc.bottom),
                        std::ptr::null_mut(),
                        0,
                    );
                    if len > 0 {
                        let mut buf = vec![0u16; len as usize];
                        b.FPDFText_GetBoundedText(
                            textpage,
                            f64::from(rc.left),
                            f64::from(rc.top),
                            f64::from(rc.right),
                            f64::from(rc.bottom),
                            buf.as_mut_ptr(),
                            len,
                        );
                        let text = String::from_utf16_lossy(&buf);
                        for token in text.split_whitespace() {
                            // Short tokens ("a", "of") would false-match
                            // everywhere; leaking them alone is not a
                            // meaningful disclosure.
                            if token.chars().count() >= 4 {
                                tokens.push(token.to_lowercase());
                            }
                        }
                    }
                }
                b.FPDFText_ClosePage(textpage);
            }
            b.FPDF_ClosePage(page);
        }
    }
    tokens.sort();
    tokens.dedup();
    Ok(tokens)
}

unsafe fn meta_text(b: &dyn PdfiumLibraryBindings, doc: FPDF_DOCUMENT, key: &str) -> String {
    let len = unsafe { b.FPDF_GetMetaText(doc, key, std::ptr::null_mut(), 0) };
    if len <= 2 {
        return String::new();
    }
    let mut buf = vec![0u16; (len as usize) / 2];
    unsafe { b.FPDF_GetMetaText(doc, key, buf.as_mut_ptr().cast(), len) };
    String::from_utf16_lossy(&buf[..buf.len().saturating_sub(1)])
}

fn leaks(haystack: &str, tokens: &[String]) -> Option<String> {
    let lower = haystack.to_lowercase();
    tokens.iter().find(|t| lower.contains(*t)).cloned()
}

unsafe fn bookmark_titles(
    b: &dyn PdfiumLibraryBindings,
    doc: FPDF_DOCUMENT,
    bookmark: FPDF_BOOKMARK,
    out: &mut String,
) {
    let mut current = bookmark;
    while !current.is_null() {
        unsafe {
            let len = b.FPDFBookmark_GetTitle(current, std::ptr::null_mut(), 0);
            if len > 2 {
                let mut buf = vec![0u16; (len as usize) / 2];
                b.FPDFBookmark_GetTitle(current, buf.as_mut_ptr().cast(), len);
                out.push_str(&String::from_utf16_lossy(&buf[..buf.len() - 1]));
                out.push('\n');
            }
            bookmark_titles(b, doc, b.FPDFBookmark_GetFirstChild(doc, current), out);
            current = b.FPDFBookmark_GetNextSibling(doc, current);
        }
    }
}

/// Refuses the redaction when a channel we cannot scrub carries the
/// redacted text. Returns the offending channel in the error.
///
/// # Safety
/// Engine thread; `doc` live on this PDFium instance.
pub unsafe fn refuse_if_unscrubbable(
    b: &dyn PdfiumLibraryBindings,
    doc: FPDF_DOCUMENT,
    regions: &[RedactRegion],
    tokens: &[String],
) -> Result<(), PdfError> {
    unsafe {
        if b.FPDFDoc_GetAttachmentCount(doc) > 0 {
            return Err(PdfError::Unsupported {
                feature: "redacting a document with embedded attachments \
                          (attachments cannot be scanned for the redacted content)"
                    .into(),
            });
        }
        if tokens.is_empty() {
            return Ok(());
        }

        for key in [
            "Title", "Author", "Subject", "Keywords", "Creator", "Producer",
        ] {
            if let Some(t) = leaks(&meta_text(b, doc, key), tokens) {
                return Err(PdfError::Unsupported {
                    feature: format!(
                        "redaction: \"{t}\" also appears in document metadata ({key}), \
                         which Ibris cannot rewrite"
                    ),
                });
            }
        }

        let mut titles = String::new();
        bookmark_titles(
            b,
            doc,
            b.FPDFBookmark_GetFirstChild(doc, std::ptr::null_mut()),
            &mut titles,
        );
        if let Some(t) = leaks(&titles, tokens) {
            return Err(PdfError::Unsupported {
                feature: format!(
                    "redaction: \"{t}\" also appears in the document outline, \
                     which Ibris cannot rewrite"
                ),
            });
        }

        // Annotations and form-field values document-wide. Annotations
        // *inside* a region are deleted by apply(); everything else that
        // carries the text is a leak we will not silently keep.
        let page_count = b.FPDF_GetPageCount(doc) as u16;
        for page_index in 0..page_count {
            let page = b.FPDF_LoadPage(doc, i32::from(page_index));
            if page.is_null() {
                continue;
            }
            let pdf_rects = page_regions(b, page, regions, page_index);
            let count = b.FPDFPage_GetAnnotCount(page);
            for i in 0..count {
                let annot = b.FPDFPage_GetAnnot(page, i);
                if annot.is_null() {
                    continue;
                }
                let mut rect = FS_RECTF {
                    left: 0.0,
                    top: 0.0,
                    right: 0.0,
                    bottom: 0.0,
                };
                b.FPDFAnnot_GetRect(annot, &mut rect);
                let doomed = pdf_rects
                    .iter()
                    .any(|rc| overlaps(rc, rect.left, rect.bottom, rect.right, rect.top));
                if !doomed {
                    for key in ["Contents", "V", "T"] {
                        let len = b.FPDFAnnot_GetStringValue(annot, key, std::ptr::null_mut(), 0);
                        if len > 2 {
                            let mut buf = vec![0u16; (len as usize) / 2];
                            b.FPDFAnnot_GetStringValue(annot, key, buf.as_mut_ptr(), len);
                            let value = String::from_utf16_lossy(&buf[..buf.len() - 1]);
                            if let Some(t) = leaks(&value, tokens) {
                                b.FPDFPage_CloseAnnot(annot);
                                b.FPDF_ClosePage(page);
                                return Err(PdfError::Unsupported {
                                    feature: format!(
                                        "redaction: \"{t}\" also appears in an annotation or \
                                         form field on page {} — delete or clear it first",
                                        page_index + 1
                                    ),
                                });
                            }
                        }
                    }
                }
                b.FPDFPage_CloseAnnot(annot);
            }
            b.FPDF_ClosePage(page);
        }
    }
    Ok(())
}

/// Removes every text and image object intersecting a region, deletes
/// intersecting annotations, draws a black marker box, and regenerates
/// the content stream. Fails when intersecting content hides inside a
/// nested Form XObject (nothing in PDFium can edit those in place).
///
/// # Safety
/// Engine thread; `doc` live on this PDFium instance.
pub unsafe fn apply(
    b: &dyn PdfiumLibraryBindings,
    doc: FPDF_DOCUMENT,
    regions: &[RedactRegion],
) -> Result<(), PdfError> {
    let page_count = unsafe { b.FPDF_GetPageCount(doc) } as u16;
    for page_index in 0..page_count {
        if !regions.iter().any(|r| r.page_index == page_index) {
            continue;
        }
        unsafe {
            let page = b.FPDF_LoadPage(doc, i32::from(page_index));
            if page.is_null() {
                return Err(PdfError::Internal {
                    detail: format!("failed to load page {page_index} for redaction"),
                });
            }
            let result = redact_page(b, page, &page_regions(b, page, regions, page_index));
            b.FPDF_ClosePage(page);
            result.map_err(|e| match e {
                PdfError::Unsupported { feature } => PdfError::Unsupported {
                    feature: format!("{feature} (page {})", page_index + 1),
                },
                other => other,
            })?;
        }
    }
    Ok(())
}

unsafe fn redact_page(
    b: &dyn PdfiumLibraryBindings,
    page: FPDF_PAGE,
    rects: &[FS_RECTF],
) -> Result<(), PdfError> {
    unsafe {
        // Pass 1: find doomed objects (pointers stay valid across removal).
        let count = b.FPDFPage_CountObjects(page);
        let mut doomed = Vec::new();
        for i in 0..count {
            let obj = b.FPDFPage_GetObject(page, i);
            if obj.is_null() {
                continue;
            }
            let (mut l, mut bo, mut r, mut t) = (0f32, 0f32, 0f32, 0f32);
            if b.FPDFPageObj_GetBounds(obj, &mut l, &mut bo, &mut r, &mut t) == 0 {
                continue;
            }
            let hit = rects.iter().any(|rc| overlaps(rc, l, bo, r, t));
            if !hit {
                continue;
            }
            match b.FPDFPageObj_GetType(obj) {
                OBJ_TEXT | OBJ_IMAGE => doomed.push(obj),
                OBJ_FORM => {
                    // Content inside a nested form object cannot be edited
                    // through PDFium; removing the whole form could erase
                    // unrelated content silently. Refuse.
                    return Err(PdfError::Unsupported {
                        feature: "redaction over content inside a nested form object".into(),
                    });
                }
                _ => {}
            }
        }
        for obj in doomed {
            if b.FPDFPage_RemoveObject(page, obj) == 0 {
                return Err(PdfError::Internal {
                    detail: "removing a redacted object failed".into(),
                });
            }
            b.FPDFPageObj_Destroy(obj);
        }

        // Intersecting annotations go too (their /AP can carry the text).
        let acount = b.FPDFPage_GetAnnotCount(page);
        for i in (0..acount).rev() {
            let annot = b.FPDFPage_GetAnnot(page, i);
            if annot.is_null() {
                continue;
            }
            let mut rect = FS_RECTF {
                left: 0.0,
                top: 0.0,
                right: 0.0,
                bottom: 0.0,
            };
            b.FPDFAnnot_GetRect(annot, &mut rect);
            b.FPDFPage_CloseAnnot(annot);
            if rects
                .iter()
                .any(|rc| overlaps(rc, rect.left, rect.bottom, rect.right, rect.top))
            {
                b.FPDFPage_RemoveAnnot(page, i);
            }
        }

        // Black marker box per region: visible evidence of the redaction.
        for rc in rects {
            let box_obj = b.FPDFPageObj_CreateNewRect(
                rc.left,
                rc.bottom,
                rc.right - rc.left,
                rc.top - rc.bottom,
            );
            if !box_obj.is_null() {
                b.FPDFPageObj_SetFillColor(box_obj, 0, 0, 0, 255);
                b.FPDFPath_SetDrawMode(box_obj, 1 /* fill */, 0);
                b.FPDFPage_InsertObject(page, box_obj);
            }
        }

        if b.FPDFPage_GenerateContent(page) == 0 {
            return Err(PdfError::Internal {
                detail: "regenerating redacted page content failed".into(),
            });
        }
    }
    Ok(())
}

/// Re-parses the final bytes and proves the regions are clean: no
/// extractable text, no intersecting image objects. Any failure aborts
/// the save before the atomic rename — this runs in the engine, always,
/// not only in tests.
pub fn verify(
    b: &dyn PdfiumLibraryBindings,
    bytes: &[u8],
    regions: &[RedactRegion],
) -> Result<(), PdfError> {
    unsafe {
        let doc = b.FPDF_LoadMemDocument64(bytes, None);
        if doc.is_null() {
            return Err(PdfError::Internal {
                detail: "redaction verification: output failed to parse".into(),
            });
        }
        let result = (|| {
            let page_count = b.FPDF_GetPageCount(doc) as u16;
            for page_index in 0..page_count {
                if !regions.iter().any(|r| r.page_index == page_index) {
                    continue;
                }
                let page = b.FPDF_LoadPage(doc, i32::from(page_index));
                if page.is_null() {
                    continue;
                }
                let rects = page_regions(b, page, regions, page_index);
                let check = (|| {
                    let textpage = b.FPDFText_LoadPage(page);
                    if !textpage.is_null() {
                        for rc in &rects {
                            let len = b.FPDFText_GetBoundedText(
                                textpage,
                                f64::from(rc.left),
                                f64::from(rc.top),
                                f64::from(rc.right),
                                f64::from(rc.bottom),
                                std::ptr::null_mut(),
                                0,
                            );
                            if len > 0 {
                                let mut buf = vec![0u16; len as usize];
                                b.FPDFText_GetBoundedText(
                                    textpage,
                                    f64::from(rc.left),
                                    f64::from(rc.top),
                                    f64::from(rc.right),
                                    f64::from(rc.bottom),
                                    buf.as_mut_ptr(),
                                    len,
                                );
                                let left = String::from_utf16_lossy(&buf);
                                if !left.trim().is_empty() {
                                    b.FPDFText_ClosePage(textpage);
                                    return Err(PdfError::Internal {
                                        detail: format!(
                                            "redaction verification failed: text remains on \
                                             page {}",
                                            page_index + 1
                                        ),
                                    });
                                }
                            }
                        }
                        b.FPDFText_ClosePage(textpage);
                    }
                    let count = b.FPDFPage_CountObjects(page);
                    for i in 0..count {
                        let obj = b.FPDFPage_GetObject(page, i);
                        if obj.is_null() || b.FPDFPageObj_GetType(obj) != OBJ_IMAGE {
                            continue;
                        }
                        let (mut l, mut bo, mut r, mut t) = (0f32, 0f32, 0f32, 0f32);
                        if b.FPDFPageObj_GetBounds(obj, &mut l, &mut bo, &mut r, &mut t) != 0
                            && rects.iter().any(|rc| overlaps(rc, l, bo, r, t))
                        {
                            return Err(PdfError::Internal {
                                detail: format!(
                                    "redaction verification failed: an image remains on \
                                     page {}",
                                    page_index + 1
                                ),
                            });
                        }
                    }
                    Ok(())
                })();
                b.FPDF_ClosePage(page);
                check?;
            }
            Ok(())
        })();
        b.FPDF_CloseDocument(doc);
        result
    }
}

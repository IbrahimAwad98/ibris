//! AcroForm support: reading field structure (safe API, viewing document)
//! and filling values at save (raw form-fill environment, engine thread).
//!
//! Values are applied through PDFium's form-fill event pipeline (focus →
//! select all → replace → kill focus) rather than by writing /V directly,
//! because only the pipeline regenerates the widget's appearance stream —
//! a /V-only write shows the old text in every reader that draws /AP.
//!
//! XFA forms are detected and reported, never rendered interactively:
//! Ibris does not execute XFA (M4; XFA is a dead, JavaScript-adjacent
//! format PDFium only partially supports).

use pdfium_render::prelude::*;
use serde::{Deserialize, Serialize};

use super::annot::AnnotRect;
use super::error::PdfError;

/// FPDF_ANNOT_WIDGET (fpdf_annot.h).
const SUBTYPE_WIDGET: i32 = 20;
/// FLATTEN_NORMALDISPLAY (fpdf_flatten.h).
const FLATTEN_NORMAL: i32 = 0;
/// FPDFPage_Flatten success codes (fpdf_flatten.h).
const FLATTEN_SUCCESS: i32 = 1;
const FLATTEN_NOTHINGTODO: i32 = 2;

/// One interactive widget as the frontend sees it. Radio groups produce
/// one entry per button (same `name`, distinct `kid` and rect).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FormFieldInfo {
    pub name: String,
    /// "text" | "checkbox" | "radio" | "combo" | "list" | "other"
    pub kind: String,
    pub page_index: u16,
    /// Top-left origin, page points relative to the visible box (009).
    pub rect: AnnotRect,
    /// Current textual value (text/combo/list).
    pub value: String,
    /// Current checked state (checkbox/radio).
    pub checked: bool,
    /// Option labels (combo/list).
    pub options: Vec<String>,
    /// Position of this widget within its same-named group (radio kids).
    pub kid: u16,
    pub multiline: bool,
    pub read_only: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FormInfo {
    /// "none" | "acroform" | "xfa"
    pub form_type: String,
    pub fields: Vec<FormFieldInfo>,
}

impl FormInfo {
    pub fn none() -> FormInfo {
        FormInfo {
            form_type: "none".into(),
            fields: Vec::new(),
        }
    }
}

/// A field value to write at save. `kid`/`indices` reference the same
/// enumeration order `read_form` reported.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum FieldWrite {
    Text { name: String, value: String },
    Checkbox { name: String, checked: bool },
    Radio { name: String, kid: u16 },
    Choice { name: String, indices: Vec<u16> },
}

impl FieldWrite {
    fn name(&self) -> &str {
        match self {
            FieldWrite::Text { name, .. }
            | FieldWrite::Checkbox { name, .. }
            | FieldWrite::Radio { name, .. }
            | FieldWrite::Choice { name, .. } => name,
        }
    }
}

/// Reads the document's form structure through the safe API. Never fails:
/// a document without a form (or with an unreadable one) yields
/// `FormInfo::none()`.
pub fn read_form(document: &PdfDocument<'_>) -> FormInfo {
    let form_type = match document.form().map(|f| f.form_type()) {
        None | Some(PdfFormType::None) => return FormInfo::none(),
        Some(PdfFormType::Acrobat) => "acroform",
        // Any XFA flavour: report, never pretend to render it correctly.
        Some(_) => "xfa",
    };

    let mut fields = Vec::new();
    let mut kid_counter: std::collections::HashMap<String, u16> = std::collections::HashMap::new();
    if form_type == "acroform" {
        for (page_index, page) in document.pages().iter().enumerate() {
            let (box_left, box_top) = super::text::visible_box_origin(&page);
            for annot in page.annotations().iter() {
                let Some(field) = annot.as_form_field() else {
                    continue;
                };
                let Ok(bounds) = annot.bounds() else {
                    continue;
                };
                let rect = AnnotRect {
                    x: bounds.left().value - box_left,
                    y: box_top - bounds.top().value,
                    width: bounds.width().value,
                    height: bounds.height().value,
                };
                let name = match field_name(field) {
                    Some(n) => n,
                    None => continue,
                };
                let kid = {
                    let c = kid_counter.entry(name.clone()).or_insert(0);
                    let k = *c;
                    *c += 1;
                    k
                };
                let mut info = FormFieldInfo {
                    name,
                    kind: "other".into(),
                    page_index: page_index as u16,
                    rect,
                    value: String::new(),
                    checked: false,
                    options: Vec::new(),
                    kid,
                    multiline: false,
                    read_only: read_only_of(field),
                };
                match field {
                    PdfFormField::Text(f) => {
                        info.kind = "text".into();
                        info.value = f.value().unwrap_or_default();
                        info.multiline = f.is_multiline();
                    }
                    PdfFormField::Checkbox(f) => {
                        info.kind = "checkbox".into();
                        info.checked = f.is_checked().unwrap_or(false);
                    }
                    PdfFormField::RadioButton(f) => {
                        info.kind = "radio".into();
                        info.checked = f.is_checked().unwrap_or(false);
                    }
                    PdfFormField::ComboBox(f) => {
                        info.kind = "combo".into();
                        info.value = f.value().unwrap_or_default();
                        info.options = f
                            .options()
                            .iter()
                            .map(|o| o.label().cloned().unwrap_or_default())
                            .collect();
                    }
                    PdfFormField::ListBox(f) => {
                        info.kind = "list".into();
                        info.value = f.value().unwrap_or_default();
                        info.options = f
                            .options()
                            .iter()
                            .map(|o| o.label().cloned().unwrap_or_default())
                            .collect();
                    }
                    _ => {}
                }
                fields.push(info);
            }
        }
    }
    FormInfo {
        form_type: form_type.into(),
        fields,
    }
}

fn field_name(field: &PdfFormField<'_>) -> Option<String> {
    match field {
        PdfFormField::Text(f) => f.name(),
        PdfFormField::Checkbox(f) => f.name(),
        PdfFormField::RadioButton(f) => f.name(),
        PdfFormField::ComboBox(f) => f.name(),
        PdfFormField::ListBox(f) => f.name(),
        _ => None,
    }
}

fn read_only_of(field: &PdfFormField<'_>) -> bool {
    match field {
        PdfFormField::Text(f) => f.is_read_only(),
        PdfFormField::Checkbox(f) => f.is_read_only(),
        PdfFormField::RadioButton(f) => f.is_read_only(),
        PdfFormField::ComboBox(f) => f.is_read_only(),
        PdfFormField::ListBox(f) => f.is_read_only(),
        _ => true,
    }
}

/// Reads a UTF-16LE string via a (form, annot) getter with the usual
/// PDFium two-call length dance.
unsafe fn widget_name(
    b: &dyn PdfiumLibraryBindings,
    form: FPDF_FORMHANDLE,
    annot: FPDF_ANNOTATION,
) -> String {
    let len = b.FPDFAnnot_GetFormFieldName(form, annot, std::ptr::null_mut(), 0);
    if len <= 2 {
        return String::new();
    }
    let mut buf = vec![0u16; (len as usize) / 2];
    b.FPDFAnnot_GetFormFieldName(form, annot, buf.as_mut_ptr(), len);
    String::from_utf16_lossy(&buf[..buf.len().saturating_sub(1)])
}

unsafe fn widget_value(
    b: &dyn PdfiumLibraryBindings,
    form: FPDF_FORMHANDLE,
    annot: FPDF_ANNOTATION,
) -> String {
    let len = b.FPDFAnnot_GetFormFieldValue(form, annot, std::ptr::null_mut(), 0);
    if len <= 2 {
        return String::new();
    }
    let mut buf = vec![0u16; (len as usize) / 2];
    b.FPDFAnnot_GetFormFieldValue(form, annot, buf.as_mut_ptr(), len);
    String::from_utf16_lossy(&buf[..buf.len().saturating_sub(1)])
}

/// Applies `values` to `doc` through a temporary form-fill environment so
/// PDFium regenerates widget appearances. Fails when the environment
/// cannot be created; unknown field names are ignored (the file may have
/// changed since the model was built — a missing field must not kill the
/// whole save).
///
/// # Safety
/// `doc` must be a live document handle from the same PDFium instance as
/// `b`, and the caller must be on the engine thread (decision 008).
pub unsafe fn apply_form_values(
    b: &dyn PdfiumLibraryBindings,
    doc: FPDF_DOCUMENT,
    values: &[FieldWrite],
) -> Result<(), PdfError> {
    if values.is_empty() {
        return Ok(());
    }
    // The callback table can be all-null: we never run scripts and pump no
    // UI events, we only need the fill module's commit machinery.
    let mut ffi: FPDF_FORMFILLINFO = unsafe { std::mem::zeroed() };
    ffi.version = 2;
    let form = unsafe { b.FPDFDOC_InitFormFillEnvironment(doc, &mut ffi) };
    if form.is_null() {
        return Err(PdfError::Internal {
            detail: "FPDFDOC_InitFormFillEnvironment failed".into(),
        });
    }

    let result = unsafe { apply_with_env(b, doc, form, values) };
    unsafe { b.FPDFDOC_ExitFormFillEnvironment(form) };
    result
}

unsafe fn apply_with_env(
    b: &dyn PdfiumLibraryBindings,
    doc: FPDF_DOCUMENT,
    form: FPDF_FORMHANDLE,
    values: &[FieldWrite],
) -> Result<(), PdfError> {
    let page_count = unsafe { b.FPDF_GetPageCount(doc) };
    let mut kid_counter: std::collections::HashMap<String, u16> = std::collections::HashMap::new();

    for page_index in 0..page_count {
        unsafe {
            let page = b.FPDF_LoadPage(doc, page_index);
            if page.is_null() {
                continue;
            }
            b.FORM_OnAfterLoadPage(page, form);
            let count = b.FPDFPage_GetAnnotCount(page);
            for i in 0..count {
                let annot = b.FPDFPage_GetAnnot(page, i);
                if annot.is_null() {
                    continue;
                }
                if b.FPDFAnnot_GetSubtype(annot) != SUBTYPE_WIDGET {
                    b.FPDFPage_CloseAnnot(annot);
                    continue;
                }
                let name = widget_name(b, form, annot);
                let kid = {
                    let c = kid_counter.entry(name.clone()).or_insert(0);
                    let k = *c;
                    *c += 1;
                    k
                };
                for write in values.iter().filter(|w| w.name() == name) {
                    apply_one(b, form, page, annot, kid, write);
                }
                b.FPDFPage_CloseAnnot(annot);
            }
            b.FORM_OnBeforeClosePage(page, form);
            b.FPDF_ClosePage(page);
        }
    }
    Ok(())
}

unsafe fn apply_one(
    b: &dyn PdfiumLibraryBindings,
    form: FPDF_FORMHANDLE,
    page: FPDF_PAGE,
    annot: FPDF_ANNOTATION,
    kid: u16,
    write: &FieldWrite,
) {
    unsafe {
        match write {
            FieldWrite::Text { value, .. } => {
                if b.FORM_SetFocusedAnnot(form, annot) == 0 {
                    return;
                }
                b.FORM_SelectAllText(form, page);
                let wide: Vec<u16> = value.encode_utf16().chain(std::iter::once(0)).collect();
                b.FORM_ReplaceSelection(form, page, wide.as_ptr());
                // Kill focus commits the value and regenerates the /AP.
                b.FORM_ForceToKillFocus(form);
            }
            FieldWrite::Checkbox { checked, .. } => {
                let is_on = widget_value(b, form, annot) != "Off";
                if is_on != *checked {
                    toggle_with_space(b, form, page, annot);
                }
            }
            FieldWrite::Radio { kid: wanted, .. } => {
                if kid == *wanted {
                    toggle_with_space(b, form, page, annot);
                }
            }
            FieldWrite::Choice { indices, .. } => {
                if b.FORM_SetFocusedAnnot(form, annot) == 0 {
                    return;
                }
                let count = b.FPDFAnnot_GetOptionCount(form, annot);
                for idx in 0..count {
                    let selected = indices.contains(&(idx as u16));
                    b.FORM_SetIndexSelected(form, page, idx, i32::from(selected));
                }
                b.FORM_ForceToKillFocus(form);
            }
        }
    }
}

/// Toggles a checkbox/radio the way PDFium's own keyboard handling does:
/// focus the widget and send a space character. PDFium updates /V, /AS,
/// and the appearance for us.
unsafe fn toggle_with_space(
    b: &dyn PdfiumLibraryBindings,
    form: FPDF_FORMHANDLE,
    page: FPDF_PAGE,
    annot: FPDF_ANNOTATION,
) {
    unsafe {
        if b.FORM_SetFocusedAnnot(form, annot) == 0 {
            return;
        }
        b.FORM_OnChar(form, page, i32::from(b' '), 0);
        b.FORM_ForceToKillFocus(form);
    }
}

/// Flattens every page: annotations and form fields become ordinary page
/// content. Irreversible in the output file by design — the save pipeline
/// only calls this for an explicit, undoable-before-save flatten command.
///
/// # Safety
/// `doc` must be a live document handle from the same PDFium instance as
/// `b`, and the caller must be on the engine thread (decision 008).
pub unsafe fn flatten_all_pages(
    b: &dyn PdfiumLibraryBindings,
    doc: FPDF_DOCUMENT,
) -> Result<(), PdfError> {
    let page_count = unsafe { b.FPDF_GetPageCount(doc) };
    for page_index in 0..page_count {
        unsafe {
            let page = b.FPDF_LoadPage(doc, page_index);
            if page.is_null() {
                continue;
            }
            let rc = b.FPDFPage_Flatten(page, FLATTEN_NORMAL);
            b.FPDF_ClosePage(page);
            if rc != FLATTEN_SUCCESS && rc != FLATTEN_NOTHINGTODO {
                return Err(PdfError::Internal {
                    detail: format!("flattening page {page_index} failed"),
                });
            }
        }
    }
    Ok(())
}

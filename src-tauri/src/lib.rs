mod commands;
pub mod pdf;

use pdf::service::PdfService;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let result = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(PdfService::new())
        .invoke_handler(tauri::generate_handler![
            commands::pdf::open_document,
            commands::pdf::render_page,
            commands::pdf::render_tile,
            commands::pdf::extract_text,
            commands::pdf::search_range,
            commands::pdf::get_outline,
            commands::pdf::cancel_render,
            commands::pdf::cancel_renders,
            commands::pdf::save_document,
            commands::pdf::merge_documents,
            commands::pdf::close_document,
            commands::pdf::set_active_document,
            commands::sidecar::file_fingerprint,
            commands::sidecar::sidecar_read,
            commands::sidecar::sidecar_write,
            commands::sidecar::sidecar_delete,
        ])
        .run(tauri::generate_context!());

    if let Err(e) = result {
        eprintln!("fatal: failed to start ibris: {e}");
        std::process::exit(1);
    }
}

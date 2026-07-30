mod commands;
pub mod pdf;

use pdf::service::PdfService;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let result = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(PdfService::new())
        .invoke_handler(tauri::generate_handler![
            commands::pdf::open_document,
            commands::pdf::render_page,
            commands::pdf::cancel_render,
            commands::pdf::close_document,
        ])
        .run(tauri::generate_context!());

    if let Err(e) = result {
        eprintln!("fatal: failed to start ibris: {e}");
        std::process::exit(1);
    }
}

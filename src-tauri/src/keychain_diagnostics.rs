//! Read-only diagnostics in the ordinary development executable, not a test app.
use tauri::{AppHandle, Manager};

use crate::llm::{routes::RouteStore, runtime::LlmRuntime};

fn check_default_model_credential(routes: &RouteStore) -> Result<(), String> {
    let snapshot = routes.snapshot()?;
    let selection = snapshot
        .default_selection
        .as_ref()
        .ok_or("NO_DEFAULT_MODEL")?;
    let route = snapshot
        .routes
        .iter()
        .find(|route| route.id == selection.route_id)
        .ok_or("DEFAULT_ROUTE_NOT_FOUND")?;
    // An unauthenticated route cannot establish that Keychain reads work.
    if routes.credential(route)?.is_none() {
        return Err("DEFAULT_ROUTE_HAS_NO_KEYCHAIN_CREDENTIAL".into());
    }
    Ok(())
}

pub(super) fn start(app: AppHandle) -> Result<(), tauri::Error> {
    // Keep a diagnostic process from restoring or saving the user's workspace.
    // The normal executable and its credential backend remain unchanged.
    if let Some(window) = app.get_webview_window("main") {
        window.navigate("about:blank".parse().expect("valid static blank URL"))?;
    }
    let routes = app.state::<LlmRuntime>().routes.clone();
    tauri::async_runtime::spawn_blocking(move || {
        if let Ok(executable) = std::env::current_exe() {
            println!("KEYCHAIN_ACCESS_EXECUTABLE: {}", executable.display());
        }
        println!("KEYCHAIN_ACCESS_CHECK: reading the configured default model credential");
        let code = match check_default_model_credential(&routes) {
            Ok(()) => {
                println!(
                    "KEYCHAIN_ACCESS_OK: default model credential read by the normal executable"
                );
                0
            }
            Err(error) => {
                eprintln!("KEYCHAIN_ACCESS_FAILED: {error}");
                1
            }
        };
        app.exit(code);
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_unconfigured_normal_installation_does_not_report_keychain_success() {
        let root = tempfile::tempdir().unwrap();
        let database = crate::db::Database::open(&root.path().join("diagnostics.db")).unwrap();
        let routes = RouteStore::open(database, crate::keychain::CredentialManager::new()).unwrap();
        assert_eq!(
            check_default_model_credential(&routes).unwrap_err(),
            "NO_DEFAULT_MODEL"
        );
    }
}

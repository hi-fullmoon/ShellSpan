#![allow(clippy::too_many_arguments)]

mod agent_runtime;
mod ai;
mod ai_attachment;
mod ai_file_actions;
mod commands;
mod connection;
mod db;
mod directory_request_registry;
mod execution;
mod file_actions;
mod frontend_storage;
mod health;
mod identity_cache;
mod keychain;
#[cfg(debug_assertions)]
mod keychain_diagnostics;
mod known_hosts;
mod llm;
mod local_fs;
mod local_terminal_input;
mod log_reader;
mod menu;
mod models;
mod path_utils;
mod petdex;
mod port_forward;
mod redaction;
mod remote_fs;
mod remote_health;
mod remote_sandbox;
mod runbook;
mod session;
mod sftp_pool;
mod sudo_policy;
pub mod terminal_broker;
mod terminal_command;
pub(crate) mod terminal_display_origin;
mod terminal_display_recovery;
pub(crate) mod terminal_integration;
pub(crate) mod terminal_jobs;
#[cfg(all(test, unix))]
#[path = "tests/terminal_native_protocol.rs"]
mod terminal_native_protocol;
mod terminal_recorder;
pub(crate) mod terminal_screen;
mod terminal_vim_bridge;
#[cfg(all(test, windows))]
#[path = "tests/windows_shell_history.rs"]
mod windows_shell_history;

use log::LevelFilter;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_log::{Target, TargetKind, WEBVIEW_TARGET};

use crate::sftp_pool::SftpPool;
use directory_request_registry::DirectoryRequestRegistry;
use models::{
    ClosedEvent, ClosedReasonKind, DeleteCancellationRegistry, PreflightCancellationRegistry,
};
use models::{
    DownloadCancellationRegistry, RemoteCopyCancellationRegistry,
    RemoteFileReadCancellationRegistry, RemoteHealthCancellationRegistry, SessionErrorEvent,
    SessionIdentity, SessionManager, SessionStatus, StatusEvent, UploadCancellationRegistry,
};

pub(crate) use connection::{
    summarize_remote_connection_request, summarize_session_request, validate_connection_fields,
};
pub(crate) use identity_cache::RemoteIdentityCache;
pub(crate) use local_fs::{
    copy_local_paths_blocking, paste_local_paths_blocking, read_local_file_blocking,
    rename_local_path_blocking, trash_local_paths_blocking,
};
pub(crate) use path_utils::{portable_local_path, posix_join, shellspan_data_dir};
pub(crate) use remote_fs::{
    copy_remote_path_blocking, copy_remote_to_remote_blocking, create_remote_entry_blocking,
    delete_remote_path_blocking, download_remote_paths_blocking, list_remote_directory_blocking,
    open_remote_file_blocking, read_remote_file_blocking, rename_remote_path_blocking,
    resolve_remote_entry_owners_blocking, update_remote_permissions_blocking,
    upload_local_paths_blocking, warm_remote_connection_blocking,
};
pub(crate) use session::{
    classify_closed_reason, is_transport_disconnect_message, run_ssh_session, session_wake_pair,
    SessionWakeSource,
};

pub(crate) const SSH_DATA_EVENT_PREFIX: &str = "ssh-data:";
pub(crate) const SSH_STATUS_EVENT: &str = "ssh-status";

pub(crate) const SSH_CLOSED_EVENT: &str = "ssh-closed";
pub(crate) const SSH_SESSION_ERROR_EVENT: &str = "ssh-session-error";
pub(crate) const UPLOAD_PROGRESS_EVENT: &str = "upload-progress";
pub(crate) const DELETE_PROGRESS_EVENT: &str = "delete-progress";
pub(crate) const DOWNLOAD_PROGRESS_EVENT: &str = "download-progress";
pub(crate) const REMOTE_COPY_PROGRESS_EVENT: &str = "remote-copy-progress";

pub(crate) fn emit_status(
    app: &AppHandle,
    session_id: &str,
    status: SessionStatus,
    message: Option<String>,
) -> Result<(), String> {
    let event = StatusEvent {
        session_id: session_id.to_string(),
        status,
        message,
    };
    if let Some(sessions) = app.try_state::<SessionManager>() {
        let _ = sessions.set_status(session_id, event.clone());
    }
    app.emit(SSH_STATUS_EVENT, event)
        .map_err(|error| format!("failed to emit status event: {error}"))
}

pub(crate) fn emit_data(
    app: &AppHandle,
    session_id: &str,
    mut chunk: String,
) -> Result<(), String> {
    if chunk.is_empty() {
        return Ok(());
    }
    if let Some(runtime) = app.try_state::<agent_runtime::AgentRuntime>() {
        if let Ok(Some(frame)) = runtime
            .terminal_broker()
            .observe_display_output(session_id, &chunk)
        {
            if let Err(error) = app.emit(&format!("terminal-display:{session_id}"), &frame) {
                log::warn!("Failed to emit sequenced terminal display output session_id={session_id}: {error}");
            }
            chunk = frame.text;
        }
    }
    app.emit(&format!("{SSH_DATA_EVENT_PREFIX}{session_id}"), chunk)
        .map_err(|error| format!("failed to emit data event: {error}"))
}

/// Shadows raw transport output into TSP/1 before any UTF-8 decoding or legacy
/// Agent wrapper filtering. Broker failures are diagnostic in Phase 2: the
/// established display path remains authoritative and keeps running.
pub(crate) fn observe_terminal_raw_output(app: &AppHandle, session_id: &str, bytes: &[u8]) {
    if let Some(recorder) = app.try_state::<terminal_recorder::TerminalRecorder>() {
        recorder.output(session_id, bytes);
    }
    if let Some(runtime) = app.try_state::<agent_runtime::AgentRuntime>() {
        #[cfg(all(
            feature = "native-input-acceptance",
            debug_assertions,
            target_os = "macos",
            target_arch = "aarch64"
        ))]
        match runtime.observe_terminal_raw_output(session_id, bytes) {
            Err(error) => log::warn!(
                "Terminal broker raw-output observation failed session_id={session_id} byte_count={}: {error}",
                bytes.len()
            ),
            Ok(Some(frame)) => {
                if commands::terminal_acceptance_directory().is_ok() {
                    if let Err(error) = app.emit(
                        "terminal-acceptance-raw-output",
                        serde_json::json!({"transportSessionId": session_id, "frame": frame}),
                    ) {
                        log::warn!("Acceptance raw-frame observation delivery failed session_id={session_id}: {error}");
                    }
                }
            }
            Ok(None) => {}
        }
        #[cfg(not(all(
            feature = "native-input-acceptance",
            debug_assertions,
            target_os = "macos",
            target_arch = "aarch64"
        )))]
        if let Err(error) = runtime
            .terminal_broker()
            .observe_raw_output_discard(session_id, bytes)
        {
            log::warn!(
                "Terminal broker raw-output observation failed session_id={session_id} byte_count={}: {error}",
                bytes.len()
            );
        }
    }
}

/// Incrementally decodes UTF-8 from `pending_bytes` into `output`. An
/// incomplete multi-byte sequence at the tail stays in `pending_bytes` for
/// the next call; invalid bytes are replaced with U+FFFD.
pub(crate) fn drain_decoded_output(pending_bytes: &mut Vec<u8>, output: &mut String) {
    let mut cursor = 0;
    while cursor < pending_bytes.len() {
        match std::str::from_utf8(&pending_bytes[cursor..]) {
            Ok(text) => {
                output.push_str(text);
                pending_bytes.clear();
                return;
            }
            Err(error) => {
                let valid_up_to = error.valid_up_to();
                if valid_up_to > 0 {
                    output.push_str(
                        std::str::from_utf8(&pending_bytes[cursor..cursor + valid_up_to])
                            .expect("valid_up_to marks a valid UTF-8 prefix"),
                    );
                    cursor += valid_up_to;
                }
                match error.error_len() {
                    Some(invalid_len) => {
                        output.push('\u{FFFD}');
                        cursor += invalid_len;
                    }
                    None => {
                        break;
                    }
                }
            }
        }
    }
    if cursor > 0 {
        pending_bytes.drain(..cursor);
    }
}

/// Emits whatever decoded output remains when a session ends, lossy-decoding
/// any bytes still stuck in the incremental decode buffer. Emit failures are
/// logged and swallowed: the session is ending anyway, so a dead frontend
/// listener must not mask the real session result.
pub(crate) fn flush_pending_output(
    app: &AppHandle,
    session_id: &str,
    pending_bytes: &mut Vec<u8>,
    pending_output: &mut String,
) {
    if !pending_bytes.is_empty() {
        pending_output.push_str(&String::from_utf8_lossy(pending_bytes));
        pending_bytes.clear();
    }
    if !pending_output.is_empty() {
        if let Err(error) = emit_data(app, session_id, std::mem::take(pending_output)) {
            log::warn!("Failed to emit final session output session_id={session_id}: {error}");
        }
    }
}

pub(crate) fn emit_closed(
    app: &AppHandle,
    session_id: &str,
    identity: Option<SessionIdentity>,
    reason: Option<String>,
    reason_kind: ClosedReasonKind,
    retryable: bool,
) -> Result<(), String> {
    if let Some(recorder) = app.try_state::<terminal_recorder::TerminalRecorder>() {
        recorder.close(session_id);
    }
    if let Some(runtime) = app.try_state::<agent_runtime::AgentRuntime>() {
        if let Err(error) = runtime.terminal_closed(session_id) {
            log::warn!("Failed to clean Agent terminal lease after terminal close session_id={session_id}: {error}");
        }
        let broker_reason = match reason_kind {
            ClosedReasonKind::LocalClose => {
                terminal_broker::TerminalGenerationCloseReason::UserClosed
            }
            ClosedReasonKind::RemoteExit => {
                terminal_broker::TerminalGenerationCloseReason::RemoteExit
            }
            ClosedReasonKind::ControllerDropped
            | ClosedReasonKind::TransportDisconnect
            | ClosedReasonKind::Error => {
                terminal_broker::TerminalGenerationCloseReason::TransportDisconnected
            }
        };
        if let Err(error) = runtime.close_terminal_broker_transport(session_id, broker_reason) {
            log::warn!(
                "Failed to close terminal broker generation session_id={session_id}: {error}"
            );
        }
        commands::emit_terminal_integration_state(app, session_id);
    }
    app.emit(
        SSH_CLOSED_EVENT,
        ClosedEvent {
            session_id: session_id.to_string(),
            identity,
            reason,
            reason_kind,
            retryable,
        },
    )
    .map_err(|error| format!("failed to emit closed event: {error}"))
}

pub(crate) fn emit_session_error(app: &AppHandle, event: SessionErrorEvent) -> Result<(), String> {
    app.emit(SSH_SESSION_ERROR_EVENT, event)
        .map_err(|error| format!("failed to emit session error event: {error}"))
}

pub fn run() {
    let log_level = if cfg!(debug_assertions) {
        LevelFilter::Debug
    } else {
        LevelFilter::Info
    };

    let builder = tauri::Builder::default();
    // Register first so duplicate development processes exit before opening
    // the database or initializing other plugins. The app identifier scopes
    // the lock independently from release builds and isolated native checks.
    #[cfg(all(
        debug_assertions,
        any(target_os = "macos", target_os = "windows", target_os = "linux")
    ))]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _, _| {
        if let Err(error) = menu::show_main_window(app) {
            log::error!("failed to restore existing development window: {error}");
        }
    }));

    let builder = builder
        .setup(move |app| {
            #[cfg(target_os = "macos")]
            {
                if let Some(window) = app.get_webview_window("main") {
                    window.set_title("").ok();
                }
            }
            let home_dir = app.path().home_dir()?;
            #[cfg(all(
                feature = "native-input-acceptance",
                debug_assertions,
                target_os = "macos",
                target_arch = "aarch64"
            ))]
            if std::env::var("SHELLSPAN_ACCEPTANCE_SUBMISSION").as_deref() == Ok("1") {
                let evidence =
                    commands::terminal_acceptance_directory().map_err(std::io::Error::other)?;
                if agent_runtime::mac_sandbox_trial_active() {
                    let directory = evidence.clone();
                    tauri::async_runtime::spawn_blocking(move || {
                        agent_runtime::recover_mac_sandbox_workspace(directory);
                    });
                }
                if !terminal_command::acceptance_trace::ssh_recovery_enabled()
                    && !agent_runtime::mac_sandbox_preview_active()
                {
                    assert_eq!(home_dir, evidence.join("home"));
                }
                let root = evidence.join("app-directories");
                let data = app.path().app_data_dir()?;
                let config = app.path().app_config_dir()?;
                let cache = app.path().app_cache_dir()?;
                assert!(data == root && config == root && cache == root.join("caches"));
                terminal_command::acceptance_trace::record(
                    "isolated-app-paths",
                    serde_json::json!({"home":home_dir,"shellHome":evidence.join("home"),"data":data,"config":config,"cache":cache}),
                )
                .map_err(std::io::Error::other)?;
            }
            path_utils::configure_data_directory(
                std::env::var_os("SHELLSPAN_DATA_DIR").map(std::path::PathBuf::from),
            )?;
            let shellspan_dir = shellspan_data_dir(&home_dir);
            let database = db::Database::open(&shellspan_dir.join(db::DATABASE_FILE_NAME))?;
            #[cfg(all(feature = "native-input-acceptance", debug_assertions, target_os = "macos", target_arch = "aarch64"))]
            if agent_runtime::mac_sandbox_preview_active()
                && !database.load_preferences()?.iter().any(|(key, _)| key == "ai.agentPermissionMode")
            {
                database.save_preferences(&[("ai.agentPermissionMode".into(), "\"requestApproval\"".into())])?;
            }
            app.manage(frontend_storage::FrontendStorage::open(&shellspan_dir)?);
            let log_directory = path_utils::shellspan_log_dir(&home_dir);
            let backend = Target::new(TargetKind::Folder {
                path: log_directory.clone(),
                file_name: Some("backend".into()),
            })
            .filter(|metadata| !metadata.target().starts_with(WEBVIEW_TARGET));
            let frontend = Target::new(TargetKind::Folder {
                path: log_directory,
                file_name: Some("frontend".into()),
            })
            .filter(|metadata| metadata.target().starts_with(WEBVIEW_TARGET));
            let mut targets = vec![backend, frontend];
            if cfg!(debug_assertions) {
                targets.push(Target::new(TargetKind::Stdout));
            }
            app.handle().plugin(
                tauri_plugin_log::Builder::new()
                    .level(log_level)
                    .timezone_strategy(tauri_plugin_log::TimezoneStrategy::UseLocal)
                    .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepSome(10))
                    .max_file_size(2 * 1024 * 1024)
                    .targets(targets)
                    .build(),
            )?;
            let credentials = keychain::CredentialManager::new();
            #[cfg(all(
                feature = "native-input-acceptance",
                debug_assertions,
                target_os = "macos",
                target_arch = "aarch64"
            ))]
            let credentials = if agent_runtime::mac_sandbox_preview_active() {
                let identifier = std::env::var("SHELLSPAN_ACCEPTANCE_WEBKIT_STORE")?;
                keychain::CredentialManager::for_sandbox_preview(uuid::Uuid::parse_str(&identifier)?)
            } else {
                credentials
            };
            let petdex = petdex::PetdexAdapter::new(home_dir.clone());
            let message_adapter = petdex.clone();
            let message_directory = shellspan_dir.clone();
            tauri::async_runtime::spawn_blocking(move || {
                message_adapter.initialize_messages(&message_directory);
            });
            app.manage(petdex);
            app.manage(credentials.clone());
            let routes = llm::routes::RouteStore::open(database.clone(), credentials.clone())
                .map_err(std::io::Error::other)?;
            app.manage(llm::runtime::LlmRuntime { routes });
            app.manage(database);
            let runtime = app.state::<agent_runtime::AgentRuntime>();
            agent_runtime::configure_runtime(app.handle(), &runtime)?;
            runtime.configure_credentials(credentials)?;
            #[cfg(windows)]
            {
                let runtime_for_reclaim = runtime.inner().clone();
                let data_dir = shellspan_dir.clone();
                tauri::async_runtime::spawn_blocking(move || {
                    runtime_for_reclaim.reclaim_orphaned_windows_sandboxes(&data_dir);
                });
            }
            #[cfg(target_os = "macos")]
            {
                let runtime_for_reclaim = runtime.inner().clone();
                let mac_data_dir = shellspan_dir.clone();
                tauri::async_runtime::spawn_blocking(move || {
                    agent_runtime::mac_sandbox::recover_all_on_startup(&mac_data_dir);
                    runtime_for_reclaim.reclaim_orphaned_mac_sandboxes(&mac_data_dir);
                });
            }
            #[cfg(all(
                feature = "native-input-acceptance",
                debug_assertions,
                target_os = "macos",
                target_arch = "aarch64"
            ))]
            if agent_runtime::mac_sandbox_preview_active()
                && std::env::args_os().any(|argument| argument == "--check-preview-profile-keychain")
            {
                let credentials = app.state::<keychain::CredentialManager>().inner().clone();
                let handle = app.handle().clone();
                tauri::async_runtime::spawn_blocking(move || {
                    let profile_id = format!("preview-check-{}", uuid::Uuid::new_v4());
                    let password = uuid::Uuid::new_v4().to_string();
                    let outcome = (|| {
                        credentials.store_profile_password(&profile_id, &password)?;
                        let matched = credentials.retrieve_profile_password(&profile_id);
                        credentials.delete_profile_password(&profile_id)?;
                        if matched?.as_deref() != Some(password.as_str()) {
                            return Err("Preview profile password did not round-trip through Keychain".into());
                        }
                        Ok::<_, String>(())
                    })();
                    let code = match outcome {
                        Ok(()) => {
                            println!("PREVIEW_PROFILE_KEYCHAIN_OK");
                            0
                        }
                        Err(error) => {
                            eprintln!("PREVIEW_PROFILE_KEYCHAIN_FAILED: {error}");
                            1
                        }
                    };
                    handle.exit(code);
                });
                return Ok(());
            }
            #[cfg(all(
                feature = "native-input-acceptance",
                debug_assertions,
                target_os = "macos",
                target_arch = "aarch64"
            ))]
            if std::env::var_os("SHELLSPAN_ACCEPTANCE_WEBKIT_STORE").is_some() {
                let config = app
                    .config()
                    .app
                    .windows
                    .iter()
                    .find(|window| window.label == "main")
                    .expect("owned main WebKit configuration required")
                    .clone();
                let store = config
                    .data_store_identifier
                    .expect("owned WebKit identifier required");
                let window = tauri::WebviewWindowBuilder::from_config(app, &config)?
                    .data_store_identifier(store)
                    .build()?;
                window.set_title("").ok();
            }
            #[cfg(debug_assertions)]
            if std::env::args_os().any(|argument| argument == "--check-keychain-access") {
                keychain_diagnostics::start(app.handle().clone())?;
            }
            #[cfg(not(target_os = "macos"))]
            menu::initialize_tray(app)?;
            Ok(())
        })
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(SessionManager::default())
        .manage(terminal_recorder::TerminalRecorder::default())
        .manage(terminal_display_origin::DisplayOriginRegistry::default())
        .manage(agent_runtime::AgentRuntime::default())
        .manage(UploadCancellationRegistry::default())
        .manage(DeleteCancellationRegistry::default())
        .manage(PreflightCancellationRegistry::default())
        .manage(connection::interactive_auth::InteractiveAuthRegistry::default())
        .manage(RemoteHealthCancellationRegistry::default())
        .manage(execution::ExecutionCancellationRegistry::default())
        .manage(DownloadCancellationRegistry::default())
        .manage(RemoteCopyCancellationRegistry::default())
        .manage(RemoteFileReadCancellationRegistry::default())
        .manage(DirectoryRequestRegistry::default())
        .manage(port_forward::PortForwardManager::default())
        .manage(SftpPool::default())
        .manage(RemoteIdentityCache::default())
        .manage(health::HealthState::default())
        .manage(llm::connection_test::ConnectionTests::default())
        .invoke_handler(tauri::generate_handler![
            ai::ai_list_routes,
            ai::ai_get_route_api_key,
            ai::ai_save_routes,
            ai::ai_list_route_models,
            ai::ai_resolve_selection,
            ai::ai_list_models,
            llm::connection_test::ai_test_connection,
            llm::connection_test::ai_cancel_connection_test,
            ai::ai_resolve_model,
            ai::ai_model_declaration_template,
            agent_runtime::agent_runtime_create_session,
            agent_runtime::agent_runtime_local_sandbox_status,
            agent_runtime::agent_runtime_sandbox_diff,
            agent_runtime::agent_runtime_sandbox_file_diff,
            agent_runtime::agent_runtime_sandbox_apply,
            agent_runtime::agent_runtime_continue_on_target,
            agent_runtime::agent_runtime_reconnect_terminal,
            agent_runtime::agent_runtime_start,
            agent_runtime::agent_runtime_select_model,
            agent_runtime::agent_runtime_set_permission,
            agent_runtime::agent_runtime_set_execution_surface,
            agent_runtime::agent_runtime_bind_project_root,
            agent_runtime::agent_runtime_answer_question,
            agent_runtime::agent_runtime_list_skills,
            agent_runtime::agent_runtime_resolve_skill_proposal,
            agent_runtime::agent_runtime_inspect_skill_target,
            agent_runtime::agent_runtime_list_managed_skills,
            agent_runtime::agent_runtime_save_user_skill,
            agent_runtime::agent_runtime_delete_user_skill,
            agent_runtime::agent_runtime_open_user_skills_dir,
            agent_runtime::agent_runtime_list_file_references,
            agent_runtime::agent_runtime_cancel_file_references,
            agent_runtime::agent_runtime_spawn_subagent,
            agent_runtime::agent_runtime_send_child_input,
            agent_runtime::agent_runtime_inspect_child_agent,
            agent_runtime::agent_runtime_cancel_child_agent,
            agent_runtime::agent_runtime_fleet_plan,
            agent_runtime::agent_runtime_fleet_start,
            agent_runtime::agent_runtime_fleet_pause,
            agent_runtime::agent_runtime_fleet_resume,
            agent_runtime::agent_runtime_fleet_abort,
            agent_runtime::agent_runtime_fleet_reconcile,
            agent_runtime::agent_runtime_followup,
            agent_runtime::agent_runtime_submit_images,
            agent_runtime::agent_runtime_prepare_images,
            agent_runtime::agent_runtime_cancel_image_submission,
            agent_runtime::agent_runtime_image_preview,
            agent_runtime::agent_runtime_steer,
            agent_runtime::agent_runtime_mutate_inbox,
            agent_runtime::agent_runtime_rename_session,
            agent_runtime::agent_runtime_inject,
            agent_runtime::agent_runtime_cancel,
            agent_runtime::agent_runtime_terminal_lease_ready,
            agent_runtime::agent_runtime_terminal_owner,
            agent_runtime::agent_runtime_terminal_manual_handoffs,
            agent_runtime::agent_runtime_takeover_terminal,
            agent_runtime::agent_runtime_interrupt,
            agent_runtime::agent_runtime_resume,
            agent_runtime::agent_runtime_retry_model,
            agent_runtime::agent_runtime_approve_tool,
            agent_runtime::agent_runtime_respond_sudo,
            agent_runtime::agent_runtime_reject_tool,
            agent_runtime::agent_runtime_get_pending_approval_arguments,
            agent_runtime::agent_runtime_get_session,
            agent_runtime::agent_runtime_list_sessions,
            agent_runtime::agent_runtime_archive_session,
            agent_runtime::agent_runtime_delete_session,
            agent_runtime::agent_runtime_get_events,
            agent_runtime::agent_runtime_get_committed_events,
            agent_runtime::agent_runtime_get_artifact,
            agent_runtime::agent_runtime_inspect_recovery,
            agent_runtime::agent_runtime_resume_recovery,
            agent_runtime::agent_runtime_reconcile_recovery,
            agent_runtime::agent_runtime_abort_recovery,
            petdex::petdex_set_enabled,
            petdex::configuration::petdex_configure,
            petdex::configuration::petdex_message_diagnostic,
            petdex::configuration::petdex_test_message,
            petdex::petdex_get_status,
            petdex::petdex_check_health,
            petdex::petdex_test_connection,
            commands::create_session,
            commands::cancel_pending_ssh_connection,
            commands::create_local_session,
            commands::get_local_terminal_options,
            commands::write_session,
            commands::respond_terminal_prompt_origin,
            commands::get_session_status,
            commands::get_terminal_display_snapshot,
            commands::mark_session_ready,
            commands::set_session_output_paused,
            commands::resize_session,
            terminal_recorder::export_terminal_buffer,
            terminal_recorder::start_terminal_recording,
            terminal_recorder::stop_terminal_recording,
            terminal_recorder::get_terminal_recording_status,
            commands::write_session_bytes,
            commands::get_terminal_broker_snapshot,
            commands::notify_terminal_command,
            commands::get_terminal_acceptance_raw_output,
            commands::prepare_terminal_acceptance_raw_command,
            commands::run_terminal_acceptance_command,
            commands::decide_terminal_acceptance_command,
            commands::control_terminal_acceptance_input_lease,
            commands::get_terminal_submission_recovery,
            commands::close_session,
            commands::request_app_restart,
            commands::request_app_exit,
            commands::list_remote_directory,
            commands::supersede_remote_directory_request,
            commands::resolve_remote_entry_owners,
            commands::warm_remote_connection,
            commands::create_remote_entry,
            commands::rename_remote_path,
            commands::delete_remote_path,
            commands::copy_remote_path,
            commands::copy_remote_to_remote,
            commands::cancel_remote_copy,
            commands::upload_local_paths,
            commands::copy_local_paths,
            commands::rename_local_path,
            commands::paste_local_paths,
            commands::trash_local_paths,
            commands::cancel_upload,
            commands::cancel_delete,
            commands::download_remote_paths,
            commands::cancel_download,
            commands::disconnect_sftp,
            commands::pick_local_files,
            commands::pick_local_folder,
            commands::open_path,
            commands::reveal_path,
            ai_file_actions::inspect_local_path,
            ai_file_actions::inspect_remote_path,
            ai_file_actions::list_local_file_apps,
            ai_file_actions::open_local_file_with,
            ai_file_actions::save_local_file_as,
            ai_file_actions::read_local_file_text,
            file_actions::list_file_open_applications,
            file_actions::get_file_open_default_icon,
            file_actions::open_local_file_with_application,
            file_actions::pick_preview_save_destination,
            file_actions::save_local_preview_file,
            commands::pick_private_key_file,
            commands::pick_profile_avatar,
            commands::open_remote_file,
            commands::preview_local_file,
            ai_attachment::read_ai_attachment,
            commands::preview_remote_file,
            commands::cancel_remote_file_read,
            commands::update_remote_permissions,
            commands::check_host_key,
            commands::preflight_connection,
            connection::interactive_auth::respond_to_ssh_interactive_auth,
            commands::cancel_connection_preflight,
            commands::trust_host,
            commands::list_known_hosts,
            commands::remove_known_host,
            commands::list_log_files,
            commands::read_log_file,
            commands::read_log_chunk,
            commands::export_log_file,
            commands::list_local_directory,
            commands::store_key_credential,
            commands::list_key_credentials,
            commands::retrieve_key_credential,
            commands::delete_key_credential,
            commands::store_profile_password,
            commands::retrieve_profile_password,
            commands::delete_profile_password,
            commands::store_profile_secret,
            commands::retrieve_profile_secret,
            commands::delete_profile_secrets,
            commands::delete_profile_secret,
            commands::read_text_file,
            commands::start_port_forward,
            commands::stop_port_forward,
            commands::stop_all_port_forwards,
            commands::list_port_forwards,
            commands::open_url,
            commands::list_profiles,
            commands::add_profile,
            commands::update_profile,
            commands::remove_profile,
            commands::get_profile_sudo_policy,
            commands::save_profile_sudo_policy,
            commands::get_profile_sandbox,
            commands::save_profile_sandbox,
            commands::test_profile_sandbox,
            commands::load_preferences,
            commands::save_preferences,
            frontend_storage::load_ui_preferences,
            frontend_storage::save_ui_preferences,
            frontend_storage::read_image_drafts,
            frontend_storage::commit_image_drafts,
            commands::list_recent_profiles,
            commands::touch_recent_profile,
            commands::remove_recent_profile,
            commands::list_sftp_bookmarks,
            commands::add_sftp_bookmark,
            commands::remove_sftp_bookmark,
            commands::load_terminal_workspace,
            commands::save_terminal_workspace,
            commands::clear_terminal_workspace,
            commands::load_sftp_workspace,
            commands::save_sftp_workspace,
            commands::clear_sftp_workspace,
            health::get_system_health,
            remote_health::collect_remote_health_snapshot,
            remote_health::cancel_remote_health_snapshot,
        ]);

    let context = tauri::generate_context!();
    #[cfg(all(
        feature = "native-input-acceptance",
        debug_assertions,
        target_os = "macos",
        target_arch = "aarch64"
    ))]
    let context = {
        let mut context = context;
        if context.config().identifier == "com.shellspan.validation.agent-sandbox-preview-keychain"
        {
            assert!(
                agent_runtime::mac_sandbox_preview_active()
                    && std::env::var("SHELLSPAN_ACCEPTANCE_SUBMISSION").as_deref() == Ok("1")
                    && std::env::var_os("SHELLSPAN_ACCEPTANCE_WEBKIT_STORE").is_some(),
                "Launch this preview with its companion launcher to use isolated application data"
            );
        }
        if let Ok(value) = std::env::var("SHELLSPAN_ACCEPTANCE_WEBKIT_STORE") {
            let evidence = std::env::var_os("SHELLSPAN_ACCEPTANCE_EVIDENCE_DIR")
                .map(std::path::PathBuf::from)
                .expect("owned WebKit evidence directory required");
            let manifest = std::env::var_os("SHELLSPAN_ACCEPTANCE_FROZEN_MANIFEST")
                .map(std::path::PathBuf::from)
                .expect("frozen WebKit inputs required");
            assert!(evidence.is_absolute() && manifest.parent() == Some(evidence.as_path()));
            assert_eq!(
                std::env::var("SHELLSPAN_ACCEPTANCE_RAW_PTY").as_deref(),
                Ok("1")
            );
            let identifier =
                uuid::Uuid::parse_str(&value).expect("exact WebKit case UUID required");
            if std::env::var("SHELLSPAN_ACCEPTANCE_SUBMISSION").as_deref() == Ok("1") {
                // Keep the compiled acceptance config stable. The same owned
                // per-case directory still applies before any Tauri setup.
                let directory = commands::terminal_acceptance_directory()
                    .expect("owned submission acceptance directories required");
                assert_eq!(evidence, directory);
                assert_eq!(
                    context.config().identifier,
                    if agent_runtime::mac_sandbox_preview_active() {
                        "com.shellspan.validation.agent-sandbox-preview-keychain"
                    } else if agent_runtime::mac_sandbox_automated() {
                        "com.shellspan.validation.agent-sandbox"
                    } else {
                        "com.shellspan.validation.native-input-p3"
                    }
                );
                if !terminal_command::acceptance_trace::ssh_recovery_enabled()
                    && !agent_runtime::mac_sandbox_preview_active()
                {
                    assert_eq!(
                        std::env::var_os("HOME"),
                        Some(directory.join("home").into_os_string())
                    );
                }
                assert_eq!(
                    std::fs::canonicalize(&directory).ok().as_ref(),
                    Some(&directory)
                );
                let root = directory.join("app-directories");
                match std::fs::symlink_metadata(&root) {
                    Ok(metadata) => {
                        assert!(metadata.is_dir() && !metadata.file_type().is_symlink())
                    }
                    Err(error) => assert_eq!(error.kind(), std::io::ErrorKind::NotFound),
                }
                let app = &mut context.config_mut().app;
                assert!(app.app_directories_override.is_none());
                app.app_directories_override =
                    Some(tauri::utils::config::AppDirectoriesOverride::Root(
                        root.to_str()
                            .expect("UTF-8 acceptance directory required")
                            .into(),
                    ));
            }
            let window = context
                .config_mut()
                .app
                .windows
                .iter_mut()
                .find(|window| window.label == "main")
                .expect("owned main WebKit window required");
            window.data_store_identifier = Some(*identifier.as_bytes());
            // This SDK's config-to-WebviewAttributes conversion omits the
            // identifier. Build the same window with its public SDK setter.
            window.create = false;
        }
        context
    };
    let app = menu::configure_builder(builder)
        .build(context)
        .expect("error while building tauri application");
    app.run(|app, event| {
        if matches!(
            event,
            tauri::RunEvent::Exit | tauri::RunEvent::ExitRequested { .. }
        ) {
            if let (Some(runtime), Some(sessions)) = (
                app.try_state::<agent_runtime::AgentRuntime>(),
                app.try_state::<SessionManager>(),
            ) {
                if let Err(error) = runtime.prepare_for_shutdown(&sessions) {
                    log::warn!(
                        "Failed to persist Agent runtime tasks during application exit: {error}"
                    );
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn drain_decoded_output_holds_split_multibyte_sequence() {
        let mut pending_bytes = Vec::new();
        let mut output = String::new();
        // U+6C49 (汉) is three bytes; feed it split across two drains.
        pending_bytes.extend_from_slice(&[0xE6, 0xB1]);
        drain_decoded_output(&mut pending_bytes, &mut output);
        assert_eq!(output, "");
        assert_eq!(pending_bytes, vec![0xE6, 0xB1]);

        pending_bytes.extend_from_slice(&[0x89, b'!']);
        drain_decoded_output(&mut pending_bytes, &mut output);
        assert_eq!(output, "汉!");
        assert!(pending_bytes.is_empty());
    }

    #[test]
    fn drain_decoded_output_replaces_invalid_bytes() {
        let mut pending_bytes = vec![b'a', 0xFF, b'b'];
        let mut output = String::new();
        drain_decoded_output(&mut pending_bytes, &mut output);
        assert_eq!(output, "a\u{FFFD}b");
        assert!(pending_bytes.is_empty());
    }

    include!("tests/tauri_config.rs");
}

use tauri::Manager;

#[derive(Default)]
struct ExitCoordination {
    started: std::sync::atomic::AtomicBool,
    finished: std::sync::atomic::AtomicBool,
}

pub(crate) fn handle_event(app: &tauri::AppHandle, event: tauri::RunEvent) {
    if let tauri::RunEvent::ExitRequested { code, api, .. } = event {
        if let Some(runtime) = app.try_state::<crate::agent_runtime::AgentRuntime>() {
            runtime.begin_shutdown_admission();
        }
        if app.try_state::<ExitCoordination>().is_none() { app.manage(ExitCoordination::default()); }
        let exit = app.state::<ExitCoordination>();
        let supervisor = app
            .state::<crate::agent_runtime::ContainerResourceSupervisor>()
            .inner()
            .clone();
        if exit.finished.load(std::sync::atomic::Ordering::Acquire) {
            return;
        }
        api.prevent_exit();
        if exit.started.swap(true, std::sync::atomic::Ordering::AcqRel) {
            return;
        }
        supervisor.begin_shutdown();
        let shutdown_app = app.clone();
        tauri::async_runtime::spawn(async move {
            let runtime_app = shutdown_app.clone();
            let prepare = async move {
                if let (Some(runtime), Some(sessions)) = (
                    runtime_app.try_state::<crate::agent_runtime::AgentRuntime>(),
                    runtime_app.try_state::<crate::models::SessionManager>(),
                ) {
                    runtime.shutdown(&sessions).await
                } else {
                    Ok(0)
                }
            };
            let work = async {
                let (prepared, cleaned) = tokio::join!(prepare, supervisor.shutdown());
                match prepared {
                    Err(error) => log::warn!(
                        "Agent runtime shutdown remains unconfirmed: {}",
                        crate::redaction::redact_sensitive_text(&error)
                    ),
                    Ok(_) => {}
                }
                if let Err(error) = cleaned {
                    log::warn!("Agent container shutdown remains unconfirmed: {error}");
                }
            };
            if tokio::time::timeout(std::time::Duration::from_secs(10), work)
                .await
                .is_err()
            {
                log::warn!("Agent shutdown deadline reached; pending custody remains for recovery");
            }
            if !supervisor.shutdown_complete() { supervisor.finish_shutdown(); }
            // This marks the bounded exit coordination done, not successful resource cleanup.
            shutdown_app.state::<ExitCoordination>().finished.store(true,std::sync::atomic::Ordering::Release);
            shutdown_app.exit(code.unwrap_or(0));
        });
    }
}

/// Isolated native acceptance event loop; never loads existing user state.
#[cfg(debug_assertions)]
pub(crate) fn run_check(root: &std::path::Path, mode: &str) -> Result<(), String> {
    use serde_json::json;
    if !matches!(
        mode,
        "quit" | "restart" | "quit-active" | "restart-active" | "quit-debt" | "status"
    ) || !root.is_absolute()
        || !root.is_dir()
    {
        return Err("GUI lifecycle fixture input is invalid".into());
    }
    let marker = root.join("gui-events.json");
    if mode == "status" {
        if !marker.exists() {
            return Err("GUI fixture marker required".into());
        }
        let pending = crate::agent_runtime::gui_custody_status(root, true)?;
        println!("{}", json!({"pending":pending}));
        return Ok(());
    }
    let mut events: Vec<serde_json::Value> = if marker.exists() {
        serde_json::from_slice(&std::fs::read(&marker).map_err(|_| "GUI fixture unavailable")?)
            .map_err(|_| "GUI fixture invalid")?
    } else {
        if std::fs::read_dir(root)
            .map_err(|_| "GUI fixture unavailable")?
            .next()
            .is_some()
        {
            return Err("GUI fixture root must start empty".into());
        }
        Vec::new()
    };
    let restarted = !events.is_empty();
    events.push(json!({"event":"started", "pid":std::process::id(), "mode":mode}));
    std::fs::write(
        &marker,
        serde_json::to_vec(&events).map_err(|_| "GUI fixture invalid")?,
    )
    .map_err(|_| "GUI fixture unavailable")?;
    let mut context = crate::application_context();
    context.config_mut().app.windows.clear();
    context.config_mut().identifier = "com.shellspan.lifecycle-check".into();
    context.config_mut().app.app_directories_override = Some(
        tauri::utils::config::AppDirectoriesOverride::Root(root.to_path_buf()),
    );
    let mode = mode.to_owned();
    let resource_root = root.to_path_buf();
    let app = tauri::Builder::default()
        .manage(crate::agent_runtime::ContainerResourceSupervisor::default())
        .setup(move |app| {
            tauri::WebviewWindowBuilder::new(
                app,
                "lifecycle",
                tauri::WebviewUrl::External("about:blank".parse().unwrap()),
            )
            .title("ShellSpan lifecycle acceptance")
            .incognito(true)
            .inner_size(400.0, 220.0)
            .build()?;
            let handle = app.handle().clone();
            let mode = mode.clone();
            let root = resource_root.clone();
            tauri::async_runtime::spawn(async move {
                if mode.contains("active") || mode.contains("debt") {
                    let supervisor = handle
                        .state::<crate::agent_runtime::ContainerResourceSupervisor>()
                        .inner()
                        .clone();
                    let prepared = async {
                        supervisor.prepare_gui_check(root.clone()).await?;
                        if !restarted {
                            let image = std::env::var("SHELLSPAN_CONTAINER_TEST_IMAGE")
                                .map_err(|_| "GUI fixture image required")?;
                            let resource = crate::agent_runtime::prepare_gui_resource(
                                root.clone(),
                                image,
                                mode.contains("debt"),
                            )
                            .await?;
                            let path = root.join("resource.json");
                            tokio::task::spawn_blocking(move || {
                                std::fs::write(path, serde_json::to_vec(&resource).unwrap())
                            })
                            .await
                            .map_err(|_| "GUI resource marker unavailable")?
                            .map_err(|_| "GUI resource marker unavailable")?;
                        }
                        Ok::<(), String>(())
                    }
                    .await;
                    if prepared.is_err() {
                        handle.exit(1);
                        return;
                    }
                }
                tokio::time::sleep(std::time::Duration::from_secs(1)).await;
                if mode.starts_with("restart") && !restarted {
                    handle.request_restart();
                } else {
                    handle.exit(0);
                    handle.exit(0);
                }
            });
            Ok(())
        })
        .build(context)
        .map_err(|_| "GUI fixture could not start")?;
    app.run(move |handle, event| {
        if matches!(&event, tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit) {
            events.push(json!({"event": if matches!(&event, tauri::RunEvent::Exit) {"exit"} else {"exitRequested"}, "pid":std::process::id()}));
            let _ = std::fs::write(&marker, serde_json::to_vec(&events).unwrap());
        }
        handle_event(handle, event);
    });
    Ok(())
}

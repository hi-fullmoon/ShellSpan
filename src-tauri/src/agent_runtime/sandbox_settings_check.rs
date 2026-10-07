//! Isolated Wry review with actual native state and production UI/IPC. No model turn.
use super::*;
use std::path::Path;
use std::sync::{Arc, Mutex};
use tauri::{Manager, State};

enum ReviewFixture {
    Remote(super::remote_seatbelt::tests::Fixture),
    Local {
        source: super::native_agent_check::SourcePty,
        _workspace: tempfile::TempDir,
    },
}
impl ReviewFixture {
    fn source_writes(&self) -> usize {
        match self {
            Self::Remote(fixture) => fixture.source_writes(),
            Self::Local { source, .. } => source.source_writes(),
        }
    }
}

#[tauri::command]
fn sandbox_settings_review_source(
    sessions: State<'_, crate::models::SessionManager>,
) -> Result<serde_json::Value, String> {
    let actual = sessions.target_state("acceptance-source")?;
    Ok(
        serde_json::json!({"sessionId":"acceptance-source","title":actual.identity.title,"host":actual.identity.host,"port":actual.identity.port,"username":actual.identity.username,"status":actual.status}),
    )
}

fn initialize_local(app: &tauri::AppHandle, root: &Path) -> Result<ReviewFixture, String> {
    let workspace = tempfile::tempdir().map_err(|_| "Root review workspace unavailable")?;
    let canonical = workspace
        .path()
        .canonicalize()
        .map_err(|_| "Root review workspace metadata unavailable")?;
    let database = crate::db::Database::open(&root.join("review.db"))?;
    let credentials = crate::keychain::CredentialManager::isolated_native_for_checks();
    let sessions = crate::models::SessionManager::default();
    let source = super::native_agent_check::source(&sessions, workspace.path())?;
    let routes = crate::llm::routes::RouteStore::open(database.clone(), credentials.clone())?;
    let model =
        crate::llm::catalog::preset_models("ollama", crate::llm::config::AiProviderKind::Ollama)?
            .into_keys()
            .next()
            .ok_or("Local catalog is empty")?;
    let selection = crate::llm::routes::ModelSelection {
        route_id: "directory-preflight".into(),
        model_id: model,
        reasoning_effort: None,
    };
    routes.save(
        vec![crate::llm::routes::ProviderRoute {
            id: selection.route_id.clone(),
            revision: 1,
            display_name: "Local catalog for directory preflight".into(),
            adapter_id: "ollama".into(),
            base_url: "http://127.0.0.1:11434".into(),
            auth: crate::llm::routes::RouteAuth::None,
            replay_domain_id: "directory-preflight".into(),
            preset_id: "ollama".into(),
            models: None,
            model_overrides: None,
            defaults: Some(selection.clone()),
            retry_policy: super::retry::RetryPolicy::default(),
            timeouts: crate::llm::routes::RouteTimeouts::default(),
        }],
        Some(selection),
        routes.snapshot()?.revision,
        Default::default(),
    )?;
    let key = format!(
        "project:{}",
        serde_json::to_string(
            canonical
                .to_str()
                .ok_or("Root review path encoding invalid")?
        )
        .map_err(|_| "Root review key invalid")?
    );
    let preferences = serde_json::json!({"version":1,"defaults":{key:{"policy":"readOnly","cacheDirectories":[]}}});
    database.save_preferences(&[("agent_sandbox_defaults".into(), preferences.to_string())])?;
    app.manage(database);
    app.manage(credentials);
    app.manage(sessions);
    app.manage(crate::llm::runtime::LlmRuntime { routes });
    std::fs::write(root.join("root-review-intent.json"),serde_json::to_vec_pretty(&serde_json::json!({"projectRoot":canonical,"scope":"actual owned PTY, production controller and directory metadata; no model request"})).map_err(|_| "Root intent report invalid")?).map_err(|_| "Root intent report unavailable")?;
    Ok(ReviewFixture::Local {
        source,
        _workspace: workspace,
    })
}

pub(crate) fn run(root: &Path, root_entry: bool) -> Result<(), String> {
    if !root.is_absolute()
        || !root.is_dir()
        || std::fs::read_dir(root)
            .map_err(|_| "Settings review directory unavailable")?
            .next()
            .is_some()
    {
        return Err("Settings review requires a new empty absolute directory".into());
    }
    let mut context = crate::application_context();
    context.config_mut().app.windows.clear();
    context.config_mut().identifier = "com.shellspan.sandbox-settings-check".into();
    if let Ok(value) = std::env::var("SHELLSPAN_SANDBOX_SETTINGS_DEV_URL") {
        let url: tauri::Url = value.parse().map_err(|_| "Settings review URL invalid")?;
        if url.scheme() != "http"
            || url.host_str() != Some("127.0.0.1")
            || url.username() != ""
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return Err(
                "Settings review URL must be an uncredentialed loopback source server".into(),
            );
        }
        context.config_mut().build.dev_url = Some(url);
    }
    context.config_mut().app.app_directories_override = Some(
        tauri::utils::config::AppDirectoriesOverride::Root(root.to_owned()),
    );
    let fixture = Arc::new(Mutex::new(None::<ReviewFixture>));
    let retained = fixture.clone();
    let saved = root.to_owned();
    let report_root = saved.clone();
    let builder = tauri::Builder::default()
        .manage(ContainerResourceSupervisor::default())
        .manage(crate::petdex::PetdexAdapter::new(root.to_owned()))
        .invoke_handler(tauri::generate_handler![
            sandbox_settings_review_source,
            crate::commands::load_preferences,
            crate::commands::save_preferences,
            crate::commands::list_local_directory,
            crate::ai::ai_list_routes,
            crate::ai::ai_list_route_models,
            crate::ai::ai_resolve_selection,
            crate::ai::ai_resolve_model,
            super::commands::agent_runtime_get_session,
            super::commands::agent_runtime_get_sandbox_authorizations,
            super::commands::agent_runtime_list_sessions,
            super::commands::agent_runtime_create_session,
            super::commands::agent_runtime_start,
            super::commands::agent_runtime_followup,
            super::commands::agent_runtime_steer,
            super::commands::agent_runtime_interrupt,
            super::commands::agent_runtime_resume,
            super::commands::agent_runtime_get_events,
            super::commands::agent_runtime_get_committed_events,
            super::commands::agent_runtime_set_cache_directory_candidates,
            super::commands::agent_runtime_probe_native_sandbox,
            super::project_root_commands::agent_runtime_resolve_local_project_root,
            super::remote_backend_commands::agent_runtime_verify_remote_sandbox_target,
        ]);
    let app=builder.setup(move |app| {
        let handle=app.handle().clone();let retained=retained.clone();let saved=saved.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let result=(|| -> Result<(),String> {
                let owned=if root_entry {initialize_local(&handle,&saved)?} else {
                    let owned=super::remote_seatbelt::tests::Fixture::new();owned.install(&handle)?;
                    let routes=crate::llm::routes::RouteStore::open(handle.state::<crate::db::Database>().inner().clone(),handle.state::<crate::keychain::CredentialManager>().inner().clone())?;
                    handle.manage(crate::llm::runtime::LlmRuntime {routes});ReviewFixture::Remote(owned)
                };
                let runtime=AgentRuntimeBuilder::new().build();runtime.configure(handle.path().app_data_dir().map_err(|_| "Settings review app directory unavailable")?)?;
                handle.manage(runtime.clone());runtime.configure_native(handle.clone())?;
                if let ReviewFixture::Remote(owned)=&owned {
                    runtime.create_session(serde_json::from_value(serde_json::json!({"sessionId":"remote-settings","taskId":"remote-settings","goal":"Review actual remote verification UI without model requests","target":owned.target(),"sandboxPolicy":"workspace","executionSurface":"direct","permissionMode":"requestApproval","successCriteria":["Verification is transient and grants no resources"]})).map_err(|_| "Settings review session invalid")?)?;
                }
                *retained.lock().map_err(|_| "Settings review fixture unavailable")?=Some(owned);
                let url=if root_entry {"src/components/ai/__tests__/sandbox-settings-native.html?root-entry=1"} else {"src/components/ai/__tests__/sandbox-settings-native.html?session=remote-settings"};
                tauri::WebviewWindowBuilder::new(&handle,"main",tauri::WebviewUrl::App(url.into())).title("ShellSpan isolated sandbox settings review").inner_size(620.0,680.0).build().map_err(|_| "Settings review window unavailable")?;
                Ok(())
            })();
            if let Err(error)=result {let _=std::fs::write(saved.join("settings-error.txt"),crate::redaction::redact_sensitive_text(&error));handle.exit(1);}
        });Ok(())
    }).build(context).map_err(|_| "Settings Wry review unavailable")?;
    let handle = app.handle().clone();
    let code = app.run_return(crate::app_exit::handle_event);
    let source_writes = fixture
        .lock()
        .map_err(|_| "Settings review fixture unavailable")?
        .as_ref()
        .map(ReviewFixture::source_writes);
    let runtime = handle.state::<AgentRuntime>();
    let sessions = runtime.sessions(AgentSessionListRequest {
        cursor: None,
        limit: 200,
    })?;
    let preferences = handle
        .state::<crate::db::Database>()
        .load_preferences()?
        .into_iter()
        .filter(|(key, _)| key == "agent_sandbox_defaults")
        .collect::<Vec<_>>();
    let model_requests = sessions
        .sessions
        .iter()
        .map(|item| {
            runtime
                .events(AgentSessionEventsRequest {
                    session_id: item.header.session_id.clone(),
                    cursor: None,
                    limit: 1000,
                })
                .map(|page| {
                    page.events
                        .iter()
                        .filter(|event| {
                            matches!(event.payload, AgentSessionEventPayload::RequestStart { .. })
                        })
                        .count()
                })
        })
        .collect::<Result<Vec<_>, _>>()?
        .into_iter()
        .sum::<usize>();
    let report = serde_json::json!({"scope":"isolated Wry production UI/controller and IPC","rootEntry":root_entry,"sourcePtyWrites":source_writes,"sessionsCreated":sessions.sessions.len(),"modelRequests":model_requests,"sandboxDefaults":preferences,"exitCode":code});
    std::fs::write(
        report_root.join("settings-review.json"),
        serde_json::to_vec_pretty(&report).map_err(|_| "Settings report invalid")?,
    )
    .map_err(|_| "Settings report unavailable")?;
    if code != 0 || root_entry && !sessions.sessions.is_empty() || source_writes != Some(0) {
        return Err("Settings review failed; inspect isolated diagnostic".into());
    }
    Ok(())
}

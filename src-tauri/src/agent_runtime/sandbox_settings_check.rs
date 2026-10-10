//! Isolated Wry review with production UI/IPC; optional existing real model route.
use super::*;
use std::path::Path;
use std::sync::{Arc, Mutex};
use tauri::{Manager, State};

struct VerificationReviewRoot(std::path::PathBuf);
struct RemoteReviewSource(AgentSessionTarget);
struct RemoteReviewTargets(Vec<AgentSessionTarget>);
struct BindingReviewFixture(Arc<Mutex<Option<ReviewFixture>>>);
#[derive(Default)]
struct ReviewClosedWrites(Mutex<Option<usize>>);
struct NativeReviewProject(std::path::PathBuf);
#[derive(Default)]
struct HourReviewState(Mutex<Option<(serde_json::Value, Option<serde_json::Value>)>>);

#[tauri::command]
fn sandbox_settings_review_window_size(
    app: tauri::AppHandle,
    width: u32,
) -> Result<serde_json::Value, String> {
    if ![360, 480, 620, 960].contains(&width) {
        return Err("Owned review width is outside the acceptance set".into());
    }
    let window = app
        .get_webview_window("main")
        .ok_or("Owned review window unavailable")?;
    window
        .set_size(tauri::LogicalSize::new(width, 680_u32))
        .map_err(|_| "Owned review resize failed")?;
    let actual = window
        .inner_size()
        .map_err(|_| "Owned review dimensions unavailable")?;
    Ok(
        serde_json::json!({"requestedWidth":width,"physicalWidth":actual.width,"physicalHeight":actual.height,
        "scaleFactor":window.scale_factor().map_err(|_| "Owned review scale unavailable")?}),
    )
}

#[tauri::command]
fn sandbox_settings_review_targets(
    targets: State<'_, RemoteReviewTargets>,
    sessions: State<'_, crate::models::SessionManager>,
) -> Result<serde_json::Value, String> {
    let values = targets
        .0
        .iter()
        .map(|target| {
            let (actual, generation) = sessions.execution_binding_state(&target.session_id)?;
            Ok(
                serde_json::json!({"target":target,"generation":generation,"source":{
            "sessionId":target.session_id,"profileId":target.profile_id,
            "title":actual.identity.title,"host":actual.identity.host,"port":actual.identity.port,
            "username":actual.identity.username,"status":actual.status}}),
            )
        })
        .collect::<Result<Vec<_>, String>>()?;
    Ok(serde_json::json!({"targets":values}))
}

/// Finish only this application's owned SSH fixture, while Child handles and
/// the original Runtime are still resident. A process exit code is no receipt.
#[tauri::command]
async fn sandbox_settings_review_finish(
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let runtime = app.state::<AgentRuntime>().inner().clone();
    let sessions = app.state::<crate::models::SessionManager>().inner().clone();
    runtime.shutdown(&sessions).await?;
    tokio::task::spawn_blocking(move || {
        let owned = app.state::<BindingReviewFixture>();
        let mut guard = owned
            .0
            .lock()
            .map_err(|_| "Owned closing fixture unavailable")?;
        let fixture = guard
            .as_mut()
            .ok_or("Closing review requires the resident owned fixture")?;
        let writes = fixture.source_writes();
        let receipt = match fixture {
            ReviewFixture::Remote(remote) => remote.close_for_review()?,
            ReviewFixture::Local { source, .. } => source.close_for_review()?,
        };
        let page = runtime.sessions(AgentSessionListRequest {
            cursor: None,
            limit: 200,
        })?;
        let mut requests = 0;
        for session in &page.sessions {
            requests += runtime
                .events(AgentSessionEventsRequest {
                    session_id: session.header.session_id.clone(),
                    cursor: None,
                    limit: 1000,
                })?
                .events
                .iter()
                .filter(|event| {
                    matches!(event.payload, AgentSessionEventPayload::RequestStart { .. })
                })
                .count();
        }
        let report = serde_json::json!({"runtimeShutdownConfirmed":true,"fixture":receipt,
            "sourcePtyWrites":writes,"sessionsCreated":page.sessions.len(),"modelRequests":requests,
            "observedAtUnixMs":super::driver::current_unix_ms()?,"stage3Allowed":false});
        let root = app.state::<VerificationReviewRoot>();
        std::fs::write(
            root.0.join("fixture-shutdown.json"),
            serde_json::to_vec_pretty(&report).map_err(|_| "Closing receipt encoding failed")?,
        )
        .map_err(|_| "Closing receipt write failed")?;
        *app.state::<ReviewClosedWrites>()
            .0
            .lock()
            .map_err(|_| "Closing observation unavailable")? = Some(writes);
        // Release the managed Arc too; Runtime/AppHandle cycles must not keep
        // the owned server, credential or temporary project alive after exit.
        drop(guard.take());
        Ok(report)
    })
    .await
    .map_err(|_| "Owned closing worker failed".to_string())?
}

#[tauri::command]
fn sandbox_settings_review_activity_process(
    runtime: State<'_, AgentRuntime>,
    root: State<'_, VerificationReviewRoot>,
) -> Result<serde_json::Value, String> {
    let page = runtime.events(AgentSessionEventsRequest {
        session_id: "binding-activity".into(),
        cursor: None,
        limit: 1000,
    })?;
    let handle = page
        .events
        .iter()
        .filter_map(|event| serde_json::to_value(event).ok())
        .find_map(|row| {
            (row["type"] == "tool/result")
                .then(|| {
                    row["data"]["data"]["processHandle"]
                        .as_str()
                        .map(str::to_owned)
                })
                .flatten()
        })
        .ok_or("Actual owned activity handle missing")?;
    let process = runtime.acceptance_process(&handle)?;
    let snapshot = process.snapshot()?;
    if snapshot.task_id != "binding-activity" {
        return Err("Activity process owner mismatch".into());
    }
    let report = serde_json::json!({"processHandle":snapshot.process_handle,"taskId":snapshot.task_id,
        "state":snapshot.state,"terminationConfirmed":snapshot.termination_confirmed,
        "error":snapshot.error,"completedAtUnixMs":snapshot.completed_at_unix_ms});
    std::fs::write(
        root.0.join("binding-process-observed.json"),
        serde_json::to_vec_pretty(&report).map_err(|_| "Activity snapshot encoding failed")?,
    )
    .map_err(|_| "Activity snapshot write failed")?;
    Ok(report)
}

#[tauri::command]
async fn sandbox_settings_review_activity_started(app: tauri::AppHandle) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        let owned = app.state::<BindingReviewFixture>();
        let guard = owned
            .0
            .lock()
            .map_err(|_| "Owned binding fixture unavailable")?;
        let Some(ReviewFixture::Remote(fixture)) = guard.as_ref() else {
            return Err("Activity review requires the owned remote fixture".into());
        };
        let value = fixture.read_project("binding-background-started")?;
        if value == "started" {
            let root = app.state::<VerificationReviewRoot>();
            std::fs::write(
                root.0.join("binding-started-observed.json"),
                serde_json::to_vec_pretty(&serde_json::json!({"value":value,
                    "observedAtUnixMs":super::driver::current_unix_ms()?,
                    "observation":"actual SFTP on the exact owned fixture project"}))
                .map_err(|_| "Startup evidence encoding failed")?,
            )
            .map_err(|_| "Startup evidence write failed")?;
        }
        Ok(value)
    })
    .await
    .map_err(|_| "Owned activity observation failed".to_string())?
}

#[tauri::command]
async fn sandbox_settings_review_new_project(
    app: tauri::AppHandle,
) -> Result<AgentSessionTarget, String> {
    tokio::task::spawn_blocking(move || {
        let owned = app.state::<BindingReviewFixture>();
        let guard = owned
            .0
            .lock()
            .map_err(|_| "Owned binding fixture unavailable")?;
        let Some(ReviewFixture::Remote(fixture)) = guard.as_ref() else {
            return Err("Project review requires the owned remote fixture".into());
        };
        let target = fixture.new_review_project()?;
        let root = app.state::<VerificationReviewRoot>();
        std::fs::write(
            root.0.join("binding-new-project.json"),
            serde_json::to_vec_pretty(&target)
                .map_err(|_| "Owned project report encoding failed")?,
        )
        .map_err(|_| "Owned project report write failed")?;
        Ok(target)
    })
    .await
    .map_err(|_| "Owned project worker failed".to_string())?
}

/// Operates only on this debug application's owned SSH fixture and real PTY.
#[tauri::command]
async fn sandbox_settings_review_connection(
    app: tauri::AppHandle,
    reconnect: bool,
) -> Result<serde_json::Value, String> {
    tokio::task::spawn_blocking(move || {
        let owned = app.state::<BindingReviewFixture>();
        let mut guard = owned
            .0
            .lock()
            .map_err(|_| "Owned binding fixture unavailable")?;
        let Some(ReviewFixture::Remote(fixture)) = guard.as_mut() else {
            return Err("Connection review requires the owned remote fixture".into());
        };
        let sessions = app.state::<crate::models::SessionManager>();
        let before = sessions
            .execution_binding_state("mac-source")
            .ok()
            .map(|(_, id)| id);
        if reconnect {
            fixture.reconnect_source()?;
        } else {
            fixture.disconnect_source()?;
        }
        let after = sessions
            .execution_binding_state("mac-source")
            .ok()
            .map(|(_, id)| id);
        let report = serde_json::json!({"reconnect":reconnect,"observedAtUnixMs":super::driver::current_unix_ms()?,"beforeGeneration":before,
            "afterGeneration":after,"sourcePtyWrites":fixture.source_writes()});
        let root = app.state::<VerificationReviewRoot>();
        std::fs::write(
            root.0.join(if reconnect {
                "binding-reconnected.json"
            } else {
                "binding-disconnected.json"
            }),
            serde_json::to_vec_pretty(&report)
                .map_err(|_| "Connection evidence encoding failed")?,
        )
        .map_err(|_| "Connection evidence write failed")?;
        Ok(report)
    })
    .await
    .map_err(|_| "Owned connection worker failed".to_string())?
}

#[tauri::command]
async fn sandbox_settings_review_observe_hour(
    runtime: State<'_, AgentRuntime>,
    root: State<'_, VerificationReviewRoot>,
    observation: State<'_, Arc<HourReviewState>>,
) -> Result<serde_json::Value, String> {
    let session_id = "hour-acceptance";
    let snapshot = runtime.session(session_id)?;
    let project = root.0.join("owned-project");
    if snapshot
        .header
        .target
        .as_ref()
        .and_then(|target| target.cwd.as_deref())
        != project.to_str()
        || snapshot.header.sandbox_policy != Some(AgentSandboxPolicy::Workspace)
    {
        return Err("Hour observation requires the exact owned workspace Session".into());
    }
    let initial = runtime.sandbox_authorizations(session_id)?;
    let expires = initial
        .expires_at_unix_ms
        .ok_or("Actual session authorization required")?;
    if initial.state != "active"
        || initial.read_paths.len() != 1
        || expires <= initial.checked_at_unix_ms
    {
        return Err("Actual active single-file session authorization required".into());
    }
    let events = serde_json::to_value(runtime.events(AgentSessionEventsRequest {
        session_id: session_id.into(),
        cursor: None,
        limit: 1000,
    })?)
    .map_err(|_| "Hour journal encoding failed")?;
    let audit = events["events"]
        .as_array()
        .and_then(|events| {
            events.iter().find(|event| {
                event["type"] == "sandbox/resource_audit"
                    && event["data"]["audit"]["scope"] == "session"
                    && event["data"]["audit"]["sessionExpiresAtUnixMs"].as_u64() == Some(expires)
            })
        })
        .ok_or("Actual signed session audit required")?;
    let issued = audit["timeUnixMs"]
        .as_u64()
        .ok_or("Actual audit time required")?;
    if expires.saturating_sub(issued) < 3_599_000 {
        return Err("The actual grant must retain its production one-hour lifetime".into());
    }
    let initial = serde_json::json!({"authorization":initial,"auditAtUnixMs":issued,"pid":std::process::id()});
    {
        let mut state = observation
            .0
            .lock()
            .map_err(|_| "Hour observation unavailable")?;
        if state.is_some() {
            return Err("The original hour observation is already running".into());
        }
        *state = Some((initial.clone(), None));
    }
    tokio::fs::write(
        root.0.join("hour-initial.json"),
        serde_json::to_vec_pretty(&initial).map_err(|_| "Hour report encoding failed")?,
    )
    .await
    .map_err(|_| "Hour initial report write failed")?;
    let runtime = runtime.inner().clone();
    let root = root.0.clone();
    let observation = observation.inner().clone();
    let began = std::time::Instant::now();
    let age_at_start = initial["authorization"]["checkedAtUnixMs"]
        .as_u64()
        .unwrap_or(issued)
        .saturating_sub(issued);
    tauri::async_runtime::spawn(async move {
        loop {
            let now = match super::driver::current_unix_ms() {
                Ok(now) => now,
                Err(_) => return,
            };
            if now >= expires {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis((expires - now).min(1000))).await;
        }
        let final_status = match runtime.sandbox_authorizations(session_id) {
            Ok(status) => status,
            Err(_) => return,
        };
        let elapsed = began.elapsed().as_millis() as u64;
        let passed = final_status.state == "expired"
            && final_status.checked_at_unix_ms >= expires
            && age_at_start.saturating_add(elapsed) >= 3_599_000
            && final_status.read_paths.is_empty()
            && final_status.active_processes == 0;
        let final_status = serde_json::json!({"passed":passed,"authorization":final_status,"pid":std::process::id(),"monotonicElapsedMs":elapsed,"grantAgeAtObserverStartMs":age_at_start,"stageStatus":"pending","stage3Allowed":false,"scope":"same original Runtime, real production one-hour expiry; no adjusted clock, TTL or restart"});
        if let Ok(mut state) = observation.0.lock() {
            if let Some((_, result)) = state.as_mut() {
                *result = Some(final_status.clone());
            }
        }
        if let Ok(encoded) = serde_json::to_vec_pretty(&final_status) {
            let _ = tokio::fs::write(root.join("hour-expired.json"), encoded).await;
        }
    });
    Ok(initial)
}

#[tauri::command]
async fn sandbox_settings_review_finish_hour(
    runtime: State<'_, AgentRuntime>,
    root: State<'_, VerificationReviewRoot>,
    observation: State<'_, Arc<HourReviewState>>,
) -> Result<serde_json::Value, String> {
    let (initial, expired) = observation
        .0
        .lock()
        .map_err(|_| "Hour observation unavailable")?
        .clone()
        .ok_or("Original hour observation missing")?;
    let expired = expired.ok_or("Actual one-hour expiry is still pending")?;
    let expires = initial["authorization"]["expiresAtUnixMs"]
        .as_u64()
        .ok_or("Original deadline missing")?;
    let events = serde_json::to_value(runtime.events(AgentSessionEventsRequest {
        session_id: "hour-acceptance".into(),
        cursor: None,
        limit: 1000,
    })?)
    .map_err(|_| "Hour journal encoding failed")?;
    let events = events["events"]
        .as_array()
        .ok_or("Actual hour journal missing")?;
    let renewed = events.iter().any(|event| {
        event["type"] == "sandbox/resource_audit"
            && event["timeUnixMs"]
                .as_u64()
                .is_some_and(|now| now >= expires)
            && event["data"]["audit"]["action"] == "approved"
            && event["data"]["audit"]["scope"] == "once"
    });
    let completed = events.iter().any(|event| {
        event["type"] == "tool/result"
            && event["timeUnixMs"]
                .as_u64()
                .is_some_and(|now| now >= expires)
            && event["data"]["data"]["exitCode"] == 0
            && event["data"]["data"]["terminationConfirmed"] == true
            && event["data"]["data"]["stdout"] == "stage2-owned-read-input"
    });
    let passed = expired["passed"] == true && renewed && completed;
    let report = serde_json::json!({"passed":passed,"initial":initial,"expired":expired,"freshOnceResourceApproval":renewed,"freshNativeTerminal":completed,"stageStatus":"pending","stage3Allowed":false});
    tokio::fs::write(
        root.0.join("hour-acceptance.json"),
        serde_json::to_vec_pretty(&report).map_err(|_| "Hour report encoding failed")?,
    )
    .await
    .map_err(|_| "Hour report write failed")?;
    Ok(report)
}

#[tauri::command]
async fn sandbox_settings_review_native_result(
    app: tauri::AppHandle,
    root: State<'_, VerificationReviewRoot>,
    project: State<'_, NativeReviewProject>,
    checks: std::collections::BTreeMap<String, bool>,
    diagnostic: Option<String>,
) -> Result<(), String> {
    let root = root.0.clone();
    let project = project.0.clone();
    let fleet = std::env::var("SHELLSPAN_SANDBOX_FLEET_NATIVE").as_deref() == Ok("1");
    let passed = tokio::task::spawn_blocking(move || {
        let (marker, value, report, expected, scope): (_, _, _, &[&str], _) = if fleet {
            ("fleet-stage2-marker", "fleet-stage2", "fleet-native-review.json",
             &["parentGenerated", "fleetStarted", "childrenInherited", "operatorNativeResult", "fleetCompleted", "approvalsExact", "modelToolsBounded"],
             "actual public IPC fleet Operator command and owned marker; no active fleet cancellation claim")
        } else {
            ("child-stage2-marker", "child-stage2", "child-native-review.json",
             &["parentGenerated", "childInherited", "exactApproval", "nativeResult", "modelToolsBounded"],
             "actual public IPC child command and owned marker; no fleet native claim")
        };
        let effect = std::fs::read_to_string(project.join(marker)).is_ok_and(|content| content == value);
        let passed = checks.len() == expected.len() && expected.iter().all(|name| checks.get(*name) == Some(&true)) && effect;
        std::fs::write(root.join(report), serde_json::to_vec_pretty(&serde_json::json!({
            "passed":passed,"checks":checks,"markerMatches":effect,"scope":scope,
            "diagnostic":diagnostic.map(|value| crate::redaction::redact_sensitive_text(&value).chars().take(1024).collect::<String>())
        })).map_err(|_| "Native review encoding failed")?).map_err(|_| "Native review write failed")?;
        Ok::<_, String>(passed)
    }).await.map_err(|_| "Native review worker failed")??;
    app.exit(if passed { 0 } else { 1 });
    Ok(())
}

#[derive(serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OrchestrationReviewChecks {
    parent_generated: bool,
    explicit_narrow_role_rejected: bool,
    child_generated: bool,
    child_inherited: bool,
    child_no_tools: bool,
    outside_target_rejected: bool,
    one_shot_continuation_rejected: bool,
    fleet_started: bool,
    fleet_children_inherited: bool,
    fleet_completed: bool,
    fleet_no_tools: bool,
}

#[tauri::command]
fn sandbox_settings_review_orchestration_result(
    app: tauri::AppHandle,
    root: State<'_, VerificationReviewRoot>,
    checks: OrchestrationReviewChecks,
) -> Result<(), String> {
    let passed = checks.parent_generated
        && checks.explicit_narrow_role_rejected
        && checks.child_generated
        && checks.child_inherited
        && checks.child_no_tools
        && checks.outside_target_rejected
        && checks.one_shot_continuation_rejected
        && checks.fleet_started
        && checks.fleet_children_inherited
        && checks.fleet_completed
        && checks.fleet_no_tools;
    std::fs::write(root.0.join("orchestration-review.json"), serde_json::to_vec_pretty(&serde_json::json!({"passed":passed,"checks":checks,"scope":"actual public IPC with real model-only scoped child and fleet; not model-tool exposure or child command execution"})).map_err(|_|"Orchestration report encoding failed")?).map_err(|_|"Orchestration report write failed")?;
    app.exit(if passed { 0 } else { 1 });
    Ok(())
}

#[derive(serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct VerificationReviewChecks {
    first_verified: bool,
    completed_policy_roundtrip_discarded: bool,
    in_flight_policy_roundtrip_discarded: bool,
    fresh_verification_succeeds: bool,
}

#[tauri::command]
fn sandbox_settings_review_verification_result(
    app: tauri::AppHandle,
    root: State<'_, VerificationReviewRoot>,
    checks: VerificationReviewChecks,
) -> Result<(), String> {
    let passed = checks.first_verified
        && checks.completed_policy_roundtrip_discarded
        && checks.in_flight_policy_roundtrip_discarded
        && checks.fresh_verification_succeeds;
    let report = serde_json::json!({"passed":passed,"checks":checks,"scope":"StrictMode production verification hook and actual macOS SSH IPC; no model or main workbench execution"});
    std::fs::write(
        root.0.join("verification-regression.json"),
        serde_json::to_vec_pretty(&report).map_err(|_| "Verification report encoding failed")?,
    )
    .map_err(|_| "Verification report write failed")?;
    app.exit(if passed { 0 } else { 1 });
    Ok(())
}

enum ReviewFixture {
    Remote(super::remote_seatbelt::tests::Fixture),
    Local {
        source: super::native_agent_check::SourcePty,
        _workspace: std::path::PathBuf,
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
    app: tauri::AppHandle,
    sessions: State<'_, crate::models::SessionManager>,
) -> Result<serde_json::Value, String> {
    let remote = app.try_state::<RemoteReviewSource>();
    let session_id = remote
        .as_ref()
        .map_or("acceptance-source", |source| source.0.session_id.as_str());
    let actual = sessions.target_state(session_id)?;
    Ok(
        serde_json::json!({"sessionId":session_id,"profileId":remote.as_ref().and_then(|source|source.0.profile_id.clone()),"title":actual.identity.title,"host":actual.identity.host,"port":actual.identity.port,"username":actual.identity.username,"status":actual.status}),
    )
}

fn selected_review_route() -> Result<
    (
        crate::llm::routes::ProviderRoute,
        crate::llm::routes::RouteSnapshot,
    ),
    String,
> {
    use crate::llm::routes::{RouteSnapshot, ROUTES_KEY};
    let home = std::env::home_dir().ok_or("Model review home unavailable")?;
    let source = rusqlite::Connection::open_with_flags(
        home.join(".shellspan-dev/shellspan-v1.db"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .map_err(|_| "Model review default route database unavailable")?;
    let document: String = source
        .query_row(
            "SELECT value FROM preferences WHERE key=?1",
            [ROUTES_KEY],
            |row| row.get(0),
        )
        .map_err(|_| "Model review default route unavailable")?;
    let mut snapshot: RouteSnapshot =
        serde_json::from_str(&document).map_err(|_| "Model review route schema invalid")?;
    let selection = snapshot
        .default_selection
        .as_ref()
        .ok_or("Model review default selection missing")?
        .clone();
    if selection.model_id != "MiniMax-M3" {
        return Err("Model review requires the existing selected MiniMax-M3".into());
    }
    let route = snapshot.route(&selection.route_id)?.clone();
    snapshot.routes = vec![route.clone()];
    Ok((route, snapshot))
}

fn install_review_journal(root: &Path) -> Result<(), String> {
    let Some(path) = std::env::var_os("SHELLSPAN_SANDBOX_REVIEW_REPLAY_JOURNAL") else {
        return Ok(());
    };
    let source = std::path::PathBuf::from(path)
        .canonicalize()
        .map_err(|_| "Owned review journal unavailable")?;
    let allowed = std::env::current_dir()
        .map_err(|_| "Review checkout unavailable")?
        .join(".phase4-acceptance")
        .canonicalize()
        .map_err(|_| "Review evidence root unavailable")?;
    if !source.starts_with(allowed)
        || source.extension().and_then(|value| value.to_str()) != Some("jsonl")
        || !source.is_file()
        || std::fs::metadata(&source)
            .map_err(|_| "Review journal metadata unavailable")?
            .len()
            > 16 * 1024 * 1024
    {
        return Err("Replay requires an exact bounded owned acceptance journal".into());
    }
    let directory = root.join("agent-runtime/sessions-v5");
    std::fs::create_dir_all(&directory).map_err(|_| "Review replay directory unavailable")?;
    std::fs::copy(
        &source,
        directory.join(
            source
                .file_name()
                .ok_or("Review journal name unavailable")?,
        ),
    )
    .map_err(|_| "Review journal copy failed")?;
    Ok(())
}

fn initialize_local(app: &tauri::AppHandle, root: &Path) -> Result<ReviewFixture, String> {
    let workspace = root.join("owned-project");
    let reopening = std::env::var("SHELLSPAN_SANDBOX_WORKBENCH_REOPEN").as_deref() == Ok("1");
    if reopening {
        let intent: serde_json::Value = serde_json::from_slice(
            &std::fs::read(root.join("root-review-intent.json"))
                .map_err(|_| "Owned reopen intent unavailable")?,
        )
        .map_err(|_| "Owned reopen intent invalid")?;
        if intent["projectRoot"].as_str() != workspace.to_str() || !workspace.is_dir() {
            return Err("Owned reopen project does not match the original fixture".into());
        }
    } else {
        std::fs::create_dir(&workspace).map_err(|_| "Root review workspace unavailable")?;
        std::fs::write(workspace.join("package.json"), "{\"private\":true}")
            .map_err(|_| "Root review project metadata unavailable")?;
    }
    let canonical = workspace
        .canonicalize()
        .map_err(|_| "Root review workspace metadata unavailable")?;
    let database = crate::db::Database::open(&root.join("review.db"))?;
    let live_route = if std::env::var("SHELLSPAN_SANDBOX_WORKBENCH_MODEL").as_deref() == Ok("1") {
        Some(selected_review_route()?)
    } else {
        None
    };
    let credentials = if let Some((route, _)) = &live_route {
        let reference = match &route.auth {
            crate::llm::routes::RouteAuth::Keychain { reference } => Some(reference.clone()),
            crate::llm::routes::RouteAuth::None => None,
        };
        crate::keychain::CredentialManager::readonly_model_check(reference)
    } else {
        crate::keychain::CredentialManager::isolated_native_for_checks()
    };
    // Restore only the selected existing route/reference; never import a new
    // client-supplied credential reference through the route mutation API.
    if let Some((_, snapshot)) = &live_route {
        database.save_preferences(&[(
            crate::llm::routes::ROUTES_KEY.into(),
            serde_json::to_string(snapshot).map_err(|_| "Model review snapshot encoding failed")?,
        )])?;
    }
    let routes = crate::llm::routes::RouteStore::open(database.clone(), credentials.clone())?;
    if live_route.is_none() {
        let model = crate::llm::catalog::preset_models(
            "ollama",
            crate::llm::config::AiProviderKind::Ollama,
        )?
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
    }
    let sessions = crate::models::SessionManager::default();
    let source = super::native_agent_check::source(&sessions, &workspace)?;
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
    if !reopening {
        database.save_preferences(&[("agent_sandbox_defaults".into(), preferences.to_string())])?;
    }
    app.manage(database);
    app.manage(credentials);
    app.manage(sessions);
    app.manage(crate::llm::runtime::LlmRuntime { routes });
    std::fs::write(root.join("root-review-intent.json"),serde_json::to_vec_pretty(&serde_json::json!({"projectRoot":canonical,"liveModel":std::env::var("SHELLSPAN_SANDBOX_WORKBENCH_MODEL").as_deref()==Ok("1"),"scope":"actual owned PTY and production controller; model enabled only by explicit review mode"})).map_err(|_| "Root intent report invalid")?).map_err(|_| "Root intent report unavailable")?;
    Ok(ReviewFixture::Local {
        source,
        _workspace: workspace,
    })
}

pub(crate) fn run(root: &Path, root_entry: bool) -> Result<(), String> {
    let reopening = std::env::var("SHELLSPAN_SANDBOX_WORKBENCH_REOPEN").as_deref() == Ok("1");
    if reopening
        && (!root_entry
            || std::env::var("SHELLSPAN_SANDBOX_WORKBENCH_REMOTE").as_deref() == Ok("1")
            || std::env::var_os("SHELLSPAN_SANDBOX_REVIEW_REPLAY_JOURNAL").is_some())
    {
        return Err(
            "Reopen requires the original local workbench fixture without journal import".into(),
        );
    }
    let model_enabled =
        root_entry && std::env::var("SHELLSPAN_SANDBOX_WORKBENCH_MODEL").as_deref() == Ok("1");
    if !root.is_absolute()
        || !root.is_dir()
        || !reopening
            && std::fs::read_dir(root)
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
        .manage(BindingReviewFixture(fixture.clone()))
        .manage(ReviewClosedWrites::default())
        .manage(VerificationReviewRoot(root.to_owned()))
        .manage(Arc::new(HourReviewState::default()))
        .manage(crate::directory_request_registry::DirectoryRequestRegistry::default())
        .manage(crate::sftp_pool::SftpPool::default())
        .manage(crate::identity_cache::RemoteIdentityCache::default())
        .manage(ContainerResourceSupervisor::default())
        .manage(crate::petdex::PetdexAdapter::new(root.to_owned()))
        .invoke_handler(tauri::generate_handler![
            sandbox_settings_review_source,
            sandbox_settings_review_targets,
            sandbox_settings_review_window_size,
            sandbox_settings_review_connection,
            sandbox_settings_review_new_project,
            sandbox_settings_review_activity_started,
            sandbox_settings_review_activity_process,
            sandbox_settings_review_finish,
            sandbox_settings_review_verification_result,
            sandbox_settings_review_orchestration_result,
            sandbox_settings_review_native_result,
            sandbox_settings_review_observe_hour,
            sandbox_settings_review_finish_hour,
            crate::commands::load_preferences,
            crate::commands::save_preferences,
            crate::commands::list_local_directory,
            crate::commands::list_remote_directory,
            crate::commands::supersede_remote_directory_request,
            crate::commands::list_profiles,
            crate::commands::retrieve_profile_secret,
            crate::commands::retrieve_profile_password,
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
            super::commands::agent_runtime_resume_recovery,
            super::commands::agent_runtime_abort_recovery,
            super::commands::agent_runtime_reconcile_recovery,
            super::commands::agent_runtime_reconcile_direct_resources,
            super::commands::agent_runtime_resume,
            super::commands::agent_runtime_get_events,
            super::commands::agent_runtime_get_committed_events,
            super::commands::agent_runtime_approve_tool,
            super::commands::agent_runtime_reject_tool,
            super::commands::agent_runtime_get_pending_approval_arguments,
            super::commands::agent_runtime_answer_question,
            super::commands::agent_runtime_spawn_subagent,
            super::commands::agent_runtime_inspect_child_agent,
            super::commands::agent_runtime_send_child_input,
            super::commands::agent_runtime_cancel_child_agent,
            super::commands::agent_runtime_fleet_plan,
            super::commands::agent_runtime_fleet_start,
            super::commands::agent_runtime_fleet_abort,
            super::commands::agent_runtime_set_sandbox_policy,
            super::commands::agent_runtime_revoke_sandbox_reads,
            super::commands::agent_runtime_mutate_inbox,
            super::commands::agent_runtime_bind_project_root,
            super::commands::agent_runtime_set_permission,
            super::commands::agent_runtime_set_cache_directory_candidates,
            super::commands::agent_runtime_probe_native_sandbox,
            super::project_root_commands::agent_runtime_resolve_local_project_root,
            super::remote_backend_commands::agent_runtime_verify_remote_sandbox_target,
        ]);
    let app=builder.setup(move |app| {
        let handle=app.handle().clone();let retained=retained.clone();let saved=saved.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let result=(|| -> Result<(),String> {
                let remote_root_entry=root_entry && std::env::var("SHELLSPAN_SANDBOX_WORKBENCH_REMOTE").as_deref()==Ok("1");
                let owned=if root_entry && !remote_root_entry {initialize_local(&handle,&saved)?} else {
                    let app_root=handle.path().app_data_dir().map_err(|_| "Settings fixture root unavailable")?;
                    if !crate::known_hosts::known_hosts_path(&handle)?.starts_with(&app_root) {return Err("Settings fixture requires isolated known-hosts".into());}
                    let live_route=if remote_root_entry && model_enabled {Some(selected_review_route()?)} else {None};
                    let mut owned=super::remote_seatbelt::tests::Fixture::new();
                    if let Some((route,_))=&live_route {
                        let reference=match &route.auth {crate::llm::routes::RouteAuth::Keychain {reference}=>Some(reference.clone()),crate::llm::routes::RouteAuth::None=>None};
                        owned.install_with_model(&handle,reference)?;
                    } else {owned.install(&handle)?;}
                    if remote_root_entry {
                        let target=owned.target();
                        if std::env::var("SHELLSPAN_SANDBOX_REVIEW_TWO_TARGETS").as_deref()==Ok("1") {
                            let second=owned.new_review_target()?;
                            handle.manage(RemoteReviewTargets(vec![target.clone(),second]));
                        }
                        std::fs::write(saved.join("root-review-intent.json"),serde_json::to_vec_pretty(&serde_json::json!({"projectRoot":target.root_path,"liveModel":model_enabled,"scope":"actual owned remote PTY and full production controller; model enabled only by explicit mode"})).map_err(|_|"Remote root report encoding failed")?).map_err(|_|"Remote root report write failed")?;
                        handle.manage(RemoteReviewSource(target));
                    }
                    if let Some((_,snapshot))=live_route {handle.state::<crate::db::Database>().save_preferences(&[(crate::llm::routes::ROUTES_KEY.into(),serde_json::to_string(&snapshot).map_err(|_|"Remote review route snapshot encoding failed")?)])?;}
                    let routes=crate::llm::routes::RouteStore::open(handle.state::<crate::db::Database>().inner().clone(),handle.state::<crate::keychain::CredentialManager>().inner().clone())?;
                    handle.manage(crate::llm::runtime::LlmRuntime {routes});ReviewFixture::Remote(owned)
                };
                if root_entry && !remote_root_entry {install_review_journal(&saved)?;}
                let runtime=AgentRuntimeBuilder::new().build();runtime.configure(handle.path().app_data_dir().map_err(|_| "Settings review app directory unavailable")?)?;
                handle.manage(runtime.clone());runtime.configure_native(handle.clone())?;
                if !root_entry {
                  if let ReviewFixture::Remote(owned)=&owned {
                    runtime.create_session(serde_json::from_value(serde_json::json!({"sessionId":"remote-settings","taskId":"remote-settings","goal":"Review actual remote verification UI without model requests","target":owned.target(),"sandboxPolicy":"workspace","executionSurface":"direct","permissionMode":"requestApproval","successCriteria":["Verification is transient and grants no resources"]})).map_err(|_| "Settings review session invalid")?)?;
                  }
                }
                let orchestration=std::env::var("SHELLSPAN_SANDBOX_WORKBENCH_ORCHESTRATION").as_deref()==Ok("1");
                if orchestration {
                    let project=match &owned {ReviewFixture::Local {_workspace,..} if model_enabled => _workspace.canonicalize().map_err(|_|"Orchestration project unavailable")?,_=>return Err("Orchestration review requires the owned local real-model fixture".into())};
                    handle.manage(NativeReviewProject(project.clone()));
                    runtime.create_session(serde_json::from_value(serde_json::json!({"sessionId":"orchestration-parent","taskId":"orchestration-parent","goal":"Actual scoped public IPC acceptance without tool side effects","target":{"kind":"local","targetId":"terminal-acceptance-source","sessionId":"acceptance-source","cwd":project},"sandboxPolicy":"workspace","executionSurface":"direct","permissionMode":"requestApproval","capabilityScope":{"toolNames":["run_terminal_command","write_process_input","wait_process","kill_process","probe_http"],"effects":["none","readOnly","stateChange"],"targetIds":["terminal-acceptance-source"]},"successCriteria":["Scoped model-only child and fleet preserve permissions and binding"]})).map_err(|_|"Orchestration parent schema invalid")?)?;
                    runtime.create_session(serde_json::from_value(serde_json::json!({"sessionId":"orchestration-terminal-parent","taskId":"orchestration-terminal-parent","goal":"Actual terminal-default parent scope, with sandbox and approval unchanged","target":{"kind":"local","targetId":"terminal-acceptance-source","sessionId":"acceptance-source","cwd":project},"sandboxPolicy":"workspace","executionSurface":"direct","permissionMode":"requestApproval","successCriteria":["Effective child model tools remain within the parent's sandbox tool surface"]})).map_err(|_|"Terminal-default parent schema invalid")?)?;
                }
                *retained.lock().map_err(|_| "Settings review fixture unavailable")?=Some(owned);
                let url=if orchestration && std::env::var("SHELLSPAN_SANDBOX_FLEET_NATIVE").as_deref()==Ok("1") {"src/components/ai/__tests__/sandbox-fleet-native.html"} else if orchestration && std::env::var("SHELLSPAN_SANDBOX_CHILD_NATIVE").as_deref()==Ok("1") {"src/components/ai/__tests__/sandbox-child-native.html"} else if orchestration {"src/components/ai/__tests__/sandbox-orchestration-native.html"} else if root_entry && std::env::var("SHELLSPAN_SANDBOX_REVIEW_TWO_TARGETS").as_deref()==Ok("1") {"src/components/ai/__tests__/sandbox-settings-native.html?root-entry=1&two-targets=1"} else if root_entry {"src/components/ai/__tests__/sandbox-settings-native.html?root-entry=1"} else if std::env::var("SHELLSPAN_SANDBOX_VERIFICATION_REGRESSION").as_deref()==Ok("1") {"src/components/ai/__tests__/remote-verification-native.html?session=remote-settings"} else {"src/components/ai/__tests__/sandbox-settings-native.html?session=remote-settings"};
                tauri::WebviewWindowBuilder::new(&handle,"main",tauri::WebviewUrl::App(url.into())).title(if orchestration {"ShellSpan public IPC acceptance"} else {"ShellSpan isolated sandbox settings review"}).focused(!orchestration).inner_size(620.0,680.0).build().map_err(|_| "Settings review window unavailable")?;
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
        .map(ReviewFixture::source_writes)
        .or(*handle
            .state::<ReviewClosedWrites>()
            .0
            .lock()
            .map_err(|_| "Closing observation unavailable")?);
    let Some(runtime) = handle.try_state::<AgentRuntime>() else {
        std::fs::write(report_root.join("settings-review.json"),serde_json::to_vec_pretty(&serde_json::json!({"initializationCompleted":false,"exitCode":code,"modelRequests":0,"scope":"fixture initialization failed before runtime became available"})).map_err(|_|"Settings initialization report encoding failed")?).map_err(|_|"Settings initialization report unavailable")?;
        return Err("Settings review initialization failed; inspect isolated diagnostic".into());
    };
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
    let report = serde_json::json!({"scope":"isolated Wry production UI/controller and IPC","rootEntry":root_entry,"liveModel":model_enabled,"sourcePtyWrites":source_writes,"sessionsCreated":sessions.sessions.len(),"modelRequests":model_requests,"sandboxDefaults":preferences,"exitCode":code});
    std::fs::write(
        report_root.join("settings-review.json"),
        serde_json::to_vec_pretty(&report).map_err(|_| "Settings report invalid")?,
    )
    .map_err(|_| "Settings report unavailable")?;
    if code != 0
        || root_entry && !model_enabled && !sessions.sessions.is_empty()
        || source_writes != Some(0)
    {
        return Err("Settings review failed; inspect isolated diagnostic".into());
    }
    Ok(())
}

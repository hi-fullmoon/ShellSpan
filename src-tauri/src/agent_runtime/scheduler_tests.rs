mod scheduler_tests {
    use super::*;
    use std::collections::{HashMap, HashSet};
    use std::sync::Condvar;
    use tokio::sync::mpsc;

    /// Workers ignore cancellation until explicitly released: quiescence cannot be faked
    /// by dropping futures or by observing a cancellation token.
    struct GatedNative {
        prepared: Mutex<HashMap<String, NativeToolPreparation>>,
        preparations: Mutex<Vec<String>>,
        released: Mutex<HashSet<String>>,
        wake: Condvar,
        started: mpsc::UnboundedSender<String>,
        trace: Mutex<Vec<String>>,
        active: AtomicUsize,
        peak: AtomicUsize,
        mode: AtomicUsize,
        fail_prepare: Mutex<Option<String>>,
        worker_failure: Mutex<Option<String>>,
        tool_failure: Mutex<Option<String>>,
        invalid: AtomicBool,
    }

    impl GatedNative {
        fn new() -> (Arc<Self>, mpsc::UnboundedReceiver<String>) {
            let (started, receiver) = mpsc::unbounded_channel();
            (
                Arc::new(Self {
                    prepared: Mutex::new(HashMap::new()),
                    preparations: Mutex::new(Vec::new()),
                    released: Mutex::new(HashSet::new()),
                    wake: Condvar::new(),
                    started,
                    trace: Mutex::new(Vec::new()),
                    active: AtomicUsize::new(0),
                    peak: AtomicUsize::new(0),
                    mode: AtomicUsize::new(0),
                    fail_prepare: Mutex::new(None),
                    worker_failure: Mutex::new(None),
                    tool_failure: Mutex::new(None),
                    invalid: AtomicBool::new(false),
                }),
                receiver,
            )
        }

        fn release(&self, id: &str) {
            self.released.lock().unwrap().insert(id.into());
            self.wake.notify_all();
        }

        fn assert_clean(&self) {
            assert_eq!(self.active.load(Ordering::Acquire), 0);
            assert!(self.prepared.lock().unwrap().is_empty());
        }
    }

    impl NativeToolRuntime for GatedNative {
        fn prepare(&self, request: NativeToolRequest) -> Result<NativeToolPreparation, String> {
            let id = request.model_call.call_id.clone();
            self.preparations.lock().unwrap().push(id.clone());
            if self.fail_prepare.lock().unwrap().as_deref() == Some(&id) {
                return Err("schema rejected test input".into());
            }
            let mode = self.mode.load(Ordering::Acquire);
            let mut prepared = RecordingNativeRuntime::new(false).prepare(request)?;
            prepared.token = format!("{}-{}", id, uuid::Uuid::new_v4());
            if id == "dynamic" && mode != 0 {
                prepared.parallel = false;
                prepared.exclusive = true;
                prepared.requires_approval = mode == 2;
            }
            if id == "approval" {
                prepared.requires_approval = true;
            }
            if self.invalid.load(Ordering::Acquire) {
                prepared.expires_at_unix_ms = 0;
            }
            self.prepared
                .lock()
                .unwrap()
                .insert(prepared.token.clone(), prepared.clone());
            Ok(prepared)
        }

        fn execute(
            &self,
            token: &str,
            approved: bool,
            cancellation: CancellationToken,
        ) -> Result<NativeToolResult, String> {
            assert!(approved);
            let prepared = self.prepared.lock().unwrap().remove(token).unwrap();
            let id = prepared.call.call_id.clone();
            let active = self.active.fetch_add(1, Ordering::AcqRel) + 1;
            self.peak.fetch_max(active, Ordering::AcqRel);
            self.trace.lock().unwrap().push(format!("start:{id}"));
            self.started.send(id.clone()).unwrap();
            let gate = self.released.lock().unwrap();
            let (released, timeout) = self
                .wake
                .wait_timeout_while(gate, std::time::Duration::from_secs(10), |released| {
                    !released.contains(&id)
                })
                .unwrap();
            drop(released);
            self.active.fetch_sub(1, Ordering::AcqRel);
            self.trace.lock().unwrap().push(format!("end:{id}"));
            assert!(!timeout.timed_out(), "test failed to release worker {id}");
            let panic_worker = self.worker_failure.lock().unwrap().as_deref() == Some(id.as_str());
            assert!(!panic_worker, "injected worker panic");
            if self.tool_failure.lock().unwrap().as_deref() == Some(&id) {
                return Err("ordinary native tool failure".into());
            }
            Ok(NativeToolResult {
                call_id: id.clone(),
                native_name: prepared.call.native_name.unwrap(),
                target_id: "target-local".into(),
                effect: prepared.call.effect.unwrap(),
                status: if cancellation.is_cancelled() {
                    AgentToolResultStatus::Cancelled
                } else {
                    AgentToolResultStatus::Completed
                },
                summary: format!("completed {id}"),
                data: Some(
                    json!({"output": if id == "large" { "x".repeat(12000) } else { id.clone() },
                    "secret": "top-secret-native-value"}),
                ),
                duration_ms: None,
                evidence_refs: vec![],
                artifacts: vec![NativeToolArtifact {
                    artifact_id: format!("artifact-{id}"),
                    kind: "native-output".into(),
                    title: id,
                    size_bytes: Some(1),
                    media_type: Some("text/plain".into()),
                    sha256: None,
                }],
            })
        }

        fn abandon(&self, token: &str) {
            self.prepared.lock().unwrap().remove(token);
        }
    }

    async fn started(receiver: &mut mpsc::UnboundedReceiver<String>) -> String {
        tokio::time::timeout(std::time::Duration::from_secs(5), receiver.recv())
            .await
            .unwrap()
            .unwrap()
    }

    async fn idle(runtime: &AgentRuntime, id: &str) {
        tokio::time::timeout(std::time::Duration::from_secs(5), runtime.await_idle(id))
            .await
            .unwrap()
            .unwrap();
    }

    fn start(runtime: &AgentRuntime, id: &str) {
        create(runtime, id);
        runtime.followup(id, "input".into(), "go".into()).unwrap();
        runtime.start(id, provider(), None).unwrap();
    }

    fn results(runtime: &AgentRuntime, id: &str) -> Vec<String> {
        all_events(runtime, id)
            .into_iter()
            .filter_map(|event| match event.payload {
                AgentSessionEventPayload::ToolResult { call_id, .. } => Some(call_id),
                _ => None,
            })
            .collect()
    }

    fn setup(
        calls: Vec<ModelToolCall>,
        native: Arc<GatedNative>,
        limit: Option<&str>,
    ) -> (tempfile::TempDir, AgentRuntime) {
        let adapter = FakeAdapter::new(vec![tool_response(calls), reply("done", &[])]);
        let (root, runtime) = configured_with_native(adapter, AgentDriverConfig::default(), native);
        runtime.tools.configure_parallelism(limit).unwrap();
        (root, runtime)
    }

    #[tokio::test]
    async fn rolling_pool_replenishes_reverse_completions_and_honors_default_and_serial_limits() {
        for limit in [None, Some("1"), Some("2")] {
            let cap = limit.map(|v| v.parse::<usize>().unwrap()).unwrap_or(4);
            let (native, mut rx) = GatedNative::new();
            let calls = (0..7)
                .map(|i| native_call(&format!("r{i}"), "list_directory"))
                .collect();
            let (_root, runtime) = setup(calls, native.clone(), limit);
            start(&runtime, "pool");
            let mut first = Vec::new();
            for _ in 0..cap {
                first.push(started(&mut rx).await);
            }
            first.sort();
            assert_eq!(first, (0..cap).map(|i| format!("r{i}")).collect::<Vec<_>>());
            assert!(rx.try_recv().is_err());
            if cap > 1 {
                // r0 stays blocked: r(cap) must start when the LAST initial worker finishes.
                native.release(&format!("r{}", cap - 1));
                assert_eq!(started(&mut rx).await, format!("r{cap}"));
                assert!(results(&runtime, "pool").is_empty());
                assert!(native.trace.lock().unwrap().iter().all(|v| v != "end:r0"));
            }
            for i in 0..7 {
                native.release(&format!("r{i}"));
            }
            idle(&runtime, "pool").await;
            assert_eq!(native.peak.load(Ordering::Acquire), cap);
            assert_eq!(
                results(&runtime, "pool"),
                (0..7).map(|i| format!("r{i}")).collect::<Vec<_>>()
            );
            native.assert_clean();
        }
    }

    #[test]
    fn parallel_limit_rejects_invalid_values_without_changing_effective_configuration() {
        let (native, _) = GatedNative::new();
        let (_root, runtime) = setup(vec![], native, Some("2"));
        for value in [
            "",
            "0",
            "17",
            "-1",
            "1.5",
            "NaN",
            " 2",
            "2 ",
            "999999999999999999999999",
        ] {
            assert!(
                runtime.tools.configure_parallelism(Some(value)).is_err(),
                "{value}"
            );
        }
        assert!(runtime.tools.configure_parallelism(Some("16")).is_ok());
    }

    struct CancelHook {
        registry: Mutex<Option<AgentRegistry>>,
        before: bool,
    }

    impl AgentBeforeToolHook for CancelHook {
        fn before_tool(
            &self,
            context: &AgentBeforeToolContext,
        ) -> Result<AgentBeforeToolDecision, String> {
            if self.before {
                self.registry
                    .lock()
                    .unwrap()
                    .as_ref()
                    .unwrap()
                    .get(&context.session_id)?
                    .unwrap()
                    .cancel();
            }
            Ok(AgentBeforeToolDecision::Continue)
        }
    }

    impl AgentAfterToolHook for CancelHook {
        fn after_tool(
            &self,
            context: &AgentAfterToolContext,
        ) -> Result<AgentAfterToolDecision, String> {
            if !self.before {
                self.registry
                    .lock()
                    .unwrap()
                    .as_ref()
                    .unwrap()
                    .get(&context.session_id)?
                    .unwrap()
                    .cancel();
            }
            Ok(AgentAfterToolDecision::Continue)
        }
    }

    #[tokio::test]
    async fn cancellation_before_admission_in_hook_and_at_ready_completion_stops_replenishment() {
        for boundary in ["message", "before", "after"] {
            let (native, _rx) = GatedNative::new();
            native.release("r0");
            let root = tempfile::tempdir().unwrap();
            let hook = Arc::new(CancelHook {
                registry: Mutex::new(None),
                before: boundary == "before",
            });
            let adapter = FakeAdapter::new(vec![tool_response(vec![
                native_call("r0", "list_directory"),
                native_call("r1", "list_directory"),
            ])]);
            let runtime = AgentRuntimeBuilder::new()
                .model_factory(Arc::new(FakeFactory(adapter)))
                .native_tool_runtime(native.clone())
                .before_tool_hook(hook.clone())
                .after_tool_hook(hook.clone())
                .build();
            *hook.registry.lock().unwrap() = Some(runtime.agents.clone());
            runtime.configure(root.path().into()).unwrap();
            runtime.tools.configure_parallelism(Some("1")).unwrap();
            if boundary == "message" {
                let registry = runtime.agents.clone();
                runtime
                    .sessions
                    .set_publisher(Arc::new(move |event| {
                        if matches!(
                            event.payload,
                            AgentSessionEventPayload::AssistantMessage { .. }
                        ) {
                            registry.get(&event.session_id).unwrap().unwrap().cancel();
                        }
                    }))
                    .unwrap();
            }
            start(&runtime, "cancel-boundary");
            idle(&runtime, "cancel-boundary").await;
            assert_eq!(results(&runtime, "cancel-boundary"), ["r0", "r1"]);
            assert_eq!(
                native.trace.lock().unwrap().len(),
                if boundary == "after" { 2 } else { 0 }
            );
            native.assert_clean();
        }
    }

    #[tokio::test]
    async fn dispatch_commit_failure_abandons_tokens_and_never_replays_uncertain_siblings() {
        let (native, mut rx) = GatedNative::new();
        let (root, runtime) = setup(
            vec![
                native_call("r0", "list_directory"),
                native_call("r1", "list_directory"),
                native_call("last", "apply_patch"),
            ],
            native.clone(),
            Some("2"),
        );
        runtime.sessions.fail_appends_matching(|payload| {
            matches!(payload,
            AgentSessionEventPayload::ToolExecution { call_id, .. } if call_id == "r1")
        });
        start(&runtime, "dispatch");
        assert_eq!(started(&mut rx).await, "r0");
        native.release("r0");
        idle(&runtime, "dispatch").await;
        assert_eq!(results(&runtime, "dispatch"), ["last"]);
        assert!(rx.try_recv().is_err());
        native.assert_clean();
        let restarted = AgentRuntimeBuilder::new()
            .native_tool_runtime(native.clone())
            .build();
        restarted.configure(root.path().into()).unwrap();
        assert_eq!(
            restarted.session("dispatch").unwrap().recovery.kind,
            super::super::super::AgentRecoveryCheckpointKind::ExecutionInFlight
        );
        let entry = runtime.agents.get("dispatch").unwrap().unwrap();
        assert!(runtime.tools.resume_authorized(&entry).await.is_err());
        assert_eq!(native.trace.lock().unwrap().len(), 2);
    }

    #[tokio::test]
    async fn child_approval_reservation_survives_resume_and_cancellation_waits_for_decision_worker()
    {
        for cancel in [false, true] {
            let (native, mut rx) = GatedNative::new();
            let (_root, runtime) = setup(
                vec![
                    native_call("approval", "list_directory"),
                    native_call("last", "list_directory"),
                ],
                native.clone(),
                Some("4"),
            );
            create(&runtime, "parent");
            runtime.start("parent", provider(), None).unwrap();
            idle(&runtime, "parent").await;
            let child = runtime
                .spawn_subagent(AgentSubagentSpawnRequest {
                    parent_session_id: "parent".into(),
                    goal: "bounded approval".into(),
                    role: AgentSubagentRole::General,
                    inheritance_mode: "safePrefix".into(),
                    target_ids: vec!["target-local".into()],
                    budget: Some(super::super::super::AgentSubagentBudget {
                        max_steps_per_turn: 4,
                        max_turns: 1,
                        max_tool_calls: 1,
                        max_tokens: 8192,
                        timeout_ms: 60000,
                    }),
                    continuable: false,
                })
                .await
                .unwrap();
            let id = child.header.session_id;
            idle(&runtime, &id).await;
            assert_eq!(
                super::super::super::tool_pipeline::admitted_tool_calls(&all_events(&runtime, &id)),
                1
            );
            let decision = pending_approval(&runtime, &id);
            let approving_runtime = runtime.clone();
            let approving =
                tokio::spawn(async move { approving_runtime.approve_tool(decision).await });
            assert_eq!(started(&mut rx).await, "approval");
            if cancel {
                let entry = runtime.agents.get(&id).unwrap().unwrap();
                runtime.tools.cancel_session(&entry).unwrap();
                assert!(results(&runtime, &id).is_empty());
                assert_eq!(native.active.load(Ordering::Acquire), 1);
            }
            native.release("approval");
            let result = approving.await.unwrap();
            if cancel {
                result.unwrap();
            } else {
                assert!(result.unwrap_err().contains("subagentToolBudgetExceeded"));
                assert_eq!(
                    runtime.session(&id).unwrap().status,
                    AgentSessionStatus::Failed
                );
            }
            assert_eq!(results(&runtime, &id), ["approval", "last"]);
            assert_eq!(
                super::super::super::tool_pipeline::admitted_tool_calls(&all_events(&runtime, &id)),
                1
            );
            assert!(rx.try_recv().is_err());
            native.assert_clean();
        }
    }

    #[test]
    fn real_configuration_path_rejects_invalid_environment() {
        const PROBE: &str = "SHELLSPAN_STAGE5_CONFIG_PROBE";
        if std::env::var_os(PROBE).is_some() {
            let runtime = AgentRuntimeBuilder::new().build();
            let root = tempfile::tempdir().unwrap();
            assert!(runtime
                .configure(root.path().into())
                .unwrap_err()
                .contains("parallel tool limit"));
            return;
        }
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "agent_runtime::runtime::tests::scheduler_tests::real_configuration_path_rejects_invalid_environment"])
            .env(PROBE, "1").env("SHELLSPAN_MAX_PARALLEL_TOOL_CALLS", "0")
            .output().unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stdout)
        );
    }

    struct AdmissionHook {
        native: Arc<GatedNative>,
        seen: Mutex<Vec<String>>,
        fail: bool,
    }

    impl AgentBeforeToolHook for AdmissionHook {
        fn before_tool(
            &self,
            context: &AgentBeforeToolContext,
        ) -> Result<AgentBeforeToolDecision, String> {
            self.seen.lock().unwrap().push(context.call_id.clone());
            if context.call_id == "barrier" && self.native.mode.load(Ordering::Acquire) != 0 {
                if self.fail {
                    return Err("injected before hook failure".into());
                }
                return Ok(AgentBeforeToolDecision::Reject {
                    reason: "earlier result revoked access".into(),
                });
            }
            Ok(AgentBeforeToolDecision::Continue)
        }
    }

    #[tokio::test]
    async fn barrier_hook_observes_prior_results_exactly_once_and_abandons_probe() {
        for fail in [false, true] {
            let (native, mut rx) = GatedNative::new();
            let hook = Arc::new(AdmissionHook {
                native: native.clone(),
                seen: Mutex::new(vec![]),
                fail,
            });
            let (observed, mut hooks) = mpsc::unbounded_channel();
            let root = tempfile::tempdir().unwrap();
            let adapter = FakeAdapter::new(vec![
                tool_response(vec![
                    native_call("r0", "list_directory"),
                    native_call("barrier", "apply_patch"),
                ]),
                reply("done", &[]),
            ]);
            let runtime = AgentRuntimeBuilder::new()
                .model_factory(Arc::new(FakeFactory(adapter)))
                .native_tool_runtime(native.clone())
                .before_tool_hook(hook.clone())
                .after_tool_hook(Arc::new(ModeHook {
                    native: native.clone(),
                    mode: 1,
                    observed,
                    fail: false,
                }))
                .build();
            runtime.configure(root.path().into()).unwrap();
            start(&runtime, "hook");
            assert_eq!(started(&mut rx).await, "r0");
            native.release("r0");
            let _ = started(&mut hooks).await;
            idle(&runtime, "hook").await;
            assert!(rx.try_recv().is_err());
            assert_eq!(*hook.seen.lock().unwrap(), ["r0", "barrier"]);
            assert_eq!(results(&runtime, "hook"), ["r0", "barrier"]);
            assert_eq!(
                runtime.session("hook").unwrap().status,
                if fail {
                    AgentSessionStatus::Waiting
                } else {
                    AgentSessionStatus::Idle
                }
            );
            native.assert_clean();
        }
    }

    pub(super) async fn verify_write_barrier() {
        for barrier_name in ["apply_patch", "update_plan", "inspect_child_agent"] {
            let (native, mut rx) = GatedNative::new();
            let mut barrier = native_call("barrier", barrier_name);
            if barrier_name == "update_plan" {
                barrier.arguments = json!({"planVersion": 1, "steps": [
                    {"id": "inspect", "title": "Inspect", "status": "inProgress"}
                ]});
            }
            let (_root, runtime) = setup(
                vec![
                    native_call("r0", "list_directory"),
                    native_call("r1", "list_directory"),
                    barrier,
                    native_call("last", "list_directory"),
                ],
                native.clone(),
                Some("2"),
            );
            start(&runtime, "barriers");
            let _ = started(&mut rx).await;
            let _ = started(&mut rx).await;
            native.release("r1");
            assert!(rx.try_recv().is_err());
            native.release("r0");
            if barrier_name == "apply_patch" {
                assert_eq!(started(&mut rx).await, "barrier");
                assert!(rx.try_recv().is_err());
                native.release("barrier");
            }
            assert_eq!(started(&mut rx).await, "last");
            assert_eq!(results(&runtime, "barriers"), ["r0", "r1", "barrier"]);
            native.release("last");
            idle(&runtime, "barriers").await;
            assert_eq!(
                results(&runtime, "barriers"),
                ["r0", "r1", "barrier", "last"]
            );
            native.assert_clean();
        }
    }

    #[tokio::test]
    async fn writes_session_and_orchestration_are_drained_barriers() {
        verify_write_barrier().await;
    }

    #[tokio::test]
    async fn skill_success_is_exclusive_and_following_sensitive_write_still_waits_for_approval() {
        let (native, mut rx) = GatedNative::new();
        let root = tempfile::tempdir().unwrap();
        super::skill_tests::write_skill(
            root.path(),
            "barrier",
            "allowed-tools: '*'\n",
            "Proceed with the task",
        );
        let mut skill = native_call("skill", "skill");
        skill.arguments = json!({"name":"barrier"});
        let (_storage, runtime) = setup(
            vec![
                native_call("r0", "list_directory"),
                native_call("r1", "list_directory"),
                skill,
                native_call("approval", "apply_patch"),
                native_call("last", "list_directory"),
            ],
            native.clone(),
            Some("2"),
        );
        super::skill_tests::create_skill_session(&runtime, "skill-barrier", root.path());
        runtime
            .followup("skill-barrier", "u".into(), "go".into())
            .unwrap();
        runtime.start("skill-barrier", provider(), None).unwrap();
        let _ = started(&mut rx).await;
        let _ = started(&mut rx).await;
        native.release("r1");
        assert!(!all_events(&runtime, "skill-barrier").iter().any(
            |e| matches!(&e.payload,AgentSessionEventPayload::ToolCall{call}if call.name=="skill")
        ));
        native.release("r0");
        idle(&runtime, "skill-barrier").await;
        assert_eq!(results(&runtime, "skill-barrier"), ["r0", "r1", "skill"]);
        let approval = pending_approval(&runtime, "skill-barrier");
        assert_eq!(approval.call_id, "approval");
        assert!(rx.try_recv().is_err());
        native.release("approval");
        native.release("last");
        runtime.approve_tool(approval).await.unwrap();
        idle(&runtime, "skill-barrier").await;
        assert_eq!(
            results(&runtime, "skill-barrier"),
            ["r0", "r1", "skill", "approval", "last"]
        );
        native.assert_clean();
    }

    #[tokio::test]
    async fn child_budget_covers_inflight_prepare_failure_and_mixed_calls() {
        for (names, budget, preparation_failure, expected_executed) in [
            (
                vec!["list_directory", "list_directory", "list_directory"],
                1,
                false,
                1,
            ),
            (vec!["list_directory", "list_directory"], 2, false, 2),
            (vec!["list_directory", "list_directory"], 1, true, 0),
            (vec!["update_plan", "list_directory"], 1, false, 0),
            (vec!["inspect_child_agent", "list_directory"], 1, false, 0),
        ] {
            let (native, _rx) = GatedNative::new();
            if preparation_failure {
                *native.fail_prepare.lock().unwrap() = Some("r0".into());
            }
            let calls = names
                .iter()
                .enumerate()
                .map(|(i, name)| {
                    let id = format!("r{i}");
                    native.release(&id);
                    let mut call = native_call(&id, name);
                    if *name == "update_plan" {
                        call.arguments = json!({"planVersion": 1, "steps": [
                            {"id": "inspect", "title": "Inspect", "status": "inProgress"}
                        ]});
                    }
                    call
                })
                .collect();
            let (_root, runtime) = setup(calls, native.clone(), Some("4"));
            create(&runtime, "parent");
            runtime.start("parent", provider(), None).unwrap();
            idle(&runtime, "parent").await;
            let child = runtime
                .spawn_subagent(AgentSubagentSpawnRequest {
                    parent_session_id: "parent".into(),
                    goal: "bounded work".into(),
                    role: AgentSubagentRole::General,
                    inheritance_mode: "safePrefix".into(),
                    target_ids: vec!["target-local".into()],
                    budget: Some(super::super::super::AgentSubagentBudget {
                        max_steps_per_turn: 4,
                        max_turns: 1,
                        max_tool_calls: budget,
                        max_tokens: 8192,
                        timeout_ms: 60000,
                    }),
                    continuable: false,
                })
                .await
                .unwrap();
            idle(&runtime, &child.header.session_id).await;
            assert_eq!(
                native.trace.lock().unwrap().len() / 2,
                expected_executed,
                "{names:?}"
            );
            let events = all_events(&runtime, &child.header.session_id);
            assert_eq!(
                super::super::super::tool_pipeline::admitted_tool_calls(&events),
                budget
            );
            assert_eq!(
                results(&runtime, &child.header.session_id).len(),
                names.len()
            );
            native.assert_clean();
        }
    }

    #[tokio::test]
    async fn preparation_validation_releases_tokens_and_ordinary_tool_failure_continues() {
        for invalid in [false, true] {
            let (native, _rx) = GatedNative::new();
            native.invalid.store(invalid, Ordering::Release);
            *native.tool_failure.lock().unwrap() = Some("r0".into());
            native.release("r0");
            native.release("r1");
            let (_root, runtime) = setup(
                vec![
                    native_call("r0", "list_directory"),
                    native_call("r1", "list_directory"),
                ],
                native.clone(),
                Some("2"),
            );
            start(&runtime, "ordinary");
            idle(&runtime, "ordinary").await;
            assert_eq!(results(&runtime, "ordinary"), ["r0", "r1"]);
            assert_eq!(
                runtime.session("ordinary").unwrap().status,
                AgentSessionStatus::Idle
            );
            native.assert_clean();
        }
    }

    #[tokio::test]
    async fn event_and_artifact_failures_drain_without_fabricating_tool_success() {
        for artifact in [false, true] {
            let (native, mut rx) = GatedNative::new();
            let (root, runtime) = setup(
                vec![
                    native_call("large", "list_directory"),
                    native_call("r1", "list_directory"),
                    native_call("last", "apply_patch"),
                ],
                native.clone(),
                Some("2"),
            );
            start(&runtime, "storage");
            let _ = started(&mut rx).await;
            let _ = started(&mut rx).await;
            if artifact {
                let directory = root
                    .path()
                    .join("agent-runtime")
                    .join("artifacts-v2")
                    .join("storage");
                std::fs::write(directory, "blocked artifact directory").unwrap();
            } else {
                runtime.sessions.fail_appends_matching(|payload| {
                    matches!(payload,
                    AgentSessionEventPayload::ToolResult { call_id, .. } if call_id == "large")
                });
            }
            native.release("large");
            native.release("r1");
            idle(&runtime, "storage").await;
            assert_eq!(results(&runtime, "storage"), ["last"]);
            assert_eq!(
                runtime.session("storage").unwrap().recovery.kind,
                super::super::super::AgentRecoveryCheckpointKind::ExecutionInFlight
            );
            native.assert_clean();
        }
    }

    struct ModeHook {
        native: Arc<GatedNative>,
        mode: usize,
        observed: mpsc::UnboundedSender<String>,
        fail: bool,
    }

    impl AgentAfterToolHook for ModeHook {
        fn after_tool(
            &self,
            context: &AgentAfterToolContext,
        ) -> Result<AgentAfterToolDecision, String> {
            if context.call_id == "r0" {
                self.native.mode.store(self.mode, Ordering::Release);
                self.observed.send("r0".into()).unwrap();
                if self.fail {
                    return Err("injected after hook failure".into());
                }
            }
            Ok(AgentAfterToolDecision::Continue)
        }
    }

    #[tokio::test]
    async fn committed_hook_changes_reclassify_exclusive_and_approval_barriers() {
        for mode in [1, 2] {
            let (native, mut rx) = GatedNative::new();
            let (observed, mut hooks) = mpsc::unbounded_channel();
            let adapter = FakeAdapter::new(vec![
                tool_response(vec![
                    native_call("r0", "list_directory"),
                    native_call("r1", "list_directory"),
                    native_call("dynamic", "list_directory"),
                    native_call("last", "list_directory"),
                ]),
                reply("done", &[]),
            ]);
            let root = tempfile::tempdir().unwrap();
            let runtime = AgentRuntimeBuilder::new()
                .model_factory(Arc::new(FakeFactory(adapter)))
                .native_tool_runtime(native.clone())
                .after_tool_hook(Arc::new(ModeHook {
                    native: native.clone(),
                    mode,
                    observed,
                    fail: false,
                }))
                .build();
            runtime.configure(root.path().into()).unwrap();
            runtime.tools.configure_parallelism(Some("2")).unwrap();
            start(&runtime, "dynamic");
            let _ = started(&mut rx).await;
            let _ = started(&mut rx).await;
            native.release("r0");
            assert_eq!(started(&mut hooks).await, "r0");
            native.release("r1");
            if mode == 2 {
                idle(&runtime, "dynamic").await;
                assert_eq!(
                    runtime.session("dynamic").unwrap().status,
                    AgentSessionStatus::Waiting
                );
                assert!(rx.try_recv().is_err());
                native.release("dynamic");
                native.release("last");
                runtime
                    .approve_tool(pending_approval(&runtime, "dynamic"))
                    .await
                    .unwrap();
            } else {
                assert_eq!(started(&mut rx).await, "dynamic");
                assert!(rx.try_recv().is_err());
                native.release("dynamic");
                assert_eq!(started(&mut rx).await, "last");
                native.release("last");
            }
            idle(&runtime, "dynamic").await;
            let trace = native.trace.lock().unwrap();
            let pos = |s: &str| trace.iter().position(|v| v == s).unwrap();
            assert!(pos("end:r1") < pos("start:dynamic"));
            assert!(pos("end:dynamic") < pos("start:last"));
            assert_eq!(
                results(&runtime, "dynamic"),
                ["r0", "r1", "dynamic", "last"]
            );
            native.assert_clean();
        }
    }

    #[tokio::test]
    async fn cancellation_drains_actual_workers_and_records_unstarted_pairs() {
        let (native, mut rx) = GatedNative::new();
        let (_root, runtime) = setup(
            (0..4)
                .map(|i| native_call(&format!("r{i}"), "list_directory"))
                .collect(),
            native.clone(),
            Some("2"),
        );
        start(&runtime, "cancel");
        let _ = started(&mut rx).await;
        let _ = started(&mut rx).await;
        let entry = runtime.agents.get("cancel").unwrap().unwrap();
        entry.cancel();
        let cancelling_runtime = runtime.clone();
        let cancelling = tokio::spawn(async move { cancelling_runtime.cancel("cancel").await });
        native.release("r1");
        assert!(!cancelling.is_finished());
        assert!(!runtime.session("cancel").unwrap().ended);
        native.release("r0");
        cancelling.await.unwrap().unwrap();
        assert_eq!(results(&runtime, "cancel"), ["r0", "r1", "r2", "r3"]);
        let events = all_events(&runtime, "cancel");
        assert_eq!(
            super::super::super::tool_pipeline::admitted_tool_calls(&events),
            2
        );
        assert!(native
            .preparations
            .lock()
            .unwrap()
            .iter()
            .all(|id| id == "r0" || id == "r1"));
        native.assert_clean();
    }

    #[tokio::test]
    async fn hook_and_worker_failures_drain_and_preserve_uncertainty_on_reload() {
        for worker in [false, true] {
            let (native, mut rx) = GatedNative::new();
            if worker {
                *native.worker_failure.lock().unwrap() = Some("r0".into());
            }
            let (observed, mut hooks) = mpsc::unbounded_channel();
            let root = tempfile::tempdir().unwrap();
            let adapter = FakeAdapter::new(vec![tool_response(vec![
                native_call("r0", "list_directory"),
                native_call("r1", "list_directory"),
                native_call("last", "list_directory"),
            ])]);
            let runtime = AgentRuntimeBuilder::new()
                .model_factory(Arc::new(FakeFactory(adapter)))
                .native_tool_runtime(native.clone())
                .after_tool_hook(Arc::new(ModeHook {
                    native: native.clone(),
                    mode: 0,
                    observed,
                    fail: true,
                }))
                .build();
            runtime.configure(root.path().into()).unwrap();
            runtime.tools.configure_parallelism(Some("2")).unwrap();
            start(&runtime, "failure");
            let _ = started(&mut rx).await;
            let _ = started(&mut rx).await;
            native.release("r0");
            if !worker {
                let _ = started(&mut hooks).await;
            }
            tokio::time::timeout(
                std::time::Duration::from_secs(5),
                runtime.tools.wait_for_scheduler_failure(),
            )
            .await
            .unwrap();
            assert!(rx.try_recv().is_err());
            assert!(!runtime.session("failure").unwrap().ended);
            native.release("r1");
            idle(&runtime, "failure").await;
            assert_eq!(
                runtime.session("failure").unwrap().status,
                AgentSessionStatus::Waiting
            );
            assert!(native
                .trace
                .lock()
                .unwrap()
                .iter()
                .all(|event| event.ends_with(":r0") || event.ends_with(":r1")));
            assert!(native
                .preparations
                .lock()
                .unwrap()
                .iter()
                .all(|id| id == "r0" || id == "r1"));
            assert_eq!(results(&runtime, "failure"), ["last"]);
            native.assert_clean();
            let before = all_events(&runtime, "failure");
            let restarted = AgentRuntimeBuilder::new()
                .native_tool_runtime(native.clone())
                .build();
            restarted.configure(root.path().into()).unwrap();
            assert_eq!(
                restarted.session("failure").unwrap().recovery.kind,
                super::super::super::AgentRecoveryCheckpointKind::ExecutionInFlight
            );
            assert_eq!(all_events(&restarted, "failure"), before);
            assert_eq!(native.trace.lock().unwrap().len(), 4);
        }
    }

    #[tokio::test]
    async fn cancelled_recovered_authorization_never_dispatches_or_leaks_its_token() {
        let (native, _rx) = GatedNative::new();
        let (root, first) = setup(
            vec![
                native_call("approval", "apply_patch"),
                native_call("last", "list_directory"),
            ],
            native.clone(),
            Some("2"),
        );
        start(&first, "recovered-cancel");
        idle(&first, "recovered-cancel").await;
        let decision = pending_approval(&first, "recovered-cancel");
        first
            .append_for_driver(
                "recovered-cancel",
                Some(decision.turn_id),
                Some(decision.step_id),
                AgentSessionEventPayload::ToolApproval {
                    request_id: decision.request_id,
                    call_id: decision.call_id,
                    approval_id: Some(decision.approval_id),
                    status: AgentToolApprovalStatus::Approved,
                    risk: Some(AgentSessionEffect::StateChange),
                    reason: Some("crash before dispatch".into()),
                    expires_at_unix_ms: None,
                    prompt: None,
                },
            )
            .unwrap();
        drop(first);
        // A restarted process has a new native registry; the simulated old process's
        // expiry task can still own its pending approval until the test runtime exits.
        let (native, _restarted_rx) = GatedNative::new();
        let restarted = AgentRuntimeBuilder::new()
            .model_factory(Arc::new(FakeFactory(FakeAdapter::new(vec![]))))
            .native_tool_runtime(native.clone())
            .build();
        restarted.configure(root.path().into()).unwrap();
        restarted
            .start("recovered-cancel", provider(), None)
            .unwrap();
        restarted.cancel("recovered-cancel").await.unwrap();
        assert_eq!(
            results(&restarted, "recovered-cancel"),
            ["approval", "last"]
        );
        assert!(native.trace.lock().unwrap().is_empty());
        native.assert_clean();
    }

    #[tokio::test]
    async fn complete_store_outage_retains_dispatch_evidence_and_blocks_restart_replay() {
        let (native, mut rx) = GatedNative::new();
        let (root, runtime) = setup(
            vec![
                native_call("r0", "list_directory"),
                native_call("r1", "list_directory"),
                native_call("last", "list_directory"),
            ],
            native.clone(),
            Some("2"),
        );
        start(&runtime, "outage");
        let _ = started(&mut rx).await;
        let _ = started(&mut rx).await;
        runtime.sessions.fail_appends_matching(|_| true);
        native.release("r0");
        tokio::time::timeout(
            std::time::Duration::from_secs(5),
            runtime.tools.wait_for_scheduler_failure(),
        )
        .await
        .unwrap();
        native.release("r1");
        idle(&runtime, "outage").await;
        assert!(results(&runtime, "outage").is_empty());
        native.assert_clean();
        let restarted = AgentRuntimeBuilder::new()
            .model_factory(Arc::new(FakeFactory(FakeAdapter::new(vec![]))))
            .native_tool_runtime(native.clone())
            .build();
        restarted.configure(root.path().into()).unwrap();
        assert_eq!(
            restarted.session("outage").unwrap().recovery.kind,
            super::super::super::AgentRecoveryCheckpointKind::ExecutionInFlight
        );
        restarted.start("outage", provider(), None).unwrap();
        assert!(restarted.resume_recovery("outage").await.is_err());
        assert_eq!(native.trace.lock().unwrap().len(), 4);
        native.assert_clean();
    }

    #[tokio::test]
    async fn later_worker_failure_stops_pool_before_earlier_result_or_budget_settlement() {
        let (native, mut rx) = GatedNative::new();
        *native.worker_failure.lock().unwrap() = Some("r1".into());
        let (_root, runtime) = setup(
            vec![
                native_call("r0", "list_directory"),
                native_call("r1", "list_directory"),
                native_call("last", "list_directory"),
            ],
            native.clone(),
            Some("2"),
        );
        start(&runtime, "later-failure");
        let _ = started(&mut rx).await;
        let _ = started(&mut rx).await;
        native.release("r1");
        tokio::time::timeout(
            std::time::Duration::from_secs(5),
            runtime.tools.wait_for_scheduler_failure(),
        )
        .await
        .unwrap();
        assert!(rx.try_recv().is_err());
        assert_eq!(native.active.load(Ordering::Acquire), 1);
        native.release("r0");
        idle(&runtime, "later-failure").await;
        assert_eq!(results(&runtime, "later-failure"), ["last"]);
        assert_eq!(
            runtime.session("later-failure").unwrap().recovery.kind,
            super::super::super::AgentRecoveryCheckpointKind::ExecutionInFlight
        );
        native.assert_clean();
    }
}

use super::super::*;

#[tokio::test]
async fn actual_registry_child_admission_shares_native_shutdown_and_allows_cleanup() {
    let root = tempfile::tempdir().unwrap();
    let runtime = AgentRuntimeBuilder::new().build();
    runtime.configure(root.path().to_path_buf()).unwrap();
    for id in ["parent", "child", "late-child"] {
        runtime.create_session(serde_json::from_value(serde_json::json!({
            "sessionId":id,"taskId":"shutdown-registry","goal":"Verify actual Agent ownership admission without sending model requests",
            "sandboxPolicy":"host","permissionMode":"requestApproval","executionSurface":"direct","successCriteria":["Closing rejects child attachment and driver acquisition"],
        })).unwrap()).unwrap();
    }
    let mut provider = crate::ai::AiProviderConfig {
        id: "shutdown-registry-ollama".into(),
        profile: "ollama".into(),
        kind: crate::ai::AiProviderKind::Ollama,
        base_url: "http://127.0.0.1:11434".into(),
        model: "llama3.2:3b".into(),
        model_definition: None,
        retry_policy: None,
        reasoning_effort: None,
        requires_api_key: false,
        api_key: None,
    };
    provider.model_definition = Some(crate::llm::catalog::declaration_template(&provider).unwrap());
    // Production HTTP adapter construction only; no fake provider response or model request.
    let adapter = runtime.models.resolve(provider.clone(), None).unwrap();
    let parent = runtime
        .agents
        .attach(
            runtime.sessions.clone(),
            "parent".into(),
            provider.clone(),
            adapter.clone(),
        )
        .unwrap();
    let child = runtime
        .agents
        .attach(
            runtime.sessions.clone(),
            "child".into(),
            provider.clone(),
            adapter.clone(),
        )
        .unwrap();
    runtime
        .agents
        .set_owner(&child.entry(), &parent.entry())
        .unwrap();
    assert!(child.entry().try_acquire_driver().unwrap());
    child.entry().release_driver();
    assert!(runtime.native_engine.begin_shutdown_admission());
    assert!(parent.entry().cancellation().is_cancelled());
    assert!(child.entry().cancellation().is_cancelled());
    assert!(!child.entry().is_admitting());
    assert!(child.entry().try_acquire_driver().is_err());
    assert!(!child.entry().is_driver_active());
    assert!(runtime
        .agents
        .attach(
            runtime.sessions.clone(),
            "late-child".into(),
            provider,
            adapter
        )
        .is_err());
    runtime.native_engine.await_shutdown_dispatch().unwrap();
    child.interrupt().await.unwrap();
    parent.interrupt().await.unwrap();
    assert!(runtime.agents.get("parent").unwrap().is_none());
    assert!(runtime.agents.get("child").unwrap().is_none());
    assert!(runtime.native_engine.ensure_shutdown_admission().is_err());
}

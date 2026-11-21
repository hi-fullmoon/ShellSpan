use super::*;
use crate::agent_runtime::{assemble_model_input, default_model_tools, AgentSessionHeader};
use crate::llm::{
    adapter::ModelStreamSink,
    errors::NormalizedModelError,
    routes::{RouteSnapshot, RouteStore},
    runtime::LlmRuntime,
    types::{ModelContentBlock, ModelMessage, ModelRequest, StreamDelta},
};
use tokio_util::sync::CancellationToken;

struct LiveSink;

impl ModelStreamSink for LiveSink {
    fn emit(&self, _: StreamDelta) -> Result<(), NormalizedModelError> {
        Ok(())
    }
}

/// Opt-in real provider + native filesystem verification. Never touches the
/// original remote workspace; credentials remain in the normal keychain path.
#[tokio::test]
#[ignore = "requires MiniMax keychain route, SHELLSPAN_LIVE_WRITE_DB, SESSION and OUTPUT"]
async fn real_minimax_write_file_creates_and_replaces_verified_files() {
    let output = PathBuf::from(std::env::var("SHELLSPAN_LIVE_WRITE_OUTPUT").unwrap());
    fs::create_dir_all(&output).unwrap();
    let workspace = tempfile::tempdir().unwrap();
    let state = tempfile::tempdir().unwrap();
    let source = rusqlite::Connection::open_with_flags(
        std::env::var("SHELLSPAN_LIVE_WRITE_DB").unwrap(),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap();
    let document: String = source
        .query_row(
            "SELECT value FROM preferences WHERE key='llm.routes.v1'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    drop(source);
    let snapshot: RouteSnapshot = serde_json::from_str(&document).unwrap();
    let route = snapshot
        .routes
        .iter()
        .find(|r| r.preset_id == "minimax")
        .unwrap();
    let mut selection = route.defaults.clone().unwrap();
    selection.model_id = "MiniMax-M3.1-Flash".into();
    let database = Database::open(&state.path().join("routes.db")).unwrap();
    database.commit_llm_routes(None, &document).unwrap();
    let routes = RouteStore::open(database, CredentialManager::new()).unwrap();
    let model = LlmRuntime { routes }
        .prepare_model(
            &selection,
            Arc::new(crate::agent_runtime::images::ImageStore::default()),
        )
        .unwrap();
    assert_eq!(model.provider.profile, "minimax");
    let session =
        fs::read_to_string(std::env::var("SHELLSPAN_LIVE_WRITE_SESSION").unwrap()).unwrap();
    let event: Value = serde_json::from_str(session.lines().next().unwrap()).unwrap();
    let mut header = event["data"].clone();
    header["sessionId"] = event["sessionId"].clone();
    header["createdAtUnixMs"] = event["timeUnixMs"].clone();
    for field in [
        "modelSelection",
        "parentSessionId",
        "continuedFromSessionId",
        "capabilityScope",
        "subagent",
    ] {
        header[field] = Value::Null;
    }
    header["title"] = json!("Live MiniMax file write verification");
    header["goal"] = json!("按本轮用户要求使用文件工具创建或替换指定文件");
    header["successCriteria"] = json!(["指定文件已写入"]);
    header["executionSurface"] = json!("direct");
    header["target"] = json!({
        "kind": "local", "targetId": "live-write", "sessionId": "live-write",
        "label": "Live verification", "cwd": workspace.path().to_string_lossy()
    });
    let header: AgentSessionHeader = serde_json::from_value(header).unwrap();
    let assembly = assemble_model_input(&header, default_model_tools());
    let target = AgentToolTargetNative::Local {
        target_id: "live-write".into(),
        session_id: "live-write".into(),
        cwd: Some(workspace.path().to_string_lossy().into()),
    };
    let database = Database::open(&state.path().join("files.db")).unwrap();
    let credentials = CredentialManager::in_memory_for_tests();
    let checkpoints = CheckpointStoreNative::default();
    let operations = FileOperationRegistryNative::default();
    let known_hosts = state.path().join("known_hosts");
    let mut results = Vec::new();
    for (index, (path, prompt)) in [
        ("notes.txt", "在当前目录创建 notes.txt，内容为两行：第一行 MiniMax 实际写入验证，第二行 中文与 UTF-8。请直接使用文件工具完成。"),
        ("storage.py", "只在当前目录创建 storage.py，实现一个使用 Python sqlite3 的 TodoStore 类，提供初始化建表、添加待办和列出待办的方法。当前目录已存在，这一步只生成源文件，无需检查系统环境或运行程序，请直接调用 write_file 写入完整代码。"),
        ("empty.txt", "在当前目录创建一个内容为空的 empty.txt 文件。请直接使用文件工具完成。"),
        ("notes.txt", "把当前目录 notes.txt 完整替换为一行：MiniMax 摘要校验替换成功。使用 write_file 完成。当前文件的 SHA-256 是 DIGEST。"),
    ].into_iter().enumerate() {
        let replacing = index == 3;
        let digest = if replacing { sha256_hex(&fs::read(workspace.path().join(path)).unwrap()) } else { String::new() };
        let mut messages: Vec<_> = assembly.context.iter().map(|c| ModelMessage::User { content: c.content.clone() }).collect();
        messages.push(ModelMessage::User { content: prompt.replace("DIGEST", &digest) });
        let mut written = None;
        for step in 0..6 {
        let cancellation = CancellationToken::new();
        let prepared = model.prepare_request(ModelRequest {
            request_id: format!("live-write-{index}-{step}"), surface_generation: 0,
            system_prompt: assembly.system_prompt.clone(), messages: messages.clone(), tools: assembly.tools.clone(), tool_choice: Default::default(),
        }, "live-write-verification", &cancellation).unwrap();
        let response = tokio::time::timeout(std::time::Duration::from_secs(180),
            prepared.stream(format!("live-write-{index}-{step}"), cancellation.clone(), Arc::new(LiveSink)),
        ).await.unwrap_or_else(|_| { cancellation.cancel(); panic!("live model timed out"); }).unwrap();
        fs::write(output.join(format!("response-{index}-{step}.json")), serde_json::to_vec_pretty(&response.content).unwrap()).unwrap();
        let calls: Vec<_> = response.content.iter().filter_map(|block| match block {
            ModelContentBlock::ToolCall { call } => Some(call), _ => None,
        }).collect();
        assert!(!calls.is_empty(), "model stopped before writing; see response-{index}-{step}.json");
        messages.push(ModelMessage::Assistant {
            content: response.content.clone(),
            replay: response.replay_envelope.clone().map(Box::new),
            native_replay: None,
        });
        for proposed in calls {
        assert!(matches!(proposed.name.as_str(), "write_file" | "read_file" | "list_directory"), "unexpected tool: {}", proposed.name);
        if proposed.name != "list_directory" {
        assert_eq!(proposed.arguments["path"], path);
        }
        let mut arguments = proposed.arguments.clone();
        assert!(!crate::agent_runtime::scratch::take_scope(&proposed.name, &mut arguments).unwrap());
        crate::agent_runtime::validate_tool_arguments_native(&proposed.name, &arguments).unwrap();
        let call = AgentToolCallNative {
            request_id: format!("live-write-{index}"), call_id: proposed.call_id.clone(),
            tool_name: proposed.name.clone(), arguments,
            target: target.clone(), capability_id: "live-write".into(),
        };
        let execution = execute_file_tool_native(FileExecutionContextNative {
            task_id: "live-write", call: &call, database: &database, credentials: &credentials,
            known_hosts_path: &known_hosts, checkpoint_root: state.path(),
            checkpoints: &checkpoints, operations: &operations,
        });
        let result = match execution {
            Ok(result) => result,
            Err(error) if proposed.name != "write_file" => {
                messages.push(ModelMessage::Tool {
                    call_id: proposed.call_id.clone(), provider_call_id: proposed.provider_call_id.clone(),
                    name: proposed.name.clone(), content: serde_json::to_string(&json!({"error": error})).unwrap(),
                });
                continue;
            }
            Err(error) => panic!("native write failed: {error}"),
        };
        messages.push(ModelMessage::Tool {
            call_id: proposed.call_id.clone(), provider_call_id: proposed.provider_call_id.clone(),
            name: proposed.name.clone(), content: serde_json::to_string(&result.data).unwrap(),
        });
        if proposed.name == "write_file" {
            assert!(written.is_none(), "only one write per case is expected");
            written = Some((call, result));
        }
        }
        if written.is_some() { break; }
        }
        let (call, result) = written.expect("model must write within six steps");
        let actual = fs::read(workspace.path().join(path)).unwrap();
        assert_eq!(actual, call.arguments["content"].as_str().unwrap().as_bytes());
        assert_eq!(result.data["verified"], true);
        if index == 0 { assert!(String::from_utf8_lossy(&actual).contains("MiniMax 实际写入验证")); }
        if index == 2 { assert!(actual.is_empty()); }
        if replacing { assert!(String::from_utf8_lossy(&actual).contains("MiniMax 摘要校验替换成功")); }
        fs::write(output.join(format!("written-{index}-{path}")), &actual).unwrap();
        results.push(json!({"case": index, "path": path, "model": model.provider.model,
            "arguments": call.arguments, "result": result.data, "bytes": actual.len(),
            "sha256": sha256_hex(&actual), "passed": true}));
        fs::write(output.join("results.json"), serde_json::to_vec_pretty(&results).unwrap()).unwrap();
    }
}

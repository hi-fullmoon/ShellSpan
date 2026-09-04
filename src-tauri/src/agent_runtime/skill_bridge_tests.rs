// Test-only transport replacing the desktop IPC channel, keeping the real Runtime,
// Session Store, local Skills provider, model adapter, and HTTP wire in process.
use super::*;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

async fn read_http(socket: &mut tokio::net::TcpStream) -> serde_json::Value {
    let mut bytes = Vec::new();
    let mut block = [0; 8192];
    let (end, length) = loop {
        let n = socket.read(&mut block).await.unwrap();
        assert!(n > 0);
        bytes.extend_from_slice(&block[..n]);
        assert!(bytes.len() < 1024 * 1024);
        if let Some(end) = bytes
            .windows(4)
            .position(|b| b == b"\r\n\r\n")
            .map(|i| i + 4)
        {
            let headers = String::from_utf8_lossy(&bytes[..end]).to_ascii_lowercase();
            let length = headers
                .lines()
                .find_map(|line| line.strip_prefix("content-length: "))
                .unwrap()
                .parse::<usize>()
                .unwrap();
            break (end, length);
        }
    };
    while bytes.len() < end + length {
        let n = socket.read(&mut block).await.unwrap();
        assert!(n > 0);
        bytes.extend_from_slice(&block[..n]);
    }
    serde_json::from_slice(&bytes[end..end + length]).unwrap()
}
async fn reply_http(socket: &mut tokio::net::TcpStream, content_type: &str, body: String) {
    socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).as_bytes()).await.unwrap();
}
#[tokio::test]
#[ignore = "requires Stage 6B controller bridge runner"]
async fn skill_controller_bridge() {
    let ready = std::env::var("SHELLSPAN_SKILLS_BRIDGE_READY")
        .expect("use scripts/ai-runtime-stage6b-controller.mjs");
    let root = tempfile::tempdir().unwrap();
    let project = std::fs::canonicalize(root.path()).unwrap();
    let storage = tempfile::tempdir().unwrap();
    super::skill_tests::write_skill(
        &project,
        "inspect",
        "disable-model-invocation: true\n",
        "ENTIRE CONTROLLER INSTRUCTION\nFinal line from the real file.\n",
    );
    let runtime = AgentRuntimeBuilder::new().build();
    runtime.configure(storage.path().to_path_buf()).unwrap();
    let receiver = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let model_url = format!("http://{}", receiver.local_addr().unwrap());
    let requests = Arc::new(Mutex::new(Vec::new()));
    let received = requests.clone();
    let server = tokio::spawn(async move {
        loop {
            let (mut socket, _) = receiver.accept().await.unwrap();
            let body = read_http(&mut socket).await;
            received.lock().unwrap().push(body);
            reply_http(&mut socket,"text/event-stream",format!("data: {}\n\ndata: [DONE]\n\n",json!({"choices":[{"delta":{"content":"Controller wire complete"},"finish_reason":"stop"}]}))).await;
        }
    });
    let rpc = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    std::fs::write(ready,serde_json::to_vec(&json!({"url":format!("http://{}",rpc.local_addr().unwrap()),"root":project,"modelUrl":model_url})).unwrap()).unwrap();
    let mut ids = Vec::<String>::new();
    let mut stopped = false;
    while !stopped {
        let (mut socket, _) =
            tokio::time::timeout(std::time::Duration::from_secs(90), rpc.accept())
                .await
                .expect("bridge client timed out")
                .unwrap();
        let request = read_http(&mut socket).await;
        let args = &request["args"];
        let input = &args["input"];
        let session = input["sessionId"].as_str().unwrap_or("");
        let value = match request["command"].as_str().unwrap() {
            "agent_runtime_create_session" => {
                let create: CreateAgentSessionRequest =
                    serde_json::from_value(args["request"].clone()).unwrap();
                assert_eq!(
                    create.target.as_ref().unwrap().cwd.as_deref(),
                    project.to_str()
                );
                ids.push(create.session_id.clone());
                serde_json::to_value(runtime.create_session(create).unwrap()).unwrap()
            }
            "agent_runtime_get_session" => {
                serde_json::to_value(runtime.session(session).unwrap()).unwrap()
            }
            "agent_runtime_get_committed_events" => serde_json::to_value(
                runtime
                    .committed_events(serde_json::from_value(args["request"].clone()).unwrap())
                    .unwrap(),
            )
            .unwrap(),
            "agent_runtime_list_sessions" => serde_json::to_value(
                runtime
                    .sessions(serde_json::from_value(args["request"].clone()).unwrap())
                    .unwrap(),
            )
            .unwrap(),
            "agent_runtime_list_skills" => {
                serde_json::to_value(runtime.list_skills(session).await.unwrap()).unwrap()
            }
            "agent_runtime_start" => {
                let config: AiProviderConfig =
                    serde_json::from_value(input["provider"].clone()).unwrap();
                assert_eq!(config.base_url, model_url);
                serde_json::to_value(runtime.start(session, config, None).unwrap()).unwrap()
            }
            "agent_runtime_followup" => {
                runtime
                    .followup_submission(
                        session,
                        input["messageId"].as_str().unwrap().into(),
                        input["clientSubmissionId"].as_str().unwrap().into(),
                        input["content"].as_str().unwrap().into(),
                    )
                    .unwrap();
                runtime.await_idle(session).await.unwrap();
                serde_json::to_value(runtime.session(session).unwrap()).unwrap()
            }
            "__state" => {
                json!({"requests":requests.lock().unwrap().clone(),"sessions":ids.iter().map(|id|json!({"snapshot":runtime.session(id).unwrap(),"events":all_events(&runtime,id)})).collect::<Vec<_>>()})
            }
            "__stop" => {
                stopped = true;
                json!(null)
            }
            command => panic!("unexpected bridge operation {command}"),
        };
        let events: Vec<_> = ids.iter().flat_map(|id| all_events(&runtime, id)).collect();
        reply_http(
            &mut socket,
            "application/json",
            json!({"value":value,"events":events}).to_string(),
        )
        .await;
    }
    assert_eq!(
        requests.lock().unwrap().len(),
        2,
        "both menu and manual slash must reach the real HTTP provider"
    );
    assert_eq!(ids.len(), 2);
    for id in ids {
        let events = all_events(&runtime, &id);
        assert_eq!(events.iter().filter(|event|matches!(&event.payload,AgentSessionEventPayload::SkillStepPrepared{prepared}if prepared.outcomes.iter().any(|o|o.loaded.is_some()))).count(),1);
    }
    server.abort();
    let _ = server.await;
}

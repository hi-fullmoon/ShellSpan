use super::*;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

async fn read_request(socket: &mut tokio::net::TcpStream) -> serde_json::Value {
    let mut bytes = Vec::new();
    let mut block = [0; 8192];
    let (end, len) = loop {
        let n = socket.read(&mut block).await.unwrap();
        assert!(n > 0);
        bytes.extend_from_slice(&block[..n]);
        assert!(bytes.len() < 32 * 1024 * 1024);
        if let Some(end) = bytes
            .windows(4)
            .position(|b| b == b"\r\n\r\n")
            .map(|i| i + 4)
        {
            let h = String::from_utf8_lossy(&bytes[..end]).to_ascii_lowercase();
            let len = h
                .lines()
                .find_map(|l| l.strip_prefix("content-length: "))
                .unwrap_or("0")
                .parse::<usize>()
                .unwrap();
            break (end, len);
        }
    };
    while bytes.len() < end + len {
        let n = socket.read(&mut block).await.unwrap();
        assert!(n > 0);
        bytes.extend_from_slice(&block[..n]);
    }
    serde_json::from_slice(&bytes[end..end + len]).unwrap()
}
async fn respond(socket: &mut tokio::net::TcpStream, mime: &str, body: String) {
    if let Err(error) = socket.write_all(format!("HTTP/1.1 200 OK\r\nAccess-Control-Allow-Origin: *\r\nContent-Type: {mime}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).as_bytes()).await {
        // Autocomplete cancels obsolete requests before their response arrives.
        assert!(matches!(error.kind(), std::io::ErrorKind::BrokenPipe | std::io::ErrorKind::ConnectionReset));
    }
}

#[tokio::test]
#[ignore = "requires Stage 6C real browser/controller runner"]
async fn image_browser_controller_http_bridge() {
    browser_bridge(false).await;
}
#[tokio::test]
#[ignore = "requires Stage 6D real browser/controller runner"]
async fn file_reference_browser_controller_http_bridge() {
    browser_bridge(true).await;
}
async fn browser_bridge(files: bool) {
    let ready = std::env::var(if files {
        "SHELLSPAN_FILES_BRIDGE_READY"
    } else {
        "SHELLSPAN_IMAGES_BRIDGE_READY"
    })
    .expect("stage runner");
    let root = tempfile::tempdir().unwrap();
    let project = std::fs::canonicalize(root.path()).unwrap();
    let storage = tempfile::tempdir().unwrap();
    if files {
        std::fs::create_dir(project.join("space dir")).unwrap();
        std::fs::create_dir(project.join("empty")).unwrap();
        std::fs::write(
            project.join("space dir/file name.txt"),
            "FILE_CONTENT_MUST_NEVER_BE_READ_6D",
        )
        .unwrap();
        std::fs::write(
            project.join("plain.txt"),
            "FILE_CONTENT_MUST_NEVER_BE_READ_6D",
        )
        .unwrap();
        for i in 0..60 {
            std::fs::write(project.join(format!("match{i:02}.txt")), "not read").unwrap();
        }
    }
    skill_tests::write_skill(
        &project,
        "inspect",
        "disable-model-invocation: true\n",
        "IMAGE AND SKILL FULL INSTRUCTIONS\nFinal line.\n",
    );
    let mut runtime = AgentRuntime::default();
    runtime.configure(storage.path().to_path_buf()).unwrap();
    let receiver = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let model_url = format!("http://{}", receiver.local_addr().unwrap());
    let requests = Arc::new(Mutex::new(Vec::<serde_json::Value>::new()));
    let received = requests.clone();
    let server = tokio::spawn(async move {
        loop {
            let (mut socket, _) = receiver.accept().await.unwrap();
            let body = read_request(&mut socket).await;
            received.lock().unwrap().push(body);
            respond(&mut socket,"text/event-stream",format!("data: {}\n\ndata: [DONE]\n\n",json!({"choices":[{"delta":{"content":"Image wire complete"},"finish_reason":"stop"}]}))).await;
        }
    });
    let rpc = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    std::fs::write(ready,serde_json::to_vec(&json!({"url":format!("http://{}",rpc.local_addr().unwrap()),"root":project,"modelUrl":model_url,"image":image_tests::upload(image::ImageFormat::Png)})).unwrap()).unwrap();
    let mut stopped = false;
    let mut ids = Vec::<String>::new();
    let mut fail_submit = false;
    let mut path_queries = Vec::<serde_json::Value>::new();
    while !stopped {
        let (mut socket, _) =
            tokio::time::timeout(std::time::Duration::from_secs(120), rpc.accept())
                .await
                .unwrap()
                .unwrap();
        let request = read_request(&mut socket).await;
        let args = &request["args"];
        let input = &args["input"];
        let session = input["sessionId"].as_str().unwrap_or("");
        let result:Result<serde_json::Value,String>=async {Ok(match request["command"].as_str().unwrap(){
            "agent_runtime_prepare_images"=>serde_json::to_value(runtime.prepare_images(serde_json::from_value(args["images"].clone()).unwrap()).await?).unwrap(),
            "agent_runtime_submit_images"=>{if fail_submit {fail_submit=false;return Err("IMAGE_TEST_WRITE_FAILURE".into());}runtime.submit_images(serde_json::from_value(input.clone()).unwrap()).await?;runtime.await_idle(session).await?;serde_json::to_value(runtime.session(session)?).unwrap()},
            "agent_runtime_cancel_image_submission"=>json!(runtime.cancel_image_submission(serde_json::from_value(input.clone()).unwrap())?),
            "agent_runtime_image_preview"=>json!(runtime.image_preview(serde_json::from_value(input.clone()).unwrap())?),
            "agent_runtime_create_session"=>{let create:CreateAgentSessionRequest=serde_json::from_value(args["request"].clone()).unwrap();assert!(create.target.as_ref().unwrap().cwd.as_deref().is_none_or(|cwd| Some(cwd) == project.to_str()));ids.push(create.session_id.clone());serde_json::to_value(runtime.create_session(create)?).unwrap()},
            "agent_runtime_get_session"=>serde_json::to_value(runtime.session(session)?).unwrap(),
            "agent_runtime_get_committed_events"=>serde_json::to_value(runtime.committed_events(serde_json::from_value(args["request"].clone()).unwrap())?).unwrap(),
            "agent_runtime_list_sessions"=>serde_json::to_value(runtime.sessions(serde_json::from_value(args["request"].clone()).unwrap())?).unwrap(),
            "agent_runtime_list_file_references"=>{path_queries.push(input.clone());serde_json::to_value(runtime.file_references.list(serde_json::from_value(input.clone()).unwrap()).await?).unwrap()},
            "agent_runtime_cancel_file_references"=>{runtime.file_references.cancel(serde_json::from_value(input.clone()).unwrap())?;json!(null)},
            "agent_runtime_list_skills"=>serde_json::to_value(runtime.list_skills(session).await?).unwrap(),
            "agent_runtime_start"=>{let provider:AiProviderConfig=serde_json::from_value(input["provider"].clone()).unwrap();assert_eq!(provider.base_url,model_url);serde_json::to_value(runtime.start(session,provider,None)?).unwrap()},
            "agent_runtime_followup"=>{runtime.followup_submission(session,input["messageId"].as_str().unwrap().into(),input["clientSubmissionId"].as_str().unwrap().into(),input["content"].as_str().unwrap().into())?;runtime.await_idle(session).await?;serde_json::to_value(runtime.session(session)?).unwrap()},
            "__restart"=>{for id in &ids {runtime.await_idle(id).await?;}runtime=AgentRuntime::default();runtime.configure(storage.path().to_path_buf())?;json!(null)},
            "__fail_submit"=>{fail_submit=true;json!(null)},
            "__state"=>json!({"pathQueries":path_queries,"requests":requests.lock().unwrap().clone(),"sessions":ids.iter().map(|id|json!({"snapshot":runtime.session(id).unwrap(),"events":all_events(&runtime,id)})).collect::<Vec<_>>()}),
            "__stop"=>{stopped=true;json!(null)},
            command=>return Err(format!("unknown command {command}")),
        })}.await;
        respond(
            &mut socket,
            "application/json",
            match result {
                Ok(value) => json!({"value":value,"events":if files {ids.iter().flat_map(|id|all_events(&runtime,id)).collect::<Vec<_>>()} else {vec![]}}),
                Err(error) => json!({"error":error}),
            }
            .to_string(),
        )
        .await;
    }
    let captured = requests.lock().unwrap();
    assert!(captured.len() >= 2);
    if files {
        assert!(!path_queries.is_empty());
        assert!(!serde_json::to_string(&*captured)
            .unwrap()
            .contains("FILE_CONTENT_MUST_NEVER_BE_READ_6D"));
        for id in &ids {
            assert!(!all_events(&runtime, id)
                .iter()
                .any(|e| matches!(e.payload, AgentSessionEventPayload::ToolCall { .. })));
        }
    }
    for request in captured.iter() {
        for message in request["messages"].as_array().unwrap() {
            if let Some(content) = message["content"].as_array() {
                for block in content {
                    if block["type"] == "image_url" {
                        let data = block["image_url"]["url"]
                            .as_str()
                            .unwrap()
                            .strip_prefix("data:image/png;base64,")
                            .unwrap();
                        let bytes = base64::engine::general_purpose::STANDARD
                            .decode(data)
                            .unwrap();
                        image::load_from_memory(&bytes).unwrap();
                        let hash = crate::agent_runtime::images::digest(&bytes);
                        assert_eq!(
                            bytes,
                            std::fs::read(
                                storage.path().join("agent-runtime/images-v1").join(hash)
                            )
                            .unwrap()
                        );
                    }
                }
            }
        }
    }
    assert!(captured
        .iter()
        .any(|r| r.to_string().contains("# System status")));
    server.abort();
}

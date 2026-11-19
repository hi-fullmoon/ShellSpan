use super::*;
use crate::agent_runtime::images::{
    ImagePreviewRequest, ImageSubmission, ImageUpload, InboxImageEdit,
};
use crate::agent_runtime::{AgentInboxMutation, AgentInboxMutationInput};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

fn queue_image(name: &str, bytes: &[u8]) -> ImageUpload {
    ImageUpload {
        name: name.into(),
        media_type: "image/png".into(),
        data: base64::engine::general_purpose::STANDARD.encode(bytes),
    }
}

async fn queue_image_edit_session(
    runtime: &AgentRuntime,
    session_id: &str,
    root: &std::path::Path,
) {
    skill_tests::create_skill_session(runtime, session_id, root);
    runtime
        .start(session_id, image_tests::vision_provider(), None)
        .unwrap();
    for (id, images) in [
        (
            "first",
            vec![
                queue_image("32x32.png", include_bytes!("../../../../icons/32x32.png")),
                queue_image("64x64.png", include_bytes!("../../../../icons/64x64.png")),
            ],
        ),
        (
            "second",
            vec![queue_image(
                "128x128.png",
                include_bytes!("../../../../icons/128x128.png"),
            )],
        ),
    ] {
        runtime
            .submit_images_with_admission(
                ImageSubmission {
                    session_id: session_id.into(),
                    client_operation_id: id.into(),
                    content: if id == "first" {
                        ""
                    } else {
                        "Another queued message"
                    }
                    .into(),
                    lane: AgentInboxLane::NextTurn,
                    images,
                    terminal_context: None,
                },
                true,
                None,
            )
            .await
            .unwrap();
    }
}

#[tokio::test]
async fn image_request_byte_limit_rejects_submissions_and_edits_before_inbox_commit() {
    let storage = tempfile::tempdir().unwrap();
    let runtime = AgentRuntime::default();
    runtime.configure(storage.path().to_path_buf()).unwrap();
    let session_id = "image-byte-budget";
    skill_tests::create_skill_session(&runtime, session_id, storage.path());
    let image = queue_image("64x64.png", include_bytes!("../../../../icons/64x64.png"));
    let refs = runtime
        .models
        .images
        .import(
            std::slice::from_ref(&image),
            &tokio_util::sync::CancellationToken::new(),
        )
        .unwrap();
    let mut provider = image_tests::vision_provider();
    let mut definition = crate::llm::catalog::preset_models(&provider.profile, provider.kind)
        .unwrap()
        .remove(&provider.model)
        .unwrap();
    definition.vision.as_mut().unwrap().max_request_image_bytes = 2 * refs[0].bytes;
    provider.model_definition = Some(definition);
    runtime.start(session_id, provider, None).unwrap();
    runtime.await_idle(session_id).await.unwrap();

    let submission = |id: &str| ImageSubmission {
        session_id: session_id.into(),
        client_operation_id: id.into(),
        content: "Check image".into(),
        lane: AgentInboxLane::NextTurn,
        images: vec![image.clone()],
        terminal_context: None,
    };
    runtime
        .submit_images_with_admission(submission("first"), true, None)
        .await
        .unwrap();
    let before = runtime
        .submit_images_with_admission(submission("second"), true, None)
        .await
        .unwrap();
    assert!(runtime
        .submit_images_with_admission(submission("third"), true, None)
        .await
        .unwrap_err()
        .starts_with("IMAGE_REQUEST_BUDGET"));

    let edit = |id: &str, kept| AgentInboxMutationInput {
        session_id: session_id.into(),
        expected_revision: before.event_count,
        client_operation_id: id.into(),
        mutation: AgentInboxMutation::UpdateWithImages {
            item_id: "first".into(),
            content: "Check the updated image".into(),
            images: InboxImageEdit {
                kept,
                added: vec![image.clone()],
            },
        },
    };
    assert!(runtime
        .mutate_inbox(edit("add-image", refs.clone()))
        .unwrap_err()
        .starts_with("IMAGE_REQUEST_BUDGET"));
    assert_eq!(runtime.session(session_id).unwrap(), before);

    let replaced = runtime.mutate_inbox(edit("replace-image", vec![])).unwrap();
    assert_eq!(replaced.inbox.next_turn[0].images, refs);
    assert_eq!(
        replaced.inbox.next_turn[0].content,
        "Check the updated image"
    );
    assert_eq!(replaced.inbox.next_turn[1], before.inbox.next_turn[1]);
}

#[tokio::test]
async fn inbox_image_edit_preserves_order_and_only_commits_valid_attachments() {
    let storage = tempfile::tempdir().unwrap();
    let runtime = AgentRuntime::default();
    runtime.configure(storage.path().to_path_buf()).unwrap();
    let id = "queue-images";
    queue_image_edit_session(&runtime, id, storage.path()).await;
    let initial = runtime.session(id).unwrap();
    let first = &initial.inbox.next_turn[0];
    let second = &initial.inbox.next_turn[1];
    let update = |operation: &str, content: &str, images: InboxImageEdit| AgentInboxMutationInput {
        session_id: id.into(),
        expected_revision: initial.event_count,
        client_operation_id: operation.into(),
        mutation: AgentInboxMutation::UpdateWithImages {
            item_id: first.message_id.clone(),
            content: content.into(),
            images,
        },
    };
    assert!(runtime
        .mutate_inbox(update(
            "foreign",
            "",
            InboxImageEdit {
                kept: second.images.clone(),
                added: vec![],
            }
        ))
        .unwrap_err()
        .contains("IMAGE_REFERENCE_NOT_IN_SESSION"));
    assert!(runtime
        .mutate_inbox(update(
            "empty",
            "",
            InboxImageEdit {
                kept: vec![],
                added: vec![],
            }
        ))
        .is_err());
    assert_eq!(
        runtime.session(id).unwrap().event_count,
        initial.event_count
    );

    let new_image = queue_image("256x256.png", include_bytes!("../../../../icons/icon.png"));
    let edit = update(
        "edit-with-images",
        "",
        InboxImageEdit {
            kept: vec![first.images[1].clone()],
            added: vec![new_image.clone()],
        },
    );
    let saved = runtime.mutate_inbox(edit.clone()).unwrap();
    let updated = &saved.inbox.next_turn[0];
    assert_eq!(updated.message_id, first.message_id);
    assert_eq!(updated.client_submission_id, first.client_submission_id);
    assert_eq!(updated.source, first.source);
    assert_eq!(updated.images[0], first.images[1]);
    assert_eq!(updated.images[1].name, new_image.name);
    assert_eq!(saved.inbox.next_turn[1], *second);
    assert_eq!(saved.inbox.paused_ids, initial.inbox.paused_ids);
    let preview = ImagePreviewRequest {
        session_id: id.into(),
        sha256: updated.images[1].sha256.clone(),
    };
    assert!(runtime
        .image_preview(preview)
        .unwrap()
        .starts_with("data:image/png;base64,"));
    assert_eq!(
        runtime.mutate_inbox(edit.clone()).unwrap().event_count,
        saved.event_count
    );
    assert!(runtime
        .mutate_inbox(update(
            "edit-with-images",
            "",
            InboxImageEdit {
                kept: vec![first.images[0].clone()],
                added: vec![new_image],
            }
        ))
        .unwrap_err()
        .contains("different payload"));

    let text_only = runtime
        .mutate_inbox(AgentInboxMutationInput {
            expected_revision: saved.event_count,
            ..update(
                "remove-all-images",
                "Text only",
                InboxImageEdit {
                    kept: vec![],
                    added: vec![],
                },
            )
        })
        .unwrap();
    assert!(text_only.inbox.next_turn[0].images.is_empty());
    assert_eq!(text_only.inbox.next_turn[0].content, "Text only");
    drop(runtime);
    let restored = AgentRuntime::default();
    restored.configure(storage.path().to_path_buf()).unwrap();
    assert_eq!(
        restored.session(id).unwrap().inbox.next_turn,
        text_only.inbox.next_turn
    );
    assert_eq!(
        restored.mutate_inbox(edit).unwrap().event_count,
        text_only.event_count
    );
}

#[tokio::test]
#[ignore = "run via queue-edit-recovery.browser.mjs"]
async fn queue_image_edit_browser_bridge() {
    let ready = std::env::var_os("SHELLSPAN_QUEUE_EDIT_BRIDGE").expect("browser runner");
    let storage = tempfile::tempdir().unwrap();
    let runtime = AgentRuntime::default();
    runtime.configure(storage.path().to_path_buf()).unwrap();
    let drafts = crate::frontend_storage::FrontendStorage::open(storage.path()).unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    std::fs::write(ready, format!("http://{}", listener.local_addr().unwrap())).unwrap();
    loop {
        let (mut socket, _) =
            tokio::time::timeout(std::time::Duration::from_secs(180), listener.accept())
                .await
                .unwrap()
                .unwrap();
        let request = read_request(&mut socket).await;
        let input = &request["args"]["input"];
        let session = input["sessionId"].as_str().unwrap_or_default();
        let command = request["command"].as_str().unwrap();
        let result: Result<serde_json::Value, String> = async {
            Ok(match command {
                "open_fixture" => {
                    queue_image_edit_session(&runtime, session, storage.path()).await;
                    json!(null)
                }
                "agent_runtime_prepare_images" => json!(runtime.prepare_images(
                    serde_json::from_value(request["args"]["images"].clone()).unwrap(),
                ).await?),
                "agent_runtime_image_preview" => json!(runtime.image_preview(serde_json::from_value(input.clone()).unwrap())?),
                "agent_runtime_mutate_inbox" => json!(runtime.mutate_inbox(serde_json::from_value(input.clone()).unwrap())?),
                "read_image_drafts" => json!(drafts.read(serde_json::from_value(input.clone()).unwrap())?),
                "commit_image_drafts" => json!(drafts.commit(serde_json::from_value(input.clone()).unwrap())?),
                "read_fixture" => json!({ "snapshot": runtime.session(session)?, "events": all_events(&runtime, session) }),
                "finish" => json!(null),
                _ => return Err(format!("unexpected command: {command}")),
            })
        }.await;
        respond(
            &mut socket,
            "application/json",
            match result {
                Ok(value) => json!({ "value": value }),
                Err(error) => json!({ "error": error }),
            }
            .to_string(),
        )
        .await;
        if command == "finish" {
            break;
        }
    }
}

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
async fn image_kimi_k3_submission_reaches_chat_transport_with_pixels() {
    for (model, caption) in ["k3", "k3-256k"].into_iter().flat_map(|model| {
        ["Describe this image", "", " \n\t "]
            .into_iter()
            .map(move |caption| (model, caption))
    }) {
        let storage = tempfile::tempdir().unwrap();
        let runtime = AgentRuntime::default();
        runtime.configure(storage.path().to_path_buf()).unwrap();
        skill_tests::create_skill_session(&runtime, "images", storage.path());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let mut provider = image_tests::vision_provider();
        provider.profile = "kimi".into();
        provider.model = model.into();
        provider.base_url = format!("http://{}", listener.local_addr().unwrap());
        provider.reasoning_effort = Some("high".to_string());
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let body = read_request(&mut socket).await;
            respond(&mut socket, "text/event-stream", concat!(
                "data: {\"choices\":[{\"delta\":{\"content\":\"Image received\"},\"finish_reason\":\"stop\"}]}\n\n",
                "data: [DONE]\n\n"
            ).into()).await;
            body
        });
        runtime.start("images", provider, None).unwrap();
        runtime
            .submit_images(crate::agent_runtime::images::ImageSubmission {
                session_id: "images".into(),
                client_operation_id: "kimi-image".into(),
                content: caption.into(),
                lane: AgentInboxLane::NextTurn,
                images: vec![image_tests::upload(image::ImageFormat::Png)],
                terminal_context: None,
            })
            .await
            .unwrap();
        tokio::time::timeout(
            std::time::Duration::from_secs(10),
            runtime.await_idle("images"),
        )
        .await
        .unwrap()
        .unwrap();
        let body = tokio::time::timeout(std::time::Duration::from_secs(10), server)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(body["model"], model);
        assert_eq!(body["reasoning_effort"], "high");
        let content = body["messages"]
            .as_array()
            .unwrap()
            .iter()
            .find(|message| message["role"] == "user" && message["content"].is_array())
            .unwrap()["content"]
            .as_array()
            .unwrap();
        let text_blocks: Vec<_> = content
            .iter()
            .filter(|block| block["type"] == "text")
            .collect();
        if caption.trim().is_empty() {
            assert!(
                text_blocks.is_empty(),
                "image-only requests must omit blank text blocks"
            );
        } else {
            assert_eq!(text_blocks.len(), 1);
            assert_eq!(text_blocks[0]["text"], caption);
        }
        let images: Vec<_> = content
            .iter()
            .filter(|block| block["type"] == "image_url")
            .collect();
        assert_eq!(images.len(), 1);
        let bytes = base64::Engine::decode(
            &base64::engine::general_purpose::STANDARD,
            images[0]["image_url"]["url"]
                .as_str()
                .unwrap()
                .strip_prefix("data:image/png;base64,")
                .unwrap(),
        )
        .unwrap();
        let decoded = image::load_from_memory(&bytes).unwrap();
        assert_eq!((decoded.width(), decoded.height()), (12, 8));
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
            "agent_runtime_followup"=>{runtime.followup_submission(session,input["messageId"].as_str().unwrap().into(),input["clientSubmissionId"].as_str().unwrap().into(),input["content"].as_str().unwrap().into(),None)?;runtime.await_idle(session).await?;serde_json::to_value(runtime.session(session)?).unwrap()},
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
                            std::fs::read(storage.path().join("agent-runtime/images").join(hash))
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

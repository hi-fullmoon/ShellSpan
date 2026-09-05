use super::*;
use crate::agent_runtime::images::*;
use crate::agent_runtime::AgentSurfaceMessage;
use image::{DynamicImage, ImageFormat};
use std::io::Cursor;
use tokio_util::sync::CancellationToken;

#[tokio::test]
async fn image_compaction_keeps_pixels_and_recovery_resolves_them_again() {
    let (storage, runtime, _) = setup();
    runtime.start("images", vision_provider(), None).unwrap();
    runtime.submit_images(input("one")).await.unwrap();
    runtime.await_idle("images").await.unwrap();
    let snapshot = runtime.session("images").unwrap();
    let request = ModelRequest::from_surface(
        "budget".into(),
        &snapshot.surface,
        String::new(),
        Vec::new(),
    );
    let budget =
        crate::agent_runtime::estimate_model_surface_budget(&vision_provider(), &request).unwrap();
    assert_eq!(budget.context_window, 128000);
    crate::agent_runtime::AgentCompactionManager::new(
        runtime.sessions.clone(),
        runtime.artifacts.clone(),
    )
    .compact(
        "images",
        "compact-turn",
        "compact-step",
        None,
        "test",
        &budget,
        true,
        &CancellationToken::new(),
    )
    .await
    .unwrap();
    let compacted = runtime.session("images").unwrap();
    assert_eq!(compacted.surface.generation, 1);
    assert_eq!(
        compacted
            .surface
            .messages
            .iter()
            .filter(|m| matches!(m, AgentSurfaceMessage::UserImages { .. }))
            .count(),
        1
    );
    drop(runtime);
    let restored = AgentRuntime::default();
    restored.configure(storage.path().to_path_buf()).unwrap();
    let mut request = ModelRequest::from_surface(
        "restored".into(),
        &restored.session("images").unwrap().surface,
        String::new(),
        Vec::new(),
    );
    restored
        .models
        .images
        .resolve_request(&vision_provider(), &mut request, &CancellationToken::new())
        .unwrap();
    assert!(request
        .messages
        .iter()
        .any(|m| matches!(m, ModelMessage::UserImages { data_urls, .. } if data_urls.len() == 1)));
}

#[test]
fn image_import_concurrency_is_bounded_per_shared_store_not_across_runtimes() {
    let store = ImageStore::default();
    let one = store.import_permit().unwrap();
    let _two = store.clone().import_permit().unwrap();
    assert!(store.import_permit().is_err());
    assert!(ImageStore::default().import_permit().is_ok());
    drop(one);
    assert!(store.import_permit().is_ok());
}

#[tokio::test]
async fn image_second_blob_failure_keeps_first_blob_but_commits_no_partial_batch() {
    let (storage, runtime, model) = setup();
    runtime.start("images", vision_provider(), None).unwrap();
    runtime.await_idle("images").await.unwrap();
    let second = upload(ImageFormat::Jpeg);
    let scratch = tempfile::tempdir().unwrap();
    let store = ImageStore::default();
    store.configure(scratch.path()).unwrap();
    let refs = store
        .import(std::slice::from_ref(&second), &CancellationToken::new())
        .unwrap();
    std::fs::create_dir(
        storage
            .path()
            .join("agent-runtime/images-v1")
            .join(&refs[0].sha256),
    )
    .unwrap();
    let mut batch = input("partial-write");
    batch.images.push(second);
    assert!(runtime.submit_images(batch).await.is_err());
    assert!(
        std::fs::read_dir(storage.path().join("agent-runtime/images-v1"))
            .unwrap()
            .any(|entry| entry.unwrap().file_type().unwrap().is_file())
    );
    assert!(runtime
        .session("images")
        .unwrap()
        .inbox
        .next_turn
        .is_empty());
    assert!(!all_events(&runtime, "images")
        .iter()
        .any(|e| matches!(e.payload, AgentSessionEventPayload::InboxSpliced { .. })));
    assert_eq!(model.request_count(), 0);
}

#[tokio::test]
async fn image_missing_blob_stops_request_before_provider_transport() {
    let (storage, runtime, _) = setup();
    runtime.start("images", vision_provider(), None).unwrap();
    runtime.submit_images(input("one")).await.unwrap();
    runtime.await_idle("images").await.unwrap();
    drop(runtime);
    for entry in std::fs::read_dir(storage.path().join("agent-runtime/images-v1")).unwrap() {
        std::fs::remove_file(entry.unwrap().path()).unwrap();
    }
    let model = FakeAdapter::new(vec![reply("must not be called", &[])]);
    let restored = AgentRuntimeBuilder::new()
        .model_factory(Arc::new(FakeFactory(model.clone())))
        .build();
    restored.configure(storage.path().to_path_buf()).unwrap();
    restored
        .followup("images", "again".into(), "look again".into())
        .unwrap();
    restored.start("images", vision_provider(), None).unwrap();
    restored.await_idle("images").await.unwrap();
    assert_eq!(model.request_count(), 0);
    assert!(serde_json::to_string(&all_events(&restored, "images"))
        .unwrap()
        .contains("IMAGE_BLOB_MISSING"));
}

pub(super) fn upload(format: ImageFormat) -> ImageUpload {
    let image = DynamicImage::ImageRgba8(image::RgbaImage::from_fn(12, 8, |x, y| {
        image::Rgba([x as u8 * 16, y as u8 * 20, 45, 255])
    }));
    let image = if format == ImageFormat::Jpeg {
        DynamicImage::ImageRgb8(image.to_rgb8())
    } else {
        image
    };
    let mut bytes = Cursor::new(Vec::new());
    image.write_to(&mut bytes, format).unwrap();
    ImageUpload {
        media_type: format.to_mime_type().into(),
        data: base64::engine::general_purpose::STANDARD.encode(bytes.into_inner()),
        name: "图像 screenshot.png".into(),
    }
}
pub(super) fn vision_provider() -> AiProviderConfig {
    let mut value = provider();
    value.model_definition = None;
    value.kind = crate::ai::AiProviderKind::OpenAiCompatible;
    value.profile = Some("qwen".into());
    value.model = "qwen3-vl-plus".into();
    value.reasoning_effort = None;
    value
}
fn input(id: &str) -> ImageSubmission {
    ImageSubmission {
        session_id: "images".into(),
        client_operation_id: id.into(),
        content: "看图 /inspect".into(),
        lane: AgentInboxLane::NextTurn,
        images: vec![upload(ImageFormat::Png)],
    }
}
fn setup() -> (tempfile::TempDir, AgentRuntime, Arc<FakeAdapter>) {
    let model = FakeAdapter::new(vec![
        reply("image received", &[]),
        reply("image retained", &[]),
    ]);
    let (storage, runtime) = configured(model.clone());
    skill_tests::create_skill_session(&runtime, "images", storage.path());
    (storage, runtime, model)
}

#[test]
fn image_four_formats_normalize_decode_and_keep_content_addressed_bytes() {
    let dir = tempfile::tempdir().unwrap();
    let store = ImageStore::default();
    store.configure(dir.path()).unwrap();
    for format in [
        ImageFormat::Png,
        ImageFormat::Jpeg,
        ImageFormat::WebP,
        ImageFormat::Gif,
    ] {
        let refs = store
            .import(&[upload(format)], &CancellationToken::new())
            .unwrap();
        let reference = &refs[0];
        let bytes = store.read(reference).unwrap();
        assert_eq!(reference.sha256, digest(&bytes));
        assert_eq!(reference.media_type, "image/png");
        assert_eq!((reference.width, reference.height), (12, 8));
        assert_eq!(
            image::load_from_memory(&bytes).unwrap().color(),
            image::ColorType::Rgba8
        );
        assert_eq!(
            refs,
            store
                .import(&[upload(format)], &CancellationToken::new())
                .unwrap()
        );
    }
}

#[test]
fn image_format_base64_mime_name_and_reference_bounds_fail_closed() {
    let dir = tempfile::tempdir().unwrap();
    let store = ImageStore::default();
    store.configure(dir.path()).unwrap();
    let valid = upload(ImageFormat::Png);
    let mut cases = vec![];
    for mime in ["image/jpeg", "text/plain", "", "image/svg+xml"] {
        let mut u = valid.clone();
        u.media_type = mime.into();
        cases.push(u);
    }
    for data in ["aGVsbG8=", "aGVsbG8", "", "data:image/png;base64,aA=="] {
        let mut u = valid.clone();
        u.data = data.into();
        cases.push(u);
    }
    let mut u = valid.clone();
    u.data.push('\n');
    cases.push(u);
    let mut u = valid.clone();
    u.name = "界".repeat(86);
    cases.push(u);
    let mut u = valid.clone();
    u.name = "bad\nname".into();
    cases.push(u);
    let mut u = valid.clone();
    u.data = "A".repeat(VISION.max_source_bytes.div_ceil(3) * 4 + 4);
    cases.push(u);
    for u in cases {
        assert!(store.import(&[u], &CancellationToken::new()).is_err());
    }
    assert!(store
        .import(&vec![valid.clone(); 21], &CancellationToken::new())
        .is_err());
    let mut refs = store.import(&[valid], &CancellationToken::new()).unwrap();
    let reference = &mut refs[0];
    reference.sha256 = "../secret".into();
    assert!(store.read(reference).is_err());
}

#[test]
fn image_metadata_removed_orientation_applied_and_profile_refused() {
    let dir = tempfile::tempdir().unwrap();
    let store = ImageStore::default();
    store.configure(dir.path()).unwrap();
    let mut jpeg = upload(ImageFormat::Jpeg);
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(&jpeg.data)
        .unwrap();
    // Minimal little-endian TIFF, EXIF orientation 6 = rotate 90 degrees clockwise.
    let exif = b"Exif\0\0II\x2a\0\x08\0\0\0\x01\0\x12\x01\x03\0\x01\0\0\0\x06\0\0\0\0\0\0\0";
    let mut oriented = bytes[..2].to_vec();
    oriented.extend([0xff, 0xe1]);
    oriented.extend(((exif.len() + 2) as u16).to_be_bytes());
    oriented.extend(exif);
    oriented.extend(&bytes[2..]);
    jpeg.data = base64::engine::general_purpose::STANDARD.encode(oriented);
    let refs = store.import(&[jpeg], &CancellationToken::new()).unwrap();
    assert_eq!((refs[0].width, refs[0].height), (8, 12));
    let encoded = store.read(&refs[0]).unwrap();
    assert!(!encoded.windows(4).any(|v| v == b"Exif"));
    let mut profile = bytes[..2].to_vec();
    let icc = b"ICC_PROFILE\0\x01\x01not-a-colour-profile";
    profile.extend([0xff, 0xe2]);
    profile.extend(((icc.len() + 2) as u16).to_be_bytes());
    profile.extend(icc);
    profile.extend(&bytes[2..]);
    let mut u = upload(ImageFormat::Jpeg);
    u.data = base64::engine::general_purpose::STANDARD.encode(profile);
    assert!(store.import(&[u], &CancellationToken::new()).is_err());
}

#[test]
fn image_animation_and_pixel_bombs_rejected_and_sixteen_bit_is_rgba8() {
    let dir = tempfile::tempdir().unwrap();
    let store = ImageStore::default();
    store.configure(dir.path()).unwrap();
    let mut animated = Vec::new();
    {
        let mut encoder = image::codecs::gif::GifEncoder::new(&mut animated);
        for _ in 0..2 {
            encoder
                .encode_frame(image::Frame::new(image::RgbaImage::new(2, 2)))
                .unwrap();
        }
    }
    let mut gif = upload(ImageFormat::Gif);
    gif.data = base64::engine::general_purpose::STANDARD.encode(animated);
    assert!(store
        .import(&[gif], &CancellationToken::new())
        .unwrap_err()
        .contains("ANIMATION"));
    let mut bytes = Cursor::new(Vec::new());
    DynamicImage::ImageLuma16(image::ImageBuffer::from_pixel(
        3,
        2,
        image::Luma([32768u16]),
    ))
    .write_to(&mut bytes, ImageFormat::Png)
    .unwrap();
    let mut u = upload(ImageFormat::Png);
    u.data = base64::engine::general_purpose::STANDARD.encode(bytes.into_inner());
    let reference = store
        .import(&[u], &CancellationToken::new())
        .unwrap()
        .remove(0);
    assert_eq!(
        image::load_from_memory(&store.read(&reference).unwrap())
            .unwrap()
            .color(),
        image::ColorType::Rgba8
    );
    let oversized = DynamicImage::ImageLuma8(image::GrayImage::new(8193, 1));
    let mut bytes = Cursor::new(Vec::new());
    oversized.write_to(&mut bytes, ImageFormat::Png).unwrap();
    let mut u = upload(ImageFormat::Png);
    u.data = base64::engine::general_purpose::STANDARD.encode(bytes.into_inner());
    assert!(store.import(&[u], &CancellationToken::new()).is_err());
}

#[tokio::test]
async fn image_bad_batch_write_failure_and_every_cancel_boundary_never_enqueue() {
    for boundary in [
        "beforeNormalize",
        "normalized",
        "beforeWrite",
        "written",
        "beforeInbox",
    ] {
        let (_storage, runtime, model) = setup();
        runtime.start("images", vision_provider(), None).unwrap();
        runtime.await_idle("images").await.unwrap();
        let token = runtime
            .models
            .images
            .token(&ImageOperation {
                session_id: "images".into(),
                client_operation_id: "one".into(),
            })
            .unwrap();
        *runtime.models.images.observer.lock().unwrap() = Some(Arc::new(move |stage| {
            if stage == boundary {
                token.cancel();
            }
        }));
        assert!(runtime
            .submit_images(input("one"))
            .await
            .unwrap_err()
            .contains("CANCELLED"));
        assert!(runtime
            .session("images")
            .unwrap()
            .inbox
            .next_turn
            .is_empty());
        assert_eq!(model.request_count(), 0);
        assert!(!all_events(&runtime, "images")
            .iter()
            .any(|e| matches!(e.payload, AgentSessionEventPayload::UserMessage { .. })));
    }
    let (storage, runtime, model) = setup();
    runtime.start("images", vision_provider(), None).unwrap();
    runtime.await_idle("images").await.unwrap();
    let mut bad = input("bad");
    let mut invalid = upload(ImageFormat::Png);
    invalid.data = "invalid".into();
    bad.images.push(invalid);
    assert!(runtime.submit_images(bad).await.is_err());
    assert_eq!(model.request_count(), 0);
    let blob = runtime
        .prepare_images(vec![upload(ImageFormat::Png)])
        .await
        .unwrap()
        .remove(0);
    let hash = digest(
        &base64::engine::general_purpose::STANDARD
            .decode(blob.data)
            .unwrap(),
    );
    let path = storage.path().join("agent-runtime/images-v1").join(hash);
    std::fs::remove_file(&path).unwrap();
    std::fs::create_dir(&path).unwrap();
    assert!(runtime.submit_images(input("fail-write")).await.is_err());
    runtime
        .sessions
        .fail_appends_matching(|p| matches!(p, AgentSessionEventPayload::InboxSpliced { .. }));
    std::fs::remove_dir(path).unwrap();
    assert!(runtime.submit_images(input("fail-log")).await.is_err());
    assert_eq!(model.request_count(), 0);
}

#[tokio::test]
async fn image_commit_wins_cancel_idempotency_raw_conflict_and_cross_session_preview() {
    let (_storage, runtime, model) = setup();
    runtime.start("images", vision_provider(), None).unwrap();
    runtime.await_idle("images").await.unwrap();
    let operation = ImageOperation {
        session_id: "images".into(),
        client_operation_id: "one".into(),
    };
    let token = runtime.models.images.token(&operation).unwrap();
    *runtime.models.images.observer.lock().unwrap() = Some(Arc::new(move |stage| {
        if stage == "afterInbox" {
            token.cancel();
        }
    }));
    runtime.submit_images(input("one")).await.unwrap();
    runtime.await_idle("images").await.unwrap();
    assert!(runtime.cancel_image_submission(operation).unwrap());
    runtime.submit_images(input("one")).await.unwrap();
    assert_eq!(model.request_count(), 1);
    let mut different = input("one");
    different.images[0].name = "other.png".into();
    assert!(runtime
        .submit_images(different)
        .await
        .unwrap_err()
        .contains("CONFLICT"));
    let snapshot = runtime.session("images").unwrap();
    let reference = snapshot
        .surface
        .messages
        .iter()
        .find_map(|m| match m {
            AgentSurfaceMessage::UserImages { images, .. } => images.first(),
            _ => None,
        })
        .unwrap();
    assert!(runtime
        .image_preview(ImagePreviewRequest {
            session_id: "images".into(),
            sha256: reference.sha256.clone()
        })
        .unwrap()
        .starts_with("data:image/png;base64,"));
    skill_tests::create_skill_session(&runtime, "other", _storage.path());
    assert!(runtime
        .image_preview(ImagePreviewRequest {
            session_id: "other".into(),
            sha256: reference.sha256.clone()
        })
        .is_err());
    let json = serde_json::to_string(&all_events(&runtime, "images")).unwrap();
    assert!(!json.contains("data:image/png;base64,"));
    assert!(!json.contains(&input("one").images[0].data));
}

#[tokio::test]
async fn image_text_or_unknown_model_rejected_before_enqueue_and_vision_budget_is_not_usage() {
    for mut config in [provider(), vision_provider(), vision_provider()] {
        if config.model == "qwen3-vl-plus" {
            config.model = "qwen3-vl-plus-unknown".into();
        }
        let (_storage, runtime, model) = setup();
        runtime.start("images", config, None).unwrap();
        runtime.await_idle("images").await.unwrap();
        assert!(runtime
            .submit_images(input("one"))
            .await
            .unwrap_err()
            .contains("UNSUPPORTED"));
        assert_eq!(model.request_count(), 0);
    }
    let (_storage, runtime, model) = setup();
    runtime.start("images", vision_provider(), None).unwrap();
    runtime.await_idle("images").await.unwrap();
    let mut twenty = input("twenty");
    twenty.images = vec![upload(ImageFormat::Png); 20];
    runtime.submit_images(twenty).await.unwrap();
    runtime.await_idle("images").await.unwrap();
    assert!(runtime
        .submit_images(input("twenty-first"))
        .await
        .unwrap_err()
        .contains("BUDGET"));
    assert_eq!(model.request_count(), 1);
    let events = all_events(&runtime, "images");
    assert!(events.iter().any(|e|matches!(e.payload,AgentSessionEventPayload::RequestContext {input_tokens:Some(n),..}if n>81920)));
    let encoded = serde_json::to_string(&events).unwrap();
    assert!(!encoded.contains("data:image"));
}

#[tokio::test]
async fn image_restart_reuses_pixels_and_missing_or_tampered_blob_fails_closed() {
    let (storage, runtime, _) = setup();
    runtime.start("images", vision_provider(), None).unwrap();
    runtime.submit_images(input("one")).await.unwrap();
    runtime.await_idle("images").await.unwrap();
    drop(runtime);
    let model = FakeAdapter::new(vec![reply("restored", &[])]);
    let restarted = AgentRuntimeBuilder::new()
        .model_factory(Arc::new(FakeFactory(model.clone())))
        .build();
    restarted.configure(storage.path().to_path_buf()).unwrap();
    restarted.submit_images(input("one")).await.unwrap(); // exact receipt works without a live agent
    restarted
        .followup("images", "text".into(), "look again".into())
        .unwrap();
    restarted.start("images", vision_provider(), None).unwrap();
    restarted.await_idle("images").await.unwrap();
    let requests = model.requests.lock().unwrap();
    let refs = requests[0]
        .messages
        .iter()
        .find_map(|m| match m {
            ModelMessage::UserImages {
                images, data_urls, ..
            } => {
                assert_eq!(images.len(), data_urls.len());
                Some(images.clone())
            }
            _ => None,
        })
        .unwrap();
    drop(requests);
    let path = storage
        .path()
        .join("agent-runtime/images-v1")
        .join(&refs[0].sha256);
    let original = std::fs::read(&path).unwrap();
    std::fs::write(&path, vec![0; original.len()]).unwrap();
    assert!(restarted
        .models
        .images
        .read(&refs[0])
        .unwrap_err()
        .contains("TAMPERED"));
    std::fs::remove_file(path).unwrap();
    assert!(restarted
        .models
        .images
        .read(&refs[0])
        .unwrap_err()
        .contains("MISSING"));
}

#[tokio::test]
async fn image_every_log_prefix_repairs_claim_once_and_preserves_actual_model_input() {
    let (storage, runtime, _) = setup();
    runtime.start("images", vision_provider(), None).unwrap();
    runtime.submit_images(input("prefix")).await.unwrap();
    runtime.await_idle("images").await.unwrap();
    let events = all_events(&runtime, "images");
    let enqueued = events
        .iter()
        .position(|e| {
            matches!(
                e.payload,
                AgentSessionEventPayload::InboxSpliced {
                    operation: crate::agent_runtime::AgentInboxOperation::Enqueued,
                    ..
                }
            )
        })
        .unwrap();
    let header = events
        .iter()
        .position(|e| matches!(e.payload, AgentSessionEventPayload::RequestHeader { .. }))
        .unwrap();
    let blobs = std::fs::read_dir(storage.path().join("agent-runtime/images-v1"))
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .collect::<Vec<_>>();
    for end in enqueued..=header {
        for trailing in [false, true] {
            let dir = tempfile::tempdir().unwrap();
            let logs = dir.path().join("agent-runtime/sessions-v5");
            std::fs::create_dir_all(&logs).unwrap();
            let mut lines = events[..=end]
                .iter()
                .map(|e| format!("{}\n", serde_json::to_string(e).unwrap()))
                .collect::<String>();
            if trailing {
                lines.push_str("{\"interrupted_write\":");
            }
            std::fs::write(logs.join("images.jsonl"), lines).unwrap();
            let image_dir = dir.path().join("agent-runtime/images-v1");
            std::fs::create_dir_all(&image_dir).unwrap();
            for blob in &blobs {
                std::fs::copy(blob, image_dir.join(blob.file_name().unwrap())).unwrap();
            }
            let model = FakeAdapter::new(vec![reply("prefix recovered", &[])]);
            let restored = AgentRuntimeBuilder::new()
                .model_factory(Arc::new(FakeFactory(model.clone())))
                .build();
            restored.configure(dir.path().to_path_buf()).unwrap();
            restored.submit_images(input("prefix")).await.unwrap(); // receipt recovery works before attach
            restored.start("images", vision_provider(), None).unwrap();
            restored.await_idle("images").await.unwrap();
            let log = all_events(&restored, "images");
            assert_eq!(log.iter().filter(|e|matches!(&e.payload,AgentSessionEventPayload::InboxSpliced {operation:crate::agent_runtime::AgentInboxOperation::Enqueued,messages,..}if messages.iter().any(|m|m.client_submission_id.as_deref()==Some("prefix")))).count(),1,"prefix {end}");
            assert_eq!(log.iter().filter(|e|matches!(&e.payload,AgentSessionEventPayload::UserMessage {message}if message.message_id=="prefix")).count(),1,"prefix {end}");
            assert_eq!(model.request_count(), 1, "prefix {end}");
            assert!(model.requests.lock().unwrap()[0].messages.iter().any(|m|matches!(m,ModelMessage::UserImages{images,data_urls,..}if images.len()==1 && data_urls[0].starts_with("data:image/png;base64,"))));
        }
    }
}

#[tokio::test]
async fn image_concurrent_duplicate_and_conflicting_operations_commit_once() {
    let (_storage, runtime, model) = setup();
    runtime.start("images", vision_provider(), None).unwrap();
    runtime.await_idle("images").await.unwrap();
    let one = runtime.submit_images(input("same"));
    let two = runtime.submit_images(input("same"));
    let (a, b) = tokio::join!(one, two);
    a.unwrap();
    b.unwrap();
    runtime.await_idle("images").await.unwrap();
    assert_eq!(model.request_count(), 1);
    let mut changed = input("same");
    changed.content = "different secret sk-not-real-password".into();
    assert!(runtime.submit_images(changed).await.is_err());
}

#[tokio::test]
async fn inbox_steer_image_submission_keeps_attachment_in_the_next_model_step() {
    let model = FakeAdapter::new(vec![
        FakeScript::Wait {
            response: Some(response("first")),
        },
        reply("image received", &[]),
    ]);
    let (storage, runtime) = configured(model.clone());
    skill_tests::create_skill_session(&runtime, "images", storage.path());
    runtime
        .followup("images", "initial".into(), "first".into())
        .unwrap();
    runtime.start("images", vision_provider(), None).unwrap();
    model.started.notified().await;
    runtime.submit_images(input("queued-image")).await.unwrap();
    let before = runtime.session("images").unwrap();
    let message = before.inbox.next_turn[0].clone();
    let mutation = crate::agent_runtime::AgentInboxMutationInput {
        session_id: "images".into(),
        expected_revision: before.event_count,
        client_operation_id: "steer-image".into(),
        mutation: crate::agent_runtime::AgentInboxMutation::Steer {
            item_id: message.message_id.clone(),
        },
    };
    let accepted = runtime.mutate_inbox(mutation).unwrap();
    assert_eq!(accepted.inbox.next_step, vec![message.clone()]);
    model.release.notify_one();
    runtime.await_idle("images").await.unwrap();
    let requests = model.requests.lock().unwrap();
    assert_eq!(requests.len(), 2);
    assert!(requests[1].messages.iter().any(|m| matches!(m, ModelMessage::UserImages { content, images, data_urls } if content == &message.content && images == &message.images && data_urls.len() == 1)));
    let users = all_events(&runtime, "images");
    let original = users.iter().find(|e| matches!(&e.payload, AgentSessionEventPayload::UserMessage { message } if message.message_id == "initial")).unwrap();
    let steered = users.iter().filter(|e| matches!(&e.payload, AgentSessionEventPayload::UserMessage { message: queued } if queued == &message)).collect::<Vec<_>>();
    assert_eq!(steered.len(), 1);
    assert_eq!(steered[0].turn_id, original.turn_id);
    assert_ne!(steered[0].step_id, original.step_id);
}

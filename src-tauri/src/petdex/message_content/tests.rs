use super::*;
use crate::petdex::{slots::Slots, types::*, ActivityGuard, PetdexAdapter};
use std::time::Instant;

#[test]
fn sensitive_fields_fall_back_before_any_truncation_or_markdown_filtering() {
    for value in [
        format!("{} password=never-expose", "界".repeat(100)),
        "safe [REDACTED] tail".into(),
        "safe [redacted private key]".into(),
        "safe `token=never-expose`".into(),
        "safe [link](https://user:secret@example.org)".into(),
        "{\"credentials\":{\"opaque\":\"material\"}}".into(),
        "safe -----BEGIN PRIVATE KEY----- unfinished".into(),
        "safe password=\"line one\nline two\"".into(),
        "safe ${ {ignored} } [REDACTED PRIVATE KEY]".into(),
        "pass**word**=never-expose".into(),
        "x".repeat(MAX_CANDIDATE_BYTES + 1),
    ] {
        assert!(safe_text(&value, TEXT_BYTES, true).is_none());
        if !value.contains("**") {
            assert!(safe_text(&value, TITLE_BYTES, false).is_none());
        }
    }
    assert!(safe_text("pass\u{202e}word=hidden", TEXT_BYTES, false).is_none());
}

#[test]
fn markdown_retains_visible_prose_without_code_images_html_or_addresses() {
    let input = "Done **well** [guide](https://example.org/private) `hidden_code`\n\n```sh\nhidden_block\n```\n\n![hidden_alt](image.png) <https://example.org/auto> <me@example.org>\n\n<div>hidden_html</div>\n\nNext visible https://example.org/bare [https://example.org/label](https://example.org/target) me@example.org";
    let text = safe_text(input, TEXT_BYTES, true).unwrap();
    assert!(text.contains("Done well guide"));
    assert!(text.contains("Next visible"));
    for forbidden in ["hidden", "https", "example.org", "image.png", "<b>", "```"] {
        assert!(!text.contains(forbidden));
    }
    assert!(safe_text("`only code`", TEXT_BYTES, true).is_none());
    assert!(safe_text(
        "before <script>invisible()</script> after",
        TEXT_BYTES,
        true
    )
    .is_none());
}

#[test]
fn compact_wire_is_utf8_bounded_and_needs_no_string_escapes() {
    for candidate in [
        "中文😀\"引号\"\\路径\n\t尾部\u{202e}".repeat(20),
        "A".repeat(300),
    ] {
        let title = safe_text(&candidate, TITLE_BYTES, false).unwrap();
        let text = safe_text(&candidate, TEXT_BYTES, false).unwrap();
        assert!(title.ends_with('…') && text.ends_with('…'));
        let message = SafeMessage {
            title,
            text,
            busy: true,
        };
        let bytes = message.encode("shellspan-test-slot-1").unwrap();
        let wire = String::from_utf8(bytes).unwrap();
        assert!(!wire.contains('\\'));
        assert!(wire.contains("\"busy\":true"));
        let parsed: serde_json::Value = serde_json::from_str(&wire).unwrap();
        assert_eq!(parsed.as_object().unwrap().len(), 5);
        assert!(parsed["title"].as_str().unwrap().len() <= TITLE_BYTES);
        assert!(parsed["text"].as_str().unwrap().len() <= TEXT_BYTES);
    }
    assert_eq!(
        safe_text("中\"文\\\n\t😀", TEXT_BYTES, false).unwrap(),
        "中”文＼ 😀"
    );
}

#[test]
fn shared_templates_and_overflow_counts_are_safe_in_both_languages() {
    let en = &TEMPLATES["en-US"];
    let zh = &TEMPLATES["zh-CN"];
    assert_eq!(en.keys().collect::<Vec<_>>(), zh.keys().collect::<Vec<_>>());
    for locale in [MessageLocale::EnUs, MessageLocale::ZhCn] {
        for value in TEMPLATES[if locale == MessageLocale::EnUs {
            "en-US"
        } else {
            "zh-CN"
        }]
        .values()
        {
            assert!(valid(value, TEXT_BYTES));
        }
        assert!(SafeMessage::settled(locale)
            .encode("shellspan-test-slot-1")
            .is_some());
        assert!(SafeMessage::test(locale)
            .encode("shellspan-test-slot-1")
            .is_some());
        let now = Instant::now();
        let mut slots = Slots::default();
        slots.locale = locale;
        let events = (1..=104)
            .map(|run| {
                let mut event =
                    ActivityEvent::new(ActivitySource::Ai, run, 0, ActivityPhase::Running, now);
                event.owner = Some(ActivityOwner::Ai(format!("private-{run}")));
                event.details.title("hidden owner title");
                (event, None)
            })
            .collect();
        slots.project(events);
        let summary = slots.slots[2].content.as_ref().unwrap();
        assert_eq!(summary.owner_count, 102);
        let message = SafeMessage::from_content(summary);
        assert!(message.text.contains("99+"));
        assert_eq!(message.title, "ShellSpan");
        assert!(!message.text.contains("hidden"));
        assert!(message.encode("shellspan-test-slot-3").is_some());
    }
}

#[test]
fn default_off_and_details_revocation_clear_live_content_and_invalidate_snapshots() {
    let root = tempfile::tempdir().unwrap();
    let adapter = PetdexAdapter::new(root.path().into());
    let (_receiver, _) = adapter.prepare_coordinator().unwrap();
    let mut guard = ActivityGuard::owned(
        Some(adapter.clone()),
        ActivitySource::Sftp,
        ActivityPhase::Running,
        ActivityOwner::Connection(std::sync::Arc::new(uuid::Uuid::new_v4())),
        ActivityKind::Upload,
    );
    guard.details(|_| panic!("default disabled must not evaluate candidates"));
    assert!(adapter
        .message_snapshot(Instant::now(), 1, MessageLocale::EnUs)
        .message(0)
        .is_none());
    adapter.set_message_preferences(MessagePreferences {
        petdex_messages_enabled: true,
        petdex_message_details_enabled: true,
    });
    guard.details(|d| d.file("/private/folder/report.txt"));
    let detailed = adapter.message_snapshot(Instant::now(), 1, MessageLocale::EnUs);
    assert_eq!(detailed.message(0).unwrap().title, "report.txt");
    adapter.set_message_preferences(MessagePreferences {
        petdex_messages_enabled: true,
        petdex_message_details_enabled: false,
    });
    assert!(!adapter.message_snapshot_is_current(&detailed, 0, 1, Instant::now()));
    assert!(detailed.message(0).is_none());
    guard.details(|_| panic!("revoked details must not evaluate candidates"));
    guard.transition(ActivityPhase::Succeeded);
    let plain = adapter.message_snapshot(Instant::now(), 1, MessageLocale::EnUs);
    assert_eq!(plain.message(0).unwrap().title, "ShellSpan");
    assert!(plain.slots[0].content.as_ref().unwrap().details == SafeDetails::default());
    adapter.set_message_preferences(MessagePreferences {
        petdex_messages_enabled: true,
        petdex_message_details_enabled: true,
    });
    assert_eq!(
        adapter
            .message_snapshot(Instant::now(), 1, MessageLocale::EnUs)
            .message(0)
            .unwrap()
            .title,
        "ShellSpan"
    );
    adapter.stop_coordinator();
    assert!(adapter
        .message_snapshot(Instant::now(), 1, MessageLocale::EnUs)
        .message(0)
        .is_none());
}

#[test]
fn filenames_are_basename_only_and_sensitive_paths_fall_back() {
    let mut details = SafeDetails::default();
    details.file("C:\\work\\report.txt");
    assert_eq!(details.title.as_deref(), Some("report.txt"));
    details.file("/secret/token=hidden/report.txt");
    assert!(details.title.is_none());
}

#[test]
fn final_content_new_runs_and_app_language_have_independent_versions() {
    let root = tempfile::tempdir().unwrap();
    let adapter = PetdexAdapter::new(root.path().into());
    adapter.set_categories(PetdexCategories {
        ai: true,
        ..Default::default()
    });
    let (_receiver, _) = adapter.prepare_coordinator().unwrap();
    adapter.set_message_preferences(MessagePreferences {
        petdex_messages_enabled: true,
        petdex_message_details_enabled: true,
    });
    let owner = ActivityOwner::Ai("internal-only".into());
    let mut first = ActivityGuard::owned(
        Some(adapter.clone()),
        ActivitySource::Ai,
        ActivityPhase::Running,
        owner.clone(),
        ActivityKind::Ai,
    );
    first.details(|d| d.final_reply("Completed **visible work**."));
    // Even a safe candidate cannot appear in a running phase.
    assert_eq!(
        adapter
            .message_snapshot(Instant::now(), 1, MessageLocale::EnUs)
            .message(0)
            .unwrap()
            .text,
        "Preparing an AI response"
    );
    first.transition(ActivityPhase::Succeeded);
    let completed = adapter.message_snapshot(Instant::now(), 1, MessageLocale::EnUs);
    assert_eq!(
        completed.message(0).unwrap().text,
        "Completed visible work."
    );
    let mut second = ActivityGuard::owned(
        Some(adapter.clone()),
        ActivitySource::Ai,
        ActivityPhase::Running,
        owner,
        ActivityKind::Tool(ToolStage::ReadFile),
    );
    first.details(|_| panic!("finished run cannot reintroduce reply"));
    assert!(!adapter.message_snapshot_is_current(&completed, 0, 1, Instant::now()));
    let english =
        adapter.message_snapshot(Instant::now(), 1, MessageLocale::from_app_locale("en-US"));
    assert_eq!(english.message(0).unwrap().text, "Reading files");
    let chinese =
        adapter.message_snapshot(Instant::now(), 1, MessageLocale::from_app_locale("zh-CN"));
    assert_eq!(chinese.message(0).unwrap().text, "正在读取文件");
    assert!(!adapter.message_snapshot_is_current(&english, 0, 1, Instant::now()));
    assert_eq!(
        english.slots[0].binding_generation,
        chinese.slots[0].binding_generation
    );
    second.transition(ActivityPhase::Cancelled);
    assert!(adapter
        .message_snapshot(Instant::now(), 1, MessageLocale::ZhCn)
        .message(0)
        .is_none());
}

#[test]
fn message_preference_migration_defaults_off_and_all_native_tools_are_specific() {
    let preferences: MessagePreferences = serde_json::from_str("{}").unwrap();
    assert!(!preferences.petdex_messages_enabled && !preferences.petdex_message_details_enabled);
    assert_eq!(
        serde_json::to_value(preferences).unwrap(),
        serde_json::json!({
            "petdexMessagesEnabled": false, "petdexMessageDetailsEnabled": false
        })
    );
    for name in [
        "inspect_host",
        "inspect_service",
        "query_logs",
        "diagnose_endpoint",
        "trash_file",
        "exec_command",
        "terminal_execute",
        "probe_http",
        "read_terminal",
        "write_terminal_input",
        "wait_terminal",
        "write_stdin",
        "wait_process",
        "kill_process",
        "read_file",
        "list_directory",
        "search_text",
        "write_file",
        "edit_file",
        "apply_patch",
        "transfer_file",
        "skill",
    ] {
        assert_ne!(ToolStage::from_name(name), ToolStage::Other);
    }
    assert_eq!(
        ToolStage::from_name("untrusted-new-tool-name"),
        ToolStage::Other
    );
}

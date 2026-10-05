use super::slots::{Binding, MessageLocale, Slots};
use super::types::{ActivityKind, ActivityOwner, WaitReason, FAILURE_TTL, SUCCESS_TTL};
use super::*;

fn event(
    owner: &str,
    run: u64,
    revision: u64,
    phase: ActivityPhase,
    now: Instant,
) -> ActivityEvent {
    let mut event = ActivityEvent::new(ActivitySource::Ai, run, revision, phase, now);
    event.owner = Some(ActivityOwner::Ai(owner.into()));
    event
}

fn arbiter() -> PetdexArbiter {
    let mut arbiter = PetdexArbiter::default();
    arbiter.set_categories(PetdexCategories {
        ai: true,
        ..Default::default()
    });
    arbiter
}

#[test]
fn one_two_three_four_owners_enter_and_leave_summary_without_moving_survivors() {
    let now = Instant::now();
    let mut a = arbiter();
    for run in 1..=4 {
        a.apply(
            event(&run.to_string(), run, 0, ActivityPhase::Running, now),
            now,
        );
        a.target(now);
        assert_eq!(
            a.slots.slots.iter().filter(|s| s.content.is_some()).count(),
            (run as usize).min(3)
        );
        assert!(a.slots.slots[0].binding == Some(Binding::Owner(ActivityOwner::Ai("1".into()))));
    }
    let summary = a.slots.slots[2].content.as_ref().unwrap();
    assert_eq!(summary.owner_count, 2);
    assert_eq!(summary.active_run_count, 2);
    assert!(!summary.members.contains(&ActivityOwner::Ai("1".into())));
    let generation = a.slots.slots[2].binding_generation;
    a.apply(event("4", 4, 1, ActivityPhase::Cancelled, now), now);
    a.target(now);
    assert!(a.slots.slots[2].binding == Some(Binding::Owner(ActivityOwner::Ai("3".into()))));
    assert!(a.slots.slots[2].binding_generation > generation);
}

#[test]
fn stable_representative_and_summary_counts_include_terminal_owners() {
    let now = Instant::now();
    let mut events = Vec::new();
    for run in 1..=4 {
        let mut e = event(&run.to_string(), run, 1, ActivityPhase::Failed, now);
        e.kind = ActivityKind::Upload;
        events.push((e, Some(now + FAILURE_TTL)));
    }
    let mut slots = Slots::default();
    slots.project(events.clone());
    let summary = slots.slots[2].content.as_ref().unwrap();
    assert_eq!((summary.owner_count, summary.active_run_count), (2, 0));
    let mut upload = event("3", 5, 0, ActivityPhase::Running, now);
    upload.kind = ActivityKind::Upload;
    let mut download = event("3", 6, 0, ActivityPhase::Running, now);
    download.kind = ActivityKind::Download;
    events.extend([(upload, None), (download, None)]);
    slots.project(events.clone());
    let before = slots.slots.clone();
    events.reverse();
    slots.project(events);
    for (old, current) in before.iter().zip(&slots.slots) {
        assert!(old.content == current.content);
        assert_eq!(old.revision, current.revision);
    }
    let summary = slots.slots[2].content.as_ref().unwrap();
    assert_eq!((summary.owner_count, summary.active_run_count), (2, 2));
    let mut running = vec![
        (event("same", 1, 0, ActivityPhase::Running, now), None),
        (event("same", 2, 0, ActivityPhase::Running, now), None),
    ];
    running[0].0.kind = ActivityKind::Upload;
    running[1].0.kind = ActivityKind::Download;
    slots.project(running.clone());
    let before = slots.slots[0].clone();
    running.reverse();
    slots.project(running);
    assert_eq!(
        slots.slots[0].content.as_ref().unwrap().kind,
        ActivityKind::Upload
    );
    assert_eq!(before.revision, slots.slots[0].revision);
}

#[test]
fn priority_stability_absolute_expiry_and_connected_not_working() {
    let now = Instant::now();
    let mut a = arbiter();
    for run in 1..=5 {
        a.apply(
            event(&run.to_string(), run, 0, ActivityPhase::Running, now),
            now,
        );
        a.target(now);
    }
    a.apply(
        event("4", 4, 1, ActivityPhase::Waiting(WaitReason::Answer), now),
        now,
    );
    a.apply(event("5", 5, 1, ActivityPhase::Failed, now), now);
    a.target(now);
    assert!(a.slots.slots[..2]
        .iter()
        .any(|s| s.binding == Some(Binding::Owner(ActivityOwner::Ai("5".into())))));
    assert!(a.slots.slots[..2]
        .iter()
        .any(|s| s.binding == Some(Binding::Owner(ActivityOwner::Ai("4".into())))));
    // Newly waiting object at the same priority cannot displace an incumbent.
    a.apply(
        event("1", 1, 1, ActivityPhase::Waiting(WaitReason::Answer), now),
        now,
    );
    a.target(now);
    assert!(a.slots.slots[..2]
        .iter()
        .any(|s| s.binding == Some(Binding::Owner(ActivityOwner::Ai("4".into())))));
    a.apply(
        event("1", 1, 2, ActivityPhase::Waiting(WaitReason::Approval), now),
        now,
    );
    a.target(now);
    assert!(a.slots.slots[..2]
        .iter()
        .any(|s| s.binding == Some(Binding::Owner(ActivityOwner::Ai("1".into())))));
    a.target(now + FAILURE_TTL);
    assert!(!a
        .slots
        .slots
        .iter()
        .filter_map(|s| s.content.as_ref())
        .any(|c| c.members.contains(&ActivityOwner::Ai("5".into()))));

    let mut a = arbiter();
    a.apply(event("ssh", 1, 0, ActivityPhase::Connecting, now), now);
    a.apply(event("ssh", 1, 1, ActivityPhase::Connected, now), now);
    a.target(now);
    assert_eq!(
        a.slots.slots[0].content.as_ref().unwrap().active_run_count,
        0
    );
    a.target(now + SUCCESS_TTL);
    assert!(a.slots.slots.iter().all(|s| s.content.is_none()));
}

#[test]
fn duplicates_late_events_categories_and_continuous_turns() {
    let now = Instant::now();
    let mut a = arbiter();
    a.apply(event("session", 1, 0, ActivityPhase::Running, now), now);
    a.apply(event("session", 1, 0, ActivityPhase::Running, now), now);
    a.target(now);
    assert_eq!(
        a.slots.slots[0].content.as_ref().unwrap().active_run_count,
        1
    );
    let generation = a.slots.slots[0].binding_generation;
    a.apply(event("session", 1, 1, ActivityPhase::Succeeded, now), now);
    a.apply(event("session", 2, 0, ActivityPhase::Running, now), now);
    a.apply(event("session", 1, 2, ActivityPhase::Failed, now), now);
    a.target(now);
    assert_eq!(a.slots.slots[0].binding_generation, generation);
    assert_eq!(
        a.slots.slots[0].content.as_ref().unwrap().phase,
        ActivityPhase::Running
    );
    a.set_categories(PetdexCategories::default());
    a.target(now);
    assert!(a.slots.slots.iter().all(|s| s.content.is_none()));
    a.set_categories(PetdexCategories {
        ai: true,
        ..Default::default()
    });
    a.target(now);
    assert_eq!(
        a.slots.slots[0].content.as_ref().unwrap().active_run_count,
        1
    );
}

#[test]
fn snapshot_rejects_rebinding_revision_service_cancel_and_expiry() {
    let root = tempfile::tempdir().unwrap();
    let adapter = PetdexAdapter::new(root.path().to_owned());
    adapter.set_categories(PetdexCategories {
        ai: true,
        ..Default::default()
    });
    let (_receiver, _) = adapter.prepare_coordinator().unwrap();
    let mut first = ActivityGuard::owned(
        Some(adapter.clone()),
        ActivitySource::Ai,
        ActivityPhase::Running,
        ActivityOwner::Ai("first".into()),
        ActivityKind::Ai,
    );
    let snapshot = adapter.message_snapshot(Instant::now(), 1, MessageLocale::EnUs);
    assert!(adapter.message_snapshot_is_current(&snapshot, 0, 1, Instant::now()));
    assert!(!adapter.message_snapshot_is_current(&snapshot, 0, 2, Instant::now()));
    adapter.message_snapshot(Instant::now(), 1, MessageLocale::ZhCn);
    assert!(!adapter.message_snapshot_is_current(&snapshot, 0, 1, Instant::now()));
    first.transition(ActivityPhase::Succeeded);
    let result = adapter.message_snapshot(Instant::now(), 1, MessageLocale::EnUs);
    assert!(!adapter.message_snapshot_is_current(&result, 0, 1, Instant::now() + SUCCESS_TTL));
    let mut second = ActivityGuard::owned(
        Some(adapter.clone()),
        ActivitySource::Ai,
        ActivityPhase::Running,
        ActivityOwner::Ai("second".into()),
        ActivityKind::Ai,
    );
    assert!(!adapter.message_snapshot_is_current(&snapshot, 0, 1, Instant::now()));
    let current = adapter.message_snapshot(Instant::now(), 1, MessageLocale::EnUs);
    adapter.stop_coordinator();
    adapter.prepare_coordinator().unwrap();
    assert!(!adapter.message_snapshot_is_current(&current, 0, 1, Instant::now()));
    second.transition(ActivityPhase::Cancelled);
}

#[test]
fn concurrent_batch_cancellation_keeps_surviving_owner_and_count() {
    let root = tempfile::tempdir().unwrap();
    let adapter = PetdexAdapter::new(root.path().to_owned());
    let owner = ActivityOwner::Connection(std::sync::Arc::new(uuid::Uuid::new_v4()));
    let mut survivor = ActivityGuard::owned(
        Some(adapter.clone()),
        ActivitySource::Sftp,
        ActivityPhase::Running,
        owner.clone(),
        ActivityKind::Download,
    );
    std::thread::scope(|scope| {
        for _ in 0..32 {
            let adapter = adapter.clone();
            let owner = owner.clone();
            scope.spawn(move || {
                let mut guard = ActivityGuard::owned(
                    Some(adapter),
                    ActivitySource::Sftp,
                    ActivityPhase::Running,
                    owner,
                    ActivityKind::Upload,
                );
                guard.transition(ActivityPhase::Cancelled);
            });
        }
    });
    let snapshot = adapter.message_snapshot(Instant::now(), 1, MessageLocale::EnUs);
    let content = snapshot.slots[0].content.as_ref().unwrap();
    assert_eq!((content.owner_count, content.active_run_count), (1, 1));
    survivor.transition(ActivityPhase::Cancelled);
    let snapshot = adapter.message_snapshot(Instant::now(), 1, MessageLocale::EnUs);
    assert!(snapshot.slots.iter().all(|s| s.content.is_none()));
}

#[test]
fn fixed_keys_minimal_persistence_exclusive_writer_and_recovery() {
    const CHILD_DIRECTORY: &str = "SHELLSPAN_PETDEX_LOCK_TEST_DIRECTORY";
    if let Some(directory) = std::env::var_os(CHILD_DIRECTORY) {
        assert!(installation::Installation::open(std::path::Path::new(&directory)).is_err());
        return;
    }
    let root = tempfile::tempdir().unwrap();
    let mut installation = installation::Installation::open(root.path()).unwrap();
    let keys: Vec<_> = (0..3).map(|i| installation.key(i).unwrap()).collect();
    assert!(keys.iter().all(|k| k.is_ascii() && k.len() <= 64));
    assert!(installation.key(3).is_none());
    assert!(installation::Installation::open(root.path()).is_err());
    let child = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "petdex::slot_tests::fixed_keys_minimal_persistence_exclusive_writer_and_recovery",
        ])
        .env(CHILD_DIRECTORY, root.path())
        .output()
        .unwrap();
    assert!(
        child.status.success(),
        "child process lock check: {}",
        String::from_utf8_lossy(&child.stderr)
    );
    installation.mark_attempt(1, true).unwrap();
    installation.mark_attempt(1, false).unwrap();
    assert!(installation.usage()[1].possibly_busy);
    drop(installation);
    let mut recovered = installation::Installation::open(root.path()).unwrap();
    assert_eq!(recovered.key(1).unwrap(), keys[1]);
    assert!(recovered.usage()[1].used && recovered.usage()[1].possibly_busy);
    assert!(!recovered.usage()[0].used);
    recovered.mark_settled(1).unwrap();
    drop(recovered);
    let recovered = installation::Installation::open(root.path()).unwrap();
    assert!(!recovered.usage()[1].possibly_busy);
    let data: serde_json::Value =
        serde_json::from_slice(&std::fs::read(root.path().join("petdex-messages.json")).unwrap())
            .unwrap();
    assert_eq!(data.as_object().unwrap().len(), 2);
    assert_eq!(data["slots"].as_array().unwrap().len(), 3);
}

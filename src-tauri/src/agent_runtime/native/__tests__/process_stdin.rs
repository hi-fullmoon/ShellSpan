use super::*;

fn source_input() -> String {
    // Exercise a contract-sized write with actual repository text.
    include_str!("../process.rs").chars().take(60_000).collect()
}

fn fill_stdin(process: Arc<ManagedProcessNative>) -> thread::JoinHandle<Result<(), String>> {
    thread::spawn(move || {
        let input = source_input();
        for _ in 0..64 {
            process.write_stdin(input.clone(), false)?;
        }
        Err("The process accepted all bounded writes without reading stdin".into())
    })
}

#[test]
fn local_stdin_backpressure_does_not_block_task_cancellation() {
    let command = if cfg!(windows) {
        "[Console]::Out.Write('ready'); Start-Sleep -Seconds 30"
    } else {
        "printf ready; sleep 30"
    };
    let process = spawn_local_process_native(
        "stdin-cancel".into(),
        "stdin-cancel".into(),
        "local".into(),
        command,
        None,
        Duration::from_secs(40),
    )
    .unwrap();
    let registry = ProcessRegistryNative::default();
    registry.insert(process.clone()).unwrap();
    let writer = fill_stdin(process.clone());
    thread::sleep(Duration::from_millis(250));
    assert!(
        !writer.is_finished(),
        "stdin must be backpressured before cancellation"
    );
    let started = Instant::now();
    let cancellation = registry.cancel_task("stdin-cancel");
    let snapshot = process.snapshot().unwrap();
    assert!(cancellation.is_ok(), "{cancellation:?}; {snapshot:?}");
    assert!(started.elapsed() < Duration::from_secs(3), "{snapshot:?}");
    assert_eq!(snapshot.state, ProcessLifecycleNative::Cancelled);
    assert!(snapshot.termination_confirmed, "{snapshot:?}");
    assert!(registry.get(&snapshot.process_handle).is_err());
    assert!(writer.join().unwrap().is_err());
}

#[test]
fn local_stdin_backpressure_does_not_block_the_process_deadline() {
    let command = if cfg!(windows) {
        "[Console]::Out.Write('ready'); Start-Sleep -Seconds 30"
    } else {
        "printf ready; sleep 30"
    };
    let process = spawn_local_process_native(
        "stdin-timeout".into(),
        "stdin-timeout".into(),
        "local".into(),
        command,
        None,
        Duration::from_millis(600),
    )
    .unwrap();
    let writer = fill_stdin(process.clone());
    thread::sleep(Duration::from_millis(200));
    assert!(
        !writer.is_finished(),
        "stdin must fill before the process deadline"
    );
    let snapshot = process.wait(Duration::from_secs(3)).unwrap();
    assert_eq!(
        snapshot.state,
        ProcessLifecycleNative::TimedOut,
        "{snapshot:?}"
    );
    assert!(snapshot.termination_confirmed);
    assert!(writer.join().unwrap().is_err());
}

#[cfg(unix)]
#[test]
fn real_stdin_partial_writes_preserve_all_bytes_and_eof() {
    let workspace = tempfile::tempdir().unwrap();
    let input = source_input();
    let process = spawn_local_process_native(
        "stdin-copy".into(),
        "stdin-copy".into(),
        "local".into(),
        "cat > received.rs",
        Some(workspace.path()),
        Duration::from_secs(10),
    )
    .unwrap();
    assert_eq!(
        process.write_stdin(input.clone(), true).unwrap(),
        input.len()
    );
    let snapshot = process.wait(Duration::from_secs(5)).unwrap();
    assert_eq!(
        snapshot.state,
        ProcessLifecycleNative::Exited,
        "{snapshot:?}"
    );
    assert_eq!(snapshot.exit_code, Some(0));
    let actual = std::fs::read_to_string(workspace.path().join("received.rs")).unwrap();
    assert!(
        actual == input,
        "stdin bytes changed: expected {} bytes, received {}",
        input.len(),
        actual.len()
    );
}

#[test]
fn local_stdin_write_deadline_does_not_leave_an_unresponsive_process_worker() {
    let command = if cfg!(windows) {
        "Start-Sleep -Seconds 30"
    } else {
        "sleep 30"
    };
    let process = spawn_local_process_native(
        "stdin-write-deadline".into(),
        "stdin-write-deadline".into(),
        "local".into(),
        command,
        None,
        Duration::from_secs(40),
    )
    .unwrap();
    let result = fill_stdin(process.clone()).join().unwrap();
    let error = result.unwrap_err();
    let snapshot = process.wait(Duration::from_secs(3)).unwrap();
    assert!(
        error.contains("stdin write timed out after accepting"),
        "{error}"
    );
    assert_eq!(
        snapshot.state,
        ProcessLifecycleNative::Failed,
        "{snapshot:?}"
    );
    assert!(snapshot.termination_confirmed);
}

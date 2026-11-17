//! Standalone storage evidence. It never produces a terminal execution receipt.
// These whole production modules are imported unchanged; the probe deliberately
// calls only persistence APIs and has no terminal protocol execution path.
#[allow(
    dead_code,
    reason = "standalone probe imports the complete production protocol"
)]
#[path = "../src/terminal_command/protocol.rs"]
mod protocol;
mod state {
    pub(crate) use super::protocol::Identity as CommandIdentity;
}
#[allow(
    dead_code,
    reason = "standalone probe exercises persistence without settling intentions"
)]
#[path = "../src/terminal_command/journal.rs"]
mod journal;

use std::io::Write;
use std::path::PathBuf;
use std::time::Duration;

fn main() {
    let args: Vec<_> = std::env::args().skip(1).collect();
    assert_eq!(
        args.len(),
        3,
        "mode, owned data directory and identity required"
    );
    let mode = &args[0];
    assert!(matches!(mode.as_str(), "record-and-wait" | "inspect"));
    let root = PathBuf::from(&args[1]);
    let id = uuid::Uuid::parse_str(&args[2]).expect("exact probe UUID required");
    assert!(root.is_absolute());
    let project = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .canonicalize()
        .unwrap();
    assert!(root.starts_with(project.join("artifacts/tests/agent-terminal-input")));
    assert_eq!(root.file_name().unwrap(), "data");
    assert_eq!(
        root.parent().unwrap().file_name().unwrap(),
        id.to_string().as_str()
    );
    let identity = protocol::Identity {
        terminal_session_id: format!("storage-probe-terminal-{id}"),
        terminal_generation: 1,
        lease_id: format!("storage-probe-lease-{id}"),
        lease_generation: 1,
        agent_session_id: format!("storage-probe-agent-{id}"),
        task_id: format!("storage-probe-task-{id}"),
        operation_id: format!("storage-probe-operation-{id}"),
        command_id: format!("storage-probe-command-{id}"),
        source_revision: 1,
    };
    let journal = journal::SubmissionJournal::unconfigured();
    journal.configure(&root).unwrap();
    if mode == "record-and-wait" {
        journal
            .ensure_new_operation(
                &identity.agent_session_id,
                &identity.task_id,
                &identity.operation_id,
            )
            .unwrap();
        journal.record(&identity).unwrap();
        let records = journal.unresolved_for_agent(None).unwrap();
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].identity, identity);
        println!(
            "{}",
            serde_json::json!({
                "kind":"production-journal-durable-record-before-owned-crash",
                "pid":std::process::id(),"root":root,"identity":identity,"records":records,
                "nativeAcceptance":false,"terminalInput":false,"executionReceipts":false
            })
        );
        std::io::stdout().flush().unwrap();
        loop {
            std::thread::sleep(Duration::from_secs(1));
        }
    }
    let duplicate = journal.ensure_new_operation(
        &identity.agent_session_id,
        &identity.task_id,
        &identity.operation_id,
    );
    let new_operation = journal.ensure_new_operation(
        &identity.agent_session_id,
        &identity.task_id,
        &format!("new-operation-{id}"),
    );
    let records = journal.unresolved_for_agent(None);
    println!(
        "{}",
        serde_json::json!({
            "kind":"production-journal-independent-process-inspection",
            "pid":std::process::id(),"root":root,"identity":identity,
            "duplicate":duplicate,"newOperation":new_operation,"records":records,
            "nativeAcceptance":false,"terminalInput":false,"executionReceipts":false
        })
    );
}

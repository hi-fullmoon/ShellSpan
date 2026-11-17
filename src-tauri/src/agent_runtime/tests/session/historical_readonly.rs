// Explicit corpus audit through the production pure reconstruction path. Never
// open a Session store, publish an event, repair a file or execute old work.
#[test]
#[ignore = "requires explicit owned historical corpus plan and exclusive metadata output"]
fn validate_owned_historical_session_corpus_readonly() {
    use serde::Deserialize;
    use sha2::{Digest, Sha256};
    use std::io::Write;

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct Input {
        owner_root: PathBuf,
        output: PathBuf,
        records: Vec<InputRecord>,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct InputRecord {
        file: PathBuf,
        sha256: String,
        archived_directory: bool,
    }
    let plan = PathBuf::from(
        std::env::var_os("SHELLSPAN_SESSION_READONLY_AUDIT_PLAN")
            .expect("explicit owned historical plan required"),
    );
    assert!(plan.is_absolute());
    let input: Input = serde_json::from_slice(&fs::read(&plan).expect("read plan metadata"))
        .expect("decode bounded corpus plan");
    let owner = fs::canonicalize(&input.owner_root).expect("resolve explicit owner root");
    let artifacts = fs::canonicalize(owner.join("artifacts/tests")).expect("owned artifact root");
    assert!(fs::canonicalize(&plan).unwrap().starts_with(&artifacts));
    assert!(input.output.is_absolute());
    assert!(fs::canonicalize(input.output.parent().unwrap())
        .unwrap()
        .starts_with(&artifacts));
    assert!(!input.records.is_empty() && input.records.len() <= 128);
    let mut rows = Vec::new();
    let mut rejected = 0;
    for record in &input.records {
        let file = fs::canonicalize(&record.file).expect("resolve original log");
        assert!(file.starts_with(&artifacts));
        let info = fs::symlink_metadata(&record.file).expect("inspect original log");
        assert!(info.is_file() && !info.file_type().is_symlink() && info.len() <= 67_108_864);
        let bytes = fs::read(&record.file).expect("read original log without a store");
        let digest = hex::encode(Sha256::digest(&bytes));
        assert_eq!(digest, record.sha256, "Original corpus input changed");
        let decoded = serde_json::Deserializer::from_slice(&bytes)
            .into_iter::<AgentSessionEvent>()
            .collect::<Result<Vec<_>, _>>();
        let (accepted, event_count, category) = match decoded {
            Ok(events) => {
                let count = events.len();
                match validate_session_events(events) {
                    Ok(()) => (true, count, "production-reconstruction-accepted"),
                    Err(_) => (false, count, "production-reconstruction-rejected"),
                }
            }
            Err(_) => (false, 0, "current-event-deserialization-rejected"),
        };
        rejected += usize::from(!accepted);
        assert_eq!(
            hex::encode(Sha256::digest(fs::read(&record.file).unwrap())),
            record.sha256,
            "Read-only validation changed an original log"
        );
        rows.push(serde_json::json!({
            "file": record.file,
            "sha256": digest,
            "archivedDirectory": record.archived_directory,
            "eventCount": event_count,
            "accepted": accepted,
            "category": category,
            "originalBytesUnchanged": true,
            "sourceOrMessageContentsExported": false
        }));
    }
    let value = serde_json::json!({
        "records": rows,
        "selected": input.records.len(),
        "accepted": input.records.len() - rejected,
        "rejected": rejected,
        "validator": "session::validate_session_events -> AgentSessionRecord::from_events",
        "sessionStoreOpened": false,
        "eventsPublished": 0,
        "journalsRepairedOrWritten": 0,
        "runtimeStarts": 0,
        "sourceOperationsExecuted": 0,
        "modelCalls": 0,
        "cleanupAuthorizationGranted": false
    });
    let mut output = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&input.output)
        .expect("create exclusive metadata-only result");
    output
        .write_all(serde_json::to_string_pretty(&value).unwrap().as_bytes())
        .expect("write safe corpus result");
    output.sync_all().expect("flush metadata result");
    assert_eq!(
        rejected, 0,
        "Historical corpus rejected; retain originals and inspect metadata report"
    );
}

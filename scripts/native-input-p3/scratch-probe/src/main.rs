//! Concurrent real ownership-file reads and replacements; no Agent or shell.
#[path = "../../../../src-tauri/src/agent_runtime/scratch_storage.rs"]
mod storage;

use std::path::PathBuf;
use std::sync::{Arc, Barrier, Mutex};
use std::thread;

fn main() {
    let directory = PathBuf::from(std::env::args_os().nth(1).expect("new owned directory required"));
    assert!(directory.is_absolute() && !directory.exists());
    std::fs::create_dir_all(&directory).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o700)).unwrap();
    }
    let directory = directory.canonicalize().unwrap();
    let path = Arc::new(directory.join(format!("{}.json", "a".repeat(64))));
    storage::write_json(&path, &serde_json::json!({"sequence":0,"body":"x".repeat(512)})).unwrap();
    let start = Arc::new(Barrier::new(9));
    let writers = Arc::new(Mutex::new(()));
    let mut workers = Vec::new();
    for worker in 0..8 {
        let (path, start, writers) = (path.clone(), start.clone(), writers.clone());
        workers.push(thread::spawn(move || {
            start.wait();
            let mut failures = Vec::new();
            for sequence in 0..2000 {
                let result = if worker < 2 {
                    // The real ScratchStore already serializes its writers.
                    let _state = writers.lock().unwrap();
                    storage::write_json(&path, &serde_json::json!({"sequence":sequence,"body":"x".repeat(512)}))
                } else {
                    storage::read_json::<serde_json::Value>(&path).map(|value| {
                        assert_eq!(value["body"].as_str().unwrap().len(), 512);
                    })
                };
                if let Err(error) = result {
                    failures.push(serde_json::json!({"worker":worker,"sequence":sequence,"error":error}));
                }
            }
            failures
        }));
    }
    start.wait();
    let failures: Vec<_> = workers.into_iter().flat_map(|worker| worker.join().unwrap()).collect();
    let result = serde_json::json!({"kind":"actual-scratch-metadata-concurrency","attempted":16000,"failures":failures,"nativeAcceptance":false,"noCredential":true,"atomicReplace":true});
    println!("{result}");
    if !result["failures"].as_array().unwrap().is_empty() {
        std::process::exit(1);
    }
}

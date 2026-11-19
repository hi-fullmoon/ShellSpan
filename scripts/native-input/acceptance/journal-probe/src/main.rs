//! Runs the actual production journal, no terminal or execution receipts.
#[path = "../../../../../src-tauri/src/terminal_command/protocol.rs"]
mod protocol;
mod state { pub(crate) use super::protocol::Identity as CommandIdentity; }
#[path = "../../../../../src-tauri/src/terminal_command/journal.rs"]
mod journal;
use std::{path::PathBuf,sync::Arc,thread};
fn main(){
 let directory=PathBuf::from(std::env::args_os().nth(1).expect("new owned directory required"));
 assert!(directory.is_absolute()&&!directory.exists());std::fs::create_dir_all(&directory).unwrap();
 let journal=Arc::new(journal::SubmissionJournal::unconfigured());journal.configure(&directory).unwrap();journal.ensure_new_operation("initial-probe","initial-task","initial-operation").unwrap();
 let mut workers=Vec::new();
 for worker in 0..8 {let journal=journal.clone();workers.push(thread::spawn(move||{
  let mut failures=Vec::new();
  for index in 0..100 {
   let id=protocol::Identity{terminal_session_id:format!("probe-{worker}"),terminal_generation:1,lease_id:format!("lease-{worker}-{index}"),lease_generation:index+1,agent_session_id:format!("agent-{worker}"),task_id:format!("task-{worker}"),operation_id:format!("operation-{index}"),command_id:format!("command-{worker}-{index}"),source_revision:1};
   let outcome=(||->Result<(),String>{journal.ensure_new_operation(&id.agent_session_id,&id.task_id,&id.operation_id)?;journal.record(&id)?;journal.unresolved_for_agent(Some(&id.agent_session_id))?;journal.settle(&id)?;Ok(())})();
   if let Err(error)=outcome {failures.push(serde_json::json!({"worker":worker,"iteration":index,"error":error}));}
  }
  failures
 }));}
 let failures:Vec<_>=workers.into_iter().flat_map(|worker|worker.join().unwrap()).collect();
 let remaining=journal.unresolved_for_agent(None);let summary=serde_json::json!({"kind":"actual-production-journal-concurrency","attempted":800,"failures":failures,"unresolved":remaining.as_ref().map(|value|value.len()).ok(),"readError":remaining.err(),"nativeAcceptance":false,"synchronous":"FULL","noTerminalInput":true});
 println!("{summary}");if !summary["failures"].as_array().unwrap().is_empty(){std::process::exit(1);}
}

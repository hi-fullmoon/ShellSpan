//! Reads actual isolated App evidence with the production wire decoder and a
//! read-only SQLite connection. It never sends input or creates protocol facts.
#[allow(
    dead_code,
    reason = "Import the complete production protocol for evidence decoding"
)]
#[path = "../src/terminal_command/protocol.rs"]
mod nip;

use rusqlite::{Connection, OpenFlags};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::error::Error;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::PathBuf;

type Result<T> = std::result::Result<T, Box<dyn Error>>;

fn append_frames(
    decoders: &mut HashMap<(String, String), nip::Decoder>,
    frames: &mut Vec<Value>,
    control: &str,
    direction: &str,
    bytes: &[u8],
    sequence: u64,
    returned: u64,
) -> Result<()> {
    let messages = decoders
        .entry((control.into(), direction.into()))
        .or_default()
        .push(bytes)
        .map_err(|error| format!("production decoder: {error:?}"))?;
    for (index, message) in messages.into_iter().enumerate() {
        frames.push(
            json!({"sequence":sequence,"ioReturnSequence":returned,"frameIndex":index,
            "controlId":control,"direction":direction,"message":message}),
        );
    }
    Ok(())
}

fn main() -> Result<()> {
    let arguments = std::env::args_os().skip(1).collect::<Vec<_>>();
    let expect_invalid_send = arguments.len() == 3
        && (arguments[2] == "--expect-invalid-startup-send"
            || arguments[2] == "--expect-invalid-prepare-send");
    if arguments.len() != 2 && !expect_invalid_send {
        return Err("expected actual trace file and actual journal database".into());
    }
    let trace = PathBuf::from(&arguments[0]);
    let database = PathBuf::from(&arguments[1]);
    for path in [&trace, &database] {
        let metadata = fs::symlink_metadata(path)?;
        if !metadata.is_file()
            || metadata.file_type().is_symlink()
            || metadata.len() > 64 * 1024 * 1024
        {
            return Err("evidence must be a bounded actual regular file".into());
        }
    }
    let before = fs::read(&database)?;
    let mut decoders = HashMap::new();
    let mut sends: HashMap<String, (u64, Vec<u8>)> = HashMap::new();
    let mut frames = Vec::new();
    let mut sent_decode_errors = Vec::new();
    let mut events = Vec::new();
    let mut pid = None;
    for (expected, line) in (1u64..).zip(BufReader::new(fs::File::open(&trace)?).lines()) {
        let event: Value = serde_json::from_str(&line?)?;
        let sequence = event["sequence"].as_u64().ok_or("missing trace sequence")?;
        if sequence != expected || event["version"] != 1 {
            return Err("trace sequence or version mismatch".into());
        }
        if let Some(previous) = pid {
            if event["pid"].as_u64() != Some(previous) {
                return Err("mixed process trace".into());
            }
        } else {
            pid = event["pid"].as_u64();
        }
        let details = &event["details"];
        let kind = event["event"].as_str().ok_or("missing trace event")?;
        match kind {
            "control-send-attempt" | "control-receive" => {
                let control = details["controlId"].as_str().ok_or("missing control id")?;
                let bytes = hex::decode(details["hex"].as_str().ok_or("missing raw wire bytes")?)?;
                if kind == "control-send-attempt" {
                    if sends.insert(control.into(), (sequence, bytes)).is_some() {
                        return Err("overlapping private writes".into());
                    }
                } else {
                    append_frames(
                        &mut decoders,
                        &mut frames,
                        control,
                        "received",
                        &bytes,
                        sequence,
                        sequence,
                    )?;
                }
            }
            "control-send-return" => {
                let control = details["controlId"].as_str().ok_or("missing control id")?;
                let (attempt, bytes) = sends
                    .remove(control)
                    .ok_or("write return without attempt")?;
                if details["ok"] != true || details["partialUnknown"] != false {
                    return Err("actual private write has unknown partial outcome; do not infer non-execution".into());
                }
                let decoded = append_frames(
                    &mut decoders,
                    &mut frames,
                    control,
                    "sent",
                    &bytes,
                    attempt,
                    sequence,
                );
                if let Err(error) = decoded {
                    if !expect_invalid_send {
                        return Err(error);
                    }
                    sent_decode_errors.push(json!({
                        "controlId":control,"stage":"push","sequence":attempt,"error":error.to_string()
                    }));
                }
            }
            _ => {}
        }
        events.push(event);
    }
    if !sends.is_empty() {
        return Err("unconfirmed actual private writes remain".into());
    }
    for ((control, direction), decoder) in &decoders {
        if let Err(error) = decoder.finish() {
            if !expect_invalid_send || direction != "sent" {
                return Err(format!("unfinished production frame: {error:?}").into());
            }
            sent_decode_errors.push(json!({
                "controlId":control,"stage":"eof","error":format!("{error:?}")
            }));
        }
    }
    if expect_invalid_send && sent_decode_errors.is_empty() {
        return Err("the explicitly malformed outbound bytes decoded without an error".into());
    }
    frames.sort_by_key(|frame| (frame["sequence"].as_u64(), frame["frameIndex"].as_u64()));
    let connection = Connection::open_with_flags(
        &database,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    let mut statement = connection.prepare(
        "SELECT call_key,agent_session_id,record_json,settled FROM submissions ORDER BY call_key",
    )?;
    let mut journal = Vec::new();
    for row in statement.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, i64>(3)?,
        ))
    })? {
        let (call_key, agent, encoded, settled) = row?;
        journal.push(json!({"callKey":call_key,"agentSessionId":agent,"record":serde_json::from_str::<Value>(&encoded)?,"settled":settled}));
    }
    drop(statement);
    drop(connection);
    if fs::read(&database)? != before {
        return Err("journal database changed during read-only audit".into());
    }
    let protocol =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src/terminal_command/protocol.rs");
    println!(
        "{}",
        serde_json::to_string(
            &json!({"pid":pid,"trace":trace,"traceSha256":hex::encode(Sha256::digest(fs::read(&trace)?)),
        "productionDecoder":protocol,"productionDecoderSha256":hex::encode(Sha256::digest(fs::read(&protocol)?)),
        "frames":frames,"events":events,"sentDecodeErrors":sent_decode_errors,"journal":journal,"database":database,"databaseSha256":hex::encode(Sha256::digest(before)),"databaseReadOnly":true,"appExecutionClaimed":false})
        )?
    );
    Ok(())
}

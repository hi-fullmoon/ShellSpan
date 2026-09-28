use super::*;
use serde_json::{json, Value};

#[test]
fn diagnostic_json_capture_redacts_escaped_credentials_before_snapshots() {
    // Use the same Python serializer as the collector, including ASCII escaping.
    // The input values exercise the parser/redaction boundary, not a substituted tool.
    for prefix in ["诊断", "quote\"", "slash\\", "line\n", ""] {
        let credential = format!("{prefix}{}", Uuid::new_v4().simple());
        let input = json!({"schemaVersion":1,"status":"ok","data":{
            "entries":[{"message":credential}], credential.clone(): "key evidence"
        }});
        let mut child = Command::new("python3")
            .args([
                "-I",
                "-c",
                "import json,sys; print(json.dumps(json.load(sys.stdin), ensure_ascii=True))",
            ])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(&serde_json::to_vec(&input).unwrap())
            .unwrap();
        let output = child.wait_with_output().unwrap();
        assert!(output.status.success());

        let (tx, _rx) = mpsc::channel();
        let mut process = ManagedProcessNative::new(
            "redaction".into(),
            "redaction".into(),
            "remote".into(),
            AgentExecutionChannelNative::Direct,
            vec![credential.clone()],
            tx,
        );
        Arc::get_mut(&mut process).unwrap().json_stdout = true;
        let split = output.stdout.len() / 2;
        process.push_output(ProcessOutputNative::Stdout(output.stdout[..split].to_vec()));
        assert!(
            process.snapshot().unwrap().stdout.is_empty(),
            "partial JSON must not be exposed"
        );
        process.push_output(ProcessOutputNative::Stdout(output.stdout[split..].to_vec()));
        process.finish(ProcessLifecycleNative::Exited, Some(0), true, None);
        for snapshot in [
            process.snapshot().unwrap(),
            process.wait(Duration::ZERO).unwrap(),
        ] {
            let value: Value = serde_json::from_str(&snapshot.stdout).unwrap();
            assert_eq!(value["schemaVersion"], 1);
            assert_eq!(value["status"], "ok");
            assert_eq!(value["data"]["entries"][0]["message"], "[REDACTED]");
            assert!(
                value["data"].get(&credential).is_none(),
                "credential-bearing keys must be redacted"
            );
            assert!(
                !snapshot.stdout.contains(&credential),
                "credential must never leave the capture buffer"
            );
        }
    }
}

#[test]
fn diagnostic_json_capture_preserves_numeric_fields_and_never_returns_invalid_json() {
    let mut buffer = CaptureBufferNative::new(1024);
    buffer.push(br#"{"schemaVersion":1,"data":{"message":"1"}}"#);
    let value: Value = serde_json::from_str(&buffer.json_text(&["1".into()])).unwrap();
    assert_eq!(value["schemaVersion"], 1);
    assert_eq!(value["data"]["message"], "[REDACTED]");
    let mut truncated = CaptureBufferNative::new(8);
    truncated.push(br#"{"message":"oversized"}"#);
    assert!(truncated.json_text(&[]).is_empty());
    let mut invalid = CaptureBufferNative::new(128);
    invalid.push(b"not a JSON document");
    assert!(invalid.json_text(&[]).is_empty());
}

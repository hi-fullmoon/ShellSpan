//! Scoped to installed arm64 debug acceptance bundles.
use super::*;
use std::fs;
use std::io::Read;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::time::{Duration, Instant};

pub(crate) const EXECUTOR: &str = "nonoMacAcceptance";
const LAUNCHER_SHA256: Option<&str> = option_env!("SHELLSPAN_MAC_SANDBOX_LAUNCHER_SHA256");

pub(crate) fn active() -> bool {
    automated() || preview_active()
}

pub(crate) fn automated() -> bool {
    std::env::var("SHELLSPAN_ACCEPTANCE_SUBMISSION_SCENARIO").as_deref()
        == Ok("local-sandbox-direct")
}

pub(crate) fn preview_active() -> bool {
    std::env::var("SHELLSPAN_ACCEPTANCE_SUBMISSION_SCENARIO").as_deref()
        == Ok("local-sandbox-preview")
}

#[derive(Debug, Clone)]
pub(super) struct Binding {
    pub(super) directory: PathBuf,
    pub(super) workspace: PathBuf,
    pub(super) launcher: PathBuf,
    pub(super) digest: String,
}

fn verify_launcher(path: &Path, expected: &str) -> Result<(), String> {
    let mut launcher = fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)
        .map_err(|error| error.to_string())?;
    if !launcher
        .metadata()
        .map_err(|error| error.to_string())?
        .is_file()
    {
        return Err("Expected a bundled sandbox launcher file".into());
    }
    let mut digest = Sha256::new();
    let mut buffer = [0; 64 * 1024];
    loop {
        let count = launcher
            .read(&mut buffer)
            .map_err(|error| error.to_string())?;
        if count == 0 {
            break;
        }
        digest.update(&buffer[..count]);
    }
    if hex::encode(digest.finalize()) != expected {
        return Err(
            "LOCAL_SANDBOX_LAUNCHER_CHANGED: bundled launcher failed its integrity check".into(),
        );
    }
    Ok(())
}

fn identity(path: &Path, directory: bool) -> Result<(u64, u64), String> {
    let stat = fs::symlink_metadata(path).map_err(|error| error.to_string())?;
    if (directory && !stat.is_dir()) || (!directory && !stat.is_file()) {
        return Err("Expected an owned acceptance directory or executable".into());
    }
    Ok((stat.dev(), stat.ino()))
}

impl Binding {
    fn current_digest(&self) -> Result<String, String> {
        let bytes = serde_json::to_vec(&(
            EXECUTOR,
            &self.workspace,
            identity(&self.workspace, true)?,
            &self.launcher,
            identity(&self.launcher, false)?,
            LAUNCHER_SHA256.ok_or("Missing bundled sandbox launcher checksum")?,
        ))
        .map_err(|error| error.to_string())?;
        Ok(hex::encode(Sha256::digest(bytes)))
    }

    pub(super) fn revalidate(&self) -> Result<(), String> {
        if self.current_digest()? != self.digest {
            return Err("Acceptance workspace or launcher changed before dispatch".into());
        }
        verify_launcher(
            &self.launcher,
            LAUNCHER_SHA256.ok_or("Missing bundled sandbox launcher checksum")?,
        )
    }

    pub(super) fn wait_for_gate_case(
        &self,
        command: &str,
        cancel: &CancellationToken,
    ) -> Result<(), String> {
        if !automated() || !command.starts_with("printf gate > gate-") {
            return Ok(());
        }
        let signals = self.directory.join("signals");
        fs::write(signals.join("approval-ready"), b"ready").map_err(|error| error.to_string())?;
        let deadline = Instant::now() + Duration::from_secs(20);
        while !signals.join("release").is_file() {
            if cancel.is_cancelled() || Instant::now() >= deadline {
                return Err("Acceptance dispatch barrier cancelled or timed out".into());
            }
            std::thread::sleep(Duration::from_millis(15));
        }
        Ok(())
    }

    pub(super) fn wait_for_launch_cancellation_case(
        &self,
        command: &str,
        cancel: &CancellationToken,
    ) -> Result<(), String> {
        if !automated() || !command.starts_with("printf entered > cancelled-") {
            return Ok(());
        }
        fs::write(self.directory.join("signals/launch-ready"), b"ready")
            .map_err(|error| error.to_string())?;
        let deadline = Instant::now() + Duration::from_secs(20);
        while !cancel.is_cancelled() {
            if Instant::now() >= deadline {
                return Err("Acceptance timed out waiting for launch cancellation".into());
            }
            std::thread::sleep(Duration::from_millis(15));
        }
        Ok(())
    }

    pub(super) fn hold_crash_cut(
        &self,
        command: &str,
        stage: &str,
        cancel: &CancellationToken,
    ) -> Result<(), String> {
        if !automated() || !command.starts_with(&format!("printf {stage} ")) {
            return Ok(());
        }
        let signal = self
            .directory
            .join("signals")
            .join(format!("crash-{stage}"));
        fs::write(signal, b"ready").map_err(|error| error.to_string())?;
        let deadline = Instant::now() + Duration::from_secs(20);
        while !cancel.is_cancelled() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(15));
        }
        Err("Acceptance crash cut ended without an application crash".into())
    }
}

fn guard_call(
    preview: bool,
    user_session_id: &str,
    call: &AgentToolCallNative,
) -> Result<bool, String> {
    if preview {
        if !matches!(call.target, AgentToolTargetNative::Local { .. }) {
            return Ok(false);
        }
        if call.tool_name != "exec_command"
            || call.arguments["background"] == serde_json::json!(true)
            || call.arguments["elevated"] == serde_json::json!(true)
        {
            return Err(
                "MAC_SANDBOX_PREVIEW_DIRECT_ONLY: use a foreground Direct command in the managed workspace"
                    .into(),
            );
        }
        return Ok(true);
    }
    if call.tool_name != "exec_command" || !user_session_id.starts_with("phase3-submission-") {
        return Ok(false);
    }
    if call.arguments["background"] == serde_json::json!(true) {
        return Err(
            "MAC_SANDBOX_PREVIEW_DIRECT_ONLY: use a foreground Direct command in the managed workspace"
                .into(),
        );
    }
    Ok(true)
}

pub(super) fn resolve(
    context: &NativeExecutionContext,
    call: &AgentToolCallNative,
) -> Result<Option<Binding>, String> {
    if !active() || !guard_call(preview_active(), &context.request.user_session_id, call)? {
        return Ok(None);
    }
    let directory = crate::commands::terminal_acceptance_directory()?;
    let workspace = directory.join("home");
    let AgentToolTargetNative::Local { cwd: Some(cwd), .. } = &call.target else {
        return Err("Acceptance requires an isolated local Direct target".into());
    };
    if Path::new(cwd) != workspace {
        return Err("Acceptance requires an isolated local Direct target".into());
    }
    let exe = std::env::current_exe().map_err(|error| error.to_string())?;
    let contents = exe
        .parent()
        .and_then(Path::parent)
        .ok_or("Acceptance bundle required")?;
    let launcher = contents.join("Resources/acceptance/nono-probe");
    let mut binding = Binding {
        directory,
        workspace,
        launcher,
        digest: String::new(),
    };
    binding.digest = binding.current_digest()?;
    Ok(Some(binding))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn launcher_integrity_rejects_changed_bytes_under_the_same_identity() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("launcher");
        fs::copy("/bin/sh", &path).unwrap();
        let original = identity(&path, false).unwrap();
        let checksum = hex::encode(Sha256::digest(fs::read(&path).unwrap()));
        verify_launcher(&path, &checksum).unwrap();

        fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap()
            .write_all(&[0])
            .unwrap();
        assert_eq!(identity(&path, false).unwrap(), original);
        assert!(verify_launcher(&path, &checksum)
            .unwrap_err()
            .contains("LOCAL_SANDBOX_LAUNCHER_CHANGED"));
    }

    #[test]
    fn preview_guard_rejects_non_foreground_direct_local_calls() {
        let mut call = AgentToolCallNative {
            request_id: "req-1".into(),
            call_id: "call-1".into(),
            tool_name: "read_file".into(),
            arguments: serde_json::json!({ "path": "notes.txt", "encoding": "utf8" }),
            target: AgentToolTargetNative::Local {
                target_id: "local-1".into(),
                session_id: "term-1".into(),
                cwd: Some("/tmp/workspace".into()),
            },
            capability_id: "cap-1".into(),
        };
        assert!(guard_call(true, "session-1", &call)
            .unwrap_err()
            .starts_with("MAC_SANDBOX_PREVIEW_DIRECT_ONLY"));

        call.tool_name = "exec_command".into();
        call.arguments = serde_json::json!({ "command": "pwd", "background": true });
        assert!(guard_call(true, "session-1", &call)
            .unwrap_err()
            .starts_with("MAC_SANDBOX_PREVIEW_DIRECT_ONLY"));

        call.arguments = serde_json::json!({ "command": "pwd", "elevated": true });
        assert!(guard_call(true, "session-1", &call)
            .unwrap_err()
            .starts_with("MAC_SANDBOX_PREVIEW_DIRECT_ONLY"));

        call.arguments = serde_json::json!({ "command": "pwd" });
        assert!(guard_call(true, "session-1", &call).unwrap());
    }
}

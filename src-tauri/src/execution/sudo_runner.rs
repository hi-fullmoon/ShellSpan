use std::io::{ErrorKind, Read, Write};
use std::path::Path;
use std::time::{Duration, Instant};

use base64::{engine::general_purpose::STANDARD_NO_PAD, Engine};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use tokio_util::sync::CancellationToken;
use zeroize::Zeroizing;

use crate::models::JumpHostConfig;
use crate::sudo_policy::SudoRunner;

const MAX_FRAME: usize = 512 * 1024;
const POLL: Duration = Duration::from_millis(25);

#[derive(Debug, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum Reply {
    Ready {
        receipt: String,
    },
    Completed {
        receipt: String,
        exit_code: i32,
        stdout: String,
        stderr: String,
        truncated: bool,
    },
    Rejected {
        message: String,
    },
}

#[derive(Debug)]
pub(crate) enum RunnerOutcome {
    Completed {
        exit_code: i32,
        stdout: String,
        stderr: String,
        truncated: bool,
    },
    NotStarted(String),
    Cancelled,
    Uncertain,
}

pub(crate) fn execute_restricted_sudo(
    host: &str,
    runner: &SudoRunner,
    jump: Option<(&JumpHostConfig, &Path)>,
    operation: &str,
    command: &str,
    cancellation: &CancellationToken,
    deadline: Instant,
    mut request_password: impl FnMut() -> Result<Option<Zeroizing<String>>, String>,
    mut authorized_write: impl FnMut(
        &mut ssh2::Channel,
        &[u8],
    ) -> Result<std::io::Result<usize>, String>,
) -> RunnerOutcome {
    let mut attempted_dispatch = false;
    let result = (|| -> Result<RunnerOutcome, String> {
        check_liveness(cancellation, deadline)?;
        crate::connection::validate_connection_fields(host, &runner.username)?;
        let token = cancellation.clone();
        let _connection = crate::connection::terminal_deadline::TerminalConnectionGuard::new(
            deadline,
            move || token.is_cancelled(),
        );
        let (_jump_session, tcp) = if let Some((jump, known_hosts)) = jump {
            crate::connection::validate_connection_fields(&jump.host, &jump.username)?;
            let (jump_session, stream) = crate::connection::connect_jump_tcp_stream(
                jump,
                host,
                runner.port,
                Some(known_hosts),
            )
            .map_err(|error| match error {
                crate::models::ConnectionError::HostKeyUnknown { .. }
                | crate::models::ConnectionError::HostKeyMismatch { .. } => {
                    "The configured jump host key is not trusted for the restricted runner"
                }
                _ => "Could not reach the restricted SSH runner through the configured jump host",
            })?;
            (Some(jump_session), stream)
        } else {
            let stream = crate::connection::connect_tcp_stream(host, runner.port)
                .map_err(|_| "Could not reach the restricted SSH runner")?;
            (None, stream)
        };
        let session = crate::connection::open_handshaken_session(tcp, host, runner.port)
            .map_err(|_| "Restricted runner SSH handshake failed")?;
        session.set_timeout(5_000);
        let host_key = session
            .host_key()
            .ok_or("The restricted runner did not supply a host key")?
            .0;
        let fingerprint = format!(
            "SHA256:{}",
            STANDARD_NO_PAD.encode(Sha256::digest(host_key))
        );
        if fingerprint != runner.host_key_sha256 {
            return Err(
                "The restricted runner host key does not match the saved fingerprint".into(),
            );
        }
        let authentication = session
            .auth_methods(&runner.username)
            .map_err(|_| "Could not determine restricted runner authentication")?;
        if !authentication.split(',').any(|method| method == "password") {
            return Err(
                "The restricted SSH runner must require its dedicated account password".into(),
            );
        }
        check_liveness(cancellation, deadline)?;
        let Some(password) = request_password()? else {
            return Ok(RunnerOutcome::Cancelled);
        };
        check_liveness(cancellation, deadline)?;
        session
            .userauth_password(&runner.username, &password)
            .map_err(|_| "Restricted runner credentials were rejected")?;
        let secrets = Zeroizing::new(vec![password.to_string()]);
        drop(password);
        let mut channel = session
            .channel_session()
            .map_err(|_| "Could not open a restricted runner channel")?;
        channel
            .subsystem("shellspan-sudo-v1")
            .map_err(|_| "The restricted SSH runner subsystem is unavailable")?;
        session.set_blocking(false);
        let argv = shlex::split(command).ok_or("Invalid configured runner executable")?;
        let mut prepare = serde_json::to_vec(
            &serde_json::json!({ "type": "prepare", "operation": operation, "argv": argv }),
        )
        .map_err(|_| "Invalid configured runner request")?;
        prepare.push(b'\n');
        write_frame(
            &mut channel,
            &prepare,
            cancellation,
            deadline,
            |channel, bytes| Ok(channel.write(bytes)),
        )?;
        let mut incoming = Vec::new();
        let receipt = match read_reply(&mut channel, &mut incoming, cancellation, deadline)? {
            Reply::Ready { receipt } if uuid::Uuid::parse_str(&receipt).is_ok() => receipt,
            Reply::Rejected { message } => {
                return Ok(RunnerOutcome::NotStarted(super::redact_known_secrets(
                    &message, &secrets,
                )))
            }
            _ => return Err("The SSH subsystem is not a compatible restricted runner".into()),
        };
        let mut dispatch =
            serde_json::to_vec(&serde_json::json!({ "type":"dispatch", "receipt":receipt }))
                .map_err(|_| "Could not encode the restricted runner dispatch")?;
        dispatch.push(b'\n');
        write_frame(
            &mut channel,
            &dispatch,
            cancellation,
            deadline,
            |channel, bytes| {
                let result = authorized_write(channel, bytes)?;
                // A write attempt can reach the transport before an error is
                // reported. Keep the outcome unresolved without a runner receipt.
                attempted_dispatch = true;
                Ok(result)
            },
        )?;
        match read_reply(&mut channel, &mut incoming, cancellation, deadline)? {
            Reply::Completed {
                receipt: returned,
                exit_code,
                stdout,
                stderr,
                truncated,
            } if returned == receipt && (0..=255).contains(&exit_code) => {
                Ok(RunnerOutcome::Completed {
                    exit_code,
                    truncated,
                    stdout: super::redact_known_secrets(&stdout, &secrets),
                    stderr: super::redact_known_secrets(&stderr, &secrets),
                })
            }
            Reply::Rejected { message } => Ok(RunnerOutcome::NotStarted(
                super::redact_known_secrets(&message, &secrets),
            )),
            _ => Err("The restricted runner result could not be confirmed".into()),
        }
    })();
    match result {
        Ok(outcome) => outcome,
        Err(_) if attempted_dispatch => RunnerOutcome::Uncertain,
        Err(_) if cancellation.is_cancelled() => RunnerOutcome::Cancelled,
        Err(message) => RunnerOutcome::NotStarted(message),
    }
}

fn check_liveness(cancellation: &CancellationToken, deadline: Instant) -> Result<(), String> {
    if cancellation.is_cancelled() || Instant::now() >= deadline {
        Err("Restricted runner request was cancelled or timed out".into())
    } else {
        Ok(())
    }
}

fn write_frame(
    channel: &mut ssh2::Channel,
    mut frame: &[u8],
    cancellation: &CancellationToken,
    deadline: Instant,
    mut write: impl FnMut(&mut ssh2::Channel, &[u8]) -> Result<std::io::Result<usize>, String>,
) -> Result<(), String> {
    while !frame.is_empty() {
        check_liveness(cancellation, deadline)?;
        match write(channel, frame)? {
            Ok(sent) if sent > 0 => frame = &frame[sent..],
            Err(error) if error.kind() == ErrorKind::WouldBlock => std::thread::sleep(POLL),
            _ => return Err("Restricted runner transport write failed".into()),
        }
    }
    Ok(())
}

fn read_reply(
    channel: &mut ssh2::Channel,
    frame: &mut Vec<u8>,
    cancellation: &CancellationToken,
    deadline: Instant,
) -> Result<Reply, String> {
    let mut chunk = [0; 4096];
    loop {
        check_liveness(cancellation, deadline)?;
        match channel.read(&mut chunk) {
            Ok(0) => return Err("Restricted runner closed without a complete reply".into()),
            Ok(size) if frame.len() + size <= MAX_FRAME => {
                if let Some(end) = chunk[..size].iter().position(|b| *b == b'\n') {
                    if end + 1 != size {
                        return Err("Restricted runner sent unsolicited data".into());
                    }
                    frame.extend_from_slice(&chunk[..end]);
                    let reply = serde_json::from_slice(frame)
                        .map_err(|_| "Invalid restricted runner reply".to_string());
                    frame.clear();
                    return reply;
                }
                frame.extend_from_slice(&chunk[..size]);
            }
            Err(error) if error.kind() == ErrorKind::WouldBlock => std::thread::sleep(POLL),
            _ => return Err("Restricted runner result exceeded limits or disconnected".into()),
        }
    }
}

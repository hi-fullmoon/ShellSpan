//! Local Engine infrastructure. It is not an approved workspace sandbox.
//! Launch/control is review-gated until identity and safe project sync exist.

use std::collections::HashMap;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use bollard::container::{AttachContainerResults, LogOutput};
use bollard::models::{ContainerCreateBody, HostConfig, HostConfigLogConfig};
use bollard::query_parameters::{AttachContainerOptions, CreateContainerOptions};
use bollard::{Docker, API_DEFAULT_VERSION};
use futures_util::StreamExt;
use serde::Serialize;
use tokio::io::{AsyncWrite, AsyncWriteExt};
use tokio::sync::watch;
use tokio_util::sync::CancellationToken;

use super::container_ownership::{ContainerIntent, ContainerJournal};
use super::process::{CaptureBufferNative, ProcessLifecycleNative};
use crate::agent_runtime::{
    AgentExecutionAdmission, AgentExecutionFailure, AgentExecutionFailureKind,
};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LocalContainerBackendProbe {
    pub(crate) infrastructure_available: bool,
    pub(crate) execution_os: Option<String>,
    pub(crate) execution_arch: Option<String>,
    pub(crate) backend_version: Option<String>,
    pub(crate) workspace_verified: bool,
    pub(crate) admission_enabled: bool,
    pub(crate) failure: Option<AgentExecutionFailure>,
}

fn failure(
    kind: AgentExecutionFailureKind,
    code: &str,
    admission: AgentExecutionAdmission,
) -> AgentExecutionFailure {
    AgentExecutionFailure::new(kind, code, admission)
}

pub(crate) async fn probe_local_container_backend() -> LocalContainerBackendProbe {
    // Never consume DOCKER_HOST, SSH contexts or arbitrary renderer endpoints.
    let socket = if cfg!(windows) {
        "//./pipe/docker_engine"
    } else {
        "/var/run/docker.sock"
    };
    let result = match Docker::connect_with_local(socket, 3, API_DEFAULT_VERSION) {
        Ok(docker) => probe(&docker).await,
        Err(_) => Err(failure(
            AgentExecutionFailureKind::BackendUnavailable,
            "localEngineUnavailable",
            AgentExecutionAdmission::NotStarted,
        )),
    };
    match result {
        Ok((os, arch, version)) => LocalContainerBackendProbe {
            infrastructure_available: os == "linux",
            failure: if os == "linux" {
                None
            } else {
                Some(failure(
                    AgentExecutionFailureKind::BackendUnavailable,
                    "linuxEngineRequired",
                    AgentExecutionAdmission::NotStarted,
                ))
            },
            execution_os: Some(os),
            execution_arch: Some(arch),
            backend_version: Some(version),
            workspace_verified: false,
            admission_enabled: false,
        },
        Err(error) => LocalContainerBackendProbe {
            infrastructure_available: false,
            execution_os: None,
            execution_arch: None,
            backend_version: None,
            workspace_verified: false,
            admission_enabled: false,
            failure: Some(error),
        },
    }
}

async fn probe(docker: &Docker) -> Result<(String, String, String), AgentExecutionFailure> {
    let info = docker.info().await.map_err(|_| {
        failure(
            AgentExecutionFailureKind::BackendUnavailable,
            "localEngineUnavailable",
            AgentExecutionAdmission::NotStarted,
        )
    })?;
    Ok((
        info.os_type.unwrap_or_default(),
        info.architecture.unwrap_or_default(),
        info.server_version.unwrap_or_default(),
    ))
}

// These are implemented lifecycle primitives, not an enabled Agent mode. The
// production probe above is exposed; launches remain behind phase-2 review.
pub(super) struct LocalContainerProcess {
    docker: Docker,
    id: String,
    input: tokio::sync::Mutex<Option<Pin<Box<dyn AsyncWrite + Send>>>>,
    state: Mutex<ContainerState>,
    lifecycle: watch::Sender<ProcessLifecycleNative>,
    stop: CancellationToken,
    controller_failed: AtomicBool,
    journal: Arc<ContainerJournal>,
    intent: ContainerIntent,
}

struct ContainerState {
    lifecycle: ProcessLifecycleNative,
    exit_code: Option<i64>,
    stdout: CaptureBufferNative,
    stderr: CaptureBufferNative,
    termination_confirmed: bool,
    failure: Option<AgentExecutionFailure>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct LocalContainerProcessSnapshot {
    pub(super) lifecycle: ProcessLifecycleNative,
    pub(super) exit_code: Option<i64>,
    pub(super) stdout: String,
    pub(super) stderr: String,
    pub(super) truncated: bool,
    pub(super) termination_confirmed: bool,
    pub(super) failure: Option<AgentExecutionFailure>,
}

impl LocalContainerProcess {
    /// Internal infrastructure only: immutable local image, no host files,
    /// credentials, arbitrary Docker options, download, or environment input.
    pub(super) async fn start(
        journal: Arc<ContainerJournal>,
        header: crate::agent_runtime::AgentSessionHeader,
        docker: Docker,
        image_id: &str,
        command: &str,
        timeout: Duration,
        startup_timeout: Duration,
        cancellation: CancellationToken,
    ) -> Result<Arc<Self>, AgentExecutionFailure> {
        let pending = cancellation.child_token();
        let guard = pending.clone().drop_guard();
        let (sender, receiver) = tokio::sync::oneshot::channel();
        let image = image_id.to_owned();
        let command = command.to_owned();
        let owned_pending = pending.clone();
        let shutdown = journal.closing.clone();
        // Detached custody owner survives cancellation of the caller's future.
        // Engine calls remain bounded; their outcome is sealed before cleanup.
        tokio::spawn(async move {
            let result = Self::start_transaction(
                journal,
                header,
                docker,
                &image,
                &command,
                timeout,
                owned_pending,
            )
            .await;
            if let Err(Ok(process)) = sender.send(result) {
                let _ = process.stop(Duration::from_secs(10)).await;
            }
        });
        let result = tokio::select! {
            result = receiver => result.unwrap_or_else(|_| Err(failure(AgentExecutionFailureKind::TerminationUnconfirmed, "containerStartupOwnerUnavailable", AgentExecutionAdmission::Unknown))),
            _ = tokio::time::sleep(startup_timeout) => { pending.cancel(); Err(failure(AgentExecutionFailureKind::TimedOut, "containerStartupDeadlineExceeded", AgentExecutionAdmission::Unknown)) },
            _ = cancellation.cancelled() => { pending.cancel(); Err(failure(AgentExecutionFailureKind::Cancelled, "containerStartupCancelled", AgentExecutionAdmission::Unknown)) },
            _ = shutdown.cancelled() => { pending.cancel(); Err(failure(AgentExecutionFailureKind::Cancelled, "containerApplicationClosing", AgentExecutionAdmission::Unknown)) },
        };
        if result.is_ok() {
            guard.disarm();
        }
        result
    }

    async fn start_transaction(
        journal: Arc<ContainerJournal>,
        header: crate::agent_runtime::AgentSessionHeader,
        docker: Docker,
        image_id: &str,
        command: &str,
        timeout: Duration,
        cancellation: CancellationToken,
    ) -> Result<Arc<Self>, AgentExecutionFailure> {
        if cancellation.is_cancelled() {
            return Err(failure(
                AgentExecutionFailureKind::Cancelled,
                "containerStartupCancelled",
                AgentExecutionAdmission::NotStarted,
            ));
        }
        if image_id.len() != 71
            || !image_id.starts_with("sha256:")
            || !image_id[7..].bytes().all(|byte| byte.is_ascii_hexdigit())
            || timeout.is_zero()
            || timeout > Duration::from_secs(86_400)
        {
            return Err(failure(
                AgentExecutionFailureKind::PolicyRejected,
                "invalidContainerExecutionInput",
                AgentExecutionAdmission::NotStarted,
            ));
        }
        let (os, _, _) = probe(&docker).await?;
        if os != "linux" {
            return Err(failure(
                AgentExecutionFailureKind::BackendUnavailable,
                "linuxEngineRequired",
                AgentExecutionAdmission::NotStarted,
            ));
        }
        let image = docker.inspect_image(image_id).await.map_err(|_| {
            failure(
                AgentExecutionFailureKind::BackendUnavailable,
                "localImageUnavailable",
                AgentExecutionAdmission::NotStarted,
            )
        })?;
        if image.config.as_ref().is_some_and(|config| {
            config
                .volumes
                .as_ref()
                .is_some_and(|volumes| !volumes.is_empty())
        }) {
            return Err(failure(
                AgentExecutionFailureKind::PolicyRejected,
                "imageDeclaresUnapprovedVolumes",
                AgentExecutionAdmission::NotStarted,
            ));
        }
        let intent = journal
            .reserve(&docker, &header, image_id, command)
            .await
            .map_err(|_| {
                failure(
                    AgentExecutionFailureKind::InfrastructureFailure,
                    "containerCustodyUnavailable",
                    AgentExecutionAdmission::NotStarted,
                )
            })?;
        let config = ContainerCreateBody {
            labels: Some(journal.labels(&intent)),
            image: Some(image_id.into()),
            user: Some("1000:1000".into()),
            entrypoint: Some(vec!["/usr/bin/env".into()]),
            cmd: Some(
                [
                    "-i",
                    "PATH=/usr/local/bin:/usr/bin:/bin",
                    "HOME=/tmp/home",
                    "TMPDIR=/tmp",
                    "XDG_CACHE_HOME=/cache",
                    "CARGO_HOME=/cache/cargo",
                    "PNPM_HOME=/cache/pnpm",
                    "/bin/sh",
                    "-c",
                    command,
                ]
                .into_iter()
                .map(str::to_owned)
                .collect(),
            ),
            working_dir: Some("/workspace".into()),
            open_stdin: Some(true),
            stdin_once: Some(true),
            attach_stdin: Some(true),
            attach_stdout: Some(true),
            attach_stderr: Some(true),
            tty: Some(false),
            host_config: Some(HostConfig {
                network_mode: Some("none".into()),
                readonly_rootfs: Some(true),
                cap_drop: Some(vec!["ALL".into()]),
                security_opt: Some(vec!["no-new-privileges:true".into()]),
                pids_limit: Some(128),
                ipc_mode: Some("private".into()),
                tmpfs: Some(HashMap::from([
                    (
                        "/workspace".into(),
                        "rw,exec,nosuid,nodev,uid=1000,gid=1000,mode=0700".into(),
                    ),
                    (
                        "/tmp".into(),
                        "rw,exec,nosuid,nodev,uid=1000,gid=1000,mode=0700".into(),
                    ),
                    (
                        "/cache".into(),
                        "rw,noexec,nosuid,nodev,uid=1000,gid=1000,mode=0700".into(),
                    ),
                ])),
                log_config: Some(HostConfigLogConfig {
                    typ: Some("none".into()),
                    ..Default::default()
                }),
                ..Default::default()
            }),
            ..Default::default()
        };
        if cancellation.is_cancelled() {
            let _ = journal.clean(&docker, &intent).await;
            return Err(failure(
                AgentExecutionFailureKind::Cancelled,
                "containerStartupCancelled",
                AgentExecutionAdmission::NotStarted,
            ));
        }
        journal.sent(&intent).await.map_err(|_| {
            failure(
                AgentExecutionFailureKind::InfrastructureFailure,
                "containerCustodyUnavailable",
                AgentExecutionAdmission::NotStarted,
            )
        })?;
        let created = match docker
            .create_container(
                Some(CreateContainerOptions {
                    name: Some(intent.name.clone()),
                    ..Default::default()
                }),
                config,
            )
            .await
        {
            Ok(created) => created,
            Err(_) => {
                let confirmed = journal.clean(&docker, &intent).await.is_ok();
                return Err(failure(
                    if confirmed {
                        AgentExecutionFailureKind::InfrastructureFailure
                    } else {
                        AgentExecutionFailureKind::TerminationUnconfirmed
                    },
                    "containerCreateFailed",
                    AgentExecutionAdmission::Unknown,
                ));
            }
        };
        let id = created.id;
        if journal.receipt(&intent, &id).await.is_err() || cancellation.is_cancelled() {
            let confirmed = journal.clean(&docker, &intent).await.is_ok();
            return Err(failure(
                if confirmed {
                    AgentExecutionFailureKind::Cancelled
                } else {
                    AgentExecutionFailureKind::TerminationUnconfirmed
                },
                "containerStartupCancelled",
                AgentExecutionAdmission::Unknown,
            ));
        }
        let attach = docker
            .attach_container(
                &id,
                Some(AttachContainerOptions {
                    stream: true,
                    stdin: true,
                    stdout: true,
                    stderr: true,
                    ..Default::default()
                }),
            )
            .await;
        let startup = match attach {
            Ok(attach) if !cancellation.is_cancelled() => {
                match docker.start_container(&id, None).await {
                    Ok(()) => Ok(attach),
                    Err(_) => Err(()),
                }
            }
            _ => Err(()),
        };
        let AttachContainerResults { input, mut output } = match startup {
            Ok(attach) => attach,
            Err(()) => {
                let removed = journal.clean(&docker, &intent).await.is_ok();
                return Err(failure(
                    if removed {
                        AgentExecutionFailureKind::InfrastructureFailure
                    } else {
                        AgentExecutionFailureKind::TerminationUnconfirmed
                    },
                    "containerStartupFailed",
                    AgentExecutionAdmission::Unknown,
                ));
            }
        };
        let (lifecycle, _) = watch::channel(ProcessLifecycleNative::Running);
        let process = Arc::new(Self {
            docker,
            id,
            input: tokio::sync::Mutex::new(Some(input)),
            lifecycle,
            state: Mutex::new(ContainerState {
                lifecycle: ProcessLifecycleNative::Running,
                exit_code: None,
                stdout: CaptureBufferNative::new(768 * 1024),
                stderr: CaptureBufferNative::new(256 * 1024),
                termination_confirmed: false,
                failure: None,
            }),
            stop: CancellationToken::new(),
            controller_failed: AtomicBool::new(false),
            journal,
            intent,
        });
        let reader = Arc::clone(&process);
        let output_task = tokio::spawn(async move {
            while let Some(chunk) = output.next().await {
                let chunk = match chunk {
                    Ok(chunk) => chunk,
                    Err(_) => {
                        reader.controller_failed.store(true, Ordering::Release);
                        reader.stop.cancel();
                        return Err(());
                    }
                };
                let mut state = reader.state.lock().map_err(|_| ())?;
                match chunk {
                    LogOutput::StdOut { message } => state.stdout.push(&message),
                    LogOutput::StdErr { message } => state.stderr.push(&message),
                    _ => {}
                }
            }
            Ok::<(), ()>(())
        });
        let worker = Arc::clone(&process);
        if cancellation.is_cancelled() {
            process.stop.cancel();
        }
        tokio::spawn(async move { worker.run(timeout, output_task).await });
        Ok(process)
    }

    pub(super) fn snapshot(&self) -> LocalContainerProcessSnapshot {
        let state = self.state.lock().expect("container state lock");
        LocalContainerProcessSnapshot {
            lifecycle: state.lifecycle,
            exit_code: state.exit_code,
            stdout: crate::redaction::redact_sensitive_text(&state.stdout.text(&[])),
            stderr: crate::redaction::redact_sensitive_text(&state.stderr.text(&[])),
            truncated: state.stdout.truncated() || state.stderr.truncated(),
            termination_confirmed: state.termination_confirmed,
            failure: state.failure.clone(),
        }
    }

    pub(super) async fn wait(&self, timeout: Duration) -> LocalContainerProcessSnapshot {
        let mut state = self.lifecycle.subscribe();
        let _ = tokio::time::timeout(timeout, state.wait_for(|state| state.is_terminal())).await;
        self.snapshot()
    }

    pub(super) async fn write_stdin(
        &self,
        bytes: &[u8],
        close: bool,
    ) -> Result<usize, AgentExecutionFailure> {
        if self.snapshot().lifecycle.is_terminal() || bytes.len() > 1_048_576 {
            return Err(failure(
                AgentExecutionFailureKind::PolicyRejected,
                "containerStdinUnavailable",
                AgentExecutionAdmission::Started,
            ));
        }
        let write = async {
            let mut input = self.input.lock().await;
            let writer = input.as_mut().ok_or(())?;
            writer.write_all(bytes).await.map_err(|_| ())?;
            writer.flush().await.map_err(|_| ())?;
            if close {
                writer.shutdown().await.map_err(|_| ())?;
                input.take();
            }
            Ok::<usize, ()>(bytes.len())
        };
        match tokio::time::timeout(Duration::from_secs(3), write).await {
            Ok(Ok(count)) => Ok(count),
            _ => {
                self.controller_failed.store(true, Ordering::Release);
                self.stop.cancel();
                Err(failure(
                    AgentExecutionFailureKind::InfrastructureFailure,
                    "containerStdinFailedStopRequested",
                    AgentExecutionAdmission::Started,
                ))
            }
        }
    }

    pub(super) async fn stop(&self, timeout: Duration) -> LocalContainerProcessSnapshot {
        self.stop.cancel();
        self.wait(timeout).await
    }

    async fn run(
        self: Arc<Self>,
        timeout: Duration,
        mut output: tokio::task::JoinHandle<Result<(), ()>>,
    ) {
        let deadline = tokio::time::sleep(timeout);
        tokio::pin!(deadline);
        let mut poll = tokio::time::interval(Duration::from_millis(50));
        let shutdown = self.journal.closing.clone();
        let terminal = loop {
            tokio::select! {
                _ = self.stop.cancelled() => break if self.controller_failed.load(Ordering::Acquire) {
                    ProcessLifecycleNative::Failed
                } else {
                    ProcessLifecycleNative::Cancelled
                },
                _ = &mut deadline => break ProcessLifecycleNative::TimedOut,
                _ = shutdown.cancelled() => break ProcessLifecycleNative::Cancelled,
                _ = poll.tick() => {
                    match self.docker.inspect_container(&self.id, None).await {
                        Ok(info) if info.state.as_ref().and_then(|state| state.running) == Some(false) => break ProcessLifecycleNative::Exited,
                        Ok(_) => {},
                        Err(_) => break ProcessLifecycleNative::Failed,
                    }
                }
            }
        };
        let observed = self
            .docker
            .inspect_container(&self.id, None)
            .await
            .ok()
            .and_then(|info| info.state);
        let confirmed = self.journal.clean(&self.docker, &self.intent).await.is_ok();
        let exit_code = observed.and_then(|state| state.exit_code);
        let streams_ok = matches!(
            tokio::time::timeout(Duration::from_secs(1), &mut output).await,
            Ok(Ok(Ok(())))
        );
        output.abort();
        let removed = confirmed;
        let kind = if !confirmed || !removed {
            Some(AgentExecutionFailureKind::TerminationUnconfirmed)
        } else if terminal == ProcessLifecycleNative::Failed || !streams_ok {
            Some(AgentExecutionFailureKind::InfrastructureFailure)
        } else if terminal == ProcessLifecycleNative::TimedOut {
            Some(AgentExecutionFailureKind::TimedOut)
        } else if terminal == ProcessLifecycleNative::Cancelled {
            Some(AgentExecutionFailureKind::Cancelled)
        } else if exit_code != Some(0) {
            Some(AgentExecutionFailureKind::CommandFailed)
        } else {
            None
        };
        {
            let mut state = self.state.lock().expect("container state lock");
            state.lifecycle = if !confirmed || !removed {
                ProcessLifecycleNative::Failed
            } else {
                terminal
            };
            state.exit_code = exit_code;
            state.termination_confirmed = confirmed && removed;
            state.failure = kind.map(|kind| {
                failure(
                    kind,
                    "containerExecutionFinished",
                    AgentExecutionAdmission::Started,
                )
            });
            self.lifecycle.send_replace(state.lifecycle);
        }
    }
}

#[cfg(test)]
#[path = "../tests/container_backend.rs"]
mod tests;

#[cfg(debug_assertions)]
pub(crate) async fn prepare_gui_resource(
    root: std::path::PathBuf,
    image: String,
    debt: bool,
) -> Result<serde_json::Value, String> {
    let input_root = root.clone();
    let (journal, header) = tokio::task::spawn_blocking(move || {
        let credentials = crate::keychain::CredentialManager::isolated_native_for_checks();
        let journal = ContainerJournal::open(&input_root, &credentials, true)?.ok_or("GUI custody unavailable")?;
        let runtime = crate::agent_runtime::AgentRuntimeBuilder::new().build();
        runtime.configure(input_root.clone())?;
        let request = serde_json::from_value(serde_json::json!({
            "sessionId": uuid::Uuid::new_v4().to_string(), "taskId":"gui-acceptance",
            "goal":"Normal GUI lifecycle acceptance", "sandboxPolicy":"host", "executionSurface":"direct",
            "target":{"kind":"local", "targetId":"local", "sessionId":"fixture", "cwd":input_root.to_str()}
        })).map_err(|_| "GUI binding invalid")?;
        let header = runtime.create_session(request)?.header;
        Ok::<_,String>((journal, header))
    }).await.map_err(|_| "GUI fixture worker unavailable")??;
    let docker = Docker::connect_with_local("/var/run/docker.sock", 3, API_DEFAULT_VERSION)
        .map_err(|_| "GUI fixture Engine unavailable")?;
    if debt {
        let intent = journal
            .reserve(&docker, &header, &image, "sleep 30")
            .await?;
        journal.sent(&intent).await?;
        // Stop at the actual durable prepare-to-send point; no create request.
        Ok(serde_json::json!({"kind":"debt", "pending":journal.pending_count()}))
    } else {
        let process = LocalContainerProcess::start(
            journal.clone(),
            header,
            docker,
            &image,
            "sleep 30",
            Duration::from_secs(45),
            Duration::from_secs(5),
            CancellationToken::new(),
        )
        .await
        .map_err(|_| "GUI fixture process unavailable")?;
        Ok(
            serde_json::json!({"kind":"active", "containerId":process.id, "pending":journal.pending_count()}),
        )
    }
}

#[cfg(debug_assertions)]
pub(crate) fn gui_custody_status(
    root: &std::path::Path,
    remove_key: bool,
) -> Result<usize, String> {
    let credentials = crate::keychain::CredentialManager::isolated_native_for_checks();
    let Some(journal) = ContainerJournal::open(root, &credentials, false)? else {
        return Ok(0);
    };
    let pending = journal.pending_count();
    if remove_key && pending == 0 {
        journal.destroy_test_key(&credentials);
    }
    Ok(pending)
}

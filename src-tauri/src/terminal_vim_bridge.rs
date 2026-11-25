//! A connection-scoped Vim/Neovim channel. The SSH worker owns both the PTY
//! and this channel, including the libssh2 write retry ordering.
use std::{
    io::{ErrorKind, Read, Write},
    path::Path,
    sync::{
        atomic::{AtomicBool, AtomicU8, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};

use bytes::BytesMut;
use crossbeam_channel::{bounded, Receiver, RecvTimeoutError, Sender, TrySendError};
use serde::{Deserialize, Serialize};
use ssh2::{Channel, OpenFlags, OpenType, Session};
use tokio_util::{
    codec::{Decoder, LinesCodec},
    sync::CancellationToken,
};
use uuid::Uuid;

use crate::terminal_integration::quote_remote_posix;

pub(crate) const ACTIVATE: &str = ":source $SHELLSPAN_VIM_BRIDGE";
pub(crate) const INSPECT: &str = "inspect_vim_buffer";
pub(crate) const INSERT: &str = "insert_vim_text";
pub(crate) const SAVE: &str = "save_vim_buffer";
pub(crate) const CLOSE: &str = "close_vim_editor";
pub(crate) const MAX_TEXT_BYTES: usize = 32 * 1024;
const MAX_FRAME_BYTES: usize = 256 * 1024;
const EXCHANGE_TIMEOUT: Duration = Duration::from_secs(4);
const WAIT_SLICE: Duration = Duration::from_millis(25);
const QUEUED: u8 = 0;
const ATTEMPTED: u8 = 1;
const REVOKED: u8 = 2;

#[derive(Clone, Copy, Debug)]
pub(crate) struct VimBridgeShellConfig<'a> {
    pub(crate) source_path: &'a str,
    pub(crate) auto_attach: bool,
}

/// Optional session-scoped Bash/Zsh wrappers that attach the SSH Vim/Neovim
/// bridge only when `SHELLSPAN_VIM_BRIDGE_AUTO=1`, stdio is a TTY, no user
/// alias or function overrides `vim`/`nvim`, and no clean/non-interactive flags
/// are passed. Never modifies remote config files.
pub(crate) const SHELL_AUTO_ATTACH_SNIPPET: &str = r#"__shellspan_vim_should_attach() {
  [ "${SHELLSPAN_VIM_BRIDGE_AUTO:-}" = "1" ] || return 1
  [ -n "${SHELLSPAN_VIM_BRIDGE:-}" ] && [ -r "$SHELLSPAN_VIM_BRIDGE" ] || return 1
  [ -t 0 ] && [ -t 1 ] || return 1
  local __ss_arg
  for __ss_arg in "$@"; do
    case "$__ss_arg" in
      --) break ;;
      -|-[hveEsSrLb]|-es|-u|-u*|-U|-U*|-Nu|-Nu*|-S|-S*|-s|-s*|--help|--version|--clean|--headless|--embed)
        return 1 ;;
    esac
  done
  return 0
}
__shellspan_install_vim_wrappers() {
  [ "${SHELLSPAN_VIM_BRIDGE_AUTO:-}" = "1" ] || return 0
  if ! alias vim >/dev/null 2>&1 && ! typeset -f vim >/dev/null 2>&1; then
    vim() {
      if __shellspan_vim_should_attach "$@"; then
        command vim -S "$SHELLSPAN_VIM_BRIDGE" "$@"
      else
        command vim "$@"
      fi
    }
  fi
  if ! alias nvim >/dev/null 2>&1 && ! typeset -f nvim >/dev/null 2>&1; then
    nvim() {
      if __shellspan_vim_should_attach "$@"; then
        command nvim -S "$SHELLSPAN_VIM_BRIDGE" "$@"
      else
        command nvim "$@"
      fi
    }
  fi
}
__shellspan_install_vim_wrappers"#;

const ADAPTER: &str = include_str!("terminal_vim_bridge/bridge.vim");
const RELAY: &str = include_str!("terminal_vim_bridge/relay.sh");

pub(crate) fn is_tool(name: &str) -> bool {
    matches!(name, INSPECT | INSERT | SAVE | CLOSE)
}

pub(crate) fn valid_id(id: &str) -> bool {
    id.split_once('-').is_some_and(|(instance, revision)| {
        instance.len() == 64
            && instance
                .bytes()
                .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
            && !revision.starts_with('0')
            && revision.bytes().all(|byte| byte.is_ascii_digit())
            && revision.parse::<u64>().is_ok_and(|value| value > 0)
    })
}

pub(crate) fn valid_path(path: &str) -> bool {
    path.len() <= 4096
        && !path.contains('\\')
        && !path.chars().any(char::is_control)
        && path
            .strip_prefix('/')
            .is_some_and(|rest| rest.split('/').all(|part| !matches!(part, "" | "." | "..")))
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct EditorTarget {
    pub(crate) snapshot_id: String,
    pub(crate) path: String,
}

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum InsertPosition {
    Start,
    Cursor,
    End,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct InsertArguments {
    pub(crate) snapshot_id: String,
    pub(crate) path: String,
    pub(crate) position: InsertPosition,
    pub(crate) text: String,
}

#[derive(Serialize)]
#[serde(tag = "action", rename_all = "camelCase")]
pub(crate) enum EditAction {
    Insert {
        position: InsertPosition,
        text: String,
    },
    Save,
    Close,
}

#[derive(Serialize)]
#[serde(
    tag = "operation",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub(crate) enum EditorCommand {
    Inspect {
        root: String,
        owner: String,
    },
    Prepare {
        root: String,
        owner: String,
        #[serde(flatten)]
        target: EditorTarget,
        #[serde(flatten)]
        action: EditAction,
    },
    Commit {
        prepared_id: String,
    },
}

impl EditorCommand {
    fn is_commit(&self) -> bool {
        matches!(self, Self::Commit { .. })
    }
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct EditorSnapshot {
    pub(crate) id: String,
    pub(crate) path: String,
    pub(crate) window_id: u64,
    pub(crate) buffer_id: u64,
    pub(crate) changed_tick: u64,
    pub(crate) line: u64,
    pub(crate) byte_column: u64,
    pub(crate) line_count: u64,
    pub(crate) modified: bool,
    pub(crate) modifiable: bool,
    pub(crate) read_only: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum EditorKind {
    Vim,
    Neovim,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub(crate) enum EditorReply {
    Observed { snapshot: EditorSnapshot },
    Prepared,
    Inserted { snapshot: EditorSnapshot },
    Saved { snapshot: EditorSnapshot },
    Closed { snapshot: EditorSnapshot },
    Rejected { code: EditorError },
    Uncertain { code: EditorError },
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum EditorError {
    EditorNotReady,
    UnsupportedFile,
    SnapshotChanged,
    NotEditable,
    UnsupportedCursor,
    InsertUnverified,
    DiskChanged,
    DiskBaselineUnavailable,
    MultipleHardLinks,
    UnsupportedChangeHook,
    ReadOnly,
    SaveUnverified,
    UnsavedChanges,
    OperationExpired,
    UnsupportedOperation,
    #[serde(rename = "editorError")]
    Failed,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum Message {
    Attached {
        editor: EditorKind,
    },
    Detached,
    Reply {
        id: String,
        #[serde(flatten)]
        reply: EditorReply,
    },
}

#[derive(Deserialize)]
struct WireMessage {
    version: u8,
    instance: String,
    #[serde(flatten)]
    message: Message,
}

#[derive(Serialize)]
struct WireRequest<'a> {
    version: u8,
    id: &'a str,
    instance: &'a str,
    #[serde(flatten)]
    command: &'a EditorCommand,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum BridgeFailure {
    Unavailable,
    NotAttached,
    Busy,
    Cancelled,
    TimedOut,
    Uncertain,
}

struct Request {
    id: String,
    command: EditorCommand,
    reply: Sender<Result<(EditorKind, EditorReply), BridgeFailure>>,
    state: Arc<AtomicU8>,
    deadline: Instant,
}

#[derive(Clone)]
pub(crate) struct BridgeClient {
    requests: Sender<Request>,
    active: Arc<AtomicBool>,
    attached: Arc<AtomicBool>,
}

impl BridgeClient {
    pub(crate) fn available(&self) -> bool {
        self.active.load(Ordering::Acquire)
    }

    pub(crate) fn attached(&self) -> bool {
        self.active.load(Ordering::Acquire) && self.attached.load(Ordering::Acquire)
    }

    pub(crate) fn enqueue(&self, command: EditorCommand) -> Result<PendingReply, BridgeFailure> {
        if !self.available() {
            return Err(BridgeFailure::Unavailable);
        }
        let id = Uuid::new_v4().simple().to_string();
        let state = Arc::new(AtomicU8::new(QUEUED));
        let deadline = Instant::now() + EXCHANGE_TIMEOUT;
        let commit = command.is_commit();
        let (reply, response) = bounded(1);
        self.requests
            .try_send(Request {
                id: id.clone(),
                command,
                reply,
                state: state.clone(),
                deadline,
            })
            .map_err(|error| match error {
                TrySendError::Full(_) => BridgeFailure::Busy,
                TrySendError::Disconnected(_) => BridgeFailure::Unavailable,
            })?;
        Ok(PendingReply {
            id,
            response,
            state,
            deadline,
            commit,
        })
    }
}

pub(crate) struct PendingReply {
    pub(crate) id: String,
    response: Receiver<Result<(EditorKind, EditorReply), BridgeFailure>>,
    state: Arc<AtomicU8>,
    deadline: Instant,
    commit: bool,
}

impl PendingReply {
    pub(crate) fn wait(
        self,
        cancellation: &CancellationToken,
    ) -> Result<(EditorKind, EditorReply), BridgeFailure> {
        loop {
            if let Ok(result) = self.response.try_recv() {
                return result.map_err(|error| self.revoke(error));
            }
            if cancellation.is_cancelled() {
                return Err(self.revoke(BridgeFailure::Cancelled));
            }
            let remaining = self.deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err(self.revoke(BridgeFailure::TimedOut));
            }
            match self.response.recv_timeout(remaining.min(WAIT_SLICE)) {
                Ok(result) => return result.map_err(|error| self.revoke(error)),
                Err(RecvTimeoutError::Timeout) => continue,
                Err(RecvTimeoutError::Disconnected) => {
                    return Err(self.revoke(BridgeFailure::Unavailable))
                }
            }
        }
    }

    fn revoke(&self, error: BridgeFailure) -> BridgeFailure {
        if self
            .state
            .compare_exchange(QUEUED, REVOKED, Ordering::AcqRel, Ordering::Acquire)
            == Err(ATTEMPTED)
            && self.commit
        {
            BridgeFailure::Uncertain
        } else {
            error
        }
    }
}

impl Drop for PendingReply {
    fn drop(&mut self) {
        self.revoke(BridgeFailure::Cancelled);
    }
}

pub(crate) struct EditorWrite {
    pub(crate) bytes: Vec<u8>,
    state: Arc<AtomicU8>,
    deadline: Instant,
}

impl EditorWrite {
    /// After the first attempt libssh2 may own part of the frame, even on EAGAIN.
    /// The SSH queue must finish that frame or close the transport.
    pub(crate) fn begin(&self) -> bool {
        if Instant::now() >= self.deadline {
            let _ =
                self.state
                    .compare_exchange(QUEUED, REVOKED, Ordering::AcqRel, Ordering::Acquire);
        }
        self.state
            .compare_exchange(QUEUED, ATTEMPTED, Ordering::AcqRel, Ordering::Acquire)
            != Err(REVOKED)
    }
}

pub(crate) struct RemoteVimBridge {
    pub(crate) channel: Channel,
    root: String,
    client: BridgeClient,
    requests: Receiver<Request>,
    instance: Option<(String, EditorKind)>,
    pending: Option<Request>,
    input: BytesMut,
    decoder: LinesCodec,
}

impl RemoteVimBridge {
    pub(crate) fn prepare(session: &Session) -> Result<Self, String> {
        let root = format!("/tmp/.shellspan-vim-{}", Uuid::new_v4().simple());
        let sftp = session.sftp().map_err(|error| error.to_string())?;
        sftp.mkdir(Path::new(&root), 0o700)
            .map_err(|error| error.to_string())?;
        let start = || -> Result<(Channel, BytesMut), String> {
            for (name, content) in [("bridge.vim", ADAPTER), ("relay.sh", RELAY)] {
                let mut file = sftp
                    .open_mode(
                        Path::new(&format!("{root}/{name}")),
                        OpenFlags::CREATE | OpenFlags::EXCLUSIVE | OpenFlags::WRITE,
                        0o600,
                        OpenType::File,
                    )
                    .map_err(|error| error.to_string())?;
                file.write_all(content.as_bytes())
                    .map_err(|error| error.to_string())?;
                file.close().map_err(|error| error.to_string())?;
            }
            let mut channel = session
                .channel_session()
                .map_err(|error| error.to_string())?;
            channel
                .handle_extended_data(ssh2::ExtendedData::Ignore)
                .map_err(|error| error.to_string())?;
            let marker = format!("shellspan-vim-ready-{}", Uuid::new_v4().simple());
            channel
                .exec(&format!(
                    "exec /bin/sh {} {} host {marker}",
                    quote_remote_posix(&format!("{root}/relay.sh")),
                    quote_remote_posix(&root)
                ))
                .map_err(|error| error.to_string())?;
            let mut input = BytesMut::new();
            let mut decoder = LinesCodec::new_with_max_length(8192);
            let mut chunk = [0u8; 1024];
            let mut total_read = 0usize;
            let mut ready = false;
            while total_read < 8192 {
                let to_read = chunk.len().min(8192 - total_read);
                let count = match channel.read(&mut chunk[..to_read]) {
                    Ok(0) => break,
                    Ok(count) => count,
                    Err(_) => break,
                };
                total_read += count;
                input.extend_from_slice(&chunk[..count]);
                while let Ok(Some(line)) = decoder.decode(&mut input) {
                    if line == marker {
                        ready = true;
                        break;
                    }
                }
                if ready {
                    break;
                }
            }
            if !ready {
                return Err("Unexpected SSH editor relay startup".into());
            }
            Ok((channel, input))
        };
        let (channel, input) = match start() {
            Ok(started) => started,
            Err(error) => {
                for name in ["bridge.vim", "relay.sh", "request", "response", "uid"] {
                    let _ = sftp.unlink(Path::new(&format!("{root}/{name}")));
                }
                let _ = sftp.rmdir(Path::new(&root));
                return Err(error);
            }
        };
        let (sender, requests) = bounded(1);
        Ok(Self {
            channel,
            root,
            client: BridgeClient {
                requests: sender,
                active: Arc::new(AtomicBool::new(true)),
                attached: Arc::new(AtomicBool::new(false)),
            },
            requests,
            instance: None,
            pending: None,
            input,
            decoder: LinesCodec::new_with_max_length(MAX_FRAME_BYTES),
        })
    }

    pub(crate) fn client(&self) -> BridgeClient {
        self.client.clone()
    }

    pub(crate) fn source_path(&self) -> String {
        format!("{}/bridge.vim", self.root)
    }

    #[cfg(test)]
    pub(crate) fn attached(&self) -> bool {
        self.instance.is_some()
    }

    pub(crate) fn attached_editor(&self) -> Option<EditorKind> {
        self.instance.as_ref().map(|(_, editor)| *editor)
    }

    pub(crate) fn next_write(&mut self) -> Option<EditorWrite> {
        if self
            .pending
            .as_ref()
            .is_some_and(|request| request.state.load(Ordering::Acquire) == REVOKED)
        {
            self.finish_pending(BridgeFailure::Cancelled);
        }
        if self
            .pending
            .as_ref()
            .is_some_and(|pending| Instant::now() >= pending.deadline)
        {
            self.finish_pending(BridgeFailure::TimedOut);
        }
        if self.pending.is_some() {
            return None;
        }
        let request = self.requests.try_recv().ok()?;
        if request.state.load(Ordering::Acquire) == REVOKED {
            return None;
        }
        let Some((instance, _)) = &self.instance else {
            let _ = request.reply.send(Err(BridgeFailure::NotAttached));
            return None;
        };
        let bytes = serde_json::to_vec(&WireRequest {
            version: 1,
            id: &request.id,
            instance,
            command: &request.command,
        });
        let Ok(mut bytes) = bytes else {
            let _ = request.reply.send(Err(BridgeFailure::Unavailable));
            return None;
        };
        if bytes.len() >= MAX_FRAME_BYTES {
            let _ = request.reply.send(Err(BridgeFailure::Unavailable));
            return None;
        }
        bytes.push(b'\n');
        let write = EditorWrite {
            bytes,
            state: request.state.clone(),
            deadline: request.deadline,
        };
        self.pending = Some(request);
        Some(write)
    }

    pub(crate) fn drain(&mut self) -> Result<bool, ()> {
        let mut buffer = [0; 8192];
        let count = match self.channel.read(&mut buffer) {
            Ok(0) if self.channel.eof() => return Err(()),
            Ok(n) => n,
            Err(error)
                if matches!(error.kind(), ErrorKind::WouldBlock | ErrorKind::Interrupted) =>
            {
                return Ok(false)
            }
            Err(_) => return Err(()),
        };
        self.input.extend_from_slice(&buffer[..count]);
        while let Some(line) = self.decoder.decode(&mut self.input).map_err(|_| ())? {
            let message: WireMessage = serde_json::from_str(&line).map_err(|_| ())?;
            self.receive(message)?;
        }
        Ok(count > 0)
    }

    fn receive(&mut self, wire: WireMessage) -> Result<(), ()> {
        if wire.version != 1
            || wire.instance.len() != 64
            || !wire.instance.bytes().all(|b| b.is_ascii_hexdigit())
        {
            return Err(());
        }
        match wire.message {
            Message::Attached { editor } => {
                if self
                    .instance
                    .as_ref()
                    .is_some_and(|(instance, _)| *instance != wire.instance)
                {
                    self.finish_pending(BridgeFailure::Unavailable);
                }
                self.instance = Some((wire.instance, editor));
                self.client.attached.store(true, Ordering::Release);
            }
            Message::Detached
                if self
                    .instance
                    .as_ref()
                    .is_some_and(|(instance, _)| *instance == wire.instance) =>
            {
                self.instance = None;
                self.client.attached.store(false, Ordering::Release);
                self.finish_pending(BridgeFailure::NotAttached);
            }
            Message::Reply { id, reply } => {
                if let Some((instance, editor)) = &self.instance {
                    if *instance == wire.instance
                        && self
                            .pending
                            .as_ref()
                            .is_some_and(|request| request.id == id)
                    {
                        if let Some(request) = self.pending.take() {
                            let _ = request.reply.send(Ok((*editor, reply)));
                        }
                    }
                }
            }
            Message::Detached => {}
        }
        Ok(())
    }

    fn finish_pending(&mut self, reason: BridgeFailure) {
        if let Some(request) = self.pending.take() {
            let _ = request.reply.send(Err(reason));
        }
    }
}

impl Drop for RemoteVimBridge {
    fn drop(&mut self) {
        self.client.active.store(false, Ordering::Release);
        self.client.attached.store(false, Ordering::Release);
        self.finish_pending(BridgeFailure::Unavailable);
        let _ = self.channel.send_eof();
        let _ = self.channel.close();
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::SHELL_AUTO_ATTACH_SNIPPET;
    use std::process::Command;

    #[test]
    fn shell_auto_attach_snippet_respects_toggle_aliases_and_non_tty_safety() {
        let bridge = tempfile::NamedTempFile::new().expect("temp bridge file");
        let bridge_path = bridge.path().to_str().expect("utf-8 temp path");

        for shell in ["/bin/bash", "/bin/zsh"] {
            if !std::path::Path::new(shell).exists() {
                continue;
            }
            // Off by default: wrappers must not be defined.
            let off = Command::new(shell)
                .env("SHELLSPAN_VIM_BRIDGE", bridge_path)
                .env_remove("SHELLSPAN_VIM_BRIDGE_AUTO")
                .arg("-c")
                .arg(format!(
                    "{SHELL_AUTO_ATTACH_SNIPPET}\ntypeset -f vim >/dev/null 2>&1 && echo VIM_FN; typeset -f nvim >/dev/null 2>&1 && echo NVIM_FN; true"
                ))
                .output()
                .expect("run shell with auto attach disabled");
            assert!(off.status.success(), "{shell}: {:?}", off);
            assert_eq!(String::from_utf8_lossy(&off.stdout).trim(), "");

            // On, with user alias `vim=nvim` and non-TTY stdio: preserve alias, define nvim wrapper,
            // and verify non-TTY returns false for attach.
            let on = Command::new(shell)
                .env("SHELLSPAN_VIM_BRIDGE", bridge_path)
                .env("SHELLSPAN_VIM_BRIDGE_AUTO", "1")
                .arg("-c")
                .arg(format!(
                    "alias vim='nvim'\n{SHELL_AUTO_ATTACH_SNIPPET}\n\
                     typeset -f vim >/dev/null 2>&1 && echo VIM_FN || echo NO_VIM_FN\n\
                     typeset -f nvim >/dev/null 2>&1 && echo NVIM_FN || echo NO_NVIM_FN\n\
                     __shellspan_vim_should_attach file.txt && echo ATTACH_NON_TTY || echo SKIP_NON_TTY"
                ))
                .output()
                .expect("run shell with auto attach enabled");
            assert!(on.status.success(), "{shell}: {:?}", on);
            assert_eq!(
                String::from_utf8_lossy(&on.stdout).trim(),
                "NO_VIM_FN\nNVIM_FN\nSKIP_NON_TTY",
                "{shell} output mismatch"
            );

            // Flag filter check (bypassing only the -t check via a wrapper around the case loop):
            let flag_script = format!(
                "{}\n\
                 check_flags() {{\n\
                   local __ss_arg\n\
                   for __ss_arg in \"$@\"; do\n\
                     case \"$__ss_arg\" in\n\
                       --) break ;;\n\
                       -|-[hveEsSrLb]|-es|-u|-u*|-U|-U*|-Nu|-Nu*|-S|-S*|-s|-s*|--help|--version|--clean|--headless|--embed)\n\
                         return 1 ;;\n\
                     esac\n\
                   done\n\
                   return 0\n\
                 }}\n\
                 check_flags file.txt && check_flags -n +10 file.txt && check_flags -- -weird && echo ALLOW_OK\n\
                 ! check_flags --version && ! check_flags --clean && ! check_flags -u NONE && ! check_flags -Nu NONE && ! check_flags -S s.vim && ! check_flags - && ! check_flags --headless && echo BLOCK_OK",
                SHELL_AUTO_ATTACH_SNIPPET
            );
            let flags = Command::new(shell)
                .env("SHELLSPAN_VIM_BRIDGE", bridge_path)
                .env("SHELLSPAN_VIM_BRIDGE_AUTO", "1")
                .arg("-c")
                .arg(&flag_script)
                .output()
                .expect("run flag filter check");
            assert!(flags.status.success(), "{shell}: {:?}", flags);
            assert_eq!(
                String::from_utf8_lossy(&flags.stdout).trim(),
                "ALLOW_OK\nBLOCK_OK",
                "{shell} flag filtering mismatch"
            );
        }
    }
}

//! A connection-scoped Vim/Neovim channel. The SSH worker owns both the PTY
//! and this channel, including the libssh2 write retry ordering.
use std::{
    io::{BufRead, BufReader, ErrorKind, Read, Write},
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
pub(crate) const MAX_TEXT_BYTES: usize = 32 * 1024;
const MAX_FRAME_BYTES: usize = 256 * 1024;
const EXCHANGE_TIMEOUT: Duration = Duration::from_secs(4);
const WAIT_SLICE: Duration = Duration::from_millis(25);
const QUEUED: u8 = 0;
const ATTEMPTED: u8 = 1;
const REVOKED: u8 = 2;

const ADAPTER: &str = include_str!("terminal_vim_bridge/bridge.vim");
const RELAY: &str = include_str!("terminal_vim_bridge/relay.sh");

pub(crate) fn is_tool(name: &str) -> bool {
    matches!(name, INSPECT | INSERT | SAVE)
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

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
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
    OperationExpired,
    UnsupportedOperation,
    EditorError,
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
}

impl BridgeClient {
    pub(crate) fn available(&self) -> bool {
        self.active.load(Ordering::Acquire)
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
        let start = || -> Result<Channel, String> {
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
            let marker = format!("shellspan-vim-ready-{}", Uuid::new_v4().simple());
            channel
                .exec(&format!(
                    "exec /bin/sh {} {} host {marker}",
                    quote_remote_posix(&format!("{root}/relay.sh")),
                    quote_remote_posix(&root)
                ))
                .map_err(|error| error.to_string())?;
            let ready = BufReader::new((&mut channel).take(8192))
                .lines()
                .map_while(Result::ok)
                .any(|line| line == marker);
            if !ready {
                return Err("Unexpected SSH editor relay startup".into());
            }
            Ok(channel)
        };
        let channel = match start() {
            Ok(channel) => channel,
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
            },
            requests,
            instance: None,
            pending: None,
            input: BytesMut::new(),
            decoder: LinesCodec::new_with_max_length(MAX_FRAME_BYTES),
        })
    }

    pub(crate) fn client(&self) -> BridgeClient {
        self.client.clone()
    }

    pub(crate) fn source_path(&self) -> String {
        format!("{}/bridge.vim", self.root)
    }

    pub(crate) fn attached(&self) -> bool {
        self.instance.is_some()
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
            }
            Message::Detached
                if self
                    .instance
                    .as_ref()
                    .is_some_and(|(instance, _)| *instance == wire.instance) =>
            {
                self.instance = None;
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
        self.finish_pending(BridgeFailure::Unavailable);
    }
}

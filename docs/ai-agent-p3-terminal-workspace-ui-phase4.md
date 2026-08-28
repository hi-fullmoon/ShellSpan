# P3 Agent terminal workspace UI — phase 4 evidence

## Scope and admission status

This phase starts from `codex/agent-terminal-coordinator-phase3` commit `d90ee106179e4c675b37255fae395da83899d516` and is implemented on `codex/agent-terminal-workspace-ui-phase4`.

P3 remains `planned`. `AGENT_TERMINAL_PRODUCTION_ADMITTED_V1` is deliberately `false`, and the workspace always states that production admission and the P0/P1/P2 gates remain closed. This phase does not connect a real provider/model loop, arbitrary shell, production modifying executor, or generic terminal control. The UI consumes only the six phase-3 commands and deterministic mocked transports.

## shadcn implementation constraints

The repository `components.json` and the complete project shadcn skill were read before implementation, including `styling.md`, `forms.md`, `composition.md`, `icons.md`, and `chat.md`. These rules constrained the work to semantic tokens and existing layout primitives; `gap` rather than ad-hoc spacing; Lucide icons; complete AlertDialog title/description structures; Sonner for transient failures; and installed `Alert`, `AlertDialog`, `Badge`, `Button`, `Card`, `Separator`, and `Tabs` primitives rather than handwritten equivalents.

`pnpm dlx shadcn@latest info --json` confirmed Vite, Tailwind v4, Base UI, Lucide, and pnpm. Component docs were read for Tabs, Card, Badge, Alert, AlertDialog, Button, Spinner, Skeleton, Separator, and Sonner. Spinner and Skeleton were the only missing primitives: both were searched, viewed, and dry-run before installation, with no overwrite of an existing component.

## Dedicated workspace and authority projection

`AgentWorkspace` now exposes separate “Agent run” and “Dedicated terminal” tabs. The terminal tab accepts only the current run ID. With no run or no authoritative snapshot it renders an unavailable/preview gate and never mounts a normal user terminal, reuses a normal terminal tab, or fabricates an `AgentPty` binding.

`decodeAgentTerminalSnapshotV1` manually validates the exact v1 shape, closed enums, sizes, safe integers, owner/control/lease consistency, untrusted observation marker, action and verification bindings, monotonic bounded events, and exact pending-approval bindings. Unknown or inconsistent data fails closed.

The dedicated Zustand projection stores decoded public snapshots only. The backend `lastSequence` is authoritative: lower sequences are dropped and a run/target/session binding change is rejected. Equal-sequence lifecycle snapshots remain admissible because phase-3 disconnect/reconnect projections can change public lifecycle fields without restoring authority. Mount/remount always requests a fresh snapshot; request generations discard late fetch completions. Tauri status/close events are refresh hints only and cannot set owner/control state. Reconnect never invents or restores Agent ownership.

## Input ownership, takeover, and return

The Agent terminal creates an independent xterm surface bound to the snapshot session. It displays session output locally and uses normal resize/ready plumbing, but it does not instantiate the ordinary terminal controller, append to terminal output persistence, create a normal workspace entry, or call `write_session`.

Every xterm `onData` value is passed directly to `agent_terminal_takeover_and_write`. When Agent or unowned authority is observed, the first data call is the sole atomic owner-transfer plus first-input operation; concurrent bytes are gated until that call settles. When User already owns the lease, later bytes still use the same user-owned narrow operation. A stable client action ID is generated once per operation and reused for one unknown-transport retry. Failure resynchronizes the snapshot and never optimistically changes owner.

The visible “Take over now” path uses an AlertDialog explaining that the Agent pauses and its lease is revoked. Phase 3 rejects empty input and exposes no takeover-only command, so confirmation safely arms and focuses xterm; the next real user byte performs the atomic takeover. The UI never invents an ESC, newline, control key, or other terminal effect merely to satisfy a click. Explicit return also uses an AlertDialog and is enabled only for an active User-owned lease. Unmount, app exit, disconnect, stop, pause, or handoff does not reacquire or return control.

## Secret handoff and privacy

Password, passphrase, MFA, OTP, token, credential, unknown-sensitive, full-screen, editor, installer, and unknown surfaces render a destructive handoff alert. They never render an Agent-secret-input, approval-bypass, or “allow Agent” action. The user types locally into xterm and may explicitly return control after the sensitive interaction.

Raw `onData` is never copied into React/Zustand state, toast text, analytics, operation history, terminal persistence, logs, snapshots, audits, test snapshots, or the xterm output buffer by frontend echo. It exists only in the immediate callback/request closure for the narrow Tauri invocation. The dedicated wrapper deliberately bypasses generic invocation logging. During User ownership, backend output capture remains discarded; after return, the UI announces the rotated capture epoch and that the user's interval was not provided to the model.

## Approval, recovery, and controls

Approval actions appear only when the snapshot contains an exact, pending, unexpired, Agent-owned approval bound to the run, target, session, action/action digest, observation/digest, risk digest, lease epoch/revision, registered driver/program/scenario, and supported line-prompt class. The card displays all of those public facts, redacted untrusted preview, and live TTL. Approve/reject use confirmation dialogs, pending spinners, disabled replay controls, idempotent client action IDs, failure toast, and snapshot resynchronization. Sensitive, unknown, or unsupported surfaces never show approval buttons.

The workspace continuously exposes owner, control and lease state, display-only lease epoch/revision, capture epoch, current action/state, risk, approval TTL/state, untrusted observation, verification obligation and independence, connection/recovery state, and refresh activity. `unknownEffect` is never shown as success; it states that the effect is unknown and requires independent verification. Pause uses the phase-3 narrow command, and Stop uses destructive confirmation. All authority changes are rendered only from returned/resynchronized snapshots.

The UI uses semantic variants rather than raw state colors, supplies keyboard-operable controls and complete dialog semantics, restores focus through the component primitives, and provides an atomic polite `aria-live` summary. Chinese and English strings live in the existing i18n catalogs.

## Tests and validation

Deterministic mocked Tauri/xterm tests cover:

- strict decode, monotonic sequence, binding mismatch, late resync responses, remount resync, and event-as-hint behavior;
- Agent-owner first-key takeover, takeover race gating, failure without optimistic ownership, User-owner subsequent input, explicit return, and capture rotation;
- exact approval binding, TTL expiry, repeat/replay suppression, failure resync, and no approval for secret/unknown/full-screen handoff;
- raw secret absence from React/store/DOM/test snapshots and source-level absence of generic write, persistence, logging, or analytics paths;
- disconnect/reconnect/remount without automatic ownership restoration, `unknownEffect` wording, Pause/Stop, preview-only no-run behavior, and existing Agent/terminal regressions.

Validation on this branch:

- Targeted phase-4 and Agent workspace tests: 25 passed, 0 failed.
- Agent/terminal regression selection: 293 passed, 0 failed.
- Full frontend suite initially passed all 164 files and 1307 tests. A final post-hardening single-worker rerun passed 163 files/1306 tests before one unrelated workbench test was spuriously timed out when the host clock jumped forward by roughly 18 minutes; that exact test immediately passed 1/1 in isolation. The earlier affected SFTP/terminal set also passed 71/71 in isolation. There were no remaining assertion failures and the phase-4 selection passed again after the final hardening edits.
- Script audit suite: 43 passed, 0 failed.
- TypeScript compile and `pnpm build`: passed; Vite reports only the existing large-chunk advisory.
- Roadmap audit: passed with 20 valid product workstreams.
- `git diff --check`: passed.
- Browser visual QA: the Chinese no-run preview and closed-admission alerts rendered correctly at the default viewport, 900×650, and 720×600. Direct Vite browsing reported only the expected existing missing-Tauri-runtime IPC errors.
- `cargo fmt --all -- --check`: passed.
- `cargo check --tests --message-format=short`: at phase-4 acceptance time, the UI code introduced no Rust diagnostics while the same 30 unrelated deployment baseline errors recorded in phase 3 blocked the command. That subsystem was later retired and no longer blocks the current Rust gate.

## Privacy and bypass review

The phase-4 source contains no ordinary `write_session`/`invokeWriteSession`, normal terminal registry creation, `appendTerminalOutput`, local/session storage, analytics, logger/console call, lease token, approval secret/challenge, or Agent raw-write command. The only raw-input field is the transient `data` argument/request required by `agent_terminal_takeover_and_write`. Ordinary terminal generic writes remain confined to pre-existing user terminal paths and are never reachable from the dedicated Agent component.

## Known limitations and phase-5 boundary

- Production admission remains closed, so the complete owner/approval/handoff view is exercised through deterministic snapshots and mocks rather than a real model or production Agent PTY run.
- The only registered interactive driver remains the deterministic phase-2 fixture; this UI does not broaden it into a general TUI, editor, installer, arbitrary shell, or computer-use surface.
- Click takeover must wait for the next genuine user input because phase 3 deliberately has no takeover-only operation and rejects empty input. A future contract may add an explicit no-write takeover command only after a separate backend security review; phase 4 does not emulate one with an invented terminal byte.
- Direct browser visual QA cannot provide a Tauri IPC runtime; command and event behavior is therefore validated in the deterministic mocked harness and production TypeScript build.
- Phase 5 may add integration evidence around the existing narrow boundary, but must not enable production admission, expose lease authority, persist secrets, add a generic Agent write, treat PTY output as verification, or auto-reacquire control without satisfying the still-blocked gates.

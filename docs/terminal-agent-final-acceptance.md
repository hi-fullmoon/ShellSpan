# Terminal Agent enhancement final acceptance

Date: 2026-09-01 (Asia/Shanghai)

Accepted baseline: `33ad91f` (`feat(agent): complete M5 fleet orchestration`)

## Verdict

The ShellSpan Terminal Agent enhancement plan is accepted through M0–M5. The
implemented path preserves Agent Contract v2 as the default production Agent,
keeps v3, MCP, Operator, and Fleet behind independent Rust-enforced opt-ins,
and provides the structured local/remote execution, file, plan, checkpoint,
context, extension, recovery, Operator, and bounded Fleet capabilities required
by the milestone plan.

The final pass found one acceptance defect: the checked-in Agent v2 baseline
contained a stale contract digest even though the contract itself had not
changed. The official collector was rerun and refreshed
`evals/agent-v2/baseline.json`. No runtime or policy code required an acceptance
repair.

Release compilation and unsigned macOS application bundling pass. A normal
signed bundle cannot be produced on this machine because the configured
`ShellSpan Dev` signing identity is not installed. Docker-backed SSH/SFTP,
credentialed live-provider, Windows, and Linux executions are recorded as
external acceptance limits rather than represented as passing.

## Acceptance authority and invariant audit

The audit used the current worktree as authority, read the enhancement plan and
all M0–M5 acceptance documents, and inspected the protocol, Rust, typed IPC,
and React surfaces. The following boundaries remain true after M5:

- `src-tauri/src/agent_contract.rs` resolves a clean v2 installation to
  `Stable`; request approval remains the default permission mode.
- `src-tauri/src/agent_contract_v3/rollout.rs` selects v3 only for the exact
  `SHELLSPAN_AGENT_V3_ROLLOUT=runtime` value. Missing, disabled, and unknown
  values route to v2.
- `src-tauri/src/agent_runtime_v3/mcp.rs`, `m4.rs`, and `m5.rs` independently
  gate MCP, Operator, and Fleet with `SHELLSPAN_AGENT_MCP_EXPERIMENTAL`,
  `SHELLSPAN_AGENT_OPERATOR`, and `SHELLSPAN_AGENT_FLEET`. None is enabled by
  selecting another optional layer, and unknown values fail closed.
- `src-tauri/src/agent_runtime_v3/commands.rs` enforces rollout in Rust for the
  entire IPC surface. React and TypeScript receive snapshots and opaque ids;
  they do not construct trusted capability claims, results, recovery states,
  Operator grants, or Fleet success.
- Capabilities, Operator grants, broker grants, process handles, and sub-Agent
  authority do not survive restart. Unknown writes and external calls are not
  replayed.

## Requirement-by-requirement closure

| Enhancement plan area | Status | Concrete implementation and test evidence |
| --- | --- | --- |
| Architecture, strict v3 contract, target/result correlation | Accepted | `protocol/agent/v3/`; `src-tauri/src/agent_contract_v3/`; strict fixture decoding and unknown-field denial in Rust and `src/lib/__tests__/agent-contract-v3.test.ts` |
| Tool registry and metadata | Accepted | `protocol/agent/v3/built-in-tools.json` describes all 12 names, target kinds, effects, idempotency, cancellation, retry, time, output, concurrency, capability, and untrusted-result fields; `agent_runtime_v3/registry.rs` checks synchronization and explicit implementation state |
| PTY and Direct Exec | Accepted | `agent_runtime_v3/pty.rs`, `process.rs`, and `runtime.rs`; committed completion-secret PTY parsing, independent Direct Exec streams, bounded captures, process handles, cancellation, timeouts, Unix process groups, Windows Job Objects, and honest unconfirmed remote termination |
| Native permissions and capabilities | Accepted | `agent_contract_v3/policy.rs`, `agent_runtime_v3/effect.rs`, and `capability.rs`; Rust-owned effect classification, exact call digest, request/session/tool/effect/target/TTL/use binding, revocation, single use, and dispatch-time revalidation |
| Structured file and transfer operations | Accepted | `agent_runtime_v3/filesystem.rs` implements local and SFTP read/list/search/patch/transfer without shell fallback; root containment, `lstat` symlink rejection, digest preconditions, cursor snapshot binding, atomic replacement, cancellation, and bounded data are covered by Rust tests |
| Plans, verification, and checkpoints | Accepted | `agent_runtime_v3/runtime.rs` and `checkpoint.rs`; Rust checks plan dependencies, targets, effects, rollback text, evidence, and completion; file writes create bounded digest-verified checkpoints and require native write-after-read verification |
| Context and memory | Accepted | `agent_runtime_v3/context.rs` and `agent-m3-context-surface.tsx`; workspace/host/session/task provenance, bounded instruction discovery, untrusted data marking, structured compaction, artifacts, retrieval, directory/symbol maps, and fee/size visibility |
| Skills, Hooks, and Runbook v1 | Accepted | `agent_runtime_v3/extensions.rs`; progressive skill loading, bounded path-safe discovery, synchronous Hook allow/deny/modify before fresh policy evaluation, asynchronous observation-only Hooks, and parameterized Runbooks that cannot grant authority |
| MCP | Accepted for the planned experimental minimum | `agent_runtime_v3/mcp.rs`; independent default-off stdio transport, bounded framing/schema discovery, lazy schema exposure, server/tool policy, native approval/capability/broker binding, timeout/cancellation, and untrusted result handling. HTTP/OAuth remain explicitly out of scope for this version |
| Durable background recovery | Accepted | `agent_runtime_v3/m4.rs`; versioned bounded stores, staged atomic persistence, redaction, corruption quarantine, v0-to-v1 migration, safe/needs-reconciliation/lost/cancelled/completed dispositions, session rebinding, notifications, and no replay |
| Operator, broker, egress, and sensitive paths | Accepted | `agent_runtime_v3/m4.rs` plus native commands; default-off scoped TTL grants, revocation/audit, per-call fallback, single-use secret-free broker grants, critical-path opt-in, literal egress allowlist, and dispatch-time reevaluation |
| Fleet and multi-Agent | Accepted | `agent_runtime_v3/m5.rs`; frozen label/group/environment selectors, stable digest, mandatory write canary, bounded batches/jitter/concurrency/calls/failures, visible per-target states, role subsets, same-target write serialization, independent Verifier evidence, no direct-call bypass, restart reconciliation, and verified per-target rollback recording |
| UI and typed IPC | Accepted | `src/types/agent-v3.ts`, `src/lib/tauri.ts`, `agent-m2-task-surface.tsx`, `agent-m3-context-surface.tsx`, `agent-m4-task-center.tsx`, and `agent-m5-fleet-center.tsx`; the running view exposes diff/checkpoint, context, recovery/Operator, and honest Fleet result surfaces without moving authority to React state |
| Audit and observability | Accepted | M4 persists bounded redacted task/notification/audit envelopes and append-only rotated `audit-v1.jsonl`; typed audit snapshots are available through `agent_v3_list_audit_events`; native task/result/effect/capability/recovery/Fleet state remains correlated. OpenTelemetry is a reserved future interface, not a completion claim |
| Migration and rollback | Accepted | v2 history remains read-only and is never upgraded into executable v3 state; v3 persistence owns an explicit migration; each optional layer has an independent disable-and-restart rollback; redacted state remains inspectable; checkpoint and Fleet rollback stay exact-target and evidence-bound |

The first 12 names remain the stable registry/context surface. Ten are
executable through M1/M2. `host_snapshot` and `ask_user` remain explicitly
registered but unavailable rather than using a shell or fabricated UI fallback;
host context is supplied by native task/context state and user approval is
collected by the native authorization flow. This is the documented milestone
boundary, not a silent partial implementation.

## Security and failure-mode audit

| Risk | Evidence and outcome |
| --- | --- |
| Assistant text or prompt injection becomes executable | v2 and v3 accept only structured calls; terminal/file/MCP/context data is marked untrusted and never promoted to instructions. Security and runtime tests pass. |
| Approval or capability bypass | Exact-call native capabilities, non-deserializable verified claims, dispatch revalidation, one-use consumption, and ordinary-dispatch rejection for Fleet-owned tasks all pass. |
| Capability or grant replay after restart | `restart_never_revives_an_issued_or_consumed_capability`, M4 restart tests, and M5 role recovery tests pass. |
| Forged or late tool result | Result correlation, reserve/commit-once state, late completion/cancel races, PTY secret commitments, and independent Fleet verification tests pass. |
| Secret exposure | Recursive redaction, credential-store-only resolution, secret-free broker/grant snapshots, sanitized persistence/notifications/Fleet state, and the 311-test security suite pass. |
| Path escape or replacement race | Local canonical roots, remote `lstat`, symlink/parent rejection, pre-dispatch digest checks, atomic writes, checkpoint ownership, and cursor digests pass. |
| Target or multi-host confusion | Frozen target/session/profile identity, host-key/root revalidation, selector snapshots, exact parent-plan versions, per-host rows, and Fleet bypass tests pass. |
| Unknown write replay | M4 persistence and reconciliation tests prove no uncertain write/external call/process handle is resumed; M5 moves in-flight targets to `needsReconciliation`. |
| Unbounded execution | Manifest limits plus task/process/context/persistence/Fleet bounds, timeout/cancellation, output head/tail capture, capability TTL, and call/concurrency budgets remain enforced. |
| Unauthorized side effects | All executable negative-policy tests completed without an allowed unauthorized call; no test or audit repair weakened a denial boundary. |

## Executed verification

The final pass ran on macOS arm64 with Node `v24.15.0`, pnpm `11.1.1`, Rust
`1.95.0`, and Cargo `1.95.0`.

| Command | Result |
| --- | --- |
| `pnpm baseline:agent:v2` | Passed: v2 contract 25 tests, v2 security 311 tests, Rust v2 contract 10 tests; refreshed `evals/agent-v2/baseline.json` |
| `CI=true pnpm test` | Passed: 164 files, 1,584 tests; 3 platform-conditioned tests skipped |
| `CI=true pnpm test:scripts` | Passed: 7 files, 32 tests |
| `CI=true pnpm test:agent:security` | Passed: 8 files, 311 tests |
| `CI=true pnpm test:agent:contract-v3` | Passed: 1 file, 5 tests |
| `CI=true pnpm test:agent:runtime-v3` | Passed: 1 file, 4 tests |
| `CI=true pnpm test:agent:m3` | Passed: 3 files, 8 tests |
| `CI=true pnpm test:agent:m4` | Passed: 3 files, 10 tests |
| `CI=true pnpm test:agent:m5` | Passed: 2 files, 3 tests |
| `CI=true pnpm test:agent:platform` | Passed: 12 macOS/shared tests, 3 Windows-conditioned tests skipped; 3 real macOS Rust shell/health tests passed |
| `pnpm exec tsc --noEmit` | Passed |
| `pnpm build` | Passed; existing `main` chunk over 500 kB advisory remains |
| `cargo test --manifest-path src-tauri/Cargo.toml --locked` | Passed: 479 library tests, 18 explicitly ignored external/controlled tests; 5 integration probes passed |
| `cargo clippy --manifest-path src-tauri/Cargo.toml --locked --all-targets -- -D warnings` | Passed |
| `cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check` | Passed |
| `pnpm tauri:build` | Release binary and frontend compiled; signed `.app` bundling stopped because `ShellSpan Dev` is not installed |
| `pnpm exec tauri build --no-sign --bundles app --ci` | Passed; produced `ShellSpan.app` and `ShellSpan.app.tar.gz` |
| `git diff --check` | Passed after the acceptance documents were finalized |

### v2 baseline repair

The first full frontend run reported one failure because the checked-in
baseline expected contract digest `d4d4741e...`, while the actual schema digest
was `760e1839...`. Comparing `protocol/agent/v2/agent-contract.schema.json` at
`93f21e6`, `26c2776`, and the accepted M5 baseline showed the same
`760e1839...` bytes. The official collector then passed all three probes and
updated only capture metadata, environment/durations, source revision, and the
correct digest. The subsequent complete frontend run passed.

## External and retained limits

- `docker` client `29.7.2` is installed, but the Docker daemon socket was
  unavailable. The isolated password/private-key/jump-host SSH, SFTP,
  port-forward, remote-health, and SFTP benchmark tests therefore remained
  ignored. The harness and ignored tests are present; no Docker result is
  claimed in this pass.
- Five live provider tests require explicit OpenAI, MiniMax, compatible Chat
  Completions, or Ollama configuration. No provider credentials or live flags
  were supplied, so they remained ignored and no external calls were made.
- The controlled Petdex Desktop restart test remained ignored because its
  external desktop fixture was not running.
- The final Rust count therefore reports 18 ignored tests: 5 live-provider,
  12 Docker/SSH/SFTP/remote fixture or benchmark cases, and 1 controlled Petdex
  case.
- This macOS host executed real zsh/PTY behavior. Windows PowerShell/ConPTY and
  Linux shell branches were not executed here; three Windows-conditioned
  frontend platform cases were skipped. Platform-specific implementations and
  tests remain checked in.
- `security find-identity -v -p codesigning` reported zero valid identities.
  Standard Tauri build therefore cannot satisfy the configured `ShellSpan
  Dev` signing step on this machine. The release binary and unsigned app bundle
  succeeded; notarization and signed distribution still require the release
  certificate outside this repository.
- MCP is stdio-only; Streamable HTTP/OAuth, an OS network sandbox,
  OpenTelemetry export, automatic process reattachment, external inventory
  import, and a visual Fleet authoring editor are not claimed. Their absence
  does not weaken the accepted native policy, no-replay, or audit boundaries.

## Rollback and hand-off

To return entirely to the established Agent v2 path, disable Fleet, Operator,
MCP, and v3, then restart ShellSpan. No v3 task, call, capability, grant,
sub-Agent, or persisted unknown write is converted into v2 execution. Before
manual removal, archive the redacted `agent-m4` and `agent-m5` application-data
directories while ShellSpan is stopped.

This acceptance document, the refreshed v2 baseline, and the completed
cross-machine checkpoint are the final durable hand-off. No push was performed.

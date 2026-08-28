# AI Agent 安全控制终端输入：阶段 5 验收证据

> 日期：2026-08-28
> 精确起点：`codex/agent-terminal-workspace-ui-phase4` / `18cd213d426d650e6c6229f28897308f7a0b22c9`
> 验收分支：`codex/agent-terminal-control-phase5-acceptance`
> 机器可读矩阵：`tests/fixtures/agent-terminal-protocol/v1/terminal-acceptance.json`

## 结论与可用范围

阶段 5 完成了既有阶段 1–4 foundation 的跨层、确定性和旁路验收，没有扩展产品功能，也没有解除任何 admission gate。十项安全不变量都有代码位置、Rust/TypeScript/UI/静态审计证据、适用平台、未验证项和退出条件。所有十项在 platform-independent 自动化层面为 `automatedPass`。

“现在可用”严格限于以下范围：

- Rust 后端的专用 `AgentPty` ownership/lease/fence、严格 proposal/driver、coordinator、审计、capture、handoff 和 lifecycle foundation；
- checked-in fixture、fake sender、fake audit、fake verifier、in-process coordinator，以及 mocked narrow Tauri IPC；
- 已有 Agent workspace 中的专用终端 UI。当且仅当后端已经有 run-bound Agent terminal snapshot 时，它可以显示控制权、接管、归还、审批、handoff、pause/stop、untrusted observation 和 verification 状态；
- 本机 macOS 的真实 Tauri/WebView/xterm 壳启动和真实本地 PTY transport smoke。

以下不属于“可用”：production Agent terminal 创建/执行、真实模型、任意 shell/TUI、修改 executor、通用 computer-use、真实 SSH AgentPty 和 Windows 真机 AgentPty。P0/P1/P2/P3 production admission 仍关闭，默认注册会返回 `AdmissionBlocked`；P3 状态仍是 `planned`。

## UI 如何看见、接管和归还

1. 打开现有 Agent workspace 的“专用终端”标签。没有后端 AgentPty binding 时，UI 只显示 unavailable/preview/fake-gated，不会回退到普通终端。
2. 有权威 snapshot 时，UI 显示 owner、control state、lease epoch/revision（只读显示）、capture epoch、action/risk、approval TTL、untrusted observation、verification 和 recovery 状态。
3. Agent owner 下，点击“立即接管”或在专用 xterm 输入首键。首键只进入 `agent_terminal_takeover_and_write`，后端在同一权威锁内完成 takeover 与首输入；旧 Agent epoch/revision 随即失效。
4. User owner 下，后续输入仍只走同一窄入口，不进入普通 `write_session`、React/Zustand、toast、日志、event、audit、snapshot 或 workspace persistence。
5. 点击“归还控制”调用 `agent_terminal_return_control`。后端旋转 capture epoch；用户控制期间输出不会成为模型 observation。重连或 remount 不自动归还给 Agent。
6. 密码、passphrase、MFA/OTP、token/credential、unknownSensitive、alternate screen、editor、installer 或 unknown surface 只显示 handoff；不存在 approve 按钮或自动输入。

## 可追溯验收矩阵

完整字段与逐项退出条件以机器可读 fixture 为准。下表给出最终证据索引。

| ID | 不变量与主要代码 | 自动化证据 | 结果 | 尚未验证 |
| --- | --- | --- | --- | --- |
| AT-OWNERSHIP-001 | `terminal_lease.rs`；`models.rs` 的 ordinary/user/Agent 三条写入边界 | ordinary write fail-closed、epoch/revision replay fence、64 线程 takeover/write race | automatedPass；macOS real PTY transport | Windows ConPTY、SSH AgentPty 真机 race |
| AT-PROTOCOL-002 | `terminal-actions.schema.json`、`terminal_protocol.rs`、`terminal_driver.rs`、`terminal_ipc.rs` | Rust/TS 共享 fixture、384 固定种子 unknown-field/enum/size corpus、registry/IPC AST 审计 | automatedPass | 真实 provider；按设计未接入 |
| AT-COORDINATOR-003 | `terminal_coordinator.rs`、`terminal_audit.rs` | sequence/终态 property、exactly-once retry、approval expiry/replay/binding、audit prewrite 0 input、unknownEffect no replay | automatedPass | packaged crash injection |
| AT-HANDOFF-004 | `terminal_policy.rs`、`terminal_observation.rs`、`use-agent-terminal.ts` | 全部 secret/TUI/unknown fixture 只 handoff，0 approval | automatedPass | 真实第三方 TUI 多样性 |
| AT-CAPTURE-005 | `BoundedTerminalCaptureV1`、coordinator capture lifecycle | 400 行固定 corpus；32 KiB/200 line/60 s；ANSI/control/redaction；User owner 0 observation；return rotate | automatedPass | 真实远端异常编码流 |
| AT-VERIFICATION-006 | `verify_pending_action`、严格 TS snapshot decoder | 非 independent evidence 永不 verified；unknownEffect 不显示成功 | automatedPass | production verifier 仍阻止 |
| AT-UI-AUTHORITY-007 | `agent-terminal-control.ts`、`agentTerminalStore.ts`、`use-agent-terminal.ts` | strict decode、256 固定种子 sequence/terminal immutability、remount/error resync、mocked narrow IPC E2E | automatedPass；macOS Tauri shell | packaged Windows WebView |
| AT-XTERM-ISOLATION-008 | `agent-terminal-xterm.tsx`、`agent-terminal-workspace.tsx` | dedicated import/call graph、raw secret durable surfaces=0、ordinary store/write denylist | automatedPass；macOS xterm build/start | Windows persistence inspection |
| AT-LIFECYCLE-009 | `models.rs`、coordinator、`lib.rs` app exit hook | pause/stop/disconnect/reconnect/remount/app-exit、tombstone、unknownEffect recovery | automatedPass | Windows crash kill、SSH link-loss during write |
| AT-ADMISSION-010 | Rust/TS admission constants、ROADMAP | default registration `AdmissionBlocked`；P0/P1/P2 blocked、P3 planned；generic execute/write=0 | automatedPass | Production 故意不可用 |

## 跨层 E2E 与隐私旁路

`agent-terminal-acceptance.e2e.test.tsx` 使用 deterministic in-process backend，固定从 strict snapshot/fixture 流经 UI action、六个 mocked narrow Tauri commands，再回到 backend authoritative snapshot。它覆盖：

- 首键原子 takeover、User 连续输入、归还与 capture rotation；
- ambiguous transport retry 的 exactly-once effect；
- approve/reject/expiry/replay/binding 和 single-use；
- 全 secret/TUI/unknown handoff 且无 approve；
- disconnect/reconnect/remount、pause/stop、不自动 reacquire；
- unknownEffect 不显示成功、结构化错误后强制 resync；
- generic write 调用 0，输入 synthetic raw secret 后 durable state、Zustand 和 DOM 中出现次数 0。

`scripts/check-agent-terminal-boundaries.mjs` 不是简单的全仓纯字符串搜索。它使用 TypeScript AST 分析 dedicated UI imports/calls/state interfaces，结构化抽取 Rust `generate_handler!`、`#[tauri::command]`、snapshot/audit structs 和 SQLite audit columns，并验证矩阵中的证据路径/测试符号存在。明确 allowlist 只有：

- 普通 `write_session` 的既有全局注册；它只服务 `UserTerminal`，SessionManager 对 `AgentPty` fail closed；
- 专用 xterm 读取不可变 theme/font/cursor display settings；
- 专用 xterm 的 output/status/ready/resize 显示通道；
- 既有 terminal theme resolver。

审计确认 Agent terminal 注册命令精确为 snapshot、resolve approval、takeover-and-write、return、pause、stop 六个；不存在 generic Agent raw write/execute。Audit schema 为固定 19 列 identity/digest/state metadata，没有 raw input/output、secret/token/credential/transcript 字段。

## Rust 实际执行与历史 deployment 基线

> 退役附记：以下 deployment 编译问题是本次验收发生时的原始记录。该功能随后从产品和代码中移除，不再构成当前 Rust 门禁或待修复项。

精确起点和最终工作树在不带兼容补丁时，`cargo check --tests --locked --message-format=short` 都因相同 30 个既有 deployment 源级错误失败：

| 类别 | 数量 | 文件 |
| --- | ---: | --- |
| SHA-256 result 不实现 `LowerHex` | 5 | `deployment_execution.rs`、`deployment_persistence.rs`、`deployment_rollout.rs`、`rollback_execution.rs` |
| rusqlite 不支持 `usize` ToSql/FromSql | 21 | `deployment_rollout.rs` |
| `ExecutionErrorCategory` match 非穷尽 | 2 | `deployment_execution.rs`、`rollback_execution.rs` |
| rollout statement lifetime | 2 | `deployment_rollout.rs` |

为实际执行 Agent tests，工作树曾两次使用同一最小 deployment-only compatibility patch：手工 digest hex、SQLite 边界 `usize`/`i64` 转换、补齐 enum match、延长 statement result 局部变量生命周期。它不修改 terminal 行为。每次运行后都用限定四文件 `git diff --exit-code` 验证为零；最终提交不包含该 patch。

兼容条件下，`cargo check --tests` 通过并实际运行：

| 命令/范围 | 实际结果 |
| --- | --- |
| `cargo test agent::terminal -- --test-threads=1` | 36 passed、0 failed |
| `cargo test terminal_lease -- --test-threads=1` | 4 passed、0 failed |
| `cargo test models::session_manager_tests -- --test-threads=1` | 14 passed、0 failed；包含 64 线程 takeover/write race |
| macOS real PTY exact smoke | 1 passed、0 failed |
| `cargo test --all-targets --locked -- --test-threads=1` | 加入 macOS smoke 前发现 537：520 passed、1 failed、16 ignored |

全量唯一失败为既有 `deployment_runbook::tests::serialization_is_canonical_and_revalidates_mutated_documents`，隔离重跑仍稳定失败：序列化 object key 顺序与测试期望不同。本阶段未修改 `deployment_runbook.rs`，也没有改变测试语义掩盖该失败。

## 前端、共享 fixture 与最终 gate

| 命令 | 结果 |
| --- | --- |
| `pnpm check:roadmap` | passed；P0 implemented，P1/P1 release/P1 admission blocked |
| `pnpm check:agent-terminal` | passed；六窄命令、5 dedicated files、19 audit columns、10 acceptance entries |
| `pnpm test:scripts` | 45/45 passed |
| `pnpm test` | 1317/1317 passed，166 files |
| `pnpm build` | TypeScript + Vite production build passed；只有既有 chunk-size warning |
| `pnpm review:frontend` | 上述完整链一次通过；未出现阶段 4 宿主时钟抖动 |

Rust 与 TypeScript 都消费 checked-in terminal protocol fixture；TS 还消费最终 acceptance fixture。固定 seed property corpus 覆盖 unknown field/enum/size、sequence monotonicity、terminal-state immutability、capture bounds/redaction/time limit，未引入重量级依赖。

## 平台证据分级

| 平台 | 实际状态 | 证据 | 不能据此声称 |
| --- | --- | --- | --- |
| macOS aarch64 本机 | platformPass（真实/半真实本地） | 真实 `portable-pty` + direct `/usr/bin/printf` 1/1；`tauri build --debug --no-bundle`；debug app 实际启动 5 秒，WebView/IPC/workspace load；xterm production bundle | 没有真实 Agent action、真实模型、任意 shell driver 或 SSH credential |
| Windows x86_64 | notRun | 现有 `windows-2025` CI matrix 已新增 Agent boundary audit 与定点 contract step；本阶段没有触发远端 job，本机只安装 `aarch64-apple-darwin` target | ConPTY/Job Object compile pass、CI pass、真机 pass 均不能声称 |
| SSH AgentPty | notRun / contractOnly | 既有 isolated SSH/SFTP CI 不创建 AgentPty；共享 ownership/coordinator fixture 不等同真实 SSH transport | 真实 SSH AgentPty、断链/重连、crash evidence 均不能声称 |

## 调用方与影响面审核

- Normal terminal：普通 `write_session` 注册不变；新增真实 PTY test 是 `cfg(target_os = "macos")` 的 test-only direct process；Agent dedicated path 不导入普通 terminal controller/store。
- Agent v1/v2：decision union 未加入 terminal action；`agent-terminal/v1` 仍是独立 typed proposal；P0/P1/P2 admission 未改。
- SFTP/SSH：没有修改 SFTP、connection、execution 或 SSH channel；现有 SSH/SFTP CI 不能冒充 AgentPty 证据。
- Deployment：本节只保留验收发生时的 30-error baseline 历史记录；该功能现已退役。
- App exit：既有 exit hook 的 lease revoke 加上 coordinator-after-revoke test；不自动 reacquire/write。
- i18n：没有新增或修改用户可见生产 copy，不需要 locale 变化。
- Workspace persistence：没有修改普通 terminal/SFTP persistence schema；AST/schema 审计证明 dedicated raw input、PTY transcript 和 lease counters 不进入持久状态。
- Executor/computer-use：没有修改 reviewed executor、没有 production driver、没有 generic execute/write/computer-use path。

阶段 5 的 UI 代码遵循仓库既有 shadcn primitives 与现有 Agent workspace 组合方式；没有新增 UI component 或设计系统依赖，主要变更为测试、store fail-closed 投影和证据收口。

## 未解决限制与退出条件

- 当前 Rust gate 已不再依赖退役的 deployment 源文件；该历史基线不属于后续 Agent 准入条件。
- Windows 必须取得实际 `windows-2025` CI 和真实设备 ConPTY/Job Object 的 ownership、takeover、crash、remount、secret persistence 证据。
- SSH 必须用隔离 fixture 创建真实专用 AgentPty，并验证 write ambiguity、断链、旧 epoch、reconnect no-reacquire；不得请求用户生产凭据。
- Production verifier 必须是独立只读结构化证据，并精确绑定 run/target/obligation；PTY output 永远不能单独满足 verification。
- 新 driver 或 prompt surface 需要独立 corpus 与安全评审；unknown、credential 和 TUI 默认继续 handoff。
- 开放 production 需要 P0/P1/P2 的独立准入结论和 P3 产品/安全评审。阶段 5 的 `automatedPass` 不构成开启 feature flag 的授权。

# AI Agent P1-E：Agent Workspace UI 验收证据

> 状态：implemented（生产 dynamic start 与 P1 总体仍 blocked）
>
> 基线提交：`eddab8ea3bbea20764644e95cf04b55c7eba16f0`
>
> 验收日期：2026-08-27
>
> 设计来源：`docs/ai-agent-p1-readonly-dynamic-agent-design.md`

## 1. 基线复核与阶段边界

实施前完整复核了 P1 设计、shadcn skill/项目约束、P1-0/A/B/C 的 versioned TypeScript/Rust 协议、共享状态机/预算、Agent manager/journal/IPC、model adapter、tool registry/policy/evidence，以及当前 production wiring。

当前生产 `AgentManager::default()` 仍只构造 `BlockedNoopAgentBoundary`；六个生命周期 IPC 已注册，但 `agent_start` 稳定返回 `p1Blocked` 且不创建 run。P1-D 在独立会话中因当前 SHA 缺少 Windows runner 真实证据而 fail-closed，没有 adapter、fixture 或提交。本阶段因此只实现 UI、前端 projection 和既有 IPC 的 strict typed client，不假设真实 adapter 存在。

本阶段没有实现或接入：

- `execute_reviewed_ssh_command` Agent adapter、raw SSH、`start_ssh_exec_channel` 或真实 Agent SSH fixture。
- PTY、`write_session`、terminal lease、SFTP、local process 或 generic/tool execute IPC。
- P1-F eval/release gate、P2 approval/修改工具或任何生产 dynamic execution wiring。

## 2. 实现映射

| 设计要求 | 实现位置 | 失败关闭边界 |
| --- | --- | --- |
| Agent Workspace 组件目录 | `src/components/ai/agent/` | 只组合现有 UI/chat primitives；不创建执行能力 |
| snapshot-authoritative projection | `src/stores/agentStore.ts` | v1 strict decode；未知版本/字段拒绝；event payload 不直接生成 UI 状态 |
| sequence/resync | `agentStore.ts`、`agent-workspace.tsx` | applied/gap 触发 snapshot；duplicate 不推进；terminal late event 忽略；stale snapshot 不覆盖 |
| mount/remount recovery | `agent-workspace.tsx` | 先 subscribe 后 snapshot；unmount 只 unlisten；已知 run ID remount resync |
| frozen target/policy/provider | `agentStore.ts`、`agent-run-header.tsx` | goal/target/provider/policy 变化或 terminal→nonterminal snapshot 被拒绝并显示 projection error |
| Header/Timeline/Plan | `agent-run-header.tsx`、`agent-timeline.tsx`、`agent-plan.tsx` | 只显示 backend snapshot；不展示 chain-of-thought |
| Tool Card | `agent-tool-card.tsx` | shell command 只显示 backend `commandPreview`；输出默认折叠；显示 capture/read/truncation/error metadata |
| Evidence/Report | `agent-evidence.tsx`、`agent-report.tsx` | evidence ID 只导航 backend snapshot evidence；verified/hypothesis 标记不自行升级可信度 |
| Composer/control | `agent-composer.tsx`、`agent-workspace.tsx` | Pause/Resume/Stop/answer/steering 只调用六个窄 IPC，等待 accepted result 后 snapshot resync |
| typed Agent IPC client | `src/lib/tauri.ts`、`src/lib/agent-protocol.ts` | start/action/snapshot/error strict decode；unversioned transport body不回显到 UI |
| static fallback | `src/stores/staticDiagnosticStore.ts`、`src/components/ai/agent-run-view.tsx`、`ai-panel.tsx` | 旧一次性 plan 明确命名为 static；需用户显式点击；不冒充 dynamic run |
| blocked/incompatible | `agent-workspace.tsx` | `p1Blocked`、provider incompatible 与缺失 profile 显式展示；生产 gate 不被前端绕过 |

## 3. 自动化验收矩阵

| 验收项 | 自动化证据 | 结果 |
| --- | --- | --- |
| gap / duplicate / late event | `agentProjectionStore.test.ts`、既有 `agent-events.test.ts` | gap 阻断并 resync；duplicate 不清除 pending resync；终态 late event 不覆盖 |
| mount / remount snapshot | `agent-workspace.test.tsx` | 调用顺序为 listen→snapshot；unmount unlisten；remount 使用已知 run ID 恢复 |
| frozen target / terminal regression | `agentProjectionStore.test.ts`、`agent-workspace.test.tsx` | snapshot 被拒绝并保留原绑定/终态；profile tab drift 显示 frozen target |
| budgets / all tool states / truncation | `agent-workspace.test.tsx`、`agent-tool-card.test.tsx` | duration/model/tool budget、8 个 tool state、exit/duration/bytes/truncation 与折叠输出均有覆盖 |
| Pause / Resume / Stop | `agent-workspace.test.tsx` | 仅窄 transport action；每次 accepted 后重新 snapshot |
| awaitingUser / steering / keyboard | `agent-workspace.test.tsx` | answer 与 steering 分类；Enter 发送、Shift+Enter 不发送；IME guard 由 composer 条件固定 |
| blocked / provider incompatible / static fallback | `agent-workspace.test.tsx`、`ai-panel.test.ts` | production block 与不兼容 provider 显式；fallback 必须用户点击；旧 guidance/composer 位置不回归 |
| evidence navigation / report / error / live region | `agent-workspace.test.tsx` | evidence link 聚焦目标 article；report/error/terminal state 与 polite live region 有覆盖 |
| strict IPC envelopes | `agent-protocol.test.ts`、`tauri.test.ts` | 六命令窄 envelope；unknown fields/action 被拒；untrusted error body 不回显 |
| Chat/Command/Explain/static/Remote Health | `src/components/ai/__tests__`、`remote-health-section.test.tsx`、`agentStore.test.ts` | 既有行为回归通过，static plan 仍不执行且可 handoff 到 Runbook review |

## 4. 门禁命令

- TypeScript：`pnpm exec tsc --noEmit`。
- 前端定点：Agent protocol/event/store/workspace/tool/AI Panel/Remote Health/tauri tests。
- 前端全量与 build：`pnpm review:frontend`。
- Rust：`cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check`、`cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --locked -- -D warnings`、`cargo test --manifest-path src-tauri/Cargo.toml --all-targets --locked --no-fail-fast`。
- Roadmap/audit：`pnpm check:roadmap`。
- 静态安全扫描：Agent UI/store/typed IPC 与生产 wiring 中检查 generic execute、raw SSH、PTY/`write_session`、adapter/orchestrator wiring 和 `BlockedNoopAgentBoundary`。
- 补充一致性：`git diff --check`。

实际结果：

- `pnpm review:frontend`：roadmap audit 通过；scripts 4 files / 39 tests passed；Vitest 150 files / 1208 tests passed；TypeScript 与 Vite production build 通过。
- `cargo fmt ... --check`：通过。
- `cargo clippy ... -D warnings`：通过。
- `cargo test ... --all-targets --locked --no-fail-fast`：402 passed、16 ignored、0 failed；ignored 均为需要显式隔离 Docker SSH/SFTP fixture 的既有测试，本阶段没有把它们作为 P1-D 真实证据。
- `git diff --check` 与安全扫描：通过。

提交哈希在本阶段提交完成后记录于交付报告；以上结果只证明 P1-E 本地实现，不得把 P1-E 或 P1 总体描述为 verified。

## 5. 安全边界结论

- 新 UI 不执行命令；它只展示 backend snapshot、发送 lifecycle/steering request，并在 event 后读取权威 snapshot。
- `src/lib/tauri.ts` 的 Agent client union 只有 `agent_start`、`agent_get_snapshot`、`agent_pause`、`agent_resume`、`agent_stop`、`agent_send_message`；没有 generic execute/tool command。
- static fallback 继续使用原一次性模型计划与 Runbook review handoff，不接 Agent execution kernel，也不会自动发送终端命令。
- 生产 wiring 未改变：`src-tauri/src/lib.rs` 继续 manage `AgentManager::default()`，manager default 继续绑定 `BlockedNoopAgentBoundary`。

## 6. 剩余阻塞

- 当前 SHA 没有 Windows runner 实跑证据，P0 只能是 `implemented（verification pending external）`。
- P1-D 准入核验已经 fail-closed，真实 adapter、direct/jump-host Agent fixture、cancel/timeout/output cap/target drift 联调均不存在。
- production dynamic Agent start 继续 `p1Blocked`；provider 无 strict JSON schema 时 UI 也失败关闭。
- P1 总体继续 `blocked`；本阶段没有开始 P1-F。

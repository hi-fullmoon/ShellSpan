# AI Agent P1-B：ModelAdapter 与 fake Agent loop 验收证据

> 状态：implemented（P1 总体仍 blocked）
>
> 基线提交：`e57efa84bcf4b8fc49823c00ded95fb5f8b07b4b`
>
> 验收日期：2026-08-27
>
> 设计来源：`docs/ai-agent-p1-readonly-dynamic-agent-design.md`

## 1. 本阶段边界

本阶段只实现三类 provider 的 provider-neutral strict `AgentDecisionV1` adapter、capability snapshot、最多一次 repair、request cancellation、stable/dynamic context builder、可测试单决策 orchestrator，以及 fake model/fake tools 多轮路径。

本阶段没有实现或接入：

- P1-C 的真实 tool registry、program-specific read-only policy、POSIX renderer、evidence ledger/final report evidence validator 或 Agent redactor。
- P1-D 的 `execute_reviewed_ssh_command` adapter、raw SSH、真实 Agent SSH fixture 或任何 `write_session`/PTY 路径。
- P1-E 的 UI workspace、事件投影或生产 dynamic Agent 入口。

`AgentManager::default()` 继续使用 `BlockedNoopAgentBoundary`。P1-B 的 HTTP adapter、orchestrator 和 fake tool seam 没有被 manager、IPC 或 `lib.rs` 构造；生产 `agent_start` 继续稳定返回 `p1Blocked` 且不创建 run。

## 2. 实现证据

| 设计要求 | 实现位置 | 失败关闭边界 |
| --- | --- | --- |
| 三类 provider adapter | `src-tauri/src/agent/model.rs` | OpenAI Responses、OpenAI Compatible Chat、Ollama 共享 checked-in v1 schema；native tool calls 不进入 decision path |
| capability snapshot | `src-tauri/src/agent/model.rs` | 冻结 provider ID/kind/base URL/model/capabilities；Compatible/Ollama 非 `jsonSchema` 时 `providerIncompatible` |
| strict schema 与 repair | `src-tauri/src/agent/model.rs`、`src-tauri/src/agent/orchestrator.rs` | decoder unknown/missing/extra action 失败；只允许一次通用 repair；第二次失败为 `failed(providerProtocol)` |
| request cancel 与有界响应 | `src-tauri/src/agent/model.rs` | cancellation 覆盖 HTTP send 和 response stream；provider envelope 上限 128 KiB；公开错误不回显 raw body |
| stable/dynamic context | `src-tauri/src/agent/context.rs` | observation 明确标为 untrusted；最近四条保留有界 excerpt，旧内容只有 bounded index；不重复完整历史 |
| 单决策 loop | `src-tauri/src/agent/orchestrator.rs` | 每次只应用一个 tool/askUser/final；repair 计模型预算；tool proposal 计 tool budget |
| steering/Pause/Stop | `src-tauri/src/agent/orchestrator.rs` | steering 使用 generation + cancellation 使 in-flight decision 失效；Pause/Stop 在状态机边界收敛；终态不可覆盖 |
| fake model/tools | `src-tauri/src/agent/orchestrator.rs` 的 `cfg(test)` | fake validation/execution seam 没有生产 registry、policy、evidence、redactor 或执行 adapter |

OpenAI Responses 请求采用官方 API 的 `instructions`、`input` 与 `text.format` structured output 形状；REST response 从 `output` 的 `output_text` content 读取，并兼容 SDK 风格的顶层 `output_text` helper 表示。参考：<https://developers.openai.com/api/reference/cli/resources/responses/methods/create>。

## 3. 关键验收路径

| 验收项 | 自动化证据 | 结果 |
| --- | --- | --- |
| 第二个 fake tool call 由首个 observation 决定 | `second_fake_tool_call_is_selected_from_the_first_observation` | `load=9.2` 选择第二个 `ps`；`load=0.2` 不调用 `ps` 而直接 final |
| 两类 tool variant 完整多轮 | `fake_host_inspect_to_shell_to_final_path_exercises_both_tool_variants` | `host.inspect → shell.execReadOnly(ps) → final`，且 shell 决策读取 host observation |
| steering 使 in-flight decision 失效 | `steering_invalidates_an_in_flight_decision_even_if_the_model_ignores_cancel` | 即使 fake model 忽略 cancel 并迟到返回 `systemctl restart`，decision 仍被 generation check 丢弃，tool 调用数为 0 |
| schema failure | `exactly_one_schema_repair_is_allowed_before_provider_protocol_failure` | 两次无效 JSON 只产生一次 repair；两次请求均计预算；终态 `failed(providerProtocol)` |
| provider timeout | `provider_timeout_has_a_stable_failed_terminal` | 终态 `failed(providerUnavailable)`；再次 drive 不改变 snapshot |
| tool denied 后替代 | `denied_fake_tool_is_observed_and_the_model_selects_an_allowed_alternative` | fake boundary 拒绝 `systemctl restart`，下一回合基于 denial 选择 `uptime` |
| askUser/answer | `ask_user_is_a_stable_boundary_and_the_answer_reaches_the_next_turn` | `awaitingUser` 为稳定边界，回答进入下一回合 dynamic context |
| thinking Pause | `pause_cancels_thinking_and_resume_uses_a_fresh_model_turn` | in-flight model request 被取消，进入 paused；Resume 使用新回合完成 |
| tool Pause/Stop | `pause_during_tool_waits_for_observation_while_stop_cancels_without_next_turn` | Pause 等当前 fake tool observation 原子完成；Stop 取消 fake tool、不创建 observation、不启动下一模型回合 |
| budget exhaustion | `budget_exhaustion_prevents_an_additional_model_request_and_is_terminal` | model turn 用尽后不再请求 provider，终态 `failed(budgetExceeded)` |
| 生产 gate | `production_noop_boundary_keeps_p1_blocked_without_creating_a_run` | `agent_start` 返回 `p1Blocked`，无 run |

## 4. 门禁结果

- Rust 定点：`cargo test --manifest-path src-tauri/Cargo.toml --locked agent:: --no-fail-fast`，40 passed。
- Rust 格式：`cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check`，通过。
- Rust lint：`cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --locked -- -D warnings`，通过。
- Rust 全量：`cargo test --manifest-path src-tauri/Cargo.toml --all-targets --locked --no-fail-fast`，378 passed、16 ignored、0 failed；ignored 项均为需显式 Docker fixture 的既有用例。
- Frontend/audit 全量：`pnpm review:frontend`，roadmap audit 通过，scripts 39 passed，Vitest 147 files / 1194 tests passed，TypeScript 与 production build 通过。
- 隔离 SSH/SFTP 回归：仓库 PowerShell wrapper 在当前 macOS 环境没有 `powershell` 可执行文件；按脚本完全相同的 compose/env/cargo 参数运行，15 passed、0 failed，随后移除 fixture containers、network 和 volumes。

## 5. 安全边界扫描

扫描范围为本阶段新增文件与生产 wiring：

- 新增 `context.rs`、`model.rs`、`orchestrator.rs` 不包含 `execute_reviewed_ssh_command`、`start_ssh_exec_channel`、`write_session`、`SessionManager`、`ssh2::`、`std::process::Command`、`tokio::process` 或 `tauri::command`。
- `manager.rs`、`ipc.rs`、`lib.rs` 没有引用或构造 `HttpAgentModelAdapterV1` / `AgentOrchestratorV1`，且三文件本阶段无 diff。
- `src-tauri/src/agent/{evidence,redaction,policy}.rs` 与 `src-tauri/src/agent/tools/` 不存在，证明 P1-C 未开始。
- `git diff --check` 通过；生产 blocked boundary 定点测试通过。

## 6. 剩余阻塞

- P0 仍是 `implemented（verification pending external）`，尚未满足 P1 真实执行准入；P1 总体保持 `blocked`。
- 本阶段没有真实 provider compatibility probe 或外部 provider 网络验收；只验证请求形状、capability gate、provider envelope strict decode 与 fake transport/control 语义。
- P1-C、P1-D、P1-E、P1-F 均未开始；fake observation 不是 evidence，fake denial 不是生产 read-only policy，fake final 也不替代 evidence ownership 校验。

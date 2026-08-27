# AI Agent P1-C：Tool registry、policy 与 evidence 验收证据

> 状态：implemented（P1 总体仍 blocked）
>
> 基线提交：`6b30390246e128ed0ae881a000a7b8d673264229`
>
> 验收日期：2026-08-27
>
> 设计来源：`docs/ai-agent-p1-readonly-dynamic-agent-design.md`

## 1. 复核基线与本阶段边界

实施前完整复核了 P1 设计及 P1-0/A/B 的提交链、调用方、共享协议、状态机、预算、manager/IPC wiring、provider adapter、context builder、orchestrator 和历史阶段证据。工作区起点干净，`HEAD` 为用户指定的 `6b30390246e128ed0ae881a000a7b8d673264229`。

复核没有发现需要先回退的已确认前序回归。P1-B 的 fake observation 没有 evidence/redaction，final decision 没有 ownership validator，正是设计明确留给 P1-C 的范围；生产 `AgentManager::default()` 仍只构造 `BlockedNoopAgentBoundary`。

本阶段只实现本地纯逻辑 registry/policy/redaction/evidence，并允许 orchestrator 在测试中接 registry + fake executor。本阶段没有实现或接入：

- P1-D 的 `execute_reviewed_ssh_command` adapter、raw SSH、真实 Agent SSH fixture、target revalidation 或 operation registry。
- 交互 PTY、`write_session`、`SessionManager`、本地/远端通用 process/exec IPC。
- P1-E UI workspace、前端事件投影或生产 dynamic Agent start。

P0 仍为 `implemented（verification pending external）`；生产 `agent_start` 继续稳定返回 `p1Blocked`，不创建 run。P1-C 完成不解除 P1 总体 gate，也不准入 P1-D。

## 2. 实现证据

| 设计要求 | 实现位置 | 失败关闭边界 |
| --- | --- | --- |
| 编译期 registry 与统一 definitions/dispatch | `src-tauri/src/agent/tools/mod.rs`、`context.rs` | 静态 `ToolDefinition` 同时生成 model schema 与选择 executor；policy/registry version 不一致、tool 未冻结启用或 definition/variant 不一致均 denied |
| 固定 `host.inspect` | `src-tauri/src/agent/tools/host.rs` | 只接受六种 enum field，映射为固定 probe enum；空、重复、未知 field 在协议/registry 双层拒绝，不接受 command/path/env/target |
| program-specific policy | `src-tauri/src/agent/policy.rs` | 13 个 program 各自 parser；Docker 默认关闭，只有冻结 capability 对应的本地 policy 才能启用 |
| 唯一 POSIX renderer | `src-tauri/src/agent/tools/shell.rs` | 只有 policy 成功后的规范化 program/args 才能生成 `ApprovedPosixCommandV1`；所有 word 单引号，内嵌单引号使用唯一 portable sequence |
| fake executor | `src-tauri/src/agent/tools/mod.rs` 的 `cfg(test)` support | executor 只收到 fixed probe plan 或 approved POSIX command；P1-C 没有 SSH/process/session 实现 |
| Agent generic redactor | `src-tauri/src/agent/redaction.rs` | 完整 byte chunks 重组后再匹配；覆盖 key/value、Bearer/Basic、private key、URL userinfo/query、connection string、AWS/GitHub/JWT/OpenAI token 和额外 literal |
| 同源 observation | `src-tauri/src/agent/evidence.rs`、`context.rs`、`orchestrator.rs` | raw fake output 先统一脱敏，再做 Agent 有界压缩与 digest；model/UI/event/evidence 从同一 immutable content 派生，不存在 raw model side channel |
| evidence ledger | `src-tauri/src/agent/evidence.rs` | 写入时绑定 run/target/source/tool call；其他 run、其他 target、source/tool 关系错误和重复 tool-call evidence 均拒绝 |
| final report validator | `src-tauri/src/agent/evidence.rs`、`orchestrator.rs` | unknown/foreign evidence、verified 无成功 evidence、likely 无 evidence、可识别 secret 均使 final 失败；`changes: [String; 0]` 与 validator 保证 P1 changes 永远为空 |

## 3. 首批 allowlist 与规范化边界

| Program | Allow | Deny / 强制规范化 |
| --- | --- | --- |
| `uname` | 空参数或固定 kernel/arch flags | unknown/重复 flag；`--all` 不与其他 flag 混用 |
| `hostname` | 空参数或单个 fqdn/short/domain/IP 读取 flag | positional hostname（可能修改）及未知 flag |
| `whoami` | 无参数 | 任意 argument |
| `id` | 当前用户的固定 uid/gid/groups/name/real/context flags | 任意 username、无 selector 的 name/real、重复/未知 flag |
| `date` | 当前时间、UTC、三种固定输出 format | set/date parsing 等任意输入 |
| `uptime` | 默认、pretty、since | 其他 flag/position |
| `df` | `-h/-P/-T`，path 仅 `/` 或后端冻结 known mount | 任意 path、其他 flag、重复 flag |
| `free` | 固定 unit flag | repeat/watch/count 与未知 flag |
| `ps` | 固定 columns，默认或 CPU/memory fixed sort | `aux`、任意 column/sort/filter/position |
| `ss` | 五个固定 summary/listen/socket snapshot query | kill/event/filter/unknown query |
| `systemctl` | `status/show/is-active/list-units` | 修改型 subcommand；status 强制 no-pager/lines=0/full，show 强制安全 properties，list-units 强制 no-pager/no-legend |
| `journalctl` | unit/boot/time/UTC/fixed output filter，lines `1..500` | follow、无 line bound、未知/修改型 flag；强制 no-pager |
| `docker` | capability 开启后仅 `ps/inspect/stats/logs` | 默认 disabled；exec/cp/run/start/stop/restart/kill/rm；stats 强制 no-stream/safe format，inspect 强制 safe fields，logs tail `1..500` 且禁止 follow |

所有 program 进入独立 parser 前还经过统一结构预检：拒绝 Unicode/ASCII control、newline、`;`、pipe、`&&`、重定向、command/process substitution、glob、environment assignment、shell `-c`、后台化/脱离会话、提权、修改程序、SSH key/history、`/proc/*/environ`、credential store 和 cloud metadata 读取结构。Quoting 不是授权依据，只是 policy 通过后的最后渲染层。

## 4. 关键验收路径

| 验收项 | 自动化证据 | 结果 |
| --- | --- | --- |
| definitions/dispatch 同一 registry | `model_definitions_and_dispatch_share_the_compile_time_registry` | 两个工具的 model schema 和 executor kind 均来自静态 registry，版本漂移失败关闭 |
| 每个 program/flag/subcommand allow table | `program_allow_deny_table_covers_every_first_wave_validator`、`every_allowlisted_flag_and_subcommand_has_an_explicit_allow_case` | 首批 13 program 的每个允许 flag/subcommand 均有显式 allow case |
| 修改/无界 deny table | `every_mutating_or_unbounded_subcommand_family_has_an_explicit_deny_case`、`denial_taxonomy_distinguishes_the_security_boundaries` | systemctl/docker 修改 family、journal follow/vacuum/rotate 等与其他未知 flag 均拒绝并保留稳定分类 |
| injection corpus | `security_injection_corpus_never_reaches_executor_or_produces_an_approved_command` | shell `-c`、控制符、控制操作符、重定向、substitution、后台化、提权、敏感文件/metadata、systemctl/docker 修改全部 denied；approved invocation 0，executor call 0 |
| 固定 host tool | `host_inspect_maps_only_enum_fields_to_fixed_probes`、`duplicate_fixed_fields_fail_closed` | 只生成固定 probe enum；重复/空 field 不进入 executor |
| POSIX quote | `the_single_posix_renderer_quotes_empty_space_unicode_and_single_quotes` | empty/space/Unicode/single quote 使用同一 portable renderer |
| fake executor dispatch | `approved_shell_dispatch_reaches_the_fake_executor_with_the_unique_rendering` | 只有 approved normalized command 到达 fake executor，rendered command 与实际 invocation 同源 |
| redaction cross-chunk/Unicode/URL/connection | `cross_chunk_reassembly_redacts_unicode_key_values_and_literal_secrets`、`private_keys_and_high_confidence_tokens_are_removed_after_unicode_chunk_splits`、`url_userinfo_connection_strings_and_query_secrets_are_redacted` | secret 跨 chunk、UTF-8 字节边界、private key、Unicode password、URL userinfo/query、SQL/Redis connection string 均不泄漏 |
| 同源 model/UI/event/evidence | `one_redacted_observation_is_the_identical_model_ui_event_and_evidence_source` | 三个 projection 共享同一 `Arc`，evidence content 逐字段相等，digest 基于脱敏数据 |
| orchestrator + registry + fake executor | `local_registry_fake_executor_creates_one_redacted_evidence_source_for_final_validation` | fixed `host.inspect → redacted evidence → verified final` 完成；model observation/evidence 内容和 digest 一致，raw secret 不在 snapshot surfaces |
| ownership/target/report | `ledger_rejects_other_run_target_and_duplicate_tool_ownership`、`final_validator_rejects_foreign_ownership_failed_verified_and_secret_text` | 其他 run/target、duplicate ownership、失败 evidence 冒充 verified、report secret 全部拒绝 |
| P1 changes 永远为空 | protocol shared decision fixture tests + `likely_requires_evidence_uncertain_may_be_explicitly_unverified_and_changes_are_unrepresentable` | 非空 JSON `changes` 无法 decode；Rust report 类型只能表示空数组，validator 再次检查 |
| 生产 gate | `production_noop_boundary_keeps_p1_blocked_without_creating_a_run` | `AgentManager::default()` 仍返回 `p1Blocked`，无 run |

## 5. 门禁结果

- Rust 定点：`cargo test --manifest-path src-tauri/Cargo.toml --locked agent:: --no-fail-fast`，64 passed、0 failed。
- Rust 格式：`cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check`，通过。
- Rust lint：`cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --locked -- -D warnings`，通过。
- Rust 全量：`cargo test --manifest-path src-tauri/Cargo.toml --all-targets --locked --no-fail-fast`，402 passed、16 ignored、0 failed；ignored 项均为需要显式 Docker SSH/SFTP fixture 的既有测试。
- Frontend/audit 全量：`pnpm review:frontend`，roadmap audit 通过，scripts 39 passed，Vitest 147 files / 1194 tests passed，TypeScript 与 production build 通过。
- `git diff --check`：通过。

## 6. 安全边界扫描

- P1-C 新增/修改的 registry、policy、host/shell tool、redaction、evidence、context 和 orchestrator 不包含 `execute_reviewed_ssh_command`、`start_ssh_exec_channel`、`write_session`、`request_pty`、`SessionManager`、`ssh2::`、`std::process::Command`、`tokio::process`、raw `.exec(` 或 `#[tauri::command]`。
- 整个 `src-tauri/src/agent/` 只有 P1-A 已有的六个窄 lifecycle IPC 使用 `#[tauri::command]`；没有 generic execute/tool IPC。
- `src-tauri/src/agent/{manager,ipc}.rs` 与 `src-tauri/src/lib.rs` 没有引用或构造 `AgentToolRegistryV1`、`AgentOrchestratorV1` 或 `HttpAgentModelAdapterV1`。
- `src-tauri/src/lib.rs` 继续 `.manage(agent::manager::AgentManager::default())`；`Default` 继续只绑定 `BlockedNoopAgentBoundary`。
- 本阶段未修改 `src-tauri/src/execution/`、`runbook.rs`、真实 SSH fixture、前端 store/component 或 Tauri command 注册表。

## 7. 剩余阻塞

- P0 仍是 `implemented（verification pending external）`，未满足 P1-D 准入；没有把 approved POSIX command 接到任何真实执行边界。
- P1-D 的 P0 adapter、direct/jump-host Agent fixture、cancel/timeout/output cap/target drift 联调均未开始。
- P1-E UI workspace 与真实 event projection 尚未开始；P1-C 只冻结了可供 model/UI/event/evidence 共用的后端 observation source contract。
- P1 总体继续 `blocked（P0 verification gate）`；本阶段提交不得描述为 P1 verified，也不授权任何修改型工具或 P2 行为。

# AI Agent P1-F：Eval、文档与发布门禁验收记录

> 状态：implemented（P1 总体仍 blocked）
>
> 基线提交：`783c8c9526b2be007335725a3dd370dfc6200eed`
>
> 日期：2026-08-27

## 1. 基线复核与范围

实施前完整复核了 `docs/ai-agent-p1-readonly-dynamic-agent-design.md`、P1-0/A/B/C/E 提交链及实际协议、状态、manager/IPC、provider adapter、orchestrator、registry/policy、redaction/evidence 和 Workspace UI。工作区起点干净且 HEAD 为用户指定提交。

| 阶段 | 复核提交/来源 | 复核结论 |
| --- | --- | --- |
| 设计 | `docs/ai-agent-p1-readonly-dynamic-agent-design.md` | P1-F 只闭合 eval、说明、audit 和发布门禁；P1-D 准入与 P1 12 项退出条件不得绕过 |
| P1-0 | `6141e7a8aff6596d25b2c51d9b51bf698fa9ec9f` | v1 decision/run/event/error/evidence 协议、strict decode 与共享 fixture 已冻结 |
| P1-A | `e57efa84bcf4b8fc49823c00ded95fb5f8b07b4b` | `AgentManager`/journal/snapshot 是权威控制面，生产 boundary 仍失败关闭，IPC 仅六项 lifecycle |
| P1-B | `6b30390246e128ed0ae881a000a7b8d673264229` | 三 provider envelope/capability 兼容路径与 fake observation-driven loop、预算和控制终态已有自动化 |
| P1-C | `eddab8ea3bbea20764644e95cf04b55c7eba16f0` | 编译期 registry、program-specific read-only policy、同源脱敏、evidence ownership 与空 `changes` 已建立 |
| P1-E | `783c8c9526b2be007335725a3dd370dfc6200eed` | snapshot-authoritative Workspace、完整 tool/evidence UI 与显式 static fallback 已实现，dynamic start 仍返回 `p1Blocked` |
| P1-D | 独立门禁结论（无 adapter 提交） | P0 未 verified 且当前提交无 Windows runner 真实证据，故不准入；缺失 adapter/direct/jump fixture/真实演示必须继续记为 blocked |

独立 P1-D 结论保持失败关闭：当前 SHA 没有 Windows runner 真实结果，P0 在 Roadmap/audit 中仍为 `implemented（verification pending external）`，所以 P1-D 不具备准入条件。本阶段没有实现 adapter、没有让 Agent 连接真实 SSH、没有新增 generic execute/tool IPC、raw SSH、PTY、`write_session` 或本地 process 路径，也没有把 P1/P1-D 改成通过。

## 2. 固定诊断 eval

版本化 fixture 位于 `tests/fixtures/agent-evals/v1/diagnostic-scenarios.json`，由 `src-tauri/src/agent/eval.rs` 的 test-only harness 消费。Harness 使用 strict decision decoder、编译期 registry、生产 read-only policy、生产 orchestrator/evidence ledger 和 scripted fake executor；它不连接网络或执行系统命令。

| 类别 | observation-driven 路径 | 预期结果 | Evidence |
| --- | --- | --- | --- |
| CPU | `host.inspect → uptime → ps` | diagnosed | load 与热点进程引用同 run/target evidence |
| 磁盘 | bounded `df /` | diagnosed | 只确认 mount 压力，不扫描任意目录 |
| 内存 | `free → ps --sort=-%mem` | diagnosed | 区分 available/cache 与进程用量；fixture secret 被脱敏 |
| 服务 | `systemctl show → journalctl --lines 50` | diagnosed | 状态与 bounded 日志共同引用 |
| 端口 | `ss -ltnp → systemctl is-active` | diagnosed | listener 与服务状态共同引用 |
| 可选容器 | capability-gated `docker ps/stats/logs --tail` | diagnosed | 一次性 stats 与 bounded logs；无 exec/follow |
| 信息不足 | `askUser → inconclusive` | inconclusive | 不扩大权限、不调用工具、无伪造 evidence |

每个场景连续运行两次并比较规范化结果，包括终态、预算、工具序列、evidence/run/target/exit 绑定、finding 引用、outcome、askUser 与 `changes`；时间戳不参与确定性比较。Fixture 还冻结 strict JSON Schema/no-native-tools provider compatibility、逐回合 fake input/output token accounting 和 1 秒 harness 延迟上限；steering、Pause/Stop、provider timeout 与 budget exhaustion 由同一 Rust 全量门禁中的具名确定性测试提供控制面证据。

## 3. 安全 adversarial corpus

`tests/fixtures/agent-evals/v1/adversarial-corpus.json` 固定 21 项：shell `-c`、服务修改、follow/watch、后台化、SSH key、`/proc/*/environ`、cloud metadata、pipeline、重定向、两类 substitution、提权、Docker exec/follow、环境注入、控制字符、glob、kill、package install、不安全 systemctl property，以及来自不可信工具输出的 prompt injection。

每项先核对 program-specific denial taxonomy，再通过 fake model → registry/policy → orchestrator 运行。恶意 proposal 到达 fake executor 的次数为 **0**，报告非空 `changes` 次数为 **0**。Prompt-injection 用例仅允许一次预先定义的只读 `uptime` observation；其中的“restart”文本仍被视作不可信数据，后续修改提案被拒绝。

## 4. 用户可见说明

- Workspace 启动前双语提示明确只读范围、独立 Exec、同源输出隐私和 Pause/Stop/退出/崩溃限制。
- Tool Card 继续逐项说明独立 Exec 不继承 cwd/env/alias/history，输出详情只展示脱敏内容。
- `docs/ai-agent-readonly-user-guide.md` 提供完整边界说明；Timeline 保留 Stop 对 detached process 的有限保证。

## 5. 稳定状态与回归证据

| 行为 | 自动化证据 | 确定结果 |
| --- | --- | --- |
| provider timeout/error/schema repair | `agent/model.rs`、`agent/orchestrator.rs` | `failed(providerUnavailable/providerProtocol)`，终态不可覆盖 |
| budget exhaustion | `agent/budgets.rs`、`agent/orchestrator.rs` | 不启动额外 model/tool，稳定 `failed(budgetExceeded)` |
| steering | `agent/orchestrator.rs` | in-flight decision 失效；新约束进入下一回合 |
| Pause/Resume | `agent/orchestrator.rs` | thinking 取消；tool observation 原子提交后 paused；Resume 使用新回合 |
| Stop | `agent/orchestrator.rs`、`agent/manager.rs` | model/tool 取消，无下一回合，稳定 cancelled |
| Panel remount/event disorder | manager、event/store/workspace tests | snapshot 恢复；gap resync；duplicate/late 不覆盖 |
| report/evidence/changes | evidence/protocol/eval tests | foreign/failed evidence 拒绝；verified 引用有效；changes 恒空 |
| Chat/Command/Explain/static fallback | AI Panel/旧 Agent tests | 既有路径保留，dynamic blocked 时显式 fallback |

## 6. P1 十二项退出条件结论

逐项可机读证据见 `docs/roadmap-audit.json` 的 `p1ReadonlyDynamicAgent.exitCriteria`，并由 `scripts/check-roadmap-audit.mjs` 强制与设计第 25 节精确、按序映射。

- `blocked`：第 1 项 P0/Windows；第 6 项真实 P1-D adapter；第 10 项 Windows、P1 direct/jump fixture 与真实演示。
- `verified`：第 2–5、7–9、11–12 项，对应 manager/snapshot、动态 fake loop、三 provider 兼容/降级、registry/policy、安全与 redaction/evidence、控制终态、报告引用/changes、安全 corpus 0 副作用和用户说明。

因此最终 P1 状态必须保持 `blocked（P0 verification gate；P1-D/Windows/真实 Agent SSH 证据缺失）`。本阶段完成不构成 P2 准入。

## 7. 最终门禁记录

| 命令 | 结果 |
| --- | --- |
| `cargo test --manifest-path src-tauri/Cargo.toml --locked agent::eval --no-fail-fast` | 通过：P1-F eval 3/3；七类场景可重复，21 项 corpus 未授权 executor 命中 0、非空 changes 0 |
| `pnpm test` | 通过：150 个 test files、1213 个 tests；包含 Chat/Command/Explain/static Diagnostic Plan、Agent Workspace/store/protocol 与 Remote Health 回归 |
| `pnpm test:scripts` | 通过：4 个 test files、43 个 tests；包含 P1 roadmap/release fail-closed 变异用例 |
| `pnpm build` | 通过：TypeScript 与 Vite production build；仅保留既有 chunk-size warning |
| `cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check` | 通过 |
| `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --locked -- -D warnings` | 通过 |
| `cargo test --manifest-path src-tauri/Cargo.toml --all-targets --locked` | 通过：405 passed、0 failed、16 ignored；ignored 为显式隔离 fixture/benchmark |
| `pnpm check:roadmap` | 通过：P0=`implemented`、P1=`blocked`、P1 release=`blocked`、P1 admission=`blocked` |
| `git diff --check` | 通过 |
| 隔离双 sshd `cargo test ... isolated_ssh_sftp_end_to_end -- --ignored --nocapture --test-threads=1` | 通过：15/15；direct SSH/SFTP、P0 reviewed direct/jump Exec、cancel/timeout/output/redaction、port forward、Remote Health 与 Runbook 回归 |

隔离 SSH/SFTP fixture 只表示既有 P0/SSH/SFTP 路径在本机 Docker Linux 双 sshd 环境无回归。Agent 没有进入该 fixture，也没有 P1 adapter，因此它不是 P1-D 真实 adapter、Windows runner 或 P1 演示证据。

# Agent 可视终端执行 Phase 1 验收记录

> 对应设计：`agent-visible-terminal-execution.md` 第 16 节
> 验收日期：2026-09-10
> 当前结论：代码与自动化门禁已具备；Windows ConPTY 与 Docker SSH POSIX 已实际执行，本机不具备的本地 POSIX 和完整桌面人工观察项仍须在发布候选包上完成。

## 1. 发布范围与 rollout 决策

首版仍只支持用户显式选择的、前台、非交互、单命令执行。新 Session 和缺少字段的历史 Session 均默认 `direct`；`boundTerminal` 只能由用户在 terminal-scoped Agent composer 中显式选择，且选择会冻结到 Session Header。这个显式选择、历史默认值和 Session 冻结已经构成首版 rollout 边界，因此本轮不再增加环境变量或隐藏 feature flag，避免出现第三套状态来源。

诊断日志只记录 terminal session、Agent Session、task、operation 和释放原因，不记录命令或输出。关键日志为：

- `Agent terminal lease acquired ...`
- `Agent terminal frontend ready ...`
- `Agent terminal frontend rejected lease ... reason=<stable error>`
- `Agent terminal lease rejected as busy ...`
- `Agent terminal lease released ... reason=<terminal state>`
- 主窗口销毁时的 native operation 清理数量或失败原因

## 2. 第 16 节验收矩阵

| 验收标准 | 自动化证据 | 仍需人工证据 | 状态 |
| --- | --- | --- | --- |
| 用户显式选择可视终端执行 | `ai-workspace-controller.test.tsx` 的 `freezes the selected visible-terminal surface...`；`session.rs` 的历史默认与恢复测试 | 在 RC 中确认新会话初始选择为“后台执行” | 自动化通过，人工待 RC |
| 命令和输出在绑定终端实时可见 | 平台真实 PTY 测试把 production wrapper 的 display chunk 逐块送入展示流；前端 coordinator/filter 测试验证同 operation 订阅 | 三个平台各观察一次长达 3 秒、分三行输出的命令 | 自动化通过，人工待多平台 |
| 屏幕不出现 wrapper 和认证 marker | parser 任意 chunk 矩阵；Windows ConPTY、本地 POSIX、Docker SSH POSIX 的真实协议流均断言 display 不含 marker/`__ss_` | 三个平台复制全部可见终端文本并搜索 `shellspan_native_`、`__ss_`、`:BEGIN:`、`:END:` | Windows/SSH 自动化通过；本地 POSIX 待对应 runner |
| 退出码与工具结果一致 | parser chunk matrix（23）、wrapper tests（7）、真实 PTY/SSH tests（7） | 在 RC 中执行成功与非零退出各一次并核对工具卡 | 自动化通过，人工待 RC |
| 不发生用户与 Agent 输入拼接 | 后端 lease typed-input 测试；前端半行、未确认提交和 ready gate 拒绝测试 | 在已有半行及刚提交未出输出时尝试可视执行 | 自动化通过，人工待 RC |
| 一次动作中断并接管 | takeover 单次提交、Ctrl-C、operation owner 与状态条/Escape 测试 | 执行有界 `sleep` 后按 Esc，确认输入恢复且 Agent 不重试 | 自动化通过，人工待 RC |
| 所有终止路径释放 lease | cancel、timeout、takeover、terminal close/disconnect、shutdown、重复清理、Runtime restart 内存失效；主窗口 `Destroyed` 清理 | 强制断网、关闭 terminal、销毁主窗口、重启应用各一次 | 自动化覆盖状态机；系统级人工待 RC |
| 可视模式不绕过权限审批 | Runtime 测试断言 durable approved event 早于 dispatched，拒绝/取消时 native execution 为 0 | requestApproval 下拒绝一条有副作用命令 | 自动化通过，人工待 RC |
| `direct` 模式稳定 | native adapter 按 Session 中显式记录的 `direct` 执行；前端 direct terminal 无 lease UI/filter | direct 模式执行一条命令并确认绑定 terminal 无合成行 | 自动化通过，人工待 RC |
| 本地 POSIX、远程 POSIX、Windows ConPTY 端到端 | `local_posix_pty_visible_command_protocol_is_end_to_end`（POSIX runner）；`remote_ssh_posix_visible_command_protocol_is_end_to_end`（Docker）；`windows_conpty_visible_command_protocol_is_end_to_end` | macOS 与 Linux RC 各跑一次完整桌面流程 | Windows 与 SSH 已实跑；本地 POSIX 未在本机执行 |
| 敏感输出不会未经脱敏进入模型或持久事件 | Rust `bound_terminal_result_is_redacted_before_model_context_and_session_persistence` 同时检查下一次模型 request、内存事件与 JSONL；command display 预发布脱敏测试 | 用 fixture secret 检查导出日志与模型调试视图 | 自动化通过，人工待 RC |

## 3. 可重复运行的自动化门禁

当前平台的 Rust/前端门禁：

```text
pnpm test:agent-visible-terminal
```

连同隔离 Docker SSH fixture：

```text
pnpm test:agent-visible-terminal:ssh
```

SSH 脚本只启动并最终关闭 `tests/ssh-e2e` 的两个专用容器。远程测试也可单独运行：

```text
docker build -t shellspan-ssh-e2e:local tests/ssh-e2e
docker compose -f tests/ssh-e2e/compose.yml up -d --wait
cargo test --manifest-path src-tauri/Cargo.toml agent_runtime::native::pty::tests::remote_ssh_posix_visible_command_protocol_is_end_to_end --lib -- --ignored --exact --nocapture
docker compose -f tests/ssh-e2e/compose.yml down
```

平台 gated 测试只在对应 runner 上编译和执行：Windows 使用真实 ConPTY/PowerShell；Linux/macOS 使用真实 PTY 与 `/bin/sh`。不能用 Windows 上的 Docker SSH 成功替代本地 Linux/macOS 桌面验证。

## 4. 发布候选包手工步骤

每个平台使用 `requestApproval` 新建 Agent Session，并显式选择“可视终端”。测试命令不得包含真实凭据。

1. 执行一个每秒输出一行、三秒后以 7 退出的非交互命令。确认输出逐步出现、工具结果为 7、复制出的屏幕文本没有协议内容。
2. 在 terminal 中先输入半行但不回车，再请求 Agent 执行；随后提交一条用户命令但在输出确认前再请求一次。两次都应在 wrapper 写入前拒绝。
3. 让 terminal 停在 password、passphrase 和 host-key confirmation fixture prompt。可视执行必须拒绝，Agent 不得回答 prompt。
4. 执行产生超过 1 MiB 输出的有界命令。xterm 应继续显示并经历高低水位暂停/恢复；工具结果应标记截断，UI 不死锁。
5. 对有界 `sleep` 分别触发 Agent Stop、timeout、按钮 takeover、Esc takeover、terminal disconnect/close、主窗口销毁、应用 shutdown/restart。每次确认状态条消失、用户输入恢复、同 terminal 可再次申请 lease。
6. 在命令即将完成时同时 takeover，重复 20 次。只允许一个终态，不能重复发送或释放下一 operation。
7. 第一个 Agent 占用 terminal 时启动第二个 `boundTerminal` Agent。第二个应立即收到 `TERMINAL_LEASE_BUSY`，不能排队后静默执行。
8. 用仅存在于 fixture 的假 secret 作为命令参数和输出。检查终端显示符合用户原本可见范围，而工具结果、下一次模型请求、Session JSONL/导出日志均只含 `[REDACTED]`。
9. 重复第 1 步但保持默认“后台执行”。绑定 terminal 不应出现 Agent 合成行或 lease 状态条，审批顺序仍保持不变。

## 5. 首版明确不支持

本发布不得宣称支持 TUI（如 `vim`、`top`、`less`）、REPL/数据库控制台、password/passphrase/OTP 等秘密 prompt、长期后台任务或完整继承交互 shell 的 alias/function/未导出变量。未知本地 shell 会拒绝可视执行；未知远程 shell 会在隐藏 capability probe 后拒绝。首版没有 `wait_terminal`、`write_terminal_input` 或任何通用半交互接口。

## 6. 已知风险与非本阶段问题

- `recovery_reconciliation_uses_the_checkpoint_step_when_call_ids_repeat` 的既有 call-id 失败按项目约束保留，不在本阶段修复。
- Runtime 在已 dispatch、未持久化结果时重启会进入“结果不确定、必须 reconciliation”的安全恢复边界，不会重放命令或伪造成功；进程重启后的内存 lease 不会存活。
- 完整桌面窗口销毁、系统断网和 macOS/Linux 本地 PTY 的用户可见行为仍需各平台 RC 手工签字；自动化测试不能替代视觉和操作系统生命周期验证。

## 7. 本次实际执行记录

执行主机为 Windows x64；Docker Desktop 提供隔离 Alpine SSH server。实际结果：

- `pnpm test:agent-visible-terminal:ssh`：通过；包含 6 个 lease 测试、16 个当前平台 PTY 测试（另 1 个 SSH fixture 测试在普通轮次按设计忽略）、模型/持久化脱敏测试、restart 不重放测试、178 个定向前端测试，以及单独启用后通过的 Docker SSH PTY 测试。fixture 容器和 network 已由脚本关闭。
- `cargo test --all-targets`：690 通过、27 忽略、1 失败；唯一失败为已知的 `recovery_reconciliation_uses_the_checkpoint_step_when_call_ids_repeat`，差异仍是 `call-1` 对哈希化 call-id。
- `cargo test --all-targets -- --skip agent_runtime::runtime::tests::recovery_reconciliation_uses_the_checkpoint_step_when_call_ids_repeat`：690 个 lib 测试通过、27 忽略、1 过滤；5 个 `petdex_contract_probe` integration tests 通过，其余 targets 通过。
- `pnpm test`：190 个 test files 通过、1 个跳过；1715 个 tests 通过、1 个跳过。
- `pnpm build`：通过；保留既有的大 chunk 提示，没有构建错误。
- `cargo fmt --all -- --check`、`cargo check --all-targets`：通过。

本机没有执行 macOS/Linux 本地 PTY 测试，也没有进行完整桌面 RC 的视觉与窗口/断网生命周期手工操作；这些项目不能标记为已验证。

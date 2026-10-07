# macOS 阶段 5 真实开发工作流

测试入口为 `src-tauri/src/agent_runtime/tests/developer_workflow.rs`，通过既有原生测试模块的真实 PTY 身份、Session、审批、签发与 Seatbelt 执行链运行，不使用模型或 backend 替身。

公网测试必须显式运行：

```bash
cargo test --manifest-path src-tauri/Cargo.toml developer_workflow::approved_locked -- --ignored
```

每项创建独立临时工作区与空缓存，临时目录由 tempfile 管理。项目锁文件由真实包管理器生成并复制到临时项目；安装后断言锁文件字节不变、代理实际连接大于零、代理已关闭、源 PTY 写入为零，下载的依赖实际执行。

- pnpm：真实 `is-number@7.0.0`；执行 `pnpm install --frozen-lockfile` 后运行生产依赖；只批准 `registry.npmjs.org:443` 与独立 store 写路径。
- Cargo：真实 `itoa@1.0.15`；执行 `cargo fetch --locked` 后 `cargo run --locked --offline`；只批准 `index.crates.io:443`、`static.crates.io:443` 与独立 Cargo home。请求显式使用 Cargo 标准 `CARGO_HTTP_PROXY` 配置接入已有 Unix SOCKS5 代理，不能据此宣称任意客户端自动兼容。
- 解析器为显式批准并签名的 cloudflare 选项；TCP 只承诺 host/port/实际地址边界，不检查 HTTPS 内容或路径。

锁文件准备发生在宿主，仅准备真实元数据，不计受限安装成功；通过结论来自冷缓存中的实际受限下载和执行。未开放全网络，没有改用户 lock、node_modules、系统网络或凭据设置。

本模块的会话授权隔离与日志诊断测试单独执行，不进行公网下载：

```bash
cargo test --manifest-path src-tauri/Cargo.toml developer_workflow -- --skip approved_locked
```

结果及未覆盖范围见 `docs/design/agent-shell-sandbox-phase-5-acceptance.md`。不要把某两项通过改称整文件或整个阶段通过。

## 独立真实 Wry 关闭验收

macOS debug-only 的既有 native-agent-check 入口，在模型配置初始化之前按 `SHELLSPAN_NATIVE_SHUTDOWN_CHECK` 分流。每次必须提供新的空绝对目录；不读取用户模型或 credential vault，不调用模型，不使用替身。

模式为 `normal`、`undrained`、`exit-active`。前两个分别验证正常关闭和真实 lease 未排空时错误/门禁保留；第三个在真实后台和 Node 服务仍运行时，通过实际 AppExit 首次关闭和清理。三个模式都使用同一生产 Runtime / engine / NativeToolAdapter 与 AppExit 回调。

```bash
cargo build --manifest-path src-tauri/Cargo.toml
SHELLSPAN_NATIVE_SHUTDOWN_CHECK=exit-active src-tauri/target/debug/ShellSpan --native-agent-check /absolute/new-empty-fixture-directory normal
```

该命令中的最后一个 `normal` 是既有 CLI 参数；实际关闭场景由 debug-only 环境模式选择，不改变用户的执行策略。报告为 fixture 内的 `shutdown-check.json` 和 `app-exit-events.json`，opaque token 仅在内存中使用，不导出。成熟 Tauri `run_return` 保留真实事件并让验收完成原子报告交付，不修改生产退出行为。

`passed=true` 代表对应断言正确。`undrained` 预期真实 `shutdownOutcome.confirmed=false`，不能把该报告解释为成功排空；一次 race 实际为 gateRejected 时，不推导所有并发分支已覆盖。当前不包含子 Agent Registry/driver 的完整门禁验证或实际版本回退。

## 两个真实 App 的正常退出恢复

使用新的空绝对 fixture 目录运行 `restore-seed`；确认其报告通过、真实 Exit 事件和原 PID 消失，再对完全相同目录运行 `restore-reopen`。reopen 代码也检查 seed PID 不能仍存在。

```bash
SHELLSPAN_NATIVE_SHUTDOWN_CHECK=restore-seed src-tauri/target/debug/ShellSpan --native-agent-check /absolute/new-empty-fixture-directory normal
SHELLSPAN_NATIVE_SHUTDOWN_CHECK=restore-reopen src-tauri/target/debug/ShellSpan --native-agent-check /absolute/new-empty-fixture-directory normal
```

目录内 `state` 保存生产数据库、journal、checkpoint、preferences；`project` 和 `cache` 是独立兄弟目录，不允许 Agent 修改应用状态。真实公开 Runtime/NativeAdapter 路径创建会话、资源审计和未暂停用户队列，正常实际 AppExit 清理；第二进程实际 configure 回放策略/元数据、暂停恢复队列、无旧授权并要求新 explicit approval才执行。新进程按生产公共 async probe 运行真实 OS preflight，无模型初始化或替身。

只保存 `restore-seed.json` / `restore-reopen.json` 非敏感事实与对应 events；live bearer只留 seed 内存并在关闭后验证拒绝，不写文件移交。正常恢复通过不等于模型 WaitingApproval/dispatched-unknown、hardcrash、远端/child/UI全部恢复通过；对应未覆盖项目仍在阶段5报告中保留。

## 实际 pipeline 中断恢复

`model-waiting-seed` 使用当前用户选定的真实 MiniMax-M3 driver，新请求达到实际 AssistantToolCall/WaitingApproval；`model-waiting-reopen`恢复真实driver记录并取消旧restricted审批。只允许既有明确授权的default route及该credential reference，没有其他secret读取或替身。若 default改变/认证不可用/请求0，不算模型验收通过。

`pipeline-unknown-seed` 是固定structured protocol输入，真实生产pipeline批准、派发和 owned marker，命令仅sleep6自限；`pipeline-unknown-reopen`恢复uncertain门禁、基于真实文件/已结束进程证据人工reconcile后新explicit请求。这个模式没有生成模型回合或resident LLM自动恢复。

seed发布 `pipeline-ready.json`（不是pass报告）；必须用 `interrupt_owned_pipeline.py` 核对实际PID/starttime/全argv/freshroot/identifier和unknown实时marker，才仅对ownApp SIGKILL。脚本从不按basename杀进程、从不向descendant发送信号。记录的own descendants须在自然终态并核对starttime/cwd后才reopen；代码也拒绝仍存活的原进程。所有report无bearer，失败journal不得人工改写。使用新独立root执行新增case，不能中断别的活fixture、用户App或旧标记反例。

没有driver AssistantMessage的早期 `pipeline-waiting`协议fixture不能代表真实模型等待恢复；它的失败记录保留，不通过伪造AssistantMessage/LlmResponse修复。各exact scene报告和所有仍未覆盖范围以phase5验收记录为准。

`model-unknown-seed/reopen` 是独立的真实MiniMax-M3生成与residentDriver恢复场景：精确自有printf/sleep6/printf请求批准一次，actualdispatch/started后onlyownApp身份核对中断；own子进程自然结束后同dataRoot用公开Runtime.start恢复模型绑定，uncertain先阻止继续，human实际证据reconcile后真实driver的新模型请求应只简短完成、不重复旧效果。任何额外工具副作用不批准；报告根据实际RequestStart/TurnEnd/文件/PID事实判断，不能把protocol10代替它或私改Driver状态。此finitefocusedcase不推广所有模型、平台或并发压力。

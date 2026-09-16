# Agent 终端执行 Windows 发布说明

> 状态：Phase 6 Windows 首发范围
> 更新：2026-09-16
> 协议依据：`protocol/agent/runtime/terminal-protocol-rfc.md`
> 后续：macOS 已通过独立验收并启用，见 `agent-terminal-execution-macos-rollout.md`。

## 用户可见行为

Windows 本地终端在新建连接上默认启用 Terminal Session Broker、
PowerShell shell integration、wrapper-free `terminal_execute` 与交互终端工具。
可视终端命令会原样提交给当前 Windows PowerShell 5.1 或 PowerShell 7
交互式 shell，因此目录、环境变量、alias、函数和提示符状态会留在同一个
shell 中；终端显示真实回显，不再生成 `[Agent]` 命令行。

如果集成不支持、初始化失败、已被回滚或终端不在可确认的提示符边界，
Windows 本地可视命令会明确显示为不可用或降级。用户可以切换到“直接执行”；
运行时不会把这次操作静默改发给旧 wrapper，也不会在两条路径之间重放命令。

`direct` 与 `boundTerminal` 两个 Session 存储值保持不变，历史 sessions-v5
日志无需改写。Direct 的 stdout/stderr、退出状态、后台 handle、stdin、wait、
kill、超时、取消和恢复语义不依赖终端 rollout。

## 平台边界

- Windows 本地 ConPTY：新路径默认开启；旧 wrapper 已从本地路由移除。
- macOS 本地 PTY：已在后续独立验收中默认开启；此 Windows 首发记录不提供其证据。
- Linux 本地 PTY：新路径仍默认关闭，compatibility wrapper 保留。
- SSH/remote：专用 Agent SSH PTY 与交互工具仍默认关闭，compatibility wrapper
  保留；Windows 本地发布不能替远端或其他平台提供验收证据。
- `exec_command.channel = "pty"` 仍可解码旧协议记录，但 Windows 本地目标会拒绝
  执行并要求使用 `terminal_execute` 或 Direct。远端与非 Windows 的兼容实现不受影响。

## 回滚

环境变量只由后端可信配置读取，不写入 Agent Session 或终端工作区。Windows
默认值可依次用以下变量设为 `off` 回滚：

1. `SHELLSPAN_TERMINAL_INTERACTIVE_TOOLS_V1`
2. `SHELLSPAN_TERMINAL_EXECUTE_V1`
3. `SHELLSPAN_TERMINAL_SHELL_INTEGRATION_V1`
4. `SHELLSPAN_TERMINAL_BROKER_V1`

回滚只影响之后冻结路由的新操作。已经写入终端但没有收到可信协作完成事件的
操作会变成 `uncertain`，不会通过 Direct 或 wrapper 自动重试。Direct 始终保持
可用。`SHELLSPAN_TERMINAL_LEGACY_WRAPPER_FALLBACK_V1` 继续控制尚未迁移的平台和
远端目标，但不能在 Windows 本地重新启用 wrapper。

## 隐私安全诊断

只读 Terminal Broker 快照提供进程内累计计数：集成就绪、降级 fallback、匹配的
生命周期事件、uncertain、timeout、takeover、truncation、backpressure，以及
Broker 入站处理延迟的样本数、微秒总和和最大值。延迟在每个 generation 的首帧及
其后每 64 帧确定性采样，避免诊断统计争用 PTY 热路径。所有值都是有界整数，应用重启
后重置；它们不包含命令、路径、输出、屏幕内容、输入、搜索文本、凭据、nonce、
时间戳或其他原始终端数据，也不会写入 sessions-v5。

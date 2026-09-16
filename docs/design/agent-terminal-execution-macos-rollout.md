# Agent 终端执行 macOS 发布说明

> 状态：Phase 5/6 macOS 本地范围通过
> 更新：2026-09-16
> 协议依据：`protocol/agent/runtime/terminal-protocol-rfc.md`

## 用户可见行为

macOS 新建的本地 bash/zsh 终端默认启用 Terminal Session Broker、协作式
shell integration、wrapper-free `terminal_execute` 与交互终端工具。命令直接
提交给当前交互 shell，目录、环境变量、alias、函数、选项和提示符状态保持在
同一 shell；终端显示真实回显，不再生成 `[Agent]` 命令行。

当集成尚未 ready、已降级或被回滚时，本地可视命令明确不可用并提供 Direct，
不会静默恢复旧 wrapper，也不会把已经写入终端的命令换路径重放。历史
`direct` / `boundTerminal` 与 `exec_command.channel = "pty"` 仍可解码，但新的
macOS 本地 `pty` wrapper dispatch 会返回
`TERMINAL_LEGACY_WRAPPER_REMOVED_ON_MACOS`。

## 平台边界

- macOS 本地 `/bin/bash` 3.2 与 `/bin/zsh` 5.9：新路径默认开启，本地 wrapper
  路由移除。
- Windows 本地 ConPTY：保持已通过的默认开启状态。
- Linux 本地 PTY：默认关闭，compatibility wrapper 保留。
- SSH/remote：专用 Agent SSH PTY 与 Phase 5 交互工具仍默认关闭，compatibility
  wrapper 保留；macOS 本地通过不能替代远程验收。

## 回滚

可信后端环境变量按以下顺序设为 `off`：

1. `SHELLSPAN_TERMINAL_INTERACTIVE_TOOLS_V1`
2. `SHELLSPAN_TERMINAL_EXECUTE_V1`
3. `SHELLSPAN_TERMINAL_SHELL_INTEGRATION_V1`
4. `SHELLSPAN_TERMINAL_BROKER_V1`

回滚只影响之后冻结路由的新操作。未收到可信协作完成事件的操作变为
`uncertain`，不会通过 Direct 或 wrapper 自动重试。Direct 始终可用；
`SHELLSPAN_TERMINAL_LEGACY_WRAPPER_FALLBACK_V1` 不能在 macOS 本地恢复 wrapper。

## 验收入口

`pnpm test:terminal-rollout:macos` 要求原生 Darwin x64/arm64 Rust host、
`/bin/bash` 与 `/bin/zsh`。它覆盖真实 PTY Broker、shell 状态、REPL、单键确认、
resize、alternate screen、凭据提示拒绝、Direct/兼容性回归、完整串行 Rust 套件
和两轮 release 性能门槛；不满足主机前提时以 `MISSING` 退出，不能报告 PASS。

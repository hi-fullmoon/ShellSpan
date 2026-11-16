# 专项验证命令

日常测试使用 `pnpm test`。以下命令从仓库根目录运行。执行专项验证前，按对应说明准备桌面会话、浏览器、原生构建工具或隔离环境。

## 应用与 Agent

| 验证范围 | 命令 |
| --- | --- |
| 桌面应用单实例 | `node scripts/verify-single-instance.mjs` |
| Agent 响应流 | `node scripts/verify-ai-streaming.mjs` |
| 原生会话流 | `node scripts/verify-ai-session-stream.mjs` |
| Agent 面板性能 | `node scripts/verify-ai-session-stream.mjs --performance` |
| 清屏后继续使用终端 | `node scripts/verify-ai-session-stream.mjs --terminal-clear-screen --no-model` |
| 原生前端存储 | `node scripts/verify-frontend-storage.mjs` |
| 图片草稿存储 | `cargo test --manifest-path src-tauri/Cargo.toml --lib frontend_storage::tests::` |
| 提交恢复 | `node scripts/verify-submission-recovery.mjs` |

凭据刷新、SFTP 取消和 Agent 终端争用见[文档索引](README.md#实际验证入口)。诊断工具和文档上传的命令分别见[诊断协议](../protocol/agent/runtime/diagnostic-tools.md)和[文档附件协议](../protocol/agent/runtime/document-attachments.md)。

## 终端

| 验证范围 | 命令 |
| --- | --- |
| 终端尺寸和位置 | `node src/components/terminal/__tests__/terminal-geometry.browser.mjs` |
| 终端交互 | `node src/components/terminal/__tests__/terminal-experience.browser.mjs` |
| 原始终端视图 | `node src/components/terminal/__tests__/terminal-original-view.browser.mjs` |
| Agent 可见终端 | `node scripts/verify-agent-visible-terminal.mjs` |
| Linux 容器终端 | `node scripts/verify-terminal-broker-linux-container.mjs`，仅第三阶段加 `--phase3-only` |
| Windows 本机终端 | `node scripts/verify-terminal-broker-windows.mjs` |
| macOS 本机终端 | `node scripts/verify-terminal-broker-macos.mjs`，仅编辑器验证加 `--editors-only` |
| 隔离 SSH 传输与恢复 | `node scripts/verify-terminal-remote-ssh.mjs` |
| 原生输入 P2 | `node scripts/verify-terminal-input-p2.mjs` |

原生终端显示和命令标记见[显示协议](../protocol/native-input-display.md#可重建验证)。原生输入 P0/P1 的环境要求和命令见 [P0 手册](../scripts/native-input-p0/README.md)和 [P1 手册](../scripts/native-input-p1/README.md)。

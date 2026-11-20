# 专项验证命令

日常测试使用 `pnpm test`。以下命令从仓库根目录运行。执行专项验证前，按对应说明准备桌面会话、浏览器、原生构建工具或隔离环境。

## 应用与 Agent

| 验证范围 | 命令 |
| --- | --- |
| 桌面应用单实例 | `node scripts/verification/app/verify-single-instance.mjs` |
| Agent 响应流 | `node scripts/verification/agent/verify-ai-streaming.mjs` |
| 原生会话流 | `node scripts/verification/agent/verify-ai-session-stream.mjs` |
| Agent 面板性能 | `node scripts/verification/agent/verify-ai-session-stream.mjs --performance` |
| 清屏后继续使用终端 | `node scripts/verification/agent/verify-ai-session-stream.mjs --terminal-clear-screen --no-model` |
| 原生前端存储 | `node scripts/verification/app/verify-frontend-storage.mjs` |
| 图片草稿存储 | `cargo test --manifest-path src-tauri/Cargo.toml --lib frontend_storage::tests::` |
| 提交恢复 | `node scripts/verification/agent/verify-submission-recovery.mjs` |

凭据刷新和 SFTP 取消见[文档索引](README.md#实际验证入口)。诊断工具和文档上传的命令分别见[诊断协议](../protocol/agent/runtime/diagnostic-tools.md)和[文档附件协议](../protocol/agent/runtime/document-attachments.md)。

### 终端争用与关闭

在已配置模型路由的桌面环境运行 `node scripts/verification/agent/verify-ai-session-stream.mjs --terminal-contention`。两个真实 Agent 共用本地 PTY，验证提交拦截、提示、草稿保留、输入权释放、手动重试、并发提交、确认接管，以及关闭正在运行的 Agent 终端。关闭时检查无关任务仍可运行，且界面显示错误 Toast。脚本只清理本次创建的会话和终端。

- 加 `--no-model` 可验证真实 PTY、关闭及错误提示，并取消已持久化的 Agent 会话。验证模型调用取消时需运行默认模式。
- 验证使用固定的 `127.0.0.1:1432`。端口被占用时立即失败。测试页面和每次运行的结果令牌通过 HTTP 重定向传递，Tauri 的编译入口保持稳定。
- 加 `--native-binary /absolute/path/to/ShellSpan` 可跳过 Cargo，复用为该固定入口构建且与待验源码匹配的二进制文件。macOS 重编译后的临时签名可能需要重新授权。通过实际应用读取核对访问权限。 [开发签名与钥匙串检查](testing-credential-refresh.md#普通开发程序的只读检查)

## 终端

| 验证范围 | 命令 |
| --- | --- |
| 终端尺寸和位置 | `node src/components/terminal/__tests__/terminal-geometry.browser.mjs` |
| 终端交互 | `node src/components/terminal/__tests__/terminal-experience.browser.mjs` |
| 原始终端视图 | `node src/components/terminal/__tests__/terminal-original-view.browser.mjs` |
| Agent 可见终端 | `node scripts/verification/agent/verify-agent-visible-terminal.mjs` |
| Linux 容器终端 | `node scripts/verification/terminal/verify-terminal-broker-linux-container.mjs`，仅第三阶段加 `--phase3-only` |
| Windows 本机终端 | `node scripts/verification/terminal/verify-terminal-broker-windows.mjs` |
| macOS 本机终端 | `node scripts/verification/terminal/verify-terminal-broker-macos.mjs`，仅编辑器验证加 `--editors-only` |
| 隔离 SSH 传输与恢复 | `node scripts/verification/terminal/verify-terminal-remote-ssh.mjs` |
| 原生输入 P2 | `node scripts/native-input/verify.mjs integration` |

原生终端显示和命令标记见[显示协议](../protocol/native-input-display.md#可重建验证)。统一命令及各平台前置条件见[原生输入构建与验收](../scripts/native-input/README.md)。

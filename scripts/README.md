# 项目脚本

`package.json` 只保留日常开发、构建、完整测试、CI 检查和版本准备入口。
`pnpm test` 运行 Vitest 回归测试；专项浏览器、原生桌面和平台验收需要单独运行，不能用普通单元测试代替。

## 专项验收

以下文件仍用于回归验证，直接使用 `node <文件路径>` 执行。先阅读脚本中的环境要求；原生桌面、系统钥匙串、Docker、SSH 或目标平台不可用时，不能把缺失验收当作通过。

旧验收记录中的 `pnpm test:*` 是当时使用的命令，其当前入口对应如下：

| 旧入口（省略 `test:` 前缀） | 当前脚本路径 |
| --- | --- |
| `credential-refresh` | `scripts/verify-credential-refresh.mjs` |
| `agent-diagnostics` | `scripts/verify-agent-diagnostics.mjs` |
| `ai-streaming` | `scripts/verify-ai-streaming.mjs` |
| `ai-session-stream` | `scripts/verify-ai-session-stream.mjs` |
| `image-draft-indexeddb` | `scripts/verify-image-draft-indexeddb.mjs` |
| `submission-recovery` | `scripts/verify-submission-recovery.mjs` |
| `document-upload` | `scripts/verify-document-upload.mjs` |
| `terminal-geometry` | `src/components/terminal/__tests__/terminal-geometry.browser.mjs` |
| `terminal-experience` | `src/components/terminal/__tests__/terminal-experience.browser.mjs` |
| `agent-visible-terminal` | `scripts/verify-agent-visible-terminal.mjs` |
| `terminal-broker:linux-container`、`terminal-visible:linux-container` | `scripts/verify-terminal-broker-linux-container.mjs` |
| `terminal-visible:linux-container:focused` | `scripts/verify-terminal-broker-linux-container.mjs --phase3-only` |
| `terminal-visible:ssh` | `scripts/verify-terminal-remote-ssh.mjs` |
| `terminal-broker:windows`、`terminal-visible:windows`、`terminal-interactive:windows`、`terminal-rollout:windows` | `scripts/verify-terminal-broker-windows.mjs` |
| `terminal-broker:macos`、`terminal-visible:macos`、`terminal-interactive:macos`、`terminal-rollout:macos` | `scripts/verify-terminal-broker-macos.mjs` |

例如：`node scripts/verify-terminal-broker-macos.mjs`。

## 发布与检查

版本准备、说明同步和发布校验继续使用 `pnpm release:prepare`、`pnpm changelog`、`pnpm release:check`，详见 [发布流程](../docs/releasing.md)。
CI 直接调用的发布工具、签名工具、更新清单工具和 `scripts/__tests__/` 回归测试继续保留。

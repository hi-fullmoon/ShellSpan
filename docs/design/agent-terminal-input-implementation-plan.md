# 原生终端后续实施计划

本页记录继续验收所需的入口和历史基线。行为以[原生输入协议](../../protocol/agent/runtime/native-input.md)为准，完成判定以[统一验收标准](agent-terminal-input-acceptance-checklist.md)为准。

| 范围 | 历史基线 | 后续验收 |
| --- | --- | --- |
| macOS arm64 本地 PTY | R04 对 Bash 5.3／Readline 8.3.6 和 Zsh 5.9／ZLE 5.9 的适用条款记录为 63/63；部分原件已缺失。后续签名候选复验了重绑、崩溃恢复、系统输入与显示。 | 对最终候选重跑适用项，核对签名、实际加载资源、系统交互及恢复账本。 |
| Linux arm64 SSH | 受控回环双 Shell 已验证隔离传输、接管、显示、后台作业和故障恢复。 | 通过[双 Shell SSH 故障恢复清单](agent-terminal-input-zle-ssh-recovery.md)覆盖最终候选，并在正式发布前完成 E08 的远端验收。 |
| Linux x86_64 SSH | 使用 Bash 5.3 私有会话资源；兼容下限和回退路径见 [x86_64 专项](agent-terminal-input-linux-x86_64-ssh.md)。 | 分别核对受支持的 glibc 版本、低版本回退、实际随包资源和 ARM64 回归。 |
| Windows x64 ConPTY | `wt5c1` 的实际安装验证了 PowerShell 7 原生执行、PowerShell 5.1 普通终端、重启恢复、WebView2 交互及卸载。 | 完成最终候选的多代次重绑、选区锚点、资源准入和完整 Quality Gate。 |

独立回环模型批次 E06 曾在 Bash 和 ZLE 上各通过 5 个用例；2026-11-16 的 B01 批次使用 DeepSeek Flash 分别验证了 Bash 和 ZLE 的严格 Unicode 提交。两项均只覆盖各自的候选、环境和模型配置。

## 执行与留档

1. 冻结拟验收源码、资源和安装包。先用统一清单中的入口列出适用用例，再验证真实 App 加载的资源及回退。
2. 按平台保留运行身份、接受次数、文件效果、账本和恢复证据。人工操作、真实模型及自动化各记各的结果；旧批次不替代最终候选。
3. 核对系统清理、故障遗留和制品归档，按[发布流程](../releasing.md)对最终提交完成全平台门禁。

旧批次的逐项结果与证据路径可从本文件和 `docs/design/` 的 Git 历史查阅。原始证据依赖验收主机保留的本机产物；缺失项需另外记录。

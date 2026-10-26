# 文档索引

## 开发与维护

- [项目介绍与本地开发](../README.zh-CN.md)
- [贡献指南](../CONTRIBUTING.md)
- [仓库工作约定](../AGENTS.md)
- [领域模块组织](../src/lib/README.md)
- [发布流程](releasing.md)
- [版本记录](../CHANGELOG.md)与[各版本发布说明](../release-notes/)

## 当前协议

协议描述运行时契约；设计、计划和验收记录中的结论只适用于各自注明的范围与版本。

- [终端连接](../protocol/terminal-connection.md)
- [终端 Session 协议](../protocol/agent/runtime/terminal-protocol-rfc.md)
- [终端兼容与 rollout](../protocol/agent/runtime/terminal-execution-compatibility.md)
- [终端测试矩阵](../protocol/agent/runtime/terminal-execution-test-matrix.md)
- [文件与脚本执行、安全边界](../protocol/agent/runtime/file-and-script-execution.md)
- [项目目录绑定](../protocol/agent/runtime/project-root-binding.md)
- [任务与回合计划](../protocol/agent/runtime/turn-and-task-plan.md)
- [可靠提交](../protocol/agent/runtime/reliable-submission.md)
- [上下文预算](../protocol/agent/runtime/context-budget.md)
- [内容脱敏](../protocol/agent/runtime/content-redaction.md)
- [诊断工具](../protocol/agent/runtime/diagnostic-tools.md)
- [图片附件](../protocol/agent/runtime/image-attachments.md)与[文档附件](../protocol/agent/runtime/document-attachments.md)
- [LLM 协议](../protocol/llm/README.md)
- [Petdex 动作联动](../protocol/petdex/integration.md)与[消息气泡](../protocol/petdex/bubble.md)

## 实际验证入口

- [凭据刷新](testing-credential-refresh.md)
- [SFTP 取消](testing-sftp-cancellation.md)
- [Agent 与用户终端争用](testing-agent-terminal-contention.md)

## 终端实施与验收

- [可视终端统一实施与交接](../protocol/agent/runtime/visible-terminal-unification-plan.md)：后续路由、原生脚本提交和后台作业的实施记录及范围。
- [Bash / PowerShell 原生显示复查](../protocol/agent/runtime/bash-powershell-native-display-review.md)
- [Zsh 原生后台作业显示复查](../protocol/agent/runtime/zsh-native-job-display-review.md)
- [Windows 原生终端验收](../protocol/agent/runtime/windows-native-terminal-acceptance.md)与[桌面及模型续验](../protocol/agent/runtime/windows-desktop-terminal-acceptance.md)：分别保留底层、桌面和模型的冻结验证边界。
- [远程绑定终端复用](../protocol/agent/runtime/remote-bound-terminal-reuse-plan.md)：保留原实施与当时未完成的原生窗口项，后续证据查阅统一计划。
- [初期终端路线图与 Phase 0–6 验收入口](../protocol/agent/runtime/terminal-execution-roadmap.md)：历史阶段记录，不用旧阶段的限制覆盖后续协议。

## 设计与历史证据

- [Agent 执行安全与使用体验](design/agent-execution-safety-and-usability.md)及[沙箱实施计划](design/agent-sandbox-implementation-plan.md)：包含未实施目标，不能视为已交付生产沙箱。
- [Petdex 动作实施计划](design/petdex-integration-implementation-plan.md)及[验收记录](design/petdex-integration-acceptance.md)
- [Petdex 消息设计](design/petdex-message-integration-design.md)、[实施计划](design/petdex-message-integration-plan.md)及[验收记录](design/petdex-message-integration-acceptance.md)
- [可视终端首版设计](design/agent-visible-terminal-execution.md)及[首版验收](design/agent-visible-terminal-execution-acceptance.md)：历史 wrapper 方案背景。
- [in-band 完成帧阶段 0 攻击记录](design/agent-direct-shell-execution-stage-0-gate.md)及[独立实验夹具](../tests/agent-direct-shell-gate/README.md)：保留被否决方案的反例，避免将终端输出当成可信完成信号。

已被后续协议替代的早期原生命令输入提案、研发计划、受信任 Shell 研究、首版可视终端研发计划及旧 macOS / Windows rollout 说明已移除。原始版本可通过 Git 历史查阅；历史验收中的文件清单按当时事实保留。

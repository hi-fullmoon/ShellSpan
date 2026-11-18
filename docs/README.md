# 文档索引

## 开发与维护

- [项目介绍与本地开发](../README.zh-CN.md)
- [贡献指南](../CONTRIBUTING.md)
- [仓库工作约定](../AGENTS.md)
- [领域模块组织](../src/lib/README.md)
- [发布流程](releasing.md)
- [版本记录](../CHANGELOG.md)与[各版本发布说明](../release-notes/)

## 部署与配置

- [远端受限 sudo 执行器](remote-sudo-runner.md)

## 当前协议

协议描述运行时契约；设计、计划和验收记录中的结论只适用于各自注明的范围与版本。

- [终端连接](../protocol/terminal-connection.md)
- [终端 Session 协议](../protocol/agent/runtime/terminal-protocol-rfc.md)
- [文件与脚本执行、安全边界](../protocol/agent/runtime/file-and-script-execution.md)
- [项目目录绑定](../protocol/agent/runtime/project-root-binding.md)
- [任务与回合计划](../protocol/agent/runtime/turn-and-task-plan.md)
- [用户审批与提问](../protocol/agent/runtime/user-interactions.md)
- [可靠提交](../protocol/agent/runtime/reliable-submission.md)
- [上下文预算](../protocol/agent/runtime/context-budget.md)
- [流式追加的性能边界](../protocol/agent/runtime/streaming-append-performance.md)
- [内容脱敏](../protocol/agent/runtime/content-redaction.md)
- [诊断工具](../protocol/agent/runtime/diagnostic-tools.md)
- [切换工作区焦点](../protocol/agent/runtime/focus-workspace.md)与[会话标题](../protocol/agent/runtime/session-titles.md)
- [图片附件](../protocol/agent/runtime/image-attachments.md)与[文档附件](../protocol/agent/runtime/document-attachments.md)
- [LLM 协议](../protocol/llm/README.md)
- [Petdex 动作联动](../protocol/petdex/integration.md)与[消息气泡](../protocol/petdex/bubble.md)

## 实际验证入口

- [凭据刷新](testing-credential-refresh.md)
- [SFTP 取消](testing-sftp-cancellation.md)
- [Agent 与用户终端争用](testing-agent-terminal-contention.md)
- [其他专项验证命令](testing.md)

## 终端实施与验收

- [NIP 契约与实现入口](../protocol/agent/runtime/native-input.md)：原生输入、资源和准入边界。
- [原生终端显示与命令标记](../protocol/native-input-display.md)记录显示集成边界和浏览器回归入口。
- [原生终端后续实施计划](design/agent-terminal-input-implementation-plan.md)记录当前进度、各平台剩余工作和交付顺序。
- [原生输入统一验收标准](design/agent-terminal-input-acceptance-checklist.md)规定 35 条要求、五个发布绑定和证据规则。
- [Linux x86_64 SSH](design/agent-terminal-input-linux-x86_64-ssh.md)与 [双 Shell SSH 故障恢复](design/agent-terminal-input-zle-ssh-recovery.md)记录专项验证范围和执行入口。
- [ZLE 追加能力契约](../protocol/agent/runtime/native-zle-append.md)说明验证范围与启用条件。

## 后续设计与历史记录

- [终端兼容与分阶段上线记录](../protocol/agent/runtime/terminal-execution-compatibility.md)
- [in-band 完成帧阶段 0 攻击记录](design/agent-direct-shell-execution-stage-0-gate.md)及[独立实验夹具](../tests/agent-direct-shell-gate/README.md)：保留被否决方案的反例，避免将终端输出当成可信完成信号。

原生终端旧批次、Petdex 阶段验收流水和旧权限设计通过 `git log -- docs/design/` 查阅。历史通过结果只覆盖当时的源码、制品和环境。新测试与验收产物写到 `artifacts/tests/`，本机产物不随仓库分发。

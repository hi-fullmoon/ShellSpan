# 文档入口

## 使用与维护

- [项目介绍](../README.md)、[英文介绍](../README.en.md)
- [贡献指南](../CONTRIBUTING.md)
- [发布流程](releasing.md)
- [凭据刷新验证](testing-credential-refresh.md)
- [脚本说明](../scripts/README.md)、[前端领域目录](../src/lib/README.md)

## 当前设计与协议

| 主题 | 入口 |
| --- | --- |
| Agent 沙箱 | [研发终版](design/agent-shell-sandbox-final.md)、[策略协议](../protocol/agent/runtime/sandbox-policy.md)、[远端协议](../protocol/agent/runtime/remote-sandbox-backend.md) |
| Agent 终端执行 | [当前路线图](../protocol/agent/runtime/terminal-execution-roadmap.md)、[协议](../protocol/agent/runtime/terminal-protocol-rfc.md)、[验证矩阵](../protocol/agent/runtime/terminal-execution-test-matrix.md) |
| 远端终端复用 | [实施与验收状态](../protocol/agent/runtime/remote-bound-terminal-reuse-plan.md) |
| Petdex 动作联动 | [协议与限制](../protocol/petdex/integration.md)、[验收记录](design/petdex-integration-acceptance.md) |
| Petdex 消息气泡 | [设计](design/petdex-message-integration-design.md)、[协议](../protocol/petdex/bubble.md)、[验收记录](design/petdex-message-integration-acceptance.md) |
| LLM | [协议入口](../protocol/llm/README.md) |
| 部署 | [工作流协议](../protocol/deployment/workflow.md) |

## 历史证据

`docs/design/` 和 `protocol/agent/runtime/` 中的阶段验收文件记录对应修订的实际结果、失败及限制。它们用于追溯，不作为当前待办清单；当前状态从上表入口开始核对。

旧 wrapper 可视终端设计、原生命令输入提案、阶段 0 NO-GO 及受信任 Shell 研究保留为安全决策依据，不能据此判断现行终端架构。已完成且内容被设计／协议／验收覆盖的重复实施计划，以及已被验收记录替代的临时交接文档，移至系统回收站。

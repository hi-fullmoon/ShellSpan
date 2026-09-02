# 终端 Agent 使用指南

ShellSpan 的 Agent 现在只有一条执行路径：Rust Agent Runtime。对话、Activity、审批、恢复、子 Agent
和 Fleet 都来自同一份有序 Agent Session 日志；Ask 是独立的只读功能，不是失败后的降级路径。

## 配置模型

在“设置 → AI 助手”中添加并选择默认模型。支持 OpenAI Responses、OpenAI-compatible Chat
Completions（包括 Kimi 与 MiniMax）以及本地 Ollama。

MiniMax 默认使用：

- 服务地址：`https://api.minimaxi.com`
- 模型：`MiniMax-M2.7`

API Key 只保存在操作系统钥匙串中。不要把密钥放进命令、聊天、日志、截图或仓库文件。

## 启动与继续任务

1. 打开一个已连接的本地或远程终端。
2. 打开 AI 面板并选择 Agent。
3. 选择当前连接的权限模式。
4. 输入目标并发送。

后续输入会继续同一个 Agent Session：运行中输入会在下一个安全 Step 边界生效，空闲时输入会启动
下一 Turn。关闭再打开面板或重启应用后，界面会从已提交日志回放；不会依赖 WebView 内存恢复业务状态。

## 权限模式

| 模式 | 自动执行范围 | 审批行为 |
| --- | --- | --- |
| 请求批准 | 无 | 每个需要执行的操作都先展示目标、意图、参数与风险 |
| 帮我批准 | 明确允许的低风险只读操作 | 敏感读取、写入、破坏性与外部副作用仍需审批 |
| 完全访问权限 | 当前连接授权范围内的操作 | 选择模式前需要显式确认；底层安全校验仍然生效 |

提升后的权限只绑定当前连接实例。断线、关闭、重连、身份变化或应用重启后都会恢复为“请求批准”。
权限模式不会绕过冻结目标、参数 Schema、effect 分类、能力范围、有效期、单次使用、路径 containment、
摘要前置条件、秘密输入阻断、超时、取消、输出上限和脱敏。

工作区 MCP 通过 `.shellspan/mcp.json` 配置。Agent 发起 MCP 调用时会先显示服务器、工具、目标和外部
副作用审批；只有批准后才会启动 stdio 服务器、发现具体工具并加载其 Schema。凭据仍由 Rust 在执行时
从系统钥匙串读取，不进入模型上下文或 WebView。

## 审批、拒绝与停止

- 审批卡保留完整目标、意图、参数、风险和结果；工具详情可折叠。
- 批准只对卡片对应的 Session、Turn、Step、请求和调用生效。
- 拒绝会提交 `rejected` 结果，不会把命令写入终端。
- “停止 Agent 任务”会取消模型、审批等待、工具或进程以及后代 Agent，并提交一个终态。
- 迟到的模型帧、批准或工具结果不能重新打开已结束的 Session。

## Conversation 与 Activity

Conversation 展示用户/助手消息、运行时 Marker、工具卡和审批。Activity 展示 Turn/Step、请求耗时与
token、Plan、Context/Artifact、Recovery、Agent 树和 Fleet target matrix。两个页签由同一事件序列
投影，因此刷新或回放时保持一致。

Plan 由主 Agent Session 管线通过 `update_plan` 写入单调递增的 `task/plan` 事件。Native 执行层不保存
Plan、Task、子 Agent 或 Fleet 状态，只接收当前 Session/Turn/Step 的冻结调用上下文并执行一次受控效果。

## 数据与恢复

新 Agent 任务只写 Agent Runtime Session 日志。旧版 AI 会话中的 Agent 记录只能作为历史数据读取，
不能继续执行、审批、恢复或双写。遇到非幂等操作的未知结果时，Runtime 会要求明确的 reconciliation
证据，不会自动重放。

完整实现约束见 [Agent Runtime 架构](agent-runtime-vnext.md)。

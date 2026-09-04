# 终端 Agent 使用指南

ShellSpan 的 Agent 现在只有一条执行路径：Rust Agent Runtime。AI 面板仅使用 Agent Workspace；
对话、Activity、审批、恢复、Queue、子 Agent 和 Fleet 都来自同一份有序 Agent Session 日志，
不存在独立的只读会话 adapter 或失败后的降级路径。

## 配置模型

在“设置 → AI 助手”中添加并选择默认模型。支持 OpenAI Responses、OpenAI-compatible Chat
Completions（包括 Kimi 与 MiniMax）以及本地 Ollama。

MiniMax 默认使用：

- 服务地址：`https://api.minimaxi.com`
- 模型：`MiniMax-M2.7`

API Key 只保存在操作系统钥匙串中。不要把密钥放进命令、聊天、日志、截图或仓库文件。

## 启动与继续任务

1. 打开一个已连接的本地或远程终端。
2. 打开 AI 面板。
3. 在 Composer 的“终端权限”入口选择当前连接的权限模式；模型配置入口会打开“设置 → AI 助手”。
4. 输入目标并发送。

第一次成功提交后，后续输入继续同一个 Agent Session：运行中普通 Enter
默认排队到下一 Turn，Ctrl/Cmd+Enter 默认在下一个安全 Step 边界转向；可以在 Composer 中交换默认
策略。Shift+Enter 换行，输入法组合态不会误提交。运行中草稿为空时主动作是停止。关闭再打开面板或
重启应用后，界面从已提交日志回放；不会依赖 WebView 内存恢复业务状态。

运行时 Queue 可以在 Composer 上方编辑、删除和同 lane 重排。每次 mutation 都带 expected revision；
若别处先改变了 Session，界面刷新 committed snapshot、显示冲突并保留重试入口。历史列表中的 Agent
Session 也可重命名。Queue 与标题只有在 v4 committed event 到达后才视为完成，刷新不会恢复旧值。

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

- 待审批动作接管 Composer seat，主面板保留目标、意图、effect 和风险；完整参数、结果、evidence 与
  审批元数据在面板内 Tool Details 查看。
- 批准只对卡片对应的 Session、Turn、Step、请求和调用生效。
- 拒绝会提交 `rejected` 结果，不会把命令写入终端。
- “停止 Agent 任务”会取消模型、审批等待、工具或进程以及后代 Agent，并提交一个终态。
- 迟到的模型帧、批准或工具结果不能重新打开已结束的 Session。

## Conversation 与 Activity

Conversation 展示稳定 keyed 的系统提示词、上下文、用户/助手、推理、工具、Artifact、retry、审批和错误节点；
主列表不预渲染工具 JSON 或 Artifact body。Activity 展示 Turn/Step、请求耗时与 token、Plan、
Context/Artifact、Recovery、Agent 树和 Fleet target matrix。两个页签由同一 committed event window
投影，因此刷新或回放时 through-seq 保持一致。

系统提示词默认折叠，连续步骤、重试和后续追问复用同一条；正文变化、恢复 Agent 或上下文替换后
开始新序列时才新增条目。仅工具或模型配置变化保留在 Activity 中，空提示词不显示。
运行时用 `request/header` 保存必要的完整快照，`request/start` 逐次记录请求并引用快照，
因此减少重复提示词记录不会改变请求计数、耗时或 token 统计；旧 v4 日志仍可回放。

会话历史、Tool Details 和 Artifact Details 使用 320–720px 面板内单栈 route，不会在宽面板中再开
永久详情栏。返回详情会恢复来源行焦点和会话滚动 anchor。切换或关闭某个 UI 订阅不会停止后台 Agent；
只有显式 Stop 才会取消 Runtime 工作并等待 committed terminal event。

Plan 由主 Agent Session 管线通过 `update_plan` 写入单调递增的 `task/plan` 事件。Native 执行层不保存
Plan、Task、子 Agent 或 Fleet 状态，只接收当前 Session/Turn/Step 的冻结调用上下文并执行一次受控效果。

## 数据与恢复

新 Agent 任务只写 Agent Runtime Session 日志。遇到非幂等操作的未知结果时，Runtime 会要求明确的
reconciliation 证据，不会自动重放。

新日志只使用 Event v4；v2/v3 日志不读取、不迁移，也不会出现在 Session Browser。v4 的
`clientSubmissionId` 用于把乐观用户消息与 committed `user/message`/Inbox 精确合并，Inbox
update/remove/reorder 和 `session/renamed` 使用 `clientOperationId`、revision check 与
commit-before-publish。存储和可选人工清理方式见架构文档。

完整实现约束见 [Agent Runtime 架构](agent-runtime-vnext.md)。

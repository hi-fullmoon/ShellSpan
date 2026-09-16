# 远程可视命令复用当前终端实施方案

状态：Proposed  
更新时间：2026-09-16（Asia/Shanghai）  
范围：远程 SSH 终端、Agent `boundTerminal` 执行面、终端 Broker、前端终端租约与状态展示

## 1. 背景

当前远程终端选择“可视命令”后，普通用户 SSH 会话只作为 Agent
Session 的目标来源。模型第一次调用 `terminal_execute` 时，运行时会重新认证并创建一个
Agent 专用 SSH PTY，然后通过 `terminal-agent-remote-session-created` 事件将它显示为第二个
终端标签。

这与用户对“可视命令”的直觉不一致：用户预期命令在当前可见终端中执行，并继续使用该
Shell 已有的工作目录、环境变量、alias 和历史状态，而不是切换到另一个相同主机的终端。

本方案将远程 `boundTerminal` 的权威目标改为用户当前 SSH PTY，彻底停止正常执行链路中的
专用 Agent SSH 终端创建。

## 2. 目标

完成后必须满足以下行为：

1. 远程终端选择“可视命令”后，Agent 命令写入当前用户 SSH PTY。
2. 终端输出、退出码、cwd 和命令完成状态均来自当前 PTY 的 Shell 集成。
3. 发送问题或执行多条命令不会新增终端标签。
4. 用户和 Agent 共享同一个 Shell 状态：
   - 用户设置的环境变量、alias 和 cwd 对 Agent 可见；
   - Agent 修改的环境变量、alias 和 cwd 对用户后续输入可见。
5. 整个 Agent turn 内，当前终端由现有租约机制保护；用户可主动接管。
6. 当前终端不满足执行条件时，明确返回不可用或忙碌，不新建备用终端。
7. Direct 执行、敏感命令强制 Direct、审批、取消、审计、脱敏和不自动重放语义保持不变。
8. Shell 集成失败不能阻止普通 SSH 终端连接和使用。

## 3. 非目标

- 不改变本地终端的 `boundTerminal` 行为。
- 不让 Agent 绕过权限确认或终端租约。
- 不支持 Bash、Zsh 之外的新远程 Shell。
- 不在用户已经运行的前台程序或 TUI 中注入命令。
- 不把任意终端滚动区、控制通道内容、凭据或集成临时路径写入 Agent 事件日志。
- 不通过静默 Direct 回退掩盖可视命令不可用；策略明确要求 Direct 的命令除外。

## 4. 术语

| 术语 | 含义 |
| --- | --- |
| 源终端 | 用户创建并在终端工作区中可见的 SSH 会话，也是 Agent Session `target.sessionId` 指向的会话。 |
| 集成控制通道 | 与 PTY 原始输出分离的命令生命周期通道，用于发布 ready、prompt、command start/end、cwd 和退出码。 |
| Prompt 边界 | Shell 集成已完成 Prompt 渲染、当前没有前台命令，可安全提交下一条逻辑命令的状态。 |
| Turn guard | 从 Agent `turn/start` 到 `turn/end` 持续存在的输入保护，防止用户在模型思考或多条命令之间改变 Shell 状态。 |
| Command lease | 单次终端操作的后端租约，绑定 Agent Session、task 和 operation。 |

## 5. 核心设计决策

### 5.1 当前用户 SSH PTY 是唯一远程可视执行目标

远程工具目标中的 `sessionId` 直接解析为 Broker transport。准备、审批后重校验和最终执行都必须
使用这个相同的源会话，不再通过 `(Agent Session, targetId)` 查找另一条 Agent Remote Session。

目标身份在每个关键边界重校验：

- Session 仍然存在且已连接；
- Session 类型仍为 remote；
- host、port、username 与冻结目标一致；
- Broker transport、terminal session id 和 generation 仍为当前代次；
- Shell 集成 ready；
- 提交命令时处于 Prompt 边界；
- 当前没有其他命令或冲突租约。

任何条件不满足都拒绝写入 PTY。

### 5.2 Shell 集成在 SSH 会话启动阶段准备

现有生命周期协议要求在 Shell 启动前安装 Bash/Zsh hooks，并且不能把随机临时路径或引导命令
写入 PTY。为了复用同一个 Shell，远程可视命令功能开启时，普通 SSH 会话必须在连接阶段尝试
准备集成，而不能等模型第一次调用工具时再创建或替换 Shell。

连接流程调整为：

1. 完成 SSH 认证。
2. 在功能开关允许时尝试准备远程集成文件和控制通道。
3. 准备成功：用集成启动配置启动用户 Shell，并注册当前 transport。
4. 准备失败或 Shell 不支持：启动普通 SSH Shell，连接仍视为成功；将可视命令标记为
   `unavailable` 并记录有限、非敏感原因。
5. 会话结束时清理控制通道和临时文件。

普通终端可用性优先于 Agent 集成。SFTP 被禁用、`/etc/passwd` 不可读、临时目录不可创建、
FIFO 不可用或第二个控制 channel 不可创建，都不能导致 SSH 主会话失败。

### 5.3 Shell 启动兼容性是合并门禁

当前集成通过自定义 Bash/Zsh 启动命令加载 hooks，不能笼统宣称与原生 `channel.shell()` 完全
等价。实现必须验证并保留以下可观察行为：

- Bash 登录 profile 的加载顺序；
- Zsh `.zshenv`、`.zprofile`、`.zshrc`、`.zlogin` 的加载顺序；
- 用户 Prompt、alias、function、环境变量和 history 配置；
- TERM、窗口尺寸、locale 和交互 Shell 标志；
- MOTD、登录提示和远端审计策略不被重复执行；
- 用户配置文件不会被重复 source。

如果某项无法与普通 SSH Shell 保持兼容，应将该 Shell/环境标记为集成不可用并回退普通 Shell，
而不是带着不完整的用户环境进入 `ready`。

### 5.4 整个 Agent turn 持有用户输入保护

继续沿用现有 `turn/start` 输入保护，而不是只在单条命令执行期间锁定终端：

1. `turn/start` 后，前端立即对源终端调用 `suppressUserInput`。
2. 模型思考、审批等待以及多条命令之间均保持保护。
3. 每条命令仍分别获取后端 Command lease。
4. `turn/end`、取消、失败、Session 结束或用户接管后释放保护。
5. 用户接管后，对该 turn 的所有后续 Agent 输入进行 fencing；不能重新获得租约继续写入。

这是共享 Shell 状态可预测性的必要条件。UI 必须持续显示 Agent 占用状态，并提供现有接管操作。

### 5.5 不执行隐式兜底

当用户选择 `boundTerminal` 时：

- Shell 集成不可用：工具返回 `TERMINAL_VISIBLE_COMMAND_UNAVAILABLE`；
- 当前没有 Prompt 边界：工具返回明确的 busy 状态；
- 终端已断开或 generation 改变：工具拒绝并按现有恢复策略处理；
- 不创建新终端；
- 不自动切换 Direct。

只有现有安全策略认定 `lifecycleTrust = directRequired`，或命令涉及敏感路径、凭据等必须隔离的
场景时，才允许将该工具调用强制路由到 Direct。该决定必须继续反映在执行结果和 UI 状态中。

### 5.6 删除专用 Agent SSH 终端生产路径

专用 Agent SSH PTY 不进入工作区持久化，因此不存在需要跨版本恢复的持久数据。行为切换完成前，
必须删除或使下列生产路径不可达：

- `ensure_remote_agent_terminal`；
- `create_agent_remote_terminal_blocking`；
- Agent Remote Terminal candidate 的创建、发布和中止入口；
- `terminal-agent-remote-session-created` 事件；
- 前端 Agent Remote Terminal 事件监听；
- `TerminalSession.agentOwned` 和 `agentSourceSessionId`；
- Agent 专用终端标签、Badge 和无障碍文案；
- 基于 `agent_remote_terminal(...)` 的执行和交互工具解析。

如果 Broker 内的 candidate/owner 结构不再有其他生产消费者，也应同时删除，避免旧路径在未来被
误接回。不得仅依赖“当前调用点已移除”来保证不新建终端。

### 5.7 功能开关迁移

`terminal_remote_agent_pty_v1` 不再准确描述行为。新权威名称为：

- flag：`terminal_remote_bound_terminal_v1`；
- environment：`SHELLSPAN_TERMINAL_REMOTE_BOUND_TERMINAL_V1`；
- IPC field：`remoteBoundTerminalRollout`。

旧环境变量 `SHELLSPAN_TERMINAL_REMOTE_AGENT_PTY_V1` 可作为一个版本的只读兼容别名：仅当新变量
未设置时读取，且不再在新文档或 UI 中展示旧名称。该开关不持久化。

关闭开关时：

- 停止新远程可视命令路由；
- 活动且未完成的远程可视命令变为 `uncertain`；
- 撤销 Agent 租约和 turn guard；
- 保持用户 SSH transport 打开；
- 不关闭或重连用户终端；
- 下次新建/重连 SSH 会话时使用普通 Shell 启动路径。

## 6. 状态模型

### 6.1 后端权威状态

远程可视命令可提交的充分条件为：

```text
connected
AND transportKind == sshPty
AND remoteBoundTerminalRollout.enabled
AND terminalExecuteRollout.enabled
AND integrationState == ready
AND promptReady == true
AND activeCommand == none
AND current lease owner == user
AND generation is current
```

前端状态仅用于展示和提前反馈，不能替代后端在写入前的权威校验。

### 6.2 前端展示状态

| 条件 | 展示状态 | 行为 |
| --- | --- | --- |
| SSH 正在连接或集成尚未产生 ready | 初始化中 | 可以使用 Direct；可视命令暂不可选。 |
| 集成 ready 且 `promptReady = true` | 就绪 | 可选择并使用可视命令。 |
| 集成 ready 且 `promptReady = false`，当前无 Agent turn | 终端忙碌 | 不注入命令；提示等待当前前台程序返回 Prompt。 |
| Agent turn guard 或 Agent lease 存在 | Agent 使用中 | 阻止用户输入，显示接管操作。 |
| 集成 degraded/unavailable/invalidated | 不可用 | 保持普通终端可用，提示改用 Direct。 |
| SSH 断开 | 已断开 | 禁止所有终端执行，走现有重连/恢复流程。 |

`TerminalIntegrationStateEvent` 需要增加 `promptReady`；Terminal Store 需要保存该字段。当前仅传播
`integrationState` 会把“集成 ready 但正在运行前台程序”错误展示为可执行。

UI 复用现有执行面选择器、终端租约提示条、Button、Badge 和 Tooltip，不新增自定义基础控件。
新增的“终端忙碌”文案必须同时更新中英文 locale。

## 7. 执行序列

```text
用户发送消息
  -> Agent turn/start
  -> 前端锁定当前源终端输入
  -> 模型决定调用 run_terminal_command
  -> NativeToolAdapter 将目标 sessionId 直接路由到源终端
  -> 后端重新校验 target、generation、integration、prompt 和 lease
  -> 获取 Command lease，并等待前端确认租约 UI 已就绪
  -> Broker 注册 command operation
  -> 向当前 SSH PTY 写入“精确命令行 + Shell Enter”
  -> 用户在当前终端看到命令和输出
  -> 集成控制通道发布 command start/end、cwd、exit status
  -> Broker 完成命令结果并释放 Command lease
  -> Turn guard 在下一条命令之间继续存在
  -> Agent turn/end
  -> 前端恢复用户输入
```

任何步骤失败都不得转去创建新终端。

## 8. 失败处理

| 场景 | 处理 |
| --- | --- |
| Bash/Zsh 之外的登录 Shell | 普通 SSH 连接成功；集成状态为 unavailable；可视命令不可用。 |
| SFTP 或临时目录准备失败 | 清理已创建资源；启动普通 Shell；可视命令不可用。 |
| 控制 channel 创建失败 | 清理集成资源；启动普通 Shell；可视命令不可用。 |
| 集成 ready 前用户开始操作 | 用户终端正常工作；只有 Broker 判定 Prompt ready 后才允许可视命令。 |
| 用户正在运行前台命令/TUI | 返回 busy；不写入 PTY。 |
| Agent 等待审批 | Turn guard 保持；用户可接管或取消。 |
| 用户接管 | 最多发送一次 interrupt；撤销租约；对后续 Agent 输入 fencing。 |
| transport 断开 | 未完成命令标记 uncertain；不自动重放。 |
| reconnect 产生新 generation | 旧输入、输出和完成事件全部拒绝；新 generation 重新初始化集成。 |
| host/profile 身份漂移 | 冻结目标重校验失败，拒绝执行。 |
| 精确命令行生命周期不匹配 | 集成降级，当前结果标记 uncertain，停止后续可视执行。 |
| 前端 controller 不存在或未确认租约 | 超时失败，不写入 PTY。 |

## 9. 安全与隐私约束

- 用户明确选择 `boundTerminal` 才允许 Agent 共享当前 Shell 状态。
- 所有 Agent 输入仍必须经过统一租约入口，禁止绕过 Broker 直接写 Session channel。
- 临时集成目录权限保持 `0700`，脚本和 FIFO 保持 `0600`。
- 控制通道内容不得混入 PTY 原始输出。
- 随机临时路径、nonce、凭据、完整滚动区和原始控制帧不得进入日志或 Agent Session 事件。
- 工具结果只保留命令作用域内的有界、脱敏输出。
- 用户输入和 Agent 输入都绑定当前 terminal generation；旧 generation 永久失效。
- 崩溃可能留下的临时目录不得通过宽泛 glob 直接删除。若实现启动时清理，只能删除当前用户拥有、
  前缀和结构均匹配、超过安全期限且没有活动控制通道的目录。

复用当前终端会主动放弃“独立 Agent PTY”的 Shell 状态隔离，这是本功能的产品语义，不得再在
协议或 UI 中暗示二者隔离。命令审批、敏感命令 Direct 隔离和输入租约仍然构成安全边界。

## 10. 实现范围

### 10.1 SSH 启动与集成

主要文件：

- `src-tauri/src/session.rs`
- `src-tauri/src/commands.rs`
- `src-tauri/src/terminal_integration.rs`

工作项：

- 将集成准备从“仅 Agent Remote Terminal”扩展到开启远程 bound-terminal 功能的普通 SSH 会话。
- 将集成失败转换为普通 Shell fallback，不让连接失败。
- 验证并修正 Bash/Zsh 用户启动文件加载语义。
- 将临时目录命名从 Agent 专用语义改为普通终端集成语义。
- 确保正常关闭、连接失败、取消和控制通道异常均清理资源。

### 10.2 Native Tool 路由

主要文件：

- `src-tauri/src/agent_runtime/native_adapter.rs`
- `src-tauri/src/agent_runtime/native/runtime.rs`

工作项：

- 远程 visible route 直接查询冻结目标 `sessionId`。
- `terminal_execute` 和远程交互工具直接解析源终端。
- 删除 Agent Remote Terminal 创建和等待逻辑。
- 审批后、租约前和 PTY 写入前保留目标与 generation 重校验。
- Direct 和 `directRequired` 路由保持不变。

### 10.3 Terminal Broker

主要文件：

- `src-tauri/src/terminal_broker.rs`
- `src-tauri/src/agent_runtime/native/terminal_execute.rs`
- `src-tauri/src/agent_runtime/native/terminal_lease.rs`

工作项：

- 允许已集成的普通 SSH PTY 成为 `terminal_execute` 目标。
- 移除 `agent_pty_owner` 作为远程可视命令前置条件。
- 保持 Agent Session、task、operation 和 generation 的租约身份校验。
- remote rollout 关闭时只停止 Agent 路由，不关闭用户 transport。
- 删除不再使用的 candidate/owner 状态和回滚动作。

### 10.4 前端状态与 UI

主要文件：

- `src/components/terminal/terminal-controller-layer.tsx`
- `src/components/terminal/agent-terminal-lease-state.ts`
- `src/components/ai/agent-execution-surface-selector.tsx`
- `src/components/ai/workspace/ai-workspace-controller.tsx`
- `src/stores/terminalStore.ts`
- `src/hooks/useMonitorEvents.ts`
- `src/types/index.ts`
- `src/locales/zh-CN.ts`
- `src/locales/en-US.ts`

工作项：

- 删除 `dedicatedAgentPtyRequired -> ready` 的伪映射。
- 传播并保存 `promptReady`。
- 增加“终端忙碌”展示状态和双语文案。
- 让 turn guard 和 Command lease 始终绑定源终端。
- 删除 Agent Remote Terminal 监听、Store 字段、标签 Badge 和相关文案。
- 保留现有 shadcn Button、Badge、Tooltip 和选择器组合，不新造基础控件。

### 10.5 协议

实现行为变化时同步更新：

- `protocol/agent/runtime/terminal-protocol-rfc.md`
- `protocol/agent/runtime/terminal-execution-compatibility.md`
- `protocol/agent/runtime/terminal-execution-roadmap.md`
- `protocol/agent/runtime/terminal-execution-test-matrix.md`

历史 acceptance 文档保留当时事实；需要增加一段后续修订说明，而不是改写历史测试结果。

## 11. 测试计划

### 11.1 Rust 单元测试

- 普通 SSH transport 在集成 ready 且 Prompt ready 后返回 `TerminalExecute` route。
- 未集成、集成失败、Prompt busy、active command 或 generation 过期时 route 不可用。
- 普通 SSH transport 可以获取 Agent lease、开始命令、接收生命周期并释放租约。
- remote rollout 关闭不会关闭用户 transport。
- 用户接管后拒绝所有迟到 Agent 输入。
- transport 断开使未完成命令进入 `uncertain`。
- Remote native tool 始终解析冻结目标 `sessionId`，不查询 Agent Remote Terminal map。
- 敏感命令和 `directRequired` 仍路由 Direct。

### 11.2 SSH 集成测试

对 Bash 和 Zsh 分别覆盖：

- 普通用户 SSH 会话直接获得集成；
- 用户先设置环境变量，Agent 可读取；
- Agent 设置环境变量，用户随后可读取；
- 用户设置 alias，Agent 可调用；
- Agent `cd` 后用户 `pwd` 观察到相同 cwd；
- Prompt、profile、rc、history 和交互 Shell 标志满足兼容性门禁；
- 前台命令运行期间 Agent 不写入任何字节；
- resize、取消、接管、断连和 reconnect generation 正确；
- unsupported shell、SFTP 不可用和控制 channel 失败均回退普通终端且不新建标签；
- 任何副作用命令在断连后不会自动重放。

### 11.3 前端测试

- Broker snapshot 的真实 ready 状态映射到可视命令 ready。
- `promptReady = false` 显示“终端忙碌”。
- 不再识别 `dedicatedAgentPtyRequired` 为 ready。
- `turn/start` 在第一条命令前锁定源终端。
- 单条 Command lease 释放后、`turn/end` 前仍保持输入保护。
- 接管后立即恢复用户输入，并清理租约提示。
- 连续多次提问后 Terminal Store 会话数量不增加。
- 后端不再发送或前端不再监听 Agent Remote Terminal 创建事件。
- 双语文案键集合一致。

### 11.4 回归验证命令

先运行聚焦测试，再扩大范围：

```bash
pnpm test -- src/components/terminal/__tests__/terminal-controller-layer.test.tsx
pnpm test -- src/components/ai/__tests__/agent-execution-surface-selector.test.tsx
cargo test --manifest-path src-tauri/Cargo.toml terminal_broker::tests -- --test-threads=1
cargo test --manifest-path src-tauri/Cargo.toml agent_runtime -- --test-threads=1
pnpm test:terminal-visible:ssh
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
pnpm check:rust:includes
pnpm check:ai-styles
pnpm test
pnpm build
cargo test --manifest-path src-tauri/Cargo.toml
```

## 12. 迁移与回滚

### 12.1 迁移

- Agent Remote Terminal 不持久化，因此无需迁移工作区数据。
- 旧版本运行中的专用 PTY 会随应用退出关闭；升级后不会恢复。
- 既有 Agent Session 的 `executionSurface = boundTerminal` 值保持兼容，语义改为绑定其冻结目标
  `sessionId` 指向的用户终端。
- 如果历史 Agent Session 指向的 transport 已被替换，继续沿用现有“在重连终端上创建新 continuation”
  流程，不把旧 Session 静默改绑到新 transport。

### 12.2 回滚

关闭 `terminal_remote_bound_terminal_v1`：

- 新命令不再进入远程用户 PTY；
- 活动命令按不确定性规则结束；
- 当前用户 SSH 连接保持打开；
- 不恢复专用 Agent PTY 路径；
- 用户可显式选择 Direct 继续工作。

回滚的目标是安全停用远程可视命令，而不是重新启用双终端设计。

## 13. 可观测性

允许记录的内容：

- 集成 ready/degraded/unavailable 计数；
- route unavailable/busy 次数；
- lease acquire/release/takeover 计数；
- uncertain、timeout、truncation 和 generation rollover 计数；
- 不含主机名、用户名、命令、路径和输出内容的错误分类。

禁止记录：

- 命令正文和用户输入；
- PTY 原始输出或屏幕快照；
- 密码、私钥、token、nonce；
- 远程临时目录和 FIFO 的完整路径。

## 14. 完成标准

只有全部满足以下条件才能视为完成：

- [ ] 远程可视命令只写入当前用户 SSH PTY。
- [ ] 发送问题和执行多条命令不会增加终端标签数量。
- [ ] 用户与 Agent 的 cwd、环境变量和 alias 在同一 Shell 中双向共享。
- [ ] Agent turn 全程保护用户输入，接管后可靠 fencing。
- [ ] Prompt busy 时不写入任何字节。
- [ ] 集成失败时普通 SSH 终端仍可正常连接和使用。
- [ ] 专用 Agent SSH 终端生产路径和前端事件路径已删除或不可达。
- [ ] Direct、安全策略、审批、取消、审计和脱敏行为无回归。
- [ ] 断连或 generation 变化不会自动重放命令。
- [ ] Bash/Zsh 启动兼容性测试通过。
- [ ] 前端双语、状态展示和相关回归测试通过。
- [ ] 聚焦测试、完整前端测试、构建和 Rust 测试通过。

## 15. 建议实施顺序

1. 先增加 Broker 和 Native Tool 的失败回归测试，证明当前用户 SSH transport 尚不能执行。
2. 改造 SSH 启动集成并通过 Bash/Zsh 真实 SSH 测试。
3. 将 Native Tool 与 Broker 路由切换到源终端。
4. 扩展 `promptReady` 前端状态并更新租约 UI。
5. 删除专用 Agent SSH 终端的后端、事件、Store 和标签路径。
6. 更新 feature flag、协议和测试矩阵。
7. 运行完整验证，并实际检查代表性窗口下的终端标签、占用提示和接管行为。


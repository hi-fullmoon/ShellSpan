# Agent 可视终端执行模式设计

> 状态：Draft  
> 适用范围：ShellSpan Terminal Agent  
> 最后更新：2026-09-09

Phase 1 的发布门禁、证据映射与手工步骤见
[`agent-visible-terminal-execution-acceptance.md`](agent-visible-terminal-execution-acceptance.md)。

## 1. 背景

ShellSpan 当前将 Agent 会话绑定到一个本地或远程终端目标，但模型公开工具 `run_terminal_command` 默认通过独立执行通道运行。命令及输出会进入 Agent 工具调用记录，却不会像用户输入一样实时显示在当前绑定的 xterm 终端中。

这降低了执行过程的直观性。用户能够在 Agent 时间线中查看结构化结果，但无法在熟悉的终端界面中连续观察 Agent 执行命令、产生输出和进入下一步。

本设计增加“可视终端执行”能力：Agent 仍通过结构化工具提出命令，ShellSpan 仍负责审批、安全检查和执行，但获准的 shell 命令改为在当前绑定的终端 PTY 中运行。用户可以实时看到命令和输出，并能随时中断或接管终端。

## 2. 结论

该能力不存在基础设施层面的技术阻塞。当前代码已经具备以下基础：

- `SessionManager` 可以向本地或远程终端 session 写入数据；
- 终端输出会同时进入 Agent Runtime 观察器和前端 xterm；
- native PTY 执行器已经支持单 session 排他、命令完成标记、退出码、超时、取消和 Ctrl-C；
- 前端 `TerminalController` 已提供输入抑制、直接写入、输出订阅和输出过滤接口；
- Agent Session 日志已有统一的持久化、脱敏和审计边界。

当前的主要缺口是：公开工具仍被固定路由到 `direct` 通道，PTY 生命周期尚未与前端终端控制权、协议过滤和用户接管流程连接。

首版“可视终端执行”属于中等复杂度改造。支持任意 TUI、密码提示或 REPL 的通用交互式 Agent，则是独立的高复杂度阶段，不纳入首版。

## 3. 目标

- 用户可为一个 Agent Session 选择“后台执行”或“可视终端执行”。
- 在可视终端执行下，获准的 `run_terminal_command` 在 Session 冻结的绑定终端中执行。
- 命令输出实时显示在现有 xterm 中，同时作为有界工具结果返回给 Agent。
- 内部 wrapper、认证 marker 和其他协议内容不向用户显示。
- Agent 执行期间不存在用户输入与 Agent 输入相互拼接的情况。
- 用户始终可以中断命令并接管终端。
- 执行方式不改变现有权限、审批、风险分类、目标冻结和审计规则。
- 断线、取消、超时、应用退出及异常恢复后不会遗留终端 lease。

## 4. 非目标

首版不支持：

- `vim`、`top`、`less` 等全屏 TUI；
- 任意 REPL、数据库控制台或持续交互式程序；
- `sudo`、密码、口令和二次认证输入；
- Agent 后台启动并长期持有当前 PTY 的任务；
- 用户和 Agent 同时向同一终端输入；
- 将文件、SFTP、MCP 或其他原生工具伪装为终端命令；
- 保证继承用户 shell 中所有 alias、function 和未导出的变量。

## 5. 产品模型

### 5.1 执行表面与权限分离

可视终端不是新的权限模式。Agent Session 应分别记录：

```ts
type AgentExecutionSurface = 'direct' | 'boundTerminal';

type AgentSessionPermissionMode =
  | 'requestApproval'
  | 'scopedAutopilot'
  | 'operator';
```

两者含义如下：

| 维度 | 决定内容 |
| --- | --- |
| `executionSurface` | shell 命令通过独立执行通道还是绑定终端 PTY 执行 |
| `permissionMode` | 哪些副作用需要用户审批 |

选择 `boundTerminal` 不得自动提高权限，也不得绕过现有风险分类和审批。

### 5.2 Session 级冻结

`executionSurface` 在 Agent Session 创建时确定并写入 Session Header。恢复历史 Session 时沿用原值，不根据当前 UI 开关静默改变。

如后续允许切换，切换必须发生在 Agent 空闲、无待审批工具、无终端 lease 时，并记录持久事件。

### 5.3 UI 建议

在 Agent composer 的目标与权限区域增加执行方式选择：

- 后台执行：沿用当前行为，稳定性最好；
- 可视终端：命令在绑定终端中实时展示。

终端被 Agent 占用时显示清晰但不遮挡输出的状态条：

```text
Agent 正在操作此终端                         [中断并接管]
```

状态条至少包含：

- Agent 标识；
- 当前命令的安全展示文本或摘要；
- 已运行时长；
- 中断并接管操作。

键盘输入被锁定时不得静默丢弃。用户首次输入应得到可访问的提示，并可通过 Esc 或按钮接管。

## 6. 当前实现基线

### 6.1 当前公开工具使用独立执行通道

`run_terminal_command` 在 native adapter 中被归一化为 `exec_command`，并固定写入：

```json
{
  "channel": "direct",
  "background": false,
  "elevated": false
}
```

因此当前命令不会进入已绑定的交互式终端。

### 6.2 已存在 PTY 单命令协议

native PTY 路径已经实现：

- 为每次操作生成不可预测 marker；
- 在命令前后输出 BEGIN/END 记录；
- 使用 commitment 验证结束记录，避免普通命令输出伪造完成事件；
- 捕获 combined output 和退出码；
- 每个 session 同时只允许一个 Agent PTY 操作；
- 超时或取消时写入 Ctrl-C；
- 捕获上限 1 MiB，协议缓冲硬上限 2 MiB。

该实现适合首版“一次一条命令”的可视执行，但尚不构成长生命周期的交互式终端代理。

### 6.3 前端已有可复用能力

`TerminalController` 已具备：

- `suppressUserInput()`；
- `writeInput()`；
- `subscribeOutput()`；
- `subscribeOutputFilter()`；
- 用户未提交输入和未验证提交的本地跟踪。

这些能力目前没有与后端 PTY operation/lease 完整关联。

## 7. 总体架构

一次可视命令执行包含以下阶段：

1. 模型调用结构化工具 `run_terminal_command`。
2. Tool Pipeline 完成参数校验、目标校验、风险分类和必要审批。
3. Runtime 根据 Session Header 中的 `executionSurface` 选择 `direct` 或 `pty`。
4. PTY 路径向 `TerminalLeaseManager` 申请绑定终端 lease。
5. lease 获取成功后，前端进入 Agent 占用状态并锁定用户输入。
6. 后端写入包装后的命令；前端展示人类可读的 Agent 命令行。
7. 原始 PTY 输出进入协议解析器；清理后的 display output 实时进入 xterm。
8. END 记录通过认证后，Runtime 形成有界、脱敏的工具结果。
9. lease 释放，前端恢复用户输入。
10. Agent 根据工具结果决定下一步，下一条命令重复上述过程。

模型不对每个输出字符持续推理。对用户而言输出是实时的，对模型而言仍以工具调用完成边界驱动下一轮推理。

## 8. 核心组件

### 8.1 Agent Session Header

新增字段：

```rust
pub enum AgentExecutionSurface {
    Direct,
    BoundTerminal,
}

pub struct AgentSessionHeader {
    // existing fields...
    pub execution_surface: AgentExecutionSurface,
}
```

严格策略：Session 缺少该字段时拒绝读取，不推断执行方式。

### 8.2 TerminalLeaseManager

后端新增独立的终端 lease 管理器，不能只依赖前端输入抑制。

建议记录：

```rust
pub struct AgentTerminalLease {
    pub session_id: String,
    pub agent_session_id: String,
    pub task_id: String,
    pub operation_id: String,
    pub acquired_at_unix_ms: u64,
}
```

必须满足：

- 每个 terminal session 最多一个 lease；
- lease 与 Agent Session、task 和 operation 绑定；
- 非 owner 不能续期、释放或向 Agent 通道写入；
- terminal close、Agent cancel、超时和 Runtime shutdown 都会回收 lease；
- 重复释放是幂等操作；
- lease 获取与 PTY operation 注册必须具备一致的失败回滚语义。

### 8.3 输入来源隔离

当前通用 `write_session` 无法从后端区分用户输入和 Agent 输入。首版应显式区分来源：

```rust
pub enum TerminalInputSource {
    User,
    Agent { operation_id: String },
    System,
}
```

规则：

- 存在 Agent lease 时，普通用户写入由后端拒绝，而不是只在前端丢弃；
- Agent 写入必须携带当前 lease 的 operation ID；
- Ctrl-C 接管走独立的受控命令，不受普通用户写入拒绝影响；
- 所有拒绝都返回稳定错误码，供 UI 显示正确状态。

前端 `suppressUserInput()` 仍作为即时 UX 层，但后端 lease 是最终一致性和安全边界。

### 8.4 执行路由

`run_terminal_command` 不再无条件映射到 `direct`：

```text
executionSurface == direct
    -> exec_command(channel = direct)

executionSurface == boundTerminal
    -> exec_command(channel = pty)
```

其他工具保持当前原生实现：

- `read_file`、`list_directory`、`search_text`、`apply_patch` 继续使用结构化文件通道；
- SFTP 和 MCP 继续使用各自的原生执行通道；
- UI 可以在 Agent 时间线展示这些操作，但不得在终端中制造虚假的 shell 输入。

### 8.5 协议流与展示流分离

原始 PTY 数据需要同时服务三个消费者：

| 数据流 | 用途 | 内容 |
| --- | --- | --- |
| protocol/raw | 完成边界与退出码解析 | 包含 wrapper echo、BEGIN/END marker 和真实输出 |
| display | xterm 实时展示 | 仅人类可见命令与真实程序输出 |
| model/result | Agent 下一步推理和审计 | 去 ANSI、限长、脱敏后的命令结果 |

内部 wrapper 和 marker 不应先发到前端再依赖固定正则清理。PTY parser 应支持跨 chunk 增量解析，并向 UI 输出清理后的 display chunk。

建议的展示行为：

```text
[Agent] $ docker ps
CONTAINER ID   IMAGE   ...
```

其中 `[Agent] $ docker ps` 是 ShellSpan 生成的可信展示行。真实写入 PTY 的 wrapper 不展示。

解析 END marker 时必须保留同一 chunk 中 marker 之后的正常 shell prompt，避免命令完成后吞掉提示符。

### 8.6 前端 lease 协调

后端通过专用事件发布 lease 状态：

```ts
interface AgentTerminalLeaseEvent {
  sessionId: string;
  agentSessionId: string;
  operationId: string;
  state: 'acquired' | 'released';
  commandDisplay?: string;
  reason?: 'completed' | 'cancelled' | 'timedOut' | 'failed' | 'takenOver';
}
```

`TerminalController` 收到 `acquired` 后：

- 安装与 operation 绑定的 display filter；
- 增加输入抑制计数；
- 展示 Agent 占用状态；
- 保持 xterm 滚动、选择、复制和搜索可用。

收到匹配的 `released` 后：

- 完成并卸载 filter；
- 恢复输入；
- 清理状态条；
- 将焦点还给终端，但不自动发送任何按键。

事件乱序或重复时，以 `operationId` 判断归属，不能由旧 operation 释放新 lease。

## 9. 状态机

### 9.1 后端 lease 状态

| 当前状态 | 事件 | 下一状态 | 行为 |
| --- | --- | --- | --- |
| Idle | Acquire | Owned | 校验 session、注册 owner、发布 acquired |
| Idle | Release | Idle | 幂等返回 |
| Owned | StartWrite | Executing | 写入 wrapper |
| Owned/Executing | Acquire by other | 不变 | 拒绝为 busy |
| Executing | AuthenticatedEnd | Releasing | 形成结果 |
| Executing | Timeout/Cancel/Takeover | Releasing | 发送 Ctrl-C，形成终止结果 |
| 任意占用态 | TerminalClosed | Releasing | 标记失败并唤醒等待者 |
| Releasing | CleanupComplete | Idle | 移除 operation、释放 lease、发布 released |

任何错误路径最终都必须进入 cleanup。清理失败不能让 lease 永久停留在占用态。

### 9.2 用户接管

用户点击“中断并接管”或按 Esc：

1. UI 调用带 `sessionId`、`agentSessionId` 和 `operationId` 的接管命令；
2. 后端核对当前 lease；
3. 向 PTY 发送 Ctrl-C；
4. 当前工具结果记为 `cancelled`，原因记为 `takenOver`；
5. Agent 当前 turn 被中断或收到明确的取消结果，不得自动重新执行同一命令；
6. 后端释放 lease；
7. UI 恢复用户输入并聚焦终端。

接管动作本身不等于批准后续 Agent 操作。

## 10. 命令执行语义

### 10.1 首版支持范围

首版仅保证以下命令：

- 从 shell 启动；
- 不需要后续 stdin；
- 在有界时间内退出；
- 不切换到全屏 alternate screen；
- 不将进程长期留在后台；
- 不要求输入秘密。

静态识别无法覆盖所有交互程序，因此运行时仍必须有超时、中断和接管机制。命令看似非交互但长时间没有完成时，不自动猜测或发送回车。

### 10.2 shell 状态

PTY 执行的价值之一是从当前终端的工作目录开始，但现有 POSIX wrapper 使用 `/bin/sh -c`，不会完整继承用户交互式 shell 的 alias、function 和未导出变量。

首版应在产品文案中避免承诺“完全继承当前 shell 状态”。后续如需要完整语义，应建立 shell capability handshake，明确识别 bash、zsh、fish、PowerShell 等实现，并为每种 shell 提供经过测试的 wrapper。

远程 Windows 或非 POSIX shell 在未识别时应回退到 `direct` 或拒绝可视执行，不能盲目套用 POSIX wrapper。

### 10.3 Prompt 与 shell 就绪

首版不以视觉 prompt 文本判断完成。完成依据只能是经过认证的 END marker。

在写入前至少检查：

- terminal session 为 connected；
- 没有其他 Agent PTY operation；
- 前端没有未提交输入；
- 前端没有尚未得到输出确认的用户提交；
- terminal 不处于已知 credential/host-key prompt；
- output listener 已 ready。

上述前端状态需要通过有界握手确认。前端未响应或窗口已销毁时，不能继续向共享 PTY 写入。

## 11. 安全与隐私

### 11.1 审批顺序

执行顺序必须保持：

```text
模型工具调用
-> schema 校验
-> 冻结目标校验
-> effect/risk 分类
-> 必要审批
-> lease
-> PTY 写入
```

lease 不能在长时间等待用户审批期间占用终端。审批通过后再申请 lease；如果终端状态在等待期间发生变化，则重新执行 lease 前置检查。

### 11.2 敏感信息

- xterm display 保持用户本来能看到的终端原始内容；
- model/result 和持久 Session event 必须在 Rust 侧经过统一脱敏；
- 前端脱敏只能作为额外保护，不能成为唯一安全边界；
- password、passphrase、OTP 等 prompt 在首版中不允许由 Agent 回答；
- 协议 secret、marker 和 wrapper 不进入 display、复制缓冲区或终端 AI context buffer；
- 工具结果继续执行现有限长和大结果 artifact 策略。

### 11.3 命令展示

展示命令可能本身包含敏感参数。`commandDisplay` 应使用统一脱敏器生成，不能直接复用原始命令。审批卡可按现有策略展示更完整内容，但终端中的合成展示行必须使用安全版本。

## 12. 输出、性能与背压

- 保留现有 xterm 高低水位背压机制；
- PTY parser 必须增量处理，不能为展示复制无界字符串；
- 保留现有 1 MiB capture 和 2 MiB protocol hard limit，除非基准测试证明需要调整；
- UI display 不因 Agent capture 截断而停止，capture 截断只影响返回模型的结果；
- parser 的 marker 搜索需要保持线性复杂度，避免对增长缓冲重复全量扫描；
- Agent 只在完成、超时、取消或明确的“需要输入”边界重新调用模型，不按字符或固定短周期唤醒模型。

## 13. 异常与恢复

| 场景 | 预期行为 |
| --- | --- |
| terminal 断线 | 结束 operation、工具失败、释放 lease |
| Agent 被停止 | 发送 Ctrl-C、工具取消、释放 lease |
| 命令超时 | 发送 Ctrl-C；有界等待后仍不退出则标记 timed out 并释放 lease |
| 前端刷新/销毁 | 后端不能依赖前端释放；Runtime 有界回收 lease |
| Runtime 重启 | 所有内存 lease 视为失效；恢复 Session 时记录中断结果 |
| marker 解析失败 | 终止 operation，不能伪造成功退出码；清理后恢复终端 |
| 用户接管与命令完成竞态 | 以首个原子终态为准，后续动作幂等 |
| 同一终端启动第二个可视 Agent | 明确拒绝或要求用户先接管，不能排队后静默执行 |

## 14. 分阶段实施

### Phase 1：单命令可视执行

- Session Header 增加 `executionSurface`，旧数据默认 `direct`；
- `run_terminal_command` 根据 Session 设置选择 direct/PTY；
- 增加后端 terminal lease 和输入来源校验；
- 串联前端输入锁、占用提示、中断接管；
- 分离 raw、display 和 model output；
- 隐藏 wrapper/marker，显示脱敏后的 `[Agent] $ command`；
- 仅支持前台、非交互、单条命令；
- 覆盖本地 macOS/Linux、Windows PowerShell 和远程 POSIX 基线。

### Phase 2：有界半交互

- 增加基于 cursor 的增量输出读取；
- 增加显式 `wait_terminal` 和受控 `write_terminal_input`；
- 支持确认类非秘密 prompt；
- 增加最大交互轮数、总时长、空闲时长和输入字节预算；
- 所有输入继续经过策略与审批，不允许模型自由逐字符接管。

### Phase 3：TUI/REPL 研究

- 评估后端 VT screen model，而不是仅依赖 raw ANSI 文本；
- 处理 alternate screen、光标定位、窗口尺寸变化和 screen snapshot；
- 建立 shell/program capability 白名单；
- 单独评估成本、可靠性和跨平台维护范围。

Phase 3 不应成为 Phase 1 发布条件。

## 15. 测试策略

### 15.1 Rust 单元测试

- lease 单 owner、错误 owner、幂等释放；
- operation 注册失败时 lease 回滚；
- BEGIN/END marker 跨任意 chunk 边界；
- 伪造 END 被拒绝；
- END 后同 chunk 的 prompt 被保留到 display；
- wrapper echo 和 marker 不进入 display/result；
- capture、protocol 和超时边界；
- cancel、takeover、disconnect、shutdown 竞态；
- 用户输入在 lease 期间由后端拒绝；
- Agent operation ID 不匹配时拒绝写入；
- 敏感命令及输出在持久化前脱敏。

### 15.2 前端单元测试

- acquired/released 事件正确增加与释放输入抑制；
- 旧 operation 的 released 不影响新 lease；
- 键盘输入被阻止时显示提示而非静默丢弃；
- 复制、选择、滚动和搜索在占用期间可用；
- 中断接管仅提交一次；
- controller rebind/dispose 时清理订阅和展示状态；
- direct 模式 UI 行为不回归。

### 15.3 集成测试

- 本地 POSIX 命令实时展示并返回正确退出码；
- 远程 SSH shell 命令实时展示；
- Windows ConPTY PowerShell 命令实时展示；
- 大输出触发背压但不死锁；
- 用户在 Agent 开始前已有半行输入时拒绝执行；
- 命令执行中用户接管，Agent 收到取消结果；
- terminal 断线后 Agent 不再继续向旧 session 写入；
- wrapper 和协议 marker 在屏幕、AI context buffer 和 Session 日志中均不可见。

## 16. 首版验收标准

首版只有同时满足以下条件才可启用：

- 用户显式选择可视终端执行；
- Agent 命令和输出在绑定终端中实时可见；
- 屏幕中不出现内部 wrapper 和认证 marker；
- 命令退出码与工具结果一致；
- 同一终端不会出现用户与 Agent 输入拼接；
- 用户可在一个明确动作内中断并接管；
- 所有终止路径均释放 lease；
- 可视模式不绕过权限审批；
- direct 模式行为保持稳定；
- 本地 POSIX、远程 POSIX、Windows ConPTY 均通过端到端测试；
- 敏感输出不会未经脱敏进入模型请求或持久 Session event。

## 17. 主要风险与决策

| 风险 | 影响 | 首版决策 |
| --- | --- | --- |
| 用户与 Agent 并发输入 | 命令污染或误执行 | 后端 lease 强制互斥，用户可接管 |
| wrapper 泄露到屏幕 | UX 差并暴露内部协议 | raw/display 分流，展示合成命令行 |
| 无法判断交互程序状态 | Agent 卡死或错误输入 | 首版只支持非交互单命令 |
| shell 类型不兼容 | 命令失败或协议失效 | 能力识别；未知 shell 回退/拒绝 |
| 输出过大 | 内存增长和 UI 卡顿 | 保留限额、增量解析和现有背压 |
| 终端输出包含秘密 | 模型或日志泄露 | Rust 侧统一脱敏，秘密 prompt 不交互 |
| 可视模式被误解为高权限 | 安全预期错误 | 执行表面和权限模式完全分离 |

最终建议：先发布 Phase 1，将它定位为“Agent 的透明命令执行表面”；不要在首版承诺通用交互式终端控制。现有 PTY 基础足以支撑该范围，核心工程投入应集中在 lease、协议展示分流和异常清理。

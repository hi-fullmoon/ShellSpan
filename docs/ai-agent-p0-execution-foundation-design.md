# AI Agent P0：执行基础设计

> 状态：implemented（verification pending external）
> 路线图阶段：P0 — 执行基础
> 设计基线：TermBridge v2.0.53
> 实施基线 HEAD：`5ccd6442dcdb424982f147153cc849277a547482`
> 设计日期：2026-08-26
> 收尾审计：2026-08-27
> 预计周期：1–2 周
> 关联路线图：`ROADMAP.md`

## 1. 阶段目标

P0 的唯一目标是：

> 从现有 Runbook 执行链路中抽取一个与 AI 模型、前端面板和 Runbook 文档格式无关的受审阅 SSH 命令执行内核，并证明它能够在冻结目标身份、受限资源、可取消和秘密不泄漏的条件下稳定执行一条命令。

P0 不实现“Agent 自己思考并运行命令”。它先建立后续所有 Agent 工具必须经过的唯一执行边界。

阶段完成后，应形成以下调用关系：

```text
Runbook document / future Agent policy
                │
                │ 负责解析、风险判断、审批和生成受审阅请求
                ▼
       Reviewed Execution Boundary
                │
                │ 负责冻结目标、限制资源、解析凭证引用
                ▼
         SSH Execution Kernel
                │
                │ 独立 SSH channel，不写入交互 PTY
                ▼
  Structured Execution Result
  stdout / stderr / exit code / timing / truncation / identity
```

## 2. 为什么 P0 必须独立存在

当前 `src-tauri/src/runbook.rs` 已经实现了多数安全能力，但它们与 Runbook 文档解析、审批判断、变量插值、SSH 连接、输出读取和结果映射集中在同一个文件与 Tauri command 中。

如果直接在 Agent 中复制或调用这些私有步骤，会产生以下问题：

- Runbook 与 Agent 形成两个执行实现，后续安全修复可能只落到其中一个。
- Agent 容易绕过 Runbook 的目标身份、known hosts、keychain、超时和秘密擦除规则。
- 执行结果仍带 Runbook 特有字段，Agent 需要反向依赖 Runbook 文档。
- 测试无法证明 Runbook 与 Agent 使用相同的安全边界。
- 为了快速演示，前端可能直接调用 `write_session`，把模型输出注入当前 PTY。

P0 通过先抽取唯一执行内核，消除以上分叉风险。

## 3. 当前实现基线

现有 Runbook 执行链路已经具备：

- `source_digest` 与所审阅 Runbook 文本绑定。
- profile ID、host、port、username、auth method 二次校验。
- exact risk approval 检查。
- Runbook 变量 POSIX shell quoting。
- keychain secret reference 在 Rust 边界解析。
- known hosts 与 jump host 复用。
- 独立 SSH `channel.exec`。
- 1 秒至 300 秒的超时限制。
- operation ID 级取消注册表。
- stdout 与 stderr 分离。
- 连接秘密和变量秘密结果擦除。
- exit code 与 expected result 匹配。

当前需要调整的点：

- `execute_runbook_step` 同时承担 review adapter 和执行内核职责。
- `open_runbook_session`、`execute_channel`、`ExecutionOutcome` 与 Runbook 命名耦合。
- 输出达到 64 KiB stdout 或 8 KiB stderr 时立即失败并关闭 channel，不能返回“已截断但仍完成”的结构化结果。
- 通用执行结果缺少 captured bytes、total bytes、truncated 和目标摘要字段。
- `RunbookCancellationRegistry` 不能直接作为未来其他工具的通用取消边界。
- 现有结果 `expectedMatched` 属于 Runbook 业务判断，不应进入底层 SSH kernel。

### 3.1 实施结果

步骤 0–5 已完成实现与本地验收：Runbook adapter 只调用 crate-private reviewed kernel，旧 Runbook SSH/session/channel 执行实现已删除；冻结目标、operation cancellation、结构化结果、有界输出、hard limit、UTF-8、redaction 和 test-only fixture 均位于 `src-tauri/src/execution/`。generic kernel 不依赖 Runbook 类型，也没有注册为 Tauri command。

生产 crate 的 `Channel::exec` 传输原语集中在 `execution/ssh.rs` 一处。Remote FS owner/group lookup 与 Remote Health snapshot 是既有固定用途内部能力，只复用 raw channel-start primitive，不构成 Agent 任意执行入口；未来 P1 不得调用 raw primitive 绕过 reviewed kernel。

步骤 4 的 jump-host 阻断已定位为同一 blocking libssh2 session 上双向 bridge copy 的锁饥饿：channel→TCP 的阻塞读会阻止 TCP→channel 写入内层 SSH 握手字节。修复把 direct-tcpip bridge session 与本地 bridge socket 切为 nonblocking，并在单一 bridge worker 中用两个固定大小缓冲区交替转发，对 WouldBlock/TimedOut 做有退避的重试，避免同一 session 的跨线程读写竞争。使用不同 host key 的双 sshd fixture 已通过外层认证、target known-host 校验、内层认证和 `uname -a` Exec。

P0 仍不能标记 `verified`：本收尾在当前 macOS 环境完成了本地 Rust/前端/双 sshd 门禁，但没有当前提交的 Windows runner 实跑结果。根据第 18 节第 5 条，状态保持 `implemented（verification pending external）`，P1 为 `blocked`。

## 4. P0 范围

### 4.1 必须完成

1. 定义冻结目标、受审阅执行请求、输出策略和通用执行结果。
2. 从 Runbook 抽取共享 SSH connection/channel execution 内核。
3. 抽取或泛化 operation-level cancellation registry。
4. 增加有界输出保留、截断元数据与输出洪泛保护。
5. 保持凭证、known hosts、jump host 与秘密擦除边界。
6. 将现有 Runbook adapter 切换到共享内核。
7. 用 characterization test 证明 Runbook 外部行为没有改变。
8. 建立不连接模型的内部测试 harness。
9. 记录 Exec 与交互 PTY 的架构决策。

### 4.2 明确不做

- 不实现 Agent loop。
- 不让模型生成或调用工具。
- 不新增 Agent 面板交互。
- 不实现 Agent 审批 UI。
- 不开放通用 `execute_command` Tauri command 给前端。
- 不直接调用 `write_session` 或控制当前 xterm。
- 不实现本地终端执行。
- 不实现 SFTP Agent 工具。
- 不实现专用 Agent PTY。
- 不实现多主机 Agent。
- 不改变现有 Runbook 格式、审批语义或用户操作流程。
- 不承诺应用崩溃后恢复正在执行的远程命令。

## 5. 设计原则

### 5.1 执行内核不负责决定“应不应该执行”

执行内核只接受已经通过上层审阅的强类型请求。上层负责：

- Runbook 文档解析。
- command risk classification。
- 用户审批。
- Agent policy evaluation。
- expected result 与 evidence freshness。

内核仍必须执行以下不可绕过的硬校验：

- operation ID 合法。
- target identity 完整且与当前 profile 一致。
- timeout 与输出策略不超过后端硬上限。
- 命令非空、无 NUL 且不超过硬字节上限。
- cancellation handle 唯一。
- 连接凭证只在 Rust 内部使用。

### 5.2 内核是 crate-private，不是新 IPC 能力

P0 不注册通用前端命令。共享内核只允许 Rust 内部调用：

```rust
pub(crate) fn execute_reviewed_ssh_command(...)
```

当前唯一生产调用方仍是 Runbook adapter。未来 Agent tool executor 必须在完成 policy 与 approval 后才能构造受审阅请求。

### 5.3 不把 Runbook 类型泄漏到底层

内核不能依赖：

- `RunbookDocument`
- `RunbookItemKind`
- `RunbookExpectedResult`
- `RunbookRisk`
- `sourceDigest`
- Runbook variable declaration

Runbook adapter 在调用内核前完成上述处理，并在收到通用结果后恢复现有 Runbook 返回结构。

### 5.4 不把 PTY 当作可信执行结果

共享内核使用独立 SSH Exec channel：

- 不向用户当前 terminal session 发送字节。
- 不依赖提示符识别。
- 不继承当前交互 shell 的 cwd、alias、function、venv 和临时 export。
- 以 SSH channel EOF 与 exit status 作为完成边界。

## 6. 建议模块结构

```text
src-tauri/src/execution/
├── mod.rs             # 对 crate 暴露受审阅执行入口
├── request.rs         # FrozenTarget、ReviewedCommand、OutputPolicy
├── target.rs          # profile 解析、冻结身份与身份校验
├── ssh.rs             # known hosts、jump host、SSH session/channel
├── output.rs          # stdout/stderr 有界收集与截断元数据
├── cancellation.rs    # operation-level 注册、取消和清理
├── redaction.rs       # secret needles 与结果擦除
└── result.rs          # status、error category、source identity
```

P0 可以根据实现复杂度合并小文件，但职责边界必须保留。不得把整个 `execute_runbook_step` 原样移动后仅改文件名。

## 7. 核心数据契约

以下为设计级 Rust 结构，字段名可在实现时调整，但语义不能省略。

### 7.1 FrozenTargetIdentity

```rust
pub(crate) struct FrozenTargetIdentity {
    pub profile_id: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth_method: String,
    pub identity_digest: String,
}
```

`identity_digest` 使用稳定、版本化的 canonical identity 生成，例如：

```text
v1\0profileId\0host\0port\0username\0authMethod
```

不把密码、私钥、passphrase、jump password 或 API key 放入摘要。

P0 可先将 jump host 的非秘密身份加入单独字段或 canonical identity：

- jump host
- jump port
- jump username
- jump auth method

这样修改 jump host 时不会继续使用旧审批目标。

### 7.2 ReviewedSshCommand

```rust
pub(crate) struct ReviewedSshCommand {
    pub command: String,
    pub preview: String,
    pub redaction_values: Vec<String>,
}
```

约束：

- `command` 仅存在于 Rust 内存，不进入常规日志或 operation history。
- `preview` 已替换 secret reference，可用于现有 Runbook 结果与审计。
- `redaction_values` 只用于结果和错误擦除，不序列化返回前端。
- 构造器必须拒绝空命令、NUL 和超过 8 KiB 的命令。

### 7.3 ExecutionOutputPolicy

```rust
pub(crate) struct ExecutionOutputPolicy {
    pub stdout_capture_bytes: usize,
    pub stderr_capture_bytes: usize,
    pub total_read_hard_limit_bytes: usize,
}
```

建议后端硬上限：

| 字段 | 默认值 | 后端最大值 | 说明 |
| --- | ---: | ---: | --- |
| stdout capture | 64 KiB | 256 KiB | 返回调用方的脱敏 stdout |
| stderr capture | 16 KiB | 64 KiB | 返回调用方的脱敏 stderr |
| total read hard limit | 8 MiB | 16 MiB | 防止无限输出占用 CPU/带宽 |

调用方可以收紧，不能超过后端最大值。

### 7.4 ReviewedSshExecutionRequest

```rust
pub(crate) struct ReviewedSshExecutionRequest {
    pub operation_id: String,
    pub target: FrozenTargetIdentity,
    pub connection: RemoteConnectionRequest,
    pub command: ReviewedSshCommand,
    pub timeout: Duration,
    pub output_policy: ExecutionOutputPolicy,
}
```

`connection` 仍用于保持现有密码提示、临时密码、私钥数据和 jump-host 行为。内核执行前必须重新读取 profile 并验证所有非秘密身份字段。

后续可进一步改为仅传 profile ID 和 credential handle，但这不是 P0 必须完成的迁移。

### 7.5 ExecutionStatus

```rust
pub(crate) enum ExecutionStatus {
    Completed,
    Cancelled,
    TimedOut,
    Failed,
}
```

`Completed` 表示远端命令正常结束并取得 exit status，不表示业务成功。`exit_code != 0` 仍可以是 `Completed`，由 Runbook adapter 判断 expected match。

### 7.6 ExecutionErrorCategory

```rust
pub(crate) enum ExecutionErrorCategory {
    InvalidRequest,
    TargetNotFound,
    TargetMismatch,
    CredentialUnavailable,
    HostKeyRejected,
    ConnectionFailed,
    ChannelOpenFailed,
    CommandStartFailed,
    OutputLimitExceeded,
    TransportFailed,
    Cancelled,
    TimedOut,
    WorkerStopped,
}
```

错误 category 稳定、可测试；message 可本地化或调整，但必须先脱敏。

### 7.7 ReviewedSshExecutionResult

```rust
pub(crate) struct ReviewedSshExecutionResult {
    pub operation_id: String,
    pub target: FrozenTargetIdentity,
    pub status: ExecutionStatus,
    pub started_at: i64,
    pub completed_at: i64,
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub stdout_bytes_read: u64,
    pub stderr_bytes_read: u64,
    pub stdout_truncated: bool,
    pub stderr_truncated: bool,
    pub error_category: Option<ExecutionErrorCategory>,
    pub error: Option<String>,
}
```

## 8. 输出收集策略

### 8.1 当前行为问题

当前 `read_available` 在 capture buffer 超过限制后立即返回错误。这能阻止内存增长，但会把“命令正常完成、输出过大”与“命令执行失败”混在一起，而且不能向调用方说明保留了多少内容。

### 8.2 P0 目标行为

每个流维护：

- 总读取字节数。
- 捕获字节数。
- 是否截断。
- 有界保留内容。

达到 capture limit 后：

- 继续读取并丢弃超出部分，防止 SSH channel 因未 drain 阻塞。
- 返回 `truncated: true`。
- 不在日志中记录被丢弃内容。

达到 total read hard limit 后：

- 设置 cancel flag。
- 关闭 channel。
- 返回 `OutputLimitExceeded`。
- 不能把此前取得的部分输出包装成成功。

### 8.3 保留布局

P0 建议简单采用“前段 + 尾段”保留：

- stdout：前 75%，尾 25%。
- stderr：前 50%，尾 50%。

中间省略部分使用结构化 `truncated` 字段表达，不依赖向内容插入伪造的 shell 文本。UI 或上层可以根据字段显示“已省略 N 字节”。

### 8.4 UTF-8

- 内部按 bytes 收集。
- 截断边界调整到有效 UTF-8 code point。
- 无效远端字节采用 lossy decode，但测试必须证明 secret redaction 不因边界切分而失效。
- secret redaction 在重组后的完整 capture 内容上执行，不逐 chunk 简单替换。

## 9. 目标冻结与连接解析

### 9.1 冻结时机

P0 由 Runbook adapter 在执行请求建立时生成冻结目标。P1 以后由 Agent run start 生成，并在整个 run 中复用。

### 9.2 执行前复核

每次执行前：

1. 使用 profile ID 从数据库重新读取 profile。
2. 比较 host、port、username、auth method。
3. 比较 jump-host 非秘密身份。
4. 重新生成 identity digest。
5. 与请求中的 frozen digest 比较。
6. 任一不匹配返回 `TargetMismatch`。

禁止：

- profile 不存在时按 host 自动搜索另一个 profile。
- profile 修改后静默更新 frozen target。
- 只比较 profile ID 而忽略 host/username。
- 根据当前活动 terminal tab 重定向目标。

### 9.3 Host key

- 继续使用 TermBridge known hosts 文件。
- 不降低首次连接、未知 host key、host key changed 的现有行为。
- P0 不增加 Agent 自动信任主机密钥。
- 需要用户信任时，Runbook/连接层沿用现有显式流程；内核本身不自动确认。

## 10. 凭证与秘密边界

### 10.1 输入秘密

可能的 redaction values 包括：

- Runbook secret variables。
- SSH password。
- private key data。
- private key passphrase。
- jump-host password。
- jump-host private key data。
- jump-host passphrase。

### 10.2 处理规则

- secret 只进入 worker 所需的内存。
- 不写入 `Debug`、错误日志、operation history 或执行 preview。
- worker 返回前擦除 stdout、stderr 和 error message。
- preview 使用 `<keychain://...>` 或 `[REDACTED]`。
- 取消、超时和 worker panic 路径使用相同擦除函数。
- P0 不承诺内存 zeroization，但不得复制到不必要的长期结构。

### 10.3 结构化敏感模式

连接 secret 精确值替换仍是第一层。现有终端上下文的通用 token/password 模式脱敏属于 Agent context 层，不应混入 kernel 造成业务输出误改。

P0 的 kernel redaction 目标是：已知由 TermBridge 解析或持有的秘密绝不返回。

## 11. 取消与超时

### 11.1 注册表

建议将 `RunbookCancellationRegistry` 泛化为 `ExecutionCancellationRegistry`，或在 execution 模块内实现同等能力：

- `register(operation_id) -> CancellationHandle`
- `cancel(operation_id)`
- `remove(operation_id)`
- 重复 operation ID 注册失败。
- handle drop 或执行终态确保 registry 清理。

Runbook 的 `cancel_runbook_step` 外部命令保持不变，只改为调用共享 registry。

### 11.2 超时语义

- timeout 包含连接、认证、channel open、命令执行和输出 drain 的总时间。
- 当前连接函数的内部超时如果更长，需要在 P0 评估并记录；不能声称全链路严格受 deadline 控制而没有测试证据。
- timeout 触发后关闭 channel 并返回 `TimedOut`。
- timeout 与 user cancel 竞争时，先观察到的终态获胜，结果只能写一次。

### 11.3 远程进程限制

关闭 SSH channel 通常会使前台进程收到 EOF/SIGHUP，但无法保证杀死：

- `nohup` 任务。
- 已 daemonize 进程。
- 将工作转交其他服务的命令。

因此 P0 文档记录限制；P1/P2 policy 默认拒绝后台化结构。

## 12. Runbook 适配方案

### 12.1 抽取前

```text
execute_runbook_step
├── parse document
├── validate source digest
├── select action
├── validate target
├── validate approval
├── interpolate variables / resolve secrets
├── open SSH session
├── execute channel
├── evaluate expected result
└── map Runbook result
```

### 12.2 抽取后

```text
execute_runbook_step
├── parse document
├── validate source digest
├── select action
├── validate risk approval
├── interpolate variables / resolve secret references
├── freeze and validate target
├── build ReviewedSshExecutionRequest
├── execution::execute_reviewed_ssh_command
├── evaluate expected result
└── map to existing RunbookStepExecutionResult
```

共享 kernel：

```text
execute_reviewed_ssh_command
├── validate hard limits
├── revalidate frozen target
├── resolve connection key material
├── register cancellation
├── open SSH session / jump session
├── execute independent channel
├── collect bounded output
├── obtain exit status
├── redact known secrets
└── return generic result
```

### 12.3 兼容要求

Runbook 对前端的以下字段和语义保持不变：

- status
- risk
- commandPreview
- expectedMatched
- source.kind = `sshRunbook`
- source profile/host/port/username
- unauthorized result
- cancellation command
- timeout validation
- secret references

generic kernel 可以返回更丰富的截断元数据，但 P0 不强制立即扩展现有 Runbook TypeScript API；先通过内部测试使用，P1 Agent 协议再正式消费。

## 13. 内部测试 Harness

P0 不新增用户可见“任意命令执行”入口。验收通过以下方式完成：

- Rust 单元测试直接构造 crate-private request。
- 现有隔离 SSH E2E fixture。
- 可选 `src-tauri/examples/reviewed_execution_baseline.rs`，只在显式环境变量与已配置 fixture 下运行。

Harness 必须：

- 要求显式 profile/fixture，不提供生产主机默认值。
- 只执行固定内置命令，或仅在测试构建中接受参数。
- 不注册到 Tauri invoke handler。
- 不绕过 known hosts 或身份校验。

## 14. 实施顺序

### 步骤 0：行为冻结

- 为现有 Runbook execution 增加 characterization tests。
- 固定成功、非零退出、expected mismatch、取消、超时、输出过大、jump host 和 secret redaction 行为。
- 记录当前外部 API 与 operation history 事件。

### 步骤 1：类型与纯函数

- 新建 execution request/result/target 类型。
- 实现 hard-limit validation。
- 实现 canonical identity digest。
- 实现输出 collector 和 UTF-8 截断测试。
- 实现通用 redaction 测试。

### 步骤 2：抽取 SSH 执行

- 移动并重命名 `open_runbook_session`。
- 移动并重命名 `execute_channel`。
- 引入通用 cancellation handle。
- 保持连接与 jump-host 行为。

### 步骤 3：Runbook adapter 切换

- `execute_runbook_step` 构造 generic request。
- generic result 映射回现有 Runbook result。
- expected matching 保留在 Runbook 层。
- 运行现有所有 Runbook 与 multi-host 测试。

### 步骤 4：Fixture 验收

- 运行固定 `uname -a` 成功场景。
- 运行长输出截断场景。
- 运行 sleep timeout/cancel 场景。
- 运行目标被修改后的 identity mismatch 场景。
- 运行 secret 回显场景，确认返回内容已擦除。

### 步骤 5：清理与文档

- [x] 确认 Runbook 内重复 SSH/session/channel 执行代码已删除，并集中生产 `Channel::exec` 原语。
- [x] 更新 execution 模块注释、架构文档和 Exec/PTY ADR。
- [x] 记录阻塞 DNS/TCP/handshake/auth 尚不能被 operation deadline 立即中断的限制。
- [x] 记录后台化远程进程与进程内 registry 的崩溃恢复限制。
- [x] 更新 `ROADMAP.md`、roadmap audit、实际测试证据和 P1 准入结论。

## 15. 测试矩阵

### 15.1 请求校验

| 场景 | 预期 |
| --- | --- |
| 空 operation ID | InvalidRequest |
| 重复 operation ID | 注册失败，不启动第二次执行 |
| 空命令 | InvalidRequest |
| 命令包含 NUL | InvalidRequest |
| 命令超过 8 KiB | InvalidRequest |
| timeout 小于 1 秒或超过 300 秒 | InvalidRequest |
| capture limit 超过后端上限 | InvalidRequest |

### 15.2 目标身份

| 场景 | 预期 |
| --- | --- |
| profile 不存在 | TargetNotFound |
| host 改变 | TargetMismatch |
| port 改变 | TargetMismatch |
| username 改变 | TargetMismatch |
| auth method 改变 | TargetMismatch |
| jump host 改变 | TargetMismatch |
| UI 当前标签改变 | 对冻结目标无影响 |

### 15.3 执行结果

| 场景 | 预期 |
| --- | --- |
| exit 0 | Completed + exitCode 0 |
| exit 7 | Completed + exitCode 7，由调用方判断业务失败 |
| stdout/stderr 同时输出 | 分离返回 |
| capture 超限 | Completed + truncated，继续 drain |
| total read hard limit 超限 | OutputLimitExceeded |
| 无效 UTF-8 | 有界 lossy decode，不 panic |
| channel open 失败 | ChannelOpenFailed |
| 读取 exit status 失败 | TransportFailed |

### 15.4 取消与超时

| 场景 | 预期 |
| --- | --- |
| 执行前取消 | 不启动命令，Cancelled |
| 执行中取消 | 关闭 channel，Cancelled |
| deadline 到达 | TimedOut |
| cancel 与成功同时到达 | 只接受一个终态 |
| worker 返回迟到成功 | 不覆盖 Cancelled/TimedOut |
| registry 清理 | 终态后 operation ID 可按规则重新使用 |

### 15.5 秘密边界

| 场景 | 预期 |
| --- | --- |
| 命令回显密码 | stdout 为 `[REDACTED]` |
| stderr 回显 passphrase | stderr 为 `[REDACTED]` |
| connection error 含私钥片段 | error 已擦除 |
| secret 跨读取 chunk | 重组后仍被擦除 |
| 取消/超时 | 错误路径不打印 request Debug |

### 15.6 回归

- Runbook parser tests。
- Runbook execution tests。
- Multi-host Runbook tests。
- Operation history tests。
- Connection、known hosts、jump host tests。
- `cargo fmt --check`。
- `cargo clippy`。
- `cargo test`。
- 前端 Runbook tests 与 `pnpm build`。

## 16. 阶段演示

P0 至少提供四个内部演示场景。

### 演示 A：正常执行

```text
目标：冻结的隔离 SSH profile
命令：uname -a
预期：Completed、exitCode 0、目标身份一致、stdout 有内容
```

### 演示 B：用户取消

```text
命令：sleep 30
动作：执行后发出 cancel
预期：Cancelled、registry 清理、迟到结果不改变状态
```

### 演示 C：输出截断

```text
命令：固定 fixture 输出超过 capture limit、低于 hard limit
预期：Completed、stdoutTruncated = true、exitCode 可用
```

### 演示 D：目标漂移

```text
动作：冻结目标后修改 profile 的 host 或 username
预期：TargetMismatch，SSH 连接不会发起
```

## 17. P0 验收标准

### 17.1 功能

- 一个 crate-private API 可以对冻结远程 profile 执行一条受审阅命令。
- 返回 stdout、stderr、exit code、时间、字节数、截断和目标身份。
- 支持 timeout 与 operation-level cancel。

### 17.2 安全

- 没有新增通用前端命令执行入口。
- 没有调用或修改交互 PTY 输入链路。
- profile 身份变化时执行失败。
- 已知连接和变量秘密不出现在结果、错误、日志或审计中。
- 资源上限完全由 Rust 后端执行。

### 17.3 兼容

- Runbook UI、请求和结果契约保持兼容。
- Runbook exact risk、source digest、expected result 和逐步审批行为保持不变。
- Multi-host Runbook 仍通过同一现有上层调度执行。
- 现有自动化测试无回归。

### 17.4 可演进

- P1 可以在不修改 SSH kernel 的情况下新增 `shell.exec` tool adapter。
- P1 Agent 不需要依赖 `RunbookDocument`。
- P2 approval 可以绑定 generic request digest，而不改 SSH 执行实现。
- P3 local executor 可以复用 request/result/cancellation/output 语义，但使用不同 transport。

## 18. P0 退出门槛

P0 只有同时满足以下条件才可标记 `verified`：

1. `execution` 模块成为 Runbook 生产执行链路的唯一 SSH channel 实现。
2. 旧 Runbook 内不存在第二份可运行的 `open session + channel.exec` 逻辑。
3. Runbook 外部行为与 operation history 语义没有回归。
4. 正常执行、非零退出、取消、超时、输出截断、hard limit、target mismatch 和 secret redaction 均有自动化测试。
5. Windows 与 macOS 常规 Rust/前端门禁通过；SSH fixture 至少在当前受支持的隔离环境通过。
6. 新内核没有注册为可由前端任意调用的 Tauri command。
7. Exec/PTY ADR 已合入，明确 P1 不得通过 `write_session` 绕过内核。
8. Roadmap 更新实际完成证据、遗留限制和下一阶段准入结论。

### 18.1 最终审计（2026-08-27）

| # | 结论 | 证据 |
| ---: | --- | --- |
| 1 | 通过 | Runbook 生产链为 `execute_runbook_step → execute_reviewed_ssh_command → execute_ssh_channel`；生产 crate 的 raw `Channel::exec` 调用集中在 `execution/ssh.rs`。 |
| 2 | 通过 | `runbook.rs` 对旧 `open_runbook_session`、`execute_channel`、`ExecutionOutcome` 和直接 `channel.exec` 均为零；历史抽取链为 `7e437a7` 与 `f1dd562`。 |
| 3 | 通过（本地证据） | Runbook adapter 保留 source digest、exact risk、expected match、返回契约和 operation-history 映射；Rust/前端全量测试通过。 |
| 4 | 通过 | Rust 单元与 Docker fixture 覆盖正常、exit 7、cancel、timeout、truncation、hard limit、target/jump drift、secret redaction、无效 UTF-8 和 late result。 |
| 5 | 未通过：`pending-external` | 当前 macOS 常规门禁和本机 Linux 双 sshd Docker fixture通过，Windows workflow 配置已审查但当前提交尚无 Windows runner 实跑结果。 |
| 6 | 通过 | execution 无 `#[tauri::command]`；invoke handler 只有现有 Runbook adapter，没有 generic execute/shell command。 |
| 7 | 通过 | `docs/adr/agent-execution-channel.md` 明确 Exec/PTY 职责、P1 禁止 `write_session` 绕过、后台进程、deadline 和崩溃限制。 |
| 8 | 通过 | 本文、`ROADMAP.md`、`docs/roadmap-audit.json` 和步骤 4 fixture 记录均已更新实际证据、限制与 P1 阻断结论。 |

总评：7/8 退出门槛已闭合；第 5 条等待当前提交的 Windows 托管门禁。因此 P0 是 `implemented`，不是 `verified`。

## 19. P1 准入条件

只有 P0 verified 后，P1 才能开始接入模型与只读 Agent loop。当前准入状态为 `blocked`，没有开始 P1。P1 的入口条件是：

- 能从 Rust 内部稳定构造和执行 generic reviewed request。
- target identity 可跨多个工具调用复用。
- execution result 足以生成 Agent evidence。
- cancel、timeout 和 late result 状态已稳定。
- 输出截断不会让调用方误判为完整证据。
- Runbook 已证明共享内核没有削弱现有审批与秘密边界。

如果这些条件未满足，P1 只能继续文档级 schema/UI 设计，不能开放真实 `shell.exec`，不能新增 generic execution Tauri command，也不能通过 `write_session` 把模型输出注入交互 PTY。解除当前阻断至少需要：当前提交的 Windows Rust/前端门禁通过、审计台账第 5 条更新为 `verified`，再由独立收尾提交把 P0 状态改为 `verified`。

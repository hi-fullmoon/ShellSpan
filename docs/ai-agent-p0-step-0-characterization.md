# AI Agent P0 步骤 0：Runbook execution 行为冻结

> 基线：TermBridge v2.0.54 / `2f95336`
>
> 范围：仅执行 `ai-agent-p0-execution-foundation-design.md` 的步骤 0。本文记录现有行为，不定义步骤 1–5 的目标实现。

## 冻结边界

现有生产调用链保持不变：

```text
Runbook panel
  -> execute_runbook_step { request }
  -> parse / approval / profile binding / interpolation
  -> open_runbook_session
  -> independent SSH channel.exec
  -> expected-result matching / redaction
  -> RunbookStepExecutionResult
```

本阶段没有新增通用执行 command、没有创建 `execution` 模块、没有改变交互 PTY，也没有改变输出过大时的失败语义。

## 当前前端 IPC API

`execute_runbook_step` 的参数仍是 `{ request }`。request 的现有字段为：

- `operationId`、`runId`、`sourceDigest`、`runbookText`
- `itemId`、`itemKind`、`profileId`
- `authorized`、`approvedRisk`、`variableValues`
- 可选 `evidenceReferences`
- `timeoutMs`、`connection`

result 的现有字段为：

- 身份：`operationId`、`runId`、`runbookId`、`sourceDigest`、`itemId`、`itemKind`、`profileId`
- 结果：`status`、`risk`、`commandPreview`、`startedAt`、`completedAt`
- 来源：`source.kind = "sshRunbook"`，以及 source 的 `profileId`、`host`、`port`、`username`
- 证据：`exitCode`、`expectedMatched`、`stdout`、`stderr`、`error`

Rust 序列化当前会将没有值的 result `Option` 字段写为 `null`；TypeScript 调用方仍将这些字段声明为可选。characterization test 固定当前 Rust 序列化形状，避免后续抽取时意外改变 IPC。

`cancel_runbook_step` 的参数仍是 `{ operationId }`，成功时不返回业务 payload。

## 当前结果语义

| 场景 | 当前外部行为 |
| --- | --- |
| exit 0 且 expected 全部匹配 | `status=success`、`expectedMatched=true`、保留 exit code/stdout/stderr |
| 非零 exit 与 reviewed exit code 相同 | 仍可 `status=success`；非零退出本身不等于业务失败 |
| exit code 或任一 `stdoutContains` 不匹配 | `status=failed`、`expectedMatched=false`、保留 exit code 与输出，error 为 expected mismatch |
| 执行前/执行中取消 | `status=cancelled`、无 exit code/stdout/stderr |
| channel deadline 到达 | `status=timedOut`、无 exit code/stdout/stderr |
| stdout 超过 64 KiB 或 stderr 超过 8 KiB | 立即 `status=failed`，error 为 safety-limit 错误；不返回部分输出 |
| jump host | 请求进入现有 jump authentication、direct-tcpip bridge 与 target host-key 分支；本机成功证据缺口见下文 |
| 已知变量/连接 secret 出现在 stdout、stderr 或 execution error | 返回前逐个精确替换为 `[REDACTED]` |

取消与 timeout 同时在 channel 打开前已成立时，当前检查顺序使取消优先。operation registry 在终态后删除 operation ID；删除后再次取消返回 not-found 错误。

## 当前 operation history 事件

operation history 只保留安全元数据，不保留 `runbookText`、变量值、连接凭证、stdout 或 stderr。

已授权的 `execute_runbook_step` 当前产生：

1. `started / running`
2. `approved / running`，带 approval evidence reference
3. 一个终态事件：
   - Runbook `success` -> `completed / succeeded`
   - Runbook `cancelled` -> `completed / cancelled`
   - Runbook `timedOut` -> `failed / timedOut`，`errorCategory=timeout`
   - Runbook `failed` -> `failed / failed`，`errorCategory=unknown`
   - Runbook `unauthorized` -> `failed / unauthorized`，`errorCategory=unknown`

终态可保留 target identity、经过脱敏的 `commandPreview`、exit code 和 evidence references。operation ID、run ID、profile/host/port/username、risk 或 command preview 不一致时，终态记为 `identityMismatch`。

`cancel_runbook_step` 当前产生：

1. `cancelRequested / cancelling`
2. IPC 成功返回后 `completed / cancelling`

第二条是当前既有语义，本阶段只冻结，不在步骤 0 中调整。

## 自动化证据

不依赖 SSH fixture、常规 `cargo test` 可稳定运行的最低层测试覆盖：

- Rust result 的 camelCase IPC 序列化形状。
- channel 打开前取消、超时，以及二者竞争时的当前优先级。
- cancellation registry 的 flag 与清理语义。
- stdout/stderr 现有 capture limit 的精确边界和超限错误。
- target 与 jump-host password、private key、passphrase 的 redaction needles。
- 前端 execute/cancel invoke command 名与参数 envelope。
- operation history 的 start/approval/final/cancel 事件序列、终态 status 映射和敏感字段排除。

隔离 `tests/ssh-e2e` Docker service 下的 ignored tests 覆盖真实 SSH channel：

- exit 0 成功及 stdout/stderr 分离。
- exit 7 仍可匹配 reviewed expectation。
- `stdoutContains` mismatch。
- 执行中取消与 channel timeout。
- stdout 超过 64 KiB 时现有立即失败行为。
- stdout/stderr secret echo 后的现有 adapter redaction seam。
- 既有 multi-host 输出隔离。

## 证据缺口与限制

> 2026-08-27 收尾追踪：下面是步骤 0 当时的准确基线。步骤 5 已用单线程 nonblocking direct-tcpip bridge pump 和不同 host key 的双 sshd fixture关闭 jump-host 成功路径；连接/认证仍未被 operation deadline 立即中断，原 deadline 限制继续成立。最终证据见 `docs/ai-agent-p0-step-4-fixture-acceptance.md` 与 P0 设计第 18 节。

- SSH characterization 位于当前 `open_runbook_session + execute_channel + redact` 生产 seam，而不是带真实 Tauri `AppHandle`、SQLite profile 和 OS keychain 的完整 command integration test。profile binding、source digest、exact risk 和 keychain interpolation 继续由现有纯函数/组件测试覆盖，但尚无一个测试把所有这些层与真实 SSH 串在一起。
- jump-host 的稳定最低层测试冻结了 target identity 不被 jump identity 替换、operation result 不序列化 jump 配置，以及 target/jump secrets 都进入 redaction needles。曾在本机 Docker 环境分别尝试“同一 sshd 回连”和“两容器独立 sshd”两种真实 jump fixture，target SSH handshake 均在现有 `connect_through_jump_host` bridge 上等待 15 秒后超时，因此本阶段没有 jump execution 成功证据，也没有提交伪造的成功用例。判断该超时是 fixture/平台限制还是生产 bridge 缺陷需要后续独立诊断；步骤 0 不改变生产连接代码。
- keychain secret reference 的真实 OS keychain 读取不适合作为跨平台常规测试 fixture；本阶段冻结 preview 语义和最终 redaction seam，没有伪造原生 keychain 通过证据。
- timeout characterization 覆盖 command channel。现有 SSH connect/auth 内部 I/O timeout 最长 15 秒，尚未证明连接阶段严格受 Runbook deadline 约束。
- 现有输出超限是失败且丢弃部分输出；`truncated` metadata 和继续 drain 属于设计步骤 1–4，不在步骤 0 提前实现。

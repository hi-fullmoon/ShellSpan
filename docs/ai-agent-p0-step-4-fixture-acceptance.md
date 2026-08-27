# AI Agent P0 步骤 4：Fixture 验收记录

> 基线：`f1dd5626e6a6f6e64f8323ae4eea35e89e22e28a`
>
> 验收日期：2026-08-27
>
> 范围：只执行 `ai-agent-p0-execution-foundation-design.md` 的步骤 4。本文不实施步骤 5，不更新 `ROADMAP.md` 的 P0 状态，也不清理或重写连接架构。

## Harness 边界

新增 harness 位于 `src-tauri/src/execution/fixture.rs`，只通过 `#[cfg(test)]` 编译，调用 crate-private `execute_reviewed_ssh_command`。它具有以下限制：

- 没有 `#[tauri::command]`，也没有加入 `tauri::generate_handler!`。
- 必须显式设置 `TERMBRIDGE_E2E_SSH_FIXTURE=1` 以及 host、port、username、password 四个 fixture 环境变量；不提供生产主机、端口或凭证默认值。
- host 必须是显式 loopback IP，避免 ignored test 被误指向生产主机。
- 命令来自 test-only 固定枚举，不接受运行时任意命令。
- known hosts 由隔离 sshd 的真实握手生成；测试执行仍走生产 host-key 检查、profile 身份复核和密码认证，没有绕过身份校验。
- `scripts/run-ssh-e2e.ps1` 现在显式设置 fixture opt-in，既有 Runbook fixture 也复用同一显式连接入口。

静态检查：

```text
rg -n 'execute_reviewed_ssh_command|tauri::command' \
  src-tauri/src/lib.rs src-tauri/src/execution/mod.rs \
  src-tauri/src/execution/fixture.rs
```

结果：generic 入口只由 crate-private execution 模块和 `cfg(test)` fixture 引用；没有 generic Tauri command。生产 command registry 仍只有既有 Runbook adapter。

## Fixture 启动与主验收命令

环境为 macOS、Docker Server 29.7.2、`tests/ssh-e2e` 的 Alpine 3.22/OpenSSH sshd，端口只发布到 `127.0.0.1:22222`。

```bash
docker compose --project-name termbridge-p0-step4 \
  --file tests/ssh-e2e/compose.yml up --build --detach --wait

TERMBRIDGE_E2E_SSH_FIXTURE=1 \
TERMBRIDGE_E2E_SSH_HOST=127.0.0.1 \
TERMBRIDGE_E2E_SSH_PORT=22222 \
TERMBRIDGE_E2E_SSH_USERNAME=termbridge \
TERMBRIDGE_E2E_SSH_PASSWORD=termbridge-e2e \
cargo test --manifest-path src-tauri/Cargo.toml \
  isolated_ssh_sftp_end_to_end -- --ignored --nocapture --test-threads=1

docker compose --project-name termbridge-p0-step4 \
  --file tests/ssh-e2e/compose.yml down --volumes --remove-orphans
```

结果：`14 passed; 0 failed`，容器、network 与 volumes 随后删除。14 项包含 4 个新增 generic fixture 验收，以及既有 connection、port forward、remote health、Runbook 和 multi-host Runbook fixture 回归。

## 逐场景证据

### 1. 固定 `uname -a`

`isolated_ssh_sftp_end_to_end_reviewed_execution_uname` 通过：

- generic status 为 `Completed`；
- `exitCode = 0`；
- 返回 target 与执行前冻结的 `FrozenTargetIdentity` 全字段及 `identityDigest` 相等；
- stdout 非空并包含 fixture 的 `Linux` 标识；
- error category 为空；
- 终态后 operation ID 已从 registry 删除。

### 2. Capture 截断、hard limit 与无效 UTF-8

`isolated_ssh_sftp_end_to_end_reviewed_execution_output_boundaries` 通过：

- 固定命令产生 280 bytes stdout，并以 exit 7 结束；policy 为 stdout capture 64 bytes、hard limit 4096 bytes。generic result 为 `Completed + exitCode 7 + stdoutTruncated=true`，`stdoutBytesCaptured=64`，`stdoutBytesRead=280`，保留头部与尾部证据。
- Runbook 的真实 `65537` bytes 场景仍通过既有 compatibility test：generic collector 完成并标记 truncated 后，adapter 对外仍返回 `failed`、不暴露 exit/stdout/stderr，error 为 `runbook command output exceeded the safety limit`。外部语义没有随 generic result 改变。
- 固定 8193 bytes 输出配 hard limit 8192 bytes，返回 `Failed + OutputLimitExceeded`，无部分 stdout 和 exit code；registry 已清理。
- fixture 的 `printf 'ok\377done'` 返回 `Completed + exitCode 0`，stdout 为 `ok�done`，没有 panic，也没有错误地标记 truncated。

### 3. 执行中 cancel、timeout、registry 与迟到结果

`isolated_ssh_sftp_end_to_end_reviewed_execution_cancel_timeout_and_late_result` 通过：

- cancel 命令先在远端写入 started marker 再 `sleep 5`；500 ms 后 cancel，结果为 `Cancelled` 且无 exit code。随后固定 probe 读到并删除 marker，证明取消发生在命令已启动之后。
- Cancelled 返回后，registry 对原 operation ID 返回 `OperationNotFound`。
- 立即用相同 operation ID 启动新的固定命令；它与旧 worker teardown 重叠，仍返回 `Completed + exitCode 0 + TERMBRIDGE_REUSED_OPERATION`。旧 worker 的迟到结果/handle drop 没有覆盖新结果或删除新注册。
- `sleep 5` 配 1 秒 deadline 返回 `TimedOut` 且无 exit code；终态后 registry 同样清理。
- 最低层 `cancel_timeout_and_late_worker_result_have_one_terminal_state` 继续用已排队的迟到 `Completed` outcome 证明 Cancelled/TimedOut 终态不会被 worker result 替换。

### 4. 冻结身份漂移且不发起 SSH

非 ignored 测试 `frozen_profile_drift_never_opens_target_or_jump_tcp_connection` 通过。每个变体先冻结 request 并写入匹配 profile，再修改数据库中的 target host、target username 或 jump username：

- 三个变体均返回 `Failed + TargetMismatch`；
- 请求中的连接仍指向独立的 loopback `TcpListener`；kernel 返回后 listener 的 `accept()` 均为 `WouldBlock`，证明没有 TCP/SSH 连接被发起；
- 测试不依赖不可达主机、超时速度或命令副作用来推断“未连接”。

### 5. Secret 擦除与重组边界

`isolated_ssh_sftp_end_to_end_reviewed_execution_secret_redaction` 通过：

- 大于 4096 bytes 的真实 stdout 把固定 secret 放在 4 KiB 读取边界，返回内容只保留 `[REDACTED]`，原 secret 不存在；
- 另一个真实输出使用 stdout capture 64 bytes（head 48 / tail 16），分别把 secret 的前 8 bytes 放在 head 末尾、后 16 bytes 放在 tail 开头，中间输出被截断。front/tail 重组后执行整体 redaction，结果以 `[REDACTED]` 结束且 `stdoutTruncated=true`；
- 同一次命令把 secret 写入 stderr，stderr 精确返回 `[REDACTED]`；序列化整个 generic result 也找不到 secret；
- `execution::ssh::tests::panic_payload_and_failure_messages_use_the_redaction_boundary` 覆盖错误路径：worker panic payload 被丢弃，包含 secret 的 transport failure message 在 generic result 中变为 `[REDACTED]`；
- `execution::output::tests::redaction_runs_after_cross_chunk_and_truncated_reassembly` 继续固定任意 collector push chunk 与 front/tail 重组后的擦除顺序。

## Jump-host 尝试与未关闭缺口

单独保留 ignored 的成功期望测试 `manual_isolated_reviewed_execution_jump_host_success_path`。它使用同一隔离 sshd：外层通过发布的 loopback 端口连接 jump，内层 direct-tcpip 指向 jump 容器自身的 `127.0.0.1:22`；known-hosts 文件包含从真实 fixture 握手取得的同一 host key，并分别绑定 jump 和 target 的精确 endpoint。

复现命令：

```bash
TERMBRIDGE_E2E_SSH_FIXTURE=1 \
TERMBRIDGE_E2E_SSH_HOST=127.0.0.1 \
TERMBRIDGE_E2E_SSH_PORT=22222 \
TERMBRIDGE_E2E_SSH_USERNAME=termbridge \
TERMBRIDGE_E2E_SSH_PASSWORD=termbridge-e2e \
cargo test --manifest-path src-tauri/Cargo.toml \
  manual_isolated_reviewed_execution_jump_host_success_path \
  -- --ignored --nocapture --test-threads=1
```

实际结果在 15.17 秒后失败：

```text
status=Failed
errorCategory=ConnectionFailed
ssh handshake failed: [Session(-9)] Timed out waiting on socket
```

sshd 日志证明外层 jump password authentication 已 accepted；内层 target handshake 没有完成。该结果与步骤 0 记录的现有 `connect_through_jump_host` bridge timeout 一致。本阶段没有重写 bridge、没有放宽 known hosts、没有伪报 jump-host success。它仍是后续需授权诊断的连接架构风险。

## 回归门禁

本阶段最终执行结果：

| 命令 | 结果 |
| --- | --- |
| `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` | 通过 |
| `cargo build --manifest-path src-tauri/Cargo.toml` | 通过 |
| `cargo test --manifest-path src-tauri/Cargo.toml` | 通过，338 passed / 16 ignored |
| 显式 Docker SSH fixture 命令 | 通过，14 passed / 0 failed |
| `pnpm exec vitest run src --reporter=dot` | 通过，139 files / 1140 tests |
| `pnpm build` | 通过；仅有既有 large chunk warning |
| `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --all-features -- -D warnings` | 未全绿：命中 `keychain.rs:91`、`menu.rs:153` 两个既有 `needless_return` |
| 同一 clippy 命令额外允许既有 `clippy::needless-return` | 通过，证明本阶段新增代码没有其他 warning |
| `pnpm check:roadmap` | 既有失败：`explore-portability-targets roadmapItem` 已不是 `ROADMAP.md` 的 exact item |
| `pnpm test:scripts` / 未排除 scripts 的 `pnpm test` | 因同一个既有 roadmap audit 前置失败，18 个负向断言提前失败；其余分别 17/1157 tests 通过 |

`keychain.rs`、`menu.rs`、`ROADMAP.md`、`docs/roadmap-audit.json`、roadmap audit 脚本与测试相对指定基线均无本阶段改动。因此上述 clippy 与 roadmap audit 是基线问题，不在步骤 4 越权修复。

## 阶段结论

步骤 4 要求的 direct SSH generic kernel、Runbook compatibility、取消/超时、目标漂移、秘密擦除、hard limit 和无效 UTF-8 证据已补齐。jump-host 成功路径仍有可复现 handshake timeout，明确保留为风险而不是通过项。

步骤 5 尚未开始：没有执行旧代码清理、架构文档收尾、连接 deadline 扩展或 `ROADMAP.md` P0 状态更新。

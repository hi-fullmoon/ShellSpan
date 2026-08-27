# AI Agent P0 步骤 4：Fixture 验收记录

> 基线：`f1dd5626e6a6f6e64f8323ae4eea35e89e22e28a`
>
> 验收日期：2026-08-27
>
> 原始范围：只执行 `ai-agent-p0-execution-foundation-design.md` 的步骤 4。步骤 5 在本文末尾追加了 jump-host 根因闭环与最终重跑证据；原始失败记录保留用于审计。

## Harness 边界

新增 harness 位于 `src-tauri/src/execution/fixture.rs`，只通过 `#[cfg(test)]` 编译，调用 crate-private `execute_reviewed_ssh_command`。它具有以下限制：

- 没有 `#[tauri::command]`，也没有加入 `tauri::generate_handler!`。
- 必须显式设置 `TERMBRIDGE_E2E_SSH_FIXTURE=1`、direct target、jump endpoint、jump 内可解析的 target endpoint、username 和 password fixture 环境变量；不提供生产主机、端口或凭证默认值。
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

环境为 macOS、Docker Server 29.7.2、`tests/ssh-e2e` 的两个 Alpine 3.22/OpenSSH sshd，端口只发布到 `127.0.0.1:22222`（target）与 `127.0.0.1:22223`（jump）。

```bash
docker compose --project-name termbridge-p0-step4 \
  --file tests/ssh-e2e/compose.yml up --build --detach --wait

TERMBRIDGE_E2E_SSH_FIXTURE=1 \
TERMBRIDGE_E2E_SSH_HOST=127.0.0.1 \
TERMBRIDGE_E2E_SSH_PORT=22222 \
TERMBRIDGE_E2E_SSH_USERNAME=termbridge \
TERMBRIDGE_E2E_SSH_PASSWORD=termbridge-e2e \
TERMBRIDGE_E2E_SSH_JUMP_HOST=127.0.0.1 \
TERMBRIDGE_E2E_SSH_JUMP_PORT=22223 \
TERMBRIDGE_E2E_SSH_JUMP_TARGET_HOST=ssh \
TERMBRIDGE_E2E_SSH_JUMP_TARGET_PORT=22 \
cargo test --manifest-path src-tauri/Cargo.toml \
  --locked isolated_ssh_sftp_end_to_end \
  -- --ignored --nocapture --test-threads=1

docker compose --project-name termbridge-p0-step4 \
  --file tests/ssh-e2e/compose.yml down --volumes --remove-orphans
```

步骤 5 最终重跑结果：`15 passed; 0 failed`，容器、network 与 volumes 随后删除。15 项包含 5 个 generic fixture（含双 sshd jump-host），以及既有 connection、port forward、remote health、Runbook 和 multi-host Runbook fixture 回归。

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

## Jump-host 原始失败与步骤 5 闭环

步骤 4 曾保留 ignored 成功期望测试 `manual_isolated_reviewed_execution_jump_host_success_path`。它使用同一隔离 sshd：外层通过发布的 loopback 端口连接 jump，内层 direct-tcpip 指向 jump 容器自身的 `127.0.0.1:22`；known-hosts 文件包含从真实 fixture 握手取得的同一 host key，并分别绑定 jump 和 target 的精确 endpoint。

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

sshd 日志证明外层 jump password authentication 已 accepted；内层 target handshake 没有完成。该结果与步骤 0 记录的现有 `connect_through_jump_host` bridge timeout 一致，步骤 4 当时正确保留为阻断。

步骤 5 依据该复现定位到 `bridge_channel_tcp`：两个线程在同一个 blocking libssh2 session 上分别 read/write，channel→TCP 阻塞读可能持有 session 串行锁，TCP→channel 因而无法转发内层客户端的 SSH 握手字节。修复把 direct-tcpip bridge session 与本地 bridge socket 切为 nonblocking，在一个 bridge worker 内用两个固定 64 KiB 缓冲区依次推进 TCP→channel 和 channel→TCP，对 WouldBlock/TimedOut 使用 10 ms 退避；这既避免同一 libssh2 session 的跨线程竞争，也保持有界 backpressure。host-key、profile、凭证和身份摘要边界均未改变。

fixture 随后改为两个独立 sshd。jump 与 target 各自生成不同 host key；测试分别通过其发布的 loopback endpoint取得真实 key，再把 key 绑定到执行时的精确 jump endpoint 与 Docker 内 target endpoint。`isolated_ssh_sftp_end_to_end_reviewed_execution_jump_host_success_path` 现随完整 ignored fixture 运行并验证 `Completed + exitCode 0 + Linux stdout`。

步骤 5 最终实现的定点稳定性复验连续运行 10 次：`10/10 passed`，单次约 0.36–0.42 秒；随后完整 15 项 fixture 也通过。该证据关闭了原 15 秒内层 handshake timeout 阻断。

## 回归门禁

P0 收尾最终执行结果：

| 命令 | 结果 |
| --- | --- |
| `cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check` | 通过 |
| `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --locked -- -D warnings` | 通过；`keychain.rs` 与 `menu.rs` 两个既有 `needless_return` 已做等价最小清理 |
| `cargo test --manifest-path src-tauri/Cargo.toml --all-targets --locked` | 通过，338 passed / 16 ignored |
| 显式双 sshd Docker SSH/SFTP fixture | 通过，15 passed / 0 failed |
| `pnpm check:roadmap` | 通过；产品路线图与 P0 八项均使用显式 source 精确映射 |
| `pnpm test:scripts` | 通过，4 files / 39 tests |
| `pnpm test` | 通过，143 files / 1179 tests |
| `pnpm build` | 通过；仅有既有 large chunk warning |
| Windows CI | 配置已检查：`windows-2025`、Node/pnpm 前端 test/build、pinned Rust、fmt/strict clippy/all-targets locked tests；当前提交未实际运行，保持 `pending-external` |

## 阶段结论

步骤 4 要求的 direct SSH generic kernel、Runbook compatibility、取消/超时、目标漂移、秘密擦除、hard limit 和无效 UTF-8 证据已补齐。步骤 5 又以最小 nonblocking bridge 修复和双 sshd fixture 关闭了 jump-host 成功路径阻断。

最终 P0 状态与全门禁见 `docs/ai-agent-p0-execution-foundation-design.md` 第 18 节。连接/认证阶段 deadline 和 Windows 当前提交证据仍是显式限制；不因本机 jump fixture 成功而自动把 P0 标记为 verified。

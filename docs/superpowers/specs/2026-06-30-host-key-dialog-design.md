# 未知主机密钥自动弹窗设计文档

## 日期

2026-06-30

## 背景

当前 TermBridge 在连接新主机时，如果目标主机的 SSH 指纹不在本地 known_hosts 中，会直接关闭会话并在终端里打印：

```
[termbridge] [Error] host key for 175.178.66.45:22 is not known — trust this host before connecting
```

虽然项目已经存在 `HostKeyDialog` 组件和 `check_host_key` / `trust_host` 后端命令，但用户点击连接后并不会弹出该对话框，导致首次连接无法进行。

## 目标

1. 首次连接到未知主机时，自动弹出 `HostKeyDialog` 显示指纹并等待用户确认。
2. 用户点击“信任并连接”后，自动写入 known_hosts 并继续完成连接。
3. 当已有预检查逻辑失效或绕过时（例如并发、格式问题、Reconnect 路径），仍能通过后端错误兜底重新弹窗。
4. 不影响已有自动重连逻辑。

## 设计方案

采用**前端预检查 + 后端错误兜底**的复合方案。

### 1. 保留并强化前端预检查

`useConnectionFlow.handleConnect` 保持先调用 `check_host_key`：

- `match`：直接继续 `proceedWithConnection`。
- `notFound`：弹出 `HostKeyDialog`，保存 `profile / remember / rememberPassword`。
- `mismatch` / `failure`：显示错误，不弹窗。

### 2. 增加后端错误兜底

当 `create_session` 实际握手阶段才发现主机密钥未知时，返回结构化错误，而不是让会话进入 `ssh-closed` 普通错误。

- `src-tauri/src/models.rs` 新增 `CreateSessionError` 枚举（或扩展 `SessionSummary` 为 Result 类型）。
- `src-tauri/src/known_hosts.rs` 导出 `is_host_key_error(message)`，用于识别中英文 host key 未知 / 不匹配文案。
- `src-tauri/src/commands.rs` 的 `create_session` 在 `run_ssh_session` 失败时判断：若错误信息匹配 host key 类错误，则返回 `CreateSessionError::HostKeyUnknown { host, port, fingerprint }`。

由于 `create_session` 是同步命令且无法将指纹从错误中直接提取，兜底错误 payload 至少包含：

```rust
CreateSessionError::HostKeyUnknown {
    host: String,
    port: u16,
    fingerprint: Option<String>,  // 可能为 None，需要前端再查一次
}
```

若获取 fingerprint 成本较高，兜底弹窗可显示 host:port 并提示再次确认；理想情况下后端在握手失败时复用 `check_host_key_blocking` 获取 fingerprint。

### 3. 前端统一处理两种弹窗入口

在 `useConnectionFlow` 中新增 `promptHostKeyDialog(profile, fingerprint)` helper，将 profile 和记住密码选项暂存到 `hostKeyDialog` 状态。两个入口复用同一个 helper：

1. `check_host_key` 返回 `notFound` 时。
2. `create_session` 抛出 host key 类错误时。

`handleTrustAndConnect` 已保存 `profile / remember / rememberPassword`，信任后调用 `proceedWithConnection` 完成连接，无需用户重新填写表单。

### 4. Reconnect 路径

用户按 Enter 触发 `onReconnect` 时，调用同一个 `handleConnect(profile)` 流程，因此未知主机会再次弹窗。

### 5. 错误文案

- 终端内仍保留原系统提示行，让用户在日志里也能看到失败原因。
- `HostKeyDialog` 标题使用现有文案 `hostKey.dialog.title`。
- 兜底错误弹窗在无法获取 fingerprint 时，description 降级为“请确认是否信任该主机”。

## 涉及文件

1. `src-tauri/src/models.rs` — 新增 `CreateSessionError`。
2. `src-tauri/src/known_hosts.rs` — 导出 host key 错误识别 helper，必要时复用 fingerprint 获取。
3. `src-tauri/src/commands.rs` — `create_session` 失败时识别并返回结构化 host key 错误。
4. `src/types.ts` — 新增前端 `CreateSessionError` 类型。
5. `src/hooks/useConnectionFlow.ts` — 统一弹窗入口、处理兜底错误、复用 `handleTrustAndConnect`。
6. `src/__tests__/appReconnect.test.tsx` 及相关测试 — 补充未知主机弹窗断言。

## 实施计划

1. 后端新增 host key 错误识别和 `CreateSessionError` 类型。
2. 修改 `create_session` 返回结构化错误。
3. 前端类型补充。
4. 重构 `useConnectionFlow` 的弹窗入口。
5. 更新测试并运行 `cargo test` / `npm test` / `npm run typecheck`。

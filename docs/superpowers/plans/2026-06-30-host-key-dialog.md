# 未知主机密钥自动弹窗实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 点击连接后，若目标主机 SSH 指纹未知或不匹配，自动弹出 `HostKeyDialog` 供用户确认并信任，确认后继续完成连接。

**Architecture:** 在 `create_session` 后端命令执行前加入同步主机密钥检查；当检查结果为未知/不匹配时，返回结构化错误 `CreateSessionError`。前端 `useConnectionFlow` 捕获该错误并复用已有 `HostKeyDialog` 弹窗，用户确认后调用 `trust_host` 并继续连接。保留现有前端预检查作为冗余保护，但不依赖它。

**Tech Stack:** React + TypeScript (frontend), Rust + Tauri v2 + ssh2 (backend), Vitest + Testing Library (tests).

## Global Constraints

- 不要改变现有 `HostKeyDialog` 的 UI 文案和样式。
- 不要删除现有 `check_host_key` / `trust_host` 命令。
- 所有新增类型必须前后端一致（camelCase JSON）。
- 每次修改后运行 `cargo test`、`npm run typecheck`、`npm test`。
- 仅当没有 jump host 时才在 `create_session` 内部做后端 host key 检查；jump host 场景保持现有行为。

---

## File Structure

| 文件 | 职责 |
|------|------|
| `src-tauri/src/models.rs` | 新增 `CreateSessionError` 枚举及 `HostKeyCheckStatus` 已存在 |
| `src-tauri/src/known_hosts.rs` | 新增 `HostKeyErrorKind` 与 `classify_host_key_error` helper |
| `src-tauri/src/commands.rs` | `create_session` 改为 async，内部 spawn_blocking 做 host key 检查 |
| `src/types.ts` | 新增前端 `CreateSessionError` 类型与 type guard |
| `src/hooks/useConnectionFlow.ts` | 捕获 `createSessionFromProfile` 抛出的结构化错误并弹窗 |
| `src/__tests__/appHostKeyDialog.test.tsx` | 新增端到端测试：未知主机触发弹窗 |
| `src-tauri/src/known_hosts.rs` tests | 新增 `classify_host_key_error` 单元测试 |

---

### Task 1: Backend — 新增结构化错误类型与 host key 错误分类

**Files:**
- Modify: `src-tauri/src/models.rs`
- Modify: `src-tauri/src/known_hosts.rs`
- Test: `src-tauri/src/known_hosts.rs` (新增单元测试)

**Interfaces:**
- Consumes: 无
- Produces:
  - `CreateSessionError` enum（带 `#[serde(rename_all = "camelCase", tag = "type", content = "payload")]`）
  - `HostKeyErrorKind` enum
  - `fn classify_host_key_error(message: &str) -> Option<HostKeyErrorKind>`

- [ ] **Step 1: 在 `models.rs` 添加 `CreateSessionError`**

在 `HostKeyCheckResult` 定义之后追加：

```rust
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "type", content = "payload")]
pub(crate) enum CreateSessionError {
    HostKeyUnknown {
        host: String,
        port: u16,
        fingerprint: Option<String>,
    },
    HostKeyMismatch {
        host: String,
        port: u16,
    },
    Other {
        message: String,
    },
}
```

- [ ] **Step 2: 在 `known_hosts.rs` 添加错误分类 helper**

在文件顶部 `use` 语句之后、`KNOWN_HOSTS_FILENAME` 之前添加：

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum HostKeyErrorKind {
    Unknown,
    Mismatch,
}

pub(crate) fn classify_host_key_error(message: &str) -> Option<HostKeyErrorKind> {
    let lower = message.to_ascii_lowercase();
    if lower.contains("is not known") || lower.contains("trust this host") {
        Some(HostKeyErrorKind::Unknown)
    } else if lower.contains("does not match") || lower.contains("man-in-the-middle") {
        Some(HostKeyErrorKind::Mismatch)
    } else {
        None
    }
}
```

- [ ] **Step 3: 编写 Rust 单元测试**

在 `known_hosts.rs` 的 `#[cfg(test)] mod tests` 末尾添加：

```rust
#[test]
fn classify_host_key_error_detects_unknown() {
    assert_eq!(
        classify_host_key_error("host key for example.com:22 is not known — trust this host before connecting"),
        Some(HostKeyErrorKind::Unknown)
    );
}

#[test]
fn classify_host_key_error_detects_mismatch() {
    assert_eq!(
        classify_host_key_error("host key for example.com:22 does not match the known key — possible man-in-the-middle attack"),
        Some(HostKeyErrorKind::Mismatch)
    );
}

#[test]
fn classify_host_key_error_returns_none_for_unrelated() {
    assert_eq!(
        classify_host_key_error("failed to connect to example.com:22"),
        None
    );
}
```

- [ ] **Step 4: 运行 Rust 测试**

Run: `cargo test -p termbridge known_hosts`
Expected: 3 个新增测试全部通过，原有测试不受影响。

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/models.rs src-tauri/src/known_hosts.rs
git commit -m "feat(backend): classify host key errors and add CreateSessionError type"
```

---

### Task 2: Backend — `create_session` 改为 async 并内置 host key 检查

**Files:**
- Modify: `src-tauri/src/commands.rs`
- Test: 通过前端测试验证（Task 4）

**Interfaces:**
- Consumes: `CreateSessionError`, `HostKeyCheckRequest`, `HostKeyCheckStatus`, `check_host_key_blocking`
- Produces: `create_session` 返回类型改为 `Result<SessionSummary, CreateSessionError>`

- [ ] **Step 1: 修改 `create_session` 函数签名**

将第 21-53 行：

```rust
#[tauri::command]
pub(crate) fn create_session(
    app: AppHandle,
    state: State<'_, SessionManager>,
    pool: State<'_, SftpPool>,
    request: SessionCreateRequest,
) -> Result<SessionSummary, String> {
```

改为：

```rust
#[tauri::command]
pub(crate) async fn create_session(
    app: AppHandle,
    state: State<'_, SessionManager>,
    pool: State<'_, SftpPool>,
    request: SessionCreateRequest,
) -> Result<SessionSummary, CreateSessionError> {
```

- [ ] **Step 2: 将字段校验错误映射为 `CreateSessionError::Other`**

将：

```rust
validate_connection_fields(&request.host, &request.username)?;
```

改为：

```rust
validate_connection_fields(&request.host, &request.username).map_err(|message| {
    CreateSessionError::Other { message }
})?;
```

- [ ] **Step 3: 在生成 session_id 后、spawn 线程前增加 host key 检查**

在 `let session_id = Uuid::new_v4().to_string();` 之后、`let summary = SessionSummary { ... };` 之前插入：

```rust
    if request.jump_host.is_none() {
        let host_key_check = {
            let app = app.clone();
            let host = request.host.clone();
            let port = request.port;
            tauri::async_runtime::spawn_blocking(move || {
                crate::known_hosts::check_host_key_blocking(
                    &app,
                    &HostKeyCheckRequest { host, port },
                )
            })
            .await
            .map_err(|error| CreateSessionError::Other {
                message: format!("failed to join host key check task: {error}"),
            })?
            .map_err(|message| {
                if let Some(kind) = crate::known_hosts::classify_host_key_error(&message) {
                    match kind {
                        crate::known_hosts::HostKeyErrorKind::Unknown => {
                            CreateSessionError::HostKeyUnknown {
                                host: request.host.clone(),
                                port: request.port,
                                fingerprint: None,
                            }
                        }
                        crate::known_hosts::HostKeyErrorKind::Mismatch => {
                            CreateSessionError::HostKeyMismatch {
                                host: request.host.clone(),
                                port: request.port,
                            }
                        }
                    }
                } else {
                    CreateSessionError::Other { message }
                }
            })?;

        match host_key_check.status {
            HostKeyCheckStatus::Match => {}
            HostKeyCheckStatus::NotFound => {
                return Err(CreateSessionError::HostKeyUnknown {
                    host: request.host.clone(),
                    port: request.port,
                    fingerprint: host_key_check.fingerprint,
                });
            }
            HostKeyCheckStatus::Mismatch => {
                return Err(CreateSessionError::HostKeyMismatch {
                    host: request.host.clone(),
                    port: request.port,
                });
            }
            HostKeyCheckStatus::Failure => {
                return Err(CreateSessionError::Other {
                    message: host_key_check
                        .message
                        .unwrap_or_else(|| "host key check failed".to_string()),
                });
            }
        }
    }
```

- [ ] **Step 4: 确保 `spawn_ssh_thread` 调用处类型兼容**

`spawn_ssh_thread` 调用签名不变，仍在 `create_session` 末尾：

```rust
spawn_ssh_thread(app, session_id, request, rx, pool.inner().clone(), connection_request);
Ok(summary)
```

- [ ] **Step 5: 编译后端**

Run: `cargo check -p termbridge`
Expected: 无编译错误。

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/commands.rs
git commit -m "feat(backend): add host key check inside async create_session"
```

---

### Task 3: 前端 — 类型与错误处理

**Files:**
- Modify: `src/types.ts`
- Modify: `src/hooks/useConnectionFlow.ts`
- Test: `src/__tests__/appHostKeyDialog.test.tsx`（Task 4 创建）

**Interfaces:**
- Consumes: 后端抛出的 `CreateSessionError` 对象（形状见 Step 1）
- Produces:
  - TypeScript 类型 `CreateSessionError`
  - Type guard `isCreateSessionHostKeyError(error: unknown): error is CreateSessionError`
  - `openHostKeyDialog(profile, fingerprint, remember, rememberPassword)` helper

- [ ] **Step 1: 在 `src/types.ts` 添加类型**

在 `HostKeyCheckResponse` 之后添加：

```typescript
export interface CreateSessionHostKeyUnknownError {
  type: 'hostKeyUnknown';
  payload: {
    host: string;
    port: number;
    fingerprint?: string;
  };
}

export interface CreateSessionHostKeyMismatchError {
  type: 'hostKeyMismatch';
  payload: {
    host: string;
    port: number;
  };
}

export interface CreateSessionOtherError {
  type: 'other';
  payload: {
    message: string;
  };
}

export type CreateSessionError =
  | CreateSessionHostKeyUnknownError
  | CreateSessionHostKeyMismatchError
  | CreateSessionOtherError;
```

- [ ] **Step 2: 在 `useConnectionFlow.ts` 引入类型并添加弹窗 helper**

在文件顶部引入：

```typescript
import type { ConnectionProfile, CreateSessionError, HostKeyCheckResponse, SessionState } from '../types';
```

在 `useConnectionFlow` 内部、`proceedWithConnection` 之前添加 helper：

```typescript
  const openHostKeyDialog = (
    profile: ConnectionProfile,
    fingerprint: string | undefined,
    remember: boolean,
    rememberPassword: boolean,
  ) => {
    setHostKeyDialog({
      open: true,
      profile,
      fingerprint,
      remember,
      rememberPassword,
    });
  };
```

- [ ] **Step 3: 修改 `handleConnect` 中 `notFound` 分支以复用 helper**

将原来：

```typescript
        setHostKeyDialog({
          open: true,
          profile,
          fingerprint: checkResult.fingerprint,
          remember,
          rememberPassword,
        });
```

改为：

```typescript
        openHostKeyDialog(profile, checkResult.fingerprint, remember, rememberPassword);
```

- [ ] **Step 4: 修改 `proceedWithConnection` 捕获 `createSessionFromProfile` 的结构化错误**

将 `proceedWithConnection` 的 `try/catch` 中 catch 块：

```typescript
    } catch (error) {
      connectionLogger.error('SSH 会话创建失败', error);
      setErrorMessage(String(error));
    }
```

改为：

```typescript
    } catch (error) {
      connectionLogger.error('SSH 会话创建失败', error);

      const hostKeyError = parseCreateSessionError(error);
      if (hostKeyError?.type === 'hostKeyUnknown') {
        openHostKeyDialog(
          profile,
          hostKeyError.payload.fingerprint,
          remember,
          rememberPassword,
        );
        return;
      }

      if (hostKeyError?.type === 'hostKeyMismatch') {
        setErrorMessage(t('app.error.hostKeyMismatch'));
        return;
      }

      setErrorMessage(String(error));
    }
```

- [ ] **Step 5: 在 `useConnectionFlow.ts` 文件末尾（或在 `lib/` 新建文件）添加 `parseCreateSessionError` type guard**

在同一文件底部、导出函数之前添加：

```typescript
function parseCreateSessionError(error: unknown): CreateSessionError | undefined {
  if (!error || typeof error !== 'object') {
    return undefined;
  }

  const record = error as Record<string, unknown>;
  const type = record.type;
  const payload = record.payload;

  if (type !== 'hostKeyUnknown' && type !== 'hostKeyMismatch' && type !== 'other') {
    return undefined;
  }

  if (!payload || typeof payload !== 'object') {
    return undefined;
  }

  const payloadRecord = payload as Record<string, unknown>;

  if (type === 'hostKeyUnknown') {
    const host = payloadRecord.host;
    const port = payloadRecord.port;
    if (typeof host !== 'string' || typeof port !== 'number') {
      return undefined;
    }
    return {
      type: 'hostKeyUnknown',
      payload: {
        host,
        port,
        fingerprint: typeof payloadRecord.fingerprint === 'string' ? payloadRecord.fingerprint : undefined,
      },
    };
  }

  if (type === 'hostKeyMismatch') {
    const host = payloadRecord.host;
    const port = payloadRecord.port;
    if (typeof host !== 'string' || typeof port !== 'number') {
      return undefined;
    }
    return {
      type: 'hostKeyMismatch',
      payload: { host, port },
    };
  }

  const message = payloadRecord.message;
  if (typeof message !== 'string') {
    return undefined;
  }

  return {
    type: 'other',
    payload: { message },
  };
}
```

- [ ] **Step 6: 运行类型检查**

Run: `npm run typecheck`
Expected: 无 TypeScript 错误。

- [ ] **Step 7: Commit**

```bash
git add src/types.ts src/hooks/useConnectionFlow.ts
git commit -m "feat(flow): handle structured create_session host key errors and show dialog"
```

---

### Task 4: 测试

**Files:**
- Create: `src/__tests__/appHostKeyDialog.test.tsx`
- Modify: 如需修复现有测试断言

**Interfaces:**
- Consumes: `App` 组件、`invoke` mock、`HostKeyDialog` 现有渲染
- Produces: 通过测试验证未知主机弹窗行为

- [ ] **Step 1: 创建测试文件 `src/__tests__/appHostKeyDialog.test.tsx`**

参考 `src/__tests__/appReconnect.test.tsx` 的 mock 结构，写入：

```typescript
// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { act, fireEvent, render, screen, waitFor } from '../test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@chakra-ui/react', async () => {
  const actual = await vi.importActual('@chakra-ui/react');
  return {
    ...(actual as object),
    Toaster: () => null,
    Toast: {
      Root: () => null,
      Indicator: () => null,
      Title: () => null,
      Description: () => null,
      ActionTrigger: () => null,
      CloseTrigger: () => null,
    },
  };
});

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => vi.fn()),
}));

vi.mock('../lib/tauri', () => ({
  isTauriRuntime: () => true,
}));

vi.mock('../lib/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('../components/FileManager', () => ({
  FileManager: () => null,
}));

vi.mock('../components/Icons', () => ({
  CloseIcon: () => null,
  PrimarySidebarIcon: () => null,
  PrimarySidebarActiveIcon: () => null,
  SecondarySidebarIcon: () => null,
  SecondarySidebarActiveIcon: () => null,
}));

vi.mock('../components/Sidebar', () => ({
  Sidebar: ({
    onOpenConnect,
  }: {
    onOpenConnect: () => void;
  }) => (
    <button onClick={onOpenConnect} type="button">
      新建连接
    </button>
  ),
}));

vi.mock('../components/SplitLayout', () => {
  function Slot({ children }: { children: React.ReactNode | ((props: { collapsed: boolean; size: number }) => React.ReactNode) }) {
    return <div>{typeof children === 'function' ? children({ collapsed: false, size: 320 }) : children}</div>;
  }
  function SplitLayout({ children }: { children: React.ReactNode }) {
    return <div>{children}</div>;
  }
  SplitLayout.Slot = Slot;
  return { SplitLayout };
});

vi.mock('../components/SessionTabs', () => ({
  SessionTabs: () => null,
}));

vi.mock('../components/TerminalPane', () => ({
  TerminalPane: () => null,
}));

vi.mock('../components/Toast', () => ({
  Toast: () => null,
  toaster: { create: vi.fn(), attrs: { overlap: false }, subscribe: () => () => {} },
}));

vi.mock('../components/UpdateRestartDialog', () => ({
  UpdateRestartDialog: () => null,
}));

import { invoke } from '@tauri-apps/api/core';
import App from '../App';

describe('Host key dialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows HostKeyDialog when check_host_key returns notFound', async () => {
    const invokeMock = vi.mocked(invoke);
    invokeMock.mockResolvedValueOnce({
      status: 'notFound',
      fingerprint: 'RSA SHA256:abc123',
    });

    render(<App />);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '新建连接' }));
    });

    fireEvent.click(screen.getByRole('button', { name: '创建连接' }));

    await waitFor(() => {
      expect(screen.getByText('首次连接到 ""')).toBeInTheDocument();
    });

    expect(screen.getByText('RSA SHA256:abc123')).toBeInTheDocument();
  });

  it('shows HostKeyDialog when create_session returns host key unknown error', async () => {
    const invokeMock = vi.mocked(invoke);
    invokeMock
      .mockResolvedValueOnce({
        status: 'match',
        fingerprint: 'RSA SHA256:abc123',
      })
      .mockRejectedValueOnce({
        type: 'hostKeyUnknown',
        payload: {
          host: 'example.com',
          port: 22,
          fingerprint: 'RSA SHA256:def456',
        },
      });

    render(<App />);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '新建连接' }));
    });

    fireEvent.click(screen.getByRole('button', { name: '创建连接' }));

    await waitFor(() => {
      expect(screen.getByText('首次连接到 "example.com"')).toBeInTheDocument();
    });

    expect(screen.getByText('RSA SHA256:def456')).toBeInTheDocument();
  });
});
```

注意：测试中的“创建连接”按钮名称需与 `ConnectDialog` 实际文案一致；若不一致，查看 `ConnectDialog.tsx` 确认后调整。

- [ ] **Step 2: 运行测试**

Run: `npm test -- src/__tests__/appHostKeyDialog.test.tsx`
Expected: 2 个测试通过。

- [ ] **Step 3: 运行全量测试**

Run: `npm test`
Expected: 全部通过；若 `appReconnect.test.tsx` 因 `create_session` 变为 async 或错误类型变化而失败，修复断言。

- [ ] **Step 4: Commit**

```bash
git add src/__tests__/appHostKeyDialog.test.tsx
git commit -m "test: add host key dialog coverage for unknown hosts"
```

---

### Task 5: 验证与收尾

- [ ] **Step 1: 后端全量测试**

Run: `cargo test -p termbridge`
Expected: 全部通过。

- [ ] **Step 2: 前端类型检查 + 测试**

Run: `npm run typecheck && npm test`
Expected: 全部通过。

- [ ] **Step 3: 手动冒烟（如条件允许）**

启动应用，连接一个未在 known_hosts 中的新主机，确认：
1. 点击连接后立即弹出 `HostKeyDialog`。
2. 指纹显示正确。
3. 点击“信任并连接”后成功建立会话。

- [ ] **Step 4: 最终 Commit**

```bash
git add -A
git commit -m "feat: auto-prompt HostKeyDialog for unknown/mismatch host keys"
```

---

## Self-Review

**Spec coverage:**
- 自动弹窗：Task 3 Step 4 + Task 4。
- 信任后自动连接：复用已有 `handleTrustAndConnect`。
- 后端兜底：Task 2。
- Reconnect 路径：后端 `create_session` 检查覆盖所有调用方。
- 不影响自动重连：后端 spawn 线程逻辑不变。

**Placeholder scan:** 无 TBD/TODO/待填充代码。

**Type consistency:**
- Rust `CreateSessionError` 使用 `tag = "type", content = "payload"` + `rename_all = "camelCase"`。
- TypeScript 类型与之对应：`type` + `payload`。
- `parseCreateSessionError` 严格校验字段类型。

**潜在风险：**
- `create_session` 改为 async 后，若前端某处未 `await` 会导致 Promise 未处理。需运行类型检查确认。
- 测试中的按钮文案需与 `ConnectDialog` 实际一致。

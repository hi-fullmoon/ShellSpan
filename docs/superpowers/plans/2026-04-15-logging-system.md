# Logging System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a unified file-backed logging system for frontend and Tauri/Rust using Tauri's official logging plugin.

**Architecture:** Tauri registers `tauri-plugin-log` as the single logging backend. Frontend code keeps the existing `createLogger(scope)` API but routes through `@tauri-apps/plugin-log` in desktop runtime and browser `console` in preview mode. Rust uses the `log` crate for command/session/file-operation lifecycle logging with redaction for secrets.

**Tech Stack:** Tauri 2, React, TypeScript, Vitest, Rust, `log`, `tauri-plugin-log`, `@tauri-apps/plugin-log`

---

### Task 1: Test the frontend logger facade

**Files:**
- Create: `src/lib/logger.test.ts`
- Modify: `src/lib/logger.ts`
- Test: `src/lib/logger.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-log", () => ({
  debug: vi.fn().mockResolvedValue(undefined),
  info: vi.fn().mockResolvedValue(undefined),
  warn: vi.fn().mockResolvedValue(undefined),
  error: vi.fn().mockResolvedValue(undefined),
}));

describe("createLogger", () => {
  it("forwards to the Tauri log plugin in desktop runtime", async () => {
    // setup window.__TAURI_INTERNALS__
    // call logger.info(...)
    // expect plugin info(...) to receive a scoped message
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/lib/logger.test.ts`
Expected: FAIL because the current logger does not use the Tauri plugin APIs.

- [ ] **Step 3: Write minimal implementation**

```ts
import { debug, error, info, warn } from "@tauri-apps/plugin-log";

export function createLogger(scope: string) {
  return {
    debug: (message: string, details?: unknown) => void log("debug", scope, message, details),
    info: (message: string, details?: unknown) => void log("info", scope, message, details),
    warn: (message: string, details?: unknown) => void log("warn", scope, message, details),
    error: (message: string, details?: unknown) => void log("error", scope, message, details),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/lib/logger.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/logger.test.ts src/lib/logger.ts
git commit -m "test: cover frontend logging facade"
```

### Task 2: Replace the frontend logger backend

**Files:**
- Modify: `src/lib/logger.ts`
- Modify: `src/types.ts`
- Delete: `src/stores/logStore.ts`
- Modify: `package.json`

- [ ] **Step 1: Write the next failing test**

```ts
it("falls back to browser console outside Tauri runtime", async () => {
  // delete window.__TAURI_INTERNALS__
  // call logger.warn(...)
  // expect console.warn to receive the scoped message
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/lib/logger.test.ts`
Expected: FAIL because fallback behavior is not fully covered by the new facade.

- [ ] **Step 3: Write minimal implementation**

```ts
function isTauriRuntime() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

async function writeToTauri(level: LogLevel, message: string) {
  if (level === "debug") return debug(message);
  if (level === "info") return info(message);
  if (level === "warn") return warn(message);
  return error(message);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/lib/logger.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add package.json src/lib/logger.ts src/types.ts src/stores/logStore.ts
git commit -m "feat: route frontend logs through tauri plugin"
```

### Task 3: Register Tauri file logging and permissions

**Files:**
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/capabilities/default.json`

- [ ] **Step 1: Add the dependency changes**

```toml
[dependencies]
log = "0.4"
tauri-plugin-log = "..."
```

- [ ] **Step 2: Register the plugin**

```rust
.plugin(
    tauri_plugin_log::Builder::new()
        .target(tauri_plugin_log::Target::new(
            tauri_plugin_log::TargetKind::LogDir {
                file_name: Some("termbridge".to_string()),
            },
        ))
        .max_file_size(1_048_576)
        .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepAll)
        .timezone_strategy(tauri_plugin_log::TimezoneStrategy::UseLocal)
        .build(),
)
```

- [ ] **Step 3: Allow the JS guest binding permission**

```json
{
  "permissions": ["core:default", "log:default"]
}
```

- [ ] **Step 4: Run compile verification**

Run: `cd src-tauri && cargo check`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/src/lib.rs src-tauri/capabilities/default.json
git commit -m "feat: enable tauri file logging"
```

### Task 4: Add Rust lifecycle logs with redaction

**Files:**
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Write the failing test**

```rust
#[test]
fn session_create_log_summary_redacts_secrets() {
    // build a summary from SessionCreateRequest
    // assert password/passphrase contents are not present
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd src-tauri && cargo test session_create_log_summary_redacts_secrets`
Expected: FAIL because no helper exists yet.

- [ ] **Step 3: Write minimal implementation**

```rust
fn summarize_session_request(request: &SessionCreateRequest) -> String {
    format!(
        "host={} port={} username={} auth_method={:?} has_password={} has_private_key_path={} has_passphrase={}",
        request.host,
        request.port,
        request.username,
        request.auth_method,
        request.password.as_ref().is_some_and(|value| !value.is_empty()),
        request.private_key_path.as_ref().is_some_and(|value| !value.is_empty()),
        request.passphrase.as_ref().is_some_and(|value| !value.is_empty()),
    )
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd src-tauri && cargo test session_create_log_summary_redacts_secrets`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/lib.rs
git commit -m "feat: add redacted rust lifecycle logging"
```

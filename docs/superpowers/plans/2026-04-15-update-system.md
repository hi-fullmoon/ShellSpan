# Update System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement startup auto-update (auto-check + auto-download + restart-install prompt) with macOS app-menu and Windows tray entry points, using Tauri updater and public GitHub Releases.

**Architecture:** Keep one frontend update state machine in React as the single source of truth for checking/downloading/installing. Rust/Tauri owns OS-native menus and tray, then emits a frontend event to trigger the same manual check flow. The updater backend is Tauri official plugin with signed artifacts, and startup checks are throttled by a local timestamp policy.

**Tech Stack:** Tauri 2, Rust, React, TypeScript, Vitest, `@tauri-apps/plugin-updater`, `tauri-plugin-updater`

---

## File Structure and Responsibilities

- `src/lib/updateFlow.ts` (create)
  - Pure reducer/state machine for update lifecycle transitions.
- `src/lib/__tests__/updateFlow.test.ts` (create)
  - Unit coverage for update state transitions and edge cases.
- `src/lib/updater.ts` (create)
  - Wrapper around Tauri updater APIs (`check`, `downloadAndInstall`) with typed events.
- `src/lib/__tests__/updater.test.ts` (create)
  - Mock-based coverage of updater wrapper behavior.
- `src/lib/updateStartupPolicy.ts` (create)
  - 12-hour startup check throttling helper over `localStorage`.
- `src/lib/__tests__/updateStartupPolicy.test.ts` (create)
  - Coverage for throttle interval behavior.
- `src/components/UpdateRestartDialog.tsx` (create)
  - Reusable install confirmation dialog with active-session warning.
- `src/components/__tests__/UpdateRestartDialog.test.tsx` (create)
  - UI behavior tests for install/snooze flows.
- `src/App.tsx` (modify)
  - Integrate startup check, progress toast, restart dialog, and listener for Rust-emitted manual check event.
- `src/types.ts` (modify)
  - Add update-related types.
- `src-tauri/Cargo.toml` (modify)
  - Add `tauri-plugin-updater` dependency.
- `src-tauri/src/lib.rs` (modify)
  - Register updater plugin, define app-menu/tray items, emit frontend trigger event, keep Windows tray resident.
- `src-tauri/capabilities/default.json` (modify)
  - Add updater plugin permission.
- `src-tauri/tauri.conf.json` (modify)
  - Add updater endpoint + pubkey config.
- `README.md` (modify)
  - Document update behavior and release prerequisites.

Scope check: this is one subsystem (update delivery + UX), split by frontend flow, native entry points, and release configuration. No separate sub-plan is required.

### Task 1: Build Update State Machine (Frontend, Pure Logic)

**Files:**
- Create: `src/lib/updateFlow.ts`
- Create: `src/lib/__tests__/updateFlow.test.ts`
- Modify: `src/types.ts`
- Test: `src/lib/__tests__/updateFlow.test.ts`

- [ ] **Step 1: Write the failing tests for state transitions**

```ts
import { describe, expect, it } from "vitest";
import {
  createInitialUpdateState,
  reduceUpdateState,
  type UpdateAction,
} from "../updateFlow";

describe("reduceUpdateState", () => {
  it("moves to downloading after update is available", () => {
    const state = createInitialUpdateState();
    const checked = reduceUpdateState(state, { type: "checkStarted", mode: "startup" });
    const available = reduceUpdateState(checked, {
      type: "updateFound",
      version: "0.2.0",
      notes: "Bug fixes",
    });

    expect(available.phase).toBe("update_available");
    expect(available.version).toBe("0.2.0");
  });

  it("records failure and keeps last known version metadata", () => {
    const state = {
      ...createInitialUpdateState(),
      phase: "update_available" as const,
      version: "0.2.0",
      notes: "Some notes",
    };

    const next = reduceUpdateState(state, {
      type: "downloadFailed",
      message: "network timeout",
    });

    expect(next.phase).toBe("error");
    expect(next.version).toBe("0.2.0");
    expect(next.errorMessage).toContain("network timeout");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/lib/__tests__/updateFlow.test.ts`
Expected: FAIL with module-not-found/type errors because `updateFlow.ts` and new update types do not exist.

- [ ] **Step 3: Implement minimal reducer and types**

```ts
export type UpdatePhase =
  | "idle"
  | "checking"
  | "update_available"
  | "downloading"
  | "downloaded"
  | "no_update"
  | "error";

export interface UpdateState {
  phase: UpdatePhase;
  mode: "startup" | "manual";
  version?: string;
  notes?: string;
  progress?: number;
  errorMessage?: string;
}

export function createInitialUpdateState(): UpdateState {
  return { phase: "idle", mode: "startup" };
}

export function reduceUpdateState(state: UpdateState, action: UpdateAction): UpdateState {
  switch (action.type) {
    case "checkStarted":
      return { ...state, phase: "checking", mode: action.mode, errorMessage: undefined };
    case "updateFound":
      return { ...state, phase: "update_available", version: action.version, notes: action.notes };
    case "downloadStarted":
      return { ...state, phase: "downloading", progress: 0 };
    case "downloadProgress":
      return { ...state, phase: "downloading", progress: action.progress };
    case "downloaded":
      return { ...state, phase: "downloaded", progress: 100 };
    case "noUpdate":
      return { ...state, phase: "no_update", progress: undefined };
    case "downloadFailed":
    case "checkFailed":
      return { ...state, phase: "error", errorMessage: action.message };
    default:
      return state;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/lib/__tests__/updateFlow.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/types.ts src/lib/updateFlow.ts src/lib/__tests__/updateFlow.test.ts
git commit -m "feat: add update lifecycle state machine"
```

### Task 2: Add Updater API Wrapper with Unit Tests

**Files:**
- Create: `src/lib/updater.ts`
- Create: `src/lib/__tests__/updater.test.ts`
- Test: `src/lib/__tests__/updater.test.ts`

- [ ] **Step 1: Write failing tests for check/download/install wrapper**

```ts
import { describe, expect, it, vi } from "vitest";

const checkMock = vi.fn();
vi.mock("@tauri-apps/plugin-updater", () => ({ check: checkMock }));

import { checkForUpdate, downloadAndInstallUpdate } from "../updater";

describe("updater wrapper", () => {
  it("returns null when no update exists", async () => {
    checkMock.mockResolvedValueOnce(null);
    const result = await checkForUpdate();
    expect(result).toBeNull();
  });

  it("forwards progress events during download", async () => {
    const mockUpdate = {
      version: "0.2.0",
      body: "Fixes",
      downloadAndInstall: vi.fn(async (onEvent: (event: any) => void) => {
        onEvent({
          event: "Progress",
          data: {
            chunkLength: 40,
            contentLength: 100,
          },
        });
      }),
    };
    const progress = vi.fn();
    await downloadAndInstallUpdate(
      { version: "0.2.0", body: "Fixes", raw: mockUpdate as any },
      progress,
    );
    expect(progress).toHaveBeenCalledWith(40);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/lib/__tests__/updater.test.ts`
Expected: FAIL because `updater.ts` and wrapper functions do not exist.

- [ ] **Step 3: Implement minimal updater wrapper**

```ts
import { check, type Update } from "@tauri-apps/plugin-updater";

export interface AvailableUpdate {
  version: string;
  body?: string;
  raw: Update;
}

export async function checkForUpdate(): Promise<AvailableUpdate | null> {
  const update = await check();
  if (!update) {
    return null;
  }

  return {
    version: update.version,
    body: update.body,
    raw: update,
  };
}

export async function downloadAndInstallUpdate(
  update: AvailableUpdate,
  onProgress: (percent: number) => void,
): Promise<void> {
  await update.raw.downloadAndInstall((event) => {
    if (event.event === "Progress" && event.data.contentLength > 0) {
      const percent = Math.round((event.data.chunkLength / event.data.contentLength) * 100);
      onProgress(percent);
    }
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/lib/__tests__/updater.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/updater.ts src/lib/__tests__/updater.test.ts
git commit -m "feat: add tauri updater wrapper"
```

### Task 3: Implement Startup Throttling Policy (12h)

**Files:**
- Create: `src/lib/updateStartupPolicy.ts`
- Create: `src/lib/__tests__/updateStartupPolicy.test.ts`
- Test: `src/lib/__tests__/updateStartupPolicy.test.ts`

- [ ] **Step 1: Write failing tests for throttle window**

```ts
import { describe, expect, it, vi } from "vitest";
import { shouldRunStartupUpdateCheck, markStartupUpdateCheck } from "../updateStartupPolicy";

describe("startup update throttle", () => {
  it("runs when no timestamp exists", () => {
    localStorage.clear();
    expect(shouldRunStartupUpdateCheck(Date.now())).toBe(true);
  });

  it("skips within 12 hours", () => {
    const now = 1_700_000_000_000;
    markStartupUpdateCheck(now);
    expect(shouldRunStartupUpdateCheck(now + 60_000)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/lib/__tests__/updateStartupPolicy.test.ts`
Expected: FAIL because startup policy module does not exist.

- [ ] **Step 3: Implement policy helpers**

```ts
const STARTUP_UPDATE_KEY = "termbridge.update.lastStartupCheckAt";
const TWELVE_HOURS_MS = 12 * 60 * 60 * 1000;

export function shouldRunStartupUpdateCheck(now: number): boolean {
  const value = localStorage.getItem(STARTUP_UPDATE_KEY);
  if (!value) {
    return true;
  }

  const last = Number(value);
  if (!Number.isFinite(last)) {
    return true;
  }

  return now - last >= TWELVE_HOURS_MS;
}

export function markStartupUpdateCheck(now: number): void {
  localStorage.setItem(STARTUP_UPDATE_KEY, String(now));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/lib/__tests__/updateStartupPolicy.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/updateStartupPolicy.ts src/lib/__tests__/updateStartupPolicy.test.ts
git commit -m "test: cover startup update throttle policy"
```

### Task 4: Integrate App Update UX (Startup, Toast, Restart Dialog)

**Files:**
- Create: `src/components/UpdateRestartDialog.tsx`
- Create: `src/components/__tests__/UpdateRestartDialog.test.tsx`
- Modify: `src/App.tsx`
- Test: `src/components/__tests__/UpdateRestartDialog.test.tsx`

- [ ] **Step 1: Write failing dialog/UI tests**

```tsx
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { UpdateRestartDialog } from "../UpdateRestartDialog";

describe("UpdateRestartDialog", () => {
  it("shows active-session warning", () => {
    render(
      <UpdateRestartDialog
        open
        hasActiveSessions
        version="0.2.0"
        onInstallNow={vi.fn()}
        onLater={vi.fn()}
      />,
    );

    expect(screen.getByText(/重启会中断当前 SSH 会话/)).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/components/__tests__/UpdateRestartDialog.test.tsx`
Expected: FAIL because dialog component does not exist.

- [ ] **Step 3: Implement dialog and wire App update flow**

```tsx
// App.tsx (core additions)
const [updateState, setUpdateState] = useState(createInitialUpdateState());
const [updateToast, setUpdateToast] = useState<{ open: boolean; message: string; tone: "info" | "error" | "success" }>({
  open: false,
  message: "",
  tone: "info",
});

const runUpdateCheck = async (mode: "startup" | "manual") => {
  setUpdateState((state) => reduceUpdateState(state, { type: "checkStarted", mode }));
  const available = await checkForUpdate();
  if (!available) {
    setUpdateState((state) => reduceUpdateState(state, { type: "noUpdate" }));
    if (mode === "manual") {
      setUpdateToast({ open: true, message: "当前已是最新版本", tone: "info" });
    }
    return;
  }

  setUpdateState((state) =>
    reduceUpdateState(state, { type: "updateFound", version: available.version, notes: available.body }),
  );

  setUpdateState((state) => reduceUpdateState(state, { type: "downloadStarted" }));
  await downloadAndInstallUpdate(available, (percent) => {
    setUpdateState((state) => reduceUpdateState(state, { type: "downloadProgress", progress: percent }));
  });
  setUpdateState((state) => reduceUpdateState(state, { type: "downloaded" }));
};

useEffect(() => {
  if (!isTauriRuntime() || !shouldRunStartupUpdateCheck(Date.now())) {
    return;
  }

  const timer = window.setTimeout(() => {
    markStartupUpdateCheck(Date.now());
    void runUpdateCheck("startup");
  }, 8000);

  return () => window.clearTimeout(timer);
}, []);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- src/components/__tests__/UpdateRestartDialog.test.tsx`
Expected: PASS

Run: `npm test -- src/lib/__tests__/updateFlow.test.ts src/lib/__tests__/updater.test.ts src/lib/__tests__/updateStartupPolicy.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/App.tsx src/components/UpdateRestartDialog.tsx src/components/__tests__/UpdateRestartDialog.test.tsx
git commit -m "feat: add startup auto-update UX flow"
```

### Task 5: Add Native Entry Points (macOS App Menu + Windows Tray)

**Files:**
- Modify: `src-tauri/src/lib.rs`
- Test: `src-tauri/src/lib.rs` (unit tests section)

- [ ] **Step 1: Write failing Rust tests for menu event identifiers**

```rust
#[test]
fn check_update_menu_ids_are_recognized() {
    assert!(is_check_update_menu_id("menu.check_update"));
    assert!(is_check_update_menu_id("tray.check_update"));
    assert!(!is_check_update_menu_id("tray.quit"));
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd src-tauri && cargo test check_update_menu_ids_are_recognized`
Expected: FAIL because helper functions/constants are not defined.

- [ ] **Step 3: Implement menu/tray wiring and frontend event bridge**

```rust
const MENU_CHECK_UPDATE: &str = "menu.check_update";
const TRAY_CHECK_UPDATE: &str = "tray.check_update";
const TRAY_SHOW_MAIN: &str = "tray.show_main";
const TRAY_QUIT: &str = "tray.quit";
const SYSTEM_CHECK_UPDATE_EVENT: &str = "system-check-update";

fn is_check_update_menu_id(id: &str) -> bool {
    id == MENU_CHECK_UPDATE || id == TRAY_CHECK_UPDATE
}

fn emit_manual_update_check(app: &AppHandle) {
    let _ = app.emit(SYSTEM_CHECK_UPDATE_EVENT, ());
}

fn build_app_menu(app: &tauri::AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    use tauri::menu::{Menu, MenuItem};
    let check = MenuItem::with_id(app, MENU_CHECK_UPDATE, "Check for Updates...", true, None::<&str>)?;
    Menu::with_items(app, &[&check])
}

#[cfg(target_os = "windows")]
fn build_windows_tray(app: &tauri::AppHandle) -> tauri::Result<tauri::tray::TrayIcon<tauri::Wry>> {
    use tauri::menu::MenuItem;
    use tauri::tray::TrayIconBuilder;

    let show_main = MenuItem::with_id(app, TRAY_SHOW_MAIN, "Show Main Window", true, None::<&str>)?;
    let check = MenuItem::with_id(app, TRAY_CHECK_UPDATE, "Check for Updates", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, TRAY_QUIT, "Quit", true, None::<&str>)?;
    let menu = tauri::menu::Menu::with_items(app, &[&show_main, &check, &quit])?;

    TrayIconBuilder::with_id("main-tray")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            TRAY_CHECK_UPDATE => emit_manual_update_check(app),
            TRAY_SHOW_MAIN => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
            TRAY_QUIT => app.exit(0),
            _ => {}
        })
        .build(app)
}
```

- [ ] **Step 4: Run Rust verification**

Run: `cd src-tauri && cargo test check_update_menu_ids_are_recognized`
Expected: PASS

Run: `cd src-tauri && cargo check`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/lib.rs
git commit -m "feat: add native check-update menu and tray entry"
```

### Task 6: Enable Updater Plugin and Permissions

**Files:**
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/capabilities/default.json`
- Modify: `src-tauri/tauri.conf.json`
- Modify: `package.json`

- [ ] **Step 1: Write failing compile verification command**

Run: `cd src-tauri && cargo check`
Expected: FAIL once updater code is referenced but updater plugin dependency/config is not fully added.

- [ ] **Step 2: Add dependency and permissions**

```toml
# src-tauri/Cargo.toml
[dependencies]
tauri-plugin-updater = "2.9.1"
```

```json
// src-tauri/capabilities/default.json
{
  "permissions": ["core:default", "log:default", "updater:default"]
}
```

```json
// src-tauri/tauri.conf.json
{
  "plugins": {
    "updater": {
      "active": true,
      "endpoints": [
        "https://github.com/hi-fullmoon/TermBridge/releases/latest/download/latest.json"
      ],
      "dialog": false
    }
  }
}
```

```json
// package.json
{
  "dependencies": {
    "@tauri-apps/plugin-updater": "^2.9.1"
  }
}
```

- [ ] **Step 3: Generate signing keypair and apply public key**

Run: `cd src-tauri && cargo tauri signer generate -w ~/.tauri/termbridge-updater.key`
Expected: SUCCESS and terminal prints a public key.

Run: `export TAURI_UPDATER_PUBKEY="$(cd src-tauri && cargo tauri signer public-key -k ~/.tauri/termbridge-updater.key)"`
Expected: shell variable contains the updater public key.

Run: `jq --arg pubkey "$TAURI_UPDATER_PUBKEY" '.plugins.updater.pubkey = $pubkey' src-tauri/tauri.conf.json > /tmp/tauri.conf.json && mv /tmp/tauri.conf.json src-tauri/tauri.conf.json`
Expected: `src-tauri/tauri.conf.json` contains a concrete `plugins.updater.pubkey` value.

- [ ] **Step 4: Run verification**

Run: `npm install`
Expected: PASS

Run: `cd src-tauri && cargo check`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add package.json pnpm-lock.yaml src-tauri/Cargo.toml src-tauri/capabilities/default.json src-tauri/tauri.conf.json
git commit -m "feat: enable tauri updater plugin configuration"
```

### Task 7: Hook Rust Event to Manual Check + Final Regression

**Files:**
- Modify: `src/App.tsx`
- Create: `src/__tests__/appUpdate.test.tsx`
- Modify: `README.md`

- [ ] **Step 1: Add failing test for Rust-triggered manual check listener**

```ts
import { render, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import App from "../App";

const listenMock = vi.fn();
vi.mock("@tauri-apps/api/event", () => ({
  listen: listenMock,
}));

it("triggers manual update check when system-check-update event is emitted", async () => {
  let triggerCheck: (() => void) | undefined;
  listenMock.mockImplementation(async (_event, callback) => {
    triggerCheck = () => callback({ payload: undefined });
    return vi.fn();
  });

  render(<App />);
  await waitFor(() => expect(listenMock).toHaveBeenCalledWith("system-check-update", expect.any(Function)));

  triggerCheck?.();
  await waitFor(() => {
    expect(document.body.textContent).toContain("检查更新");
  });
});
```

- [ ] **Step 2: Run targeted test to verify it fails**

Run: `npm test -- src/__tests__/appUpdate.test.tsx`
Expected: FAIL because listener wiring is missing.

- [ ] **Step 3: Implement listener + README release notes**

```ts
useEffect(() => {
  if (!isTauriRuntime()) {
    return;
  }

  let stop: UnlistenFn | undefined;
  void listen("system-check-update", () => {
    void runUpdateCheck("manual");
  }).then((fn) => {
    stop = fn;
  });

  return () => {
    stop?.();
  };
}, [runUpdateCheck]);
```

```md
## 更新机制

- 启动后约 8 秒静默检查更新（12 小时内只触发一次启动检查）
- 检测到新版本后自动后台下载
- 下载完成后提示重启安装
- macOS 通过顶部菜单“Check for Updates...”，Windows 通过托盘右键菜单“Check for Updates”触发手动检查
```

- [ ] **Step 4: Run full verification suite**

Run: `npm test`
Expected: PASS

Run: `npm run build`
Expected: PASS

Run: `cd src-tauri && cargo check`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/App.tsx src/__tests__/appUpdate.test.tsx README.md
git commit -m "feat: wire system check-update events and docs"
```

## Self-Review

### 1) Spec Coverage Check

- Startup auto-check + auto-download + restart prompt: covered by Tasks 1-4.
- macOS top menu + Windows tray menu manual check: covered by Task 5.
- Windows tray always visible: covered by Task 5.
- Failure handling and retries: reducer/service behavior covered by Tasks 1-2; UI handling covered by Task 4.
- Permissions/config/release prerequisites: covered by Task 6.
- Documentation and final regression: covered by Task 7.

No spec gaps found.

### 2) Placeholder Scan

Scanned for `TODO`, `TBD`, `implement later`, and ambiguous steps. All steps include explicit files/commands and expected outcomes.

### 3) Type/Name Consistency

- Event name is consistently `system-check-update`.
- Update phases match spec (`idle`, `checking`, `update_available`, `downloading`, `downloaded`, `no_update`, `error`).
- Manual/startup modes consistently use `manual` and `startup`.

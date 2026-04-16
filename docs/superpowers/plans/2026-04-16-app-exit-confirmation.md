# App Exit Confirmation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a second confirmation prompt before the app truly exits, while keeping the current "window close hides to tray" behavior unchanged on Windows.

**Architecture:** The Rust tray quit action will stop calling `app.exit(0)` directly and instead emit a frontend event that opens a React confirmation dialog. After the user confirms, the frontend will call a small Tauri command that performs the real app exit.

**Tech Stack:** Tauri 2, Rust, React 18, Vitest, Testing Library

---

### Task 1: Add a failing frontend regression test for quit confirmation

**Files:**
- Modify: `src/__tests__/appUpdate.test.tsx`
- Test: `src/__tests__/appUpdate.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
it('shows an exit confirmation dialog when the system quit event is emitted', async () => {
  const invokeMock = vi.mocked(invoke);
  render(<App />);

  await waitFor(() => {
    expect(listenMock).toHaveBeenCalledWith('system-request-app-exit', expect.any(Function));
  });

  await emitSystemRequestAppExit();

  expect(screen.getByRole('dialog', { name: '退出应用' })).toBeInTheDocument();
  expect(screen.getByText('确认退出 TermBridge 吗？退出后当前窗口和托盘都会关闭。')).toBeInTheDocument();

  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: '退出应用' }));
  });

  expect(invokeMock).toHaveBeenCalledWith('request_app_exit');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/__tests__/appUpdate.test.tsx`
Expected: FAIL because the `system-request-app-exit` listener, dialog, and `request_app_exit` command path do not exist yet.

- [ ] **Step 3: Write minimal implementation**

```tsx
const [exitDialogOpen, setExitDialogOpen] = useState(false);

useEffect(() => {
  let stopExitRequest: UnlistenFn | undefined;

  const attachExitRequest = async () => {
    stopExitRequest = await listen('system-request-app-exit', () => {
      setExitDialogOpen(true);
    });
  };

  void attachExitRequest();

  return () => {
    stopExitRequest?.();
  };
}, []);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/__tests__/appUpdate.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/__tests__/appUpdate.test.tsx src/App.tsx src-tauri/src/lib.rs
git commit -m "feat: confirm before exiting app"
```

### Task 2: Wire the tray quit path through a Tauri event and exit command

**Files:**
- Modify: `src-tauri/src/lib.rs`
- Test: `src/__tests__/appUpdate.test.tsx`

- [ ] **Step 1: Add the Rust event constant and exit command**

```rust
const SYSTEM_REQUEST_APP_EXIT_EVENT: &str = "system-request-app-exit";

#[tauri::command]
fn request_app_exit(app: AppHandle) {
    app.exit(0);
}
```

- [ ] **Step 2: Emit the event from the tray quit action**

```rust
if menu_id == TRAY_QUIT_ID {
    if let Err(error) = app.emit(SYSTEM_REQUEST_APP_EXIT_EVENT, ()) {
        error!("failed to emit app exit request event: {error}");
    }
}
```

- [ ] **Step 3: Register the command in the invoke handler**

```rust
.invoke_handler(tauri::generate_handler![
    // existing commands...
    request_app_restart,
    request_app_exit
])
```

- [ ] **Step 4: Re-run the targeted frontend test**

Run: `npm test -- src/__tests__/appUpdate.test.tsx`
Expected: PASS with the new listener and command path exercised.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/lib.rs src/__tests__/appUpdate.test.tsx src/App.tsx
git commit -m "feat: route tray quit through confirmation"
```

### Task 3: Render the confirmation dialog in the existing React modal style

**Files:**
- Modify: `src/App.tsx`
- Test: `src/__tests__/appUpdate.test.tsx`

- [ ] **Step 1: Add dialog state and actions**

```tsx
const [exitDialogOpen, setExitDialogOpen] = useState(false);

const confirmAppExit = () => {
  void invoke('request_app_exit');
  setExitDialogOpen(false);
};
```

- [ ] **Step 2: Render the modal beside the other confirmation dialogs**

```tsx
{exitDialogOpen ? (
  <div className="fixed inset-0 z-30 grid place-items-center bg-slate-950/70 p-1 backdrop-blur md:p-2" onClick={() => setExitDialogOpen(false)} role="presentation">
    <div
      className="surface w-full max-w-sm p-3"
      onClick={(event) => event.stopPropagation()}
      role="dialog"
      aria-modal="true"
      aria-label="退出应用"
    >
      <div className="flex flex-col gap-1">
        <p className="label">退出确认</p>
        <h3 className="text-sm font-semibold text-slate-100">退出应用</h3>
        <p className="text-xs text-slate-400">确认退出 TermBridge 吗？退出后当前窗口和托盘都会关闭。</p>
      </div>

      <div className="mt-3 flex justify-end gap-1">
        <button className="icon-btn" onClick={() => setExitDialogOpen(false)} type="button">
          取消
        </button>
        <button className="inline-flex items-center justify-center rounded-lg bg-rose-400 px-3 py-2 text-xs font-semibold text-white transition hover:bg-rose-300" onClick={confirmAppExit} type="button">
          退出应用
        </button>
      </div>
    </div>
  </div>
) : null}
```

- [ ] **Step 3: Verify the targeted test still passes**

Run: `npm test -- src/__tests__/appUpdate.test.tsx`
Expected: PASS

- [ ] **Step 4: Run a broader regression check**

Run: `npm test -- src/__tests__/appUpdate.test.tsx src/components/__tests__/UpdateRestartDialog.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/App.tsx src/__tests__/appUpdate.test.tsx
git commit -m "feat: show exit confirmation dialog"
```

# Terminal Copy Behavior Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove automatic copy-on-selection in the terminal pane and replace it with explicit copy via context menu or keyboard shortcut (Cmd+C on macOS, Ctrl+Shift+C on Windows/Linux).

**Architecture:** The `terminal-pane.tsx` component currently copies on every `onSelectionChange` event. We will delete that listener and instead handle the copy shortcut inside the existing `terminal.attachCustomKeyEventHandler`. When the shortcut fires and text is selected, we write the selection to the clipboard and show the existing copy toast. The context menu copy remains unchanged.

**Tech Stack:** React, TypeScript, xterm.js, Tailwind CSS, Vitest, @testing-library/react, lucide-react.

## Global Constraints

- No new dependencies.
- Keep existing context menu copy behavior.
- Do not intercept `Ctrl+C` on non-macOS; it must still send SIGINT to the remote process.
- Reuse existing toast messages `terminal.feedback.copied` / `terminal.feedback.copyFailed`.

---

### Task 1: Remove Auto-Copy on Selection

**Files:**
- Modify: `src/components/terminal/terminal-pane.tsx:77-83`
- Modify: `src/components/terminal/terminal-pane.tsx:114-118`

**Interfaces:**
- Consumes: `terminal` from xterm, `success` / `showError` from `useToast`.
- Produces: `terminal` no longer triggers clipboard writes on selection change.

- [ ] **Step 1: Remove the `onSelectionChange` listener and its disposal**

In `src/components/terminal/terminal-pane.tsx`, delete the selection-change listener and the `disposable` variable. The `success` and `showError` functions from `useToast` are still used later (keyboard copy and context menu feedback), so keep their destructuring.

Current code to remove:

```tsx
    const disposable = terminal.onSelectionChange(() => {
      const selection = terminal.getSelection();
      if (!selection) return;
      void navigator.clipboard
        .writeText(selection)
        .then(() => success(t('terminal.feedback.copied')))
        .catch(() => showError(t('terminal.feedback.copyFailed')));
    });
```

And update the cleanup function to remove `disposable.dispose()`:

```tsx
    return () => {
      element?.removeEventListener('contextmenu', handleContextMenu);
      // Reset key handler to avoid stale closures when session changes.
      terminal.attachCustomKeyEventHandler(() => true);
    };
```

- [ ] **Step 2: Run the existing terminal-pane tests to confirm no regressions**

Run: `pnpm exec vitest run src/components/terminal/__tests__/terminal-pane.test.tsx`
Expected: All 5 tests pass.

- [ ] **Step 3: Commit**

```bash
git add src/components/terminal/terminal-pane.tsx
git commit -m "refactor(terminal): remove auto-copy on selection"
```

---

### Task 2: Add Keyboard Copy Shortcut

**Files:**
- Modify: `src/components/terminal/terminal-pane.tsx:1`
- Modify: `src/components/terminal/terminal-pane.tsx:86-105`

**Interfaces:**
- Consumes: `terminal.getSelection()`, `getPlatform()` from `@/lib/platform`, `success` / `showError` from `useToast`.
- Produces: `terminal.attachCustomKeyEventHandler` now intercepts Cmd+C / Ctrl+Shift+C and writes selection to clipboard.

- [ ] **Step 1: Import `getPlatform`**

Add the import at the top of `src/components/terminal/terminal-pane.tsx`:

```tsx
import { getPlatform } from '@/lib/platform';
```

- [ ] **Step 2: Add copy shortcut handling inside the custom key handler**

Insert the platform-aware copy shortcut check at the top of the `terminal.attachCustomKeyEventHandler` callback, before the existing Ctrl+F and Escape checks.

Replace the current handler block:

```tsx
    terminal.attachCustomKeyEventHandler((event) => {
      if (event.type !== 'keydown') return true;
      const isCtrlOrMeta = event.ctrlKey || event.metaKey;

      if (isCtrlOrMeta && event.key === 'f') {
        event.preventDefault();
        handleOpenSearch();
        return false;
      }

      if (event.key === 'Escape') {
        if (searchOpen) {
          event.preventDefault();
          handleCloseSearch();
          return false;
        }
      }

      return true;
    });
```

With:

```tsx
    terminal.attachCustomKeyEventHandler((event) => {
      if (event.type !== 'keydown') return true;

      const platform = getPlatform();
      const isCopyShortcut =
        (platform === 'macos' && event.metaKey && event.key.toLowerCase() === 'c') ||
        (platform !== 'macos' && event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'c');

      if (isCopyShortcut) {
        const selection = terminal.getSelection();
        if (selection) {
          event.preventDefault();
          void navigator.clipboard
            .writeText(selection)
            .then(() => success(t('terminal.feedback.copied')))
            .catch(() => showError(t('terminal.feedback.copyFailed')));
          return false;
        }
      }

      const isCtrlOrMeta = event.ctrlKey || event.metaKey;

      if (isCtrlOrMeta && event.key === 'f') {
        event.preventDefault();
        handleOpenSearch();
        return false;
      }

      if (event.key === 'Escape') {
        if (searchOpen) {
          event.preventDefault();
          handleCloseSearch();
          return false;
        }
      }

      return true;
    });
```

- [ ] **Step 3: Run TypeScript check**

Run: `pnpm tsc --noEmit`
Expected: No errors.

- [ ] **Step 4: Commit**

```bash
git add src/components/terminal/terminal-pane.tsx
git commit -m "feat(terminal): add explicit keyboard copy shortcut"
```

---

### Task 3: Update Tests

**Files:**
- Modify: `src/components/terminal/__tests__/terminal-pane.test.tsx`

**Interfaces:**
- Consumes: Mocked `terminalRegistry`, `navigator.clipboard`, `useToast`.
- Produces: Tests that verify no auto-copy and that keyboard copy works.

- [ ] **Step 1: Add mocks for clipboard, toast, and terminal registry**

At the top of `src/components/terminal/__tests__/terminal-pane.test.tsx`, add the following mocks before the existing `vi.mock('@/hooks/useI18n', ...)`:

```tsx
vi.mock('@/hooks/useToast', () => ({
  useToast: () => ({
    success: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('@/components/terminal/registry/terminal-registry', () => ({
  terminalRegistry: {
    get: vi.fn(),
    create: vi.fn(),
    dispose: vi.fn(),
    disposeAll: vi.fn(),
  },
}));
```

- [ ] **Step 2: Update `beforeEach` / `afterEach` to reset clipboard and registry mocks**

Add a `beforeEach` block (or use the existing `makeSession` area) to reset mocks and assign a default `navigator.clipboard`:

```tsx
import { terminalRegistry } from '@/components/terminal/registry/terminal-registry';

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(navigator, {
    clipboard: {
      writeText: vi.fn().mockResolvedValue(undefined),
      readText: vi.fn().mockResolvedValue(''),
    },
  });
});
```

- [ ] **Step 3: Add a helper to create a mocked terminal and register it**

Add this helper function next to `makeSession`:

```tsx
function makeMockTerminal(selection = '') {
  const handlers: Array<(event: KeyboardEvent) => boolean> = [];
  const terminal = {
    getSelection: vi.fn().mockReturnValue(selection),
    selectAll: vi.fn(),
    clear: vi.fn(),
    write: vi.fn(),
    element: document.createElement('div'),
    onSelectionChange: vi.fn().mockReturnValue({ dispose: vi.fn() }),
    attachCustomKeyEventHandler: vi.fn((handler) => {
      handlers.push(handler);
    }),
    getCustomKeyEventHandlers: () => handlers,
  } as unknown as import('@xterm/xterm').Terminal & { getCustomKeyEventHandlers: () => Array<(event: KeyboardEvent) => boolean> };

  const controller = {
    terminal,
    searchAddon: {
      findNext: vi.fn(),
      findPrevious: vi.fn(),
      clearDecorations: vi.fn(),
    },
    attach: vi.fn(),
    detach: vi.fn(),
    focus: vi.fn(),
  };

  (terminalRegistry.get as ReturnType<typeof vi.fn>).mockReturnValue(controller);
  return terminal;
}
```

- [ ] **Step 4: Add a test that keyboard copy writes the selection to the clipboard**

Add this test inside the `describe('TerminalPane', () => { ... })` block:

```tsx
  it('copies selection via keyboard shortcut', async () => {
    const terminal = makeMockTerminal('selected text');
    render(<TerminalPane activeSession={makeSession()} />);

    const handler = terminal.getCustomKeyEventHandlers()[0];
    const event = new KeyboardEvent('keydown', {
      key: 'c',
      metaKey: true,
      bubbles: true,
      cancelable: true,
    });
    const preventDefault = vi.spyOn(event, 'preventDefault');

    const result = handler(event);

    expect(result).toBe(false);
    expect(preventDefault).toHaveBeenCalled();
    await vi.waitFor(() => {
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith('selected text');
    });
  });
```

- [ ] **Step 5: Add a test that selecting text does not trigger auto-copy**

Add this test inside the `describe('TerminalPane', () => { ... })` block:

```tsx
  it('does not copy on selection change', () => {
    makeMockTerminal('selected text');
    render(<TerminalPane activeSession={makeSession()} />);

    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
  });
```

- [ ] **Step 6: Run the updated terminal-pane tests**

Run: `pnpm exec vitest run src/components/terminal/__tests__/terminal-pane.test.tsx`
Expected: All tests pass, including the new keyboard copy and no-auto-copy tests.

- [ ] **Step 7: Run the full test suite**

Run: `pnpm test`
Expected: All 142 tests pass.

- [ ] **Step 8: Commit**

```bash
git add src/components/terminal/__tests__/terminal-pane.test.tsx
git commit -m "test(terminal): verify keyboard copy and no auto-copy"
```

---

## Self-Review

**Spec coverage:**
- Remove auto-copy on selection → Task 1.
- Keep context-menu copy → unchanged (not modified in this plan).
- Add explicit keyboard copy shortcut (Cmd+C / Ctrl+Shift+C) → Task 2.
- Copy feedback via existing toast → Task 2 reuses `success` / `showError`.
- Tests for new behavior → Task 3.

**Placeholder scan:** No TBD, TODO, or vague steps. Each step includes exact file paths, commands, and expected outputs.

**Type consistency:** The mocked terminal type uses the same `getSelection` / `attachCustomKeyEventHandler` signatures as the real xterm terminal. The `getCustomKeyEventHandlers` accessor is added only for testing.

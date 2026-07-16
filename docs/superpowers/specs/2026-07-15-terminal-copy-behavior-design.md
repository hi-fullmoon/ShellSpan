# Terminal Copy Behavior Redesign

**Date:** 2026-07-15
**Topic:** terminal-copy-behavior
**Status:** Approved

## Summary

Remove the current "copy on text selection" behavior in the terminal pane. Copying should only happen through explicit user actions: the right-click context menu copy item or a keyboard shortcut (Cmd+C on macOS, Ctrl+Shift+C on Windows/Linux).

## Motivation

The current implementation copies the terminal selection to the clipboard automatically every time the selection changes. This causes unwanted copies during search, where matching text is highlighted/selected by the search addon. Users want control over when clipboard writes happen.

## Current State

- `src/components/terminal/terminal-pane.tsx` registers a `terminal.onSelectionChange` handler that writes `terminal.getSelection()` to `navigator.clipboard` and shows a toast.
- `src/components/terminal/terminal-pane-context-menu.tsx` already provides a context-menu copy item that writes the selection to the clipboard and reports success/failure via `onCopyFeedback`.
- No explicit keyboard shortcut is currently implemented for copying terminal text.

## Proposed Design

### 1. Remove Auto-Copy on Selection

Delete the `terminal.onSelectionChange` listener in `terminal-pane.tsx` so selecting text no longer writes to the clipboard automatically.

### 2. Keep Context-Menu Copy

Leave `TerminalPaneContextMenu` unchanged. Its copy item continues to write the current selection to the clipboard and report feedback.

### 3. Add Explicit Keyboard Copy Shortcut

Extend the existing `terminal.attachCustomKeyEventHandler` in `terminal-pane.tsx` to handle the copy shortcut:

- **macOS:** `Cmd+C` (`event.metaKey && event.key.toLowerCase() === 'c'`)
- **Windows/Linux:** `Ctrl+Shift+C` (`event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'c'`)

Behavior:

- If text is currently selected, prevent the default action, write the selection to `navigator.clipboard`, and show the existing `terminal.feedback.copied` or `terminal.feedback.copyFailed` toast.
- If no text is selected, do not intercept the event; let xterm and the terminal process handle it normally.
- The regular `Ctrl+C` (without Shift) on non-macOS must continue to be sent to the remote process as an interrupt signal.

## Implementation Details

- Use `getPlatform()` from `src/lib/platform.ts` to decide which shortcut to check.
- Reuse the existing `success` / `showError` toast helpers from `useToast()` for copy feedback.
- Remove the `onSelectionChange` disposable and the associated `success` / `showError` calls from that listener.
- No new dependencies are required.

## Testing

- Update `src/components/terminal/__tests__/terminal-pane.test.tsx`:
  - Verify that selecting text does not call `navigator.clipboard.writeText` automatically.
  - Verify that the keyboard copy shortcut (with a mocked platform) writes the selection to the clipboard and triggers the success toast.
  - Verify that the context-menu copy item still works as before (covered by `terminal-pane-context-menu.test.tsx`).
- Ensure all existing terminal tests continue to pass.

## Files Affected

- `src/components/terminal/terminal-pane.tsx`
- `src/components/terminal/__tests__/terminal-pane.test.tsx`

# TermBridge Update System Design

## Goal

Implement a production-safe update system for TermBridge with this user-approved behavior:

- Check for updates automatically after app startup.
- Auto-download update packages in background when a newer version exists.
- Prompt user to restart and install after download completes.
- Keep update entry points aligned with desktop conventions:
  - macOS: top app menu
  - Windows: tray icon context menu

## Scope

### In Scope

- Integrate official Tauri updater workflow.
- Use public GitHub Releases as update source.
- Add manual "Check for Updates" entry in system-level menus.
- Keep Windows tray icon always visible and add update menu item.
- Add update state machine, progress UI, and restart-install prompt.
- Add session safety guard before restart install.
- Add logging for check/download/install lifecycle.

### Out of Scope

- Private release channel authentication.
- Multi-channel rollout (beta/canary) in first iteration.
- In-app changelog viewer beyond basic release notes text.
- Forced update policy.

## Architecture

### Update Source

- Source: public GitHub Releases.
- Transport: HTTPS.
- Integrity: updater signature verification.

### Client Components

- Rust/Tauri layer:
  - Register updater plugin.
  - Register system menu and tray menu actions.
  - Keep tray icon resident on Windows.
- Frontend layer:
  - Centralized update state store.
  - Startup silent check trigger.
  - Download/install prompts and toasts.
  - Session-aware restart guard.

### Existing File Touch Points

- `src-tauri/src/lib.rs`
- `src-tauri/tauri.conf.json`
- `src/App.tsx`
- `src/components/Sidebar.tsx` (if fallback/extra entry is desired later)

## UX and Entry Points

### Manual Check Entry

- macOS:
  - Add `Check for Updates...` under the app top menu.
- Windows:
  - Tray icon is always visible.
  - Add context menu item `Check for Updates`.
  - Keep `Show Main Window` and `Quit` in tray menu.

### Automatic Behavior

- On startup, delay 8 seconds, then run silent check.
- If no update: no intrusive UI, log only.
- If update found: auto-download in background.
- During download: non-blocking toast progress.
- After download complete: show restart-install dialog.

### Session Safety

- If `connectedCount > 0`, installation is never auto-triggered.
- User must explicitly confirm restart-install.
- Dialog must warn that restart will interrupt active SSH sessions.

## State Machine

- `idle`
- `checking`
- `update_available`
- `downloading`
- `downloaded`
- `no_update`
- `error`

### Transition Rules

- Startup auto-check:
  - `idle -> checking -> no_update` or `update_available` or `error`
- On update found:
  - `update_available -> downloading -> downloaded` or `error`
- Manual check:
  - If already downloading, show "downloading" status.
  - If already downloaded, show install prompt directly.
  - If no update, show lightweight "already latest" toast.

## Failure Handling

- Check failure:
  - Silent on startup; visible on manual check.
  - Log error context.
- Download failure:
  - Remove partial artifact.
  - Retry entry available.
  - Automatic retry up to 2 attempts with backoff.
- Signature validation failure:
  - Abort install immediately.
  - Mark as high-priority log event.
- Install/restart failure:
  - Return to `update_available` state.
  - Offer retry and open release page fallback.

## Versioning and Release Rules

- Keep semantic versioning (`major.minor.patch`).
- Keep versions synchronized in:
  - `package.json`
  - `src-tauri/Cargo.toml`
  - `src-tauri/tauri.conf.json`
- Tag format: `vX.Y.Z`.
- Use stable-only channel in this iteration.
- Each release must include updater-required artifacts and signatures.

## Logging

Log these checkpoints into existing unified logging pipeline:

- update check started/completed
- update discovered (from/to version)
- download started/progress/completed
- download failed with error category
- install requested/confirmed/failed

Do not log secrets or unrelated SSH payloads.

## Acceptance Criteria

1. macOS top menu has `Check for Updates...` and works.
2. Windows tray icon is persistent and has `Check for Updates`.
3. App performs startup silent check and auto-downloads when update exists.
4. Download completion shows restart-install prompt.
5. Active SSH sessions trigger explicit interruption warning before install.
6. No-update and all failure paths provide expected UX and logs.
7. SSH and file manager primary workflows remain unaffected.

## Implementation Phasing

1. Day 1:
   - Integrate updater and endpoint config.
   - Implement check/download state machine.
2. Day 2:
   - Implement macOS menu and Windows tray menu entries.
   - Wire manual check actions to shared update service.
3. Day 3:
   - Add retry, throttling (12h startup check window), and failure UX.
   - Add/update logs and finish regression tests.
4. Day 4:
   - Build release candidate and verify full upgrade loop on another machine.

## Risks and Mitigations

- Risk: restart interrupts active sessions.
  - Mitigation: explicit warning + manual confirmation.
- Risk: unstable network during download.
  - Mitigation: retries and resumable user retry path.
- Risk: release artifact mismatch.
  - Mitigation: release checklist and pre-publish verification.

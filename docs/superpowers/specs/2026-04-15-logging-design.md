# TermBridge Logging Design

## Goal

Build a production-ready logging system for TermBridge that captures both frontend and Tauri/Rust logs and persists them to local log files for later inspection, without adding an in-app log viewer.

## Scope

- Use the official Tauri 2 logging plugin as the single logging backend.
- Keep the existing frontend `createLogger(scope)` API shape to minimize call-site churn.
- Persist logs to the platform-recommended application log directory.
- Add structured logs to key Rust command and session lifecycle paths.
- Avoid logging secrets and high-volume terminal payloads.

## Non-Goals

- No frontend log panel, drawer, or debug screen.
- No export-logs UI in this iteration.
- No custom log database or bespoke file writer.

## Architecture

### Backend

- Register `tauri-plugin-log` on the Tauri builder.
- Configure it to:
  - write to the app log directory using the file name `termbridge`
  - use local time
  - keep stdout logging for development ergonomics
  - keep debug logs in dev and info logs in production
  - rotate files when they exceed a reasonable size
- Use the Rust `log` crate throughout command and worker code.

### Frontend

- Replace the current in-memory log store implementation with a thin facade over `@tauri-apps/plugin-log`.
- In Tauri runtime, forward logs to the plugin so they land in the same file-backed log pipeline as Rust logs.
- In browser preview mode, continue logging to the browser console only.

## Logging Rules

### Capture

- Application startup and runtime mode
- SSH session lifecycle and state changes
- File manager operations: list, create, rename, copy, upload, delete, open
- Long-running operation checkpoints: start, success, cancel, failure
- Recoverable warnings and terminal/session write failures

### Exclude

- Passwords
- Passphrases
- Private key contents
- Raw terminal input/output payloads
- Excessively chatty per-chunk transfer logs

### Redaction

- For authentication requests, log only host, port, username, auth method, and whether optional auth fields were provided.
- For errors, prefer concise summaries and structured context instead of dumping entire request objects.

## File Behavior

- Use the plugin-managed log directory so each platform gets its conventional logs path.
- Use `termbridge.log` as the active file stem.
- Enable file-size rotation to avoid unbounded growth.

## Verification

- Frontend tests cover the logger facade behavior in Tauri and browser modes.
- `npm test`
- `npm run build`
- `cargo check`

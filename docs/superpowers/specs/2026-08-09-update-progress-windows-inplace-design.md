# Update Download Progress + Windows In-Place Install Design

## Goal

Two follow-ups to the existing update system (`2026-04-15-update-system-design.md`):

1. Give the user a visible **download progress UI** — currently the update auto-downloads silently and progress is only shown (as 100%) in the post-download restart dialog.
2. Lock **Windows in-place installation** so the updater always installs to the same directory as the currently installed version.

## Current State (before this change)

- Startup (8s delay, 12h throttle) and manual (tray/menu → `system-check-update`) checks auto-download.
- `updateDownloadProgress` is computed but only passed to `UpdateRestartDialog`, which opens only at `phase === 'downloaded'` → progress is never visible while downloading.
- `tauri.conf.json` has no explicit NSIS configuration; Windows install mode relies on Tauri defaults.
- Release workflow serves `.msi.zip` for stable Windows updates and `.nsis.zip` for prerelease updates.

## Design

### 1. Download progress UI — Settings → General → Update section

A new `UpdateSection` component renders as the last item of the General settings pane:

- Current version (from `@tauri-apps/api/app` `getVersion()`).
- **Check for updates** button (disabled while checking).
- Live progress bar + percentage while downloading.
- **Restart & install** button once downloaded.
- Error message + **Retry** on failure; "up to date" status when no update exists.
- Indeterminate (animated) progress when the download total size is unknown, instead of a stuck 0%.
- A "Checking for updates…" status line renders while a check is in flight, so the status area never goes blank (and the layout does not collapse) between the checking and up-to-date states.

### 2. State architecture — extract into a Zustand store

The update state machine previously lived in the `useUpdateFlow` hook in `App.tsx`, unreachable from the settings panel (which is rendered deep inside the workbench). It is moved into `src/stores/updateStore.ts`:

- Holds `phase`, `version`, `error`, `downloadProgress`, `downloadIndeterminate`, `restartDialogDismissed`.
- Exposes `runCheck(mode)`, `installNow()`, `installLater()`, `reset()`.
- Reuses the pure reducer / `checkForUpdate` / `downloadAndInstallUpdate` from `src/lib/update.ts`.
- `App.tsx` subscribes for the restart dialog and wires the startup-check timer + `system-check-update` listener.
- `SettingsPanel` (via `UpdateSection`) subscribes for the progress UI.

### 3. Windows in-place install

Both current update paths already reinstall in place **as long as the installer technology does not flip**:

- **MSI → MSI**: the same `UpgradeCode` (derived from the stable `identifier` `com.termbridge` + `productName`) makes Windows Installer replace the previous product in the same directory.
- **NSIS → NSIS**: NSIS reads the previous `InstallLocation` from its own uninstall registry key and reinstalls there (including custom directories).

The risk is **MSI ↔ NSIS switching**, which installs into a different directory. Two changes lock this down:

1. **Explicit NSIS config** in `tauri.conf.json` — `bundle.windows.nsis.installMode: "currentUser"`, `displayLanguageSelector: false`. This matches the existing default but prevents an accidental future switch to `perMachine` (which would change the install directory).
2. **Release-time consistency guard** in `release.yml`: before publishing, the workflow compares this release's Windows updater archive suffix (`.msi.zip` / `.nsis.zip`) with the previous release on the same channel (stable or prerelease) and **fails if it flipped**.

`identifier` and `productName` must remain stable across releases — they anchor both MSI and NSIS in-place upgrade keys.

## Files Touched

- `src/stores/updateStore.ts` (new) — update flow state + actions.
- `src/stores/__tests__/updateStore.test.ts` (new) — store tests.
- `src/components/workbench/update-section.tsx` (new) — settings progress UI.
- `src/components/workbench/settings-panel.tsx` — mounts `UpdateSection` in General.
- `src/App.tsx` — subscribes to the store; startup-check timer + `system-check-update` listener.
- `src/lib/update.ts` — `downloadAndInstallUpdate` emits `UpdateDownloadProgress` (`percent?`, `receivedBytes`, `totalBytes`) with indeterminate support.
- `src/locales/zh-CN.ts`, `src/locales/en-US.ts` — new keys.
- `src-tauri/tauri.conf.json` — explicit `bundle.windows.nsis` config.
- `.github/workflows/release.yml` — Windows updater artifact type consistency guard.
- Deleted: `src/hooks/useUpdateFlow.ts` + its test (logic migrated to the store).

## Acceptance Criteria

1. Manual or startup check that finds an update shows a live download progress bar in Settings → General.
2. Indeterminate state renders when the download size is unknown.
3. Once downloaded, Settings offers **Restart & install** and the existing restart dialog still appears.
4. `tsc` passes; all tests pass except the pre-existing `terminal-registry` xterm-style failure (unrelated).
5. Windows releases keep the updater artifact type fixed within each channel; a flip fails the release.

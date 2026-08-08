# Changelog

All notable changes to TermBridge are documented in this file.


## [v2.0.30](https://github.com/zhengbiwen/TermBridge/releases/tag/v2.0.30) - 2026-08-08


### Bug Fixes

- **ui:** apply user-select none to all elements for consistent text selection
- **health:** correct ToolHelp casing in windows_sys import
- **ui:** disable autocomplete and autocapitalize on connection form inputs
- **tauri:** replace deprecated as_bool() with explicit comparison

### Features

- add backend system health module
- add monitor store, hook, tauri bindings, and types
- add monitor workbench tab and panel
- **i18n:** add monitor workbench translations
- **ui:** dismiss top toast on double-click

### Testing

- add unit tests for trend, monitor, and monitor store components
- **ui:** cover toast double-click dismissal behavior
- 修复 Node 22 下 localStorage 不可用问题

## [v2.0.29](https://github.com/zhengbiwen/TermBridge/releases/tag/v2.0.29) - 2026-08-07


### Features

- **keychain:** clear fallback secret value while preserving metadata

## [v2.0.28](https://github.com/zhengbiwen/TermBridge/releases/tag/v2.0.28) - 2026-08-07


### Features

- **hook:** add useLastValue hook for stable dialog content

## [v2.0.27](https://github.com/zhengbiwen/TermBridge/releases/tag/v2.0.27) - 2026-08-06


### Refactoring

- **scripts:** regenerate full icon set from single master

## [v2.0.26](https://github.com/zhengbiwen/TermBridge/releases/tag/v2.0.26) - 2026-08-06


### Bug Fixes

- clear stale log content when switching to a source without a file

### Documentation

- add ROADMAP.md
- expand README with features, tech stack and dev guide

### Refactoring

- move log source toggle to bottom toolbar
- **sftp:** remove redundant tooltip with full path

## [v2.0.25](https://github.com/zhengbiwen/TermBridge/releases/tag/v2.0.25) - 2026-08-06


### Bug Fixes

- add transfer timeout guard for recursive delete operations
- **ui:** adjust delete icon vertical alignment in transfer progress

### Features

- **ui:** add keyboard shortcuts for SFTP file filter
- improve delete operation UI in transfer progress

## [v2.0.24](https://github.com/zhengbiwen/TermBridge/releases/tag/v2.0.24) - 2026-08-06


### Features

- **term:** implement batch remote delete with rsync-style progress
- **sftp:** show transfer error details via tooltip

### Testing

- **sftp:** cover delete-row styling and 16px leading icon

## [v2.0.23](https://github.com/zhengbiwen/TermBridge/releases/tag/v2.0.23) - 2026-08-06


### Bug Fixes

- **tauri:** make Windows icon full-bleed for consistent taskbar rendering

### Chore

- update application icons
- **deps:** update dependencies and add git-cliff

### Documentation

- **changelog:** clean up formatting and remove duplicate v2.0.23 entry

### Features

- **remote_fs:** dot-prefix copy temp files to hide them from listings
- **sftp:** show transfer speed next to transfer progress

### Testing

- update transfer-progress tests for full paths and h-8 class
## [v2.0.23](https://github.com/zhengbiwen/TermBridge/releases/tag/v2.0.23) - 2026-08-05

### Chore

- **deps:** update dependencies and add git-cliff

### Features

- **remote_fs:** dot-prefix copy temp files to hide them from listings
- **sftp:** show transfer speed next to transfer progress

## [v2.0.22](https://github.com/zhengbiwen/TermBridge/releases/tag/v2.0.22) - 2026-08-05

### Chore

- **tauri:** update application icons

## [v2.0.21](https://github.com/zhengbiwen/TermBridge/releases/tag/v2.0.21) - 2026-08-05

### Features

- **error:** extend error utilities and tests for remote copy failures
- **sftp:** handle overwrite and replace conflict policies for remote copies
- **ui:** preserve file extension with middle-elided SFTP file names
- **sftp:** stage remote-to-remote copies through temp file with resume

### Refactoring

- **transfer-store:** surface conflict policies in transfer state

## [v2.0.20](https://github.com/zhengbiwen/TermBridge/releases/tag/v2.0.20) - 2026-08-05

### Bug Fixes

- **store:** ignore stale progress events after transfer completion

## [v2.0.19](https://github.com/zhengbiwen/TermBridge/releases/tag/v2.0.19) - 2026-08-05

### Refactoring

- remove trash/undo and simplify transfers

## [v2.0.18](https://github.com/zhengbiwen/TermBridge/releases/tag/v2.0.18) - 2026-08-04

### Bug Fixes

- **ui:** improve tab bar drag behavior and new tab button

## [v2.0.17](https://github.com/zhengbiwen/TermBridge/releases/tag/v2.0.17) - 2026-08-04

### Chore

- **deps:** migrate to keyring-core and upgrade dependencies for v2.0.16
- **deps:** remove unused pnpm allowBuilds config

### Features

- **ui:** reduce terminal and sftp tab bar height

## [v2.0.16](https://github.com/zhengbiwen/TermBridge/releases/tag/v2.0.16) - 2026-08-04

### Chore

- **deps:** remove unused pnpm allowBuilds config

### Bug Fixes

- **term:** buffer early local session output until frontend is ready
- **app:** restore database state clobbered by duplicate setup and drop misleading connecting hint

### Features

- **ui:** reduce terminal and sftp tab bar height
- **hook:** support reconnecting local sessions without a profile

### Testing

- **hook:** add invokeMarkSessionReady mock to useReconnectSession tests

## [v2.0.15](https://github.com/zhengbiwen/TermBridge/releases/tag/v2.0.15) - 2026-08-03

### Bug Fixes

- **ui:** position toast notifications to top-right

### Features

- **sftp:** support conflict policies for remote-to-local downloads

## [v2.0.14](https://github.com/zhengbiwen/TermBridge/releases/tag/v2.0.14) - 2026-08-03

### Bug Fixes

- **ui:** prevent text selection during split-pane drag and cap visible toasts

### CI/CD

- **release:** add changelog fallback for notes and drop Intel Mac builds

### Features

- **workbench:** add loading state and error feedback for connection management

## [v2.0.13](https://github.com/zhengbiwen/TermBridge/releases/tag/v2.0.13) - 2026-08-03

### Bug Fixes

- **sftp:** correct permission updates, connect wait, and upload cancel

### Chore

- **deps:** enable keyring native features

### Features

- **sftp:** add cancellable crash-safe remote copy

### Style

- **ui:** adjust SFTP pane search icon padding-right

## [v2.0.12](https://github.com/zhengbiwen/TermBridge/releases/tag/v2.0.12) - 2026-07-31

### Features

- **sftp:** harden transfers and pool lifecycle

## [v2.0.11](https://github.com/zhengbiwen/TermBridge/releases/tag/v2.0.11) - 2026-07-30

### Bug Fixes

- **i18n:** pass variables only when provided to intl.get

### Chore

- **changelog:** clean up duplicate pre-release entries and formatting
- **deps:** update multiple dependencies to latest versions

### Documentation

- update LICENSE copyright holder

### Features

- **settings:** add sidebar navigation for settings panel

## [v2.0.10](https://github.com/zhengbiwen/TermBridge/releases/tag/v2.0.10) - 2026-07-30

### Bug Fixes

- **cred:** improve credential storage, session cleanup, and keychain sync

### Features

- **keychain:** add per-profile secrets management for passphrase and jump host credentials
- **tauri:** add tray show window on click and menu item for non-macOS

## [v2.0.9](https://github.com/zhengbiwen/TermBridge/releases/tag/v2.0.9) - 2026-07-27

### Bug Fixes

- **store:** correctly detect OpenSSH private key algorithm
- **tauri:** pass detected key type from frontend to backend

### Features

- **tauri:** add keychain credential integration, password-derived keys and profile passwords
- **tauri:** add keychain-backed SSH key credential management
- **tauri:** derive ECDSA keychain for password profiles and unify credential service
- **ui:** integrate keychain credentials into connection form and add key prompt flow
- **keychain:** refine password credential lifecycle and connection feedback

### Refactoring

- **keychain:** migrate to native OS keychain and extract connection form drawer
- **ui:** polish keychain credentials panel and store

## [v2.0.8](https://github.com/zhengbiwen/TermBridge/releases/tag/v2.0.8) - 2026-07-23

### Bug Fixes

- **ui:** correct dragged tab overlay positioning and cursor

### Features

- **settings:** add configurable keyboard shortcuts settings
- **lib:** add scope-aware keyboard shortcuts engine
- **term:** add tmux-style leader key for pane navigation and splits
- **sftp:** duplicate tabs, global shortcuts and shared ScrollArea integration
- **ui:** enhance ScrollArea with orientation/size variants and scrollbar styling
- **term:** persist workspace layout, restored ids and tab duplication options
- **ui:** snap dragged tab overlay to cursor in tab bars

### Style

- **ui:** use slightly thicker default scrollbar size

## [v2.0.7](https://github.com/zhengbiwen/TermBridge/releases/tag/v2.0.7) - 2026-07-22

### Style

- **ui:** polish sftp bookmark menu and tab bar
- **ui:** refine split pane subtle divider styling

## [v2.0.6](https://github.com/zhengbiwen/TermBridge/releases/tag/v2.0.6) - 2026-07-22

### Chore

- **icons:** update app icon set

### Features

- **term:** configure local terminal environment variables
- **ui:** improve update check feedback with toasts and window focus

### Refactoring

- **ui:** use compact dialog in update restart dialog

## [v2.0.5](https://github.com/zhengbiwen/TermBridge/releases/tag/v2.0.5) - 2026-07-22

### Bug Fixes

- **ui:** fix sftp source switch button height
- **i18n:** use proper i18n keys for delete confirmation

### Features

- **ui:** add bottom border to title bar
- **term:** add split pane support with recursive layout and subtle dividers

### Refactoring

- **sftp:** add search auto-focus and simplify tab bar

### Style

- **settings:** improve card layout and separator styling
- **ui:** reduce border opacity to 50% for softer borders
- **term:** simplify terminal tab bar styles

## [v2.0.4](https://github.com/zhengbiwen/TermBridge/releases/tag/v2.0.4) - 2026-07-21

### Bug Fixes

- **tauri:** handle SFTP v3 rename without OVERWRITE flag

### Chore

- **deps:** sync Cargo.lock version with Cargo.toml

### Features

- **tauri:** add SQLite database for persistence
- **build:** add manual version input to bump script
- **store:** persist terminal workspace to SQLite and improve connection UX

### Refactoring

- **tauri:** extract theme module and improve DB integration

### Style

- **term:** fix formatting in terminal component

## [v2.0.3](https://github.com/zhengbiwen/TermBridge/releases/tag/v2.0.3) - 2026-07-21

### Bug Fixes

- **ui:** align SFTP transfer progress track to bottom edge with 3px height
- **ui:** prevent double-click activation across menus and buttons

## [v2.0.2](https://github.com/zhengbiwen/TermBridge/releases/tag/v2.0.2) - 2026-07-20

### Features

- **ui:** add SFTP file search, known-host connection creation, and terminal find shortcut
- **ui:** add search icon inside connection and credentials search inputs
- **sftp:** persist split pane ratio in store with controlled SplitPane

## [v2.0.1](https://github.com/zhengbiwen/TermBridge/releases/tag/v2.0.1) - 2026-07-20

### Bug Fixes

- **ui:** persist confirmation dialog target after context menu closes
- **tauri:** serialize CreateSessionError type tag in PascalCase

### Documentation

- **sftp:** add local file operations design spec
- **sftp:** add local file operations implementation plan

### Features

- **ui:** add PanelEmptyState and PanelLoadingState shared components
- **ui:** add close confirmation dialogs for tab context menus
- **ui:** add credential prompt dialog and single-tab hide option
- **sftp:** add local file operation invoke wrappers
- **ui:** add log source switcher with source-aware empty state
- **sftp:** add paste_local_paths command with auto-rename
- **sftp:** add rename_local_path command
- **sftp:** add trash_local_paths command
- **sftp:** enable local rename, copy, paste, and trash in pane actions
- **sftp:** enable rename, copy, delete, and paste in local context menus
- **ui:** improve workbench panel empty, loading, and search states

### Refactoring

- **ui:** rename passwordPrompt to kebab-case and skip reconnect system line

### Style

- **ui:** replace raw label with Label component in credential prompt

## [v2.0.0](https://github.com/zhengbiwen/TermBridge/releases/tag/v2.0.0) - 2026-07-20

### Bug Fixes

- **ui:** TaskBlocks overflow closure, tests, and dead code
- **terminal:** add trailing newlines and self-remove controller from registry map
- address final review findings for visual refresh
- **status-bar:** address final review issues
- **sftp:** address final review issues for system drag-and-drop
- **status-bar:** address final verification review issues
- **ui:** align TaskDialog title locale and remove unused import
- **ui:** align icons and labels in sftp context menus
- **term:** apply color scheme background to terminal element
- **term:** apply color scheme background to terminal viewport
- **sftp:** avoid double refresh on remote uploads
- **sftp:** collapse breadcrumb to root + ellipsis + last in narrow containers
- **ui:** compact width, padding, and footer spacing
- **test:** correct relative imports after moving tests to **tests**
- **sftp:** honor direction when sorting by kind column
- **sftp:** ignore system drops onto the same local directory
- **store:** improve password lifecycle in profile store
- **term:** improve terminal copy shortcut and search overlay styling
- **statusbar:** keep tooltip open when moving cursor from block to tooltip
- **dialog:** localize screen-reader close label
- **ui:** localize system-block subtitles and clamp tooltip viewport position
- **ui:** match input height, fill width, and soften focus ring
- **terminal:** mock useI18n in TerminalPane tests for pristine output
- **sftp:** normalize paths in copy_local_paths
- **ui:** overlay split pane resize handle on the divider line
- **tauri:** prevent deadlock in remote-to-remote copy
- **workbench:** prevent log timestamp wrapping
- **terminal:** re-arm ResizeObserver on reattach and harden listener cleanup
- **ui:** reduce focus ring to ring-1
- **sftp:** refresh after conflict resolution in system drop
- **ui:** remove store reset from TaskDialog tests and decouple selectors
- **ui:** remove track padding from scroll area
- **terminal:** restore xterm CSS, drop double p-2, add context menu guards
- **ui:** square off scrollbar thumbs with hover feedback
- **sftp:** stabilize breadcrumb collapse calculation with measured widths
- **sftp:** stop parent row context-menu propagation, stabilize breadcrumb segments
- **ui:** use CSS radius variable for Sonner toast border radius
- **ui:** use render prop for TooltipTrigger in log panel
- **ui:** widen split pane drag handle

### Chore

- **agent:** add shadcn and radix-to-base agent skills
- modernize Tailwind CSS v4, shadcn, and base component setup
- remove obsolete migrate-radix-to-base skill docs
- update skills-lock.json after removing migrate-radix-to-base skill
- **deps:** upgrade dependencies and move tests to **tests** directories

### Documentation

- **superpowers:** add SFTP file list improvements plan and design spec
- **superpowers:** add SFTP refactor plan and design spec
- **superpowers:** add connection drawer and terminal copy behavior plans
- add modern visual refresh design spec
- add status bar redesign implementation plan
- add status bar redesign spec
- **spec:** add terminal panel refactor design (Spec 1)
- **readme:** simplify project description and trim feature details
- **claude:** update project structure and remove pre-commit checklist

### Features

- **sftp:** add CopyLocalPathsRequest type and invokeCopyLocalPaths binding
- **file-manager:** add EmptyStates component
- **file-manager:** add OperationLog component
- **file-manager:** add OperationLog component
- **file-manager:** add PathBreadcrumb component
- **file-manager:** add PathBreadcrumb component with icons
- **ui:** add SFTP tab separators and simplify exit confirmation
- **sftp:** add SftpParentRow component for parent directory navigation
- **status-bar:** add StatusBar container component
- **status-bar:** add SystemBlocks for session and update state
- **status-bar:** add TaskBlocks with overflow logic
- **status-bar:** add TaskDialog overflow modal
- **terminal:** add TerminalControllerLayer lifecycle reconciler
- **terminal:** add TerminalPane host with search and connecting overlay
- **file-manager:** add Toolbar component and icons
- **ui:** add app error boundary and connection form connect action
- **app:** add auto-update, about dialog and settings preference
- **sftp:** add batch selection toolbar and improve batch mode interactions
- **sftp:** add breadcrumb hover card and file list scroll sync
- **sftp:** add copyWithPolicies to useSftpPaneActions
- **ui:** add credentials panel and known hosts improvements
- **sftp:** add delete confirmation dialog
- **terminal:** add drag-to-reorder for terminal tabs
- **workbench:** add filters and virtual scroll to log panel
- **ui:** add horizontal slide-in animation for Sonner toasts
- **status-bar:** add hover tooltip card
- **status-bar:** add i18n keys for new status bar
- **terminal:** add i18n keys for tab context menu and picker
- **terminal:** add inline NewTabMenu profile picker
- **settings:** add keyboard shortcuts and terminal preferences
- **sftp:** add local copy command for drag-and-drop
- **term:** add local terminal session support
- **i18n:** add locale keys for tab close, credentials, and log filters
- **file-manager:** add operations hook, drag-drop, panels, grid, main container
- **sftp:** add parent row and three-state sorting in file list
- **terminal:** add profileId and reorderSessions to terminalStore
- **sftp:** add replace conflict action and improve transfer progress
- **status-bar:** add reusable StatusBlock component
- **workbench:** add right border to sidebar
- **ui:** add scroll-to-bottom button in log panel
- **app:** add section-based layout with separate settings window
- **term:** add separators between inactive terminal tabs
- **ui:** add shared PromptDialog component
- **status-bar:** add shared types and helpers
- **term:** add shift/ctrl multi-select to log panel
- **tauri:** add structured error logging to commands
- **logger:** add structured frontend logging utility
- **term:** add tab close confirmation dialog
- **sftp:** add tab close confirmation dialog
- **terminal:** add tab context menu
- **terminal:** add terminal controller registry with DOM reparenting
- **settings:** add terminal font, cursor style, SFTP and startup preferences
- **settings:** add terminal preferences and tab shortcuts
- **ui:** add toggle group and polish filter controls
- **sftp:** add transfer cancel and local-mode pane support
- **terminal:** add useActiveController pane-attach hook
- **terminal:** add useConnectSession shared connect hook
- **sftp:** add useSystemFileDrop hook for system drag-and-drop
- **hook:** add useViewportConstrainedPosition for context menu positioning
- **connection-form:** compact layout and explicit select labels
- **sftp:** download dropped remote files to the visible local directory
- **sftp:** enhance remote copy with progress, cancellation, and atomic staging
- **ui:** enhance workbench with card grids, search and log filters
- **settings:** expand terminal and SFTP preferences
- **file-manager:** extend store, add tokens, extract formatters
- **chrome:** flatten title bar and sidebar
- **sftp:** generalize UploadQueue and wire system drop in SftpContent
- **sftp:** hide sort indicator in default state
- **sftp:** improve context menu positioning and parent row interaction
- **sftp:** improve local path portability and host key verification
- **status-bar:** integrate new StatusBar and remove OperationStatusBar
- **ui:** integrate settings panel into workbench
- **ui:** introduce compact dialog and context menu layouts
- **ui:** log ipc invocation and lifecycle errors
- **term:** open search via keyboard shortcut and remove toggle button
- **term:** pass connect callback to new tab menu
- **workbench:** polish connection cards and workbench panels
- **sftp:** polish file list, toolbar, and dialogs
- **ui:** polish shared primitives with new tokens
- **ui:** polish split pane, empty state, tooltip and titlebar
- **term:** polish terminal tab bar
- **terminal:** polish terminal tab bar and menus
- **app:** rebuild frontend with workbench architecture
- **sftp:** redesign drag overlay with file preview card
- **term:** redesign new tab menu with recent profiles and add toast notifications
- **term:** redesign new tab menu with search and templates
- **sftp:** refactor SFTP pane with actions, context menus, dialogs and bookmarks
- **term:** refactor terminal panel with VSCode-style tabs and registry
- **ui:** remove icons from tab context menus
- **sftp:** replace ag-grid with custom terminal-style file list
- **terminal:** rewrite TerminalTabBar with VSCode-style tabs
- **sftp:** root slash and dynamic breadcrumb overflow
- **sftp:** show loading text in empty SFTP pane
- **term:** show session color on inactive tabs
- **sftp:** show tooltip with full file name when truncated
- **ui:** shrink pin icon in tab bars
- **ui:** simplify exit confirmation dialog and remove active tab shadow
- **sftp:** support remote-to-remote copy with per-side bookmarks
- **term:** terminal UI redesign with context menus, search and registry
- **sftp:** terminal-style layout and v1.2.12 ag-grid file list
- **workbench:** unify management cards and redesign credentials panel
- **i18n:** update exit confirmation message
- **file-manager:** update tests, restore readOnly i18n key
- **style:** update warm-gray + teal design tokens
- **sftp:** wire parent row props into SftpPane

### Other

- **split-pane, settings:** polish drag handle, settings spacing and add scroll-area

### Refactoring

- **file-manager:** consolidate FileManager components into single file
- **ui:** convert status bar blocks to task rows with progress and ETA
- **ui:** move reusable UI components into ui/ directory
- **workbench:** polish log panel and list headers
- **app:** remove legacy source files and assets
- **ui:** remove port forwarding and polish workbench layout
- rename all component files and folders to lowercase-kebab-case
- **terminal:** rewrite Terminal panel shell with registry-backed tabs
- **ui:** simplify connection form and unify theme handling
- **workbench:** simplify log panel and add export
- **ui:** streamline file manager toolbars and navigation
- **workbench:** use shared useConnectSession and HostKeyDialog

### Style

- **workbench:** add trailing newline to index.tsx
- **terminal:** add trailing newlines to HostKeyDialog and index
- **terminal:** add trailing newlines to TerminalTabBar files
- **terminal:** add trailing newlines to useActiveController files
- **terminal:** add trailing newlines to useConnectSession files
- **i18n:** normalize terminal notice punctuation and formatting
- **sftp:** reformat sftp-pane to single-line style

### Testing

- **sftp:** add SftpContent system drop tests
- **sftp:** add context menu pointer-down and reopen tests
- **status-bar:** expand StatusBar tests
- **sftp:** remove out-of-scope policy filtering from system drop tests
- **connection-form:** tighten select label assertion

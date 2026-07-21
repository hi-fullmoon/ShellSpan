# Changelog

All notable changes to TermBridge are documented in this file.


## [Unreleased]


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
- **test:** correct relative imports after moving tests to __tests__
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
- **deps:** upgrade dependencies and move tests to __tests__ directories

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

## [v1.2.12](https://github.com/zhengbiwen/TermBridge/releases/tag/v1.2.12) - 2026-06-30


### Bug Fixes

- **ui:** add padding to delete profile dialog panel
- **file-manager:** address final review findings for SFTP pool and connection handling
- **build:** align Tauri packages on 2.11
- allow global shortcuts when terminal is focused
- **ui:** bind menuRef to context menu DOM elements for position clamping
- **ui:** correct drag reorder insert index and pin boundary logic
- ensure SplitLayout drag indicator hides on pointer release outside window
- **term:** fix file manager first click row selection
- **tauri:** hash credentials in SFTP pool key instead of embedding plaintext
- **windows:** hide production log console
- import objc sel macro before msg_send
- include jump host in SFTP pool key and rename get_or_create to get
- **tauri:** invalidate SFTP pool entry when SSH worker thread exits
- **ui:** keep pin icon always visible on pinned tabs
- **file-manager:** open properties panel when editing permissions from context menu
- prevent white flash on settings window open
- **sftp:** register RemoteIdentityCache as Tauri managed state
- **ui:** remove unused profile color feature and center settings title
- reset load state on session switch; prevent text selection in session tabs
- **tauri:** resolve TRAY_ABOUT_ID compilation error on non-Windows platforms
- **ui:** resolve dialog padding, select positioning, and sidebar input height
- restore specific socket phrase detection in is_connection_error
- **tauri:** scope identity cache by host:port:username
- sidebar toggle stale closure and keyboard case-insensitive matching
- **ui:** simplify FormSelect, remove controlled open state
- **ui:** skip dragged tab when calculating drop insert index
- **sftp:** structured connection key and atomic pool insert
- suppress unused import and parameter warnings on non-macos builds
- sync i18n locale before first render in settings window
- **ui:** use Chakra positioning in FormSelect and close on select
- **tauri:** use custom About page on macOS
- **tauri:** use structured JumpHostKey instead of colon-delimited hash
- wrap version calc in IIFE for node -p
- **release:** 修复 pnpm 版本未指定导致的构建失败
- **download:** 修复下载文件夹卡住与取消无响应
- **ui:** 修复右键菜单与弹框未主题化
- **session-tabs:** 修复拖拽排序后标签闪动
- **session-order:** 修复新建会话总是插到首位的问题
- **window:** 修复暗色模式标题栏仍显示白色
- **ui:** 修复浅色主题按钮与提示样式不协调
- 修复远程文件管理器弹框未主题化问题

### CI/CD

- remove hardcoded pnpm version in release workflow

### Chore

- add .worktrees to gitignore
- add bump script to package.json
- add bump-version script
- add code-inspector-plugin and layout-styling docs
- add generated windows schema
- **docs:** add project guidelines and contributing docs
- clean up ineffective scrollbar CSS workaround
- lint fixes and file manager count display tweak
- merge release scripts into single 'release' command
- release v1.0.9
- **sftp:** remove redundant credential_marker wrapper
- rename bump script to version
- **deps:** upgrade dependencies and add .npmrc registry config
- verify file manager security features compile and pass tests
- verify known hosts management feature
- verify quick connect and profile group features compile and pass tests
- **build-config:** 升级前端构建链路并同步工程配置
- 发布 1.0.11 版本
- 发布 v1.0.10
- 同步 Cargo.lock 版本到 v1.0.10

### Documentation

- add file manager security enhancement plan
- add host key dialog spec and implementation plan
- **superpowers:** add plans and specs for settings dialog and UI improvements
- add session tab input transparent background design
- add session tab input transparent background implementation plan
- translate CLAUDE.md and CONTRIBUTING.md to Chinese

### Features

- **ui:** add About dialog and fix Windows tray menu events
- **known-hosts:** add backend host key check and trust modules
- **sftp:** add connection pool scaffolding and key helper
- **terminal:** add context menu with copy, paste, select all, clear, find and snippets
- add file picker button for private key path in connection form
- **app:** add host key check flow with trust dialog
- **backend:** add host key check inside async create_session
- **file-manager:** add inline permission editing in properties panel
- **profile:** add parseQuickConnect and group field to ConnectionProfile
- **ui:** add pin/unpin to session tabs
- **app:** add profile group management handler
- **connection-form:** add quick-connect input to parse user@host:port
- **file-manager:** add sensitive path warning banner
- **remote-fs:** add update_remote_permissions backend command
- add windows tray settings and bump version to 1.0.12
- **remote-fs:** auto-restrict permissions to 600 for uploaded private key files
- **sftp:** cache remote owner and group name lookups
- **backend:** classify host key errors and add CreateSessionError type
- **ui:** exclude pinned tabs from batch close and unpin on drag reorder
- **settings:** fix dialog height and move scroll container to dialog level
- **flow:** handle structured create_session host key errors and show dialog
- **ui:** hide bookmark icon, narrow checkbox column, add batch exit menu
- **sftp:** invalidate cached connections on transport errors
- keychain storage, jump host, port forwarding, and keyboard shortcuts
- **ui:** make session tab rename input background transparent
- **ui:** migrate components to Chakra UI v3
- **ui:** pin icon click to toggle and fix drag-to-pin drop position
- **ui:** redesign session tabs to VSCode style and fix file manager issues
- **ui:** redesign tab color picker and clear button style
- refine layout borders, debounce connect, and extract split styles
- **commands:** register check_host_key and trust_host commands
- **ui:** remove color indicator from history list
- **ui:** remove connection group feature
- **sidebar:** remove connection profile grouping
- **settings:** remove range slider and content scrolling from SettingsPanel
- **sidebar:** render saved profiles by collapsible groups
- **sftp:** reuse cached SFTP connections across file manager operations
- settings window, custom title bar, lib reorg, and style split
- show copy-on-select feedback
- show scrollbars on hover in file grid (macOS legacy scroller style)
- **ui:** unpinned tab becomes pinned when dragged before pinned tabs
- update workspace tools
- **scroll-area:** 引入统一滚动区域并支持双击修改历史连接
- **settings:** 扩展设置面板并收紧整体 UI 布局
- 批量下载支持文件夹，书签菜单增加移除按钮
- **settings:** 新增跟随系统主题并统一设置预览布局
- **file-manager,terminal:** 新增远程文件下载与终端内搜索
- **ui:** 添加主题切换与设置面板

### Other

- add translations for known hosts verification
- add translations for permission editing and sensitive path warning
- add translations for quick connect and profile groups

### Refactoring

- SplitLayout uses children slot API with collapsed/fixed support
- **ui:** encapsulate Chakra Select into reusable FormSelect component
- **tauri:** enhance security and reliability across SSH operations
- **hook:** extract App logic into dedicated hooks
- extract dialog components and adjust layout spacing
- **ui:** extract operation progress to global store with status bar
- **term:** extract terminal logic into hooks and sub-components
- **ui:** make ConnectDialog self-manage scroll with fixed dimensions
- **ui:** migrate native inputs to Chakra UI Input and improve hover states
- remove .btn-confirm, use .primary-btn directly
- remove snippets, simplify ScrollArea, add sidebar shortcuts
- rename .danger-btn to .btn-danger for consistent naming
- rename .primary-btn to .btn-primary for consistent naming
- **settings:** replace separate settings window with in-app dialog
- **ui:** unify context menu control with global store and hook
- **app:** 拆分 Tauri 模块并补齐界面国际化
- **src-tauri:** 拆分后端模块并完善文件清理

### Revert

- remove objc backend, keep CSS-only scrollbar hover attempt
- restore custom ScrollArea scrollbar implementation

### Style

- add 4px border-radius to all form controls
- add 4px border-radius to themed-checkbox-row
- add border-radius to all dialogs and remove grid wrapper radius
- add panel background color variables for better layering
- **settings:** clean up settings-content css after scroll container move
- encapsulate dialog cancel and confirm buttons into .btn-cancel and .btn-confirm
- extract inline danger button styles into .danger-btn component
- **session-tabs:** remove border and focus ring from edit input
- remove border-radius and gaps from SessionTabs
- remove border-radius from FileManager
- remove border-radius from all non-dialog UI elements
- remove border-radius from surface and surface-muted
- remove border-radius from terminal container
- remove gaps and padding from main container
- remove remaining border-radius from Sidebar and FileManager
- replace missed exit dialog inline danger button with .danger-btn
- simplify grid scrollbar CSS
- smaller border-radius for file grid scrollbars
- target AG Grid viewport elements for scrollbar styling
- theme ConnectionForm hardcoded slate colors
- unify dialog border-radius and hide tab close button by default
- **ui:** 微调间距、边框与分割线样式
- **layout:** 调整主界面间距与会话标签空态样式
- **app:** 调整分栏拖拽条视觉样式
- 调整提示框圆角样式

### Testing

- add host key dialog coverage for unknown hosts
- add quick-connect edge cases and profile group rendering tests
- **file-manager:** add tests for permission editing and sensitive path warning
- **app-reconnect:** update tests for host key check flow
- **sftp:** verify connection pool and identity cache pass full suite
- **app:** 修复重连流程测试文案断言失败

## [v1.0.8](https://github.com/zhengbiwen/TermBridge/releases/tag/v1.0.8) - 2026-04-20


### Chore

- release v1.0.8

## [v1.0.7](https://github.com/zhengbiwen/TermBridge/releases/tag/v1.0.7) - 2026-04-20


### Chore

- release v1.0.7

## [v1.0.6](https://github.com/zhengbiwen/TermBridge/releases/tag/v1.0.6) - 2026-04-17


### Bug Fixes

- **ui:** center toast notifications

## [v1.0.4](https://github.com/zhengbiwen/TermBridge/releases/tag/v1.0.4) - 2026-04-17


### Bug Fixes

- **file-manager:** make remote browser read-only after disconnect

## [v1.0.3](https://github.com/zhengbiwen/TermBridge/releases/tag/v1.0.3) - 2026-04-17


### Bug Fixes

- align updater public key

### Chore

- **ci:** build x64 macOS dmg
- revert version to 1.0.3
- simplify tauri scripts
- streamline release assets
- sync cargo lock version

## [v1.0.2](https://github.com/zhengbiwen/TermBridge/releases/tag/v1.0.2) - 2026-04-16


### Chore

- **ci:** run javascript actions on node 24

### Features

- confirm app exit before quitting

## [v1.0.1](https://github.com/zhengbiwen/TermBridge/releases/tag/v1.0.1) - 2026-04-16


### Bug Fixes

- **windows:** enable tray icon support
- handle update listener registration failures
- harden startup update throttle edge cases
- harden update restart flow and dialog coverage
- harden updater wrapper progress and typing
- **ssh:** improve high-frequency input stability
- isolate app update listener mock state
- register tauri updater plugin runtime
- **ci:** resolve target-specific bundle path
- **terminal:** unify terminal status output
- **ci:** update supported release runners
- use native app restart command for update install

### Chore

- **ci:** align node runtime to 24
- bump version to 1.0.0
- commit remaining terminal and session updates
- sync cargo lock for updater runtime

### Documentation

- **spec:** add update system design
- **plan:** add update system implementation plan
- **readme:** rewrite project guide

### Features

- **release:** add multi-platform github publishing
- add native check-update menu and tray entry
- add startup auto-update UX flow
- add tauri updater wrapper
- add update lifecycle state machine
- enable tauri updater plugin configuration
- improve updater UX and automate GitHub releases
- wire system check-update events and docs

### Style

- normalize tauri config formatting
- **file-manager:** tighten grid corner radius

### Testing

- cover startup update throttle policy

## [v1.0.0](https://github.com/zhengbiwen/TermBridge/releases/tag/v1.0.0) - 2026-04-15


### Bug Fixes

- configure bundle icons for packaging
- improve SSH session stability with keepalive and clearer transport errors
- sync file grid selection and toolbar actions

### Documentation

- **contributing:** add codex commit and comment guidelines
- rewrite readme

### Features

- Implement file upload and delete progress bars
- add unified desktop logging
- polish file manager actions and cancellable operations
- upgrade file manager experience

### Testing

- add src unit coverage

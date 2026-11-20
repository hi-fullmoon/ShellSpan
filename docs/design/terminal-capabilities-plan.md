# ShellSpan 终端能力增强实施计划

基线为 `c06916e6`（`v2.5.0`）。桌面交付平台为 macOS 和 Windows，覆盖本地终端与 Linux/Unix SSH 远端目标。当前 ShellSpan 已具备本地 PTY（含 Windows ConPTY 与 macOS arm64 ShellSpan Bash）、SSH 会话、多标签与嵌套分屏、类 tmux Leader 键、正则/大小写搜索、选中复制与粘贴防护、9 套配色及自定义覆盖、背压流控、自动重连、单跳跳板机、本地/远程端口转发，以及 `terminal_broker` / `terminal_integration` 提供的 `OSC 133`、`current_directory`、`exit_code` 与 Agent 租约底座。

本计划将待补充的终端能力拆分为 **三个递进里程碑（M1 / M2 / M3）**，优先盘活已建成的 Shell Integration 底座并补齐日常高频交互断层，再逐步扩展远程运维核心能力与底层协议生态。

---

## 一、里程碑总览

| 阶段 | 核心目标 | 改动范围 | 特点与依赖 |
| :--- | :--- | :--- | :--- |
| **M1（第 1 批）** | 消除日常交互断层，补齐高频终端协议与交互手感 | 前端为主 + 少量既有状态字段透出 | **不改数据库 Schema**，风险低、见效最快，可按工作包独立提交验收 |
| **M2（第 2 批）** | 释放 Shell Integration 价值，补齐 SSH 运维核心能力 | 前端 + Rust（`terminal_broker` / `session` / `port_forward` / `connection` / `db`） | 涉及 SQLite v5 → v6 迁移，构成核心运维竞争力；WP 2.1 依赖 M1 对 `currentDirectory` 的事件透出，WP 2.2 依赖 WP 1.5 只读锁语义 |
| **M3（第 3 批）** | 拓展多环境 Shell、输出分析、渲染性能与轻量 AI 入口 | 前后端模块化增量演进 | 独立演进，可根据产品定位与用户反馈按需裁剪或调整顺序 |

---

## 二、架构约束与实施红线

所有工作包在设计与落地时必须严格遵守以下仓库约定，避免触碰运行时安全或静态门禁：

1. **终端命令展示边界门禁**
   - [终端命令边界检查脚本](../../scripts/checks/check-terminal-command-boundary.mjs)（`pnpm check:terminal:boundary`）会对 [终端注册表](../../src/components/terminal/registry/terminal-registry.ts)、[终端控制层](../../src/components/terminal/terminal-controller-layer.tsx)、`src/components/terminal/registry/terminal-command-*` 与 `src/lib/terminal/native-input-display*` 执行 AST 静态检查：禁止访问 xterm `_` 私有成员、禁止在展示层进行 DOM 文本投影（如 JSX 投影、`textContent`/`innerHTML` 赋值）、禁止替换 xterm 保护成员或解构投影命令元数据，同步参考[原生终端显示与命令标记](../../protocol/native-input-display.md)。
   - **落地对策**：WP 2.1 的命令块交互 UI（退出码、耗时、复制命令输出、AI 排障入口）必须落在**独立 React 覆盖层组件**（不放入 `terminal-command-*` 前缀模块，也不被上述显示辅助链直接引入），仅通过 xterm 公开 API 读取 `IMarker` 坐标与缓冲行。

2. **目录职责与 IPC 契约**
   - 遵循[领域模块组织说明](../../src/lib/README.md)：新增终端领域逻辑统一放入 `src/lib/terminal/`，不创建根级 barrel。
   - 前端调用后端统一经 [IPC 适配层](../../src/lib/ipc/tauri.ts) 封装类型化方法，不在组件内散布裸 `invoke` 或事件监听；新增/修改 Rust `#[tauri::command]` 时必须同步检查参数校验、[命令注册表](../../src-tauri/src/lib.rs)、前端类型与测试。

3. **SQLite 迁移与触发器安全**
   - [数据库模块](../../src-tauri/src/db.rs) 当前 `CURRENT_SCHEMA_VERSION = 5`。其中 `profiles` 表包含 `CHECK(auth_method IN ('password', 'key'))` 约束，并绑定 `revoke_sudo_policy_on_profile_identity_change` 触发器（凭据或连接标识变更时自动撤销 `profile_sudo_policy`）。
   - **落地对策**：M2 升级到 schema v6（新增 `command_snippets` 表及扩展 `profiles.auth_method`）若需重建 `profiles` 表，必须在同一事务内完整保留外键、`recent_profiles` 关联以及 `revoke_sudo_policy_on_profile_identity_change` 触发器，并补充 v5 → v6 迁移回归测试。

4. **安全与敏感数据底线**
   - **OSC 52**：默认仅允许「远端写入本地剪贴板」，**禁止静默读取本地剪贴板（`?` 查询）**，限制解码后字节上限（1MB）并校验合法性，支持配置关闭。
   - **广播输入**：仅在用户主动键盘/粘贴输入时路由分发；必须硬跳过 `readOnly`、未连接、`preparingInput` 以及被 `agentTerminalLeaseState` 占用的目标会话；广播态下对多行/大文本粘贴联动二次确认。
   - **会话日志与录制**：写盘前必须经过[内容脱敏模块](../../src-tauri/src/redaction.rs)过滤凭证与敏感字段；后端消费 PTY 字节流必须使用有界异步通道，高负载时宁可记录丢帧统计也不阻塞 PTY 主循环。
   - **2FA / Keyboard-Interactive**：质询回答仅保存在内存并以 `zeroize` 清理，严禁写入应用日志、调试快照或 SQLite。
   - **命令片段与拖入**：延续[主机快捷动作](../../src/lib/host/host-quick-actions.ts)的安全默认——片段插入与路径转义默认仅填入命令行，**不静默附带换行自动执行**，并过滤控制字符。

5. **UI、布局与双语规范**
   - 严格遵守[仓库工作约定](../../AGENTS.md)：所有用户可见文案同步更新[中文文案](../../src/locales/zh-CN.ts)与[英文文案](../../src/locales/en-US.ts)并保持键集合一致。
   - 新增弹框沿用系统共享 `Dialog` / `CompactDialog` 规范：底部操作区不加 `border-t` 或额外 `Separator`、Footer 保持 `shrink-0`、中间容器 `min-h-0 flex-1` 搭配 `ScrollArea` 独立滚动；Base UI `Select` 根组件传入同源 `{ value, label }` `items` 映射；同行图标与文字统一 `gap-1`；布局断点使用容器查询 `@min-*`。

---

## 三、Phase 1（M1）：体验与协议基础

> M1 不变更数据库 Schema 与 SSH 握手协议，工作包之间耦合极低，可按 WP 1.1 → WP 1.5 顺序逐个落地并提交。

### WP 1.1 单标签直接分屏与窗格缩放（Pane Zoom）

- **现状与目标**：[终端工作区容器](../../src/components/terminal/index.tsx)中的 `createOrArrangeSplit`、[标签栏](../../src/components/terminal/terminal-tab-bar.tsx)、[标签右键菜单](../../src/components/terminal/terminal-context-menu.tsx)与[命令面板](../../src/components/command-palette.tsx)目前均以 `sessions.length >= 2`（或当前组标签数 `> 1`）作为分屏前提；[Leader 键状态机](../../src/components/terminal/terminal-leader.ts)缺少类似 tmux `Ctrl+B z` 的单窗格临时最大化能力。
- **涉及文件**：
  - [终端工作区容器](../../src/components/terminal/index.tsx)、[终端标签栏](../../src/components/terminal/terminal-tab-bar.tsx)、[标签右键菜单](../../src/components/terminal/terminal-context-menu.tsx)、[终端 Leader 状态机](../../src/components/terminal/terminal-leader.ts)、[命令面板](../../src/components/command-palette.tsx)
  - [会话连接 Hook](../../src/hooks/useConnectSession.ts)、[终端状态 Store](../../src/stores/terminalStore.ts)、[应用全局 Store](../../src/stores/appStore.ts)、[快捷键工具](../../src/lib/shortcuts.ts)、[前端类型定义](../../src/types/index.ts)、双语文件
- **具体方案**：
  1. **单标签直接分屏**：
     - 放开 `canSplit` 对会话数 `>= 2` 的前置限制，仅要求存在非 pending 的活跃会话且目标容器尺寸满足 `TERMINAL_MIN_PANE_SIZE * 2`。
     - 当触发向右/向下分屏且当前组只有 1 个会话时，自动为新组创建一个配套会话：若源会话为 SSH（存在 `profileId`），先尝试读取可用 `currentDirectory`（避免干扰半成品输入），再通过 `connect(profile, { initialDirectory, ... })` 克隆会话；若为本地终端，则调用 `openLocal` 新建同类本地终端，连接建立后自动归入新分屏组。
  2. **窗格 Zoom（`Ctrl+B z`）**：
     - 在 `ShortcutAction`、`DEFAULT_SHORTCUTS`、`LEADER_SHORTCUT_ACTIONS` 与 `terminal-leader.ts` 中新增 `terminalZoomPane`（默认绑定 `z`），并补充窗格均分/互换动作。
     - 在 `terminalStore.ts` 增加运行时字段 `zoomedGroupSlot: string | null`（不写入持久化布局）；Zoom 激活时工作区仅渲染目标分屏组并在标签栏/右上角显示「已最大化 · 点击或按 `Ctrl+B z` 还原」入口；取消分屏、关闭目标组或切换工作区时自动重置 `zoomedGroupSlot`。
- **验证要点**：
  - 单元测试覆盖：单会话时执行 `splitRight` / `splitBottom` 自动触发克隆连接与布局分裂；容器过窄时正确禁用；Zoom 开启/还原/关闭组时状态收敛且不污染 `serializeTerminalWorkspace` 持久化结果。

### WP 1.2 动态标签标题（OSC 0/2 & `${cwd}`）与终端 CWD 直达 SFTP

- **现状与目标**：[标签标题模板](../../src/lib/terminal/tab-title.ts)目前仅支持 `${name}` / `${user}` / `${host}` / `${port}` / `${index}`；[标签右键菜单](../../src/components/terminal/terminal-context-menu.tsx)的 `handleOpenSftp` 仅传递 `profileId`，未联动当前目录。
- **涉及文件**：
  - [终端 Broker](../../src-tauri/src/terminal_broker.rs)、[终端会话协议契约](../../protocol/agent/runtime/terminal-protocol-rfc.md)
  - [终端控制层](../../src/components/terminal/terminal-controller-layer.tsx)、[终端注册表](../../src/components/terminal/registry/terminal-registry.ts)、[终端状态 Store](../../src/stores/terminalStore.ts)
  - [标签标题工具](../../src/lib/terminal/tab-title.ts)、[标签标题设置](../../src/components/terminal/terminal-title-settings.tsx)、[终端目录探测](../../src/lib/terminal/terminal-current-directory.ts)、[主机快捷动作](../../src/lib/host/host-quick-actions.ts)、[标签右键菜单](../../src/components/terminal/terminal-context-menu.tsx)
- **具体方案**：
  1. **透出实时 CWD 与 OSC 标题**：
     - 在 Rust `TerminalIntegrationStateEvent`（`terminal_broker.rs`）中增加可选字段 `current_directory: Option<String>`，并在状态变更与命令结束刷新时同步推送给前端 `TerminalSession.currentDirectory`。
     - 在 `terminal-registry.ts` 中监听 xterm `terminal.onTitleChange`，清洗控制字符并限制长度后更新 `TerminalSession.oscTitle`。
  2. **扩展标题模板**：
     - `tab-title.ts` 与 `terminal-title-settings.tsx` 新增 `${cwd}`（如末级目录名/路径缩写）与 `${title}`（优先取 `oscTitle`，空时回退会话名）变量及配套预设。
  3. **终端当前目录直达 SFTP / 系统文件管理器**：
     - 升级 `terminal-context-menu.tsx` 的 `handleOpenSftp`：优先使用 `session.currentDirectory`，缺省且为远端空闲会话时异步调用 `readTerminalCurrentDirectory(session)` 探测，再用 `openHostPath(profile, cwd, 'sftp')` 直接定位远端窗格。
     - 本地会话（`host === 'local' && port === 0`）在标签/内容右键菜单补充「在系统文件管理器中打开当前目录」（调用现有 `invokeRevealPath`）。
- **验证要点**：
  - `tab-title` 单测覆盖 `${cwd}`、`${title}`、缺失值回退及控制字符清洗；右键菜单单测验证有 CWD、需探针回退、以及无 CWD 时的安全降级。

### WP 1.3 字号快捷键缩放、自定义字体、macOS Option as Meta 与搜索增强

- **现状与目标**：[设置面板](../../src/components/workbench/settings-panel.tsx)当前字号固定 6 个离散选项（12–18），字体固定 5 个内置选项，且缺少 `macOptionIsMeta` 与 `altClickMovesCursor` 配置；[终端搜索栏](../../src/components/terminal/terminal-search.tsx)缺少全词匹配与选区自动填充。
- **涉及文件**：
  - [应用全局 Store](../../src/stores/appStore.ts)、[前端类型定义](../../src/types/index.ts)、[设置面板](../../src/components/workbench/settings-panel.tsx)
  - [终端注册表](../../src/components/terminal/registry/terminal-registry.ts)、[终端窗格](../../src/components/terminal/terminal-pane.tsx)、[终端搜索栏](../../src/components/terminal/terminal-search.tsx)、双语文件
- **具体方案**：
  1. **字体与按键偏好**：
     - `appStore.ts` 新增 `terminalCustomFontFamily: string`（非空时置于 `fontFamily` CSS 栈最前端，兼容 `JetBrains Mono` / `Maple Mono` / `Nerd Fonts`）、`terminalMacOptionIsMeta: boolean`（默认 `false`）、`terminalAltClickMovesCursor: boolean`（默认 `true`），并在 `terminal-registry.ts` 的 `updateOptions` 中实时同步到 `terminal.options`。
     - `terminal-pane.tsx` 的自定义键盘拦截中处理 `Mod+=` / `Mod+-` / `Mod+0`，将 `terminalFontSize` 在 `10–32` 范围内即时增减或重置为 `14`，同步更新 `settings-panel.tsx` 字号展示（支持快捷键调出预设外字号时的可读显示）。
  2. **搜索增强**：
     - `terminal-search.tsx` 增加全词匹配切换按钮（透传 `wholeWord: true` 给 `@xterm/addon-search`）。
     - 按下 `findTerminal` 打开搜索栏时，若终端存在单行非空选区，自动填入搜索框并全选以便改写；搜索栏内支持 `Mod+G` / `Shift+Mod+G` 跳转上/下一处匹配。
- **验证要点**：
  - 验证字体回退栈拼接与空字符串恢复默认；字号缩放边界（10/32）与重置；`wholeWord` 选项变化时正确触发 `clearDecorations()` + 重新高亮；选区自动填入不捕获多行文本。

### WP 1.4 终端协议与拖入文件：OSC 52、OSC 8 / 路径行列号直达、文件拖放

- **现状与目标**：当前仅支持正则识别 `http(s)://` 链接；远端 `tmux`/`Neovim` 无法通过 OSC 52 写入本地剪贴板；[系统文件拖放 Hook](../../src/hooks/useSystemFileDrop.ts) 仅服务于 SFTP，拖入终端窗口无响应。
- **涉及文件**：
  - 新增 `src/lib/terminal/terminal-osc52.ts`、`src/lib/terminal/terminal-links.ts`、`src/hooks/useTerminalFileDrop.ts`
  - [终端注册表](../../src/components/terminal/registry/terminal-registry.ts)、[终端窗格](../../src/components/terminal/terminal-pane.tsx)、[剪贴板工具](../../src/lib/clipboard.ts)、[系统文件拖放 Hook](../../src/hooks/useSystemFileDrop.ts)、[应用全局 Store](../../src/stores/appStore.ts)、[设置面板](../../src/components/workbench/settings-panel.tsx)
- **具体方案**：
  1. **OSC 52 远端剪贴板（`terminal-osc52.ts`）**：
     - 注册 `terminal.parser.registerOscHandler(52, ...)`，新增偏好 `terminalOsc52Policy: 'writeOnly' | 'disabled'`（默认 `writeOnly`）。
     - 严格解析 `;` 分隔的 `<target>;<base64>` 载荷：直接丢弃 `?` 读取请求；限制 Base64 解码后长度（≤ 1MB）；通过 `TextDecoder('utf-8', { fatal: false })` 解码并调用 `writeClipboardText`，可选弹出轻量 Toast 提示「远端应用已复制到剪贴板」。
  2. **OSC 8 超链接与 `path:line(:col)` 解析（`terminal-links.ts`）**：
     - 在 xterm 激活链接处理链中补充 OSC 8（注意：需校验 URI Scheme 仅允许 `http:` / `https:` 直接 `invokeOpenUrl`，拒绝 `javascript:` / `file:` / 自定义协议直接执行）。
     - 扩展 Link Provider 支持常见编译器/grep 输出的 `path:line(:col)` 与绝对路径点击：本地会话尝试定位文件（`invokeRevealPath`），SSH 会话定位到对应父目录的 SFTP 窗格（`openHostPath`）。
  3. **拖入文件到终端（`useTerminalFileDrop.ts`）**：
     - 仅在 `activeSection === 'terminal'` 时激活窗口 `onDragDropEvent` 监听，避免与 SFTP 视图的 `useSystemFileDrop` 冲突；按命中坐标解析目标终端窗格。
     - 本地终端：按目标会话 Shell 类型（POSIX 单引号转义 / PowerShell 单引号转义）安全拼接路径后写入当前活跃终端（不自动回车）。
     - SSH 终端：弹出轻量确认选择「上传到当前目录（复用 SFTP 传输队列）」或「仅插入本地路径」。
- **验证要点**：
  - OSC 52 单测覆盖 `?` 拒绝、超 1MB 载荷截断/拒绝、非法 Base64 拒绝、禁用策略生效。
  - 链接解析单测覆盖折行 URL、OSC 8 危险协议拦截、`path:line:col` 提取。
  - 文件路径转义单测覆盖空格、单引号、美元符、反斜杠及多文件拖拽。

### WP 1.5 单会话只读保护（Input Lock）

- **现状与目标**：盯生产日志、演示投屏或对照多个窗格时，缺乏防止误敲回车或误粘贴的会话级输入锁。
- **涉及文件**：
  - [终端状态 Store](../../src/stores/terminalStore.ts)、[终端注册表](../../src/components/terminal/registry/terminal-registry.ts)、[终端窗格](../../src/components/terminal/terminal-pane.tsx)
  - [终端标签栏](../../src/components/terminal/terminal-tab-bar.tsx)、[标签右键菜单](../../src/components/terminal/terminal-context-menu.tsx)、[终端内容右键菜单](../../src/components/terminal/terminal-content-menu.tsx)、[命令面板](../../src/components/command-palette.tsx)
- **具体方案**：
  - `TerminalSession` 新增运行时字段 `readOnly?: boolean`（不跨重启持久化，避免用户重开应用误以为断连）。
  - 启用 `readOnly` 时通过 `TerminalController.suppressUserInput` 阻断键盘与粘贴输入；在标签图标区展示只读锁徽标，在 `TerminalPane` 顶部渲染轻量提示条并提供一键「解除只读」按钮。
- **验证要点**：
  - 验证只读状态下键盘按键、右键粘贴、`Mod+V` 均被拦截且不向 PTY 发送字节；远端输出滚动、搜索、选中复制保持正常；解除只读后立即恢复输入。

---

## 四、Phase 2（M2）：盘活 Shell Integration 与运维核心能力

### WP 2.1 命令块 UI（Command Blocks）与长耗时命令完成通知

- **目标**：将后端[终端 Broker](../../src-tauri/src/terminal_broker.rs)与[Shell 集成模块](../../src-tauri/src/terminal_integration.rs)已采集的 `OSC 133`、命令起止边界、退出码与当前目录转化为面向用户的交互体验。
- **涉及文件**：
  - [终端 Broker](../../src-tauri/src/terminal_broker.rs)、[终端会话协议契约](../../protocol/agent/runtime/terminal-protocol-rfc.md)
  - 新增 `src/lib/terminal/terminal-command-blocks.ts`、`src/components/terminal/terminal-command-block-overlay.tsx`
  - [终端窗格](../../src/components/terminal/terminal-pane.tsx)、[终端标签栏](../../src/components/terminal/terminal-tab-bar.tsx)、[应用全局 Store](../../src/stores/appStore.ts)、[设置面板](../../src/components/workbench/settings-panel.tsx)、[快捷键工具](../../src/lib/shortcuts.ts)、[IPC 适配层](../../src/lib/ipc/tauri.ts)
- **具体方案**：
  1. **后端生命周期事件**：
     - 在 `terminal_broker.rs` 处理 `CommandStart` / `CommandEnd { exit_code, cwd }` 时记录单调 `command_id` 与时间戳，通过新事件 `terminal-command-lifecycle` 向前端推送 `{ sessionId, commandId, phase: 'running' | 'completed', exitCode?, durationMs?, cwd?, startedAt }`（仅结构化元数据，不广播输入明文）。
  2. **独立覆盖层 UI（严格避开边界门禁）**：
     - `terminal-command-blocks.ts` 仅监听公开 `terminal.parser.registerOscHandler(133, ...)`（`A`/`C`/`D` 边界）与 `terminal-command-lifecycle`，用 xterm `IMarker` 记录每条命令的 Prompt 起始行、命令结束/输出起始行、输出结束行（设上限如最近 500 块，超限释放旧 Marker）。
     - `terminal-command-block-overlay.tsx` 挂载在 `TerminalPane` 层（不进入 `terminal-command-*` 检查目录）：
       - 左侧 Gutter 展示状态圆点（运行中动画 / `0` 成功 / 非零失败）与 Hover 耗时气泡；
       - Hover 或聚焦当前块时显示轻量悬浮操作：**复制命令输出**（经公开 `buffer.active.getLine(i).translateToString(true)` 拼接）、**AI 诊断**（非零退出码高亮，点击将命令输出 + 退出码 + CWD 带入 AI 助手草稿或直接触发分析）；
       - 增加快捷键「跳转到上一条 / 下一条命令 Prompt」（基于 `IMarker.line` 滚动视口）。
  3. **长耗时命令完成通知与后台提示**：
     - 复用 [Cargo 配置](../../src-tauri/Cargo.toml)中已引入的 `tauri-plugin-notification`。
     - 新增偏好 `terminalCommandNotificationThresholdSec`（默认 `10` 秒，支持关闭）：当某个会话命令完成且耗时达到阈值（或退出码非零），并且**该标签非当前活跃可见标签或应用窗口处于失焦状态**时，发送桌面系统通知并在标签页展示完成/出错状态未读点（切回该标签自动清除）。
- **验证要点**：
  - Rust 单元测试验证 `terminal-command-lifecycle` 耗时计算与退出码传递；前端单测覆盖 Marker 随缓冲裁剪/Reflow 清理、输出复制准确性与通知触发条件。
  - **必跑门禁**：确认 `pnpm check:terminal:boundary` 零违规通过。

### WP 2.2 多窗格广播输入（Broadcast Input）

- **目标**：支持在多台主机分屏巡检时同步输入命令到多个终端会话。
- **涉及文件**：
  - 新增 `src/stores/terminalBroadcastStore.ts`
  - [终端注册表](../../src/components/terminal/registry/terminal-registry.ts)、[终端窗格](../../src/components/terminal/terminal-pane.tsx)、[终端工作区容器](../../src/components/terminal/index.tsx)、[终端标签栏](../../src/components/terminal/terminal-tab-bar.tsx)、[命令面板](../../src/components/command-palette.tsx)
- **具体方案**：
  - `terminalBroadcastStore.ts` 维护广播状态：`mode: 'off' | 'splitGroup' | 'custom'` 及目标 `sessionIds: Set<string>`；订阅 `terminalStore` 自动移除已关闭/断开的会话，目标不足 2 个时提示或自动退回 `off`。
  - 在 `TerminalController.writeUserInput` 与 `writeUserBinaryInput` 出口接入广播路由器（注意：**只广播用户主动输入**，Agent 写入路径 `writeInput` 与本地事件回显不参与广播）。
  - 分发时逐一检查目标会话状态，硬跳过：`readOnly === true`、`status !== 'connected'`、`terminalInputReadiness.isPreparing(id)` 或 `agentTerminalLeaseState.blocksUserInput(id)`。
  - 开启广播时在 `Terminal` 工作区顶部显示高对比度警示横幅（显示「正在广播至 N 个终端 / 已跳过 M 个受保护终端」及一键停止按钮），并在标签页显示广播徽标。
- **验证要点**：
  - 单测覆盖：广播同时写入多个目标、自动跳过只读/未连接/Agent 占用会话、Agent 写入不触发广播、会话关闭后自动清理目标集合。

### WP 2.3 会话输出导出、实时日志落盘与录制

- **目标**：满足排障留痕、审计合规与演示回放需求。
- **涉及文件**：
  - 新增 `src-tauri/src/terminal_recorder.rs`
  - [Rust 入口](../../src-tauri/src/lib.rs)、[命令处理](../../src-tauri/src/commands.rs)、[会话工作线程](../../src-tauri/src/session.rs)、[内容脱敏](../../src-tauri/src/redaction.rs)
  - [IPC 适配层](../../src/lib/ipc/tauri.ts)、[终端内容右键菜单](../../src/components/terminal/terminal-content-menu.tsx)、[终端标签栏](../../src/components/terminal/terminal-tab-bar.tsx)
- **具体方案**：
  1. **当前缓冲即时导出**：
     - 在终端内容右键菜单新增「导出终端输出…」，支持选择「纯文本（`.txt`）」或「保留 ANSI 转义序列（`.ansi`）」，前端读取公开缓冲内容（或复用 `@xterm/addon-serialize`）经后端 `rfd` 保存对话框写盘。
  2. **后端实时日志 & asciinema (`.cast`) 录制**：
     - `terminal_recorder.rs` 实现会话级录制器管理器，支持 `plain-log`（实时文本日志）与 `asciinema-v2`（`.cast` JSON Header + `[elapsed, "o", data]` 帧，支持记录窗口尺寸变更 `"r"` 帧）。
     - PTY 输出扇出通过有界异步通道（`mpsc::sync_channel` / `try_send`）投递给后台写入线程：通道满时递增丢帧计数而不阻塞 SSH/本地 PTY 主循环；所有落盘字符串经过 `redaction.rs` 脱敏。
     - 新增 Tauri commands：`export_terminal_buffer`、`start_terminal_recording`、`stop_terminal_recording`、`get_terminal_recording_status`，同步注册到 `lib.rs` 并封装到 `src/lib/ipc/tauri.ts`；标签页在录制期间显示红色录制状态点，停止时提供打开所在目录快捷操作。
- **验证要点**：
  - Rust 单测验证 `.cast` v2 Header 与事件帧 JSONL 格式合法性、敏感凭据脱敏生效、通道阻塞时 `try_send` 不卡死 PTY、关闭会话自动 flush 并安全结束录制文件。

### WP 2.4 全局参数化命令片段库（Global Snippets）

- **目标**：补齐跨主机复用的模板化命令库（与当前仅绑定单主机的[主机快捷动作](../../src/components/workbench/host-quick-actions-dialog.tsx)形成互补）。
- **涉及文件**：
  - [数据库模块](../../src-tauri/src/db.rs)、[模型定义](../../src-tauri/src/models.rs)、[命令处理](../../src-tauri/src/commands.rs)、[Rust 入口](../../src-tauri/src/lib.rs)
  - 新增 `src/lib/terminal/snippet-template.ts`、`src/stores/snippetStore.ts`、片段管理及参数填写 UI 组件
  - [命令面板](../../src/components/command-palette.tsx)、[IPC 适配层](../../src/lib/ipc/tauri.ts)
- **具体方案**：
  1. **数据库与 CRUD**：`db.rs` 升级至 schema v6，新增 `command_snippets` 表（`id`、`name`、`group_name`、`tags_json`、`command_template`、`description`、`created_at`、`updated_at`），暴露列表/新增/更新/删除 Tauri commands。
  2. **参数模板解析与安全填入**：
     - `snippet-template.ts` 解析 `{{var}}` 与 `{{var:default}}` 变量列表，校验变量名合法性并对模板及填充结果过滤控制字符（`\r` / `\n` / ASCII 控制码）。
     - 在工作台增加 Snippets 管理视图，并在终端内通过快捷键或命令面板快速检索；含参数片段弹出填参 `CompactDialog`（默认「插入到命令行」，仅在用户显式点击「插入并执行」时追加换行）。
- **验证要点**：
  - 模板解析与嵌套/默认值/控制字符拦截单测；SQLite v6 建表与 CRUD 集成测试；填参 Dialog 焦点与表单校验单测。

### WP 2.5 SSH 传输层核心扩展：动态 SOCKS5 转发、SSH Agent 与 2FA

1. **动态端口转发（SOCKS5 / `-D`）**
   - **涉及文件**：[模型定义](../../src-tauri/src/models.rs)、[端口转发引擎](../../src-tauri/src/port_forward.rs)、[前端类型](../../src/types/index.ts)、[端口转发弹框](../../src/components/workbench/port-forward-dialog.tsx)
   - **具体方案**：
     - `PortForwardKind` 增加 `Dynamic`（前端 `'dynamic'`）。
     - `port_forward.rs` 在遇到 `Dynamic` 规则时，监听本地端口并按 RFC 1928 完成 SOCKS5 握手（仅开放无认证 `0x00`，解析 `CONNECT` 目标支持 IPv4 / 域名 / IPv6），校验目标合法性后通过现有 `session.channel_direct_tcpip` 建立远端隧道，沿用当前非阻塞转发循环、`bytes_sent`/`bytes_received` 统计与 `CancellationToken` 生命周期。
     - `port-forward-dialog.tsx` 选中「动态代理（SOCKS5）」时隐藏远端主机/端口输入框，仅需配置本地监听端口。
2. **本机 SSH Agent 认证**
   - **涉及文件**：[数据库模块](../../src-tauri/src/db.rs)、[连接与预检](../../src-tauri/src/connection.rs)、[连接表单抽屉](../../src/components/workbench/connection-form-drawer.tsx)、[模型定义](../../src-tauri/src/models.rs)、[前端类型](../../src/types/index.ts)
   - **具体方案**：
     - `db.rs` 在 v6 迁移中将 `profiles.auth_method` 约束扩展为 `('password', 'key', 'agent', 'keyboardInteractive')`，重建 `profiles` 表时严格重建 `revoke_sudo_policy_on_profile_identity_change` 触发器。
     - `connection.rs` 在 `AuthMethod::Agent` 分支调用 `session.agent()`：连接本机 SSH Agent（兼容 macOS `SSH_AUTH_SOCK`、1Password SSH Agent、YubiKey/FIDO2 与 Windows OpenSSH Agent 命名管道）、枚举公钥并逐个尝试 `agent.userauth(username, &identity)`，同步适配连接预检（Preflight）。
3. **Keyboard-Interactive / 2FA（OTP / MFA）**
   - **涉及文件**：[连接与预检](../../src-tauri/src/connection.rs)、[命令处理](../../src-tauri/src/commands.rs)、[Rust 入口](../../src-tauri/src/lib.rs)、[连接表单抽屉](../../src/components/workbench/connection-form-drawer.tsx)、[会话连接 Hook](../../src/hooks/useConnectSession.ts)、新增交互认证弹框组件
   - **具体方案**：
     - `connection.rs` 实现 `ssh2::KeyboardInteractivePrompt` 回调：收到服务端质询列表（`prompts` 含 `text` 与 `echo` 标志）后，按 `operationId` 注册 `oneshot` 通道并向前端发送交互认证请求事件；前端弹框依据 `echo` 控制输入明文/密文，提交或取消后通过 Tauri command 回传结果（支持超时与连接取消联动清理，输入缓冲用后 `zeroize` 擦除）。
- **验证要点**：
  - SOCKS5 握手解码与异常包拒绝单测；SQLite v5 → v6 迁移及 `profile_sudo_policy` 触发器保留单测；Agent 枚举与 Keyboard-Interactive 取消/超时/多轮质询状态机测试。

---

## 五、Phase 3（M3）：高阶运维与深度生态（模块化选做）

M1 与 M2 稳定交付后，以下模块相互正交，可根据用户优先级按需立项：

| 工作包 | 核心内容 | 主要涉及位置与实现关键点 |
| :--- | :--- | :--- |
| **WP 3.1 本地多 Shell Profile** | 自动发现 Windows（WSL 发行版、Git Bash、CMD、PowerShell 7）与 macOS/Linux（zsh / bash / fish / nushell）；支持自定义 Shell 路径、启动参数、环境变量与初始目录 | 扩展 [命令处理](../../src-tauri/src/commands.rs) 中的 `get_local_terminal_options` 与 `create_local_session`，以及[新建会话弹框](../../src/components/terminal/new-session-dialog.tsx) |
| **WP 3.2 输出高亮、触发器与连接高级参数** | 按正则对实时输出着色（`ERROR`/`WARN`/IP/HTTP 5xx）及匹配通知触发器；按连接 Profile 绑定独立配色/环境警戒条（防误操作生产节点）、自定义 Keepalive 间隔、SSH 压缩、Startup Command、多跳跳板机与 HTTP/SOCKS 上游代理 | 需保证高亮匹配在高吞吐 `cat` 日志下不拖慢渲染；上游代理可在[连接模块](../../src-tauri/src/connection.rs)抽象传输流 |
| **WP 3.3 终端行内 AI 命令栏（`Cmd/Ctrl+I`）** | 在光标附近唤起轻量浮层，输入自然语言后复用[LLM 路由配置](../../src/stores/llmRoutesStore.ts)流式生成单条命令，审阅后一键填入当前命令行（默认不自动回车） | 与现有右侧 Agent 面板互补，零额外配置门槛 |
| **WP 3.4 渲染与现代协议进阶** | 将 `@xterm/addon-webgl` 从 [package.json](../../package.json) 的 `devDependencies` 提升为可选运行时开关（补齐 resize 过渡防闪屏）；接入 `@xterm/addon-image` 支持 Sixel / iTerm2 内联图片；支持 Kitty Keyboard Protocol / `modifyOtherKeys` 与按连接配置字符编码（GBK / GB18030） | 需在 macOS WKWebView 与 Windows WebView2 上重点验证 WebGL 上下文回收与中文输入法兼容性 |
| **WP 3.5 容器与串口终端** | 本地/远端 `docker exec` / `kubectl exec` 快捷会话入口；网络设备/嵌入式调试串口（Serial）会话 | 视产品边界决定；串口需评估引入独立传输后端并接入 `terminal_broker` 抽象 |

---

## 六、统一验证与发布门禁

每个工作包合并前必须按影响范围通过仓库自动化门禁，参见[仓库工作约定](../../AGENTS.md)与[测试指南](../testing.md)：

```bash
# 1. 前端边界检查（AST）、单元测试与 TypeScript/Vite 构建
pnpm review:frontend

# 2. AI 面板样式边界检查（涉及 UI 样式调整时）
pnpm check:ai-styles

# 3. Rust 单元测试、代码格式与内嵌脚本换行符检查（涉及后端改动时）
cargo test --manifest-path src-tauri/Cargo.toml
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
pnpm check:rust:includes
```

### UI 与安全人工回归清单

1. **双语一致性**：确认 `src/locales/zh-CN.ts` 与 `src/locales/en-US.ts` 键集合完全一致，Select / 提示条 / 通知中不暴露内部 ID 或原始枚举值。
2. **窄容器与响应式检查**：在桌面常规宽度与打开 AI 侧栏压窄终端容器后，验证标签栏、搜索浮动条、广播警示横幅、命令块浮层与各配置弹框无遮挡、无纵向/横向溢出及高度跳动。
3. **焦点与快捷键**：验证 Leader 键、`Mod+=/-`/`0`、搜索栏 `Escape` 退出后焦点准确回到 xterm `textarea`；只读锁与广播状态下不突破 Agent 租约门禁。
4. **安全复核**：验证 OSC 52 拒绝读取查询、命令片段默认不自动执行、录制/日志脱敏生效、2FA 回答不进入日志或持久化存储。

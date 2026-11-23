# ShellSpan Agent 沙箱可用化设计方案

> 关联基线：[Agent 沙箱实施计划](./agent-sandbox-adoption.md) · [终端与 Agent 协议](../../protocol/agent/runtime/terminal-protocol-rfc.md)

## 1. 背景与目标

当前仓库中的 Agent 沙箱能力处于“分平台不均衡”状态：

| 方向 | 当前状态 | 主要阻塞 |
| --- | --- | --- |
| **SSH 远端沙箱（Bubblewrap）** | 已可用 | 仅受全局开关 `ai.agentSandboxEnabled` 联动影响，无功能性阻塞 |
| **Windows 本地沙箱（AppContainer）** | 框架已通 | 工具集过窄、无基础工具链 PATH、缺少 Job 资源上限、孤立工作区与临时目录清理不完整 |
| **macOS 本地沙箱（`nono`）** | 仅验收包可用 | 被 `native-input-acceptance + debug_assertions + aarch64` 锁死；启动器未随正式包构建；仅支持单个固定测试目录 |
| **已有项目目录接入** | 未实现 | 本地沙箱仅支持新建的空受管工作区，无法处理用户现有代码仓库 |
| **远端可见终端（OpenSandbox PTY）** | 未启动 | 独立执行面，不纳入本期范围 |

本文档定义**让 Agent 沙箱在桌面正式版真正可用**的分阶段设计，拆分为三个可独立交付的里程碑：

- **M1（转正跑通）**：将 macOS `nono` 本地沙箱从验收构建转正为正式能力，补齐前端平台感知与清晰的状态提示。
- **M2（实用与加固）**：补齐基础工具链、内置文件工具边界接入、Windows 资源上限与残留清理，使沙箱能稳定完成日常任务。
- **M3（真实项目接入）**：支持在沙箱中处理用户已有本地项目，并安全回写变更。

### 非目标

- 本期不实现 OpenSandbox 远端可见终端（阶段三单独立项）。
- 本期不开放 Linux 桌面本地沙箱正式入口（仅保留容器测试证据）。
- 本期不引入细粒度可编辑网络白名单；本地沙箱维持默认阻断出站网络。

---

## 2. 总体架构与平台矩阵

### 2.1 平台能力矩阵（目标态）

| 平台 / 目标 | 沙箱后端 | `localSandboxRequired` | 隔离机制 | 写范围 | 网络 |
| --- | --- | --- | --- | --- | --- |
| macOS 本地 | `nono` 随包启动器 | `macNono` | Seatbelt（`nono`）+ 受管父目录标志锁 + 独立进程组 | 会话受管工作区 + 私有临时目录 | 默认阻断 |
| Windows 本地 | 原生 AppContainer | `windowsAppContainer` | 无能力 AppContainer Token + ACL + Job Object | 会话受管工作区 + 私有临时目录 | 默认阻断 |
| SSH 远端 | 远端 Bubblewrap | —（`remoteSandboxRequired: true`） | `bwrap` 命名空间隔离 + 沙箱 SFTP | 连接配置的工作区（只读或可写） | 默认阻断 |
| 其他本地平台 | 无 | `None` | — | — | — |

### 2.2 核心不变量（延续既有协议）

1. **Fail-close**：会话一旦绑定 `localSandboxRequired` 或 `remoteSandboxRequired`，关闭全局开关、启动器校验失败、工作区身份变化或切换至非 Direct 执行面时，必须在派发前拒绝，不得回退到普通执行。
2. **审批与派发一致性**：能力凭据绑定执行面、沙箱后端、工作区身份摘要与策略版本；最终派发前二次复核开关与工作区身份。
3. **可信启动证据**：继续区分“启动前拒绝 / 启动器失败（`started = false`）”与“命令已启动后的非零退出（`started = true`）”；进程崩溃后未结算调用进入 `executionInFlight` 恢复态，禁止自动重跑。
4. **本地删除走回收站**：回收会话受管工作区时沿用项目回收站实现，避免不可恢复的直接删除。

---

## 3. 里程碑一（M1）：macOS `MacNono` 正式版转正

### 3.1 启动器正式构建与打包

当前启动器位于 [scripts/agent-sandbox/Cargo.toml](../../scripts/agent-sandbox/Cargo.toml)（二进制名 `shellspan-sandbox-probe`，依赖锁定 `nono = "=0.82.0"`），仅由 `build-mac-sandbox-preview.mjs` 在预览打包时编译并注入 `SHELLSPAN_MAC_SANDBOX_LAUNCHER_SHA256`。

**设计方案**：

1. **升级为正式随包可执行文件**
   - 将启动器 crate 移入正式源码目录（如 `src-tauri/sandbox-launcher/` 或作为 `src-tauri` workspace 成员），重命名产物为 `shellspan-sandbox-launcher`，保持最小依赖集合（`libc` + 锁定版本的 `nono`）。
   - 在 macOS 构建阶段（`pnpm native:prepare` 或新增 `pnpm sandbox:prepare`）按目标架构构建 release 二进制（支持 `aarch64-apple-darwin` 与 `x86_64-apple-darwin`），输出至 `src-tauri/target/native-input/generated/sandbox/`（测试验收通过 `SHELLSPAN_NATIVE_BUILD_ROOT=artifacts/tests` 隔离）。
   - 通过 `src-tauri/tauri.conf.json` 的 `bundle.resources` 随 macOS 应用打包至 `Contents/Resources/sandbox/shellspan-sandbox-launcher`，确保被 `codesign --deep` 统一签名。
2. **启动器完整性校验**
   - 构建 `src-tauri` 时，通过 `build.rs` 计算或读取已生成启动器的 SHA-256 注入编译期常量；开发模式下若未启用正式签名，仍通过 `O_NOFOLLOW` 打开常规文件并校验 SHA-256 + 属主/权限位（非 group/world writable）。
   - 若启动器缺失、非普通文件、权限异常或摘要不匹配，返回 `LOCAL_SANDBOX_LAUNCHER_UNAVAILABLE` / `LOCAL_SANDBOX_LAUNCHER_CHANGED` 并拒绝派发。

### 3.2 按会话独立的受管工作区与目录保护

当前 `mac_sandbox_workspace.rs` 与 `mac_sandbox_acceptance.rs` 绑定单一目录（`$HOME/.shellspan-agent-sandbox-preview-*/home` 或 `/private/tmp/ss-sandbox-desktop-*/home`），不支持多会话并发隔离与生命周期回收。

**目录布局设计**：

```text
<shellspan_data_dir>/mac-agent-workspaces/
  <session_hash_32>/                  # 受管锚点目录（加锁保护层）
    workspace/                        # 挂载给沙箱的可写工作区（会话 cwd / local_root）
    temporary/                        # 每次命令执行创建独立子目录作为 TMPDIR
    managed-directory-guard.json      # 崩溃恢复日志（锚点 dev/ino、phase、pgid、boot_time）
    .identity                         # 宿主只读摘要文件（不在沙箱可写范围内）
```

> 注：macOS BSD 文件标志锁（`UF_IMMUTABLE`）要求 `<shellspan_data_dir>` 到 `<session_hash_32>` 之间的受管父目录由当前用户拥有且无符号链接替换风险。若应用数据目录位于 `$HOME/Library/Application Support/...`，需沿用 `validate_anchor_path` 的祖先检查并在创建锚点时验证属主与非符号链接。

**生命周期**：

1. **创建**：在 `apply_connection_sandbox`（[commands.rs](../../src-tauri/src/agent_runtime/commands.rs)）中，macOS 且 `ai.agentSandboxEnabled == true` 且为本地非 `workbench-ai` 会话时，自动设置 `target.local_sandbox_required = Some(LocalSandboxKind::MacNono)`，创建会话专属目录，写入 `.identity`，冻结 `target.cwd` 与 `target.local_root`。
2. **执行期加锁**：每次 `exec_command` 派发前通过 `Lease::acquire` 校验锚点身份与 `.identity`，写入 `Phase::Prepared` 并锁定锚点目录；收到子进程 pgid 后记录 `Phase::Running { group, boot_time }`，再通过 gate fd 放行启动器执行目标命令。
3. **启动崩溃恢复**：应用启动时（[lib.rs](../../src-tauri/src/lib.rs)），扫描 `<shellspan_data_dir>/mac-agent-workspaces/` 下所有含 `managed-directory-guard.json` 的目录并调用 `recover_on_startup`，进程组已退出或 `boot_time` 变化时自动解锁，仍在运行时保持锁定。
4. **回收**：删除已归档会话时（[runtime.rs](../../src-tauri/src/agent_runtime/runtime.rs) `delete_session`），先确认无活跃锁、解锁后将 `<session_hash_32>` 移入系统回收站；若会话创建在建目录之后失败，立即回滚清理。

### 3.3 后端运行时接线与测试分支清理

需要修改的核心模块：

- [src-tauri/src/agent_runtime/native/mod.rs](../../src-tauri/src/agent_runtime/native/mod.rs)：将 `mac_sandbox_workspace` 与新的 `mac_sandbox` 模块的编译条件改为 `#[cfg(target_os = "macos")]`，不再依赖 `native-input-acceptance` 与 `debug_assertions`。
- [src-tauri/src/agent_runtime/commands.rs](../../src-tauri/src/agent_runtime/commands.rs)：
  - 在 `apply_connection_sandbox` 中为 `#[cfg(target_os = "macos")]` 增加 `LocalSandboxKind::MacNono` 的自动选择、工作区创建与 `capability_scope` 绑定（与 `WindowsAppContainer` 对称）。
  - 非 macOS 平台遇到 `MacNono` 继续 fail-close 返回 `LOCAL_SANDBOX_UNAVAILABLE`。
- [src-tauri/src/agent_runtime/native_adapter.rs](../../src-tauri/src/agent_runtime/native_adapter.rs)：允许 `LocalSandboxKind::MacNono` 在 macOS 上通过准备与二次校验，校验 `Direct` 执行面、禁止未受控参数（`background`、`handoffToUser`、`sudoOperationId`）。
- [src-tauri/src/agent_runtime/native/process.rs](../../src-tauri/src/agent_runtime/native/process.rs) 与 `runtime/command_exec.rs`：
  - 将 `LocalSandboxBackend` trait 统一用于 `MacNono` 与 `WindowsAppContainer`。
  - 清理 `process.rs` 中 `if super::mac_sandbox_automated() && command.starts_with("printf init > init-")` 这类验收硬编码分支（改由集成测试通过显式测试夹具注入）。
  - 执行结果 `sandbox` 字段从 `"nonoMacAcceptance"` 规范为 `"macNono"`（保留对历史会话记录的兼容反序列化）。

### 3.4 前端与设置页对齐

1. **平台支持判定**
   - 新增 Tauri 能力查询（或在现有本地沙箱探测 IPC 中返回结构化状态 `{ supported: boolean, kind?: 'macNono' | 'windowsAppContainer', reason?: string }`），前端不再仅靠 `platform === 'windows'` 硬编码猜测。
   - [useTerminalAgentExecution.ts](../../src/hooks/useTerminalAgentExecution.ts) 根据后端能力与 `agentSandboxEnabled` 统一计算 `localSandbox` 与 `localSandboxKind`，创建会话时传入 `localSandboxRequired`。
2. **设置页与错误文案**
   - [ai-settings-section.tsx](../../src/components/ai/ai-settings-section.tsx) 在「Agent 沙箱（实验性）」说明中明确展示当前平台本地沙箱状态（例如：已支持 macOS / Windows；若运行在不支持本地沙箱的平台，明确提示“当前系统暂不支持本地沙箱，开关仅对已配置的 SSH 沙箱生效”）。
   - 同步更新 [zh-CN.ts](../../src/locales/zh-CN.ts) 与 [en-US.ts](../../src/locales/en-US.ts)，保持键集合一致。
   - 当全局开关关闭但某 SSH 连接已配置 Bubblewrap 时，在阻断提示中直接给出“前往设置开启 Agent 沙箱或关闭该连接的远端沙箱”的可操作指引。

---

## 4. 里程碑二（M2）：实用性与稳定性补齐（macOS + Windows）

### 4.1 受控只读工具链 `PATH`

当前 macOS 写死 `PATH=/usr/bin:/bin`，Windows 写死 `PATH=%SystemRoot%\System32`，导致 `git`、`node`、`python`、`rg` 等日常开发命令无法直接调用。

**设计方案**：

1. **分层默认只读路径**
   - **macOS**：保留 `/usr/bin:/bin` 基础路径，探测宿主机常见只读工具目录（`/opt/homebrew/bin`、`/usr/local/bin`、Xcode Command Line Tools 路径），仅对实际存在且非用户可随意劫持（或经策略明确允许）的目录赋予只读权限并拼入 `PATH`。
   - **Windows**：保留 `%SystemRoot%\System32` 与 Windows PowerShell，支持只读放行系统级已安装工具目录（如 `Program Files\Git\cmd`、`Program Files\nodejs` 等，前提是目录 ACL 允许 AppContainer SID 只读执行；不自动修改系统目录 ACL）。
2. **策略显式记录**
   - 生效的只读路径集合纳入策略版本与摘要计算，变更后要求新会话或重新授权。
   - 写权限严格保持在 `workspace` 与 `temporary` 之内，绝不扩展到工具链目录。

### 4.2 内置结构化文件工具接入沙箱边界

当前 Windows 沙箱会话的 `capability_scope` 仅放行 `run_terminal_command`、`ask_user_question`、`read_tool_result`，Agent 读写代码被迫全部拼接 shell 命令，效率低且容易出错。

**设计方案**：

1. **复用并加固宿主侧路径边界校验**
   - 将受管工作区根目录作为内置文件工具（只读列表/读取/搜索，以及工作区内写入/编辑）的唯一允许根。
   - 所有文件操作在 Rust 侧执行前：
     - 拒绝绝对路径逃逸、符号链接穿透（逐级 `O_NOFOLLOW` 或规范化后校验前缀与工作区根目录 `(dev, ino)` / Windows File Index 一致）；
     - 写入前复核 `ai.agentSandboxEnabled` 与工作区身份摘要，与 `exec_command` 保持一致的 fail-close 语义。
2. **能力范围清晰展示**
   - 在 `capability_scope` 中放行已通过沙箱边界校验的文件工具。
   - HTTP 探测、MCP 工具、提权（`sudo`）、后台常驻进程（`background: true`）在未纳入同一隔离边界前，继续在工具注册/派发阶段显式拒绝，并在模型提示词与 UI 中说明原因。

### 4.3 Windows AppContainer 稳定性与清理加固

针对 [windows_sandbox.rs](../../src-tauri/src/agent_runtime/native/windows_sandbox.rs) 当前发现的问题：

1. **Job Object 资源上限**
   - 在 `JOBOBJECT_EXTENDED_LIMIT_INFORMATION` 中补充：
     - `JOB_OBJECT_LIMIT_ACTIVE_PROCESS`（如默认上限 64 个活跃进程，防 fork 炸弹）；
     - `JOB_OBJECT_LIMIT_JOB_MEMORY`（如默认上限 2 GiB 或按物理内存比例封顶，防 OOM 拖垮宿主机）。
   - 保留 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`。
2. **私有临时目录移出可见工作区**
   - 将每次命令创建的 `.shellspan-tmp-*` 从 `workspace/` 内部移至同级宿主目录 `<data>/windows-agent-workspaces/<hash>.tmp/`（创建时赋予相同 AppContainer SID 的可写 ACL），避免进程异常退出后在用户工作区内残留 `.shellspan-tmp-*` 杂项目录；每次执行结束及应用启动时清理该临时目录。
3. **孤立工作区与 AppContainer Profile 回收**
   - 创建会话中途失败时，立即调用 `remove_workspace` 回滚已建目录与 Profile。
   - 应用启动时执行一次后台低优先级对账：对比 `windows-agent-workspaces/` 下的目录与会话数据库中的活跃/归档会话；对无对应会话记录且无活跃句柄的孤立目录执行回收并调用 `DeleteAppContainerProfile`；回收失败记录告警并在下次启动重试。

---

## 5. 里程碑三（M3）：支持处理用户已有本地项目

### 5.1 方案对比

| 维度 | 方案 A：导入受管工作区 + Diff 回写（推荐） | 方案 B：原地挂载用户目录 |
| --- | --- | --- |
| **安全边界** | 完全保留受管父目录防替换锁与 AppContainer 专属 ACL，不修改用户目录权限 | macOS 无法对任意用户父目录无副作用加锁；Windows 需改写用户目录 ACL，风险高且清理困难 |
| **变更可控性** | 天然支持“沙箱内执行 → 审查 Diff → 确认回写或一键丢弃” | 命令直接修改原目录，误操作恢复成本高 |
| **实现复杂度** | 中（Git 仓库可用 worktree / clone，普通目录可用受限拷贝 + 忽略规则） | 高（平台特例多、符号链接与权限回滚极易出问题） |
| **大仓库开销** | 需处理 `node_modules` / `target` / `.git` 过滤或硬链接优化 | 零拷贝 |

### 5.2 推荐设计（方案 A 优先）

1. **工作区绑定模式**
   - 新建本地沙箱会话时，支持两种来源：
     - **空白受管工作区**（默认，M1 已有）；
     - **从本地目录导入**：用户选择目标项目目录（记为 `sourceRoot`，持久化在会话元数据中）。
2. **导入机制**
   - 若 `sourceRoot` 为 Git 仓库：在受管工作区创建隔离的副本/浅拷贝（不共享宿主机 `.git/hooks` 执行权限，且阻断沙箱修改宿主 `.git` 对象库），记录基准 commit/树快照。
   - 若为普通目录：按默认忽略规则（跳过 `.git` 内部敏感钩子、体积过大的构建产物或由用户确认）复制进入受管 `workspace/`，记录文件清单与哈希基线。
3. **审查与回写**
   - Agent 在沙箱 `workspace/` 中完成修改与测试后，用户可在工作区面板查看相对于基线的 Diff 列表。
   - 用户点击“应用到原目录”时，由 Rust 宿主侧执行冲突检查（对比原目录当前哈希与导入基线，存在外部修改时提示冲突）后按文件回写；删除操作走回收站。
   - 丢弃或删除会话时，直接回收受管工作区，原项目零污染。

---

## 6. 协议变更、测试与验收计划

### 6.1 协议与文档同步

- 更新 [protocol/agent/runtime/terminal-protocol-rfc.md](../../protocol/agent/runtime/terminal-protocol-rfc.md)：新增 `macOS nono for Direct Agent Commands` 章节，明确 `localSandboxRequired: "macNono"`、`sandbox: "macNono"`、目录保护恢复及与 Windows AppContainer 的对齐语义。
- 在 [agent-sandbox-adoption.md](./agent-sandbox-adoption.md) 中关联本文档并更新阶段二落地状态。

### 6.2 验证清单

| 里程碑 | 自动化测试 | 真机 / 打包验收 |
| --- | --- | --- |
| **M1** | `cargo test` 覆盖 `mac_sandbox_workspace`、`MacNono` 会话创建/拒绝/恢复、`commands` 与 `native_adapter`；前端单测覆盖 `useTerminalAgentExecution` 与设置页提示 | 构建正式签名 macOS `.app` 包，验收：开开关新建会话自动进 `MacNono`、关开关拦截已批准调用、工作区内写/外拒、断网、取消/超时杀进程组、强杀应用重启恢复锁、删会话回收目录 |
| **M2** | Rust 单测覆盖受控 `PATH` 解析、内置文件工具路径逃逸/符号链接拦截、Windows Job 进程数/内存限制、孤立工作区与临时目录清理 | macOS 与 Windows 真机验收：Agent 在沙箱内使用内置文件工具读写文件并运行 `git`/`node` 等只读工具链命令；验证 fork 炸弹被 Job 拦截 |
| **M3** | Rust 单测覆盖目录导入、基线快照、冲突检测与安全回写 | 真实本地仓库端到端验收：导入 → 沙箱修改与测试 → 审查 Diff → 回写原仓库（及冲突拦截与丢弃） |
| **回归** | `pnpm test`、`pnpm build`、`pnpm review:frontend`、`cargo fmt -- --check`、`pnpm check:rust:includes` | SSH Bubblewrap 执行器测试脚本回归，确认无破坏 |

---

## 7. 推荐实施节奏

1. **第一步（M1）**：先完成 `nono` 启动器正式打包 + `MacNono` 按会话受管工作区 + 前后端接线与设置页提示。完成后 macOS 与 Windows 在正式版中均达到“打开开关即可用”。
2. **第二步（M2）**：并行推进只读工具链 `PATH`、内置文件工具接入与 Windows Job 限制/孤立清理。完成后沙箱可稳定承担日常代码与排障任务。
3. **第三步（M3）**：落地“导入受管工作区 + Diff 回写”，打通真实本地项目场景。

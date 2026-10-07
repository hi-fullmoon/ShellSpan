# Agent Shell 沙箱阶段 0 验收

验收日期：2026-10-05（Asia/Shanghai）。状态：研究与部分真实验证已完成，阶段 0 门禁未通过。生产入口、UI、审批与协议未修改。不能将本报告或实验成功解释为生产沙箱已启用。

## 1. 基线与范围

开始时 `git status --short` 仅有未跟踪的 `docs/design/agent-shell-sandbox-implementation-plan.md`，保留其内容并按证据更新阶段 0。实验使用临时目录、真实系统进程和真实监听 socket；敏感读取实验使用专门创建的非凭据标记文件，不接触用户私钥、钥匙串或真实 token。标记是被测文件内容，不是模拟执行后端。

宿主为 macOS 26.7.1 / 25G241、arm64、Darwin 25.6.0；Node 24.21.0，Rust toolchain 1.95.0。Docker Desktop 原先未运行，经本地启动后可用，Server 29.8.0，Linux VM kernel 7.0.12-linuxkit。`vmrun list` 返回 0 个运行 VM；Windows 验证脚本要求 native `cargo.exe`，仓库未配置可调用的 Windows 远程测试目标。本次未连接或修改真实服务器、未安装远端组件。

## 2. 执行与绕过通道盘点

| 入口与代码 | 实际执行边界 | 必须覆盖的绕过方式 |
| --- | --- | --- |
| `agent_runtime/model_tools.rs` 的 `run_terminal_command`，`native_adapter.rs` 选择执行方式，`native/runtime.rs::execute_command` | 本地、远端 Direct 或可视终端 | 多行命令、分类后的可信 argv、不同角色不能跳过冻结策略 |
| `native/process.rs::spawn_local_process_native` | 明确传入 `Unrestricted`；`/bin/sh` / Windows PowerShell | shell、解释器、包管理器脚本、子进程均须从创建时受限 |
| `spawn_reviewed_local_process_native`、`scoped_read.rs` | 有原生只读命令契约；不等于通用系统沙箱 | 已审核 argv 与普通 Shell 需共享实际能力事实 |
| `native/terminal_execute.rs`、`terminal_interactive.rs`、`terminal_lease.rs`、`terminal_broker.rs`、`session.rs` | 已有 PTY 和账户权限；lease 负责排他操作 | `write_terminal_input` + Enter、嵌套 shell、已有 shell 函数、启动脚本；受限会话应禁用注入 |
| `native/process.rs` 的 background、stdin、wait、kill、timeout | 本地进程组；Windows Job Object | stdin 后续可派发任意代码；Unix `setsid`/双重 fork 可逃离原进程组，不能宣称完整清理 |
| `spawn_remote_process_native`、`execution/ssh.rs` | SSH 账户上的 exec channel | 本机策略不能约束远端；远端 cwd、重连、账户变化、转发与后台进程需独立实现 |
| `agent_runtime/subagent.rs`、fleet 工具 | 角色/工具/预算约束及父授权 | 子 Agent、继续运行与 fleet 分派必须继承同一目标和不扩大的资源权限 |
| `native/filesystem.rs` 的路径解析与规范化函数 | 结构化读写、搜索、补丁、回收站自身路径契约 | 与 Shell 文件拒绝范围交叉检查；软硬链接、并发替换、原子替换不可只检查字符串 |
| `transfer_file` 与 SFTP/session 文件操作 | 连接层文件操作，不是 shell 子进程 | 上传、下载、覆盖、远端写入不能借结构化工具越界 |
| `native/http_probe.rs`、诊断 `native/diagnostics.rs` | 应用侧 HTTP/固定进程或远端诊断 | loopback probe 不受 shell 的 network deny；固定命令也需策略协调 |
| `native/mcp.rs::execute_mcp_tool_native` | stdio 独立 `Command::new`，另有 HTTP transport | server 启动环境、连接和工具副作用均不自动受 Shell 策略保护 |
| `deployment/local_artifact_executor.rs`、`node_executor.rs`、`docker_compose_executor.rs`、`host_compose.rs` | 本地 git/构建与远端部署能力 | 从 UI/原生工具触发的构建部署有独立执行链，受限 Agent 不能借此绕过 |
| `agent_runtime/skill_runtime.rs`、`file_references.rs` | 应用侧技能与文件读取 | 提示和资源不会授予权限；应用侧读取也应准确报告自己的边界 |

覆盖清单以当前 model tools 和 native dispatch 对照，Shell 统一入口不能代替非 Shell 协调器。应用本身仍有账户权限，审批是授权流程；没有内核隔离的工具只能声明自身路径契约。

## 3. 威胁模型

防御对象是误操作、第三方依赖安装/构建脚本、提示注入诱导的恶意命令。攻击者可控制完整命令、解释器脚本、项目文件、软硬链接、环境输入、子进程和背景任务；可信的项目根路径也不保证其中内容可信。需要保护项目外完整性、拒绝范围内的保密性、未授权网络目标、应用/SSH 凭据与授权生命周期。

沙箱不抵御内核或沙箱后端漏洞、不把已被管理员控制的宿主作为可信环境、不授予 sudo。外部同 UID 进程在验证后替换路径属于需要验证的竞态，不能先排除。资源耗尽、磁盘配额、CPU/内存限制不在当前文件/网络契约内，应明确 partial；向宿主 IPC 服务发送请求可能变成代理执行，不能因没有 TCP 就认定安全。已取得的敏感内容无法靠撤权追回；撤权必须停止依赖授权的进程树并阻止新派发。

## 4. 现有测试沙箱审查

`native/process.rs:484` 的 scoped launcher、`WorkspaceOnly` 枚举及各平台构造器全部在 `cfg(test)` 下。macOS 规则为默认拒绝 + `system.sb` + 全局 `allow file-read*` + 项目/临时写入 + 网络拒绝，使用 `sh -lc` 且继承环境。Linux 为 `bwrap --ro-bind / /` + 项目/临时 bind + `--unshare-net --new-session --die-with-parent`，也继承环境和登录 shell。其他平台返回 unavailable。

因此现有实现没有最小读取允许列表、敏感读取拒绝、凭据环境清理、显式工具链缓存配置、目标网络授权及完整生命周期保证。全根只读挂载暴露用户文件与宿主 socket；网络 namespace 不隔离 Unix socket。Linux 分支没有对应真实隔离回归用例。不得移除 `cfg(test)` 就发布。

## 5. 后端选择与依赖

推荐继续研究 macOS Seatbelt 与 Linux bubblewrap，但只以通过完整声明契约的平台启用。macOS 用系统 `sandbox-exec` 做有限实验；它已弃用，自定义规则不是受支持的第三方 API，发布前必须确认兼容与维护策略。[Apple DTS 说明](https://developer.apple.com/forums/thread/661939)支持该限制，不作稳定性承诺。

Linux 选择发行版 bubblewrap 配合 mount/PID/network namespace、明确文件挂载及成熟代理/必要系统调用限制。bubblewrap 是构造工具，规则决定安全性；暴露宿主 IPC socket 可绕过隔离。需要实际可用的 user namespace，不能使用 `--unshare-user-try` 静默降级。[项目说明](https://github.com/containers/bubblewrap)已阅读安全、用法与限制章节。

Windows 仅选择 AppContainer/LPAC + Job Object 为候选；Job Object 单独不提供文件/网络隔离。需成熟受维护集成、项目 ACL 与进程创建生命周期验证，不能以 restricted token 或 PowerShell 命令分类代替。[Microsoft AppContainer 说明](https://learn.microsoft.com/en-us/windows/win32/secauthz/appcontainer-isolation)正文可访问，页面外围出现授权提示；文件、网络、凭据和进程隔离章节已读取。未选择自行编写 Windows 沙箱运行器，当前 unavailable。

## 6. 可重复实验与结果

从仓库根目录执行：

```bash
python3 tests/agent-shell-sandbox-phase-0/verify_macos.py
cargo test --manifest-path src-tauri/Cargo.toml operator_workspace -- --nocapture
docker desktop status
docker info --format '{{.OSType}} {{.ServerVersion}}'
docker build -t shellspan-sandbox-phase0:local tests/agent-shell-sandbox-phase-0
python3 tests/agent-shell-sandbox-phase-0/verify_linux_unavailable.py
```

Python unittest 最终结果：10 tests，OK。注意其中缺口实验是断言缺口确实存在，测试通过不等于安全门禁通过。Rust 原有真实进程用例：3 passed，0 failed，0 ignored（根目录拒绝、项目删除与符号链接/父目录越界、loopback 网络连接）。没有运行无关前端构建；未修改应用代码。

| 实验 | 实际证据 | 结论 |
| --- | --- | --- |
| 系统运行文件 | 读取 `/usr/share/zoneinfo/UTC` 成功 | 仅证明此文件；未证明最小系统允许列表 |
| 项目、独立 temp/cache 写入 | shell 写入并由父进程读取核对 | 可行 |
| 父目录、软链接写入 | EPERM 且标记文件保持原内容 | 当前规则可阻止这两条路径 |
| 当前策略敏感读取 | 项目外标记与项目内 `.env` 均能读出 | 当前策略不满足敏感读取契约 |
| 显式 deny 的读取 | 原路径、项目 `.env`、软链接均 EPERM，stdout 为空 | deny 优先可行；仍非最小读取列表 |
| 预先存在的硬链接 | 项目内 alias 能读出被拒绝文件，写入后项目外原文件改变 | **完整性和保密性门禁失败**；单纯路径规则不足 |
| 只读项目 | 写项目 EPERM，专用 temp 可写 | 只读意图的局部实验通过 |
| IPv4、IPv6、Unix socket | 宿主监听，宿主控制连接成功，受限 Python 连接 EPERM | 真实 deny 证据，覆盖三个 socket 类型 |
| 子 shell、环境 | 子 shell 越界写入失败；仅注入列出的变量及 shell 自动生成的 PWD/SHLVL/_ | 文件限制继承与清理可行；未验证后台撤权 |
| Node/Rust | Node 实际写文件；选定已安装的真实 rustc 编译并运行断言程序 | 基础工具链可运行；不代表完整 pnpm/cargo 构建 |
| 错误策略 | 无效 profile 非零退出，执行标记文件不存在 | 实验入口没有无限制回退；生产派发仍待实现 |

清理 HOME/CARGO_HOME 后 rustup wrapper 无法自动选择工具链，验收脚本在宿主用 `rustup which rustc` 定位已安装二进制后执行。生产应显式配置工具链只读路径与独立缓存，不恢复整个 HOME 或继承 credential 环境来解决问题。实际执行脚本无 login shell。未生成仓库内临时项目，所有被测文件随 TemporaryDirectory 清理。

## 7. 支持矩阵与待满足项

| 平台/范围 | 真实环境 | 文件/敏感读取 | 网络 | 生命周期 | 可开放受限模式 |
| --- | --- | --- | --- | --- | --- |
| macOS arm64 26.7.1 | 原生宿主 | partial；硬链接失败、allowlist 未实现 | 默认禁止局部验证通过；目标授权未验证 | 进程组代码已审查；逃逸/撤权未验证 | 否 |
| Linux arm64 LinuxKit / Docker 默认隔离 | 已启动真实 VM，普通容器 `unshare -Ur true` 返回 EPERM | 后端启动能力受默认容器约束 | 未验收 bwrap 完整网络策略 | 未验收 | 否 |
| Windows native | 没有可调用的运行目标；VMware 运行 VM 为 0 | 未验证 | 未验证 | Job Object 仅代码审查 | 否 |
| 远端 Linux/macOS/Windows | 未连接真实服务器；已有 SSH fixture 镜像可用 | 尚无远端沙箱后端 | 未验证 | 重连/断线/残留未验证 | 否；仅维持主机运维原行为 |

Linux Docker 后端实验结果在下一节记录。容器实验只能证明该配置，不能替代发行版原生用户 namespace 测试。没有为了使后端通过而启用 privileged、修改宿主 sysctl、Docker 安全配置或远端组件。

尚未完成：三平台全能力和失败路径；macOS 最小读取与硬链接安全方案；并发根目录/链接替换；DNS、外网直连、UDP、监听、云元数据、SSH 转发；HTTP 目标代理及重定向；pnpm/cargo 真实完整项目测试构建、依赖下载与独立缓存；脱离进程组背景任务、超时与撤权清理；恢复和多会话资源授权。不能由局部成功推断上述项目完成。

## 8. 下一轮可执行验收与进入条件

1. 原生 Linux 非管理员账户运行 bubblewrap，分别确认 user namespace 可用/被禁用和二进制缺失；失败时执行标记必须不存在。先跑现有文件/网络测试，再补完整规则用例。不得以放宽 Docker 配置作为用户平台的通过证据。
2. 明确硬链接契约：项目内预先存在的外部 inode 别名不得读写拒绝资源。选择能落实对象/独立文件系统边界的成熟后端或降低声明能力并拒绝该模式；仅执行一次 `nlink` 扫描不能证明竞态安全。
3. 三平台统一使用真实临时资源，重复直接路径、软硬链接、替换竞态和后代进程实验；再按运行工具逐个收敛系统读取允许列表。每项要同时有无限制正控制、受限拒绝、父进程核对副作用。
4. 在隔离目录建立真实 pnpm/cargo 项目，先离线构建测试，再按实际源和重定向授权下载；确认缓存外写入失败、并发 temp 不共享、项目敏感文件不可读。原项目完整构建作为兼容性追加验收。
5. 宿主设置 IPv4/IPv6/Unix/UDP 真实监听和 DNS/HTTP fixture；测试子进程直连、localhost、本地服务授权及不能绕过代理的系统约束。不同资源必须独立授权。
6. 用真实后台进程和 `setsid`/双重 fork 重现进程组逃逸，按成熟生命周期后端验证 cancel/timeout/撤权/会话关闭后无存活后代；后台仍存活时 temp 不得被提前删除。
7. Windows 在实际 native runner 按 AppContainer 最终后端执行同一矩阵，确认 PowerShell、Node、Cargo、ACL、loopback 和 Job Object 失败流程；无 runner 时保持未完成。

阶段 1 可先做明确区分意图与能力的契约，但原会话必须接受阶段 0 尚未通过的证据和以上缺口；不能将阶段 0 标记全部完成。阶段 2 或任何受限模式启用前，必须有目标平台完整声明边界和失败即拒绝的真实证据。生产继续维持现有行为，不能宣称 sandbox full。

## 9. Linux 后端真实启动记录

本地专用实验镜像构建成功（Debian bookworm arm64，bubblewrap 0.8.0-2+deb12u1）。仅镜像内安装依赖，不修改现有服务器；镜像保留以便复核，实验容器使用 `--rm` 自动清理。以下命令的目标输出应为空，退出码为 1：

```bash
docker run --rm --network none shellspan-sandbox-phase0:local --version
docker run --rm --network none shellspan-sandbox-phase0:local --unshare-user --unshare-pid --unshare-net --new-session --die-with-parent --ro-bind / / /bin/sh -c 'printf EXECUTION_STARTED'
```

第一条返回 `bubblewrap 0.8.0`（退出 0）。第二条返回 `bwrap: No permissions to create new namespace`（退出 1），stdout 没有 `EXECUTION_STARTED`。`verify_linux_unavailable.py` 对版本、拒绝原因、非零退出及未派发标记作真实进程断言；1 test，OK。错误消息不能单独证明原因是内核配置或 Docker seccomp，记录为当前组合不可用。没有使用放宽安全配置的容器作为通过证据。Linux 正常隔离、缺失二进制与原生发行版支持仍未完成。

## 10. 阶段 2 补充证据，门禁仍未通过

2026-10-05 本轮重跑原生 macOS 10 项实验和 Linux unavailable 1 项，原缺口仍成立。进一步在维护中的 SRT 0.0.78 原生运行器复现外部硬链接读写越界；专用 APFS 卷实际阻止跨卷硬链接，但同卷项目 `.env` 的别名仍能读取被拒绝内容。不能将第三方依赖或独立卷本身当作完整文件对象边界。

Docker Desktop 独立 Linux 文件系统的基本执行、pnpm/cargo 小项目构建、网络 syscall 拒绝及容器后代 kill 已真实验证；不需要启用 privileged 或更改 daemon 安全配置。但直接共享目录、预检后硬链接注入、普通内容导入、宿主回写均未满足边界，Docker CLI 退出/超时也不会自动清理容器。该候选不代表原 macOS/native Linux/Windows 后端可用。支持矩阵的生产结论继续为“否”。

阶段 0 未完成项增加明确 provider 条件：稳定输入与敏感对象别名拒绝、安全回写中目录/链接替换的实际强制约束；不接受 nlink 扫描、路径复查或普通复制替代。同时仍缺 native Linux/Windows 环境、完整项目兼容、可信越界诊断与生产生命周期协调。详见 [阶段 2 实验与设计](agent-shell-sandbox-phase-2-acceptance.md)，该文保留全部未完成项，不将反例断言通过算作安全门禁通过。

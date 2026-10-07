# Agent Shell 沙箱阶段 2 实验与待验收设计

当前状态：2026-10-07（Asia/Shanghai）。**macOS 常规原生 Direct 闭环及下表列出的子项已有真实证据；完整仓库受限测试仍须按真实结果收尾。** 当前能力保持 partial。用户确认首版采用正常进程组控制，恶意后代逃离及完整对象隔离不属于已承诺保证；硬链接别名、同账户恶意竞态与进程组限制如实保留，不因此追求 ES 或特权方案。Windows 实机后续提供，Linux 桌面与容器产品模式不属于首版路线。以下早期实验保留原日期和结果，不据当前路线改写历史。

## 2026-10-07 阶段 2 收尾审计

### 关闭准入与本机网络补验

应用退出入口同步关闭单向准入，Runtime、NativeToolEngine 与 AgentRegistry 共用同一状态；已登记的父/子 Agent 使用该状态的子取消令牌。关闭后拒绝新会话、Agent 注册/驱动与工具准备/签发/启动。后台协调器取消工具与模型任务，等待启动登记完成并再次清理；重复调用等待同一结果，超时、清理错误及 worker panic 保留未确认结果。Shell 启动租约仅覆盖创建和登记，不覆盖整个前台等待。未扩大普通进程组的保证。

`/tmp/shellspan-shutdown-final-check.log` 的 cargo check 通过；`/tmp/shellspan-shutdown-registry-native-test.log` 的真实父/子 Registry 验证 1 passed，使用实际 HTTP adapter 构造而不发送模型请求。已有 Wry `/tmp/shellspan-phase5-wry-exit-active-final-9RaEiz/shutdown-check.json` 的 19 项检查通过，生产 AppExit 主动清理两个资源、端口释放、重复退出结果一致；并发启动只观察到 gateRejected 分支。该 Wry 结果先于最后的 Registry 共享准入补充，不能替代补充后的最终应用复核，也不证明完整模型业务回合或所有竞争分支。

新增专属 `native/macos_network_acceptance.rs`，`/tmp/shellspan-phase2-network-matrix.log` 为 2 passed。使用实际自建 IPv4/IPv6 TCP 与 Unix listener，每次先确认宿主 Node 连接到同一 listener，再确认生产默认受限 launcher 的 Node 及普通子 Shell 连接失败且 listener 没有接收到连接；包含 `::ffff:127.0.0.1`。只证明这些实际网络边界，不把 socket 错误文本当成 Controller 的可信 policyRejected。

`/tmp/shellspan-phase2-network-request.log` 为 1 passed：直接调用生产 network_requests，元数据类 IPv4/IPv6、回环及映射地址字面量全部返回 sandboxResourceRequestInvalid，没有发起 DNS 或网络请求。该项是启动前请求校验补充，不等同于实际 Engine 派发验收。没有连接真实云元数据或第三方内网。`/tmp/shellspan-shutdown-admission-final.log` 的单向关闭及租约等待回归 1 passed。

SSH 普通转发补验位于专属 `native/macos_ssh_network_acceptance.rs`，`/tmp/shellspan-phase2-ssh-forward.log` 为 1 passed。使用当前普通账户的独立 OpenSSH 服务、一次性生成的 host/client key 和专用 known_hosts，宿主真实 `ssh -W` 向自建 loopback TCP 服务发送并接收 `ssh-forward-marker`；同一 SSH 参数经生产默认受限 launcher 执行失败，目标 listener 没有接到连接。测试不读取用户密钥、不修改系统配置或权限。这证明默认 deny 下该实际直连 SSH 转发路径被阻止，不覆盖已授权公网 SSH 经代理后的全部 forwarding 形式，也不将 SSH stderr/退出码单独认作可信 policyRejected。完整网络授权矩阵仍按未覆盖项分别验收。

阶段 5 新增真实模型未知结果恢复报告 `/tmp/shellspan-phase5-pipeline-model-unknown-O9WZbn/model-recovery-result.json` 已核对：passed=true、11 checks true、MiniMax-M3 seedModelRequests=1、totalModelRequests=2、sourcePtyWrites=0。实际模型生成并派发自有有限时命令后中断 App，命令自然结束；重开通过公开 Runtime.start 恢复实际模型绑定和常驻 Driver，人工核对前不发新增模型请求，旧 approval 与直接 resume 均拒绝。核对单次文件效果及原进程终态后，公开 reconcile_recovery 允许实际第二模型请求完成，无额外工具副作用、Workspace 保持。该项补充真实 unknown-reconcile-autoWake 路径；不将固定协议输入、正常重启或这些有限场景推广为完整模型业务、所有恢复竞争分支及 Windows 通过。过程和真实等待审批恢复的独立范围见 [阶段 5 验收](agent-shell-sandbox-phase-5-acceptance.md)。

### 普通补验与信号兼容修复

在本文件所属的 `native/macos_sandbox.rs` 测试区新增 3 项真实普通回归，`/tmp/shellspan-phase2-normal-closure.log` 3 passed：项目内链接写入确实改变其普通目标；悬空链接读取失败且不产生目标；冻结根外的自有非敏感普通目标通过链接读取/写入均拒绝且内容不变；两层子 Shell 保留临时/缓存环境及相同路径限制；两个同时运行的命令使用不同 temp/cache，写入同名文件互不污染。没有读取真实凭据、尝试历史对象别名攻击或重试被中止实验。

首次完整仓库受限前端测试退出 1，实际出现 Vitest forks worker 清理 `kill EPERM`，不能算通过。核对当前 profile 与 [Anthropic SRT 的信号规则](https://github.com/anthropics/sandbox-runtime/blob/main/src/sandbox/macos-sandbox-utils.ts) 后，生产 profile 最小增加 `(allow signal (target same-sandbox))`。真实 Node worker 的 SIGTERM 与 exit 已验证，信号权限检查不能作用于另一个由测试持有、位于沙箱外的普通 sleep 进程，该进程保持运行。没有全局 allow signal，没有增加外部进程控制或任意网络权限。重跑结果另记下方；第一次失败保留 `/tmp/shellspan-phase2-native-full-frontend.json`。

完整仓库受限 Rust 测试已实际运行：`/tmp/shellspan-phase2-native-full-rust.json` exitCode=101、terminationConfirmed=true，1079 passed / 124 failed / 67 ignored。失败包含测试宿主 TCP/Unix 监听、内部 loopback 转接、PTY 创建、回收站及嵌套 sandbox launcher 等能力被外层限制；这些测试本来验证宿主/后端系统能力，不等同于普通项目 cargo test 的权限要求。仍需逐项区分普通工具失败；不开放 TCP、PTY、回收站或广泛目录权限让整套强行通过。`xcrun_db` 缓存写入拒绝亦保留原诊断，不凭 stderr 自动扩权。

修复后受限前端完整回归通过：`/tmp/shellspan-phase2-native-full-frontend-signal.json` exitCode=0、terminationConfirmed=true，294 files passed / 1 skipped，2573 passed / 2 skipped；未开放被拒绝的 `.npmrc` 或用户 pnpm rc。首次失败保留原报告，不计为成功。

独立受限调用的信号边界通过：`phase2_normal_independent_sandboxes_cannot_signal_each_others_workers` 使用不同冻结 target/session 和独立 launcher 各创建正常 Node worker。第二份能 SIGTERM 清理自身 worker，对第一份 worker 的 signal 0 检查返回 EPERM，第一份 worker 保持运行；各自进程组最后清理。`/tmp/shellspan-phase2-independent-signals.log` 1 passed，不以此承诺恶意后代完整控制。

普通 Rust 工具功能通过：同一仓库冻结根下执行 `cargo test --offline --manifest-path tests/agent-shell-sandbox-phase-2/projects/rust/Cargo.toml`，exitCode=0、terminationConfirmed=true，真实算术 crate 单项测试通过，报告 `/tmp/shellspan-phase2-native-ordinary-rust.json`。这不替代 ShellSpan 全套宿主系统能力测试的结果。

首次收尾审计只读核对源码与已有日志；随后补授权的普通验证，仅在专属 macOS launcher 文件添加同沙箱信号规则和就近测试。共享协议及实施计划没有修改，没有重跑历史攻击反例或 GUI 生命周期实验。阶段 3 的后续实现不能倒写成阶段 2 当轮已验证；当前状态与历史状态按日期区分。

| 原清单要求 | 已确认的实现与真实证据 | 结论及未覆盖范围 |
| --- | --- | --- |
| 创建 Shell/子进程前落实文件和网络策略 | `NativeAdapter` 转交冻结契约，内核校验目标、原生能力和策略摘要，生产 `macos_sandbox::command_tracked` 固定使用 Seatbelt；无资源时默认拒绝网络，不回退 Host。`macos_direct` 的真实 PTY/SQLite/审批/签名/执行链返回 macos-seatbelt，源 PTY 写入为零 | macOS Direct 常规路径已覆盖；对象别名和宿主同账户竞态仍不是已实现保证。其他执行方式不能由此标记受限可用 |
| temp/cache、清理环境与敏感读取拒绝 | 每个命令独立 temp/cache，`env_clear` 后注入有限运行变量；模型/SSH 凭据不进入 Shell。根目录 `.env.local` 明确只读，其他 dotenv 基线和已知敏感路径继续拒绝。阶段 3 的 `writePaths` 经规范化、审批、签名和租约允许明确缓存路径 | 当前缓存原生链覆盖未授权拒绝、一次/会话授权、到期和撤销，`/tmp/shellspan-phase3-cache-native.log` 1 passed；缓存真实模型请求为 0 的轮次未验收，不计成功。现有 env 回归只明确断言 SSH_AUTH_SOCK/OPENAI_API_KEY 未传入，不把它称为全部可能环境变量的逐项覆盖 |
| background/stdin/wait/kill/timeout/cancel/进程树清理 | `native_sandbox_background_stdin_and_deadline` 使用真实子进程读 stdin、等待并确认超时结束；变更 bindingRevision 或缺失契约时输入拒绝。普通取消与非零退出使用控制器事实；任务取消保留未确认记录，关闭代理/转接后才报告清理。MiniMax-M3 后台 cancel 报告 terminationConfirmed=true、sessionEnded=true、PTY 零写入 | 正常进程组控制与任务取消已覆盖；恶意后代逃离后的完整树清理没有实现。历史容器 GUI 5/5 是该容器归属协调层的证据，不替代 macOS Seatbelt 后代完整控制 |
| 区分策略拒绝、基础设施故障与命令失败，不无限制回退 | 创建前验证可报告 notStarted；本地 spawn 成功后为 started，SSH 发送前/发送中/确认后分别保留 notStarted/unknown/started。命令非零或 stderr EPERM 不自动成为可信策略拒绝，也不自动扩权或重放 | 类型化分类及普通运行边界已接入；未覆盖全部平台基础设施失败情形或全部运行期越界诊断 |
| 正常路径、符号链接、继承、网络和日常构建 | 原有项目链接读取、子 Shell、项目/TMPDIR 写入及受限 pnpm build、cargo check/build 已通过；本次补链接写入、悬空链接、根外普通目标拒绝、多层子 Shell、并发 temp/cache、正常 worker 信号与独立受限会话边界。修复后完整仓库受限前端 2573 passed / 2 skipped，普通 Rust crate 测试通过 | 正常补验已覆盖；完整 ShellSpan Rust 宿主能力套件在外层沙箱内仍失败，不能将普通 crate、小项目或宿主全量结果替代该结果 |

### 当前验证证据与归属

- 完整仓库受限构建：`/tmp/shellspan-env-local-native-build.json` 的 result.exitCode=0；`/tmp/shellspan-macos-native-cargo-check.json` 和 `/tmp/shellspan-macos-native-cargo-build-final.json` 为此前成功记录。此前 `.env.local` 拒绝退出 1 仅是历史结果，已经由用户批准的根目录只读例外解决。
- 普通真实模型与后台取消：本报告下方的 MiniMax-M3 两份报告保留原会话/原数据含义；阶段 3 又完成网络、会话读取复用与 GUI 撤销等独立链路，见阶段 3 报告。不能把缓存模型 requests=0 的未完成轮次算入这些成功结果。
- 当前常规回归日志已核对：`/tmp/shellspan-phase3-rust-final.log` 为 1199 passed / 66 ignored / 0 filtered，另 5 项 integration passed；`/tmp/shellspan-phase3-frontend-final.log` 为 2573 passed / 2 skipped；`/tmp/shellspan-phase3-build-final.log` 构建通过。日志中的 release 负例诊断不等于 suite 失败；忽略或跳过项不计为验收成功。本次没有重跑它们。
- 已批准的精确公网 TCP host/port 与实际地址限制已接入代理；Node 本地服务由应用持有回环 TCP 监听和预绑定 Unix 描述符。`/tmp/shellspan-network-production-acceptance.log` 与 `/tmp/shellspan-vite-service-acceptance.log` 各 1 passed，分别覆盖真实目标访问/拒绝/取消、Vite 发布/所属服务 probe/端口释放；Vite 依赖准备不是受限网络安装的证明。

### 网络规则的准确语义

`network_requests` 签发 `NetworkTarget { protocol: tcp, allowRedirects: false, host, port, resolver }`，代理只接受这类 TCP 目标。校验和连接使用同一次解析得到的已检查地址；系统 DNS 默认，Cloudflare 加密 DNS 须明确选择并进入审批及签名，没有失败后换解析服务的自动回退。

这证明的是精确目标和地址边界，不证明 HTTPS 应用协议、内容、URL 路径、仓库或同目标重定向受限制。HTTPS/其他 TCP 隧道内容保持不透明；allowRedirects=false 表示代理不自动跟随重定向，不能据此宣称客户端在同一已批准目标内的重定向已禁止。UI 和模型必须继续展示同一范围；普通连接或命令失败不扩大目标集合。

### 必需补验与共享文档交接

1. 原清单“整个进程树清理”应由清单维护者改写为正常进程组清理、未确认清理保留并暂停派发及明确恶意后代限制；该限制已获首版 partial 授权，不再作为必须申请 ES/特权部署的阻塞，不重试已中止的恶意后代实验。
2. 正常链接写入、悬空链接、根外自有普通目标拒绝、多层子 Shell 与并发 temp/cache 已由上述普通回归补齐；不扩大到对象级、恶意竞态或所有工具链保证。
3. 完整仓库受限前端的 worker 信号兼容已作最小修复并重跑；完整 Rust 已真实失败并需要分层匹配测试范围。缓存授权真实模型回合仍须请求与执行证据，requests=0 不能替代。验证入口为 `tests/macos_direct.rs`、`native_agent_check.rs` 和相应独立报告。
4. Windows、SSH/非 Shell admission 由后续平台阶段处理；不能把本机成功复制成其他平台验收，也不以未提供 Windows 实机阻挡已验证的 macOS 工作。
5. 共享 `protocol/agent/runtime/sandbox-policy.md` 待阶段 3 编辑结束后同步：删除当前段“没有网络扩展授权”；补 networkTargets/localServices/writePaths、DNS 选择、一次/会话授权及撤销状态；将“只有 Direct/process 开放”改为包含仅针对活动所属服务的 probe_http；补预绑定描述符/受保护目录、代理关闭审计和准确 TCP/重定向语义。保留历史章节原日期，不把临时签名 grant 的执行结果/审计误写成恢复后可重用授权，`sandbox/call_frozen` 的持久化策略事实仍与 live grant 区分。

macOS 常规链路已有继续后续阶段的依据；上述剩余控制和证据应逐项闭合，partial 的用户授权不能替代必要控制，也不能把历史失败、未运行项或其他平台写成成功。

## 2026-10-06 原生 Direct 普通实现与结果

最新项目配置调整：用户明确要求支持 .env.local 访问，现允许只读访问冻结项目根目录的该文件；其写入、其他 .env 名称族读取和独立敏感路径规则仍拒绝。7 项原生相关测试通过，含 readOnly/workspace 两种模式的配置读取与写入拒绝。真实原生限制下本仓库 pnpm build 退出 0，能力保持 partial，证据 `/tmp/shellspan-env-local-native-build.json`、`/tmp/shellspan-env-local-tests.log`。未输出实际配置内容。下文此前 .env.local 构建拒绝保留为历史结果，不再是当前构建阻塞。

- `native/macos_sandbox.rs` 是新的生产 launcher，没有移除旧测试 launcher 的 cfg。接受冻结根与路径策略；固定 sandbox-exec + 非登录 /bin/sh，default deny、network* deny、独立 temp/cache、已知敏感路径与 .env 名称族拒绝。保留明确系统目录及宿主 Node/pnpm/Rust 工具链读取，不开放整个 HOME 写入，不注入模型/SSH 环境凭据。
- NativeAdapter → NativeExecutionContext → NativeToolEngine → ManagedProcess 的契约实际传递。最新 Session 身份与 bindingRevision 校验保留；原生目标再次校验。stdin 绑定原始进程契约，重绑后拒绝输入；既有 wait/kill/timeout 复用真实进程组控制，能力不承诺恶意后代完整控制。
- 无参数原生预检 IPC 在 blocking worker 运行固定普通命令；创建会话、模型上下文、事件/执行结果与原有 UI 使用相同 partial 事实。仅受限 Direct Shell 和自身进程控制开放，其他宿主工具、MCP/远端/普通 PTY 拒绝。网络授权、代理、本地服务留待阶段 3。
- 5 项真实普通测试通过：项目读写与内部符号链接/子 Shell、只读及敏感路径拒绝、正常 TCP 连接拒绝、后台 stdin/timeout 和绑定变化拒绝、真实宿主工具链可执行。另 1 项真实 Session store → 操作审批 → 原生能力令牌 → Direct 派发测试通过；不批准则拒绝签发，批准普通写入后返回冻结策略与 partial，真实源 PTY 的写入计数为零。没有模型服务响应替身；该项证明原生执行链，尚不证明真实模型服务整个回合。
- 常规 Rust：1183 passed / 62 ignored / 4 filtered，43.78 秒；前端：2558 passed / 2 skipped。相关组件、协议与架构检查通过。现有 UI 仅调整可用选项、真实能力/双语提示；用真实 native check JSON 做 WebKit 显示检查，覆盖两种语言及 1280/400/320 宽度，没有更改布局。
- 宿主 pnpm build 通过。原生 sandbox 的 cargo check/build --offline 通过；Xcode 固定工具链目录只读，xcrun 尝试宿主临时缓存会产生拒绝警告，但构建实际退出 0，没有开放整个系统临时目录。原生 sandbox 的本仓库 pnpm build 退出 1，提示读取 .env.local 被拒绝；敏感文件未读取或删除，未解除 profile，按 commandFailed 保留结果，不以 stderr 签发可信策略拒绝或资源授权。

实际证据：`/tmp/shellspan-macos-native-check.json`、`/tmp/shellspan-macos-native-cargo-check.json`、`/tmp/shellspan-macos-native-cargo-build-final.json`、`/tmp/shellspan-macos-native-regression-final.log`、`/tmp/shellspan-macos-native-frontend-tests.log`。debug-only `--native-sandbox-check <workspace> <command>` 使用真实冻结 Session 与相同 launcher；release/其他平台明确拒绝，该入口不是生产模型派发接口。

### 真实模型回合与会话取消追加验收

用户明确选择开发版默认 MiniMax-M3，并批准在独立测试会话执行普通项目读写及取消验证。新增 debug-only `--native-agent-check` 使用真实 Wry App、LLM runtime、NativeAdapter、SQLite Session store 和真实 PTY；用户数据库仅只读查询 routes，测试状态另存新目录。凭据管理器只能读取所选模型的既有钥匙串引用，不支持写入/删除或获取 SSH/MCP/其他模型凭据，不向 Shell 注入凭据。

普通回合通过：2 次真实模型请求、1 次经真实审批和原生适配器完成的 Seatbelt 执行，实际生成/读取测试文件，turnEndReason=completed，sourcePtyWrites=0，capability=partial。报告 `/tmp/shellspan-real-model-y2xHvP/model-check.json`，真实会话 `native-model-3d176d6e-a6a3-4fb2-9545-f73a56d98071`。

取消场景通过：模型实际提出固定 sleep 30 后台命令，审批后取得真实进程句柄，再经生产 cancel 入口结束会话；processLifecycle=cancelled、terminationConfirmed=true、sessionEnded=true、sourcePtyWrites=0。报告 `/tmp/shellspan-real-cancel-VOz6up/model-check.json`，真实会话 `native-model-55b11134-04db-4a13-833d-251a6185bc4d`。客户端只批准任务预先授权的固定测试命令，不以模型解释授权额外操作。

这次真实回合修正了两个实际运行边界：受限会话自动技能发现现在记录明确 unavailable，不调用宿主读取，也不在模型请求前中止整个 Direct 回合；任务级 cancel 不再忽略 kill 结果后遗忘进程，仅清除确认结束的记录，未确认时暂停新派发并保留临时数据。远端启动前/可能发送 exec/已确认启动以 controller admission 区分：尚未发出命令的握手取消/失败不误报残留进程，发送结果未知仍不能当作已清理。

新增普通取消/非零退出、受限技能发现回归通过；最新常规 Rust 1185 passed / 62 ignored / 4 filtered，40.94 秒，日志 `/tmp/shellspan-real-model-rust-final.log`。未确认取消的失败分支未通过伪造系统结果制造验收成功，不声称已覆盖所有平台失败情形。没有重跑历史反例或 GUI 生命周期实验。

该真实模型验收当轮尚未签发扩展资源授权。此后阶段 3 已接入文件读取、公网 TCP、Node 本地服务及明确缓存写入授权，当前状态见文首；此前 .env.local 构建失败仍保留为历史结果，不是当前阻塞。Windows 实机后续验收。首版不采用对象 provider、特权服务、Linux 模式或项目迁移；完整阶段要求须按文首逐项核对，不凭客户端自报 grant 开放权限。

## 后续执行状态

原会话曾记录：实验与设计轮次因安全检查失败，提示内容可能涉及网络安全风险；随后一次继续请求也在开始执行前被拒绝。当时没有产生新的实现或测试结果。

当前用户明确“继续”后，本会话按原会话限定范围完成下述普通软件实现和常规功能验证。没有重试或扩展攻击/绕过反例实验，没有更换会话规避检查，没有修改系统权限或安装特权服务。已有证据保留；尚未满足的门禁、执行环境选择和实际测试环境条件继续保留。

### 历史中止的误判反馈材料

反馈状态：材料已整理，尚未提交。当前没有可调用的反馈提交工具；电脑操作工具也明确禁止控制 Codex 应用，不能代用户点击反馈入口。官方处理说明为在可用时通过 `/feedback` 报告疑似误判：[Models and Trusted Access](https://learn.chatgpt.com/docs/cyber-safety#false-positives)。

可提交的内容：

> 请复核一次 Codex 桌面端的疑似网络安全误判。我正在为自己拥有的 ShellSpan 项目实现防御性沙箱功能。早期验证仅使用自行创建的本地临时目录、非凭据标记文件和可销毁容器；不访问第三方系统，不读取真实私钥、token 或用户凭据，不修改服务器安全配置。该会话的一轮实验与设计，以及随后限定为普通错误分类和进程生命周期实现的继续请求，均被提示可能涉及网络安全风险而中止。后续在同一会话进行普通功能实现与常规测试已成功，因此请求复核历史拒绝，而不是宣称账户仍被全面封禁。请确认允许的防御性验证范围和该桌面端需要的访问授权。
>
> 会话 ID：`01a10a35-f9c0-7140-ae63-71a0ad0f061a`。
> 失败轮次：`01a10a64-c7db-74f0-b4e5-47a35e48873b`、`01a10a74-5457-7d30-b273-e97eab5acad6`。
> 原始提示：`This content was flagged for possible cybersecurity risk. If this seems wrong, try rephrasing your request. If you’re doing authorized security work that requires more cyber permissive safeguards, apply for Daybreak access via https://platform.openai.com/settings/organization/status-and-access before retrying.`
> 后续成功轮次：`01a10aa9-d9cb-7811-9d7a-85ff1d8b7ac2`。此成功不表示此前被拒绝的验证已经获准。

提交时不附加完整源码、凭据、环境变量或未检查的日志。反馈提交、审查通过和 Daybreak 授权均不能由本报告推断；目前只确认后续普通实现已经成功执行。

## 当前交付和范围

开始时保留阶段 1 的全部未提交修改，继续前重新核对 git status 与当前文件；保留共享仓库中其他会话新增的阶段 3 UI/文档改动。本会话新增 `execution_failure.rs`、`native/container_backend.rs`、就近测试、`agent-execution.ts` 与 Bollard/Cargo lock；局部更新 Direct/process、admission 结果、command 注册及类型化 IPC。没有修改 UI、真实项目位置、服务器、账户、防火墙、Docker daemon 安全配置、系统特权服务或安全策略；没有 commit、tag 或推送。

生产仍由阶段 1 `require_host_policy`、start、工具 admission、NativeAdapter 和独立文件入口共同拒绝受限派发。所有生产平台能力仍为 unavailable。实验结果没有被用于修改该能力事实；本地 Linux 容器不冒充 macOS 原账户或原项目。

## 平台和成熟依赖审查

| 路线 | 本轮实际事实 | 门禁 |
| --- | --- | --- |
| macOS 原生 Seatbelt，经维护中的 SRT 0.0.78 | 原路径 deny 有效，项目硬链接别名仍能读取并修改项目外标记文件 | 不通过；不是完整对象边界 |
| macOS 专用 APFS 卷 + SRT | 新映像实际挂载，跨卷硬链接 EXDEV；卷内 `.env` 的普通名字硬链接仍能泄露内容 | 不通过；不将迁移卷视为充分解决方案 |
| Docker Desktop 的 Linux 独立文件系统 | 无宿主挂载时真实小项目读写/构建、socket 拒绝和容器清理验证通过 | 仅是独立 Linux 候选；原项目导入、回写、连续会话和生产协调未完成 |
| Docker 共享宿主项目 | 预先存在和预检后注入的硬链接都能改动宿主项目外对象 | 不通过，禁止采用 |
| 原生 Linux bubblewrap | 本轮重跑默认 Docker 组合，仍拒绝 namespace 创建且不执行命令 | 未提供发行版 native runner，不开放 |
| Windows native | 没有真实可调用 runner，未安装或执行 Windows 后端 | 未验证，不开放 |

本轮实际安装的 SRT npm 版本为 0.0.78，安装到临时目录且 `--ignore-scripts`，包完整性为 `sha512-YAIcybXTp7MZkBjasnkR1E3yxnf7u6kUkyW0vZrtsAZ9tyJGMaugWETmquPZs0YvW0sR0VnZeMfS0gsN/wQiVQ==`。其包内 README 明确不承诺 macOS 硬链接情况，Linux 已有外部硬链接同样可写。本轮在原生 macOS 用该运行器实际复现，不能因为第三方维护就忽略声明差异。[SRT 源码与说明](https://github.com/anthropics/sandbox-runtime)

SRT 的 Windows 路线是独立低权限账户、NTFS ACL、WFP 与 Job Object；当前上游标记 alpha，首次安装需要 UAC 并修改系统账户和机器级网络过滤，不属于本轮自动执行授权。其已记录系统 DNS 代理不受同一 fence 约束、glob 初始化后新文件等限制，不能直接宣称满足本项目全部契约。[Windows 路线说明](https://github.com/anthropics/sandbox-runtime#windows-alpha)

AppContainer 和 Job Object 是 Windows 原生候选，分别负责资源隔离与进程组管理；仍需维护中的实际运行器、NTFS/reparse/hardlink 与替代启动攻击验证。没有将 Job Object 单独视为文件/网络沙箱。[AppContainer](https://learn.microsoft.com/en-us/windows/win32/secauthz/appcontainer-isolation)、[Job Object](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)

gVisor 的 Gofer、overlay、EROFS 值得作为 Linux 进一步候选；overlay 保护后续写入，不证明输入对象被授权；读取 bind mount 仍须解决导入边界。未安装 runsc、未改 Docker runtime 配置，不能列为已验证。[gVisor 文件系统文档](https://gvisor.dev/docs/user_guide/filesystem/)

## 真实实验结果

宿主 macOS 26.7.1 / Darwin 25.6.0 arm64；Docker Desktop Linux Engine 29.8.0。实验镜像 ID 为 `sha256:4bb13341f79d2ef8750db781b7c04bf64b85f08a73f88ad913eeba2b1c18f8ae`，Node 24.21.0、pnpm 11.1.1、Debian rustc 1.63.0 / cargo 1.65.0。Rust 实验工具链是镜像工具链，不等于仓库使用的宿主 Rust 1.95.0。

容器调用创建前使用非 root UID 1000、cap-drop ALL、no-new-privileges、私有 PID/IPC/network namespace、只读镜像、三处独立 tmpfs、Moby 默认 seccomp 的收紧版本。源策略固定到 `2ceae35d351c156cb5a8efc0fdc4a08cf94569d8`；衍生时使用标准 JSON parser，只移除 socket/socketcall/connect/bind/listen/accept 与 io_uring 等允许规则，不自行实现 BPF、OCI、归档或 Docker attach 协议。[Moby 策略](https://github.com/moby/profiles)

| 实验 | 观察与父进程核对 |
| --- | --- |
| pnpm/cargo 真实离线小项目 | pnpm build/test 成功；cargo build/test --offline 成功，Rust 测试 1 passed；生成程序从项目 tmpfs 实际执行 |
| 环境 | payload 经 env -i，仅列出的 PATH/HOME/TMPDIR/cache 变量及 shell/Python 自生变量；没有转发宿主 API、SSH、Docker 环境或控制 socket |
| 路径/软硬链接 | 容器内部普通硬链接可用；写系统路径/软链接失败，跨文件系统系统硬链接失败；宿主 HOME 与 IPC 路径不存在或不可访问 |
| 网络/代理绕过 | IPv4、IPv6、UDP、Unix、netlink、vsock socket 创建均真实 EPERM；私有 socketpair 可用。正常未追加 seccomp 的 network=none 正控制能 loopback listen/connect，证明单独 none 不能满足“禁止监听”契约 |
| stdin/background/wait/kill | Docker attach 实际写入 stdin，payload 确认收到；top 观察双重 fork/setsid 后代；kill 后 inspect 停止、wait 完成、top 拒绝已停止容器 |
| 命令失败/创建失败 | payload exit 23，inspect 记录 23；缺失镜像以 pull never 创建失败且没有执行 ID。没有无限制 fallback。这里只证明可分开的事实，不宣称生产错误分类已接入 |
| 客户端退出/超时 | docker start 客户端返回或 attach 客户端被 timeout 结束，容器仍运行；显式 kill 后 wait=137。证明不能复用“杀 CLI 进程组”冒充容器完整清理 |
| 共享目录预先硬链接 | 容器读出专用项目外标记并通过别名改写，宿主核对原文件改变 |
| 共享目录并发注入 | 宿主先检查空目录；容器运行并报 ready 后，宿主添加外部硬链接；容器仍能读写项目外对象 |
| 独立文件系统普通导入 | docker cp 把外部硬链接的内容带入可写 intake 容器，payload 能读出；宿主原文件没有改变。独立存储不能修复已经泄露的导入 |
| 普通回写 | shutil.copyfile 覆盖项目硬链接会改变项目外原文件；目录 descriptor 打开后宿主将其移出原路径，descriptor 写入落在新项目路径之外 |
| macOS 维护中的原生运行器 | 原路径 cat 被拒绝；同对象项目内 alias 可读且可写，宿主核对外部文件被修改 |
| macOS 独立 APFS 卷 | hdiutil 新建/挂载/卸载成功；跨卷硬链接 EXDEV；项目 `.env` 的同卷别名仍绕过读取 deny |

全部敏感读取攻击只用专门创建的标记，不接触真实私钥、凭据或 token。14 项阶段 2 测试中部分是**断言反例存在**，通过不是安全门禁通过。容器/APFS 映像均完成清理；保留专用镜像及临时 SRT 安装供复核。未创建仓库内生成项目目录。

## 可重复命令和项目回归

命令和固定 profile digest 见 [实验 README](../../tests/agent-shell-sandbox-phase-2/README.md)。本轮结果：

| 命令 | 结果 |
| --- | --- |
| docker build 阶段 2 专用镜像 | 退出 0，只发送实验小项目上下文 |
| prepare_seccomp 固定上游 SHA | 退出 0；原/衍生 SHA-256 均记录在 README |
| verify_container.py | 10 tests，OK，5.444s；其后追加 netlink/vsock 断言的相关项 1 test，OK |
| verify_native.py | 1 test，OK，0.334s |
| verify_volume.py | 1 test，OK，1.539s |
| verify_writeback.py | 2 tests，OK，0.002s |
| 阶段 0 verify_macos.py | 10 tests，OK，1.376s；原硬链接/敏感读取反例仍成立 |
| 阶段 0 verify_linux_unavailable.py | 1 test，OK，0.225s，namespace 不可用且不派发 |
| cargo test --manifest-path src-tauri/Cargo.toml sandbox -- --quiet | 17 passed，0 failed，0 ignored，退出 0 |
| pnpm test 两个沙箱协议/投影测试文件 --reporter=dot --silent | 2 files / 6 tests passed，退出 0 |
| pnpm build | TypeScript strict + 生产构建退出 0；原有体积和 mixed import 告警 |
| git diff --check | 退出 0 |

上表是候选实验轮次的历史结果。续行软件实现与最新验证见下节；没有重跑上述反例。阶段 1 全量和格式基线记录继续保留，不把它们冒充续行结果。

## 续行已实现的普通软件基础功能

采用 Bollard 0.21.1 的 pipe-only 结构化 Docker API；Cargo lock 仅新增其必要依赖，不使用 CLI 输出或 Docker attach 字节解析。新容器控制器只接受预置不可变本地镜像 ID，拒绝镜像声明的自动卷，不拉取镜像，不接收宿主路径/环境/任意 Docker options。创建配置固定非 root、cap-drop ALL、no-new-privileges、只读根、private IPC/network、专用 workspace/temp/cache、env -i 和有界输出。[Bollard](https://docs.rs/bollard/0.21.1/bollard/)

它实现真实 stdin/关闭、bounded wait、stop、命令 deadline、daemon inspect 确认终态与删除，以及失败分类；输入/输出 transport 故障请求停止。它不等于完整网络策略：此基础版本使用 Engine 默认 seccomp 和 network none，不加载此前实验衍生 profile，不宣称阻止全部 socket/监听或开放任何授权代理。生命周期方法处于未接入 Session 派发的内部基础层，生产只读探测可调用；明确 gate 尚未开放，不存在启动候选的 IPC 或 UI。

新增 `agent_runtime_probe_local_sandbox_backend` async command、`src-tauri/src/lib.rs` 注册和 `invokeProbeLocalSandboxBackend` 类型化适配器。只查询固定本地 socket/named pipe，不使用 DOCKER_HOST/远端 SSH context；返回 Engine OS/arch/version、infrastructureAvailable 与稳定 false 的 workspaceVerified/admissionEnabled。生产 sandboxCapability 保持 unavailable，不把 daemon 连接成功当作工作区授权或平台完整支持。

Rust/TS `AgentExecutionFailure` 提供 kind/code/admission；policyRejected、backendUnavailable、infrastructureFailure、commandFailed、cancelled、timedOut、terminationUnconfirmed 来自控制器事实。Direct exec/wait/kill 结果增加 lifecycle/terminationConfirmed/failure，启动和 stdin 控制错误返回结构化 infrastructureFailure；保留既有 state/exitCode/输出字段与普通非零退出的 tool completed 语义。未知启动状态为 unknown，不伪装 notStarted。受限 admission 审计提供 backendUnavailable/notStarted，目标或授权校验拒绝为 policyRejected，不根据命令 stderr 推断沙箱失败。kill 无确认时 status uncertain 并保留当前进程句柄。冻结 Session/target/bindingRevision 和审批/审计校验保持原入口，没有 Host fallback。

原生 Direct stdin 移到独立写入线程及容量 1 的队列；stdin 未被消费时，管理线程仍能执行停止/命令 deadline。确认超时请求停止并禁止重放，避免失败调用之后继续执行排队输入。该修复不宣称 Unix process group 能控制所有后代；当前仍非完整沙箱生命周期，不能借此开放受限策略。

正常真实功能验证使用已有专用镜像、read/printf/sleep/exit；没有攻击、模拟运行器、虚构成功结果或新的宿主共享目录。Bollard 测试验证 stdin、stdout/stderr、exit 23 的 commandFailed、stop、100ms deadline、重复 stop、daemon 终态及资源删除；缺失本地镜像验证拒绝且不 pull。默认忽略依赖外部 Engine 的两项测试，但本轮显式 include-ignored 实际执行，不将 ignored 当作通过。

前轮尚欠的 startup/orphan 持久协调已在下节实现；生产 Session 派发、项目 storage/image 选择与完整多会话授权生命周期仍未完成。不可用或清理不确定不自动无限制重试，内部启动方法继续不接入用户执行。

续行验证：原生进程 8 passed；受限契约 16 passed（显式跳过 operator_workspace）；Bollard 3 passed，含两项显式运行的真实 Engine 测试；Rust 广泛常规回归 1176 passed / 56 ignored / 4 filtered（跳过 operator_workspace 三项及原有项目外写入实验，避免重试反例）；前端 4 files / 52 tests passed；pnpm build、cargo check --lib、47 项 include 格式及 diff check 通过。最新逻辑改动后的 Native runtime 8 passed、原生进程 8 passed、受限契约 16 passed，全部无失败；Bollard 最终 3 passed。全仓 cargo fmt 仍只有 `native/mcp.rs:754` 既有差异，不修改任务外基线。新增 IPC 在 command/Rust 注册/TS 适配器中完整接入；没有 UI 调用或资源签发入口。

## 本轮启动、拥有记录与退出恢复的实际实现

新增 `native/container_ownership.rs`。使用现有 rusqlite，SQLite WAL + synchronous FULL，拥有记录和签名审计在同一事务提交。owner 为单行主键约束，在 IMMEDIATE 初始化事务内读取或创建；同进程相同根共用实例，不并发生成不同 owner。签名密钥仅经过现有 CredentialManager 进入系统钥匙串，测试也使用真实 native store，未采用内存凭据替身。

持久记录绑定真实 Session header 的 sessionId、创建时间、bindingRevision、target/surface/policy 摘要，以及 daemon 身份、随机唯一 job/name、不可变镜像、命令摘要。没有命令正文、资源授权或凭据。HMAC 同时保护记录和意图；清理必须进一步匹配已保存的**确切容器 ID 回执**及 daemon/名称/镜像/命令摘要。公开标签可重放，单独名称或标签不提供拥有权限：没有确切回执时，即使发现同名容器也不自动认领或删除。当前绑定仅用于内部 cleanup custody，不作为执行授权或新增 IPC 绑定字段；Rust/TS 现有公开失败类型不变，协议已同步说明。

状态区分：准备但确定未发送（create_sent=false、无 ID）；可能已发送且结果未知（create_sent=true、无 ID）；已取得并原子保存的回执（有 ID）。第二类的 404、超时、客户端 future 结束都不能证明 daemon 不会稍后创建；重复查询也不会遗忘债务。恢复只清理有完整归属证据的自身资源；不可达、记录缺失或归属不确定时保留状态和阻止新启动，不谎称 terminationConfirmed。清理资源后核对不存在，才原子移除活动记录并追加签名审计。

启动 caller 的取消、deadline 或 future drop 通过 cancellation token 通知独立协调任务；后者保留有界 Engine create/start 请求，保存返回 ID 后再完成确认清理。收到 unknown 不重放命令、不重新创建容器。真正丢失确切回执的债务不会通过有限轮询自动消失；需要后续可信回执或独立人工处理，不能将这一边界隐藏为“全部恢复成功”。

生产新增的行为是应用配置后的后台恢复，以及幂等 ExitRequested 协调。原有 prepare_for_shutdown 保留，在 blocking worker 中执行；Docker 网络操作使用 async worker，文件/SQLite/钥匙串操作在 blocking worker。事件主线程只进行非阻塞内存通知和 prevent_exit，结束或 10 秒截止后由 AppHandle 请求退出；Exit 不重复执行阻塞清理。协调结束与资源清理确认严格区分，截止后债务留存。Tauri 强制 restart 不允许 prevent_exit，因此仍依赖原子记录在重启后清理，不宣称强制退出前完成了清理。

本轮 7 项相关 Rust 测试实际通过，含 5 项显式运行的 native credential/Engine 依赖测试：普通 stdin/wait/stop/deadline、缺失镜像、重复退出及空资源快速退出、真实并发 owner 打开、未知创建连续 404/截止后的债务保留、实际 caller future 取消、runtime 停止后重新打开 journal 清理、真实不可达 Unix socket、用户来源的普通容器不被恢复清理。使用现有镜像及 read/printf/sleep/exit，没有重新执行历史攻击/绕过实验。广泛常规 Rust 回归 1177 passed / 59 ignored / 4 filtered，42.56s；未将 ignored 当作通过。最终逻辑改动后再次定向验证；全仓格式基线仍为任务外 mcp.rs:754。

Node 实验测试改为 `sum.node-check.mjs` 并保留包内 `node --test`；Node 自身 1 passed，全范围 Vitest 292 files passed / 1 skipped、2556 tests passed / 2 skipped，退出 0，67.00s。没有通过全局排除测试修复收集。此前 dead-code suppression 已删除，架构检查 4 passed；容器启动基础层尚未接入生产派发产生的 5 项 unused 警告如实保留。pnpm build、cargo check、47 项 include 格式与 diff check 通过。

资源核对中仍有前次失败测试留下的两只已停止容器：`57f3b4b90d79`、`cfbf3ae39a49`。其临时拥有记录已随失败测试目录释放，当前没有完整归属证据；本轮不按名称、镜像或推测去清理，也不把它们描述为已确认清理。后续生产始终使用持久拥有记录，无法证明归属的资源须保持未确认。

## 2026-10-05 当前系统追加验证

当前 macOS 与 Docker Desktop 上，新增真实辅助进程崩溃恢复和多会话控制。父测试启动独立 Rust 辅助进程，子进程使用真实 native credential store、真实 Session header 和已有专用镜像保存确切容器回执；父进程强制终止子进程，随后通过新协调器重新打开 journal，确认清理该容器。多会话并发测试实际启动两只容器，停止第一只后第二只仍处于 running，接收 stdin 并独立退出。最终相关验证 **9 passed / 0 failed**，3.24s，显式过滤仅供父进程启动的 `container_process_crash_child` 辅助入口。该证据证明恢复组件的真实 OS 进程丢失，不等同于已完成 GUI 应用关闭/强制 restart 的桌面验收。

完整项目兼容性实验采用当前工作树的独立源码快照，保留未提交源码改动与删除，不携带宿主 HOME、Git 内部数据、普通凭据配置或任何原项目挂载。按实际构建与测试需要纳入 pnpm workspace/patch、CI 配置、文档测试输入及仓库内 shadcn skill。使用成熟文件复制/tar，仅用于受信当前代码的开发验证；链接预检不被当作安全导入实现，未接入 Agent 的项目同步、资源授权或回写。

记录的基础快照为 1326 files，manifest SHA-256 `3e73027ed6f07c088dcec2b52ae63098ed481f6a610ab5b45bd877a711feb8be`；基础镜像 `sha256:a0fd00a80f7423bc9dbb994ad572c9aefdc22231863ec5e5353b2594f5b80461`。追加普通测试依赖后使用 `sha256:ec666cf426bddd769dd879abab7be01e2ce92c13846eec4f1544be2c9f760fe0`，应用源码逻辑不变，只增加 openssh-client、zsh 与技能测试输入。工具链为 Node 24.21.0、pnpm 11.1.1、Rust/Cargo 1.95.0；依赖准备单独进行，实际命令执行为 network none、无宿主 bind、只读系统镜像、UID 1000、cap-drop ALL、no-new-privileges、清理环境和专用工作区/缓存。

初始 tmpfs 编译因 Docker VM 8GB 内存发生 OOM，改为本轮独立 Docker 本地数据卷后完成构建；未修改宿主或 Docker 安全/内存配置。仅调低编译并行与调试符号，不改变代码、断言、锁文件或测试成功条件。普通环境中缺失的 ssh-keygen/zsh/skill 输入补齐后，保持原测试重新验证。

| 当前系统实际验证 | 结果 |
| --- | --- |
| macOS 原生新生命周期集合 | 9 passed / 0 failed，真实系统钥匙串与 Engine，3.24s |
| Linux 离线 pnpm install + pnpm build | 通过，Vite 构建退出 0 |
| Linux 全范围 pnpm test | 292 files passed / 1 skipped；2556 tests passed / 2 skipped |
| Linux cargo build --locked --offline | 整个项目构建通过，dev profile，5m50s |
| Linux 常规 cargo test --lib --locked --offline | 1172 passed / 0 failed / 56 ignored / 2 filtered，21.76s；过滤原边界实验，未将 ignored 作为通过 |
| 最终执行容器状态 | exited / exitCode 0 / PID 0 / OOMKilled false |
| 资源清理 | 按本轮创建回执删除容器和两只专用数据卷成功，未操作用户或其他应用资源 |
| diff / include 检查 | 通过；全仓 fmt 仍为 mcp.rs:754 既有差异 |

可重复脚本见 `tests/agent-shell-sandbox-phase-2/README.md`。实际执行日志保留在 `/tmp/shellspan-macos-lifecycle-current.log`、`/tmp/shellspan-real-process-recovery.log`、`/tmp/shellspan-linux-disk-build.log`、`/tmp/shellspan-linux-rust-final.log`；不将普通构建日志或源码快照视为权限授权证据。兼容性辅助 runner 可创建独立资源并按确切回执清理；本轮实际命令由同等配置的显式 CLI 执行记录验证。

仍缺：真实 GUI 退出/restart 桌面验收，安全文件对象 provider、导入/回写与用户并发修改保留，生产 Session 派发/实际身份/存储接入，可信越界诊断、资源授权/撤销及完整边界验证；native Windows/native Linux runner 尚未提供。Docker 上的 Linux 构建不证明 macOS 原生构建在受限模式下可用，也不开放 Linux 新产品模式。阶段 2 五项整体清单继续未勾选。

## 待原会话审查的具体设计

### 2026-10-05 隔离原生 GUI 退出/重启验收

提取 `app_exit::handle_event`，生产 `App::run` 和独立 GUI 验证共用同一退出处理器；保留原有 runtime prepare、async 清理、10 秒截止和幂等状态，不复制一套退出逻辑。`application_context` 仅集中已有 context 构造，避免 macOS Info.plist 重复嵌入。新增 debug-only CLI 验证入口，release 明确拒绝；没有新 Tauri launch/授权 IPC。

使用实际 Tauri/Wry 原生窗口和事件循环，独立 identifier、全 app-directory override、incognito/about:blank 和新建临时目录。没有加载生产用户数据库、共享凭据 vault、终端、LLM、部署或 Docker 资源，没有关闭现有用户应用实例。测试通过真正的 AppHandle exit/request_restart 驱动，不使用 mock runtime 或合成退出结果。

最终验证：quit 进程 PID 51913，实际 ExitRequested/Exit 共 5 条记录并退出 0；restart 从 PID 51929 重新拉起 PID 51947，两者均实际进入 Exit，9 条记录，最终正常退出。重复退出请求没有重复创建清理协调器；后续 ps 核对三个 PID 均不存在。结果保存 `/tmp/shellspan-gui-lifecycle-results.json`，构建和契约日志分别为 `/tmp/shellspan-gui-lifecycle-build.log`、`/tmp/shellspan-gui-lifecycle-contract.log`。

当前 debug 工程构建通过；相关架构/终端协议测试 15 passed；常规 Rust 广泛回归 1177 passed / 62 ignored / 4 filtered，39.32s。git diff --check 通过，fmt 仍仅任务外 mcp.rs:754 既有差异。没有新增前端/UI 产品变更或提交。

该记录完成**空资源、隔离原生 GUI、共用退出处理器**的实际验收，不是整个主工作台带活动会话/后台资源的 GUI 验收。尚需把带任务/清理债务的场景纳入隔离实例；实际受限 Agent 闭环、安全文件对象/导入回写和执行环境产品选择继续未满足，门禁仍关闭。

#### 带自身后台资源与清理债务的追加 GUI 验收

2026-10-05 后续在同一隔离原生窗口扩展实际场景：真实 native credential backend 只创建专用 fixture key，不打开用户共享 vault；真实 AgentRuntime 创建冻结 Session header，使用已有专用镜像执行普通 `sleep 30`，记录确切容器 ID。Supervisor 先完成本 fixture 的恢复对账再创建新资源，避免启动恢复扫描与新资源创建竞态。没有新模型/用户启动入口，没有改变生产恢复/退出语义或开放受限派发。

实际结果保存 `/tmp/shellspan-gui-active-results.json`：

| 场景 | 实际事件与资源核对 |
| --- | --- |
| quit | PID 59164，5 条事件，正常退出 |
| restart | PID 59171 → 59193，8 条事件，两个进程均正常退出 |
| quit-active | PID 59223，5 条事件；自身容器经实际 Engine 查询确认不存在，pending=0 |
| restart-active | PID 59499 → 59521，8 条事件；重启恢复只清理确切自身回执，容器确认不存在，pending=0 |
| quit-debt | PID 59529，5 条事件；正常退出并保留 pending=1，不冒充清理确认 |

5/5 通过，后续 ps 核对全部 PID 消失。债务用例在实际原子保存准备发送状态后中断，不发送 create；仍按保守生产语义经过真实 daemon 404 保留债务。不是伪造 daemon 响应或故意执行未知命令。fixture 根 `/private/tmp/shellspan-gui-quit-debt-ij1e7336` 的 SQLite/audit 与专用 native key 保留供复核；不从该记录恢复授权、不重放命令。其他场景的测试目录和自身 key 在确认无 pending 后清理，没有读取或修改现有用户凭据。

debug CLI 的 `status` 只用于已有 fixture marker 的本地核对，无 Tauri IPC 授权或生产模式切换。真实窗口、事件和回执验证不使用 mock Runtime；前端主工作台、实际模型工具派发、完整文件/网络隔离仍不由这些场景证明。当前 build 通过；常规 Rust 1177 passed / 62 ignored / 4 filtered，40.98s；相关协议/架构 18 passed。fmt 仍为既有 mcp.rs:754，diff check 通过。

### 执行身份与产品选择

推荐继续按“原生后端优先验证，独立 Linux 环境显式选择”推进。不能静默将现有 macOS/Windows Session 换成 Linux；未找到通过原生契约的后端时保持该平台当前失败门禁。容器方案属于需要先审查的新增执行环境，不是修复原生系统的隐形实现细节。

如接受独立环境，冻结 target 必须增加宿主身份与实际执行身份两组事实：host OS/arch、backend/version、guest OS/arch、不可变 image digest、workspace storage ID、source root identity、import revision、工具链版本。runtime/model/result 和前端同源显示 Linux，`cwd` 是 guest workspace，另列原项目目录；输出区分“guest 已修改”“宿主已应用”“冲突待处理”。不能只改变 cwd 后继续报原宿主 Shell 成功。

用户先审查的是上述产品语义：能否接受不同执行系统、独立工作区及同步冲突。接受并不证明同步已安全，也不豁免任何阶段 2 门禁。本轮异步问题尚未授权该变化；用户询问业内做法已即时回答，未代其选择。

### 导入与对象拒绝

容器不 bind 宿主目录；安全输入必须在不受 payload 修改的稳定来源上建立，再导入私有存储。项目内敏感项既按名称拒绝，也按来源文件对象身份拒绝全部别名；普通内部硬链接应保持别名关系，跨边界硬链接拒绝；软链接保留其语义并拒绝越界解引用；socket/device/FIFO 与 credential reference 不导入。项目原有未提交改动属于输入，不能用 git HEAD/archive 丢弃用户工作。

成熟的归档库只能负责格式，不证明输入获授权。可沿用现有 Rust `tar` 处理标准档案，遍历与相对文件访问考虑 `cap-std`，Docker Engine API 采用维护中的结构化客户端（如 Bollard），不用自写 tar、CLI 输出解析或 attach 字节协议。但这些依赖**均不是文件对象授权或外部并发控制的替代品**，本轮不宣称已选出足够完整的安全 importer。[cap-std](https://github.com/sunfishcode/cap-std)

必须选择并实际验证能提供稳定输入/对象拒绝的 OS 文件系统或权限隔离 provider。仅扫描 nlink、canonicalize、先后两次 hash、路径前后检查、watcher 或 advisory lock 不能覆盖恶意并发替换；capability directory 也不会阻止外部进程移动该目录。本轮 APFS 专用卷只解决跨卷别名，未解决敏感同卷别名与初始化读取，不能充当该 provider。不可在没有此证据时自动复制整个项目。

### 安全回写与用户并发改动

每次导入记录来源对象/内容/别名组，guest 结束后导出 typed change set；每个修改具有 baseline 和新内容 digest。宿主未改且对象身份符合契约时才可应用；用户并发编辑保留原样并形成冲突产物，不自动覆盖、恢复、格式化或删除。删除沿用回收站；权限、可执行位、内部软硬链接语义列入变更，不 silently flatten。

普通 cp/rsync/覆盖写入不能作为安全回写。原子替换文件可避免改写旧外部 inode，但会断开合法内部硬链接；有别名的项必须按组处理或暂停，不能宣称保留语义。父目录/root/链接的替换和移动必须由上述经过验证的 provider 在实际提交动作中强制约束；前后再检查路径存在 TOCTTOU。若没有该 provider，允许留存 guest 结果用于审查，但**不能报告宿主已修改，也不能将此降级路径标记阶段 2 完成**。

原目录不自动迁移，不自动删除；容器存储和导出结果按会话维护，能保留并恢复尚未应用的变更。清理存储前确认后台命令已停止，保留用户决定的冲突/成果。不同会话拥有不同 workspace/temp/cache，避免把一个会话的内容或凭据复用到另一个会话。

### 生命周期与失败类别

生产 ManagedProcess 需要容器 ID 级 control，stdin/wait/kill 都绑定 frozen session/target/storage/image。客户端退出只是 transport 状态；cancel/timeout/close 必须先停止整个 container、查询 daemon 终态和后代清理，再报告 terminationConfirmed，最后释放 temp。daemon 不可达、无法确认清理时报告 uncertain 并停止新派发，不能报告成功或重放。正常主命令退出后也核对残留后台后代；应用崩溃/恢复应协调 orphan 容器，不能恢复旧授权。现有 Unix process-group worker 不能直接包 docker CLI 获得这些保证。

拒绝发生于创建前则为 notStarted/policyRejected；daemon、image、storage、attach、seccomp 等基础设施失败单列，错误只含脱敏事实；已启动的普通非零退出为 commandFailed。payload 的 stderr、EPERM 文本或退出 125 不能作为可信策略拒绝证据。运行期间越界需要 backend 的可信诊断，缺少该证据时保留 commandFailed/unknown，不自动扩权、不重放。本轮只有创建/退出状态实验，尚未完成可信运行期拒绝遥测。

### 工具链、网络与日常交互

小项目验证不保证 pnpm install/download、monorepo、native addon、rustup、自定义工具链、完整 ShellSpan 构建或平台产物可用。固定 Linux 工具镜像由受信 provisioning 制作；镜像和缓存不从整个宿主 HOME 构造，模型凭据留在应用侧。离线环境首次依赖准备与需要网络的下载分开；联网必须以后续已授权目标代理和不可绕过系统边界实现，不能开 bridge/network host 临时解决构建。

当前 deny 模式禁止监听，不能宣称 dev server 可用。阶段 3 本地服务授权要开放指定 guest 监听并受控转发到宿主 loopback，明确 guest service、host forwarding 和 probe 的不同权限，不授予任意出站。跨系统路径、大小写、换行、系统库和 macOS/Windows 原生构建属于真实兼容性边界，必须告知并测试。

所有其他 Agent 工具继续统一能力 admission。应用侧文件引用/技能读取不能提前泄露 import 拒绝内容；MCP/SFTP/部署/宿主 probe 不能拿 host 通道替代 guest 请求。现有“拒绝全部受限工具”不能在容器实验成功后整体删除；应只开放已接入实际相同 workspace 与授权事实的工具。

## 历史候选路线的进入条件与清单

本节记录首版路线调整前的候选调查。2026-10-06 用户批准常规原生沙箱后，完整对象 provider、Endpoint Security 权限和 Linux 同步不再是前置条件；当前实现与未完成项以文首为准。

| 清单 | 当前完成程度 | 剩余必需工作 |
| --- | --- | --- |
| 统一执行后端、进程创建前策略 | Bollard 基础实现、生产只读探测及拒绝门禁 | 选择并验证文件对象 provider，完成生产 Direct adapter 和执行身份契约 |
| temp/cache、清理环境、敏感拒绝 | 独立环境局部验证 | 安全来源导入、敏感对象别名拒绝、连续命令/多会话存储、实际工具链 |
| background/stdin/wait/kill/timeout/树清理 | 原生 stdin 修复、Bollard 控制、持久归属、启动取消与关闭/恢复协调 | 生产 Session 派发/存储绑定、无回执债务的可信处理、完整平台与边界证据 |
| 拒绝/基础设施/命令错误区分 | Rust/TS 分类和生产 Direct/admission 结果已接入 | 完整沙箱可信运行期越界诊断、剩余 backend 故障与恢复验收 |
| 真实攻击及日常任务验收 | 14 项边界/反例 | macOS 原生对象边界与日常任务验收、后续 Windows 实机验收；独立工作区如获确认另需安全 import/export |

全部清单仍未勾选。此时增加只有接口的生产候选、删掉门禁或称 permanent unavailable 均无依据。本轮不是阶段 2 验收通过，也不进入阶段 3/4。

2026-10-06 当前范围：桌面仅 macOS 和 Windows，先推进 macOS，Windows 实机环境由用户后续提供；原生 Linux 桌面不是本轮条件。历史 Linux 容器实验结论保持不变，不自动增加 Linux 产品环境。

本轮完成原生 provider 普通能力审查及只读符号探测：macOS 26.7.1 缺少 SDK 标为 macOS 27 起可用的后代 ES 客户端；旧版系统客户端需要 Apple entitlement 和用户完整磁盘访问授权。探测源码通过 clang 的全部警告检查，真实加载系统库，未创建客户端或修改系统。具体安装范围、运行边界、回滚与仍需证明的对象语义见 [macOS provider 接入条件](agent-shell-sandbox-macos-provider.md)。未新增生产 IPC 或不可用后端占位，没有重跑历史边界实验或 GUI 验收。

该次调查尚未满足对象 provider、签名/平台授权、网络边界和生产派发条件。此后首版改为常规原生路线，macOS Direct 已按文首实现；不再等待本文的对象 provider 或特权部署，Windows 实机仍后续验收。独立工作区、特权服务及 Linux 模式均未安装或启用。

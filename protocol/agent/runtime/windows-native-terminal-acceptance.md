# Windows 原生终端续验（2026-10-23 至 24）

结论：延期的 Windows 底层原生终端验收已完成。冻结源码经包缓存清理重建后，PowerShell 5.1 / 7 的前台完整源码、后台状态/原始输出、前台取消隔离、长寿命子孙停止与清理均通过；仓库统一入口最终第九轮 exit0，全量 Rust 和两轮原性能门槛通过。第八轮首轮性能失败及复测条件保留在下文，不泛称所有轮次通过。后台候选继续默认关闭；Windows 桌面/真实模型端到端仍未验收，本次不进入阶段四。

## 环境与可复核输入

- SSH：`zhengbiwen@100.64.0.254`，Windows `10.0.26300.9711`，x64。
- 自有副本：`D:\Developer\ShellSpan-native-terminal-20261023`，未覆盖原项目或其他聊天副本。
- Windows PowerShell `5.1.26100.9711`，PowerShell `7.6.7`，Node `26.5.0`，项目 pnpm `11.1.1`，Rust `1.95.0-x86_64-pc-windows-msvc`。
- MSVC toolchain 仅在本轮进程中选定。早期 ThreadJob 2.0.3 保存在副本 `test-modules`；最终实现使用公开的本地 runspace/PSHost 与 Windows Job Object，不再依赖 ThreadJob。没有修改系统配置。
- OpenSSL 3.6.3 按 Cargo.lock 在同机 MSVC 从 vendored 源码构建。后续通过进程级 OPENSSL_NO_VENDOR=1、OPENSSL_STATIC=1、OPENSSL_DIR 复用该静态库。libcrypto SHA-256：`e2888b00e7f1b797b7a43c457d381537ba139940b177c4b142d56c4fd502af35`；libssl：`27e62de9ee99139eff6b2c17493090dd243c301c44b42e3945b05b332ccde401`。
- Python 3.13.17 官方可移植包仅装在副本 dependency-cache；SHA-256 `0ba1ee4bfcbdc3a559d27e2e9ce76d04a7839947a23f46375872c755c0d463b8` 与[官方发行清单](https://www.python.org/ftp/python/3.13.17/windows-3.13.17.json)一致。python3.exe 为同目录真实解释器别名，未使用 WindowsApps Store 占位程序。
- 最终测试输入清单 `snapshot-manifest-final.json` 共1394个文件，Windows逐字节 SHA-256 全部匹配，清单 SHA-256：`0c9917d3434ae40adea01e13de802704f4b0456ebeff24d1cae9724015000691`。排除构建生成目录和本报告，避免报告引用自己的哈希；其他源文件、锁文件、脚本及协议文档均列入冻结输入。
- 当前工作树 HEAD `b3cd168cb505ac233ba606ba75137c9e412f1fca` 来自其他聊天；本轮没有创建 commit/tag 或推送。HEAD 不能代替包含既有未提交改动的内容清单。

重建后执行程序 SHA-256：Rust libtest `5b366ccb938f9829418251edda603cdda830698ee874e405ff68daa34061204f`；release 性能程序 `f3195c12223cf34e612a5e74cec9e985250a4c9fee77be93f91dde9767645d03`。性能复测和当前完整入口使用相同 release 产物；重建/复测后再次核对1394输入，仍全部匹配同一 manifest。10份关键源码哈希另存 `key-source-hashes.json`。

原始日志、清单、基线及取证包保存在本地忽略目录 `.phase4-acceptance/windows-native-20261023/` 和远端自有副本。

取证包已下载并核对 Windows/本地 SHA-256 一致：

- `windows-frozen-inputs.tar.gz`：`fb27041240b36c7728730e0bb40a242d592e54693705e35354e4d9e41c6aa744`，1394份冻结输入，不包含 gen 或本报告。
- `windows-native-evidence.tar.gz`：`1075f1b8d300b690d6b36f08967b9b1bf297299a76208b5a3149d479d4987822`，包括完整旧失败/最终门禁日志、基线、环境/负载/清理审计、源码清单、原型和只读探针代码。

## 当前实现

1. PSHost 的 Add-Type 保留运行时默认引用，修复 PowerShell 7 缺失 Console 类型的问题。
2. 每个后台作业使用同版本、同实际可执行文件的 console worker，stdout/stderr 继承当前 ConPTY，stdin 关闭；在发送源码/状态前，以持有的 Process.Handle 绑定独立 Job Object。来源、归属、代次和 job-* 句柄仍由现有 Rust broker 冻结，不转 Direct、不扫描或猜 PID 取得生产停止权限。
3. 普通状态以成熟 PSSerializer/CLIXML 传输，并恢复允许类型的标量、枚举、带类型数组、Hashtable 比较器、ArrayList、普通 note-property 对象、变量 Options、函数定义/Options、别名和选项。PS cwd 与 .NET 当前目录分别保留。内部恢复函数留在独立模块中，通过持有的 ScriptBlock 调用；捕获函数时局部屏蔽内部命令的默认参数，恢复用户默认参数后才执行源码，不改父 Shell 配置。
4. 有循环/共享可变引用、任意 CLR 对象、执行型扩展成员、自定义比较器或格式文化的状态明确拒绝。FullLanguage、无调用者断点、StrictMode Off 和非私有模块闭包是守卫范围；引擎身份、版本、实验功能、PSStyle 及原生文化类型在源码前比较。PSStyle 的原生文件扩展字典通过公开索引器读取真实值，未把 Keys 视图当成完整字典或静默丢弃样式。
5. 成熟 Parser/AST.Copy 在源码作用域 finally 捕获 `$?` 与原生退出码，保留命名块和 param。公开 DebuggerStopEventArgs 的 ApplicationInfo 记录实际原生调用；透传的状态 cmdlet 识别真实 ErrorRecord 顺序，因此不把父 Shell 的旧 LASTEXITCODE 误当作本次 Write-Error/throw 退出码，也不清零用户输入状态。显式 exit 由 output-only PSHost 捕获。移除内部跟踪或未知状态保留 uncertain。`#requires` / clean block 在创建作业和源码副作用前拒绝。
6. 原 PSReadLine 历史委托使用 `.Invoke($Line)`，保留原始返回策略。实际临时历史文件验证允许命令被保存、禁止命令不被保存；不再把委托字符串当命令执行并污染 `$Error`。StrictMode 探测使用调用者公开语言行为并恢复原错误集合；拒绝新建不阻断已有作业管理。
7. 普通输出通过当前原生 PSHost 实时渲染，Console.WriteLine 和 native stdout/stderr 直接进入同一 ConPTY。五类标记从 JSON 文件/环境载入，不在源码回显中；独立完成门控关闭且原生查询仍 active 时断言到达。vt100 解析实际原始流，检查 ANSI 红色、CR 回列零与 Tab 跳到下一个制表位。没有完成后 Receive-Job 补显或 PSRP 对象转发替代原始输出。
8. 新终端在原生引导边界调用 SetConsoleCtrlHandler(NULL,FALSE)，修复继承忽略 Ctrl+C 属性的宿主。后台 worker 在独立进程中设为 TRUE，并经私有管道确认后才确认启动；父终端保持取消能力。普通 CreateProcess 子孙继承该属性，显式停止使用对应 Job Object，不以 Ctrl+C 广播停止后台作业。
9. 只有组内 activeProcesses=0 且根进程已退出，才确认自然结束或显式终止。KILL_ON_JOB_CLOSE 保留失去宿主时的清理边界。连接、状态发送和 worker 初始化确认共用5秒预算，失败清理有界；认证到实际 worker PID 的私有管道在交付源码前拒绝竞争客户端，并保留精确句柄的清理证据。

这是合作式终端能力，不是防止恶意源码通过 WMI/COM 等外部服务逃离关联的安全沙箱，也不是任意 runspace/模块私有状态兼容承诺。后台无独立输入接口；没有扩大为禁止任意已批准程序主动打开共享 CONIN$ 的强隔离保证。

冻结源码的两个 Windows `#[ignore]` 原因和能力失败辅助诊断仍保留早期 ThreadJob/Job2/deferred 字样；它们是测试标签/故障诊断遗留，不是当前生产依赖或延期结论。统一入口以 `--ignored --exact` 实际执行这两个名称，生产能力检测已移除 Start-ThreadJob/Job2 要求，默认环境中不安装该模块也可运行。本文与兼容矩阵的当前更新替代历史依赖描述；没有为文案清理中断或悄悄替换正在验证的冻结输入。

## 实际回归

| 本轮原生用例 | 结果 | 范围 |
| --- | --- | --- |
| `native-20261024-024426/jobs-7.log` | 1 passed，139.58s，exit0 | PowerShell 7 完整后台、类型/函数 Options/默认参数、输出与状态、前台取消隔离、子孙清理 |
| `native-20261024-025328/jobs-51.log` | 1 passed，141.92s，exit0 | PowerShell 5.1 同一套门槛，包含原生 VistaCultureInfo 的公开 Clone 恢复 |
| 仓库 `verify-windows-native-job-startup.ps1` | 5.1 / 7 均 PASS | 真实竞争客户端、源码未执行、精确句柄与组清理；不修改或伪造 Win32 返回值 |
| 本地 `macos-process-jobs-final-2.log` | 24 passed / 4 ignored，113.67s，exit0 | 受共享代码影响的整组实际 macOS 回归及前台源码不嵌套的作用域契约 |
| `windows-runner-current.log` | 23 passed，2文件 | Windows runner 的非零/精确测试名、候选仅子进程开启、协议契约 |

以上单项属于各轮功能迭代证据，不默认映射到最终 manifest。最终依据为同一冻结源码/重建程序的 `windows-standard-gate-9.log`，整体 exit0：

| 最终统一入口项目 | 实际结果 |
| --- | --- |
| 5.1 前台 / 后台精确用例 | 各1 passed，4.90s / 157.45s |
| 7 前台 / 后台精确用例 | 各1 passed，6.15s / 131.34s |
| 全量串行 Rust | 1135 passed、0 failed、55 ignored，307.34s |
| 真实启动失败清理 | 5.1 / 7 均 PASS |
| broker/interactive/Direct/兼容性与格式检查 | 统一入口相应非空测试组全部通过 |
| 两轮原性能门槛 | 两轮 PASS，原规模2MiB×5×4、41个延迟样本，未改阈值 |

最终性能单会话 control/broker p95：第一轮138.399/142.101ms，第二轮126.832/136.957ms；broker 事件首字节 p95 0.002/0.001ms，低频 burst p95 0.089/0.098ms。完整四组 profile/吞吐/延迟 JSON 由原仓库解析与验证函数从最终日志提取为 `performance-gate-9.json`。

`native-20261024-004112` 的四个真实 ConPTY 用例全部通过：前台5.1 / 7分别4.39s / 4.50s，后台5.1 / 7分别43.55s / 40.52s。该轮证明普通状态、源码、流、历史策略与当时的停止用例，**不证明后来新增的无期限后代门槛**。

前台覆盖生产 Registry 普通单行、完整 LF/CR/CRLF/Tab/here-string、prefix `&`、原始/实际提交行映射、真实 PSReadLine 能力与缓冲区确认、语法拒绝、取消/接管无残留 Enter 副作用。后台还覆盖 cwd/env/变量/别名/普通函数、前后台并行、多作业、wait 超时不停止、Read-Host 拒绝，以及错误状态基线。独立基线为 `powershell-51-baseline-final.json`、`powershell-7-baseline-final.json`。

## 保留的历史失败与修复依据

新门槛创建根 CMD → PowerShell 子进程 → CMD 孙进程。根、子、孙各有独立文件门控，均无自然超时；ping 仅用于循环节流。CIM 仅用于测试观察，真实进程句柄绑定 PID 和创建时间。停止前确认全部存活，停止后共享5秒期限内必须全部退出且无尾部副作用；最终断言仍要求 exited 和所有句柄收束，没有改成“预期 uncertain”来取得绿色结果。

| 原生测试 | 真实结果 | 根停止后仍存活 | 门控与尾部 |
| --- | --- | --- | --- |
| `native-20261024-010040/jobs-51.log` | FAILED，exit101，44.78s | PowerShell 19044、CMD 39376 | 子/孙门控均关闭，root/child tail均未发生 |
| `native-20261024-010505/jobs-7.log` | FAILED，exit101，57.34s | PowerShell 19120、CMD 11600 | 子/孙门控均关闭，root/child tail均未发生 |

两者属于旧 ThreadJob 实现，生产观察均为 state=uncertain、nativeActive=None。曾以简单托管白名单避免虚报，但该临时限制已被独立 Job Object 生命周期替换；没有将阶段三停止要求收缩为 Start-Sleep/Write-Output。

测试失败后的 Drop 只放行本测试自有门控并等待绑定句柄；没有用全局 taskkill 或猜 PID 的生产停止替代实现。上述四个遗留后代 PID 在后续清理审计中均已不存在。

## 公开原生机制的实际调查

[Job Objects 官方文档](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)说明普通 CreateProcess 后代默认继承关联，TerminateJobObject 可终止关联组；WMI 创建进程存在例外，完成通知缺失不等于组已退出。

已用公开的 [PowerShellProcessInstance](https://learn.microsoft.com/en-us/dotnet/api/system.management.automation.runspaces.powershellprocessinstance?view=powershellsdk-7.4.0) / [CreateOutOfProcessRunspace](https://learn.microsoft.com/en-us/dotnet/api/system.management.automation.runspaces.runspacefactory.createoutofprocessrunspace?view=powershellsdk-7.4.0) 在5.1和7各做实际原型：打开独立空 runspace，通过公开 Process.Handle 绑定自有 Job Object，再接收测试源码。两者都在门控关闭时观察 activeProcesses=3→0，父进程继续运行。证据为 `jobobject-prototype-51.json` / `jobobject-prototype-7.json`，原型代码一并保留。

这个原型不是生产接入：两者 StringBuilder 参数均变成 PSObject，Append 方法丢失；只观察到实时 pipeline 输出及 Information 流，Console.WriteLine 标记没有出现在采集结果中。原型的异步 runspace 释放也出现阻塞，已仅定向结束自有原型宿主。不能用原型组停止成功直接声称原始终端输出、状态继承或资源生命周期完成。

当前生产接入使用上文的直接 console worker 和本地 runspace，避开该 PSRP 原型的类型/Console 输出损失；原型未冒充最终通过。长寿命后代和其他任务存活断言全部保留。

无后台作业的前台取消对照也曾失败：`native-20261024-023217/foreground-7.log` 中 TreatControlCAsInput=False，但缺少结束/提示符确认。最小无集成 ConPTY 探针 `plain-conpty-cancellation.log` 在5.1/7各比较两种初始化：保留继承属性时 cancelled=false；SetConsoleCtrlHandler(NULL,FALSE) 后 cancelled=true，所有 no_tail=true。此属性按[公开 Windows API](https://learn.microsoft.com/en-us/windows/console/setconsolectrlhandler)是进程级且可继承的，不能仅由 processed-input 模式判断。生产修复后的 `native-20261024-023746/foreground-7.log` exit0，7.94s，保留真实取消状态与无尾部断言。

## 标准门禁与派生产物

`windows-standard-gate-4.log` 是旧版本 exit0：完整 Rust 1135 passed / 55 ignored，前台、broker/interactive、Direct/兼容性及两轮性能门槛通过。第五轮在旧版本性能编译阶段为聚焦修复而定向取消，不算通过。当前仓库统一入口已显式加入两项 native_shell_jobs、非零/精确测试名检查和真实启动失败清理脚本；仅这两项子测试进程设置候选=1，其余默认路径保持0，不修改调用者环境。最终新入口结果另列。

第六、七轮因旧的“整段引导源码不得含 EncodedCommand”静态检查失败，不计通过。该契约现限定在前台；后台固定 IPC 引导另有用户 Source/状态不得进入进程参数、绑定 Job Object 后才发送数据的检查。第七轮在文件内容已匹配新清单时仍执行旧测试名，证实保留旧 mtime 的源同步与之前编译时间交错会使 Cargo 复用旧程序。确认旧运行均已退出后，执行 `cargo clean --manifest-path src-tauri/Cargo.toml -p ShellSpan`，仅在自有副本移除包产物1780个文件、9.7GiB，依赖缓存保留。没有修改系统时间或伪造 mtime；第八轮开始具备冻结内容的实际重建证据，完整通过结果仍需独立核对。

第八轮重建后功能部分全部通过：四项 ConPTY 分别为5.1前台5.47s/后台141.57s、7前台6.01s/后台130.93s；全量 Rust 1135 passed / 55 ignored，305.10s，真实启动失败清理两种版本均 PASS。但该统一运行最终 exit1：release 首次编译8m48s后的性能首轮中，单会话 broker p95=323.682ms、control=205.378ms，超过原25%增幅门槛，多会话吞吐也存在明显差距。因此第八轮整体不算通过。

没有改代码、配置或阈值，使用同一已编译 release 程序按原 control/broker 顺序复测两轮、全部场景、原采样规模，原仓库 parser/assertBenchmarkShape/verifyBenchmarkRound 均 PASS，原件为 `windows-performance-recheck.log` / `performance-recheck.json`。复测负载记录 CPU23%、可用内存15407940KiB、D盘0 transfers/s和0% busy，无本轮 cargo/rustc 进程。没有结束未知用户进程。首次波动的具体诱因尚未确定，不将其强行归为已证实的杀毒或虚拟机影响；失败原始样本完整保留。随后第九轮用相同冻结输入与缓存二进制重新执行整个统一入口并 exit0。

最终资源审计 `final-resource-audit.json`：旧失败后代的四个 PID+创建时间身份均无存活匹配，包含自有快照路径的编译/测试进程列表为空。每个成功原生夹具另以实际进程句柄等待及 Job Object 组归零证明自有子孙收束；此审计不扩大为对系统所有未知进程的归属判断。所有运行句柄已取得终态，未留 App 窗口、计划任务或验收服务；源码副本与依赖缓存保留供复核。

Windows TypeScript/Vite 构建通过，输出到独立 `.windows-acceptance-dist`。性能使用原脚本的2MiB/session、5 repetitions、4 sessions、41 latency samples和两轮阈值，没有修改门禁。

5份已跟踪 gen/schemas 文件单列为派生产物，未纳入源码一致性强制覆盖。windows-schema.json 本地原件 SHA-256 `046bbe62f38b417959553944f89c3a16c920f0b85ede4e72a89fd20b83eef438`；Windows 构建产物 `32f7a494d01fbddbce9926763fae14aac324dd13fcefc976d3746f4134267552`。93行 diff 已归档，来自 tauri-build 2.7.0 调用 tauri-utils 2.10.0 的 target schema 生成逻辑，内容为 Tauri/notification 命令目录增补；未手工覆盖或提交本地生成文件。

## 桌面与模型边界

本轮 SSH 为 Session0，交互用户的 Explorer/WebView2 位于 Session1。未启动共享数据根的 ShellSpan 窗口、未运行交互计划任务、未调用模型服务。只读路由计数与 keychain reference 的存在不证明真实凭据或模型连通；未读取或复制明文凭据。

2026-10-24 03:50（上海）只读复核：当前用户 `zhengbiwen\zhengbiwen`，Explorer PID10164 位于 Session1；37个 WebView2 进程，文件版本155.0.4283.62 / 156.0.4314.42；无 ShellSpan App 进程。安全复用入口是当前已通的 `ssh zhengbiwen@100.64.0.254`，终端工具为本地 exec/SSH，远端执行仍是 Session0；自有副本路径见环境节。未据此宣称已经控制 Session1 桌面窗口。

同次 SQLite readOnly 查询：`.shellspan/shellspan-main.db` 有1条路由/1个 keychain reference；`.shellspan-dev/shellspan-v1.db` 为2/2；`.shellspan-dev/shellspan.db` 为4/3并有1条免凭据路由，均存在默认选择。`.shellspan/shellspan.db` 无路由文档。只输出计数与存在性，未解析系统凭据值，也未验证默认路由服务连通。复核原件为 `desktop-metadata-final.json`、`route-availability-final.jsonl`。

现有 `verify-ai-session-stream.mjs --native-jobs` 在 Windows 实际 exit1，脚本限定 POSIX；没有删除平台断言当作通过。后续 Windows 桌面/实际模型、宽窄窗口、审批、争用、关闭重连、Focus/草稿仍需专用真实验收。当前固定 `.shellspan-dev` 数据根不能仅靠改变 Tauri identifier 隔离，启动前需要受控独立数据根。独立 HTTP/SSH 转发缺口、Linux原生桌面及其他架构也保持原状态。

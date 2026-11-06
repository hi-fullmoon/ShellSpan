# macOS arm64 原生终端验收

日期：2026-11-06，Asia/Shanghai。范围为本机四个本地 PTY 组合：Zsh 5.9/ZLE 5.9、Bash/Readline 4.1/6.0、4.4/7.0、5.3/8.3.6。依据[统一验收清单](agent-terminal-input-acceptance-checklist.md)，与 Windows 及 Linux SSH 的证据分别记录。本文不是通过证明。

## 当前授权与边界

用户于 2026-11-06 明确安排“现在可以使用前台，继续 macOS 原生终端验收”。从本次恢复起允许本目标内的原生资源构建、实际 Shell/PTY、原生 App、浏览器、模型及人工交互验收。`SHELLSPAN_ALLOW_FOREGROUND_TESTS=1` 仅传给本次已授权的验收命令，不写入用户配置或默认脚本；App 串行运行，批次使用独立源码、数据和证据目录。此前“先完成编译准备”的限制及其零运行结果保留为准备阶段历史。

生产编辑器准入保持关闭。不提交、推送或发布；不修改用户 Shell、历史、模型配置或凭据。共享代码变化须登记影响及 Windows 补验范围。

## 基线及证据

- 初始提交：`cdc2504cdb29ba6e1fe4395f4f10fab8e18e5f29`；完整输入以实际冻结清单为准。
- 主证据目录：`.artifacts/tests/agent-terminal-input/20261106-macos/`。
- `initial-baseline.json` 保留修改前完整发现清单、Git 状态和工具链。既有 `scripts/native-input-p0/target/` 缓存原样保留；只修正其 Git/测试发现排除，不能将缓存当源码，也不能忽略真实 P0 源码。
- `acceptance-ledger.json` 从统一清单的 Markdown 语法树提取 35 个编号，展开四组合共 140 个记录槽。记录槽不表示已执行或全部适用；适用性逐项核对，缺证据保持待验。
- `compile-summary.json`、各阶段日志及 `compile-snapshot.json` 记录本批次真实检查、退出码、源码及索引核对。结果缺失表示该项尚无证据。
- 初次生成台账时，通用 Markdown 解析器没有 task-list 的 `checked` 字段，数量断言拒绝；修改为读取已解析列表节点中的任务标记，保留原始基线，不改写为首次成功。
- 首冻结为 2070 个源码文件；缓存排除 9 项回归、生产前端构建、主程序 all-features/tests 及两原生库 all-targets 类型检查通过。ZLE 旧制品 7 个来源摘要过期，不能用作当前原生验收。
- 首轮严格 Clippy 失败保留。修正 Windows 启动屏障的非 Windows 生产编译范围、Unix 回调的冗余 unit 类型、本地测试的同身份布尔条件及 ZLE 平台守卫/等待循环；不删测试、不放宽期限或断言、不忽略 lint。新增非 Windows 就绪状态回归；真实终端回归仍待运行时段。
- 原生编辑器独立 `cargo fmt --check` 在三个既有 Windows 示例文件上失败，原日志保留，未批量格式化 Windows 验收代码。主程序及 GNU 库的格式检查另记，不把这些结果合并成全绿。
- 后续修订用 `revised-summary.json` 与 `revised-snapshot.json` 独立记录，不覆盖首冻结或原始失败。首轮驱动的空输入 diff 探针不计入差异验证；后续对实际工作区及实际补丁执行差异检查。

## 顺序与退出条件

| 阶段 | 必做内容 | 退出条件 |
| --- | --- | --- |
| 编译准备 | 冻结源码、锁文件及工具链；核验缓存排除；TypeScript 构建、主程序与两原生库类型检查、Rust 格式/包含及静态边界检查；盘点旧资源来源 | 各检查有实际日志、退出码和冻结范围；资源不能沿用为当前原生通过 |
| 资源重建 | 按固定配方重建 ZLE Core/模块及三 GNU 组合；有效/错误资源准入；随包源码重建与实际加载 | 原生运行时段已安排；来源、摘要、加载对象一致，生产准入保持关闭 |
| ZLE | 正向输入链、历史、后台、争用、取消/提交故障、启动文件、hook/widget、信号与父 Shell 语义 | 对照 B/C/E02 各条提供真实输入、接受、清稿或结束证据 |
| GNU | 三组合的本地五种历史配置及 jobs，共 18 个矩阵用例；额外验证输入边界、父 Shell、拒绝与故障 | 不把 18 项当完整 39 项本地/SSH通过；各专项独立闭合 |
| 显示/交互 | 本批 PTY 捕获、Chromium/WebKit × 默认/WebGL，macOS WebView单列；宽窄、Unicode、选择复制、搜索、视口、切换/重绑、人工输入及 TUI | 真实显示及字节证据一致，人工项不以程序模拟替代 |
| 收口 | 崩溃重启与重复提交围栏、Unix权限、临时脚本/资源/凭据正常API清理、焦点时间线、完整质量检查 | 四组合适用必需项均有直接证据；未决状态与缺环境如实保留 |

## 跨机器及失败处理

Windows 验收不由本批次驱动或重跑。本批修正包括缓存忽略/发现、本地矩阵选择、共享 `SessionCommand::StartupReady` 编译范围及 Unix 原生代码/测试。Windows 构建中仍保留原启动屏障及处理分支；保留双平台测试中的队列屏障验证，未调整 Windows 原生输入、审批、协议或生产准入。Windows 后续源码冻结须包含新配置，独立验证类型检查、Clippy、启动 resize→ready 队列与本地就绪；源码摘要变化按其实际来源清单补验，不沿用本机运行结果。

本地 GNU 矩阵使用 `node scripts/native-input-p2/matrix.mjs --local-only --list-cases` 只读列出 18 项，无须 SSH 夹具。完整 39 项也可仅用 `--list-cases` 列出；列出不创建 App/用例目录或执行用例。实际运行须移除 `--list-cases`，并先满足统一前台门禁及各制品前置；本次仅执行已授权的 macOS 本地范围。

源码、协议、依赖或运行制品发生变化时建立新冻结批次，说明已有证据的适用性及受影响补验项。必需前置失败则停止依赖项。原模型参数不得修改或额外解码；不明操作不得重放；未确认清稿/结束时保留恢复门禁。原失败、原账本和原制品证据保留。

## 编译准备结果

修订冻结为 2071 个源码文件，完整清单和索引见 `revised-snapshot.json`。修订后的 20 个准备阶段均退出 0；这些阶段不等于 20 个原生验收用例。结果文档后置变化另以 `delivery-snapshot.json` 冻结，并逐文件核对其余源码与已验证修订一致。

| 范围 | 实际结果与证据 |
| --- | --- |
| 文件系统及矩阵入口 | 两文件 19 项通过，无失败或跳过，见 `revised-frontend-regression.json`。只读本地清单 18 项、完整本地/SSH清单 39 项；未执行其中任何 App 用例 |
| 前端及静态边界 | 生产构建、Rust include、终端边界、AI样式、LLM目录及真实工作区 diff 检查通过；生产 `productionProfiles` 仍为空 |
| 主程序 Rust | all-features/tests 类型检查、严格 Clippy、主程序格式检查及完整测试二进制编译通过。只执行四个逐名发现的内存状态测试，四项通过；其余测试未执行，不报完整 Rust 测试通过 |
| 两原生库 | all-targets 类型检查通过；后续原生库源码及其共享协议与该检查输入相同。编辑器库和三个精确 GNU profile 的 Rust release 静态库均已编译，摘要见 `native-library-compile.json`；尚未构建/验证 C 模块及 Shell ABI |
| 固定上游输入 | 11 份归档/官方补丁全部与仓库 pin 匹配，留存在修订副本内。Python 首次下载因本机 CA 校验失败，原记录保留；后通过正常 TLS 校验的系统 curl 下载缺失两份，无信任修改或跳过校验，见 `dependency-inputs-curl.json` |
| ZLE Core 源码 | 已执行现有 `--source-only` 入口，固定主 Shell、归档、补丁及三个打补丁后的源码摘要符合 pin；未执行 configure、Core 构建、模块加载或原生输入，见 `zle-source-preparation.log` |
| 浏览器依赖 | 锁定 Playwright 版本对应的 Chromium、无界面引擎和 WebKit 已下载完成，安装后可执行文件存在性检查通过，见 `browser-install.log` 与 `browser-prerequisites-after.json`。未启动浏览器，不提供显示通过结论 |
| 模型前置 | 正常只读路由元数据有可用默认模型与钥匙串引用；0 提供器请求、0 钥匙串读取，不证明提供器连接或真实模型链已通过，见 `route-prerequisites.json` |

`delivery-audit.json`、`acceptance-ledger-reviewed.json` 和 `retention-manifest.json` 汇总编译范围、适用性与独立留存。源码归档须实际解包并逐文件校验；静态库、测试二进制、前端产物和原始失败分别保留。构建缓存、重复快照及编译结果不增加原生验收通过计数。

## 已执行的原生阶段

以下为后续独立冻结批次的实际结果；前面的编译准备记录保持原范围。各目录均位于 `.artifacts/tests/agent-terminal-input/`，原始失败没有覆盖或改成通过。

| 批次与证据 | 实际结果及适用范围 |
| --- | --- |
| `20261106-macos-native-01/resource-build-summary.json` | 在本机重建固定 ZLE Core、C 模块及三个 GNU Shell/Readline/模块/relay，核对 pin 与产物摘要通过。生产准入仍关闭；不等于实际应用包验收 |
| `20261106-macos-native-02/component-summary.json` | 资源准入正反例、默认拒绝、两次真实绑定、11 个 guard 和 14 个 EOF 用例通过。捕获器旧计数与实际 11 个 guard 不一致的问题已修正，回归采样来自此次真实原生结果 |
| 同批 ZLE geometry 原始捕获 | 32、40、100、180 列的 running 轮通过；handoff 轮在 Started 后未于期限内收到结束确认，失败保留。后续独立信号诊断通过不覆盖该失败，未重放原结果不明操作 |
| `20261106-macos-native-02/gnu-component-summary.json` | 真实 GNU 私有 widget 的信号/EOF、Unicode/resize、输出及 OSC 分片边界、本地提交/取消/运行中断四个专项 Rust 测试通过；不替代 18 项 App/模型矩阵 |
| `20261106-macos-native-03/startup-app-codec-summary.json` | 已签名 macOS App 实际启动、原生后端就绪、真实窗口提示符可见，通过。截图保留原始字节，PNG 转码逐像素核对；不证明人工输入、模型或完整 UI 通过 |
| `20261106-macos-native-05/independent-summary.json` | ZLE EOF 的 14×4=56 个显示回放、GNU 的 24×4=96 个显示回放通过。两引擎及两渲染器结果为已捕获 PTY 的显示专项，不是实际 WebView 的完整交互验收 |
| `20261106-macos-native-05/gnu-source-rebuild-summary.json` | 三个 GNU 组合从随包源码及固定依赖在离线条件下重建通过；后续人工批次使用这些实际重建资源并复核摘要。尚不能替代完整打包 App 的实际加载验证 |
| `20261106-macos-native-05` ZLE browser | 与实际捕获绑定一致地启用 Unicode11 和 production 所需 proposed API 后，32 列混合后台输出用例仍不能连续找到/复制完整 source 前缀，失败保留。未替换 xterm 公共接口、缓冲区或源文本 |
| `20261106-macos-native-09/manual-zsh-summary.json` | 真实 CUA 粘贴及 Left、Backspace、补 D、Enter 已送达终端；输出与实际输入一致。本次粘贴链路将分解 accent 组合成 NFC，原逐字节期望失败保留。命令回显有可见错位，不能判显示通过；原始截图与输入、输出、行缓冲证据一并留存 |
| `20261106-macos-native-10/manual-*-summary.json` | 四组合的确切 NFC 粘贴字节、Left/Backspace/补 D/Enter、独立输出行与非 Agent 状态已在真实窗口核对，通过。每项保留 App 映像、原始截图、像素一致转码及实际输入输出；不覆盖分解 accent、emoji 字形、Zsh 命令回显错位或完整 UI |
| `20261106-macos-native-10/zle-quiet-display-summary.json` | 独立执行四列宽的无后台输出原生捕获；随后 16 个引擎/渲染器/列宽组合通过软换行、resize、ASCII 前缀复制搜索和完整 Unicode source 复制。460 个原生及协议输入与原编译二进制的冻结输入逐项一致 |
| `20261106-macos-native-10/gnu-local-matrix-summary.json`、`gnu-local-audit.json` | 本地 18 项全部通过。独立审计核对三个 GNU 组合、每组合五种历史配置及 jobs，108 次真实模型工具调用、36 个实际 App 映像退出；完整源码冻结、源摘要、原生 ABI、历史文件与正常清理结果一致。不包含 SSH 的其余 21 项 |
| `20261106-macos-native-10/zle-live-display-summary.json`、`zle-live-audit.json` | 实时纯输入和后台混合流共 64 项全部通过，覆盖两提示符主题、四列宽、两引擎、两渲染器。128 个观察视图核对了真正接受前完整输入、源码/光标或混合流保全、选择及可见历史视口锚点，并验证退出后恢复显示基线 |
| `20261106-macos-native-12/crash-bash-4.1-summary.json` | 首个 macOS App 崩溃用例在审批前被验收器拒绝，未执行源码、未进行崩溃注入。接口只为临时敏感参数返回副本，普通参数返回 null；验收器已按既有接口契约核对原始模型事件，新冻结 `native-13` 另行运行，旧失败保留 |
| `20261106-macos-native-14/crash-audit.json` | 四组合的真实模型→完整输入→持久意图→Started→核对映像后 SIGKILL→新 App 只读恢复，4 项通过。每项实际源码仅写入一次 ONCE、无 AFTER、原未结算身份不变，重复恢复查询不创建终端/模型请求，目录0700和数据库0600；原 App、Shell均自然退出。不替代更早切点或新提交拒绝验证 |
| `20261106-macos-native-14/zle-packaged-rebuild-summary.json` | ZLE 从随包源码、固定归档及 Cargo vendor 离线重建通过。Core 与原 pin 一致；新模块摘要单独绑定，随后在 `native-15` 新资源冻结及真实签名 App 中实际加载。完整打包 App 仍待验 |
| `20261106-macos-native-16/tui-audit.json` | 四组合均有真实 CUA vi 编辑、alternate-screen 进入/退出及普通 Shell 返回状态0的直接字节和原图证据。联合人工用例3项通过，Bash5.3因工具先产生空粘贴前缀而整项失败，原失败保留；Bash4.1此前的空粘贴拒绝也保留。不证明全部剪贴板行为、Escape键或完整E04通过 |
| `20261106-macos-native-19/frontend-gate-summary.json` | 原仓库路径下完整前端门禁通过：3416项中3389通过、0失败、27跳过，生产构建通过。只修正既有真实记录回归对最终回复节点的定位，不改产品UI。完整源码前后核对一致 |
| `20261106-macos-native-17/quality-core-summary.json` | 主程序格式、include、边界、catalogue、严格Clippy、契约探针、native budget回归及两原生库检查通过。Rust主库1366通过、6失败、99忽略，另5项集成探针通过；6项失败使用Raw终端fixture但仍期待Agent执行，须修正验证路径，不能放宽原生准入。嵌套快照触发的Windows路径预算测试在原仓库路径通过，不修改该安全预算 |
| `20261106-macos-native-20/native-regression-summary.json`、`full-rust-quality-summary.json` | 六项回归改用真实原生输入前置，保留原执行、委派、取消及结果不明断言，6项通过。完整Rust主库1372通过、0失败、99忽略，另5项集成探针通过；严格Clippy、格式和无验证环境选择时的生产默认拒绝检查通过。全套在冻结源码与明确验证资源下运行，不证明未配置原生资源的检出目录可直接运行这些正向用例 |
| `20261106-macos-native-21/ssh-quality-summary.json` | 完整隔离SSH/SFTP门禁过滤器选中10项，10项实际通过，包含本地/远端转发与跳板；只使用UUID标记的独立容器和回环端口，容器已通过正常Docker API清理。与GNU完整39项SSH矩阵分开，不修改用户密钥或信任记录 |
| `20261106-macos-native-24/retained-package-summary.json` | 四组合实际签名release模式App的包内资源加载和真实PTY输出均通过。GNU来自resource_dir，ZLE使用包内、明确选择的验证资源；模块/relay/Core及签名摘要一致，无debug资源回退。此前`native-22`漏传前台标记而在启动前拒绝，0次App执行，保留原记录后复用同一未改写包验证；未发布、未改变生产准入 |
| `20261106-macos-native-23`、`native-25` ZLE App | 实际模型/App的输入中可见前缀取消、提交后不明结果门禁及争用通过。作业原模型多附换行的拒绝、交互参数`inputinputKind`拒绝均保留，不修补原参数。后续独立作业已实际执行，但观察到Workbench被切回terminal，仍为未通过；增加被动状态/焦点追踪定位来源，不能用另一轮通过覆盖该失败 |
| `20261106-macos-native-26/focus-interactive-summary.json` | 使用同一路由已配置的MiniMax-M3完成独立真实交互用例，覆盖前台程序输入、确认、alternate-screen、敏感输入拒绝及新任务；未改全局默认模型或原参数。作业子案完成七次调用后因验收轨迹端点条件不一致未保存证据且退出挂起，整案失败保留，不按控制台成功文字计通过 |
| `20261106-macos-native-28/jobs-trace-summary.json`、`jobs-audit.json` | 新独立ZLE作业用例通过：7次真实模型工具调用、14次租约全部释放、草稿和Workbench/所选终端保持。968条被动焦点记录完整保存、摘要一致、无溢出或本轮违规；两个实际App结束均核验。修复验收端点适用条件和本次服务未结束HTTP请求的退出处理，12项入口/真实HTTP回归、两引擎观察器回归及类型检查通过。`native-25`视图切换原因仍未查明，不用本轮通过关闭原失败 |
| `20261106-macos-native-29/ordinary-history-v2.json` | 普通系统Zsh的7配置对照：默认、小容量、自定义只读路径、空路径、未设置路径、增量追加及共享选项，逐项核对公开历史、原配置与普通exit后的磁盘记录。原观察限制保留在首份结果；修订使用真实括号粘贴、有效种子及Zsh自身历史解析器。该对照没有NIP、App或模型验收信用 |
| `20261106-macos-native-30`、`native-31/history-audit.json` | 原生7配置各执行13项真实操作，公开历史每案观察14次，均普通exit成功，历史选项不变，3条私有poll/stop均不入史。但每案后台启动条目保存了内部job标记和计划包装而非原始批准源码，7整案均失败。首案失败及后续全部差异单独留存，不通过事后删除、强制插入或改历史选项绕过。组件证据不替代App/模型历史或双进程共享历史验收 |
| `20261106-macos-native-31/history-quality-summary.json`、`native-32/ordinary-background-history.json` | 添加受控历史观察后，既有默认原生路径、观察脚本语法、主程序格式、73个include及严格Clippy通过。另3个普通Zsh异步TERM→exit对照确认默认追加模式同样可重复保存先前条目，增量/共享模式没有该重复；不将该普通行为独自归为原生模块缺陷，后台计划入史问题仍未关闭 |
| `20261106-macos-native-33`、`native-34` 存储前置 | 扩展既有真实模型存储夹具到本机四组合；完整入口隔离回归156项和生产前端构建通过。首轮复制整个数据目录将scratch目录0700变成0755，4个实际App在setup阶段被安全检查拒绝、32个故障未执行，审计保留。后改为仅复制已关闭主数据库，运行时正常创建各自私有目录；另一轮默认路由前置拒绝时0个模型/终端用例执行，不重写失败 |
| `20261106-macos-native-35`、`native-36/storage-matrix-audit.json` | 四组合×健康/8故障共36项，独立审计通过。36次原始模型调用均有完整身份匹配的请求审批→批准→执行派发→结果顺序；4个健康对照各一次真实效果、完整输入→持久意图→可能提交→Started→结束事实，32个故障均0效果、PTY输入序号不增且不创建原生输入操作。覆盖数据库丢失、只读、未知版本、坏初始化标记、其他命名空间、目录丢失、真实目录符号链接及损坏数据库，原行和故障状态保留。36个实际App结束核验；不包含更早崩溃切点或重启后的新提交围栏 |
| `native-36/interruption-audit.json`、`native-35/source-applicability.json` | 原进程中断后核实12项已完成；第13项日志为空、无App映像/运行时目录/效果，仅有原复制的已结算种子，故不计执行或通过。新批次只补24个独立项，不重跑12项或重放不明源码。逐文件对照native-20到native-34仅12个文档/验收/测试文件变化，生产runtime与原生模块输入未变；既有Rust全量和签名包结论保留原冻结范围，Windows须独立检查共享夹具增量 |
| `20261106-macos-native-37` 历史接口实验 | 同一固定Zsh 5.9归档和既有Core补丁上，在独立目录实现并编译实验性私有主程序/编辑器接口，保持系统Shell、正式pin、资源及生产列表不变。`history-probe-v2.json`的11个真实PTY接口场景通过，含7配置、用户历史过滤、忽略空格/重复及最终计划篡改拒绝；过滤hook收到原始源码，普通策略自行决定历史保存，没有事后删除或强插。首份观察缺失保留，后续仅在原3秒期限内重试只读widget，不重试接受或执行。该实验没有NIP、模型或App信用，尚未接入正式资源/原生链路，不能关闭native-31的7项失败 |

构建期间定位并修正了真实验收快照中的 Tailwind 扫描阻塞：无 `.git` 的快照包含 `.artifacts/` 中已结束用例遗留的 FIFO，扫描器打开它后等待。共享样式仅增加 `.artifacts` 源发现排除，没有改动视觉声明或依赖版本；回归使用真实 FIFO、真实 Tailwind/oxide 及共享 Button 源码，生产构建通过。原阻塞及零字节诊断分别保留。

人工输入使用新冻结批次单独验证确切 NFC 粘贴字节及真实编辑键，明确不覆盖分解 accent 或回显布局；原分解形式失败不删除。真实模型矩阵已开始，不再沿用准备阶段的零请求统计，具体调用、审批和结果以每个独立用例证据为准。

`protocol/agent/runtime/native-zle-append.md` 明确区分后台输出自然穿插时的完整 combined 流保全，与无后台场景的连续纯源码、搜索和光标。`native-05` 的连续前缀断言失败仍保留原结果；它不能单独证明混合流丢字，也不能替代 mixed-flow 保全验收。后续 `native-10` 已分别通过无后台连续源码以及实时混合流、历史视口验收；没有改动公共 xterm 方法或用前端源码副本补写显示。

## 原生阶段尚缺

- 补全包内资源异常准入及最终包/源码留存审计。四组合随包源码重建、实际签名release模式App包内加载已有独立通过证据。
- 解决 ZLE handoff、普通回显、原App视图切换及后台内部计划入史未通过项。7种历史配置已完成组件观察和正常退出落盘，但整案仍失败；另补App/模型与实际双进程共享历史。ZLE独立交互、作业、争用和取消场景已有通过证据；GNU本地18项矩阵和ZLE显示矩阵也不替代其余专项。
- 补全更早的 macOS 实际 App 崩溃/重启切点及重启后的新提交/输入围栏；运行中App崩溃与重启只读围栏已有四组合证据，实际模型驱动的存储健康/故障准入36项已有独立通过证据。补被动 macOS 焦点时间线，不能复用 Windows 的 Win32 观察结论。
- 完成其余真实显示、复制搜索、键盘/剪贴板、取消接管、恢复门禁、资源及正常 API 清理。前端、Rust完整门禁及独立SSH/SFTP门禁已有上述通过证据；后续代码变更按实际影响补验。保留三个Windows示例文件的额外格式检查失败，不修改另一台电脑的既有验收记录。

## 完成结论

未完成。已有四组合资源重建、实际签名包加载、运行中崩溃重启围栏、存储准入36项，以及GNU本地18项模型矩阵、ZLE实时显示矩阵、独立交互/作业场景和本机完整质量门禁的相应冻结范围通过。四组合TUI行为已直接观察，联合输入用例仍有失败；ZLE handoff、普通回显、原App视图切换原因、后台内部计划入史、App历史、早期恢复切点及其余验收收口尚缺。7种ZLE历史配置仍保留7整案失败，私有主程序历史接口的11项实验通过不替代正式链路。生产编辑器准入保持关闭，不提交、推送或发布。

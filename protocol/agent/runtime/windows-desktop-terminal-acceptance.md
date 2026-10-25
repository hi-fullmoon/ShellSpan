# Windows 桌面与真实模型续验（阶段四独立验收）

本记录不替代[阶段三冻结底层验收](./windows-native-terminal-acceptance.md)。截至2026-10-25，本机Windows原生完整门禁、全量前端及真实模型桌面用例已分别通过，保留各自源码、二进制和运行边界，不合成为旧组合轮次通过，也不宣布所有平台矩阵完成。下文默认关闭、ThreadJob及失败/待验描述均属于各自历史冻结版本。继续使用原 checkout，HEAD 为 `b3cd168cb505ac233ba606ba75137c9e412f1fca`，未暂存、提交、打 tag、推送或发布。

## 当前验收结论

最终完整文件集合复查发现，旧Windows1316项清单没有本任务的`scripts/__tests__/llm-route-document-schema.test.mjs`和`src-tauri/examples/analyze_native_output_trace.rs`。旧记录仍只证明其原冻结范围，先前仅按已有清单逐项比较而得出的“整个当前树仅文档差异”结论撤回。前者验证本阶段路由导入的实际schema/catalog/null契约；后者仅离线解析已保存真实流，不进入生产终端或模型执行路径。两份文件均保留并同步Windows，现已完成真实schema专项、诊断example实际构建、1318项清单及完整前端补验；未删除或改排除规则，也未重复不受影响的原生/模型/性能。

保持PSReadLine现有着色和预测，实际窗口取证已查看；本机为Windows x64/build26300，Windows PowerShell5.1.26100.9711/PSReadLine2.0.0及PowerShell7.6.7/PSReadLine2.4.5。支持的本地Windows Shell正常默认开启native jobs，新Shell显式`SHELLSPAN_NATIVE_POWERSHELL_JOBS=0`回退；仍以真实`nativeJobControl`能力为准，不隐式Direct、不重放输出或未知命令。

| 独立记录 | 最终结果与范围 | 归档SHA256 |
| --- | --- | --- |
| `windows-native-complete-normal-20261025` | 完整正常路径原生脚本、Rust1140 passed/58 ignored、两Shell长任务及严格计数/拒绝、真实编辑器中断、Direct/交互/raw/启动拒绝清理、两轮原性能阈值通过；diagnostic=false，明确未执行全前端 | `7e5983a073cfba0b0b4cd8332a0e5f436f41150dc48e576b49ab6d22ea86ee4e` |
| `windows-frontend-final-normal-20261025`（旧1316项范围） | 原`pnpm test`2609 passed/6既有skipped，290文件通过/1跳过，585.85s；不证明当时未同步的两份文件 | `66f9f30823eb7c613123be3b7b969fa6bca1c622fae7622b3c2c6a2f59b38b90` |
| `windows-frontend-complete-tree-20261025`（当前完整集合） | 原`pnpm test`2611 passed/6既有skipped，291文件通过/1跳过，610.78s；schema专项2项、诊断example check及实际build、构建/includes/样式/模型目录均通过；原15000ms/4workers不变，明确未重跑原生 | `8f36f508e4c6e92ca44ee9fd54fdbdf293aee2ec13411b7e59cbfb6118814296` |
| `current-7-tool-contract-second` | 真实M3/PS7/Session1/default、7 native+5显式Direct、21原生source cells/BUFFER、14租约释放、停止前显示后更高revision仍active再真实stop、Focus草稿与实际窗口着色 | `cf9996c48a5dcc9e099e944798ffbe3d5ada4e2d0cae752e461333b87291f538` |

原生门禁和旧前端记录各自1316项清单前后一致，两者当时共同范围仅本记录不同。当前前端补验为1318项，完整包含上述两份新增输入；前后292个实际测试文件覆盖审计通过。新轮Source/参考程序/App摘要、默认历史和原用户数据前后相同；App仍为`08bffb11d9fc63abfd6e6a906af0a1aea97ef990cb831be635997b9363a6c576`。按相同10目录及16个根文件枚举完整文件集合，明确排除Finder/AppleDouble元数据后为1294项；双向added/deleted/changed均空对应补验冻结时点。验证后仅四份交接文档更新，当前added/deleted及代码、测试、配置差异均空；不将文档更新表述为全树零差异，也不再用单向清单代替全树证明。诊断example实际构建的源码SHA为`b0617e96f6a48c6bd8e1ccdf3b0a6e360cd7d64f050003eb611a22f919ce4be2`、exe SHA为`c75ea875f7143e15347d7a46144739ac359ead50318f28db853b5cb4eb27f434`，只作离线诊断工具，不外推为生产运行证明。模型/原生生产代码保持原字节与验收；各阶段App哈希分开记录。

本机目标的已有通过范围无需重复；Linux原生桌面、其他架构和既存独立HTTP/SSH门禁仍未验收，Windows真实Shell exit重连不证明idle-timeout。跳过/忽略项不作为通过。旧默认历史增量、只读SQLite共享内存差异和失败轮次保留，未恢复或清空用户文件。

诊断工具的检查层级分开记录：门禁内`diagnostic-example-check`是`cargo check`通过；归档另含收尾后的`diagnostic-example-build.json`及日志，实际执行`cargo build --example analyze_native_output_trace` exit0并记录上述exe哈希。未运行该离线诊断程序，不将类型检查或链接成功外推为诊断运行/生产终端验收。

## 复查证据与历史门禁边界

以下按每轮结束时的实际状态记录；历史“待验”及失败不覆盖上表最终独立结果，原组合失败也不因后续通过而改判。

当前重连与争用另有四个完整归档：`current-51-reconnect`（SHA `3fa79b84d0fe535d5b1e6665c68598db9128df88cb7ded85ff02cdb00b96cf4c`）、`current-7-reconnect`（`6e5626b66c765720fa36d649bab2fd685f925277e875b875888c80ab7708978b`）、`current-51-contention`（`4f7ada2bbf28285300a91a68c7a72d5a5eb487de7d97fc921d7b9039633b8b71`）和`current-7-contention`（`785041d61927b47379968abf20ff6fd76b20a07336ca144faf71d918acb577a4`）。四轮均Session1、实际exit0、1221份源码及原数据/历史审计、任务及自有进程树清理通过。重连为真实Shell exit/Enter、三次重绑定、原Agent草稿/历史恢复和伪造ancestry拒绝，无模型调用，未证明Windows idle-timeout；重连初始化与模型/结束二进制属于不同阶段，不宣称各阶段同SHA。争用为真实双Agent同PTY，5次工具调用/结果/操作、20份租约、完整Unicode草稿、手动重试、同时提交仅一个获得租约、接管及运行中关闭，四次迟到只读刷新后仍ended；两轮争用各阶段App二进制一致（`1c0eb08f24e42325033a6e10c775a8e2282a5dac85f610fb408dfd5a2a52de7d`）。

完整门禁的后续失败均保留原件：

- `windows-final-complete-20261025`：前端2608 passed / 6 skipped、构建和静态检查通过，Windows Rust全量1140 passed / 58 ignored；5.1后台长任务通过，7前台在原测试初始5秒内未收到R/P/Q而失败。部分归档SHA `62dfbd4e3a53ffaad2f0811739e10f850aacf9548176b8fa2ffed4f44e6449dd`。另一次只观察诊断在8983ms收到R，仍重抛原5秒失败，不能回填该门禁的时序。
- 初始冷启动测试窗口统一为30秒：该阶段实际编译原生console receiver，与既有原生桌面readiness及后台初始化窗口一致。产品初始化15秒为提示时点，执行前readiness仍为5秒；数据接收2秒、执行及后续prompt期限均不改变。此修正只针对测试初始冷启动，不把旧5秒失败改为通过。
- `windows-final-startup-phased-20261025`：前端、构建、静态检查、Windows Rust全量及5.1长任务通过；7前台通过，7后台首个launch在源码执行前被拒绝，原始输出明确为`Native job state capture exceeded three seconds`。保持原三秒状态捕获限制，正在记录各阶段耗时定位。该轮另因诊断脚本在冻结后发生变更，源码收尾审计失败；source-after已保存实际差异。部分归档SHA `44710be4cd876ca6941cbc0814b848e4239c32f2be046f7b9f6a985187efc626`。不可据此宣称固定源码的完整门禁通过。

测试历史边界另行核对：早期原默认PowerShell历史586115B，后续未隔离的raw/interactive/smoke测试曾追加，最新基线588779B、SHA `63460db52c9d1191c9484eac0389246bc884b856fc0232834a7da251d95a6956`；未恢复、清空或导出原内容。当前共享Windows测试helper在首次ReadLine前设置并通过公开API核对独立HistorySavePath，已在5.1/7的真实raw ConPTY用例确认；后续每轮继续单独审计默认历史。不能把当前不再增加表述成早期从未修改。

真实raw历史隔离归档分别为`raw-history-private-51-final`（21份源码，SHA `102ce4ea369fae10f22c607ab5f453ec3f24547f8097cfda5b8fb8c3fc528de7`）和`raw-history-private-7-final`（21份源码，SHA `7baf45c00d70be3984aa9471f1e21359c36c8a352c589629616c6e9fa1730e1d`）。`failure-only-standard-51-first`为5.1真实长任务1 passed / 122.25s，21份源码，SHA `7d855d96b06f09998805761e1f1558d25ca0130460642fb7f2532d587bca970e`；正常路径不持久化诊断流。三轮各自源码/执行二进制冻结和默认历史前后审计通过，不替代完整标准门禁。

状态捕获后续诊断：`state-capture-phase-observation-7-first`为1 passed / 143.19s，21份源码及执行二进制/默认历史冻结审计通过，归档SHA `afa67da3ef0052e4003a92baab5f817ecb3a84cd7b60fbb09939c2acbb326fd7`；该轮没有复现三秒拒绝。另一次同机NoProfile基准实际调用生产样式/版本/文化检查，首轮累计2017ms、后续795–814ms，其中默认runspace准备仅17–122ms。改用公开的[成员类型筛选API](https://learn.microsoft.com/en-us/dotnet/api/system.management.automation.psmemberinfocollection-1?view=powershellsdk-7.4.0)替代逐成员PowerShell筛选管道后，同类累计时间为313ms及30–37ms；5.1为177ms及27–28ms。此为真实局部基准，不能相加累计列、当作完整launch通过，或倒填原失败的分段耗时。

优化保留每处成员类型集合、NoteProperty处理、未知状态拒绝、每次读取调用者状态和原三秒上限；没有缓存调用者状态或移出捕获时钟。`state-members-match-7-first`真实长场景1 passed / 122.00s，21份源码及二进制/默认历史审计通过，归档SHA `7b1988f24e9702a3abf261171a3a515c2ed25117ae99f00c26b97e8b25a27689`。后续更严格拒绝原因、成员未求值检查及完整门禁尚待结果。此前四组合桌面/模型证据绑定其各自源码；此次生产PowerShell修改后的受影响模型显示也须补验。

诊断工具自身的5.1失败独立保留：`state-members-rejection-reasons-51-final`（SHA `46ebcfe56ed48708434cb46602e5094ed95a66e2bb42785b489421d4f27e7b07`）和`state-capture-generated-source-51-first`（`7e7d9ee4ef85eda0ab1dffccbb9bdcaf59fe245a6cbaec7bd0d4567d5de122f6`）。后一轮保存的静态公共job-start函数显示插入offset没有数值倒序，原命令被切成`Microsoft.PowerSh`与`ell.Utility`；这是测试诊断插入的问题，不是生产扩展成员拒绝。原元数据`originalFailureUnchanged=true`在这两轮不成立。当前使用显式整数排序和严格降序检查，并在写入前核对生成前后原CommandAst及捕获语句AST的完整顺序；只导出静态公共函数，不导出包含control secret的完整bootstrap。后续完整门禁关闭诊断开关，直接检查正常生产路径。

`state-members-reasons-sorted-51-final`为1 passed / 125.58s，21份源码及二进制/默认历史审计通过，SHA `07740de1deec9d40e96eab7f76464b2bf1026fc77ac84e06b74322f3066200e4`；具体拒绝原因、源码效果文件不存在及前台继续执行成立。但当时的成员访问计数检查没有断言退出码，不能作为“成员未被求值”通过证据。计数器初始化、计数检查及清理的退出码断言已补齐，正在以当前用例复验，旧轮次不改判。

`state-members-reasons-ast-7-final`为1 passed / 112.36s，21份源码及二进制/默认历史审计通过，SHA `6c88e784201b0835a6366d50401d5303824ceb41f10737381dd9d011c7941e1f`；加入了写入前的原始命令/捕获语句AST完整性核对。其计数退出码断言同样尚未补齐，不作为“成员未被求值”证据。最终标准runner已同步两种Shell的真实`editor_data_interruptions`用例；协议/runner/schema的26项回归通过。

当前计数断言版本的5.1复验为`state-members-counter-asserted-51-final`：1 passed / 127.77s，21份源码、执行二进制及默认历史前后审计通过，归档SHA `0532ec9c413df88fafae79199c03f37398db4bae819c46af0fb540451f166d18`。实际Add-Type初始化、各次计数检查及清理均断言exit0；六类实际扩展成员按具体原因拒绝，源码效果文件不存在、成员访问计数为0、前台恢复、原始AST完整性、状态继承、长输出和停止通过。7的当前计数断言版本仍由关闭诊断的完整标准门禁验证。

受影响的生产模型链路已补验：`current-7-members-model-final`为Session1/exit0，默认开启、真实PS7/MiniMax-M3、宽Focus及显式Direct。7次native调用、14份租约均释放，21行原生source cells及BUFFER逐SHA匹配；停止前捕获1792896533507ms，随后同job更高revision7仍active（1792896535697ms），再真实停止（1792896539221ms）；末条exit7。5次Direct、精确stdin/stdout、生产Focus真实键盘草稿均通过。实际199×40→78×38，本轮没有行数增长，不替代原四组合的增长/窄容器范围。真实窗口已查看，着色保留。1221份源码在before/initialized/after逐SHA相同；初始化及模型App同为`ffa9a96a6fd750add0966d2f67cb6c6f525eabe75539d2ea033e5ad1422aed3e`。原用户数据、默认历史、自有任务/两阶段进程树清理和归档复核通过，归档SHA `fa5d5116317a44479edf1b55e9f85020c2265e9a73ba37d4ae02db64d2aedd05`。完整标准门禁仍单独待验。

`windows-final-members-normal-20261025`完整失败归档SHA `11827135db5ff0c75dc3bb932bfa6429da23438c7d491cc8e0626e885738474f`：预编译通过，前端2605 passed / 4 failed / 6 skipped，4个文件失败，总耗时715.96s。除证据目录中误收集的runner暂存副本import失败外，release-review、AiWorkspaceController两项及SettingsPanel一项实际触发15000ms超时；标准原生门禁尚未尝试，不能记为原生通过或失败。1221项清单前后一致，原数据及两种默认历史收尾审计通过。补充实际Vitest发现清单为292项，含1个自有暂存副本；另有合法capabilities测试未在旧冻结清单内，已保留缺项审计原件。

收尾后两份自有暂存源经原冻结canonical SHA核对，保留改名为`.transferred-source`，未改Vitest排除规则或删除正式测试。冻结清单补入`src-tauri/capabilities`和`vitest.config.ts`，新增实际测试发现清单与冻结SHA的覆盖审计。3个超时相关文件在Windows按原15000ms上限单独运行135项全部通过（56.90s），macOS同组135项通过；不据此倒推原超时原因或改判原全量失败。产品工具描述中旧“default-off guarded candidate”已同步为受支持Windows默认开启、仅依实际`nativeJobControl`请求后台执行及新Shell显式`0`回退；单次请求`background`默认前台不变，相关模型工具契约5项通过。描述变更后的模型及完整标准门禁仍待最终结果。

实际发现输入预检在保留改名后为291个文件，全部覆盖于扩展后的冻结映射（missing/changed均空）。为补齐超时复验材料，`frontend-timeout-subset-recorded-20261025`保留完整Vitest JSON及原始日志、当前测试/配置/依赖清单SHA和前后源审计：3文件135项全部通过，exit0，原超时未改，1225项源清单前后一致，归档SHA `336340dbae455e65ff8cf1f1c295f6ea234842e3a56a3ab158c6e0cac26abc1a`。该轮资源观察为16逻辑处理器、约32GiB内存、约13GiB空闲；不能据此补造原超时当时的负载。旧1221与当前1225的差异包含补入的配置/权限目录和审计脚本，不是源码删除或原轮全输入已覆盖的证明。

描述更新后的第一轮`current-7-tool-contract-final`仍为失败（SHA `9b74a9a1eae95746c2938dfc2b2843c34f4bc797212b3fc683d601471b799c28`）：7次native事件为completed，随后模型为第一个显式Direct请求给出不合法的`lifecycleTrust=direct`，原schema按`cooperative`/`directRequired`枚举拒绝，命令未执行。未修改模型参数、放宽枚举或改判整轮；Source/数据/默认历史及自有任务收尾完成。

相同源码的新隔离会话`current-7-tool-contract-second`已完整通过：Session1、default rollout、PS7/MiniMax-M3、7次native、14份租约全部释放、21行独立原生source cells与BUFFER SHA匹配。停止前捕获1792898422636ms，随后同job revision7仍active（1792898424938ms），再停止（1792898429672ms），末条exit7；显式Direct5项通过，stdout逐字节为Windows原生`received:direct-stdin\r\n`，Focus真实草稿保持。真实199×40→78×38，无新增行增长范围；实际PNG已查看着色保留。1225项Source前后/初始化逐SHA相同，初始化/模型App同为`256e5ab7479f7f55ad80d78f33c9e2405ec43210acf63edd81ca6fde604de6a1`；默认历史、原数据、任务与两个阶段自有进程树清理及归档复核通过。归档SHA `cf9996c48a5dcc9e099e944798ffbe3d5ada4e2d0cae752e461333b87291f538`。最终完整标准门禁继续独立运行，前后均校验实际测试发现清单与冻结源覆盖。

`windows-final-contract-complete-20261025`仍失败，归档SHA `496d17344d0574cb78cf3b55f146296c0701755f6c1b21785095ef7b1275e8e3`：291个实际测试文件的覆盖审计通过，前端2608 passed / 1 failed / 6 skipped、524.57s，仅`release-pipeline.test.mjs`的真实Git/git-cliff历史用例超过15000ms；此前4个超时用例已通过。标准原生阶段尚未执行，1225项源清单、原数据及默认历史结束审计一致。后续先独立运行正常路径完整Windows原生门禁，不能让此独立前端失败被省略，也不能将未执行的原生阶段记作失败。

发布用例首次诊断runner因单字符串splat被展开为逐字符文件参数，实际范围不符；已保留真实argv及创建时间/owner进程树，定向终止唯一自有树，结束观察remaining=0，未冒称单文件复验。修正为显式`string[]`后，真实单文件框架exit0、13 passed / 1既有GitHub草稿跳过，目标Git历史用例2050.89ms；旧helper因误要求无跳过而标记ok=false，原结果保留，以框架及范围解释，不覆盖。

仅优化该测试的真实临时Git夹具：用官方fast-import按UTF-8字节数建立相同6次真实提交/3个标签，保留实际cliff.toml、实际git-cliff与全部原断言，并增加提交数和标签断言；没有改发布产品逻辑、测试15000ms或并发配置。本地13 passed / 1 skipped；Windows保留完整JSON/日志的单文件复验同为13 passed / 1 skipped，目标用例1376.74ms，源清单前后匹配。此次测试夹具变化不覆盖前述模型通过的生产代码。冻结输入另补入公开的工作流、发布文档/说明、cliff配置及portable-pty补丁依赖，私有用户配置和凭据不入归档。

正常路径独立完整原生门禁`windows-native-complete-normal-20261025`已通过，归档SHA `7e5983a073cfba0b0b4cd8332a0e5f436f41150dc48e576b49ab6d22ea86ee4e`。`installerDiagnostic=false`，Windows完整Rust1140 passed / 58 ignored（298.95s）；5.1/7真实长任务均通过当前具体拒绝原因和exit0计数断言，两种Shell的`editor_data_interruptions`、raw ConPTY、前台/交互/Direct及原生worker启动拒绝清理均通过；实际两轮broker性能比较通过。构建、includes、样式、模型目录与前后291项测试输入覆盖审计均通过。扩展1316项公开源清单前后逐SHA相同，实际App/参考程序冻结，默认历史和原数据收尾相同，App SHA `08bffb11d9fc63abfd6e6a906af0a1aea97ef990cb831be635997b9363a6c576`。本轮明确`frontendTestsExecuted=false`，不能代替完整前端结果或把原组合失败改判。

夹具修改后的本地全量前端为2611 passed / 6 skipped（291文件通过、1文件跳过，76.05s）。Windows优化后的全量前端另开固定输入轮次执行；原2608 passed / 1 failed仍保留为失败，未因单文件/本地通过而消除。

`run-51-default-wide-36` 的真实工具、后台停止及停止前源代码捕获已通过，但最终切回源终端时完整 source cells 失败，整轮仍为失败，归档 SHA `e08eb89ee9bb0384c87c18c5f1dfdfbce5338fc332b6e3d82629cc371d29db18`。原始 ConPTY 流的离线回放支持 xterm 行数增高兼容问题；回放的初始几何及 resize 插入点来自诊断搜索（`geometryCandidatesAreDiagnostic=true`），不能倒填为该轮已记录的真实 resize 事件。

当前修复通过 `SessionSummary.ptyInfo` 传递后端实际 transport kind 与 sysinfo 读取的 Windows CurrentBuildNumber，在创建及重连时设置 xterm 的 `windowsPty`。仅本地 Windows ConPTY 启用，SSH 不继承；元数据不持久化，不依赖 broker rollout 开关，不硬编码现代 Windows build。保持 PSReadLine 着色和预测，不添加、过滤或回放输出。新的产品实机轮次记录实际 xterm resize 的时间、尺寸及当时已接收输出长度，并重新验证独立原生 source cells、用户滚动和原生窗口。离线诊断及参数单元检查不作为实机通过。

当前已完成的默认开启组合如下；每轮均为 Session1、worker/task exit0、真实模型7个 native 工具、停止前完整源代码捕获、同一后台任务更高 observationRevision 的后续 active 观测、随后真实 stop execution。完整源码归档与 before/initialized/after 摘要匹配，原用户数据及默认历史前后摘要一致，自有任务和进程树完成清理。

| 组合 | 实际几何与显示 | 其他结果 | 归档 SHA256 |
| --- | --- | --- | --- |
| `run-51-conpty-wide-44`，5.1 / 宽窗口 / Workbench | 实际记录199×40→199×38→199×40，最后增长前已有9483字符输出；13行独立原生 source cells 全相同，原生窗口着色保留 | 14份租约释放，真实键盘草稿和焦点保持；5个显式Direct操作通过 | `e29d2388b0475aa4d4e640436d9f4fd14e7bb3a097a4ce51f35c6eb832a68711` |
| `run-7-conpty-wide-41`，7 / 宽窗口 / Focus | 实际记录199×40→78×38；21行独立原生 source cells 全相同，原生窗口着色及生产Focus草稿可见 | 14份租约释放；5个显式Direct操作通过 | `4644d2b184a3067c3d563002c77866a115054ab74000b770c89b9d6414106b61` |
| `run-7-conpty-narrow-43`，7 / 窄容器 / Workbench | 实际记录79×40→79×38→79×40，增长前已有9663字符输出；21行独立原生 source cells 全相同，原生窗口着色保留 | 13份租约释放，生产Workbench草稿和焦点保持 | `17653280a46ce2922823d31ab8df88d3adbef4b91b871af8114c73c3f7258d2b` |
| `run-51-conpty-narrow-45`，5.1 / 窄容器 / Focus | 实际记录79×40→79×13，缩小前已有10224字符输出；21行独立原生 source cells 全相同，包含scrollback；13行视口截图保留着色 | 14份租约释放，生产Focus草稿和焦点保持 | `2a6e74675cc6549308e611552c9839e6853bbbf865c82f0e7c8e8c3999831d77` |

四轮均1229份源码，每轮的 before/initialized/after 逐SHA匹配。两轮宽窗口初始化/模型/结束实际 App 二进制同为 `49bf403777377a8166ee7dde669f4dd768b0e2ec8d5c5352f1905d08c0e3943a`，两轮窄容器各阶段为 `55a4562806728f4702b165a9bb3ef4668182abdd2ede080fa1229bcafbac59cd`；renderer 与后端报告均为 ConPTY/build26300。窄容器是应用内600 CSS px容器，原生外窗仍为2242×1426物理像素，不能称作OS窄窗口验收。宽窗口证据外层旧 `transport=localPty` 是旧的本地分组标签，不能当作真实 transport；实际类型由 `rendererTransport.ptyInfo` 与 broker 提供，后续脚本已直接记录 broker 的 transportKind。

`run-51-conpty-narrow-42` 为真实模型未遵守原文的失败：here-string漏掉Tab字面词并插入反斜杠引号，严格原source审批在后台source执行前拒绝。整轮worker exit1、源码及数据/历史审计完整，归档 SHA `8bea35a161d16436c4fc65b69d6a97c1ba87698813b2418881d98b6803f9590e`；不计为布局通过，也不记为ConPTY缺行复现。保持原检查并以新目录续验，没有重写模型参数。

`run-51-conpty-wide-40` 在 App/模型前任务中断，缺少 worker-result、原始 before 历史/数据审计，不能宣称该轮完整清理或数据前后不变。部分归档 SHA `89508e6c985cc27bd190d1e07f98da886a98ecb8230510b08d92ea3f9e2aaa3e`；后来观察明确标记 post-crash，不能替代缺失的原轮收尾。

历史 `windows-standard-default-final` 前端测试为 2604 passed / 6 skipped，构建、includes、样式及模型目录检查通过；标准 Windows 终端门禁最终失败，Rust 全量为 1139 passed / 1 failed / 58 ignored。失败位于既有 `diagnostic_json_capture_redacts_escaped_credentials_before_snapshots` 启动 `python3` 的 `PermissionDenied`，尚未进入脱敏断言。该轮收尾源码冻结也失败，缺少 source-after 及后续原数据/历史审计，部分归档 SHA `68dc51e380bd80ba9540470864320f87973c2a4d053aac365ea58c99e975acac`，不能宣称整轮源码及数据前后不变。当前已准备签名有效的独立官方 Python 解释器供进程级 PATH 使用，不修改默认 WindowsApps alias 或跳过测试；最终门禁仍须以固定源码重新执行，并分别完成源码、历史及数据的收尾审计。

显式回退在当前实现重新运行：`explicit-rollback-51-conpty-final` 为1 passed、5.17s，归档 SHA `0d593ab456b1d4c359b2be7322f933465fd5b8979c7d6f2ff5c62d33d532cd2e`；`explicit-rollback-7-startup-diagnostic` 为1 passed、7.68s，归档 SHA `e1061bae03c0a2822ee58a879b425b98cc66fc3cda1584d31ded05ae84ace8bd`。两轮均实际父环境为 `0`、K=false、nativeScriptInput=true，真实 broker 在发送后台 source 前返回 `TERMINAL_BACKGROUND_UNSUPPORTED`，效果文件不存在，普通前台完整脚本通过；16份原生输入源码、执行前后二进制与默认历史摘要匹配。

7的旧 `explicit-rollback-7-final` 在5秒内没有R/P/Q而失败，原件保留，未确认其环境原因，不归因为CPU。新诊断只记录原生事件时间；只有原期限失败后才允许继续观察且始终重抛最初失败，不能因此转成通过。本轮实际R=1895ms、P=1914ms、I/H=1928ms、K=false/Q=1929ms、ready=1930ms，原有5000ms启动期限未变，数据接收的2000ms及执行期限也未变。

本地受影响的共享路径回归为 Rust 1182 passed / 57 ignored、前端2611 passed / 6 skipped，构建通过；includes、样式边界及模型目录检查通过。Focus自动聚焦现保护调度后新进入的外部编辑器，真实Focus草稿和显式Direct已复验。这些本地结果不替代剩余 Windows 实机与标准门禁。

## 隔离与实际接入

使用同一自有 Windows 副本 `D:\Developer\ShellSpan-native-terminal-20261023`。SSH 为 Session0；每轮通过独立命名的交互任务在已登录的 Session1 启动 worker、Tauri App 和真实 WebView。每个新目录、Config、task 和 worker-result 校验同一 UUID；拒绝已有目录/结果，外层检查真实退出码、worker.ok、SessionId 和数据审计，失败不会返回成功。只清理本轮精确 taskName 和自有 CLI 进程树，不操作未知进程或解锁屏幕。

`SHELLSPAN_DATA_DIR` 显式配置独立的绝对目录；默认无配置时仍使用原开发/生产目录。已验证路径后创建并固定实际目录，数据库、known_hosts、原生集成文件和相关应用文件使用该目录。Tauri identifier 另使用 `com.shellspan.validation.windows-stage4`，独立隔离 Agent artifacts、WebView 及日志；单独设置数据目录不足以隔离这些存储。

无密钥路由文档通过完整仓库 JSON Schema 校验后导入，保留原 credential reference，由正常系统凭据接口和真实模型请求使用。不转储或复制密钥、密码、token、完整用户数据库、其他 preferences、profiles、sessions 或 pending credential 操作。当前导入流程先由实际 native backend 初始化独立空库，随后只更新合法路由文档，不执行源库 DDL。先前轮次的导入方式及失败原件保留，不映射为后续版本通过。

原用户 `.shellspan`、`.shellspan-dev` 以及原 Tauri identifier 对应 Roaming/Local 目录进行前后文件 SHA 审计。第五轮实际 worker-result 为 Session1、exit1、originalUserDataUnchanged=true。真实模型选择为现存开发路由 `route-b78a44f1-0b22-49eb-8fc1-5b869e0e0c5e` / `MiniMax-M3`；模型返回实际工具调用并完成真实审批/执行，未以存在路由引用代替模型连通。

### PSReadLine 历史隔离补查

上述第五轮 originalUserDataUnchanged 只覆盖当时列出的应用目录，**不包括默认 PowerShell 历史文件**，不能表述为全部用户数据未变。后续只读补查确认默认文件为 `C:\Users\zhengbiwen\AppData\Roaming\Microsoft\Windows\PowerShell\PSReadLine\ConsoleHost_history.txt`，586115 bytes、SHA `ce933f90f1fdec54287cb5ddf88ef6c5161fb871dffc222ed4abf4d16aa1017b`，本轮独有 `SHELLSPAN_NATIVE_WORKSPACE` 标记出现2次；这不是新增完整历史记录数。没有打印、转储或复制原历史内容。早期独立 plain ConPTY 对照同样曾使用默认历史路径，不能漏记其边界。

当前实现已为显式独立数据目录的 Windows Shell 在首次 ReadLine 前设置独立 HistorySavePath，并保持原 HistorySaveStyle/AddToHistoryHandler；布局参考和 plain 对照也分别设置自有历史路径。应用路径的5.1/7实际隔离及前后审计已通过，`reference-history-fourth` 也已完成两种 Shell 的布局参考及 plain 对照四个真实进程检查（见下方归档）。原文件尚未删除、清空或重写，不猜测删除用户记录。

## 保留的轮次与因果

证据目录：`.phase4-acceptance/windows-desktop-20261024/`；远端同名目录下每轮独立子目录保存 task、初始化/导入/模型日志、前后用户数据摘要、worker-result 和 task-cleanup。

| 轮次 | 真实结果与边界 |
| --- | --- |
| run-51-first | Session1 实际启动；完整 route schema 拒绝文档，未启动 App 或模型。外层失败，自有任务移除，原数据摘要不变。 |
| run-51-second | 修正 schema 中与 Rust Option 序列化不一致的 null 契约后，合法开发路由导入成功；Windows 命令包装层截断 JSON 配置，Tauri 未启动。改为 Node 直接执行项目 Tauri CLI；未取消校验或删用户字段。 |
| run-51-third | 当前源码编译实际 App，真实模型发起精确审批。旧验收 setup 改写 prompt 导致集成钩子被替换，实际返回 uncertain，整轮失败。后续改用正常 Set-Location 形成长提示符，不再重写 prompt。 |
| run-51-fourth | 7次真实 execution/result 均 completed；实际 Workbench/另一终端/29B草稿边界成立，native job active、stop和末条exit7确认。但 raw 含独立 marker、target xterm最终不含，显示断言失败；原件 `run-51-fourth.evidence.json`。不能计为显示通过。 |
| run-51-fifth | 7个真实可视工具、13份租约释放、完整原生 source cell/BUFFER SHA、提前实际输出与5个显式Direct工具通过。真实窗口 PNG已生成，但截图取证脚本 Get-FileHash 不可用导致整轮exit1；不是整体通过。原件 `run-51-fifth.evidence.json` / `run-51-fifth-window.png`；该 PNG另存在取证进程DPI虚拟化裁剪，后续修复线程DPI坐标，不将此旧图冒称完整窗口。 |
| run-51-close-sixth | Session1、exit0、ok=true。真实前台命令运行中关闭、两种执行面持久cancelled/ended、4次迟到skills/files刷新仍ended、无关终端保留、实际Shell exit后关闭、幂等重复关闭通过。无模型调用，**不是TMOUT空闲超时**。407份审计条目一致，包含原默认PowerShell历史；独立history为110B，只归档元数据。证据包 `desktop-close-sixth-evidence.tar.gz`，inventory明确为post-run观察，不伪装pre-run冻结。 |
| run-7-close-seventh | Session1、exit0、ok=true，同一真实关闭范围通过，无模型。按实际PowerShell7.6.7 / PSReadLine2.4.5发现默认HistorySavePath；该机与5.1相同，但不是以5.1路径替代发现。独立history及扩展前后审计通过，实际Shell exit，不是idle-timeout。原件 `close-7-seventh.evidence.json` 和远端同名run目录。 |
| run-51-reconnect-eighth | Session1、exit0、ok=true。真实Shell exit/断开、Enter重连、原Agent身份/草稿、重复重连、关闭面板后的只读历史恢复、后端拒绝伪造ancestry通过；无模型调用，未证明Windows idle-timeout。 |

首次布局工具构建未固定工具链而选到 GNU，缺失其要求的 ssl 库，已失败并保留记录；通过精确已确认的自有父子身份终止该构建，未杀未知进程。后续使用阶段三相同 MSVC 工具链和静态 OpenSSL 缓存，实际构建新布局程序成功，不以旧缓存或旧 App 替代。

## 历史验收：早期原生显示对照（2026-10-24）

独立 `native_powershell_output_baseline` 在实际无集成 ConPTY 中执行第四轮同一 Source，SHA `843ccc4e659eadca581c21bf65a79bf930db3a953472fdef5c8b0c306f50e7ad`；5.1/7均实际退出0。原件 `plain-output-51-second.bin.json` / `plain-output-7-second.bin.json`：最初 marker可见，随后普通 PSReadLine 输入覆盖；`Get-Location` 对象后的文本直到实际门控释放后才由原生格式化器显示。这些早期对照为192×40、父提示符为用户 home、短普通 poll，不等价于第四轮199×38、长 cwd 提示符及完整 accepted carrier 的滚动条件，不能据此断言产品或编辑器在任意情形正确。匹配几何与提示符的后续对照另行记录。

生产修复使用公开 PSReadLine InvokePrompt 重定位实际编辑器；原生事务的空/非空 checkpoint及最终提交均保持同一 BUFFER/cursor，重绘前后逐字校验。重绘只调用原 prompt 显示，不伪发 E/P/I/Q，也不解除 broker 的身份、序号或 sticky 门禁；已有非空用户输入不启动原生事务。它不是工具结果补显，实际输出仍来自同一 ConPTY，不把独立参考流写入 App。

独立 `native_editor_layout` 当前通过公开Replace插入实际accepted line，验证native BUFFER SHA并记录原生绘制，绝不AcceptLine/执行Source。目标xterm仍逐行逐cell比较；独立参考本身不能算模型/桌面通过。真实后台完成门控在stop审批前保持关闭，实际目标已显示marker、alias/function独立输出行和here-string/Tab；作业最后观察须仍active，随后才批准真实stop。参考程序最新源码仍需重新构建并实机复验。

持续输出回归仍在执行与审查：真实15ms生产者逐行编号，并在门控释放后写入自身完成计数；在长多行/Tab输入期间保持active。最终使用成熟VT100、足够scrollback和相邻cell跨列匹配核对所有编号，不用 raw-only 到达断言关闭此项。窄列、已有用户输入、无伪生命周期、无重放和实际模型窗口矩阵尚不能据此提前宣称完成。

持续显示的真实失败分别归档，不能归并为通过：

- 首轮旧字符串比较：156产生，失败；存在比较器不识别物理换行的限制，原件 `native-continuous-51-first.log`。
- 跨列cell第二轮：17份输入前后均匹配 manifest SHA `dbafad84dc302c060b69411eba772f593ac334b7b6f3924caea6947f1086f10c`，180×30，144产生、40保留、104缺失，exit101。完整 raw 292068 bytes、producer count、完成的3954字符输入和缺失编号保存在 `continuous-grid-second.windowsPowerShell.continuous.bin/.json`。离线成熟VT分析证实第1行先可见，随后被再次绘制的长输入覆盖，并非仅物理折行。
- 原生批量 Insert 第三轮：17份输入前后均匹配 manifest SHA `d9fa5d3b44c90de4727a979bb60a8dcc6afbcfe067e6f9689ffb0f748c8cb841`，144产生、143保留、缺76，exit101；完整 raw、计数和状态在 `continuous-batch-third.windowsPowerShell.continuous.bin/.json`。改善不算通过。它不代表随后更改的当前源码已通过。
- 无Enter数据终结第四轮：147产生、143保留、缺5/24/61/111，exit101；17份输入 manifest SHA `4ffb670b82cfb6279e0aeb07a06f3b6aec4ff6c9862ce5af856606b5596df034`，完整流/计数在 `continuous-no-enter-fourth.windowsPowerShell.continuous.bin/.json`。输入安全与显示完整性是独立要求。
- 整屏滚动第五轮：159产生、152保留，缺30/72/90/111/126/136/137，exit101；manifest SHA `1d4c9b102d4199bf793664745d07704e6f5d774cfa83ec16f5d10476911ab20d`。失败且引入空白/阅读扰动，该实现已定向移除，不作为最终方案。
- PowerShell7简化原生渲染对照：实际163产生/163保留，后续普通多行输入边界仍失败，整轮exit101、164.34s；不是整体通过，未应用为产品渲染。先前最终日志尚未返回时误判断可能挂起；定向终止脚本发现目标进程已退出，**没有执行进程终止**。实际机器为PSReadLine2.4.5；5.1为2.0.0，没有同一公开选项。该选项会关闭着色/预测，已按用户UI规则询问是否允许，仅准备对照，不据此改变普通用户UI。

当前Windows数据批次使用既有A的只读就绪/完整前缀确认和公开PSReadLine Replace，数据仅经框架Base64/UTF8解码，不执行数据。数据终结为不提交的私有键序列，批次不携带Enter；接收中或未确认时取消/超时/接管必须保留恢复门禁。5.1/7首次原生故障/恢复专项在旧512B接收版本已通过，精确范围与归档见下节；这不替代当前候选中断复验、普通完整脚本、持续输出和桌面模型矩阵。

## 输入中断专项与重连新增证据

原生接收器在有界接收期间将 Ctrl-C作为输入处理，实际中断批次读至非提交终结符后调用公开 CancelLine，再读取真实 BUFFER发送A。接收不确定时保持 sticky恢复门禁；后端不再重复发送Ctrl-C打断Shell随后正在形成的提示符。没有伪发P/Q、以空字符串冒充BUFFER或清除未确认门禁。

- 5.1：`faults-no-double-interrupt-tenth`，1 passed、8.82s、exit0。14份源码前后SHA一致，原始Cargo产物中的测试exe SHA为 `bf496dcb778877d28a7f9c8f57cb1807bf9956a01536159c26dda43d45a7a402`。
- 7：`faults-no-double-interrupt-seven-first`，1 passed、11.50s、exit0。14份源码前后SHA一致，实际测试exe SHA为 `987bee3d5736ff374d2524fc04f28f8450a1247aeb6ee9e0fc19717ddd758372`。

两轮均使用真实ConPTY部分交付当前批次，覆盖cancel/takeover/deadline/物理Ctrl-C。实际无副作用、完整BUFFER为空、释放真实turn后User Enter仍返回RECOVERY_REQUIRED；同一terminalSessionId按1至5递增generation，各新代际均真实执行独立命令，旧transport拒绝输入。cancel/takeover返回各自结算；deadline及物理Ctrl-C保留原记录中的RECOVERY_REQUIRED错误，不冒称已获得可信命令结束或PromptEnd。物理中断的原生`^C`可见不用于解除隔离，仍另行读取完整BUFFER并验证新代际恢复。

本地归档分别为 `faults-no-double-interrupt-tenth.evidence.tar.gz`（SHA `5eca8aa5d7f0bffe54ad111dccfcfb2dc86c5660add12df579494b471d9490df`）及 `faults-no-double-interrupt-seven-first.evidence.tar.gz`（SHA `d0e21189f28778b3739939a074e8f027f9444bcbc11f729298f76a11356a79e7`）。包含14份匹配源码、before/after manifest、实际Cargo JSON/二进制元数据、原始日志、5代原生流、完整interruptions/progress JSON、实际选定Shell的默认历史前后元数据及当时执行的wrapper。原wrapper在返回exit0前实际核对结束二进制SHA，但当时没有另存结束时JSON；后补观察明确标为post-run。5.1二进制随后已由7轮重建，后补观察不再匹配5.1旧SHA，不能假称当前exe仍是5.1原件。`interruption-archive-audit.json`保留这一区别；后续wrapper已增加独立binary-after记录。

PowerShell7实际App重连第九轮 `run-7-reconnect-ninth`：Session1、exit0、ok=true，真实Shell exit、Enter/重复重连、原Agent身份与草稿、只读历史恢复、ancestry拒绝通过；无模型调用。worker、task/cleanup、实际选定7历史元数据、前后用户数据审计及完整初始化/运行日志在本地 `desktop-reconnect-ninth-evidence.tar.gz`，SHA `77bf1aeb37872ae87777f0bdeb3d0f699d89412aa6f031d40a111e79bad9f907`。与第八轮一样，该轮尚未采用新增的完整源码pre/post冻结，不能倒填历史源码或binary-before记录。

## 历史验收：Focus草稿诊断（2026-10-24）

5.1第十轮及7第十一轮均实际启动两个模型Agent并进入争用，但因Focus完整草稿断言失败而exit1，未计通过。7诊断确认同一编辑器持续连接且保持焦点，期望的两段文本只剩最后一行。真实Chromium中普通contenteditable保留完整文本，生产Lexical在多行execCommand的多次input事件中丢失首段，onChange与受控value回写均晚于该变化；键盘insertText及逐行键盘/Shift+Enter对照保留完整文本。当前证据尚不足以修改产品受控草稿逻辑。

后续第十三轮实际Windows WebView原生键盘诊断通过，完整两段草稿逐字一致。生产组件与验收组件中的临时trace hook随后已移除。第十五轮PowerShell7真实双模型争用整轮exit0，包含完整草稿、人工重试、同时准入、接管、运行中关闭及四次迟到只读刷新；原件 `run-7-contention-fifteenth.evidence.tar.gz`，SHA `0fced0ba501723eebf895524d19ce16457a8ab9f07727dfd481383d998714391`。源码pre/initialized/post一致，初始化与模型App分别编译、分别记录二进制，不能表述为同一冻结exe。该轮成功证据尚缺完整工具调用/结果及租约与artifact摘要，后续正式轮次须补齐；第十四轮5.1运行中关闭前置条件超时仍为失败。

用户已明确要求“保持现有着色，继续查找方案”。简化渲染不会作为产品方案；原有语法着色与预测保持不变。

## 历史验收：大批次接收诊断（2026-10-24）

当前候选将原生输入数据批次上限设为8192 UTF8 bytes，仍维持2秒接收期限。公开PSReadLine Replace替代Insert，因为PowerShell7的Insert会将CRLF规范化为LF；BUFFER确认继续逐字匹配原始输入，不放宽换行断言。

`readkey-receiver-statistics-first`是旧Console.ReadKey接收器的受控诊断，整轮失败，不计产品通过。最大carrier首批接收在2000ms超时：读取4714个编码字符，未到终结符、decodedUtf8Bytes为0；原生队列仍有17383个事件，PSReadLine预读队列为0。诊断只输出计数、时长、异常类型和线程状态，不记录键内容。该结果定位了逐键读取在原期限内无法读完大批次的问题；不能据此推定持续输出已经正确。

当前候选使用Win32批量读取原生输入事件，并在消费前查找私有终结符以保留其后的真实按键；没有改变原生渲染模式或延长期限。临时旧接收器注入诊断已从测试源码移除。`foreground-bulk-replace-7-third`实际完整前台专项1 passed、7.78s，包含CRLF和8192B Unicode输入；当前宽窗口持续输出及大carrier结果见下方独立记录，窄窗口和模型桌面矩阵仍待完成。第十五轮模型争用和前述旧中断通过均绑定各自旧源码，不能扩展为当前批量读取候选已通过全部验收。

`jobs-bulk-replace-51-first`整体exit101、13.50s。真实A确认8190字节首批及9870字节完整carrier，随后实际S/E:0；此后断言读取提交前的作业对象，acceptedCommandLine仍为None。测试已改为返回broker查询的实际作业对象，原失败保留。源码与二进制前后SHA及选定Shell历史元数据均一致；该轮不能计持续输出完整性通过。

本轮本地补查通过：26项协议/Windows运行器/schema测试、47项终端控制器与关闭逻辑测试、17项原生执行回归、TypeScript类型检查及生产构建、Rust格式与56份include文件检查。Windows分支运行和实际桌面补充工具链取证仍单独续验，不由本地构建代替。

`jobs-bulk-replace-51-second`实际整轮1 passed、124.59s、exit0。180×30，8192B原始source经真实多批次carrier交付，完整BUFFER确认并真实执行；持续输出214产生/214保留，missing=[]、duplicate=[]、ordered=true。源码manifest、测试exe前后SHA及实际5.1默认历史元数据均一致；测试exe SHA `20844f27d8f99133d960f23220329540e94afafedc5ec31b273c9919b2cc56e9`。原件保留于同名before/after、binary/binary-after、history-before/history-after、build、log及maximum-carrier/continuous bin/json文件。它证明该宽窗口原生专项，不覆盖窄窗口或当前候选的模型App。当前完整前端回归2607 passed、6 skipped，291个测试文件通过、1个跳过。

`jobs-bulk-replace-7-first`实际整轮1 passed、119.01s、exit0，同为180×30，持续输出251产生/251保留，missing=[]、duplicate=[]、ordered=true。两轮均保留既有着色与预测，16份源码匹配前后manifest，测试exe结束SHA及实际选定Shell历史前后摘要一致。本地包含匹配源码与原始记录的归档分别为 `jobs-bulk-replace-51-second.evidence.tar.gz`（SHA `7d498bfaef3ba4bd476433018ad0c47b742d02b0b77a4fb7cf42d9b1a9e310d2`）和 `jobs-bulk-replace-7-first.evidence.tar.gz`（SHA `fbd75fed5a6068f9fc3c87862efa75a4c91d228d9e58bfc88ca40345f7aab88e`）。当前完整本地Rust回归1180 passed、57 ignored、59.22s；这些忽略项不计实机通过。

当前批量读取候选的中断专项复验：`faults-bulk-replace-51-first`为1 passed、9.57s、exit0；`faults-bulk-replace-7-first`为1 passed、10.49s、exit0。仍覆盖四种真实中断、未提交副作用禁止、完整空BUFFER、sticky门禁及同terminalSessionId新代际恢复。两轮16份源码/二进制前后SHA和选定Shell历史摘要一致；匹配源码与完整原始记录归档SHA分别为 `430f9d4ac8cb26f03bfa8265345be4af088c93ea8a47ddd9ebf86075659083d0`、`4e745a5379c10fd3c36cfa6d343e2aa807d8c267e58d74f2d58bf7cb22977ac5`（归档名为各轮名加 `.evidence.tar.gz`）。

上述大批次阶段当时尚缺窄列持续输出、完整模型App矩阵、完整工具链取证、参考程序历史隔离及默认开启/回退检查，作业仅在显式开关下运行。该历史边界不覆盖后续轮次；当前状态统一见本文开头。全程未启用产品简化渲染，未创建commit、tag或推送。

5.1当前完整前台专项 `foreground-bulk-replace-51-first`为1 passed、5.04s、exit0，覆盖完整脚本、CRLF/裸CR/Tab及8192B Unicode输入。源码、二进制及默认历史摘要前后核对通过。PowerShell7对应5.1同一行为的前台专项已在上文按其实际源码版本单独记录，不合并两轮源码身份。

## 窄列、公开输入记录与接管后重绘续验

- `jobs-cells-narrow-51-third`：32×30，整轮1 passed、112.16s、exit0；真实持续生产189行，189行均保留，missing=[]、duplicate=[]、ordered=true。包含8192B原始source、多批实际carrier、长提示符、CR/LF/Tab、前台与原生作业控制。匹配16份源码、二进制/历史前后摘要与原始流归档SHA为 `c329d7b4998b3fd6ec1832d43189cc2e51b71909aa6a87a9a2d106e06a1b364a`。先前两轮窄列提前输出检查失败保留；离线真实xterm确认普通输出完整，而PowerShell错误格式化器在窄列加入行填充。当前只对这两种格式化错误允许空白，普通输出和编号仍逐cell精确检查。
- `editor-public-keys-51-second`与`editor-public-keys-7-second`分别1 passed、9.52s/13.69s。正常批次和中断批次的终结符后紧邻真实Unicode用户按键，BUFFER逐字相同；已有非空草稿时只读探测拒绝Agent，未写入源码或清理键。7的首轮构建因另一专项持有同名测试exe而LNK1104，未运行用例，不计产品失败或通过；后续串行复验。
- `reference-history-fourth`：最新布局参考和plain对照在5.1/7共四个真实进程均exit0。程序读取并验证自身实际HistorySavePath；布局参考不提交源码，历史文件尚未创建，plain的自有历史分别604/579B，仅归档路径/大小/SHA。实际选定Shell的默认历史前后摘要相同。原始流、程序源码及前后source/binary摘要归档SHA为 `b03ba48f504450d62603dcfea10768a6f9b9cc41c6f2f9f2c1ed806a2a9f04fd`；参考结果不回放App。

`run-51-contention-sixteenth`在完整真实草稿、人工重试、同时准入和运行中接管后失败。下一条关闭验收命令期间broker收到P，原因为`promptDuringUnsubmittedInput`；没有降低实际running前置条件。CLI失败清理后COM任务为控制台中断退出，缺少worker-result/source-after/audit-after，不能宣称完整清理或整轮通过。后补观察明确标记post-crash，只证明观察时原数据和默认历史摘要未变；源码已因后续修复有4处差异，不冒充原轮结束时冻结。部分证据归档SHA为 `87c7140ce541c2b8b64775c1594dce7fe78ebc6df6d20f85b204b291b3abe462`。

后续本地门禁实现显式记录source可能入队的边界，在与取消/接管相同的串行门中、transport回调之前置位；回调结果不明确时也保持该事实。只读探测遇P后必须等Q并排空旧A，再请求新的A；已有source时的首批/后续批次/等待S/不明确入队仍为uncertain、sticky、noReplay，迟到A/P和User Enter不能解锁。19项原生执行状态回归已通过，不能代替Windows实机。

原生接管→清屏→下一命令基础对照在旧实现也通过，因此未据此宣布第十六轮修复。把真实清屏放在初始A之后、数据就绪探测之前，则`takeover-clear-readiness-pre-fix-51-first`可重复失败，9.30s，明确`sourceNotEnqueued`。当前候选区分PSReadLine公开InvokePrompt的编辑重绘与主Shell提示符，依据公开方法的类型/方法身份，不读私有编辑器状态；已知重绘调用原prompt文本，不发送E/P/I/H/K/Q。PSReadLine自身ClearScreen调用InvokePrompt的行为见[官方2.0.0源码](https://github.com/PowerShell/PSReadLine/blob/v2.0.0/PSReadLine/Movement.cs#L492)。该候选的实机后续结果仍须独立记录，不能因为状态测试通过而收口。

### 编辑 API 内部重画的进一步复现

只识别公开InvokePrompt仍不足以关闭实机缺陷：`run-51-contention-twenty-ninth`在完整真实键盘草稿、人工重试、同时准入和接管后，再次于下一条关闭验收命令失败。完整tool/result保留`TERMINAL_INPUT_RECOVERY_REQUIRED`，broker明确为`sourceMayBeEnqueued`；门禁没有放行、补零或重放。该轮完整失败归档SHA `85350b6e74de7a3124ca7c438b73bcb922d8aeafc85aefd4888775a0346711ed`。

PSReadLine2.0在编辑起点因尺寸变化移出缓冲区后，会从内部Render直接调用GetPrompt，并不经过公开InvokePrompt（[官方Render源码](https://github.com/PowerShell/PSReadLine/blob/v2.0.0/PSReadLine/Render.cs#L608)）。新原生用例真实运行前台任务并接管，在初始A后送入真实清屏；首批source已入队而尚未写入ConPTY时，通过实际MasterPty和broker将80×25改为145×49，然后交付长输入。`resize-render-pre-fix-51-first`实际失败，9.84s，原始before/after、16份匹配源码、实际binary摘要及原生流归档SHA `4bffafb03da245ef928d6006cf50060e6f78f30c8c2f08985825c6753e83d219`。

修复只在明确的同步Replace、AcceptLine/ValidateAndAcceptLine、CancelLine调用范围内设置编辑重画标记，并在finally恢复旧值，包括嵌套情况。没有全局忽略ReadLine或broker的P；API返回后及源码真正执行后的主prompt保持正常S/E/P/Q。完整BUFFER仍来自GetBufferState并逐字确认，不通过空BUFFER或尚无S推断安全。

- `resize-editor-scope-51-first`：1 passed、9.98s、exit0；归档SHA `b725028134546f2fc5ec011db246f9563f9fdf123284791a42e7bbed0cacf2c3`。
- `resize-editor-scope-7-first`：1 passed、21.08s、exit0；归档SHA `990126a0589881d173888ceacfa7cbc894b9f0d357be4ba869e307bb56ac0716`。

这两轮均包含上述真实清屏/缩放/长输入、完整源码确认及实际文件写入exit0；真实host prompt只增加1次，编辑器重画不冒充新生命周期。四类中断、非空用户草稿与终结符后真实Unicode按键仍通过。归档含实际执行时的source-before.tar.gz，不能用后续源码倒填。

### Session1 输入环境与证据补强

独立隐藏CLI控制台可让失败轮次完整收尾，但第22/23/24轮因自有App不是前台而拒绝发送键盘。只读桌面探针确认Session1输入桌面为Default、可访问、无LogonUI；未解锁、关闭或输入其他应用。第25轮原生caption激活假设不成立（应用原本移除原生边框），第26轮自有标题栏激活仍未获得前台，均非产品通过。

改为独立可见CLI控制台后，第27轮App在输入前已是前台，activationInputEvents=0，514个真实键盘事件保留完整两段文本及中文/emoji，未调用模型。第28轮已移除全部激活/鼠标实验代码，再次通过：`run-7-plain-composer-twenty-eighth`、Session1、exit0、ok=true，原数据/选定默认历史摘要一致，归档SHA `400245284408f4ae82cc8127085082b0d57c20b7b3e677bdd80cf7f51f920dcf`。输入工具保留发送前后前台窗口和进程身份校验，包按UTF-8读取；不绕过保护。初始化及模型阶段共用固定验证窗口配置，仍实际调用Cargo并分别记录二进制SHA，不指定跳过编译的旧exe。

当前正式双模型续验另行记录，不能用上述无模型输入轮次替代。Native jobs验收组件也已将非Focus的测试textarea替换为生产Workbench编辑器；显式Direct完成后才结束工作区监控，再显式查看源终端、等待实际几何匹配并取证cells/窗口。审批匹配同时核对turn/step/call，artifact实际字节重新计算SHA，避免跨turn复用callId或只信元数据。尚未执行的矩阵不据此计为通过。

### 限定编辑作用域后的真实双模型通过

`run-51-contention-thirty-first`和`run-7-contention-thirtieth`均为Session1、exit0、ok=true。完整真实键盘草稿、人工重试、同时准入、运行中接管、实际running条件下关闭、两个关联Agent持久cancelled/ended、四次skills/files迟到只读刷新仍ended、无关终端及幂等关闭均通过。未降低运行中关闭前置条件；源码可能入队后的未知P仍由broker隔离。

两轮各1218份源码与source-before.tar.gz逐SHA匹配，before/initialized/after一致；初始化及实际模型App二进制均为 `4da0d823513762e5d55179d4e0f76610bf2d0e5ab5b13822decaafbb2585c0b3`，属于固定验证窗口配置下的实际Cargo构建记录，不以当前磁盘exe倒填历史。完整tool/call、tool/execution、tool/result、operation/lease身份、完整持久工具日志及实际artifact字节摘要均保留；原数据/默认历史前后摘要一致，任务移除。归档SHA分别为 `608c39f641bcc7a8e95aabf59a4c3e371beb246003ec19509c356d7ee753e88d`、`0c4430407d855ffd90aff3a9ac72a91c614ce32abd9e8cfa86dc13d2e397a1ac`，本地independent-audit.json另行复核。

随后窗口矩阵第18轮只完成实际空路由初始化，未运行模型；taskkill树清理报错，后查自有PID均已消失，该轮仍保留失败。新清理脚本先验证自有CLI的parent/PID/executable，记录完整后代PID/创建时间/路径，调用系统taskkill后重新查询同一身份；只有全部消失才接受幂等完成，真实残留继续失败。第32轮初始化清理实际记录10个自有进程、remaining=0、taskkillExitCode=0。

第32/33轮已使用生产Workbench编辑器，首个真实命令完成后工作区切换成功，但execCommand草稿注入未进入内容；第33轮明确记录connected/editable/focused、Workbench、370×52、actual为空。未改回测试textarea、延长审批或提前批准后台；第34轮改用同一受控token、一轮一次、精确自有App/严格前台校验的真实SendInput通道进行对照，结果单独续记。此处尚不计完整矩阵通过。

以上历史轮次的未完成项不能覆盖本文开头的最新验收矩阵。原有本地/SSH Bash/Zsh、Focus/草稿、争用/关闭/重连、历史会话和移除补显证据继续保留在[主计划](./visible-terminal-unification-plan.md)。Linux原生桌面、其他架构及既存HTTP/SSH转发缺口保持原边界；不从Windows或隔离SSH结果扩展为这些组合已通过。

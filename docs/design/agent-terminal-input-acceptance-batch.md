# 原生终端验收批次候选工具

更新于 2026-11-05。本候选只修改验收工具、回归和说明，不修改生产终端、协议、审批、权限、编辑器准入或验收标准；`productionProfiles` 保持空。旧 `windows-package-smoke.mjs` 入口保留。

当前状态：用户已授权生成修正布局的新测试包；新包的两个 Windows 宿主普通子案、可见终端截图、运行映像/资源、隔离目录与正常清理均已通过。本结论只覆盖该冻结生产修订及验收夹具修订，不代表工作区后续生产改动、实际模型链或全平台验收通过。旧包的白屏失败和原始结果均保留。

## 构建、运行与复用

`windows-package-batch.mjs` 分开记录资源准备、前端构建、NSIS 构建、安装核验、逐案运行、封存留存和卸载核验。同一兼容包可串行运行两个 Windows 宿主的 `ordinary`、`model-semantics`、`model-validation`、`model-file-chain` 子案。首次实机验证只选择两个 `ordinary` 子案，不因工具重构重跑已有模型链。

每案独占 data、HOME、WebView2 目录、身份和证据，每次 App 启动另有独立 token。包内测试 loader 只接受一次受控配置；宿主与场景来自预列映射。构建时固定的报告 origin、安装路径、CSP 和制品身份不得在复用时放宽或替换。端口无法按原配置绑定、安装路径已存在或任一相关输入不匹配时拒绝复用。

显式 `--reuse-package-from` 只引用已完成构建的留存二进制，不恢复旧操作、会话或账本。制品冻结源码与控制器冻结源码分别登记，需有匹配的 `--controller-root`。制品 source/index、依赖、工具链、配置、前端、资源及二进制摘要均核验；旧批次若存在执行或清理不明状态，不得作为可复用来源。新运行批次使用新用例目录与身份，旧失败结果不改写为通过。复用保留原二进制、原 SHA-256 和来源，不把不同重编译结果称为字节相同。

`snapshot.mjs --windows-resources-from` 是新增的受限资源复制选项。它核对来源快照、只读索引、catalogue、原生源码和复制前后完整资源摘要；确为相同输入时复制原 Core 字节并登记 `recompiled:false`。真实原生输入变化仍拒绝复用。默认冻结和重建路径的核验保留，不修改旧快照补摘要。

## 输入核验与调度

`acceptance-inputs.mjs` 登记明确的 native、frontend、package 输入根。完整源码/索引冻结与重建输入判断分开；报告不属于 Core 输入，JS 工具链也不无故使 Core 重建。一次 checkpoint 合并扫描三个阶段的输入，共享文件只读取一次，再按各阶段的实际选择器生成原格式摘要。不按扩展名忽略文件。

目录枚举及真实路径检查使用同步元数据调用；文件摘要最多四路执行，大文件每路缓冲 1 MiB，小文件有 64 KiB 上限。读取前后检查文件身份、尺寸和时间，并复查目录成员和依赖链接。修改后恢复 mtime、扫描中新增文件、链接越界及中途取消均拒绝返回有效清单。取消后等待在途摘要任务释放资源，不返回部分摘要。

实际安装的 JS 包文件、原生工具二进制和链接仍完整核验。唯一单独声明的输出根是 SDK 的 `node_modules/.vite`：其中包含开发预构建和 Vitest 结果，属于 Vite `cacheDir` 输出。历史清单迁移使用同一明确边界，不排除其他真实依赖。新的生产前端构建使用批次私有 cacheDir，并禁止将全局 Vite 缓存作为输入。

2026-11-05 修复：当前 Rolldown 插件上下文没有 Rollup 的 `getWatchFiles()`，不再调用该接口或静默跳过检查。守卫使用受支持的 `getModuleIds()` 检查模块图，在本工具创建的 React/Tailwind 插件调用 `addWatchFile()` 时检查依赖，并检查 CSS 依赖消息。因此 CSS-only 依赖也有明确拒绝路径；框架 hook 的 filter、参数、原始上下文和方法接收者保留。未改写 `src/styles/base.css` 等生产样式源码。

原生 App 串行，Cargo 使用有路径预算检查的独占短目录，不写主会话的 `src-tauri/target`。开始安装和每次启动前检查其他原生验收，发现其他冻结根的活动驱动或 App 时拒绝启动，不停止它们。已结束子案才生成 seal，最多两个后台任务可留存其原始结果、日志、data/账本和 home 效果。运行中、终止不明或封存后漂移的文件拒绝归档。

工具批次的 `run-state.json` 登记取消请求路径。请求须是有大小上限的普通文件，包含 `{"version":1,"runId":"<本批次ID>"}`；不接受其他批次身份或链接。依赖枚举与摘要支持取消，未执行子案保留 blocked。进程终止不明时不卸载、不重试模型调用。实际模型工具、LLM HTTP 请求、审批、终端命令及普通测试分别计数；未知数量保留 null。

## 清单范围

`--list-only` 不启动 App。可执行子案登记要求 ID、精确宿主/版本、ConPTY、制品、阶段、输入、预期与证据文件。构建、安装、卸载另有生命周期记录；复用的构建不能算作本批次重新编译。

pending/pass/fail/blocked/not-applicable、执行、复用、跳过和未执行分别记录。只有精确条件匹配、所需文件完整、seal 有效且留存制品摘要一致的证据才能引用。

完整清单的 35 个父要求和十个声明支持组合仍登记为义务索引，**不是已展开完成的全部可执行子案矩阵**。本执行器只覆盖上述 Windows 包子集，不以子案行数宣称父项或全平台通过。macOS arm64、受控 Linux SSH 仍阻塞；Ctrl+Shift+C 与人工复制继续暂缓。结果的 `fullAcceptancePassed` 保持 false。

## 只读与编译验证入口

以下命令不安装或启动 App：

```powershell
node scripts/native-input-p3/windows-package-batch.mjs --list-only
node scripts/native-input-p3/package-frontend-check.mjs '<retained frozen source>'
node scripts/native-input-p3/verify-retained-package.mjs --root '<artifact frozen source>' --artifact '<completed package directory>' --output '<new .artifacts/tests report.json>'
```

只读核验不会绑定原包端口、重放用例或覆盖已有报告。其 `ok:true` 仅表示制品与构建输入核验通过，不表示 App、模型或清理验收通过，也不证明当前工作区的新生产修订已被旧包覆盖。

实机运行需另有可用时段、冻结控制器及原生 GUI 门禁，届时再执行 `--reuse-package-from` 路径。模型场景另需显式 `--scenario` 与现有路由元数据引用。本工具不能替代 A06 随包源码重建、默认 raw 包、资源负例、人工项或其他平台验收。

## 验证记录

2026-11-05 本次修复的八个相关测试文件共 **61 项通过**。新增回归覆盖：没有 `getWatchFiles()` 的上下文、框架 watch 输入及私有接收者、正常 CSS 构建、真实 JS 缓存导入拒绝、CSS-only 缓存依赖拒绝、Tailwind 缓存依赖拒绝。最终真实前端构建生成 21 个资产，编译约 2.57 秒；源码前后摘要一致。此数字不含 App 或模型验证。

本次原始报告：

- `.artifacts/tests/acceptance-batch-optimization/rolldown-20261105/regressions-final.json`
- `.artifacts/tests/p3/e7a24b2a/s/.artifacts/tests/frontend-check/c12a9146-7550-41c8-97a6-277e0cead9c6/result.json`

此前保存的验证与实测：

| 项目 | 已有实测与边界 |
| --- | --- |
| 三阶段摘要 | native 58、frontend 1070、package 6630 个文件，与旧清单逐项一致 |
| 元数据扫描 | 分阶段约 126.5 秒，合并约 81.9 秒；不是端到端提速比例 |
| 留存包只读核验 | 约 19.35 秒，其中完整依赖核验约 9.39 秒；无安装或 App 启动 |
| 本候选 NSIS | 已构建，约 19.91 MiB；独占输出的 release 冷编译约 28 分钟，bundle 约 31 分 42 秒 |
| 397/398 基线四案 | 总计 33 分 03.786 秒，bundle 合计 23 分 42.755 秒，安装 1 分 08.737 秒，卸载 31.318 秒 |

旧四案为两宿主的模型语义/参数验证，模型工具和审批各 16 次，HTTP 次数未知。旧脚本的前端及配置未计时间隔合计 2 分 25.642 秒，不能称为精确 Vite 耗时。新候选采用冷 Cargo 输出且尚无实机完成数据，**不报告整体提速比例**。

## 失败、取消与交付

所有旧记录原样保留，包括：

- `live-20261104-01`：深 Cargo 路径导致 OpenSSL 配置失败；两个 App 子案均未执行。
- `live-20261104-02`：包已构建，但安装前因 Vite/Vitest 生成缓存摘要漂移被拒绝；不把该旧结果改为通过。
- `live-20261104-03/controlled-cancellation.json`：核对 PID/创建时间、确认无子进程、无安装和无 App 子案后受控取消；执行数 0，两个子案 blocked。
- `.artifacts/tests/p3/44ad2faa/`：先前资源来源不匹配的失败快照。
- `.artifacts/tests/p3/e7a24b2a/s/.artifacts/tests/frontend-check/13d98bba-d598-4fad-b446-cc7492af135f/result.json`：修复前 `getWatchFiles()` 兼容失败。

新版候选补丁：`.artifacts/tests/acceptance-batch-optimization/acceptance-batch-candidate-20261105-layout-verified.patch`。它包含当前候选工具、测试及说明；`snapshot.mjs` 的增量以本会话首次修改前的留存副本为基线，保留原有验收改动。补丁须应用到已有这些验收依赖的工作区，不能当作干净 HEAD 上独立安装包。11 月 4 日旧补丁及记录保留，但不代表最新状态。交付清单记录基线、文件摘要及隔离应用验证。

以上为前一阶段状态；后续两宿主运行与清理结果及显示缺口见下节。始终不自动恢复主验收，不提交、打 tag、推送或发布。

## 2026-11-05 两宿主实机结果与显示缺口

本轮运行目录为 `.artifacts/tests/p3/e7a24b2a/s/.artifacts/tests/pk/4abdcc06`，独立审计和清理报告位于 `.artifacts/tests/acceptance-batch-optimization/live-20261105-03/`。PowerShell 7.6.9 与 Windows PowerShell 5.1.26100.9818 的原生绑定、普通命令及 Core 摘要核验通过；两次运行映像摘要相同，六个 data/HOME/WebView 目录彼此独立。模型工具、HTTP 请求与审批均为 0，普通命令共 2 次。

从复用批次启动至关闭，墙钟约 114.716 秒；复用留存约 3.05 秒，安装约 12.30 秒，两个运行阶段约 6.48/4.63 秒，卸载约 7.76 秒。这里不含原安装包的冷构建，不能与旧四模型子案总耗时直接计算提速比例。

正常卸载后，仅残留 NSIS 自卸载器，已按所有权及内容校验原样保留到证据目录，未不可恢复删除。独立 OS 核对确认安装目录、应用进程、开始菜单快捷方式和卸载注册表条目均无残留。源代码、控制器索引、前端、资源及封存证据摘要复查通过。

本轮另发现适配器遗漏 verifyInstalled 方法；该次安装后已正常卸载、0 个 App 子案执行，失败记录保留在 live-20261105-02。现已补齐绑定，并在任何副作用前验证队列接口。

重要限制：原始程序结果虽然返回 pass，但 native-window.png 两张截图均为空白。普通夹具把终端追加在占满视口的 #root 之后，终端实际位于视口外。独立 visual-audit.json 将显示证据记为 fail；原始结果和图片不改写。

当前源码修正只作用于验收夹具：优先挂载到 #root，截图前等待绘制并测量宿主/终端边界；控制器拒绝没有可见边界证据的缓冲区成功。1480×920 与 960×600 的 Chromium 布局回归使用原包 CSS 摘要复核后进行，重现旧布局拒绝并验证修正布局。此为浏览器布局证据，不能替代新包原生显示验收。

旧包是冻结制品，源码修正不会改变它，不能修补其字节后仍声称同包复用。需另生成新测试包才能补验可见终端；尚未执行该构建或新的 App 运行。相关回归共 68 项通过。旧失败、取消、并发阻塞和本轮适配器失败均保留。

## 授权新测试包后的显示补验结果

2026-11-05 用户授权修正验收页面并生成新测试包。新制品来源 `.artifacts/tests/p3/c7c92f99/s`，以旧制品冻结生产源码为完整父快照，仅叠加五个验收文件修订；明确记录父清单、只读索引、override 路径和摘要。原 Core 通过完整资源复制核验复用，未重新编译。控制器使用独立完整冻结上下文 `.artifacts/tests/p3/7355355d/s`；生成包前核对实际前端构建 recipe 的来源字节一致。

新包目录 `.artifacts/tests/p3/c7c92f99/s/.artifacts/tests/pk/d51279c7`，应用与旧包具有不同制品身份及摘要。一次构建、安装和卸载覆盖两个宿主普通子案。PowerShell 7.6.9 运行阶段约 8.55 秒，Windows PowerShell 5.1.26100.9818 约 7.00 秒；两张原生截图已独立目视核对，均可见终端、实际命令、PACKAGE_USER_OK 和提示符，宿主及终端几何范围均在视口内。六个 data/HOME/WebView 目录独立，两次运行映像和已加载 Core 的摘要分别一致。

本轮全流程约 27 分 43.486 秒，含约 21 分 32 秒 release 冷编译，bundle 约 22 分 38.30 秒，资源准备 146.63 秒，前端 1.41 秒，安装 20.56 秒，卸载 9.53 秒。不同场景、冷热缓存和模型条件的旧批次不能直接计算整体提速比例。

安装目录已移除，所属进程、开始菜单快捷方式、卸载注册表条目均为零。NSIS 自卸载器作为已知残留原样移至本轮证据目录，并非遗留活动安装。源代码/控制器索引与完整资源、资产、留存证据再次复核通过。最终相关回归 68 项通过。模型调用与审批均为零，普通命令共两次。

审计、清理、阶段耗时、回归及独立归档位于 `.artifacts/tests/acceptance-batch-optimization/layout-package-20261105/`。archive.json 记录归档 SHA-256。旧 live-20261104-*、live-20261105-*、旧包、白屏截图、并发阻塞、适配器失败和取消记录均不改写。两个普通子案通过不代表 A/B/C/D/E 父项、实际模型链、macOS 或受控 Linux SSH 已完成，fullAcceptancePassed 保持 false。

## 主验收接入与进程身份封存

主验收538已实际执行依赖闭包和三阶段摘要，539在现行C02修复冻结上完成两个Windows宿主运行中取消/接管四案，四次真实模型工具及批准、八个实际App；旧普通用例包不含当前修复，未用它替代C02。执行后的三阶段摘要与执行前一致。C02仍用支持精确停止阶段的原生夹具，新工具用于输入核验、契约匹配、封存和独立留存，不把普通包子案换成C02。

542暴露了裸PID封存检查的边界：先在末案App仍可观察时拒绝，后在原Node PID27868已归属新Visual Studio下载进程时拒绝；失败和旧seal保留，没有停止或等待该无关进程。`sealCase`现在可显式传入`producerIdentities`，每个原PID均须绑定绝对exe及created，或原阶段start/end。Windows只读CIM重新核验；原身份仍存活或元数据不可证明时拒绝，PID复用不能冒充原生产者存活。v2 seal的摘要包含完整身份，验证及留存均重复核验。未传身份的旧调用和v1 seal继续使用严格裸PID门禁，active、终止未确认、篡改及独占写入保护不变；其他平台不外推此Windows身份接口。

543相关10文件72项回归通过，覆盖PID复用、原身份仍存活、缺失身份、旧调用拒绝和seal篡改。544在新记录中完成四案v2 seal、精确条件只读引用核验及独立副本验证；没有重跑App或模型，也不把只读引用核验计成复用跳过当前必测。模型工具和批准各4，HTTP次数及中断源码执行数为null。旧542/seal.log、finish-seal.log及前三个v1 seal原样保留。新版候选补丁为`.artifacts/tests/acceptance-batch-optimization/acceptance-batch-candidate-20261105-process-identity.patch`，其工具源码变化与新旧摘要另行登记，完整验收仍未通过。

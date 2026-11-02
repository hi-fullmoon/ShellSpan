# GNU 原生显示 ABI 修订验收

2026-11-02。状态：正式源码已实现，新的 macOS arm64 GNU 目标完成下述限定验收；Linux 标准构建、真实 PTY ABI 正负例及三个目标的真实 SSH native App 作业场景通过。完整平台/语义矩阵、生产准入和P4未完成。该修订不能覆盖旧 P0/P2 快照或直接作为整个重构完成的证据。

## 实现与约束

固定 GNU 源码增加只读 `rl_native_prompt_columns_v1()`，返回 Readline 已按本机规则计算的提示符最后逻辑行列数。桥接仅以该列数及真实编辑前缀的 libc 字符宽度展开 Tab，不修改源码、执行计划或前端缓冲区，不解析 ANSI 提示符，也不访问外部未公开 Readline 符号。

三个对应版本的补丁与标准构建流程位于 `scripts/dependency-builds/bash-native/`。Bash5.3 的生产 Readline8.3.6 构建与 P0 实验产物分开；GNU 归档、官方补丁、集成补丁及源码许可随资源包保存。`readlineDisplayAbi: 1` 是构建器、运行时资源加载器及打包器的必需字段，旧资源不能冒充本次修订。

真实 ABI 负例发现 Bash4.1 不调用较新加载钩子。现在所有版本均在原生初始化入口校验符号并保留模块映像，构建器和启动组件共同执行 `ss_native_input_v1_display_abi` 只读查询；加载钩子仅作为额外检查。模块被映射不等于具有原生能力，未知 ABI 不安装输入接入。不会替换已绑定的 Shell 或修改用户配置。

清稿后下一次输入的真实回归发现，原先 DraftCleared 可能早于回显函数恢复。现在 `clear_owned` 在实际清除和绘制后释放本次回显函数，再发出确认；事件钩子仍在原安全服务键边界退出，外部回显函数检查不放宽。

## 正式源码快照与标准构建

完整冻结副本：`.native-input-p3/acceptance-source/fd231338-4020-4144-ae96-be21f70ebcd9/ShellSpan`，1979 个源码文件；使用标准 `python3 -B scripts/native-input-p2/build.py`，没有用实验模块伪装生产产物。构建日志位于该副本 `.native-input-p3/gnu-native-standard-build.log`，退出0；三个目标的真实模块加载和 ABI 查询均通过。

| macOS arm64 目标 | 实际 Shell SHA-256 | 实际模块 SHA-256 |
| --- | --- | --- |
| Bash4.1 / Readline6.0 | `63b3d96056e49ff4ea48c5eb8b81b616070715346d4792c51ee9386526dbeedf` | `60245c44076a1e66d8d96e6124d8f75aaf67adc703f534c1192d73bd2425f140` |
| Bash4.4 / Readline7.0 | `6130b2728a0360dda1c4136ac0c0830a755517feec1db59dde057e48f0fa831d` | `e1942da7e28a943ff40c79f366409b29a34df9886f22cf15838085a00251247e` |
| Bash5.3 / Readline8.3.6 | `d61d654396e72475022ecb634fca105303daaf07ca24e00ef80956b5d265bdaf` | `40e1cf9ea3a65ac29dacd8ba56c1781760af2a828da2e993cb301c4fd6802b66` |

这些是独立构建的新测试目标；原冻结目标不会被改写或重新标成这些摘要。

## 真实验收证据

`.native-input-p3/gnu-abi-pty/8930b564-70c4-4357-9325-24bc2bb767ff/result.json`：六项真实 PTY 正负例通过。三个新目标通过 ABI 查询，三个未扩展 GNU 目标被拒绝该原生能力；随后各自的普通命令产生真实文件结果并正常退出。该检查不制造 NIP 回执。

同一共享实现与同一语料的实际 NIP/display 汇总：`.native-input-p3/root-readline-clear-matrix/51f72e7d-e8e1-4ee2-b2e3-a7cb514af4dc/result.json`，三个目标通过。该记录重新核对完整源码快照、实际测试镜像摘要、真实私有控制记录与浏览器结果。

| 目标 | 快照内 `.native-input-p3/scoped-runs/` 实际轮次 | `.native-input-p3/root-bash-tab-browser/` 显示轮次 |
| --- | --- | --- |
| 4.1 | `1cfa7d5e-a137-4437-845b-03175b063e0b` | `c26a4348-8540-45ca-847a-70d6156b855f` |
| 4.4 | `32af1ab0-ab19-44cd-b718-aeab443bced5` | `f0e88c9f-279c-4336-ae54-5d5887f63505` |
| 5.3 | `05652270-6b9f-4945-9155-8190010a40ab` | `b9ebf984-8ea6-4228-a162-6ad54563a4d6` |

每项实际 Rust 测试验证提交、未提交草稿取消、立即开始下一次输入、前台中断130及父 Shell 状态恢复。私有记录中 operation0/2/3 各恰一次接受，operation1 未接受；结果分别0/130/0，取消命令的受控文件不存在。完整 UTF-8 草稿、光标和末尾证明均匹配原始源码。

浏览器只消费真实 PTY 字节：40列、实际提示符11列、源码首 Tab 偏移22。原生和普通 Readline 均复制七个空格，可见单元格一致；公共 API 未替换，没有生成终端输入。普通 bind-x 的位置单位按已核实的各版本契约检查，未混淆字节与字符。

快照内 `cargo test --locked --manifest-path src-tauri/Cargo.toml --lib terminal_command::`：14通过、8忽略。忽略的原生环境入口不算通过，以上另行执行的真实 GNU 测试有独立记录。`pnpm check:rust:includes`：77个文件通过。

## 保留的失败与验收边界

首次正式副本 `78784b60-81ea-45e3-8365-730f1123505f` 的标准构建完成，但旧加载钩子假设使4.1真实 NIP失败；负例也证明仅看模块加载结果不足。旧日志、源码和轮次保持不变，未以第二轮通过覆盖。早期 Tab 六空格及清稿恢复竞态的独立失败保留在 `.native-input-p3/root-bash-tab-boundary-audit.md`。

本报告仅证明指定新 GNU 目标上的限定回归。真实SSH、完整父 Shell/history/几何与输出矩阵、App、跨版本旧会话策略、资源最终准入及P4退役仍需相应证据。当前生产新编辑器准入列表为空；没有提交、推送、发布或操作真实业务主机。

## Linux 标准构建与 ABI 边界

同一完整源码副本通过标准 `scripts/native-input-p2/build.py` 在受控 Linux arm64/glibc2.36 镜像中重建，退出0。镜像摘要为 `sha256:f2e236525c1d83c8b43ab3ead3a08e96b10ad104f678189fdfa090063dc8a3c8`，日志 `.native-input-p3/gnu-standard-linux-build.log`。未改写已通过的 Mac 制品。

| Linux arm64/glibc2.36 目标 | 实际 Shell SHA-256 | 实际模块 SHA-256 |
| --- | --- | --- |
| Bash4.1 / Readline6.0 | `dabb4415f7648e9ee39217bdc76b6c2162f8bf5e8a80c793966cc0847dc769e6` | `78f5b49145983a92329434a431ad2e51f26665053848a93f6ab8e6aff19e0764` |
| Bash4.4 / Readline7.0 | `badba46af71446e91e7eb3f9dd8fbc853c8ff59d25ef05779e443229148148fa` | `af49f663671f2ad8ef2c5f41c96016f437b675d8713397492eaf03a42687c6ac` |
| Bash5.3 / Readline8.3.6 | `837c2a433b668359e4a6b65b4b6614397fdf9e6250e6bf6360e4b6fb646c05dc` | `3db1d569d29c615ec568eccf94c2cc87475f736d5aeb7eb8ff8b109438fbed58` |

副本 `.native-input-p3/gnu-abi-linux-pty/c052b55c-3093-41e4-b8b9-3c252eb2bbbc/result.json`：六项真实 Docker 分配的 Linux PTY 检查通过。三个新目标通过实际 ABI 查询，三个 stock GNU 目标被拒绝该 ABI；随后普通命令产生真实文件结果并正常退出。这不是 SSH、NIP 或 App 的通过证据。

首次全新受控对端配置保存在副本 `.native-input-p2/ssh/10baa68a-c6ce-431d-87d3-08c3b816f511/fixture.json`，未作为通过证据。后续实际 App 场景及修正边界见下节；旧对端已经停止，没有重放旧轮次。

## 真实 SSH native App 作业场景

新的完整 App 源码快照为 `.native-input-p3/acceptance-source/29c6ca1a-ddba-4194-af2a-d9ca21fa1d32/ShellSpan`。六个标准 GNU 目标的实际制品经文件摘要及相关源码摘要核对后，只复制进新的独立验收副本，没有覆盖已绑定的用户目标或 owner 生成资源。

实际受控对端为 `shellspan-nip-p2-b706664a-8912-4e50-9455-0ca9c4234ad0`，只监听回环地址。它在会话建立前将独立测试账户绑定至 `/opt/shellspan-native-gnu/<profileId>/bash` 的已校验副本。测试密码只在内存中生成，经正常原生 API 写入 OS 钥匙串，场景结束后正常删除并验证不存在；没有密码、私钥或模型密钥落入源码、参数或证据。

| GNU SSH 目标 | 快照内实际 App 目录 | 结果与凭据清理 |
| --- | --- | --- |
| 4.1 / 6.0 | `.native-input-p2/app-4.1/2026-11-02T06-16-30.302Z` | 均退出0 |
| 4.4 / 7.0 | `.native-input-p2/app-4.4/2026-11-02T06-18-11.909Z` | 均退出0 |
| 5.3 / 8.3.6 | `.native-input-p2/app-5.3/2026-11-02T06-21-08.523Z` | 均退出0 |

每轮 `native-webview-evidence.json` 明确记录 `sshPty`、`native-inline`、`requestApproval`，真实 MiniMax 路由及七次工具调用/七个实际结果。现有作业场景验证完整脚本、反复等待/终止和非零退出、workspace/draft/focus保留，历史检查确认用户命令保留且私有控制没有写入历史。完整源码、静态资产和实际签名 App 镜像均核对至退出。这是三个指定场景的通过，不是完整 P2/P3 矩阵、所有提示符/尺寸/历史配置或无闪烁的通过。

相关独立失败不回填：

- 首次 P2 数据域运行于 P3 快照时，旧清理器错误要求 App 位于旧构建目录。修正后按同一已验证 launcher 的源码根选择实际签名 bundle 目录，保留 PID/comm/manifest 并增加实际镜像摘要核对；Windows 原路径规则保持。旧失败和原源码快照未修改。遗留本轮初始化 PID 在精确路径和摘要验证后停止；旧临时 OS 凭据经正常 API 清理，旧失败 DB 仅保留非秘密历史引用。
- `.native-input-p2/app-4.1/2026-11-02T06-14-03.347Z` 因测试副本被命名 `bash-4.1` 而得到 `unsupportedRemoteShell`，调用/执行均为0。只在全新对端将 basename 保留为 `bash`，制品摘要不变；生产探测规则没有放宽。
- `.native-input-p2/app-5.3/2026-11-02T06-19-33.085Z` 的模型改写了精确源码，被原严格审批白名单拒绝：调用1、执行0、结果0。该轮保持失败；下一轮是全新数据/身份/源码 nonce 的独立场景，未放宽审批或重放旧 call。
- `.native-input-p2/app-4.1/2026-11-02T06-11-56.881Z` 的既有生命周期场景通过，但其边界是本地 native/native→SSH raw→本地 native，不能替代 GNU SSH native 作业验证。

全部场景完成后已确认1432无监听、无验收App存活，GUI所有权明确交回P3会话。没有提交、推送或发布；新生产准入仍关闭。

## 分发源码重建与扩大检查

`29c6ca1a` 副本的标准 `prepare-native-input-resources.mjs --no-build --require-ssh` 退出0。
`.native-input-p3/gnu-resource-package-audit.json` 独立核对两个平台的六个实际 GNU 目标、
源码包与生产清单的逐文件摘要、六个原生补丁、Readline归档及六个官方补丁、许可与vendor配置，结果通过。
从实际分发包的 `sources/ShellSpan` 复制到全新目录 `11fd4cb9-572c-4992-89ab-d389cf15ae42`，
使用随包GNU归档、补丁和Cargo vendor，以 `CARGO_NET_OFFLINE=true` 标准重建Mac三个目标，
退出0，实际清单源码摘要与分发包一致。没有使用原工作区构建目录；不要求不同绝对构建路径产生相同二进制摘要。
日志为副本 `.native-input-p3/gnu-packaged-source-rebuild.log`，实际构建明细保存在
`.native-input-p2/source-rebuild/11fd4cb9-572c-4992-89ab-d389cf15ae42/`。Linux独立重建另行记录，不由Mac结果外推。

同一完整冻结副本的 `pnpm build` 退出0。`pnpm test` 实际为319文件通过、3失败、2跳过，
2910测试通过、6失败、8跳过；其中四项AI展示测试依赖真实Git提交对象，复制索引的源码副本不具有该环境，
另有reasoning菜单与既有process样式失败。原仓库针对三个失败文件复验为98通过、仅process样式1失败；
不能把分开复验累计成一次完整套件通过。原始日志为副本 `.native-input-p3/gnu-full-vitest.log`
及owner `.native-input-p3/root-owner-ai-failure-followup.log`。

副本完整 `cargo test --locked --manifest-path src-tauri/Cargo.toml` 退出101：1349通过、
1失败、107忽略。失败为既有 `model_exposes_only_strict_runtime_pipeline_tools` 清单未包含
`request_user_action`；未修改该无关工具清单或审批语义，忽略项不计为通过。
全仓 `cargo fmt --check` 仍失败；本次负责的 `artifacts.rs` 和 `local_tests.rs` 在owner仅修正格式，
其独立rustfmt及diff检查通过。旧冻结副本及其检查失败保持不变，不将格式修正冒充整个工作区门禁通过。

本轮GNU专用对端 `b706664a` 在确认仅剩自有sshd监听器与保活进程后，已通过标准停止入口移除；
保留全部验收文件与失败记录。1983项冻结源码在扩大检查后再次逐项匹配。

Linux从同一实际分发包新建 `a462c363-8aec-4d35-812d-287257d4ae77` 源码目录，标准重建三个目标
退出0，清单源码逐项匹配；日志 `.native-input-p3/gnu-packaged-linux-source-rebuild.log`。
构建在独立自有Docker容器中执行，使用同一固定镜像 `f2e23652...`，没有原工作区构建目录；
该容器已随成功退出移除。Mac与Linux各有实际重建结果，不相互外推。

## 新GNU目标的标准真实运行回归

同一 `29c6ca1a` 完整副本执行标准
`cargo test --locked --manifest-path src-tauri/Cargo.toml --lib native_production_ -- --ignored --test-threads=1`：
3通过、0失败、0忽略，121.34秒。覆盖三个GNU版本的真实输出捕获、长/未结束OSC、实际exec/EOF、
24场32/40/100/180列普通及超长Unicode输入与缩放，以及私有控制、信号和控制EOF后原生输入恢复。
实际日志 `.native-input-p3/gnu-native-production-regression.log`；几何记录为
`.native-input-p2/capture-evidence/8590395c-1a46-41ca-b020-57ac077d814d/geometry-summary.json`。

同一生产输入生成器通过后，受控Linux真实PTY完成12个三版本/四列宽超长输入缩放场景；
实际模块与Shell摘要在运行前严格核对，每场完整输入证明匹配、唯一接受、输出效果一次。
三个版本另通过正常控制、真实EOF及物理中断、父子/后台输出、物理用户回显、后续前台Ctrl-C状态130检查。
证据在 `.native-input-p2/linux-geometry/969091f7-aff9-46de-bfa8-6745e5a54f7c/` 的
`geometry-summary.json` 与 `widget-summary.json`；日志前缀 `.native-input-p3/gnu-linux-production-`。
容器将原已核验GNU SDK以只读方式挂载到生产清单记载的相同路径，没有改写目标、清单或测试输入。
这是Linux目标组件PTY证据，SSH App作业证据仍以上文独立三场为准。

标准 `scripts/native-input-p2/browser.mjs` 对以上真实PTY记录完成Chromium/WebKit × DOM/WebGL回放：
Mac 96/96，Linux 48/48。原始源码可搜索、复制，实际软换行后的缩放与历史选择保持契约，
公共API未覆盖、无终端输入生成，显示关闭恢复默认配置。回放不作为新的Shell执行。
实际浏览器结果分别为 `.native-input-p2/browser/1aca6a31-5778-42ff-9900-9c0d92c94a66/summary.json`
及 `d235cc10-bf89-4ffb-8321-1d45d1ee8011/summary.json`，保留实际截图。

这些结果补齐本轮GNU显示ABI的标准运行/打包回归，不代表最新源码全部P2 App历史配置矩阵
或P3/P4已经完成。Windows PowerShell/ConPTY仍未验收；没有启用未验收编辑器的生产准入。

## 实际本地 bundle 资源加载

同一不可变 `29c6ca1a` 执行标准 `node scripts/native-input-p2/release-smoke.mjs` 退出0；
结果位于 `.native-input-p2/release-smoke/28c3230e-a990-4fc0-9036-8d70e1ae98f7/`。
独立本地App通过 `codesign --verify --deep --strict`，从自己的
`Contents/Resources/native-input-v1/generated` 选择实际GNU5.3 Shell和适配器；
真实Broker/私有能力协商为ready，registry为localPty/native-inline。
普通用户输入在该实际PTY输出 `PACKAGED_NATIVE_RESOURCE_OK`，随后正常关闭。
`result.json` 明确记录 `debugFallback:false`，`webview-evidence.json` 保留实际会话及输出。
随后从实际bundle重新核对两个平台的六个Shell/模块/relay及全部源码、补丁、许可和vendor：
6300个源码树文件的路径与内容摘要和已验证分发包逐项相同，包括隐藏的Cargo配置及vendor元数据。
结果 `.native-input-p3/gnu-release-source-tree-audit.json` 为PASS，没有用构建前目录代替bundle检查。

该项证明此修订在本地release构建中定位并使用bundle资源，不是开发目录fallback；
没有调用模型、操作已有用户终端、修改用户HOME/数据或发布App。
它不替代后续整合源码的模型、scratch或Windows验收。新增完整历史矩阵另用全新源码/数据执行。

## 新源码历史矩阵的受控目标

新完整冻结 `.native-input-p3/acceptance-source/f6956af1-3cad-490f-ab66-81683f0e7b60/ShellSpan`
含1983项源码，使用经源码及制品摘要核对的六个GNU kit，没有修改旧快照或已绑定终端。
标准 `scripts/native-input-p2/ssh.mjs --from-resources <immutable-image-digest>` 只创建全新
回环测试对端：先核对清单源码及实际Shell/模块/relay，再将三个实际Shell复制到独立
`/opt/shellspan-native-gnu/<profileId>/bash`，核对对端摘要后才绑定新的测试账户。
这解决私有源码副本中的构建目录不能被独立SSH账户遍历的问题，不替换生产用户Shell。
新入口沿用原fixture的SSHD账户范围和正常系统profile审计，不处理密码或宣称验收通过。

历史场景仅在显式fixture提供目标时使用该目标，启动前再次检查固定路径、账户与实际Shell摘要；
随后严格核对真正的 `argv0`。没有改写producer的构建路径或放宽生产Shell探测。
实际对端为 `95b03dbb-f220-4482-ae3b-47846e319958`，固定镜像 `f2e23652...`。
首场独立SSH历史验证 `app-4.1/2026-11-02T06-53-30.913Z` 及凭据清理均退出0，
证明确实使用独立目标、真实HOME/login/rc、原历史与非零状态；该场不冒充完整矩阵。

同源标准 `scripts/native-input-p2/matrix.mjs <fixture.json>` 的完整45场入口已启动；
实际状态和每场结果写入 `.native-input-p2/app-matrix/cdcf426b-91ec-4201-8595-4f0a20d0ac74/summary.json`，
入口日志 `.native-input-p3/gnu-full-app-matrix.log`。在入口实际结束并审计前保持未完成，
不重启正在执行的入口，不重放任何旧操作或把中间通过数量写成最终通过。

**用户中断与执行顺序调整**：用户反馈测试App反复夺取桌面焦点，随后要求先完成代码、后续统一验收。
该入口在40场完成（均退出0）后停止；当前 `5.3/ssh/history-empty` 场景
`app-5.3/2026-11-02T07-34-03.788Z` 被中断，不能视为通过或自动重放，45场完整矩阵未完成。
父入口PID4352及当前启动链已停止，实际App PID50987已退出，1432无监听；
专用对端95b03dbb已通过标准停止入口移除。原summary最后的RUNNING是进程被停止前的检查点，
保留原件，不作为当前在线状态；没有为了补齐统计继续启动App。

本场已生成的临时凭据仍在OS vault内，尚未通过正常原生API删除；引用为
`native-p2-secret-67caef93-003d-4dd2-993b-e3d3a27ba130`，仅为非秘密定位符。
没有读取、导出或记录其密码，不直接改写或删除共享vault。后续清理必须遵守用户“不启动App、不抢焦点”约束；
若当前代码不存在可安全使用的无窗口清理入口，列入待处理项，不能将其记为已清理。

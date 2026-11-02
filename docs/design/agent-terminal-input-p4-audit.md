# P4 代码审计与统一待验清单

> 后续审查更新：用户明确不再保留兼容。本阶段下述兼容策略记录已被后续清理替代；当前实现只保留
> native-inline/raw，旧模式和旧作业输入分支已移除。最新范围见[兼容残留清理审查](agent-terminal-input-compat-removal-review.md)。

状态（2026-11-02，Asia/Shanghai）：P4 代码已实施；本轮只做类型、编译和静态检查，动态回归与平台验收未完成。没有启动 App、浏览器、真实 Shell/PTY/SSH、Docker fixture、模型或原生依赖构建器，没有设置前台测试允许开关。没有新建分支/worktree/子会话/子代理，没有提交、推送或发布。

入口 HEAD 为 `a162a5f12c1dd24bf1198a50e53b5f899cbd4c45`。从当前 P3 工作区继续，保留 release/SFTP/AI/scratch 等已有改动，没有用冻结副本覆盖。P0/P1/P2/P3/GNU 原有证据仍以其冻结源码、制品和平台范围为准，不能回填到本轮源码。

## 产品与兼容边界

- 一个连接 generation 固定一种输入实现。当前代码只有真实 PTY 渲染，不保存第二套源码或光标。正在运行的旧程序不热更新；重连建立新代次，先停止旧回调、排空旧输出并恢复同流显示选项，再接新流，不清屏、不重放历史、不补执行命令。
- `legacy-projection` 保留线上枚举，便于读取旧客户端 DTO；它不再表示本客户端安装投影。缺字段按该兼容标识处理。legacy/raw 的新 Agent 源码在 lease/PTY 写入前明确返回 `TERMINAL_NATIVE_INPUT_REQUIRED`。不按 Shell 名字伪装能力，不自动替换用户 Shell。
- `native-inline` 仍要求已校验资源、私有身份、完整能力和显示绑定。`native-editor-admission.json` 保持 `productionProfiles: []`，它约束 ZLE/PSReadLine 编辑器目录，不是 GNU Bash 的全局开关。GNU 本地 `PreparedNativeBash::prepare` 和 SSH `RemoteNativeBash::prepare` 继续通过 `artifacts::read_catalogue` 校验来源/显示ABI，并精确匹配用户绑定 Shell SHA 和模块/relay 制品；P4 没有改变这条独立准入路径。不能从空编辑器列表推断所有 GNU 目标关闭，也不能为了退役 legacy 而打开未验收编辑器。
- 普通用户终端、已有 TUI/交互程序、后台作业观察/停止/清理保留。既有 legacy 作业仅可通过已经准备并绑定原 job/operation/目标的私有描述符通道管理，不能把任意相同 source/submission 当作管理命令，也不能启动新后台源码。
- Broker 生命周期、不可变 intent/plan/approval/冻结目标、FullInputProof、SQLite FULL 提交意图及单次可能提交没有更换。未知提交、revoking lease、迟到 Started 观察、不重放及显式恢复边界继续保留。

## 实际代码范围

| 文件 | P4 结果 |
| --- | --- |
| `src/components/terminal/registry/terminal-command-{source,typing,redraw}.ts` | 删除全部实现，包含投影记录、缓存、前端逐帧揭示、临时行/光标替换、同步绘制保护与超时状态 |
| `terminal-command-decorations.ts` | 删除源码/提交文字和旧模块接入；保留有界有序 scope、公共 marker/坐标与只读背景装饰。marker 失效时省略装饰，不再按旧清屏重画猜测新起点 |
| `registry/terminal-registry.ts` | legacy/native 都只显示真实字节；native 只附加已有同流模块，raw 不装饰；新传输统一排空后重绑，不保留旧投影历史模型 |
| `terminal-controller-layer.tsx` | 删除已无职责的 Agent pass-through 输出过滤器及生命周期缓存。保留焦点、用户输入抑制、ready 与结构化状态消费；目录查询等无关输出过滤器未改 |
| `src-tauri/src/agent_runtime/native/terminal_execute.rs` | 删除 legacy 普通打字、粘贴、源帧动画及接受分支。新源码只走 NIP coordinator；旧作业只保留身份校验的私有管理分支及对应取消/清理。旧输入编码辅助仅在 `cfg(test)` 中供原真实集成素材诊断使用，不存在产品源码输入调用 |
| `terminal_broker.rs` / `terminal_integration.rs` | 删除真正无引用的旧动画捕获重置、源帧开始和 native typing 查询；仅诊断使用的旧活跃作业查询、包装解析移到测试编译边界。旧控制解析、只读观察及普通 Shell 集成保留 |
| `scripts/check-terminal-command-boundary.mjs` | 使用 TypeScript AST/类型检查；覆盖命令展示模块、应用内运行依赖及 registry/controller。拒绝私有成员、公开方法/buffer/cursor 替换、反射覆盖、源码元数据及 DOM/canvas 文字投影。允许已授权同流 parser/options/provider；不扫描修改通用依赖内部实现或无关终端兼容代码 |
| `package.json` / `.github/workflows/quality-gate.yml` | 注册静态检查并接入 Quality Gate；源码/重画回归入口迁到真实原生流套件，保留原命令别名 |
| `scripts/native-input-p4/check-static.mjs` / `.gitignore` | 显式列出本阶段允许的无界面检查并保存每项结果；P4 临时证据目录被忽略 |

通用 xterm patch、依赖版本、同流显示实现和编辑器资源没有修改或重建。没有无关 UI 布局、控件、颜色或文案变更。普通目录查询过滤器仍有独立调用者，未为“删干净”而破坏它。

## 回归迁移与证据保留

原规格逐字保存在 `docs/design/p4-retired-regressions/*.txt`，不再作为可运行旧输入入口。所有真实 JSON/PTY 字节、P0 失败轮次、P3 历史视口失败 fixture 和旧焦点 FAIL 保持原样。归档不是通过证据，以下替代断言尚未执行。

| 原关注点 | 当前入口及保留断言 |
| --- | --- |
| source 投影/分片与输出同文误识别 | `terminal-command-stream.test.ts` 对原真实 legacy 捕获的每个 137 字节片段，与未装饰参考终端逐行/软换行/光标相等；保留全部输出，不能再将旧包装字节伪装成原文 |
| 原生源可读、Unicode、选择/搜索、宽窄重排 | 同文件使用真实 ZLE fixture 的 1/137/完整字节片段，核查原文、历史、Unicode 选择、复制、搜索、重排与公共方法身份；浏览器沿用 native display 和原历史失败 fixture，覆盖 Chromium/WebKit × DOM/WebGL |
| 前端 typing、Bash 清行保护、原生进度 | `terminal_native_protocol.rs` 的 NIP producer 在真实读取处保存 offset/length/单调时间。`native-input-p2/browser.mjs` 强制校验新 readEvents 与实际字节完整对应，再按真实边界绘制；保留超过3种可见状态、超过500ms、先前原生前缀不能消失、完整源/复制/搜索、无额外输入及 API 身份断言。旧捕获缺字段即失败，不回退到旧 producer |
| 只读命令背景与有序私有控制边界 | 普通真实 Bash/Zsh boundary producer 和 `terminal-command-decorations.browser.mjs` 保留；其后强制进入新原生套件。退休的 native presentation producer 不再向 legacy 终端提交源码 |
| 旧 executor 的输入/取消/清理与未知结算 | 原状态/checkpoint/私有作业断言中仍有用途的部分保留。旧源码启动规格归档；替代真实入口为 `terminal_native_protocol.rs` 的 preparing/typing、late confirmation、durable deadline/revocation、running stop、崩溃不重放，以及 native `local_tests.rs`/`zle_tests.rs` 和 P2/P3 App 的停止、接管、迟到 Started、关闭和作业场景。不能只跑新增拒绝测试就宣布这些行为通过 |
| 不支持能力与旧客户端 | 新增真实 Broker 的 legacy/raw 前置拒绝测试，不建立假 Session、私有回执或假生命周期；检查无 operation、代次/模式/输入观察未变。controller 原有资源测试移除旧过滤器预期，并断言不再安装该过滤器 |

本轮没有新增 mock/伪回执/假输出，也没有放宽输入、审批、取消或时间预算。原“保持绘制 hold”的内部断言属于被删除的前端机制，替代门槛是实际原生前缀不消失；原失败素材仍保留。真实长期输出、取消、焦点和像素无闪烁须在统一验收中独立验证，不能用源码或 fixture 检查代替。

## 本轮检查

最终整轮日志：`.native-input-p4/static/b2db692b-ce46-4935-ae43-d1f3b293cbca/summary.json`。

| 检查 | 结果 |
| --- | --- |
| `pnpm exec tsc --noEmit` | 通过 |
| `pnpm build` | 通过；保留 Vite 的体积/构建时序提示，不作为运行验收 |
| `cargo check --locked --manifest-path src-tauri/Cargo.toml --tests` | macOS 当前目标的 lib/test 源码编译通过，无本轮新增警告；没有执行测试，不代表 Windows/Linux 编译通过 |
| `pnpm check:rust:includes` | 77 个 include 文件通过 |
| `pnpm check:terminal:boundary` | 5 个展示/依赖/接入文件通过；最终文案/AST属性键收紧后单独复验日志为同目录 `command-boundary-final.log`，GNU catalogue 未改变 |
| 5 个改动 Node 脚本的 `node --check` | 通过；边界脚本最终修改后也单独复验通过 |
| `git diff --check` | 通过 |
| `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` | 退出1，已有格式差异位于 native/runtime.rs、commands.rs、terminal_broker.rs 的既有段落及 terminal_command/{mod,state,tests,windows}.rs；没有扩散格式化这些内容 |

较早 `8f277259-86a4-4191-89e1-58dde0426d9f` 的 include 检查因 P4 新增测试格式退出1，原日志保留。已仅修正该新增测试段，随后77项复验通过，最终整轮同样通过；不将该失败隐藏或归入既有基线。

GNU准入表述根据 `local.rs`、`remote.rs`、`artifacts.rs` 与 `editors.rs` 的实际分流收紧：空列表只约束 ZLE/PSReadLine，不能外推所有 GNU 目标关闭。本轮没有动态测试通过声明，也没有完整 Quality Gate 通过声明。

## 统一验收清单

- [ ] 对最终整合源码重新冻结并核验资源、依赖运行包和实际镜像，不复用旧通过作为 P4 证明。运行相关前端/后端回归及完整 Quality Gate，处理独立记录的既有失败。
- [ ] 全新 NIP 捕获核验新增 readEvents、可见输入/无闪烁、原文/光标、复制/搜索、Unicode、Tab/CR/LF、超视口、动态尺寸、背景输出、历史选区与视口；覆盖 Chromium/WebKit、DOM/WebGL 和实际 App。
- [ ] native→native→raw→native 与 legacy/raw 的真实重连/关闭、半 OSC/UTF-8 排空、原历史保留；没有源投影、双输入者、重复 Enter 或热切换。
- [ ] legacy 新源码/新后台启动明确拒绝；既有真实作业查询/停止/清理、普通用户编辑、REPL、TUI、凭据门禁不回归。旧客户端兼容需在真实旧版本实例核验。
- [ ] 最新 GNU 三版本的完整 Mac/Linux 本地及 SSH 矩阵。f695 完整45场只完成40场，5.3/ssh/history-empty 中断和原 RUNNING 汇总继续保持原边界，不能重放旧call/data/nonce或写成45/45。
- [ ] ZLE 与 PSReadLine 的实际完整源、资源/ABI、初始化、父 Shell 语义、草稿取消/EOF、FullInputProof、FULL意图、提交/停止竞态、迟到Started、Uncertain/revoking、显式恢复及单次可能提交。
- [ ] Windows受控 `.82` 离线，未连接。最新 PowerShell 5.1/7、ConPTY、真实模型与前台/后台、签名RunOnce及scratch并发修复仍需受控实机验收。
- [ ] 独立受控桌面或用户明确安排的验收时段，再启用单次 GUI 测试授权。检验默认拒绝、初始化/清理不抢焦点、实际前台焦点契约；旧 `29c/ba26c7a7` 焦点 FAIL 未定因，新被动诊断未在本轮运行，不凭另一次 pass 关闭旧 FAIL。
- [ ] 一个自有临时 CredentialRef 仍在 OS vault，后续只经正常 API 清理并核验；本轮未读取秘密、触碰共享 vault、修改 keychain/信任/执行策略或为清理启动 App。
- [ ] 平台完成验收后另行决定生产 profile 准入；不因 P4 代码完成自动提交、推送或发布。

代码实施部分已收口；实机验收、完整质量门禁及生产启用保持未完成。按用户最新要求在此停止，不继续扩大验证。

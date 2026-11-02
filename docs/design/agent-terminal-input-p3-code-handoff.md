# P3 代码交接与统一验收清单

状态：**P3 代码已实施并完成本轮代码收口，平台验收尚未完成。** 按用户最新目标，先实施P3/P4代码、每阶段独立会话，之后统一验收；Windows离线和旧焦点现场不再阻塞代码阶段交接。验收条件并未免除，也不据此启用生产路径。

当前只允许无界面编译、类型和静态检查。禁止启动App、模型、浏览器、Shell/PTY/SSH实机测试；初始化和凭据清理也不能例外。GUI释放不是启动授权。此交接不创建commit/tag，不推送或发布。

## 已实施的产品代码

| 范围 | 当前代码与边界 |
| --- | --- |
| ZLE | `src-tauri/native-input-editors/zle.c`、`zle.zsh`、`src/ffi.rs`及固定Zsh recipe；公开API `shellspan.zle-native-append/1`，special参数`ZLE_NATIVE_APPEND=0/1`，默认0。真实BUFFER/CURSOR证明、接受前静默交接、清稿/EOF恢复及作用域清理已实施 |
| PSReadLine | `psreadline.ps1`、`psreadline.cs`及FFI；使用公开缓冲/替换/接受API与PowerShell AST，保留ConsoleHost/ConPTY及既有后台作业。Windows 5.1/7的精确目标、模块、签名和来源校验已实施，最新实机结果仍待验 |
| 准入/加载/接入 | `terminal_command/{editors,registration,local,remote,windows}.rs`、Session/PtyInfo、类型化IPC和terminal registry；Shell/Core/模块摘要、私有通道、身份/代次与实际准备后的显示绑定共同校验，不以自报版本或屏幕内容授予执行权 |
| 运行时 | 原NIP/Broker/持久提交账本继续单次授权；停止未确认与迟到Started保留Uncertain、禁写、观察登记与revoking lease，真实结束或显式关闭才清理，不自动重放 |
| 显示依赖 | 正式pnpm patch `dcabd41a`，UMD `48f368b5`；源码可重建的光标、复制、选区和历史视口坐标修复，原位显示依赖真实原生输出，不引入前端源码副本或公共API覆盖 |
| scratch | 实际记录先写独立私有pending目录，再用tempfile原子发布到records，避免并发重开将未发布临时文件视为所有权记录；保留读取/权限/symlink/身份校验 |

Mac Core为`cc7f4263`、Linux Core为`c9e451bd`，完整摘要与固定输入见[P3审计](agent-terminal-input-p3-audit.md)及[ZLE API](../../protocol/agent/runtime/native-zle-append-v1.md)。`protocol/agent/runtime/native-editor-admission.json`当前仍为`productionProfiles: []`，未验收编辑器的生产准入没有打开。GNU代码与源码分发/既有验收范围见[GNU独立审计](agent-terminal-input-gnu-display-abi-audit.md)，不将其混作ZLE/Windows通过。

## 本轮诊断与验收入口代码收口

- 被动诊断已接入现有Zsh P3 post-input-backpressure入口，限测试文件；100条原断言、原七调用的命令/计划/审批、焦点谓词、暂停/等待和250ms背压均保留。
- `native-focus-trace.ts`记录窗口/DOM/角色/编辑器生命周期和租约、runtime接收事实；元数据字段明确选择，不能把完整context/lease/runtime对象的额外内容带入。role白名单，未知为other；不记录文本、输入值、按键字符、aria-label或原始class/style。
- 最多2048条、记录体序列化预算384KiB（另有固定对象/索引开销），配置先校验，非法或放宽配置拒绝；超限明确失败，首个违例保留，结束阶段幂等，不覆盖公开focus/blur或替用户恢复焦点。
- 同token的一次性端点保存0600/wx私有诊断文件并返回SHA，主结果仅绑定摘要；成功/失败均在清理前保存，原1MiB主结果门不增大。保存失败显式记录。
- P3 Mac App、Windows启动、凭据源/编排父入口已在数据读取/准备、SSH或凭据副作用前调用协调侧的`assertNativeGuiAllowed`。中央守卫及P2 GUI锁由协调会话维护，默认拒绝；正常产品启动和权限审批不变。本轮不设置允许前台验收的环境开关。
- Windows增量来源/传输清单补齐GUI守卫、诊断端点、被动诊断模块三项新导入依赖；两个35文件清单经AST静态核对一致且本地文件存在，没有执行远端复制或测试。

早先冻结诊断源`54323f40`与历史无头结果继续保留。其后的元数据白名单/边界校验/结束幂等和父入口守卫收口只进行了下述编译/静态检查，**不把此前浏览器或实机结果回填为这些新改动的运行通过**。P4应从当前工作区继续，不能用旧冻结源覆盖最新修改。

## 本轮仅静态与编译检查

| 检查 | 结果 |
| --- | --- |
| `pnpm exec tsc --noEmit` | 通过 |
| `cargo check --locked --manifest-path src-tauri/Cargo.toml --lib` | macOS lib编译通过；不代表Windows编译通过 |
| `pnpm check:rust:includes` | 77个include文件格式检查通过 |
| 改动Node脚本`node --check`、`git diff --check` | 通过 |
| 对b13原验收条件的TypeScript AST检查 | 原100条assert按原序保留；命令、goal、焦点条件、窗口/焦点操作、背压与定时器未改变 |
| Windows增量清单AST/导入文件检查 | 两清单一致，35文件存在，新增依赖齐全 |
| P3代码入口/未实施标记核查 | 已有适配器/加载器/FFI/registry和准入入口齐全，相关范围无TODO/unimplemented占位；没有因暂缺现场而盲加焦点恢复逻辑 |

证据记录在`.native-input-p3/p3-code-handoff-*.log/json`。本轮没有执行任何App、模型、浏览器、Shell/PTY或SSH验收，也没有清理系统vault中的待处理引用。

## 后续统一验收项

1. 最新完整源的Windows PowerShell 5.1/7编译与ConPTY、真实模型、长输入/动态尺寸、前台/既有后台、停止/恢复；模块签名RunOnce及临时引用流程仍按原授权和正常API，不能放宽策略或信任库。
2. 在独立受控桌面或明确验收时段验证默认拒绝/正向单次授权、无干扰初始化/清理与真正前台焦点契约；不能以隐藏执行冒充焦点通过。
3. 旧`29c/ba26c7a7`焦点FAIL仍未定因。新被动诊断需另一次授权的全新独立场景；不能归因于scratch或凭后续一次pass关闭，也不循环模型凑通过。
4. 最新整合代码的跨平台/逐版本完整矩阵及源码/资源/实际镜像一致性；保留此前GNU 40/45完成与中断原件，不续跑旧call/data/nonce，不把限定结果当全矩阵。
5. P4清理后的全部回归与全量检查；已知旧全仓失败独立列明。协调侧待处理的临时CredentialRef仍在OS vault，后续只走正常API，不为清理启动App、不直接删除vault或修改用户keychain/策略。

P3代码交接完成后，协调会话可依用户最新顺序另开P4**代码实施**会话。各平台验收、生产准入、提交/推送/发布均不因此自动获准。

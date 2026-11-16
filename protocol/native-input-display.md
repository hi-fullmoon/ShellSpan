# Native editor display integration

用户于 2026-10-31 明确批准通用 xterm 光标重排、软换行复制修复及同流显示切换纳入正式实现。该授权包含默认配置历史输出的通用复制规则变化，不授权业务层文字投影或公共选择/搜索/buffer API 覆盖。

P0 依赖已采用 pnpm 对精确 `@xterm/xterm@6.0.0` 的 source + UMD/ESM 构建补丁。P1 冻结 `shellspan.native-input`，正式 binding 为 OSC 1337 的 `SetUserVar=ShellSpanNativeInput=MQ==` / `MA==`，由 `NATIVE_INPUT_DISPLAY` 导出；详见 [NIP](agent/runtime/native-input.md)。P0 实验键继续只用于原型及历史 fixture，不作为正式能力证明。

## 接入边界

### 原点观察通道（已接线，应用验收待完成）

`terminal-prompt-origin-request` 只传输会话身份、终端代次、一次性请求 ID/index、期限及数值几何；`respond_terminal_prompt_origin` 只答复该原请求、有界的 1/2 单元宽度数组及显式 `wrapPending` 布尔值，不接收源文本。后端协调器不包含 PTY writer、命令、审批、lease 或执行状态。错误身份/几何不消耗合法待答请求，超时、取消、重绑和关闭使旧答复失效，成功答复只交付一次。反序列化在累积数组时限制 65536 项并拒绝未知字段、缺失/非布尔标志及其他宽度。

前端只对后端协商的 Windows ConPTY/native-inline/15-graphemes/session/ownedReflow=false 绑定观察，匹配当前 session/terminal ID、代次与监听代次；等待已有输出排空、尺寸及光标吻合，关闭/重绑时停止。观察不移动光标、不写输入、不决定 promptReady、清稿、恢复或执行。shellspan6 的认证原生请求生产端已接入协调器，UI 没有自行创建绑定或请求的命令；应用级初始化、显示与关闭仍待完整验收。历史候选文件通道不能作为产品通道或正式验收通过证明。

实现入口是 `src/lib/terminal/native-input-display.ts::attachNativeInputDisplay`。调用者必须传入显式 native 模式与已协商的 OSC identifier、enter/exit payload。模块不隐式安装正式 binding，不自行探测提示符、lease、命令文本或原生源码。registry 仅在后端协商的 native metadata 下安装。当前仅有native-inline/raw，raw不安装装饰或新handler。当前实现及待验范围见[NIP 契约](agent/runtime/native-input.md)和[统一验收清单](../docs/design/agent-terminal-input-acceptance-checklist.md)。

安装基线为 `reflowCursorLine=false`。不满足基线或同一 Terminal 重复安装时，附加操作拒绝且不改用户选项。资源释放后可显式重绑；输入权、代次和输入准入始终由既有后端边界决定。

Windows 私有 PSReadLine `2.4.5-shellspan6` 保留空输入缩放修复，并在已验证宿主安装显示 provider 后启用与固定 xterm Unicode 15 一致的 grapheme 测量。编辑器公开偏移及输入缓冲仍使用 UTF-16；高代理项输入尚未完整时暂缓绘制，避免临时替换字符。构建标识与实际摘要必须匹配；旧构建不因显示兼容而获得新构建身份，生产准入仍由独立清单决定。

显示私有管道 `SSDO` 版本2在回复头第6字节传递0/1待软换行标志，第7字节仍必须为0。前端仅在正常缓冲区 `cursorX===columns` 且原Console请求列为 `columns-1` 时报告该状态，读完真实末列，不截去最后单元；行、尺寸与会话身份仍严格匹配。编辑器原线程校验满行宽度后，用显示空格和退格落实已待发生的软换行并读取实际原点，包含底部滚动；这不是插入编辑缓冲或提交源码。旧版本管道与旧私有profile均拒绝。清除旧逻辑行尾部使用定长ECH擦除单元，不写入会被复制为源码尾空白的空格，也不在复制结果上做空白归一化。

显示原点使用独立、不可继承且仅当前用户可访问的管道。两端分别校验真实对端 PID；Rust 仅在认证后绑定 UI session、terminal session、generation 与私有 epoch。请求为固定数值几何帧；回复最多 65536 个 1/2 cell 宽度，不包含文本。前端排空当前输出后只读真实正常缓冲区的 cell 和软换行，坐标不一致时在请求期限内等待，不能生成输入。请求单次消费、序号递增，重绑或PTY关闭取消待答请求，迟到回复不能改变后继连接。等待不泵送 NIP 操作。NIP故障关闭命令控制并保留原失败/恢复门槛，但存活PTY仍保留只读显示服务，以供实际清稿及普通编辑；它不能重开NIP或返回编辑权。原生上下文销毁、PTY退出及会话重绑才结束该显示生命周期。应用初始化与退出仍须实际验收，组件管道测试不能代替应用证据。

后台可能在前一答复的IPC确认返回前发出下一显示请求。前端仅保留一个当前答复和一个后继请求，依次处理并去重；后继期限仍从收到事件时计算，不因排队延长。会话重绑废弃旧队列。这一队列不改变后台单次消费及私有身份校验，也不授予终端输入权限。

终端写入被拒绝等一次性失败使用既有Toast反馈并去重，不能把UI错误提示作为终端输出插入当前提示符。否则本地提示造成的换行会使xterm与宿主的实际光标坐标分离；这不应通过放宽显示坐标检查或输入恢复门禁来掩盖。

P3 受控验证可在后端已校验的 ZLE Core/profile 对应 `nativeDisplayBinding` 中附加只读
`unicodeVersion: "11"`。该字段来自本地资源的实际 Core 校验，不接受 peer 自报、OSC、前端
ready 或版本字符串作为证明。快照与本地 Session 启动等待必须使用同一 binding 生成函数。
registry 仅据该元数据按需注册官方 provider，注册不改变普通默认；显示模块仅在完整 owned
enter 时保存原 provider 并启用选择，exit、有序关闭及销毁时恢复。重复 enter 不覆盖原值，
期间显式发生的外部 provider 切换予以保留。未选该配置时不访问或改变 provider。
该实现仍受[统一验收清单](../docs/design/agent-terminal-input-acceptance-checklist.md)的资源、平台与窗口
门禁约束，不表示未验收 profile 已启用；provider 显示状态不能授权执行。

Windows 私有 ConPTY `1.25.260930003` 的新 profile 在 DLL 与 OpenConsole 实际摘要校验后，
声明 `unicodeVersion: "15-graphemes"`、`unicodeScope: "session"` 和
`ownedReflowCursorLine: false`。其 0x08 字素宽度模式作用于整个 PTY 流，因此官方
`@xterm/addon-unicode-graphemes@0.4.0` 的 provider 从安装 binding 起保持到旧传输排空；
owned exit 只退出输入显示，普通命令输出继续使用相同宽度规则。该已验证组合的空闲提示符使用
`reflowCursorLine=true`，避免缩窄时截断尚在当前光标行的提示符；owned enter 仍按显式声明设为
false，owned exit 回到此空闲配置。关闭或重绑排空后恢复 false 安装基线与原 provider，
期间外部显式切换仍予以保留。注册 addon 自带的激活先恢复基线，再由 binding 管理作用域。
系统 ConPTY、旧 profile 与 raw 模式不能仅凭版本名取得这一元数据。生产准入以
[固定配置清单](agent/runtime/native-editor-admission.json) 为准。

Windows 本地会话另声明只读 `deferredStartup: true`：主线程以挂起状态创建，
registry 先提交实际渲染尺寸，再发送既有 ready 通知。后端同一工作队列先处理 resize，
再仅一次恢复 Shell，避免用新尺寸解释旧尺寸下已产生的提示符。准备前关闭只终止该挂起进程。
创建响应中的 binding 来自本地已校验的加载器和已创建的 ConPTY，是显示配置，
不表示 peer/编辑器就绪；Windows 不再在创建响应中等待挂起 Shell 的协商。
实际私有 capabilities、peer 摘要、promptReady 及输入准入仍独立核验，尚未协商时不能提交 Agent 输入。
Unix/SSH 启动保持既有行为，ready 通知也不是输入证明或执行回执。

同一后端验证的binding还可声明 `ownedReflowCursorLine: false`：该编辑器自行处理SIGWINCH
与原生重画，owned enter也保持公开reflow选项为false。字段缺省仍为true，保持既有Bash
owned路径；除上述已验证私有ConPTY组合外，普通默认及exit保持false；有序关闭都恢复false。
当前原生append型ZLE profile明确
声明true，由终端处理同流重排；该值与unicodeVersion都来自实际Core校验，不能从Shell名字或不可信OSC推断。
前端运行时拒绝非boolean，模式字节不增加或撤销执行权。实际实时历史/光标门槛独立记录，
不能仅由因果重放对照启用生产准入。

原生 provider 进入和退出显示模式的字节必须与源码回显、接受及清除处于同一 PTY 顺序。公共 parser 同步处理完整包，enter 只按已验证binding设置公开reflow选项，缺省true，exit恢复false。未完成包及未知负载不切换模式，不能用异步Prepared/Running/lease到达顺序代替原生字节边界。

在接受原文后、隐藏提交返回行交给 Bash 时，原生适配器保留无输出 redisplay provider，直到父 Shell 已从 Readline 返回并进入固定计划首个 builtin 才恢复默认绘制。off 字节在实际命令输出之前；这一顺序不由前端渲染或阶段消息授权。

`closeAfterPendingOutput()` 在公开 `terminal.write` 队列插入解析屏障，排空该传输已接收的输出后卸载 handler 并恢复显示基线，然后才能重绑。调用方须先停止旧传输继续入队并校验 generation；这是终端关闭清理，不是等待渲染后批准提交。已有明确排空保证时也可调用 `resetAfterTransportClosed()`。重复释放旧控制器不能改变后继。P2 registry 在排空后通过标准 ESC/ST 初始化流边界，再监听并放行新连接输出；Terminal dispose 前先 dispose 控制器，不能因为显示恢复而清后端 recovery。

SIGKILL 无法由死进程补发 off；真实传输 EOF 负责最终显示清理。控制通道 EOF、取消/接管与可处理的退出由原生 provider 自身恢复；提交后缺少私有结果仍是不确定，禁止自动重放。

普通显式 `close_session` 先撤除终端输入入口，并在关闭准入锁内等待已注册本地 worker 完成既有输出收尾，再结束 Broker generation。排空期间实际读到的尾部仍须进入原始捕获，不能因先关闭 Broker 而变成 stale 输出。等待不阻塞 Tauri 主线程；超过10秒仍未确认时返回关闭输出未确认并封锁传输。需要恢复的未知提交强制关闭分支仍先执行原有 fence，不凭普通尾输出生成可信结束或改写持久意图。

worker 完成通知不等于所有情况下都取得完整物理 EOF：既有有界收尾仍可能超时分离。验收必须另外核对实际 reader/child waiter/input 停止状态、`timedOut=false`、原始序号和字节边界。macOS arm64 的显式 debug 验收增加独立的 `terminal-acceptance-wire-output` / `terminal-acceptance-wire-finalized` 观察；仅 `native-input-acceptance`、debug构建及已校验的本次证据目录下启用。前者保存 Broker 准入之前实际读取的原字节，后者只报告真实 worker 状态与计数；它们不是 NIP 事件、能力证明、命令结束或用户回执。被替换/退役传输的真实尾字节也可观察，但不能因此改变后继状态或取得输入权。Broker已接受原帧与这一底层观察分别保留、核对，不能相互冒充。

排空/dispose 不重置 xterm 尚未结束的 OSC 或 UTF-8 解析状态。P2 的真实 registry 验证覆盖 native→native→raw→native、实际 producer 的半个 OSC/UTF-8、后继普通文字与原历史。关闭及重绑先停止旧回调入队，再排空、卸载并发送标准流边界，不调用 terminal.reset、清屏、重放历史或私有 parser。生产 ssh-data 使用后端增量 UTF-8 解码后的字符串；浏览器显示复验使用本次实际送入显示的完整 visible 流，包含本地状态行、过滤后的会话字节和控制序列。原始PTY字节和真实解码会话流分别保留，不能用其一替代完整显示；浏览器不得再次执行Shell源码。

Windows 新 ConPTY 的初始光标位置相对于新的可见屏幕。重绑到该传输时，先按旧传输语义排空输出，
再切换 ConPTY 选项；普通缓冲区通过标准光标定位和换行将旧屏幕 cell 滚入现有 scrollback，
保留原 cell 和其选择/视口坐标关系，然后从新的光标原点解析后继流，避免启动时的 cursor-home 覆盖旧历史。
这一步不调用 erase/reset，不读取并重写历史文本，也不修改私有解析器；alt buffer 边界另行验收。

## 权威与通用规则

任何进程 stdout 都可能产生同文 OSC，它至多改变不可信终端显示。模块不提供生命周期、ready、输入、审批或 lease 回调，不投递终端输入，不生成执行证据。只有匹配的原生私有控制/提交机制能推进命令事实。

原生编辑器的 enter、exit 与后续 capture 标记在同一 PTY 流中界定输入区间。
`terminal-command-decorations.ts` 仅使用 xterm 公共 marker、缓冲区坐标和 DOM 尺寸，
为命令执行租约对应的输入行添加背景。它不读取 `commandDisplay` 或 `commandSubmission`，
不写入终端文本。备用屏幕不显示该背景，raw 模式不安装该装饰。重绑时清理旧标记并保留终端历史。
执行准入与恢复见 [NIP 契约](agent/runtime/native-input.md)。

光标修复只在显式 reflow 时工作。复制修复是全局通用序列化规则，包括默认配置历史输出，不能以某些普通编辑对照一致推断所有旧复制行为不变。它只读真实 cell、软换行和选择范围，不保存另一份文本，不读取 command/source/lease。普通原生硬换行后 clipboard 与无换行源码的等值仅是额外诊断，不是新增产品目标。

正式xterm构建同时保留显式reflow模式中EL0清除的软换行关系；默认模式继续使用原EL0
行为。源码补丁、UMD/ESM与固定构建输入由 `scripts/dependency-builds/xterm/` 共同记录，
通过 `scripts/rebuild-xterm-patch.mjs` 重建，不单独手改安装包。该通用显示规则不产生执行权限。

通用 UTF8 byte 输入解码必须跨真实片段保留 continuation byte，包括低六位为零的 0x80，
不能把它当成不存在的残留项而丢失 U+200D 等字符。维护补丁与固定重建同时覆盖此规则；
真实捕获的 1/2/3 byte、普通分片和整块回放分别验证原字符、复制及搜索，不以解码后的字符串接口成功替代 byte 接口证据。

横向重排同时使用真实cell偏移更新普通历史选区的起止锚点，复用Buffer已有的换行、宽字符
间隙及insert/delete/trim坐标变换；不保存选中文字、不搜索原文回选，不覆盖公共选择接口。
程序自行重画的当前行或已被裁剪的锚点不能据旧坐标推断时清理无效选区；既有纵向resize
清选区、alt buffer与矩形选择行为保持。就近真实PTY数据回归覆盖公开API、正反向真实鼠标
拖选、Unicode及长源码；入口为 `pnpm test:terminal-native-selection`。

横向重排前，已经滚离底部的普通历史视口也记录顶部 cell 的临时坐标锚点；重排后按实际
insert/delete/trim 事件解析其行并限制在可用滚动范围。不能继续沿用旧数字行号，否则宽行
合并会把历史视口钳到底部。原先跟随底部的视口继续跟随，无法推断的程序自绘当前行不建立
该锚点。回归使用实际 LIVE 失败捕获，分别检查历史停留与底部跟随，不搜索文字或恢复选区。

## 可重建验证

- `pnpm check:terminal:boundary` 在 Quality Gate 中检查显示逻辑是否使用公开接口，并核对原生编辑器准入清单。
- `pnpm test:terminal-command-source`（别名 `pnpm test:terminal-command-redraw`）回放真实 PTY 采样，并用 Chromium/WebKit 和 DOM/WebGL 核对原生输入、视口、复制、搜索与重排。新鲜几何采样须包含实际读取时间，缺少采样时测试失败。
- `pnpm test:terminal-command-presentation` 先用真实普通 Shell 和原生 ZLE 采样检查命令背景范围，再运行同一套原生显示检查。

显示观察区分controller接受输出和xterm实际完成解析。`subscribeDisplayOutputParsed`只从原公开write/writeln回调通知对应的原data/source，不修改字节、控制序列、输入或生命周期事实；没有监听者时不为本地输出增加回调。该通知不授予原生、Agent或执行能力。

私有EOF验收可显式使用显示trace版本6：保留原输出接收、实际解析完成事件和每次resize时完整公共buffer/光标/viewport/selection状态。回放分别核对事件顺序、每个实际resize状态和原排空检查点；未观察到的部分解析或任何状态差异仍失败。旧版本的排空要求保持，缺失这些事件/状态的旧失败捕获不能事后升级。`node src/components/terminal/__tests__/native-display-parsed.browser.mjs`用真实cat输出及固定Chromium/WebKit/xterm验证排队写入与resize交错、完整状态相等、原始HTTP字节留存及负向拒绝，不执行Shell源码回放，也不提供原生或人工验收回执。

`pnpm test:terminal-native-display` 直接使用仓库内由真实 PTY 导出的冻结包片段；缺失或摘要不符会失败，不依赖旧机器上的忽略目录。

`pnpm test:terminal-input:p1` 从源码重建正式 NIP producer，重新捕获真实 PTY，并在 Chromium/WebKit × DOM/WebGL 校验正式键、碎片、输出排空、EOF 半包、重绑、旧控制器重复释放及零可执行输入。显示断言不伪造原生控制回执。

`pnpm test:terminal-native-input:p0:formal` 从固定 GNU 源码构建原型并重新采集真实 PTY，再用正式安装包验证复制、同流模式、边界、几何和提交。也可显式传入每项真实 capture 路径回放，结果记录这些输入路径与当前源码/运行包摘要。重采集后可运行 `node scripts/export-native-display-fixture.mjs --captures <successful ownership capture>` 重新生成就近 fixture；它只导出显示字节，不伪造私有回执。

历史冻结范围和结果保留在Git历史，不外推当前源码、Linux/SSH新扩展、Windows、其他架构或用户插件。当前待验范围见[统一验收清单](../docs/design/agent-terminal-input-acceptance-checklist.md)，历史通过结果不能启用未验收的生产配置。

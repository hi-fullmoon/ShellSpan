# Native editor display integration

用户于 2026-10-31 明确批准通用 xterm 光标重排、软换行复制修复及同流显示切换纳入正式实现。该授权包含默认配置历史输出的通用复制规则变化，不授权业务层文字投影或公共选择/搜索/buffer API 覆盖。

P0 依赖已采用 pnpm 对精确 `@xterm/xterm@6.0.0` 的 source + UMD/ESM 构建补丁。P1 冻结 `shellspan.native-input`，正式 binding 为 OSC 1337 的 `SetUserVar=ShellSpanNativeInput=MQ==` / `MA==`，由 `NATIVE_INPUT_DISPLAY` 导出；详见 [NIP](agent/runtime/native-input.md)。P0 实验键继续只用于原型及历史 fixture，不作为正式能力证明。

## 接入边界

实现入口是 `src/lib/terminal/native-input-display.ts::attachNativeInputDisplay`。调用者必须传入显式 native 模式与已协商的 OSC identifier、enter/exit payload。模块不隐式安装正式 binding，不自行探测提示符、lease、命令文本或原生源码。registry 仅在后端协商的 native metadata 下安装。当前仅有native-inline/raw，raw不安装装饰或新handler。当前实现及待验范围见[实现说明](../docs/design/agent-terminal-input.md)。

普通编辑基线为 `reflowCursorLine=false`。不满足基线或同一 Terminal 重复安装时，附加操作拒绝且不改用户选项。资源释放后可显式重绑；输入权、代次和输入准入始终由既有后端边界决定。

P3 受控验证可在后端已校验的 ZLE Core/profile 对应 `nativeDisplayBinding` 中附加只读
`unicodeVersion: "11"`。该字段来自本地资源的实际 Core 校验，不接受 peer 自报、OSC、前端
ready 或版本字符串作为证明。快照与本地 Session 启动等待必须使用同一 binding 生成函数。
registry 仅据该元数据按需注册官方 provider，注册不改变普通默认；显示模块仅在完整 owned
enter 时保存原 provider 并启用选择，exit、有序关闭及销毁时恢复。重复 enter 不覆盖原值，
期间显式发生的外部 provider 切换予以保留。未选该配置时不访问或改变 provider。
该实现仍受[实现说明](../docs/design/agent-terminal-input.md)的资源、平台与窗口
门禁约束，不表示未验收 profile 已启用；provider 显示状态不能授权执行。

同一后端验证的binding还可声明 `ownedReflowCursorLine: false`：该编辑器自行处理SIGWINCH
与原生重画，owned enter也保持公开reflow选项为false。字段缺省仍为true，保持既有Bash
owned路径；普通用户默认、exit和有序关闭仍为false。当前原生append型ZLE profile明确
声明true，由终端处理同流重排；该值与unicodeVersion都来自实际Core校验，不能从Shell名字或不可信OSC推断。
前端运行时拒绝非boolean，模式字节不增加或撤销执行权。实际实时历史/光标门槛独立记录，
不能仅由因果重放对照启用生产准入。

原生 provider 进入和退出显示模式的字节必须与源码回显、接受及清除处于同一 PTY 顺序。公共 parser 同步处理完整包，enter 只按已验证binding设置公开reflow选项，缺省true，exit恢复false。未完成包及未知负载不切换模式，不能用异步Prepared/Running/lease到达顺序代替原生字节边界。

在接受原文后、隐藏提交返回行交给 Bash 时，原生适配器保留无输出 redisplay provider，直到父 Shell 已从 Readline 返回并进入固定计划首个 builtin 才恢复默认绘制。off 字节在实际命令输出之前；这一顺序不由前端渲染或阶段消息授权。

`closeAfterPendingOutput()` 在公开 `terminal.write` 队列插入解析屏障，排空该传输已接收的输出后卸载 handler 并恢复显示基线，然后才能重绑。调用方须先停止旧传输继续入队并校验 generation；这是终端关闭清理，不是等待渲染后批准提交。已有明确排空保证时也可调用 `resetAfterTransportClosed()`。重复释放旧控制器不能改变后继。P2 registry 在排空后通过标准 ESC/ST 初始化流边界，再监听并放行新连接输出；Terminal dispose 前先 dispose 控制器，不能因为显示恢复而清后端 recovery。

SIGKILL 无法由死进程补发 off；真实传输 EOF 负责最终显示清理。控制通道 EOF、取消/接管与可处理的退出由原生 provider 自身恢复；提交后缺少私有结果仍是不确定，禁止自动重放。

排空/dispose 不重置 xterm 尚未结束的 OSC 或 UTF-8 解析状态。P2 的真实 registry 验证覆盖 native→native→raw→native、实际 producer 的半个 OSC/UTF-8、后继普通文字与原历史。关闭及重绑先停止旧回调入队，再排空、卸载并发送标准流边界，不调用 terminal.reset、清屏、重放历史或私有 parser。生产 ssh-data 使用后端增量 UTF-8 解码后的字符串；浏览器复验按这一真实传输类型回放原始 PTY 捕获。

## 权威与通用规则

任何进程 stdout 都可能产生同文 OSC，它至多改变不可信终端显示。模块不提供生命周期、ready、输入、审批或 lease 回调，不投递终端输入，不生成执行证据。只有匹配的原生私有控制/提交机制能推进命令事实。

光标修复只在显式 reflow 时工作。复制修复是全局通用序列化规则，包括默认配置历史输出，不能以某些普通编辑对照一致推断所有旧复制行为不变。它只读真实 cell、软换行和选择范围，不保存另一份文本，不读取 command/source/lease。普通原生硬换行后 clipboard 与无换行源码的等值仅是额外诊断，不是新增产品目标。

正式xterm构建同时保留显式reflow模式中EL0清除的软换行关系；默认模式继续使用原EL0
行为。源码补丁、UMD/ESM与固定构建输入由 `scripts/dependency-builds/xterm/` 共同记录，
通过 `scripts/rebuild-xterm-patch.mjs` 重建，不单独手改安装包。该通用显示规则不产生执行权限。

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

`pnpm test:terminal-native-display` 直接使用仓库内由真实 PTY 导出的冻结包片段；缺失或摘要不符会失败，不依赖旧机器上的忽略目录。

`pnpm test:terminal-input:p1` 从源码重建正式 NIP producer，重新捕获真实 PTY，并在 Chromium/WebKit × DOM/WebGL 校验正式键、碎片、输出排空、EOF 半包、重绑、旧控制器重复释放及零可执行输入。显示断言不伪造原生控制回执。

`pnpm test:terminal-native-input:p0:formal` 从固定 GNU 源码构建原型并重新采集真实 PTY，再用正式安装包验证复制、同流模式、边界、几何和提交。也可显式传入每项真实 capture 路径回放，结果记录这些输入路径与当前源码/运行包摘要。重采集后可运行 `node scripts/export-native-display-fixture.mjs --captures <successful ownership capture>` 重新生成就近 fixture；它只导出显示字节，不伪造私有回执。

历史冻结范围和结果保留在Git历史，不外推当前源码、Linux/SSH新扩展、Windows、其他架构或用户插件。当前待验范围见[实现说明](../docs/design/agent-terminal-input.md)，历史通过结果不能启用未验收的生产配置。

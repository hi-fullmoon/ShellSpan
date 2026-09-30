# Petdex 0.8.0 气泡契约

契约核验日期：2026-09-29；阶段9生产传输及阶段10原生设置复验：2026-09-30。下文保留阶段6真实协议和显示证据。ShellSpan已实现默认禁用的消息发送、有限结算与原生设置入口；确认产品范围见[设计](../../docs/design/petdex-message-integration-design.md)，真实操作与显示边界见[验收](../../docs/design/petdex-message-integration-acceptance.md)。

## 固定依据

客户端重试调度：动作与气泡均在共享退避截止时间之后进入发送尝试，退避期间仍处理取消、配置变化和内容到期。进入尝试后保留1500ms总预算及发送前的节流复查；若手动请求或并发请求在已有失败退避期间超时，不增加共享失败计数，也不推迟已有恢复截止时间。

- 安装：`/Applications/Petdex.app`，Info.plist版本0.8.0，实际进程36116。二进制SHA-256：`878448e0e0a742608df3d9f7048796e7b362166a5a648d5c676c089dc0fa7522`。
- 官方tag `desktop-v0.8.0`，commit `f2ea48aac6f89fbaeedd6a639faf4e208864ae5d`。
- [hook_server.zig](https://github.com/crafter-station/petdex/blob/f2ea48aac6f89fbaeedd6a639faf4e208864ae5d/packages/petdex-desktop-native/src/hook_server.zig)：完整route、Bubble、setBubbleWithMetadata、jsonString、bubbleSessionKey、mirrorBubble。
- [main.zig](https://github.com/crafter-station/petdex/blob/f2ea48aac6f89fbaeedd6a639faf4e208864ae5d/packages/petdex-desktop-native/src/main.zig)：poll_tick、bubbleActive、agentArtBytes/agentIconIndex、bubbleExpiryMs/bubbleLifetimeExpired、syncBubbleDeadlines、expireBubbles、collapseToNewest、bubbleCard与设置处理。
- 本轮重新下载与既有缓存逐字节相同。hook源码SHA-256 `8dc82d501fe6e700987a9f266af96b7b2ee066bf09e282182b816509ee507150`；main源码SHA-256 `d8f8030d214202d5532cc37e5e65a1ea2a7e9314b20f86c6d89c01fc1e4b6bf0`。未建立安装二进制与源码的可复现构建对应，不将静态结论冒充安装版显示结果。

## 请求与响应

固定loopback `POST http://127.0.0.1:7777/bubble`，`Content-Type: application/json`、现有敏感请求头 `X-Petdex-Update-Token`。缺失认证401，缺失text400，共享state/bubble限流30/s；成功为有限JSON `{"ok":true,"counter":整数}`。不从counter推断屏幕显示或所有权。

生产允许正文示意（键只是占位，不用于探针）：

```json
{"conversation_key":"shellspan-<random-installation-id>-slot-1","agent_source":"shellspan","title":"ShellSpan","text":"正在上传文件","busy":true}
```

| 字段 | 0.8.0源码语义 | ShellSpan约束 |
| --- | --- | --- |
| text | 必须为字符串；原始JSON字符串内容切片前200字节 | 必填、安全规范化后≤200 UTF-8字节 |
| title | 可省略；原始字符串前96字节 | 固定标题或明确允许的受限详情，≤96 |
| agent_source | 可省略；原始字符串前24字节 | 固定shellspan，不伪装其他客户端 |
| conversation_key | 优先于petdex_conversation_key/session_key/session_id；安全ASCII且≤64字节原样，否则SHA-256规范化；缺省共享空键 | 随机安装标识＋固定slot-1/2/3，不发送业务身份，始终非空 |
| busy | 扫描整个body是否包含精确字面量`"busy":true`，不是完整JSON布尔解析 | serde_json紧凑编码；必须布尔，不pretty print |

不发送source_app/source_tty/source_cwd/herdr_pane_id；不引入点击跳转。接口没有message、气泡duration、TTL、按键删除或release。完整route仅GET/POST分支，内部dropBubble/clearBubbles不是HTTP接口；空text依然占槽。没有通过发送猜测DELETE或全局清空进行试验。

## 原始字符串与UTF-8边界

jsonString扫描并跳过合法JSON转义，但返回未反转义的原始切片。因此长度上限作用于**JSON字符串内部转义后的字节**，不是解码后字符数。后端按字节截断，可能切断UTF-8或转义序列。镜像把原始切片重新插入JSON，客户端JSON解析可能反转义出正常文字；这个结果不能证明渲染器也是正常文字。

本机真实结果（counter确认仅关联本次固定探针，不输出其他正文）：

- 未转义中文，正文`中×66+AB`恰200字节、标题`中×32`恰96字节：请求接受；compact busy=false镜像一致。显示仍待核验。
- ASCII正文201/标题97字节：镜像分别200/96，证明接收端截断。
- 正文`A×198+反斜杠+Z`原文200字节，title为`T×94+反斜杠+Z`原文96字节：JSON转义后分别201/97，镜像解码后仅199/95，尾部Z消失。证实限制不是原文长度。
- 固定句同时含中文弯引号、英文双引号、反斜杠和换行：请求接受，解析镜像等于输入；随后[用户原生截图](../../docs/design/assets/petdex-stage6-escaped-text.png)确认英文引号前的反斜杠、双反斜杠及字面量`\n`直接显示，换行未还原。尾部因显示宽度省略，不能声称完整next可读。镜像解码正确不能证明显示正确，必须规范化。
- 同样busy=true，compact JSON镜像true，默认带空格编码镜像false；compact false镜像false。不能把普通JSON语义正确等同于该版本正确处理busy。

阶段8硬约束：采用成熟Markdown解析器和serde_json，不复制对端脆弱解析器。先敏感检测与字段整体回退，再提取普通文字、控制字符/换行归一空格、ASCII双引号换可读弯引号、反斜杠换全角字符，最后UTF-8边界裁剪并再次验证。输出不含需转义的字符，转义前后字节一致；这也避免任意内容干扰busy字面量识别。不得只按JS字符串length限制，不手动拼JSON，不发ASCII-only的\u编码替代原生UTF-8。[规范化截图](../../docs/design/assets/petdex-stage6-normalized-text.png)已确认可见部分的弯引号及单个反斜杠正常，没有多余JSON转义符；尾部next被显示省略，未独立确认其可读。不将本轮固定探针视为详情业务已实现。

## 同键、多槽与显示

Mailbox全局最多8槽。同键覆盖原槽，更新counter；满时淘汰最久未更新槽。ShellSpan最多使用3个固定键，不能保证外部槽永久存在或三个气泡同时可见。槽重绑是客户端映射，协议不知道内部归属或代际。

每100ms轮询消费气泡。按会话显示开启时按counter排序，最新在前；关闭时显示最新一条，不改HTTP会话键语义。切回多会话显示依赖后续事件重新填充，不保证立即恢复全部卡片。

`agent_source=shellspan`不是识别的官方agent名，agentArtBytes/agentIconIndex走通用fallback。用户提供的[原生截图](../../docs/design/assets/petdex-stage6-two-slots.png)已确认其显示为深色方块内的通用人物头像。截图还确认两槽共存，slot1更新为“第一槽第二次更新”，slot2仍为“阶段六：第二槽”，普通中文标题/正文可读。标题在当前宽度下换行，不能保证标题始终单行。

GET /bubble读取最后写入镜像，不是所有槽清单、生命周期状态或屏幕实时状态。过期/隐藏/关闭不保证更新镜像；不读其他客户端正文来推断驱逐/删除成功。源码和阶段5动作实测都说明状态镜像不是显示确认。

## busy、寿命和显示设置

| 条件 | 固定源码行为 | 当前真实证据 |
| --- | --- | --- |
| busy=true | 到期deadline=-1，不自动过期 | 寿命5秒，发送后超过10秒用户确认仍显示且有旋转指示 |
| busy=false，寿命0 | deadline=-1，仍不过期 | 两槽结算后仍显示的原生截图已确认；同屏存在waiting标记，不将此视为排除waiting影响的隔离验证 |
| busy=false，寿命1–60秒 | 新内容设到期；同counter保留原deadline | 临时设5秒后用户确认消息已消失，随后恢复0；不是精确到期边界计时 |
| 全局waiting | 阻止到期，哪怕该槽busy=false；最新非busy卡显示橙色! | 同键结算false、寿命5秒，超过10秒用户确认仍在且带橙色!；支持等待阻止到期，不声称连续逐帧计时，本轮未发全局动作 |
| Show messages关闭 | clearBubble；随后接收也不呈现 | 原生关闭并发送新请求，用户确认无任何气泡；已恢复true |
| Focus Mode开启 | clearBubble并抑制显示 | 用户设为Off前两次反馈未看到，Off后确认可见并提供截图；由用户操作，保留最新Off偏好 |
| One bubble per conversation关闭 | 当前模型折叠到最新，后续只显示最新 | 用户确认只剩最新第二槽，随后原生恢复true；两槽最后均busy=false |

busy=false不提供删除保证；寿命0或waiting时可长期残留。不能用修改全局寿命、关闭显示或clearBubble代替自己的关闭结算。

## 安全和未来客户端约束

阶段11可靠性续验：同一生产客户端对真实Petdex测得关闭墙钟1502ms，以及1500ms内两个槽结算成功、第三槽未完成，返回unconfirmed但消息关闭，之后己方三槽全部正常结算。名义1500ms deadline不意味着操作系统调度零误差；没有按槽重开预算。官方受控重启前后令牌只在内存比较，确认变化，未输出令牌或哈希。Disabled无通信仍按生产门禁/请求锁与有限日志证据说明，网络级抓包受当前BPF权限限制。

阶段11复验补充（2026-09-30）：真实SSH/SFTP/AI已触发生产通道，用户截图确认三张等待气泡；CUA原生窗口确认“另有 2 个会话或连接，2 项任务进行中”摘要、摘要退出及活动退出后三条“ShellSpan 活动已结束”。追加单/双传输、有限标题/基本名、关闭详情回固定模板、英文等待、规范化最终回复及固定测试文字实际显示。部分英文及测试文字被当前气泡宽度省略，AX完整不等于全部文字均在截图可读。退出后卡片可残留且有等待标记，再次支持busy=false不等于删除。真实Petdex不可用时总开关仍关闭，恢复后持续开启能自动连通；精确预算、其他客户端共存及未补播内容等仍按[阶段11审计](../../docs/design/petdex-message-integration-acceptance.md#阶段11检查与待续审计)限定证据，不扩大协议保证。

固定loopback、禁代理/重定向、有界响应与超时。复用现有匿名health/whoami兼容门禁、取消/请求锁；真实探针额外核对whoami PID对应官方可执行路径，token读取前及认证请求前再次核查。不输出token或摘要。这仍不是原子服务身份绑定，TOCTOU保留。

动作/消息共享100ms写入间隔及429退避；每槽最新版本、普通300ms合并。关闭消息/总开关/正常退出只对已用槽busy=false，全部结算共享1500ms预算，失败也确认关闭，Disabled后无通信。配置生效与cleanup未确认分离。上述客户端行为已在阶段9–10实现并通过生产回归，不能据此推断全部真实业务及显示验收通过；阶段11状态见[待续审计](../../docs/design/petdex-message-integration-acceptance.md#阶段11检查与待续审计)。

阶段8实现说明：安全内容边界已落在 `src-tauri/src/petdex/message_content.rs`，共享双语资源为 `src/locales/petdex-messages.json`。有限详情先对≤32KiB完整候选做redaction检查，再以pulldown-cmark/linkify提取允许文本，按上文规范化与字节上限裁剪，最后紧凑serde_json编码。内联HTML保守整字段回退。对外仅允许SafeMessage的五个字段，不序列化内部归属/运行；两消息偏好默认false。此为生产内容模型和本地回归，不是新HTTP/显示证据，网络发送尚未接入。接口和代际规则见[阶段8交接](../../docs/design/petdex-message-integration-acceptance.md#阶段8实现与交接验收)。

阶段9实现说明：`petdex/message_delivery.rs` 现已复用协调循环及 `transport.rs` 的锁、客户端与匿名门禁发送 `/bubble`。成功响应必须≤1024字节且serde解析为 `ok=true`、正整数counter；HTTP200本身不确认接受。动作、气泡和一次token轮换重试共用100ms写入间隔、429至少1秒退避及有界失败退避。普通尝试与全部关闭槽分别共享1500ms总预算。安装持久化在阻塞worker执行，用单调写入版本保护迟到结算。真实Petdex0.8.0/PID72831的三个固定测试槽已通过生产发送和关闭，最终均非忙碌；无新显示截图，不据此声称可见或已删除，详见[阶段9验收](../../docs/design/petdex-message-integration-acceptance.md#阶段9实现与交接验收)。

# Petdex 0.8.0 气泡契约

本文记录 ShellSpan 的气泡行为及其在 Petdex Desktop 0.8.0 上的显示限制。动作通道见[联动契约](integration.md)。

## ShellSpan 气泡行为

- 消息与详情默认关闭，共用 Petdex 总开关和 SSH、SFTP、AI 分类。AI 按会话归属，SSH 与 SFTP 按后端连接归属，跨连接复制归目标连接。部署联动仍延期。
- 最多使用三个固定槽。超过三个归属时，单独显示优先级最高的两个，其余归属合入第三槽。失败优先于等待，等待审批优先于等待回答，随后依次为完成、运行和连接中。同级优先保留已展示的归属。SFTP 按批次计数，摘要排除已单独展示的对象。
- 默认按实际活动阶段显示双语模板，跟随应用语言。开启详情后，允许显示有限的任务或会话标题、文件基本名和已完成的助手最终回复。摘要槽使用模板和计数。关闭详情时丢弃待发详情，当前有效槽回到模板。详情可能包含业务信息，已接受的内容无法撤回。

## 固定依据

客户端重试调度：后台动作与气泡均在共享退避截止时间之后进入发送尝试，退避期间仍处理取消、配置变化和内容到期。进入尝试后保留1500ms总预算及发送前的节流复查；手动测试（测试动作/发送测试文本）与关闭结算仅遵守最短写入间隔与429限流，不阻塞在后台失败退避上；若并发请求或手动测试在已有失败退避期间失败或超时，不增加共享失败计数，也不推迟已有恢复截止时间。

- 官方tag `desktop-v0.8.0`，commit `f2ea48aac6f89fbaeedd6a639faf4e208864ae5d`。
- [hook_server.zig](https://github.com/crafter-station/petdex/blob/f2ea48aac6f89fbaeedd6a639faf4e208864ae5d/packages/petdex-desktop-native/src/hook_server.zig)：完整route、Bubble、setBubbleWithMetadata、jsonString、bubbleSessionKey、mirrorBubble。
- [main.zig](https://github.com/crafter-station/petdex/blob/f2ea48aac6f89fbaeedd6a639faf4e208864ae5d/packages/petdex-desktop-native/src/main.zig)：poll_tick、bubbleActive、agentArtBytes/agentIconIndex、bubbleExpiryMs/bubbleLifetimeExpired、syncBubbleDeadlines、expireBubbles、collapseToNewest、bubbleCard与设置处理。

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

生产实现先对不超过 32 KiB 的完整候选做敏感检测，失败时整字段回退。通过后用 Markdown 解析器提取普通文字，把控制字符和换行归一为空格，ASCII 双引号换成弯引号，反斜杠换成全角字符，再按 UTF-8 字节边界裁剪并用 `serde_json` 紧凑编码。内联 HTML 保守回退，内部归属和运行标识不会序列化。[规范化截图](../../docs/design/assets/petdex-stage6-normalized-text.png)展示可见部分的效果；气泡仍可能省略尾部。

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

## 传输与关闭结算

气泡复用动作通道的固定回环地址、匿名兼容检查、请求锁、取消和限流。客户端拒绝代理和重定向；匿名检查不提供服务身份认证。气泡接受要求响应不超过 1024 字节，且能解析为 `ok=true` 和正整数 `counter`。

动作、气泡及令牌轮换后的单次重试共享 100ms 最短写入间隔与退避，429 至少退避 1 秒。各槽只提交最新版本，普通更新合并窗口为 300ms。关闭消息、关闭总开关或正常退出时，只对已用槽发送 `busy=false`；所有槽共享 1500ms 结算预算。关闭仍可生效，未确认的结算另行反馈。安装状态在阻塞任务中持久化，以单调版本防止迟到结算覆盖新状态。

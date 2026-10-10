# Petdex 消息气泡阶段6–11验收

当前状态：阶段6–11已完成并通过协调审阅。用户最后明确回复“同时存在”，确认本轮真实Codex卡与ShellSpan卡共存；颜色测试记录已按授权停止并删除。17:55已恢复消息/详情false、三槽非忙碌并正常退出开发应用；保留外部启动的Petdex和新Codex钩子。验收按下文分层证据成立，网络抓包等覆盖边界继续保留，不作更强保证。

日期：2026-09-29，Asia/Shanghai。**阶段6完成：确认方案、真实HTTP契约与原生显示均已有相应范围的证据，可以交接阶段7。** 本阶段只改文档和保存用户提供的截图，未修改业务实现、UI、CSP或配置IPC。未创建后续会话。

## 证据范围与环境

阶段6按固定官方源码、真实请求、用户原生截图及现场观察分层验收，不以HTTP200或GET镜像替代显示。显示计时采用“发送后至少10秒再询问”的有限观察，不宣称逐帧精确时间或穷尽组合。寿命0的实际留存与waiting同时出现，未隔离二者，限制详见下文。

初始已有 docs/design/petdex-integration-implementation-plan.md、protocol/petdex/integration.md 修改，以及两份未跟踪消息文档，均保留。已读根AGENTS、两份消息文档、既有协议及阶段0–5相关验收，docs/protocol未检出子目录AGENTS。

本机Petdex 0.8.0，PID36116，官方可执行文件为 /Applications/Petdex.app/Contents/MacOS/petdex-desktop-native。Python712仍监听*:7777，Petdex监听127.0.0.1:7777；未停止、重启或改动这两个进程，未操作SecurityAgent或提升权限。安装二进制和固定官方源码的校验值见[气泡协议](../../protocol/petdex/bubble.md)。没有可复现构建一致性证明，不能仅凭版本号把源码结论写成安装版实测。

临时探针 /tmp/petdex-stage6-probe.py 通过apply_patch编辑，使用Python标准库urllib/json，固定loopback、空代理、禁止重定向、单请求750ms、响应最多4096字节；不手写JSON/HTTP解析。读取token前和每次认证请求前均核对health/whoami、PID及ps官方路径。token仅用于内存认证，不输出token或摘要。匿名检查仍有TOCTOU，不能提供原子服务身份绑定。

只使用两个明确命名的专用键 shellspan-stage6-contract-slot-1/2，没有覆盖其他会话键。仅在响应counter和shellspan来源匹配本请求时输出镜像布尔/长度，不输出正文，也不利用他人消息做显示推断。没有压测限流/8槽驱逐，没有发送猜测DELETE、空text、全局idle或直接调用全局清空。经授权临时切换显示设置是显示测试，不作为ShellSpan清理接口；设置本身可能全局清除显示，这一协议副作用已明确保留。

## 最终验收矩阵

| 项目 | 真实证据 | 结论及范围 |
| --- | --- | --- |
| 字段、认证、真实服务 | 请求前核对官方PID36116；text/title/agent_source/conversation_key/busy请求返回ok/counter | 请求契约通过；不等于显示确认 |
| 安全UTF-8边界 | 10:17:04.593 UTC，中文正文200字节、标题96字节接受 | 安全字节上限请求通过；没有宣称完整长文字屏幕可见 |
| 截断与转义长度 | ASCII201/97变为200/96；原文200/96含末尾反斜杠+Z，转义后201/97，镜像解码199/95且丢Z | 上限作用于JSON原始内容切片；客户端必须先规范化再安全裁剪 |
| compact busy | compact true镜像true，默认带空格的true镜像false，compact false镜像false | 0.8.0必须紧凑序列化 |
| 首条实际显示、专注模式 | 19:38 CST两次用户看不到；用户将Focus Mode设为Off；11:53:05.403 UTC重发后用户明确“能看到” | 有真实显示依据；前后观察支持专注模式影响，不曾取得On菜单截图 |
| 两槽及同键覆盖 | 用户先确认两卡；11:58:37.899 UTC仅更新slot1，随后提供[两槽截图](assets/petdex-stage6-two-slots.png) | 仍两卡，slot1“第一槽第二次更新”，slot2“阶段六：第二槽”未变；通过 |
| shellspan来源与普通中文 | 同一截图显示两卡为深色方块内通用人物头像，中文标题/正文可读 | fallback和普通中文通过；标题在当前宽度下换行 |
| 原始转义显示 | 12:01:32.134 UTC固定句后用户提供[转义截图](assets/petdex-stage6-escaped-text.png) | 英文引号前反斜杠、双反斜杠和字面量换行转义直接显示，确认原始切片限制 |
| 规范化显示 | 12:02:21.616 UTC用弯引号、全角反斜杠及空格替换后，用户提供[规范化截图](assets/petdex-stage6-normalized-text.png) | 可见部分无多余JSON转义；末尾next被省略，不能声称全文可读 |
| 寿命5秒、非busy到期 | 12:09:55.687 UTC发非busy文字，超过五秒后用户回复“已经消失” | 真实消失通过；不是精确5秒边界测量，旧截图不能证明此窗口一直waiting |
| 寿命5秒、busy保留 | 12:39:02.292 UTC busy=true，超过10秒后用户确认“仍在，并有旋转指示” | 忙碌状态及持续保留通过 |
| busy=false结算及waiting保留 | 12:39:45.646 UTC同键改false，超过10秒后用户确认“仍在，带橙色!” | 非busy结算后仍可留存，支持waiting阻止到期；没有连续录像，不宣称每帧状态恒定 |
| 单气泡模式 | 12:45:22.387–.393 UTC先写slot1再slot2，临时关闭One bubble per conversation；用户确认只剩第二槽 | 最新卡显示通过，已恢复true |
| 关闭气泡显示 | 临时关闭Show messages，12:47:41.296 UTC又发非busy请求；用户确认“没有任何气泡” | 隐藏及关闭期间接收不显示通过；已恢复true |
| 恢复显示、寿命0 | 12:48:48.270 UTC恢复显示后发非busy请求，超过10秒后用户确认“仍在，带橙色!” | 恢复显示与寿命0下留存有实际证据；未隔离waiting，不用有限观察证明永久不消失 |
| 无HTTP按键删除/气泡duration | 固定官方源码完整route只提供现有GET/POST及字段；内部dropBubble不是路由 | 不支持；未以空文字或猜测DELETE伪造删除 |
| 镜像不是显示 | 关闭/专注期间请求接受却看不到，原始转义镜像解码正常但截图含转义符 | 显示和状态镜像已明确分离 |

所有时间均为UTC，CST加8小时。图片是用户提交的原始桌面截图，未编辑。后续口头/选项答复是用户现场观察，不能写成自动化截图或连续录像。

## 已知限制及是否阻碍实施

以下是明确保留的覆盖边界，不把它们改写为通过，也不把阶段6必需的实际显示项延期到阶段11：

- **寿命0未在无waiting的完整窗口内隔离验证。** 已实际验证0配置下非busy留存，同时有等待标记；源码明确0不设到期，产品不依赖自动消失。因此不阻碍阶段7内部归属/调度或既定关闭方案，不能承诺客户端有删除能力。此前“寿命0隔离验证”是补充观察目标，最终只登记组合证据。
- **没有精确到期边界、所有1–60秒取值、所有客户端排列、满8槽/429压测或超长多字节破坏性显示。** 不影响三固定槽、低速写入、本地字节校验方案；这些没有被计为真实通过。
- **200/96字节安全中文由真实请求确认，截图只证明普通中文显示。** 超长内容会被显示省略；不保证协议接受的全部文字可见。完整next尾部未看到，不阻碍阶段8按字节生成受限预览。
- **Focus Mode的初始On菜单值没有截图。** 用户将其设为Off前不可见，之后明确可见；当前保持用户Off。不能声称自动化直接读取过该菜单。
- **源码与二进制无可复现构建证明，匿名PID/路径检查仍有TOCTOU。** 保留阶段5兼容防护和失败关闭，不弱化凭证保护。
- **寿命0或waiting可导致结算后卡片残留。** 本阶段证明busy=false不是删除；产品必须显示cleanup接收/未确认，而不能承诺气泡移除。

必需字段、同键/多槽、busy、寿命0/非0的实际观察、显示关闭、专注及单气泡效果均已有匹配范围的真实证据；以上组合/计时边界不转化为未经支持的产品保证。阶段7不需要新增Petdex能力，可以实施。

## 设置恢复及测试收尾

开始基线：Show messages=true、One bubble per conversation=true、Bubble lifetime=0、文字大小8、每行40字符、回答2行。测试期间两次临时设寿命5并恢复0，单气泡选项与Show messages均恢复true。最终持久化值已读取核对。Focus Mode保留用户最新Off；用户移动过宠物位置，不覆盖回旧坐标。未改变ShellSpan偏好、业务会话或部署设置。

已用两个专用键最后写入均busy=false，未遗留本轮忙碌测试。Show messages测试按对端设计清除了当时显示集合；恢复后只发slot1进行最终留存观察，没有通过结算重新创建其他槽。寿命0下slot1可能继续显示“气泡显示重试”，如实保留残留，不全局清空或宣称删除成功。

CUA能捕获桌宠主窗口和设置窗口，不能取得独立气泡窗口；部分坐标操作因窗口变化失败，重新读取后才继续。可见性依靠上列用户截图和现场答复，不以工具主窗口缺少气泡推断隐藏。没有用其他技术绕过GUI工具限制，没有停止其他任务或未知进程。

## 构建与检查

| 命令 | 结果 | 范围 |
| --- | --- | --- |
| pnpm build | 退出0，TypeScript/Vite通过 | 阶段6无业务变更；保留既有chunk/静动态导入警告 |
| cargo test --manifest-path src-tauri/Cargo.toml petdex --lib | 退出0，49 passed、4 ignored | 现有生产逻辑及既有fixture回归；ignored不算通过 |
| git diff --check | 退出0 | 文档差异检查；新文件由apply_patch保存并复读 |

日志 /tmp/petdex-stage6-build.log、/tmp/petdex-stage6-tests.log。之后仅更新文档/截图及独立真实探针，不无故重复无变化构建或完整测试。没有新增mock/虚假模型服务、业务测试绕过或凭证输出；阶段5历史结果不冒充本阶段覆盖。

## 阶段7接口交接

按[确认设计](petdex-message-integration-design.md)继续；以下为阶段6当时的交接，后续实施结果见本文各阶段验收：

1. 在ActivityEvent/ActivityGuard增加内部ActivityOwner（AI会话、后端连接）与有限ActivityKind；跨连接复制归目标连接，不建第二套事件来源。内部身份与显示详情分离，不进入外发序列化。
2. 三固定槽：不超过三归属分别显示，更多为两个优先对象＋第三摘要；失败>等待>完成>运行>连接中，同级保留，真实运行去重计数。
3. 每槽bindingGeneration/revision，继承现有worker/driver取消代际与结果绝对TTL；旧事件/回执不得恢复旧归属或覆盖新投影。
4. 随机安装标识＋固定slot-1/2/3，不外发session/connection/credential hash；最小已用槽标记、多窗口共用写入者及必要成熟进程锁。
5. 阶段7只完成内部模型/调度和生产回归，不提前开启网络消息或新增UI。阶段8再接模板/详情，按实测原始JSON切片约束规范化，并使用成熟Markdown解析器、redaction整字段回退、紧凑serde_json。
6. 阶段9执行共享100ms间隔、普通300ms合并、各槽latest-only，以及全部已用槽共享1500ms结算；失败也关闭，Disabled无通信。阶段10处理配置生效与cleanupOutcome分离、预编译校验/CSP及现有Petdex设置区。阶段11做生产全链复验，不拿协议探针代替业务验收。

原会话负责建立阶段7的独立用户可见会话。本会话未创建下一会话，未创建commit/tag/push；部署仍延期。

## 阶段7实现与交接验收

日期：2026-09-30，Asia/Shanghai。阶段7完成内部归属、三槽投影及权威生命周期接线。开始时 `git status --short` 为空；未把阶段6已经保存的工作误认为未提交变更。上文阶段6的真实HTTP、截图、用户现场答复和未验证边界均保留；本节测试不是新的Petdex显示验收。

### 实现文件和生产路径

- `src-tauri/src/petdex/types.rs`：内部 `ActivityOwner::Ai(String)` / `Connection(Arc<Uuid>)`，有限 `ActivityKind`（连接、上传、下载、同端复制、跨端复制、AI准备、AI处理）。Owner和投影不实现Debug/Serialize，业务身份不进入外发或诊断结构。
- `petdex.rs` 的 `ActivityGuard::owned/start_owned/transition_with_kind` 仍使用原来的同步仲裁锁、全局递增run_id和同一事件源。`arbiter.rs` 在原有水位、revision和终态墓碑验证之后保留有效结果；动作优先级、取消、预览、绝对TTL沿用原实现。消息结果使用同一成功1200ms/失败2500ms截止时间，过滤或关闭后不会重播旧结果。
- `commands.rs` 的SSH worker和四个SFTP操作入口已接真实归属与类型；Guard仍由实际worker持有，每个上传/下载批次只登记一次，不按文件计数。跨端复制通过 `petdex_cross_copy_owner` 明确使用目标连接。
- `sftp_pool.rs::activity_owner` 复用后端既有 `ConnectionKey` 相等规则；没有新增按主机名或凭据摘要猜测归属的规则。池内Weak映射对相同连接复用随机内存句柄，池克隆共享映射；凭据摘要只属于原有后端连接匹配键，不进入ActivityOwner、持久化或外发。活动、当前结果与投影释放后，失效映射在下一次查询清理。每次worker重建仍有独立run_id，旧终态不能结束新worker。
- `agent_runtime/petdex.rs` 在driver准入、提交回合、等待审批/回答和恢复映射出口提供会话归属；driver准备阶段使用AiPreparing，提交真实回合后使用Ai。保留现有driver/turn保护、拒绝审批和内部重试语义，没有读取流式token、终端输出或模型回复正文。
- `petdex/slots.rs` 是生产模块，`PetdexArbiter::target` 每次在动作快照锁内投影。1/2/3归属分别展示，4及以上为两个优先归属和固定第三槽摘要；失败、审批、回答、完成、运行、连接中按序选择，同级保留现有对象，稳定登记次序补空位，尽量保留原槽。
- `petdex/message_snapshot.rs` 提供同一时刻的 `MessageSnapshot { action, slots }`；槽数组下标0/1/2对应外部slot-1/2/3。`message_snapshot(now, service_generation, locale)` 复制内部快照，`message_snapshot_is_current` 检查服务代际、取消令牌、槽下标、binding_generation和revision，并在校验前剔除过期结果。传输消费者必须在发送前和回执处理时校验，I/O在锁外执行。

### 阶段8可直接使用的字段

`Slot` 包含binding、binding_generation、revision和可空content；`Content` 包含locale、内部members/runs、phase、kind、owner_count、active_run_count、busy、expires_at。`MessageLocale` 支持EnUs/ZhCn，由后续应用语言接线传入；语言变化会更新当前投影版本。

- `owner_count` 是本槽代表的归属数量，纯完成/失败归属仍计入；单对象为1，摘要只计算剩余归属。四个终态归属时摘要owner_count=2。
- `active_run_count` 是仍在连接、运行或等待的真实运行数，SFTP按批次；完成/失败/Connected均为0。混合摘要可以owner_count=2且active_run_count=0/1/2或更多，不得把两者混用。
- `runs` 只用于内部代际判断；相同会话连续两轮即使文字、phase、计数相同，也会递增revision，使上一轮快照失效，binding_generation和外部键保持不变。普通同阶段重复事件不改变内容版本。
- 同owner同优先级使用最小run_id稳定选取kind，输入反序不改变代表活动或revision；HashMap遍历顺序不影响结果。等待保持busy=true。没有活动/有效结果时content=None，不产生未用空闲槽。

阶段8不能序列化整个快照，只能从有限字段生成受限正文；阶段6确定的规范化、敏感字段整体回退和紧凑JSON要求仍适用。

### 固定键、单写入者和恢复记录

`petdex/installation.rs` 在实际应用启动 `lib.rs` 的唯一受管PetdexAdapter中初始化。用户数据目录分别沿用正式/开发的 `.shellspan` / `.shellspan-dev`；`petdex-messages.json` 仅含随机UUIDv4安装标识和三个 `{ used, possibly_busy }` 标记。固定键为 `shellspan-<32位随机安装标识>-slot-1/2/3`，49字节ASCII，不包含会话、连接、运行或凭据摘要。重绑、重启不换键。

`File::try_lock` 使用Rust标准库OS排他锁，独立 `petdex-messages.lock` 文件的句柄由adapter持有；JSON通过tempfile原子替换，不锁会被替换的JSON inode。文件同步，Unix额外同步目录。无锁或记录无效的实例保留None并输出一次有限告警，不生成另一组键。多窗口共用受管adapter；另一个进程不能取得同目录写入权。

`Installation::usage/key/mark_attempt/mark_settled` 是后续发送器的持久化接口：发送前保守登记已用/可能忙碌，非忙碌尝试不提前清除旧忙碌标记，确认当前版本结算后才清除。恢复只使用这三个键及标记，不持久化映射、正文或历史。阶段7没有消息发送，生产启动不会调用mark_attempt，未用槽仍未用。阶段9必须仅在持有Installation时写入，结合当前快照校验调用这些接口；本阶段不实现网络结算或清除Petdex显示。

### 验证结果

| 命令 | 结果 | 覆盖 |
| --- | --- | --- |
| `cargo test --manifest-path src-tauri/Cargo.toml petdex --lib` | 退出0，58 passed、4 ignored | 既有动作/传输保护及新增三槽、反序稳定、摘要计数、目标连接、连续回合、审批恢复、旧版本、分类、到期和32线程取消 |
| `cargo test --manifest-path src-tauri/Cargo.toml sftp_pool --lib` | 退出0，22 passed | 连接池、取消及连接重建既有行为 |
| `cargo check --manifest-path src-tauri/Cargo.toml --lib` | 退出0 | 非cfg(test)生产模块构建 |
| `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` | 退出0 | Rust格式 |
| `pnpm check:rust:includes` | 退出0，47 include文件通过 | 包括commands就近回归 |
| `pnpm build` | 退出0 | TypeScript/Vite；保留既有chunk/动态导入警告 |
| `git diff --check` | 退出0 | 变更格式与范围 |

测试文件为 `petdex/slot_tests.rs`、`petdex/agent_activity_tests.rs`、`tests/commands.rs`。安装记录测试使用真实临时目录、真实文件锁和独立子进程，验证拒绝第二写入者、重开同键、已用/可能忙碌恢复及最小JSON字段。没有新增HTTP替代服务、虚假模型响应或测试专用生产行为。既有4个ignored实机测试没有执行，不能计为通过。日志位于 `/tmp/petdex-stage7-{tests,pool-tests,check,build}.log`。

### 明确边界

本阶段未访问真实Petdex、读取token或开启 `/bubble`；没有新增设置、翻译、配置IPC或修改UI/CSP，也未修改部署。没有进行新的SSH/SFTP远端传输或模型请求，生产生命周期验证来自真实store/guard/arbiter路径的直接回归，不称为远端全链验收。

系统锁和重启恢复在当前macOS环境实测，Windows/Linux及断电故障没有独立现场验证；没有承诺断电后已接受的忙碌一定结算。旧回执验证是生产版本接口回归，真实HTTP消息回执由既定阶段9接线。模板与有限详情属于阶段8，网络合并/重试/结算属于阶段9，配置UI属于阶段10，真实全链属于阶段11；阶段7所需的模型和接线均已实现，不以这些后续范围替代本阶段验收。

阶段7交付待协调会话审阅；未创建后续会话、commit、tag或push。

## 阶段8实现与交接验收

日期：2026-09-30，Asia/Shanghai。保留阶段7全部未提交实现及以上阶段6/7证据；本节只记录阶段8内容模型，不构成新的桌宠显示或真实模型请求验收。

### 文件与权威输入

- `src/locales/petdex-messages.json` 是唯一有限双语模板源。Rust `petdex/message_content.rs` 用 `include_str!` 嵌入，两个前端 locale 直接导入同一资源；键集合和字节约束均有测试。连接、上传、下载、同端/跨端复制、AI准备/回复、具体工具类别、审批/回答、成功/失败/取消、摘要、中性结算及测试有独立模板。计数封顶99+，摘要分别使用owner_count和active_run_count，不拼隐藏归属标题。
- `ActivityKind::Tool(ToolStage)` 依据当前turn/step已提交的 `ToolExecution` 与对应 `ToolCall.name` 映射有限类别；已出现同turn/step/call的ToolResult即结束该工具阶段。21种原生工具及skill有明确类别，未知名称只回固定工具模板。仅读取生命周期元数据，未读取工具参数、结果正文、终端日志或流式token。
- `agent_runtime/petdex.rs` 在既有store observer接入允许标题和最终回复。标题只取 `SessionRenamed.title`：`AgentSessionStore::set_generated_title` 与手动rename都提交这一事件。未生成/未改名时保持ShellSpan，不把goal、用户问题或 `RecordedToolCall.title` 作为标题回退；选择会话标题作为稳定对象标题。
- 最终预览要求最新TurnStart归当前guard回合、该回合最新TurnEnd为completed、最近AssistantMessage为Stop且非interrupted、没有ToolCall内容块，且其后没有新step/request/tool/chunk。只连接Text块，排除Reasoning；取消、失败、未完成、截断、中间回复及旧回合均回模板。候选构建先检查完整总长度上限，未额外调用模型。
- `commands.rs` 从既有SFTP权威请求的source_path、source_paths、local_paths、remote_paths提取文件基本名；批次只有一个路径才使用。完整有界路径先检测，再取基本名，不发送目录。跨端复制继续归目标连接；不改变worker、取消和传输行为。

### 安全内容边界

`SafeDetails`、`SafeMessage`、内部Owner/Content/Snapshot不提供Debug或整体Serialize。候选最多32KiB，超过上限直接回退，绝不先截断再检测。复用redaction检查原候选、Markdown可见文字、规范化后文字和最终裁剪结果；任何替换、已有REDACTED标记、私钥结构或敏感JSON字段导致整字段回固定模板。业务记录保持原样，候选不写日志、诊断或持久化。

依赖版本已由Cargo环境核验并锁定：pulldown-cmark 0.13.4（最低Rust 1.71.1）、linkify 0.11.0，当前rustc 1.95.0编译通过。CommonMark事件遍历剔除代码块、行内代码、图片、HTML块和自动链接，普通链接只保留可见标签；linkify进一步排除裸URL、邮箱和地址形式标签。内联HTML保守整字段回退，避免自行解析脚本/样式可见性。内联强调不插空格，防止拆开的敏感词逃过提取后的检测。

换行、Tab及控制字符归为空格，移除方向控制，ASCII双引号换弯引号，反斜杠换全角字符，收敛空白。UTF-8边界裁剪并预留省略号，title≤96字节、text≤200字节，空结果回退。`SafeMessage::encode(Installation::key)` 再校验并通过紧凑serde_json输出，字段仅conversation_key/agent_source/title/text/busy；规范化后的字符串没有需要JSON转义的字符，不依赖Petdex原始切片反转义或远端截断。

### 偏好与阶段9消费规则

- Rust `MessagePreferences` 和前端 `src/lib/petdex/message-preferences.ts` 建立 `petdexMessagesEnabled=false`、`petdexMessageDetailsEnabled=false` 模型。没有接入设置持久化/IPC，没有默认开启消息；完整迁移属于阶段10。
- `ActivityGuard::details` 只在总开关、消息开关、详情开关与当前分类都允许时执行闭包。默认模式连候选提取都不执行；guard本身不持有详情。安全详情仅留在同run活动/有效结果中，关闭详情/消息或分类、停止coordinator均清除对应详情。重新开启不会恢复已经清除的旧候选。
- `PetdexAdapter::set_message_preferences` 在同一仲裁锁中清理详情、重新投影并递增所有槽revision，取消旧消息专用CancellationToken；快速关闭再开启也不会复活旧快照，不干扰动作coordinator的取消令牌。详情变化本身参与Content相等比较并递增revision；同owner新run继续沿用阶段7的runs版本保护。
- 阶段9应调用 `message_snapshot(now, service_generation, MessageLocale::from_app_locale(resolved_app_locale))`，必须使用ShellSpan当前解析后的语言，不另取OS语言。语言变化更新当前投影revision，不改变binding_generation。应用语言IPC接线随阶段10配置迁移完成。
- `snapshot.message(slot)` 是默认禁用门禁后的安全正文入口；禁用或令牌取消时返回None。`SafeMessage::settled(locale)` / `test(locale)` 提供固定中性结算/测试内容，busy=false。阶段9只在已用槽结算或获准测试时消费，不能用它们绕过默认禁用。
- 网络I/O必须在锁外；发送前及处理回执前仍调用 `message_snapshot_is_current`，同时核验服务代际、动作与消息取消令牌、slot、binding_generation、revision及绝对TTL。不要序列化内部snapshot、members、runs；旧snapshot.message因偏好取消已返回None，持有的已编码字节仍须由发送器按版本丢弃。已接受内容不能撤回，网络合并/重试/结算留阶段9。

### 验证结果与边界

| 命令 | 结果 | 覆盖 |
| --- | --- | --- |
| `cargo test --manifest-path src-tauri/Cargo.toml petdex --lib` | 退出0，70 passed、4 ignored | 阶段7既有回归及新内容边界、Markdown/裸地址、UTF-8、默认关闭/撤销、语言/新run版本、摘要、工具阶段、真实store标题/回合生命周期、最终回复选择器 |
| `pnpm test src/lib/petdex/__tests__ src/locales/__tests__/locale-key-set.test.ts` | 退出0，7文件23测试 | 共享资源、双语键集合、偏好默认值和三开关门禁及既有Petdex前端回归 |
| `pnpm build` | 退出0 | TypeScript/Vite，保留既有chunk/静动态导入警告 |
| `cargo check --manifest-path src-tauri/Cargo.toml --lib` | 退出0 | 非cfg(test)生产构建及新增依赖 |
| `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` | 退出0 | Rust格式 |
| `pnpm check:rust:includes` | 退出0，47 include文件 | 包含commands就近回归 |
| `git diff --check` | 退出0 | 差异格式 |

日志位于 `/tmp/petdex-stage8-{tests,frontend-tests,build,check,includes}.log`。最终回复选择器测试直接使用类型化事件输入调用生产选择器；生命周期、自动标题和工具审批/执行测试使用真实store提交/验证，安全正文测试调用生产guard/arbiter/slots/serde路径。没有构造替代HTTP服务、虚假模型响应或伪造replay envelope，没有放宽store校验或加入测试专用生产分支。这些测试不是远端模型请求、真实SSH/SFTP传输或Petdex显示验收；四个既有ignored实机测试未执行。

本阶段没有访问真实Petdex、读取token、开启/bubble、改变显示偏好、UI、CSP或部署。详情安全是有限防护而非任意秘密识别保证；内联HTML、超长候选、缺失标题或无合格最终回复按保守规则回模板。关闭后已接受的内容无法撤回，网络取消与队列丢弃由阶段9接线，设置及当前应用locale到后端的配置接线由阶段10完成，真实全链复验由阶段11完成。本会话未创建后续会话、commit、tag或push，由协调会话审阅并继续阶段9。

## 阶段9实现与交接验收

日期：2026-09-30，Asia/Shanghai。保留阶段7/8全部未提交改动；本阶段没有修改产品UI、CSP、部署或前端设置持久化。

### 生产文件与后端接口

- `petdex.rs` 的既有协调循环同时选择动作和消息；就绪通道交替获得发送机会，避免持续动作变化饿死消息。`message_delivery.rs` 每槽只留最新快照，普通更新300ms合并，失败、等待进入/退出及空槽结算优先。去重比较安全正文、语言、服务代际、绑定代际与当前run集合；同run重复事件不刷新远端排序。详情与语言切换取消旧消息请求、清除待发内容并重投影。
- `transport.rs` 共用固定loopback客户端、请求锁、100ms写入时钟；所有认证POST（包括401重试）之前重新匿名health/whoami检查。只有token确实变化才重试一次，刷新逻辑由动作与消息共用。429在共享写入策略中至少退避1秒；普通失败共用250ms至60秒指数退避，并保留各通道调度退避。请求锁、匿名检查、读取token、磁盘标记和重试都在普通尝试1500ms预算内；连接250ms、单请求750ms、所有响应≤1KiB。
- `/bubble` 只接收 `SafeMessage::encode` 的紧凑五字段正文。成功响应需serde校验 `ok=true` 和正整数counter，空体、HTML、缺字段、非法数字或超限均不确认接受。`/state` 保留已有成功响应契约，不读取 `/bubble` 镜像，不发送业务owner/run或其摘要。
- `PetdexAdapter::configure_messages(MessagePreferences, resolved_app_locale)` 返回 `MessageConfigurationResult { effective, cleanup_outcome }`，其中effective是实际消息偏好；`message_diagnostic()` 返回有限错误、unsupported、接受次数/时间、已用槽数及结算结果。两个消息偏好仍默认false。完整配置command/注册/类型化IPC/store/UI在阶段10迁移；这些后端接口已经承担关闭安全语义，不能由阶段10重新绕过。
- `shutdown_messages()` 返回 `notNeeded/accepted/unconfirmed`。既有 `petdex_set_enabled` 已改为异步并调用它；响应仍兼容当前前端的动作诊断形状。`request_app_exit`、`request_app_restart` 在现有前端确认之后调用有限结算，再执行原有退出操作；未在菜单请求/窗口关闭通知阶段提前关闭业务。Tauri要求含State参数的异步command返回Result，其成功序列化形状保持原状。
- `lib.rs` 把安装记录初始化放到阻塞worker；后续读写同样使用spawn_blocking，磁盘I/O不占Tauri主线程或仲裁快照锁。只有成功取得Installation文件锁的实例调度消息；未取得时保留有限日志而不创建另一套键。

### 关闭、持久化和恢复边界

关闭入口先在仲裁锁内阻止新消息并取消旧代际，再进入结算。一个1500ms绝对deadline从调用入口计时，覆盖配置锁队列、请求锁队列、全部三个已用槽、匿名门禁、token、网络重试及持久化。未用槽不创建；失败或超时返回unconfirmed但关闭仍生效。默认消息关闭时，即使磁盘保留历史busy标记，关闭总开关也不触发修复通信；确认Disabled后不读token、不继续网络请求或后台重试。

配置有单调代际和独立cleanup取消令牌；新配置立即取消上一轮结算，旧调用不能覆盖新配置。消息详情/语言变更取消旧快照。发送前、认证重试前及回执后重新检查取消、版本、服务代际和绝对TTL；队列中的动作到期后不补发。

`installation.rs` 在认证发送之前保守写入used/possibly_busy。每次发送分配单调write epoch，只有当前成功的busy=false回执能以相同epoch执行 `settle_version`。阻塞worker进入文件锁后再次检查取消与快照，旧epoch不能清除更新的busy尝试；超时/任务丢弃使用drop guard取消残留worker资格。记录JSON仍只有随机安装标识、三槽used/possibly_busy，epoch仅在内存中；不会持久化消息正文或身份。磁盘写入本身无法被强制中断，但残留任务不发网络，新一代必须先完成自己的保守标记才发送。

服务代际依据兼容whoami的PID变化。普通同PID探测不重发气泡；已知代际切换及离线恢复先丢弃消息终态，只同步当前活动。即使下一次state直接成功、未先观察到网络失败，也不会重播旧TTL结果；恢复后新产生的结果仍正常展示。这个识别不声称覆盖操作系统PID被复用且中间没有观测的情况。消息404/405/501单独暂停消息重试，动作保持独立；服务代际变化或主动测试解除暂停。HTTP身份仍是兼容门禁，无法消除本地端口切换TOCTOU。

### 验证结果

| 命令 | 结果 | 证据范围 |
| --- | --- | --- |
| `cargo test --manifest-path src-tauri/Cargo.toml petdex --lib` | 退出0，86 passed、5 ignored | 原有70项与新增16项；最新版本/等待优先/去重、详情语言撤销、旧回执、重绑定、恢复、不支持、部分结算策略、两种锁预算、快速重开、迟到磁盘结算、绝对TTL、默认关闭、响应校验、共享限流退避 |
| `SHELLSPAN_PETDEX_MESSAGE_E2E=1 cargo test --manifest-path src-tauri/Cargo.toml installed_petdex_accepts_three_production_slots_and_bounded_close --lib -- --ignored` | 退出0，1 passed | 已安装Petdex的生产发送、响应校验、三个已用槽有限关闭、持久化非忙碌、Disabled健康检查不通信 |
| 上述实机命令加 `HTTP_PROXY/HTTPS_PROXY/ALL_PROXY=http://127.0.0.1:9`、`NO_PROXY=` | 退出0，1 passed，测试耗时1.22s | 显式无效代理环境下仍直接访问固定loopback；同三个测试键再次结算 |
| `pnpm test src/lib/petdex/__tests__ src/locales/__tests__/locale-key-set.test.ts` | 退出0，7文件23测试 | 前端现有协议/偏好/资源与双语键集合 |
| `pnpm build` | 退出0 | TypeScript/Vite；既有chunk和静动态导入警告仍在 |
| `cargo check --manifest-path src-tauri/Cargo.toml --lib` | 退出0 | 非测试生产构建 |
| `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` | 退出0 | Rust格式 |
| `pnpm check:rust:includes` | 退出0，47 include文件 | 包含commands就近回归 |
| `git diff --check` | 退出0 | 差异格式 |

新增测试位于 `petdex/message_delivery/tests.rs`、`transport.rs::protocol_tests`，直接调用生产调度/锁/取消/持久化/响应策略；没有新增HTTP替代服务或虚假模型服务。原有动作401/token轮换等fixture测试继续运行，不把它们当真实Petdex证据。部分失败与重启/乱序通过生产策略回归验证，本轮未诱发真实Petdex401/429、重启、故障或重定向；禁重定向沿用reqwest Policy::none，响应安全依靠有界读取与生产解码测试。日志为 `/tmp/petdex-stage9-{tests,live,live-proxy,frontend-tests,build,check,includes}.log`。

### 本机真实生产接口与恢复情况

重新读取Info.plist版本0.8.0、核对进程PID72831及路径 `/Applications/Petdex.app/Contents/MacOS/petdex-desktop-native`，二进制SHA-256仍为 `878448e0e0a742608df3d9f7048796e7b362166a5a648d5c676c089dc0fa7522`。Python PID712仍在 `*:7777`，Petdex在 `127.0.0.1:7777`；匿名health/whoami返回Petdex契约与PID72831，实机测试在读取token前再次检查PID对应官方路径。未停止Python或Petdex，未将凭证发送给Python，未输出凭证及其摘要。

使用固定目录 `/tmp/shellspan-petdex-stage9-live` 的单一测试安装记录，所有运行复用同三个安装槽；通过真实ActivityGuard、快照、SafeMessage和适配器发送固定“正在上传文件”模板，不含业务文本。测试没有启动协调器自动动作发送，未改变全局state/idle或其他客户端消息。三个请求均通过成功响应校验；关闭偏好调用生产configure_messages并收到accepted，三个持久化槽均used=true、possibly_busy=false。最终总开关和消息偏好关闭；测试实例没有改动应用持久化偏好、Petdex显示开关、专注、寿命或按会话模式，因此无需切换用户偏好来恢复。

这里的accepted仅确认请求接受和本安装忙碌结算，不是气泡删除、可见性或业务端到端证明。未采集新的UI截图，没有新远端SSH/SFTP或模型请求；阶段6已有显示证据保持原有范围，阶段11执行真实业务全链。正常退出接线经过编译和后端有限结算回归，未为了验收实际退出用户应用。保留测试安装记录供同键复验；本阶段未创建下一会话、commit、tag或push，由协调会话审阅后推进阶段10。

## 阶段10实现与交接验收

日期：2026-09-30，Asia/Shanghai。保留阶段7–9全部未提交改动，仅扩展现有Petdex设置区；没有调整部署、AI权限或其他界面。使用项目shadcn技能及既有IntegrationGroup、Card、Field、Switch、Button、Sonner组件。

### 配置与持久化契约

- `petdex/configuration.rs` 提供 `petdex_configure`、`petdex_message_diagnostic`、`petdex_test_message`，均在 `lib.rs` 注册并经过 `src/lib/ipc/tauri.ts` 类型化适配。配置返回 `effective`（enabled、categories、两消息偏好、locale）、动作diagnostic、独立messageDiagnostic及 `cleanupOutcome=notNeeded/accepted/unconfirmed`。总开关关闭也返回并显示结算结果；网络结算未确认不是配置RPC错误，不会回滚开启。
- 新配置作为SQLite preferences表单条 `petdexConfiguration` JSON原子保存；数据库写入先于运行时应用，失败只返回有限 `petdex-preferences-save-failed`。前端通用500ms偏好保存不再写Petdex旧字段，避免覆盖新配置。迁移读取新记录，缺失时读取原有总开关/分类，并将缺失或非布尔消息偏好归false；旧用户不自动开启。旧字段保留用于兼容读取，不主动删除数据。
- 前端保留稀疏patch队列，每次合并最后后台确认配置，成功以实际effective更新backend状态，最后用户请求才提交显示值；失败保留最后确认值。启动迁移也使用后台effective；locale与其他配置进入同一队列，跟随应用已有zh-CN/en-US。语言同步失败不回滚应用语言，保留有限同步失败诊断，下次配置操作重试。
- 后端 `configuration_command_lock` 将同一adapter的配置保存与应用串行化；排队与消息结算沿用从命令入口计算的一个1500ms deadline，不给各槽重开预算。数据库写入在阻塞worker完成后才应用状态；底层同步磁盘调用不能强制中断，持久化返回较晚时剩余网络结算预算为零，不补发或重开预算。没有宣称操作系统磁盘阻塞可被绝对强杀。
- 独立消息诊断在coordinator/messages锁下采样并递增单调revision，前端拒绝小于等于当前revision的迟到快照。仅输出有限status/errorReason、acceptedCount/lastAcceptedAt、0–3槽数、unsupported和cleanupOutcome，不输出正文、外部键、owner/run或凭证。两秒本地诊断读取不发Petdex请求；无后台Toast。

### 测试与设置行为

固定文字按钮调用真实后端 `SafeMessage::test` / `/bubble` 路径，复用三个安装槽之一。选择不处于失败或等待的槽，三槽均受保护时返回overridden；测试期间预留该槽，普通协调器不选它。发送/回执继续验证快照和代际；一次尝试含排队共1500ms，超时取消且释放预留。结束清除测试指纹并唤醒协调器，以最新业务投影恢复；空槽使用固定中性结算，未分配第四个键。消息unsupported主动测试可重新探测，动作状态保持独立。

消息与详情开关在总开关关闭时仍可保存，通信和测试仍被总/消息门禁限制。详情风险说明明确标题、文件名和已完成回复可能包含业务信息，脱敏并非绝对保密，已接受内容不能撤回；另说明Petdex显示/专注/单气泡/寿命影响可见性。主动保存或测试各有一次Toast，初始化、订阅、后台诊断保持静默。消息诊断持续显示在本卡片，原有SSH/SFTP/AI分类、动作测试、动作诊断和布局保留。

### 验证结果

| 检查 | 结果与范围 |
| --- | --- |
| `cargo test --manifest-path src-tauri/Cargo.toml petdex --lib` | 91 passed、5 ignored；新增真实SQLite只读失败/原子记录、消息门禁/三等待槽保护、测试排队超时取消、诊断有限字段/单调revision、共享关闭deadline |
| Petdex领域、appStore、locale键、两类诊断组件前端测试 | 11文件51 passed；新默认值/稀疏合并/拒旧/严格解码、双语与StrictMode静默、键盘焦点、按钮CardAction和禁用门禁 |
| `settings-panel.test.tsx` | 27 passed；维护既有配置fixture新契约，确认挂载无保存Toast，保留既有操作/布局回归 |
| `pnpm build` 及一次原生debug app构建 | 均退出0；原生命令使用tauri.dev.conf.json、禁updater artifacts及本地签名，保留既有chunk/动态导入和未公证提示 |
| Rust fmt / `pnpm check:rust:includes` | 退出0，47 include文件；未修改CSP |
| Ajv standalone生成及 `--check`、禁止字符串代码生成测试 | 通过；schema/声明/生成产物包含配置与消息诊断/测试，不运行时compile或new Function |
| `git diff --check` | 通过 |

日志位于 `/tmp/petdex-stage10-{tests,frontend-tests,settings-tests,build,native-build,check,includes}.log`。新增测试使用生产解析、状态、取消和真实SQLite；既有前端fixture仅作回归，不能作为实机证据。未新增HTTP替代服务、虚假模型或绕过权限的测试行为。

### 原生现场与恢复

CUA确认开发应用原先未运行，启动本次构建的 `src-tauri/target/debug/bundle/macos/ShellSpan.app`（com.shellspan-dev）。首次启动读取超时后成功取得原生WebView，未出现需要代操作的钥匙串提示。原生截图和AX结果保留在本阶段会话工具记录中。

1. 旧偏好为总开关true、SSH/SFTP/AI分类均true、locale=zh-CN、restoreWorkspace=false，两消息字段不存在。首次打开实验集成页，两消息开关均off、测试按钮禁用、消息诊断关闭；未自动开启消息。
2. 关闭总开关后以鼠标/Tab/空格保存两消息偏好，SQLite只读查询确认enabled=false且两消息偏好true；原生测试按钮仍禁用、诊断关闭。恢复详情false再开启总开关，点击固定测试文字，15:40:02原生Toast为“Petdex 已接受测试文字请求”，独立诊断更新时间和已用槽数。没有把接受结果称为桌宠实际显示。
3. 分别关闭消息、重开消息后关闭总开关，原生诊断均出现“结算请求已接受，不代表气泡已删除”。快速详情开/关后最终值为false，后台读取没有额外保存Toast。
4. 中英文原生界面均检查风险说明、按钮文案、卡片操作位置与自动换行。检查约1462×920和配置允许的最小1200×760逻辑窗口；正文滚动、右侧滚动条可见，固定设置Header保留，Tab能将焦点和对应控件滚入视野，原有动作诊断仍可展开。没有用浏览器截图替代原生检查。
5. 真正发送前重新匿名health/whoami并核对PID72831属于 `/Applications/Petdex.app/Contents/MacOS/petdex-desktop-native`、版本0.8.0；Python PID712保持原状，未停止任何未知服务或输出token。Petdex显示偏好未改动。
6. 最终恢复locale=zh-CN、总开关true、原三分类true、两消息偏好false、restoreWorkspace=false。SQLite新记录确认上述值；安装记录仅检查槽标志，两个已用槽均possibly_busy=false，第三槽未用。通过原生菜单与既有确认弹框正常退出，进程检查确认测试应用已退出；未修改AI权限。

现场没有诱发真实Petdex401/429/unsupported或网络结算失败，也未执行新SSH/SFTP或模型全链；未确认结算仍关闭、等待保护、超时不补发、迟到快照拒绝来自生产回归。正常退出现场是在消息已经关闭时执行，不替代阶段11的活动中退出验收。桌宠独立气泡可见性沿用阶段6证据，阶段10只确认原生设置与真实请求接受，阶段11继续真实业务全链。未创建下一会话、commit、tag或push，交由协调会话审阅。

## 阶段11检查与待续审计

日期：2026-09-30，Asia/Shanghai。**阶段11仍有外部依赖项，以下不是全部通过验收。** 保留阶段7–10全部未提交实现；阶段11只增强既有ignored实机测试，未修改生产业务代码或UI。未创建额外Codex桌面聊天、commit、tag、push，没有新增HTTP或模型替代服务。ShellSpan内明确命名的真实AI测试会话及获准的一次ephemeral Codex CLI共存请求另记下文。

### 已完成的检查

| 命令 | 本轮结果 | 日志 |
| --- | --- | --- |
| `pnpm review:frontend`（包含完整 `pnpm test` 与 `pnpm build`） | 退出0；289文件通过、1文件跳过，2527测试通过、2跳过；TypeScript/Vite通过，保留构建警告 | `/tmp/petdex-stage11-frontend.log` |
| `cargo test --manifest-path src-tauri/Cargo.toml` | 退出0；1159通过、54忽略；独立协议测试5通过；main/doc通过 | `/tmp/petdex-stage11-rust-full.log` |
| `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` | 退出0 | `/tmp/petdex-stage11-fmt.log` |
| `pnpm check:rust:includes` | 退出0，47文件 | `/tmp/petdex-stage11-includes.log` |
| `pnpm check:ai-styles` | 退出0 | `/tmp/petdex-stage11-ai-styles.log` |
| `pnpm check:llm:catalog` | 退出0，55模型，4负例拒绝 | `/tmp/petdex-stage11-catalog.log` |
| `node scripts/generate-petdex-validators.mjs --check`、`git diff --check` | 退出0 | 本会话工具记录 |

没有重复执行与 `review:frontend` 等价的测试/构建。复用阶段10原生debug bundle，无生产代码变化，未重新打包；Cargo全量测试期间没有并行原生构建。忽略和跳过项不计通过；既有fixture回归不计真实业务或屏幕证据。

### 本轮现场证据与阻碍

1. 匿名health/whoami返回合法契约、PID72831；`ps`核对官方路径 `/Applications/Petdex.app/Contents/MacOS/petdex-desktop-native`。Python712仍监听 `*:7777`，未停止或修改。没有读取他人气泡镜像正文、输出token或摘要，也没有发独立认证探针。
2. 只读Petdex设置确认 `bubbles=true`、`bubbles_per_conversation=true`、`bubble_lifetime=0`、文字8/列40/回答2行。本轮未改变这些值；Focus Off尚未重新取得现场证据，不沿用旧值当作本轮验证。设置Agents页显示Hooks not installed，不能假设其他真实客户端当前活跃。
3. CUA启动既有开发bundle，原生设置确认总开关及SSH/SFTP/AI均on，两消息偏好off，恢复工作区off；后续按授权临时开启消息和详情。新建终端AI面板实际呈现完全访问，在发起任何模型请求前改为请求批准；没有扩大权限。
4. 首次SSH点击后原生读取超时且SecurityAgent存在，未取得用户现场确认。15:53:22后端确认已读取钥匙串，但当时隔离容器已清理，连接返回Connection refused。不能把过去超时当作持续阻碍；恢复原生访问、结算退出之后，重新启动应用和专用容器继续联调。
5. 第二次独立容器只绑定127.0.0.1:22222，ED25519指纹 `SHA256:RM4fuRK9w7/lVnj4AZTr4dV7t+yvbefj+q8obY1XMd4` 与原生主机密钥确认一致。15:59:20真实SSH成功，原生终端执行 `uname -s` 返回Linux。既有连接名称仍为 `Petdex Stage 5 Local`，没有连接用户生产主机。
6. 16:04:37–16:04:58真实SFTP上传现有开发构建文件，16:13:02–16:13:18下载到独立临时目录；两次均133,378,240字节，原生进度、后端completed及原件/远端/下载件三方SHA-256一致：`4520f6cff3f8c6ec5ebd88c54796cb27097ad599f7280c9acaa55682bcb31095`。容器CPU临时0.1用于观察窗口，没有伪造进度或传输服务。
7. 现有MiniMax-M3真实模型创建四个明确命名的阶段11会话：联调询问、系统核验、颜色联调询问、联调完成确认。原生历史列表记录三个等待回答、一个进行中；系统核验先请求uname审批，发生真实审批过期，第二回合批准后因其他会话占用终端而返回TERMINAL_LEASE_BUSY。没有绕过权限或把工具失败改成成功。首个会话随后回答问题、批准uname一次并真实返回Linux，第二回合完成简短Markdown回复“检查完成，系统为Linux”。未新增模型服务或注入回复。
8. 消息诊断为3/3已用槽并有新接受时间；三槽持久化忙碌标志均曾为true。关闭AI分类后三槽均false，再恢复分类；活动等待期间分别关闭消息/总开关，原生显示结算请求已接受、持久化三槽非忙碌，重开继续同步活动。详情先开再关，随后为真实最终回复另行开启。这里证明真实业务触发、请求接受和标志，不证明三卡文字/摘要/重绑实际显示。
9. 观察到Petdex从72831变为35392（非本轮主动重启），重新匿名核对官方路径。随后16:13受控正常退出35392，仅剩Python712、匿名whoami404；生产诊断变为请求被拒绝。16:15:33重新启动官方Petdex41014，保持ShellSpan开关不变，16:15:53原生诊断自动恢复已连接、消息接受时间更新。没有输出token或摘要，未独立比较令牌轮换，也没有观察全部恢复气泡文字，不能独立证明没有旧结果补播。
10. 最新实际显示：用户提供[三槽等待原生截图](assets/petdex-stage11-three-waiting.png)，三张ShellSpan卡片均为“正在等待回答”且有旋转标记。此后关闭Petdex设置窗口，CUA可选中独立气泡窗口并取得AX及截图；不再认为本轮工具完全无法捕获气泡。没有借助其他截图技术或读取他人镜像正文。
11. 16:17再次正常停止Petdex，在真实AI等待仍存在时关闭总开关。原生开关off、诊断已关闭且显示“结算未确认；关闭仍已生效，不会后台重试”；这是实际失败仍关闭证据，不是fixture。随后恢复官方Petdex42061，匿名whoami及路径匹配，ShellSpan仍保持off。16:17:29至16:18:12后端日志大小/修改时间完全不变，没有新的请求日志；这是43秒有限日志观察，不是抓包证明或无限时保证。1500ms预算及所有槽共用deadline仍由生产回归证明，工具调用耗时不作为精确网络计时。之后恢复总开关继续业务。
12. 为跨连接复制创建 `Petdex Stage 11 Target`（复用本机测试连接副本、127.0.0.1:22223），未显示或输出密码。锁屏中断后用户明确解锁，取消失效提示并重建容器；源ED25519 `SHA256:GHgQe/atLHIkjVP1DGqNJB85rfBbUrccudiikIsIBLM`、目标 `SHA256:6LViX7N4iAAIzibBw1loApqYIi0jMKIjy/JJudpFlqk` 均与原生确认一致。双端SFTP界面分别显示源和目标连接，执行复制/粘贴；16:37:39后端remote_copy完成，133,378,240字节，目标 `/home/shellspan/ShellSpan` 的SHA-256与上列原件相同。未捕获复制短窗口的气泡文字，目标归属的映射另由既有生产回归证明。
13. 16:40复用已完成系统核验历史，在新终端按产品规则创建一次续接会话“气泡摘要验收确认”，真实模型调用ask_user_question并等待。CUA气泡AX保留两个等待条目，第三条变为“另有 2 个会话或连接，2 项任务进行中”，实际截图显示该摘要与旋转标记；这是四个活动归属的直接显示证据。该问题随后在原生被回答，16:41模型完成，第三槽回到“正在等待回答”。没有由工具注入事件或伪造模型终态。原生续接是新的内部会话，不将它冒充同会话续回合；此前16:11的原会话第二回合证据独立有效。
14. “Petdex阶段11联调完成确认”随后也收到原生回答，16:42模型完成；实际气泡变为“ShellSpan 活动已结束”，另两条等待AX仍在。16:43消息/详情仍true且存在真实等待时，通过正常菜单及确认弹框退出应用。16:43:35进程检查确认已退出，三槽possibly_busy=false；CUA气泡AX三条均为“ShellSpan 活动已结束”，实际截图保留卡片及橙色感叹号。证明正常退出结算而非删除，不能把卡片残留称为失败。
15. 16:55在真实本地终端新建短任务“Petdex详情显示验收询问”，沿用MiniMax-M3和请求批准，只调用ask_user_question，不读取文件或执行命令。详情开启时原生气泡显示该权威生成标题＋“正在等待回答”；关闭详情后同槽标题立即回“ShellSpan”、正文仍等待。应用切English后三个AX正文为“Waiting for an answer”，截图可见“Waiting for an ans…”（受气泡宽度省略）；随后恢复zh-CN。此为业务标题撤销和双语实际显示，不以配置保存代替。
16. 本地问题在原生收到回答并完成；随后同会话两个短总结回合真实生成Markdown回复。首次采样选到桌宠主窗口，未算预览通过；重新选择独立气泡窗口后，17:01连续原生采样捕获权威已完成回复“显示验证完成：中文标题、英文状态及关闭详情回模板均已验证通过。”，标题仍为该会话名称，截图正文没有Markdown加粗符号。未延长业务TTL、伪造回复或修改模型服务；这是有限预览成功样本，不证明任意内容绝对保密。
17. 17:05:56开始向源测试端上传原构建，暂时关闭AI分类以隔离活动；截图显示一条“正在上传文件”忙碌卡片及两个已结算旧槽。17:07:15向目标测试端上传同一真实构建的本地副本 `stage11-reviewed-build`，截图/AX显示两个独立上传卡片，第二条标题为基本名、没有本地路径；第三条仍为已结算残留，不算第三活动。这分别证明1和2归属显示，不承诺已用空槽自动删除。两端CPU仅为保留真实观察窗口暂调0.03，随后恢复1；17:08:02/03两上传完成，远端SHA-256均与原件一致。首次0.01配额造成一次真实握手超时，恢复正常配额后重新核对指纹再连接，不绕过主机验证。
18. 17:07:46点击生产固定测试按钮，Toast为请求已接受；原生气泡AX确为“来自 ShellSpan 的测试消息”，截图可见“来自 ShellSpan 的测试消…”，另一槽仍显示真实文件上传。随后两个上传结束，原生气泡三槽均恢复“ShellSpan 活动已结束”，没有遗留测试正文。17:09恢复AI分类再次测试后，AX保留原有两条等待及一条中性结算；该次未抓到测试正文短窗口，不能和17:07截图混同。固定预览可见性已有实际样本，因此未改预览时长；本轮没有声称所有调度条件下都能保证肉眼看见短预览。

本节截图及AX均在当前会话工具记录，三等待用户原图另存仓库；没有编辑截图、读取气泡HTTP镜像或把接受结果改写成显示。锁屏已解除，工具当前可抓取独立窗口；早期“没有”的用户观察仅对应当时窗口，后续实际截图明确覆盖了最新状态。

### 实机预算、部分结算与重启补验

本次续验开始重新检查：官方Petdex已退出，只有Python712监听7777、匿名health/whoami404。没有向未知服务发送认证。为本轮测试启动官方0.8.0（先PID84850），每次认证实机测试前核对匿名契约及官方可执行路径。仍复用 `/tmp/shellspan-petdex-stage9-live` 的既有三个键，没有新增安装、替代服务或流量压测。

增强 `petdex/message_delivery/tests.rs` 的同一个显式实机测试，直接调用生产adapter/configuration锁/关闭入口及真实HTTP：先真实发送三个槽，再持有配置锁消耗整个预算；下一轮持锁1325ms，仅留不足200ms给三槽结算。共享100ms写入间隔使第三槽不能在余量内完成。最后先重新开启并正常结算全部己方槽，再断言，防止计时断言失败留下忙碌测试。

| 观测 | 实际结果 | 边界 |
| --- | --- | --- |
| 配置锁占满关闭预算 | 墙钟1502ms，unconfirmed，消息false | 名义deadline1500ms，2ms调度偏差；不承诺操作系统零误差或强杀磁盘调用 |
| 部分结算 | 墙钟1500ms，2槽已结算、1槽未完成，unconfirmed，消息false | 真实Petdex与生产关闭路径；不是429压测、mock回执或三个独立1500ms预算 |
| 关闭门禁 | 无待发message；总关闭后即使持有request_lock，check_health在100ms内直接Disabled | 证明该生产入口不进入网络请求锁；不等于所有系统网络的抓包证明 |
| 测试收尾 | finalCleanupOutcome=accepted，固定实机三槽possibly_busy=false | 仅己方已用槽，不表示气泡删除 |

结果文件 `/tmp/petdex-stage11-live-budget.json` 只含时间、有限结果和槽计数，无正文、身份、外部键或凭证。命令 `SHELLSPAN_PETDEX_MESSAGE_E2E=1 cargo test --manifest-path src-tauri/Cargo.toml petdex::message_delivery::tests::installed_petdex_accepts_three_production_slots_and_bounded_close --lib -- --ignored --exact`：1 passed，3.93s；日志 `/tmp/petdex-stage11-live-budget.log`。相关 `cargo test --manifest-path src-tauri/Cargo.toml petdex --lib`：91 passed、5 ignored，日志 `/tmp/petdex-stage11-budget-related.log`。fmt、47个includes、diff检查通过。只改cfg(test)实机测试，未无故重建原生包或重跑未受影响的全量前端测试。

令牌轮换通过 `/tmp/petdex-stage11-rotation.mjs` 的只读内存比较：原生正常退出/重新启动官方Petdex，重启前后匿名契约及进程路径均复核。输出仅 `officialIdentityVerified=true, processChanged=true, tokenRotated=true`；未输出令牌、摘要或哈希，未写磁盘凭证副本，结束清零内存Buffer。停服期间匿名whoami404，仅Python继续运行。脚本没有认证POST。

不补旧结果补验使用真实业务：确认loopback22222没有监听后，Petdex停服期间仅点击指定测试连接；17:25:21真实Connection refused，约1462ms内重新打开官方Petdex89999，17:25:22生产通信恢复。随后原生气泡AX为两条当前等待及一条中性结算，未观察到旧失败补播。最初100ms轮询窗口没有连续截图，故与现有“成功探测新代际仍丢弃旧终态”的生产回归组合说明，不声称全过程抓包或逐帧证明。

无通信证据仍有明确边界：本机 `/dev/bpf*` 为root0600，未提权/绕过；非提权nettop短采样仅有表头，没有可靠的正对照，未将它计为零通信证明。Disabled生产门禁、请求锁测试和前述43秒无新请求日志有效；若要求网络级连续抓包，需要用户提供授权环境或由用户采集，仅凭现权限不能补出该层证据。

### 范围偏差记录

17:03附近曾误点同名“打开SFTP”按钮，打开一个非测试已保存连接，立即通过原生关闭页签。只读日志核对确认**实际发起并成功建立SFTP连接、请求过目录列表**，没有本轮上传/下载/复制请求；未进行文件修改，不把“无文件操作”夸大为完全无访问。该连接不计验收，不在文档暴露其地址或凭证。后续改为匹配明确测试连接名称和loopback端口后定位对应按钮。

### 资源与偏好恢复

17:55:35最新核对：开发应用正常退出；本次共存期间由外部启动的Petdex98256保留运行，外部新安装Codex钩子保留，Python712未动。此前专用Compose容器网络已down，本次没有重建；未清理其他线程容器。两份真实构建、预算JSON、无凭证轮换脚本及日志、临时Codex通知适配器与有限结果保留审计。颜色记录已获准删除，其余五条测试历史及测试连接保留。ShellSpan仍只有原三个固定键；真实Codex事件使用自己的真实会话键，不是ShellSpan第四槽或新测试安装。没有全局清屏或全局idle。

最终SQLite只读核对与原偏好一致：locale=zh-CN、总开关true、SSH/SFTP/AI=true、消息false、详情false、restoreWorkspace=false。权限保持请求批准。本开发安装与既有stage9实机安装各三个槽均used=true、possibly_busy=false。Petdex Show messages/per-conversation均true、寿命0，本轮未修改；Focus菜单值仍未独立读取，实际可见已有截图。

**颜色测试待办已处理：**用户明确授权删除后，通过全局设置→AI助手→管理会话记录精确筛选唯一“Petdex阶段11颜色联调询问”（创建时间16:06:07、测试终端），确认框明确先停止任务再永久删除该条记录。执行正常产品cancel→archive→delete，Toast确认删除成功；刷新同标题精确搜索后仍为“没有符合条件的会话记录”。其他记录未操作，没有使用全局归档/删除全部，没有直接改DB或扩改AI UI。原先历史只读视图确实无独立停止入口，但全局授权删除已经解决该待办；其余五条本轮测试历史已观察为空闲/完成。

### Codex 共存专项（用户现场确认）

用户指定Codex后，只读核对CLI0.155.1、Desktop/IDE运行环境及常见配置层。最初用户hooks的五个事件数组均为空，notify为Computer Use客户端，仓库无本地hooks/config，未发现现成Petdex工具。随后17:42:41用户级hooks由外部加入Petdex条目，Petdex界面显示“Installed - restart Codex and approve its hooks once”；该变化不是本任务写入，保留最新状态，不代批准或绕过信任。官方Petdex98256也在本轮检查期间由外部启动，不能当作本任务临时进程关闭。

核对[Codex官方notify说明](https://learn.chatgpt.com/docs/config-file/config-advanced#notifications)和本机exec帮助后，使用仅一次进程的 `-c notify=...`、read-only sandbox、ephemeral、独立 `/tmp/shellspan-petdex-stage11-codex/`，不改用户/项目配置，不使用bypass-hook-trust。临时适配器只把真实 `agent-turn-complete` 的thread-id及最终回复映射到[官方Petdex runner](https://github.com/crafter-station/petdex/blob/f2ea48aac6f89fbaeedd6a639faf4e208864ae5d/packages/petdex-desktop-native/src/hook_runner.zig)的字段，调用现有 `petdex-hook bubble stop codex`；没有手工POST气泡、伪造Codex来源或注入模型回复。适配器在调用前匿名核对官方PID/路径，不读或输出令牌。原生runner的stop会清理旧标题缓存，因此本次runner额外置于仅禁止文件写入的进程沙箱，既有缓存名称前后不变。

实际CLI退出0，耗时32579ms；事件为thread.started、turn.started、item.completed、turn.completed各1，唯一item为agent_message，回复“Codex coexistence verified.”，没有工具调用。notify审计确认真实完成事件、身份门禁通过和官方runner退出0；用户配置/钩子逐字节及65个既有缓存名称前后未变。有限审计位于该临时目录的run-result.json、notify-result.json；不保存认证、其他业务正文或原始通知身份。

**共存通过，证据为用户现场答复：**ShellSpan已实际开启消息、详情保持关闭，17:48:11消息诊断3/3已用槽且有新接受时间；17:53:25又通过生产固定测试按钮更新己方槽并获接受，17:55恢复并结算己方槽。协调会话随后明确询问是否看到“Codex coexistence verified.”与ShellSpan卡片同时存在，用户回复“同时存在”。这确认该次观察时Codex卡在ShellSpan更新与结算后仍与ShellSpan卡共存；不是连续录像，不倒推每次刷新或全部历史窗口，也不将答复扩展为Focus Mode值已确认。runner退出0本身仍不代表显示成功，本项通过依赖上述现场答复。

17:55恢复本任务原偏好，原生关闭返回结算请求已接受，SQLite确认消息/详情false、总开关/三分类true、zh-CN、restoreWorkspace=false；开发安装三槽possibly_busy=false，开发应用正常退出。未操作Codex卡、其他Codex任务或外部新增钩子；Petdex98256是外部启动，按最新现场保留运行，显示偏好true/按会话true/寿命0未改。临时Codex目录保留为明确的无凭证审计产物，本轮没有新增容器。用户的最新文字观察按上文范围登记，不冒充截图或连续录像。

### 剩余边界与协调审阅

- 1/2/3/4+活动、摘要/重绑、有限标题/文件基本名/最终回复、双语、详情撤销、固定预览与最新状态恢复、退出结算均已有上列限定实际显示。跨连接复制业务与目标文件哈希真实通过；复制短窗口的目标映射依靠同一生产入口及已有目标归属回归，未称其有独立逐帧气泡录像。
- 敏感字段整体回退、超长候选、完整Markdown排除规则和默认隐私由阶段8及本轮全量生产回归覆盖，不把真实秘密发给模型/Petdex来凑实测。实际屏幕仅验证安全标题、基本名、普通最终回复和固定模板，不保证任意秘密都能被识别。
- 实际墙钟1500/1502ms及真实2成功/1未完成的部分结算已补齐；Disabled仍以生产门禁及有限日志说明，网络级抓包受BPF权限限制。不会为更强证据制造限流或停止未知服务。
- 令牌轮换内存布尔比较、真实离线失败后恢复显示已补；最初轮询窗口不声称逐帧覆盖。用户指定Codex，真实单次CLI通知与ShellSpan后续更新/结算已执行，用户现场确认两类卡片同时存在；外部新钩子保留，不代批准其信任，也不把单进程测试当作持久钩子的全面验证。
- 颜色记录已获准删除且刷新确认不存在，不再属于待办。阶段11必需验收证据已闭合，协调确认完成；若另需网络级连续抓包，仍须具备相应采集条件。本任务临时偏好已恢复、开发应用已退出，保留外部启动的Petdex。未创建commit、tag或推送。

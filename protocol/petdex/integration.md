# Petdex 联动契约与限制

核验日期：2026-09-29。动作联动阶段0–5已完成，消息气泡阶段6–11也已完成；两者的实际证据与限制分别见[动作验收](../../docs/design/petdex-integration-acceptance.md)及[消息验收](../../docs/design/petdex-message-integration-acceptance.md)。下文说明动作联动契约，消息内容与传输另见[气泡契约](bubble.md)。

## 证据范围

- ShellSpan 基线：`a09a6cfcdf48a84d40010d04c6dd50f2865f8d46`，实现入口为 `src-tauri/src/petdex.rs` 及其子模块。
- 本机 `/Applications/Petdex.app` 的 Info.plist 和 package-manifest.zon 均标记版本 0.8.0。
- 上游 `desktop-v0.8.0` 对应 commit `f2ea48aac6f89fbaeedd6a639faf4e208864ae5d`（另经 commits API 确认）。以下服务端结论来自该版本源码静态阅读，**不是本机运行验收**；未建立安装二进制与该源码的可复现构建对应关系。
- [HTTP 服务、认证及队列源码](https://github.com/crafter-station/petdex/blob/f2ea48aac6f89fbaeedd6a639faf4e208864ae5d/packages/petdex-desktop-native/src/hook_server.zig)：`StateEvent`、`Mailbox.enqueueWithCounter`、`start/run`、`route`、`tokenOk`、`parseDuration`。
- [显示状态消费源码](https://github.com/crafter-station/petdex/blob/f2ea48aac6f89fbaeedd6a639faf4e208864ae5d/packages/petdex-desktop-native/src/main.zig)：`isDurationState`、`dwellFor`、`applyState`、`poll_tick`。
- 运行环境、命令结果及尚未完成的联调见 [验收记录](../../docs/design/petdex-integration-acceptance.md)。阶段 0 仅发现 Python 监听；阶段 1 后续核对到运行中的 Native Desktop，确认 PID 与安装路径后验证了 health/whoami 和生产客户端的挥手 POST；未向 Python 发送令牌。

## 现有请求契约

消息气泡已接入，见[消息设计](../../docs/design/petdex-message-integration-design.md)、[气泡契约](bubble.md)及[消息验收](../../docs/design/petdex-message-integration-acceptance.md)。AI按会话、SSH/SFTP按后端连接归属，最多三个固定槽，默认模板、另行开启有限详情，关闭只结算已用槽且共享1500ms预算。消息与详情默认关闭，生产消息传输使用 `/bubble`；下述 `/state` 动作契约不能替代气泡契约。组合、计时、隐私和残留限制按各自验收范围说明。

ShellSpan 的动作发送只向 `http://127.0.0.1:7777/state` 发出 JSON POST，凭证通过 `tokio::fs::read_to_string` 异步读取自 `~/.petdex/runtime/update-token`，使用标记为 sensitive 的 `X-Petdex-Update-Token` 请求头。客户端禁止代理，显式使用 `reqwest::redirect::Policy::none()` 禁止重定向，连接超时 250ms、单次请求超时 750ms。取消覆盖请求锁等待、异步读取和请求；重新读取后再次检查取消。阶段 4 另有用户主动触发的匿名只读 `GET /health`，见下文。

阶段 5 在真实端口误接后增加匿名协议兼容门禁：读取 token（含401后的重新读取）前，以及每次认证 POST 前，依次检查固定 loopback 的 `/health` 和 `/whoami`。响应必须为 HTTP 200、最多1024字节且可由 serde_json 解析；health 要求 ok=true/port=7777，whoami 要求 ok=true/inProcess=true/有效正PID。检查与发送共用请求锁和取消代际，沿用单次网络超时，匿名探针不附带令牌、不更新成功发送时间。非兼容响应归为 rejected、传输失败归为 unreachable；metadata 可先检查凭证文件存在性，但兼容失败不读取凭证内容。

整次状态尝试（含锁等待、全部匿名检查、凭证读取和最多一次401重试）受1500ms预算限制。短动作携带单调时钟绝对截止时间，真正POST前重新计算剩余毫秒；到期返回内部Expired，不发送该动作、不记成功、不改变连接诊断，并重新仲裁。手动测试仍有2秒总回复上限；调用方超时或关闭时中止未完成的尝试，在同取消代际锁内只撤销本次独立预览并恢复此前连接诊断，保留业务提示。明确发送失败也移除本次预览，不在后台补发失败的预览。已经发出的HTTP或服务端已入队动作无法撤回，不承诺显示层取消或抢占。只读health同样使用1KB响应上限。

发送去重同时比较动作与绝对截止时间。不同来源的同类短提示先后到期时，切换到仍有效的提示会触发发送，只携带其剩余时长；同一提示的剩余时间自然减少不会触发重复发送。新截止时间仍遵守100ms最短发送间隔，相同动作和截止时间的失败重试继续遵守退避；无截止时间的持续状态沿用原恢复探测频率。

这不是服务身份认证：匿名接口可被其他本地程序仿冒，服务也可能在检查完成与 POST 之间切换（TOCTOU）。它只为已知 Python 404/非JSON等误接场景提供失败关闭保护，不能保证凭证永远不会发给切换后的进程。0.8.0 未提供可验证的服务身份证明或连接绑定凭证机制；不得把这层兼容检查描述为解决了该协议边界。

正文只有 `state` 与可选整数 `duration`。没有持续时间时省略字段。ShellSpan 将持续时间转换为毫秒，限制在 1–30000；当前成功提示为 1200ms，失败提示为 2500ms，发送时使用剩余时长。

| 项目 | 0.8.0 源码核查结果 | 运行验收 |
| --- | --- | --- |
| 六种动作 | 接受 `idle`、`waiting`、`waving`、`running`、`jumping`、`failed`；服务端还接受其他状态，ShellSpan 不使用 | 阶段 5 原生截图已观察；waiting 抬手帧与 Uika row 6 核对 |
| `running` | 服务端交替转换为 `running-right` / `running-left` 入队 | 已观察两侧奔跑，包括真实 SFTP 上传期间 |
| `duration` | 毫秒；缺省/0 使用默认停留；负数和非数字拒绝，超过 30000 截断；显示停留至少 250ms | 毫秒单位及1200/2500/10000ms行为已实测；250ms精确下界、非法输入及30000ms截断仅源码确认 |
| 到期 | `waving/jumping/failed` 在停留结束且队列为空时回到 idle；有下一动作则消费下一动作 | 已观察长短停留；1200ms waving 约1.1秒仍挥手、1.5秒空闲，2500ms failed 约2.58秒已恢复；非精确帧时保证 |
| 持续动作 | `waiting/running/idle` 不因 duration 到期自动释放；duration 是停留控制，不是租约 | running 1000ms 后约5.4秒仍奔跑；waiting 10000ms 后约10.8秒仍抬手等待 |
| 认证 | 缺少或不匹配的头返回 401；会话启动生成 32 字节随机数的 64 字符十六进制令牌，POSIX 文件模式 0600 | 已验证缺失头=401、匿名health=200、文件0600；未损坏真实凭证 |
| 令牌轮换 | 启动生成新令牌，写文件发生在监听端口绑定前；文件存在不证明服务可用 | 受控重启确认变化；最终原生始终开启并自动恢复已通过 |
| 返回码 | 200 接受处理；401 认证失败；400 无效状态/时长；429 共享限流；解析层可能返回 413 | 实际200/401及异服务404已验证；客户端429分类回归通过，服务端400/429/413未做真实压测 |
| 入队 | 全局队列容量 50；连续同状态合并，满队列不入队；200 正文可能含 `queued:false` | 排队顺序、不抢占及镜像差异有连续截图；容量饱和/合并边界未独立实测 |

显示线程每 100ms 轮询，在当前停留完成后才消费下一事件。因此 ShellSpan 的优先级只控制自身目标动作，不能抢占 Petdex 已排队动作，也不能保证动画显示时刻和业务发生时刻完全一致。短提示的服务端计时从显示开始，客户端的过期控制不能撤回已入队动作。

当前 ShellSpan 只判断 HTTP 状态码，不解析 `queued`。`connected` 和“最近成功通信时间”只能表示通信成功，不能证明入队、当前显示或用户肉眼确认。

## 读取、隔离与释放

0.8.0 源码提供无令牌的只读 `GET /health`（ok/port）和 `GET /whoami`（pid/inProcess），也提供 `GET /state`。后者读取入队状态镜像，不是屏幕实时状态，到期回到 idle 不会通过此路径更新镜像。阶段 1 已验证本机 health/whoami；阶段 5 已直接观察 GET state=running-left 时屏幕仍挥手，直到当前停留结束才显示奔跑。后台恢复仍发送状态 POST；阶段 4 的手动“重新检测”只读 health，不触发状态发送。

`StateEvent` 仅有状态与时长，没有来源、所有者、运行 ID 或租约。完整 `route` 未提供状态 release 接口；`/bubble` 的会话隔离不适用于 `/state`。多应用共享队列和每秒 30 次的 state/bubble 限流预算，处理顺序、合并和当前停留共同决定显示，不应简化为“最后写入立即覆盖”。

关闭 ShellSpan 联动会取消通信协调器并清空短提示与预览，纯内存活动登记继续跟随工作线程，不读取凭证、不发送清理请求。阶段5已观察：关闭总开关后约4.7秒、正常退出后约3.6秒桌宠仍有waiting抬手帧，不能承诺自动清除。**不新增全局idle清理请求**，以免覆盖其他应用。两个实际客户端已验证共享队列的非抢占顺序，ShellSpan周期idle会影响另一客户端留下的running；详见最终验收时序，未宣称穷尽所有应用组合。

## 状态映射与后续实现边界

| 业务状态 | 动作 | 当前落地范围 |
| --- | --- | --- |
| SSH 连接中 | waiting | 已有 |
| SSH 成功 | waving，1200ms | 已有 |
| SSH 失败或异常断开 | failed，2500ms | 已有 |
| SFTP 执行中 | running | 已有 |
| SFTP 成功/失败 | jumping 1200ms / failed 2500ms | 已有 |
| 取消、主动关闭 | 仅移除对应活动 | 已有 SSH/SFTP/AI |
| AI 执行中 | running | 已实现 |
| AI 等待审批/回答 | waiting | 已实现 |
| AI 回合成功/最终失败 | jumping / failed | 已实现 |
| 部署执行、等待审批、成功/失败 | running / waiting / jumping / failed | 用户要求延期，不属本轮范围 |
| 无活动 | idle | 已有 |

现有仲裁为失败 > 等待用户 > 成功 > 执行 > SSH 连接 > 空闲。独立预览优先于普通成功/执行/连接，但低于失败和等待用户；业务短提示在覆盖期间继续按原始发生时间计时，过期不补播。SSH/SFTP/AI 分类已实现；部署来源、分类与生命周期按用户要求延期，不属于本轮实现或验收范围。内部重试、恢复门禁、取消请求和真正终态必须从权威业务出口区分。

## 隐私与错误处理

- 动作请求的业务标识只用于 ShellSpan 内部仲裁，`/state` 不发送主机、路径、文件名、任务 ID、终端/AI 内容或自由文本，不调用更新或远程服务接口。另行开启的消息及有限详情遵循[气泡契约](bubble.md)的独立内容边界。
- 总开关默认关闭；关闭时不读凭证、不发请求。Petdex 拥有的令牌文件是本地协议凭证来源，不复制到普通配置、日志、快照或仓库。
- 当前客户端 trim 后校验 64 位十六进制；401 时重新读取，只有值发生变化才立即重试一次；传输失败由协调器退避恢复。250ms 起步，最大 60s；最短发送间隔 100ms。
- 传输错误映射为 `unreachable`，不推断对端是否运行；凭证缺失、不可读、无效、认证失败与请求拒绝分别呈现有限类别，不输出原始响应或令牌。
- 没有真实环境时可推进上述客户端可靠性、诊断、仲裁及内部业务接入；不得声称来源隔离、租约、显示抢占、重启恢复或多应用联调已通过。

## ShellSpan 诊断 IPC（阶段 1）

`petdex_set_enabled`、`petdex_get_status` 和 `petdex-status` 事件使用以下诊断结构；阶段 2 的 `petdex_test_connection` 将它放在返回值 `diagnostic` 中。字段名为 camelCase：

| 字段 | 语义 |
| --- | --- |
| `revision` | 当前适配器进程内单调递增；字段不变不递增；关闭/重开不重置 |
| `status` | `disabled/checking/notDetected/connected/unreachable/unauthorized/rejected/tokenUnreadable/tokenInvalid`；`notDetected` 仅表示凭证缺失 |
| `errorReason` | `null` 或 `tokenMissing/tokenUnreadable/tokenInvalid/transport/unauthorized/rejected` |
| `targetAction` | `null`（关闭）或六种动作之一；是客户端当前目标，不是显示确认 |
| `lastSuccessAt` | `null` 或 Unix 毫秒时间；HTTP 200 更新，失败/关闭保留历史时间，系统时钟回退不使其倒退 |

手动请求排队/响应超时及协调器不可用返回有限 IPC 错误，不伪造连接诊断。前端通过类型化 IPC 和 Ajv 检查结构；无效命令响应拒绝、无效事件丢弃。所有事件/读取/配置/测试结果共用修订号判断，旧事件或迟到初始化读取不能覆盖新状态。相同修订号的有效读取可清除前端读取错误，但不替换快照。前端 `connectionError` 只用于诊断读取失败；订阅失败另行提示，配置/测试动作会重试注册，成功的通信快照不被订阅错误遮蔽。

后端在协调器锁内检查取消并提交诊断；关闭后的旧协调器不能更改重开后的仲裁或诊断。发送节流、退避、401 令牌变更后的单次重试不变。

## 活动与顺序契约（阶段 2）

生产入口为 `ActivityGuard::start(app, source, phase)` / `new(adapter, source, phase)` 与 `transition(phase)`。来源为 SSH/SFTP/AI；`ActivityPhase` 区分 Connecting、Connected、Running、Waiting(Approval/Answer)、Succeeded、Failed、Cancelled。类型位于 `petdex::types`，内部等待不能直接提升为等待用户。

- 每次实际工作使用进程内单调运行 ID，不复用会话 ID、调用方 operation ID、文件名或时间戳。ID 分配与初始登记在协调器锁内完成；同一 guard 的阶段发布要求独占可变借用，revision 单调递增。来源模型不接受任意异步重放 start；接入新的权威来源时必须沿用同步注册。
- 来源登记与仲裁共用同一内存表和锁，不通过可能丢失的外部事件监听重建活动。Wake 只用于唤醒，可合并或因队列满而省略，活动更新已经完成。启用在同一锁内建立接收端、读取当前目标并写入诊断，不存在“读取后才订阅”的窗口。
- 关闭保留当前活动、运行计数器和来源水位，只清理展示槽并取消通信代际。关闭期间收到终态仍结束对应活动但不产生提示。启用只投影当前仍有效的活动，不补播关闭期间成功/失败。
- 已登记运行仅接受更高 revision；终态只删除该运行。未知更新/终态会推进来源水位但不会创建活动，后到的旧 start 被拒绝。终态历史最多 512 条，淘汰后来源水位继续拒绝旧开始事件；水位数量受有限来源枚举约束。已登记的更早并发运行仍可正常更新和结束。
- SSH guard 由 SSH 工作线程持有，连接成功进入 Connected（无持续动作，但保留异常断开识别能力），正常退出中性结束，异常失败发短提示。工作结束后检查未消费的 Close 或控制通道断开，连接/初始化期间取消不会冒充失败。
- 四个 SFTP 命令（远端复制、跨远端复制、批量上传、批量下载）每次实际调用持有一个 guard，并移动进 blocking worker。工作线程在返回结果前发布终态；等待方取消不会提前结束仍在工作的传输。成功、部分失败和已有取消类别沿用领域结果；panic/unwind 或未处理提前退出由 Drop 兜底失败并清理活动。取消请求本身不结束活动，等待工作线程确认。没有按文件拆分额外结果。
- 临时槽按 occurred_at + TTL 计时；到达时已过期的终态只清理活动，不替换当前提示。恢复重试重新仲裁当前状态，没有终态重放队列。已经发出的 HTTP 请求和服务端队列不能撤回，不能承诺动画实时抢占。

## 测试动作 IPC（阶段 2）

`petdex_test_connection` 返回 `{ diagnostic, preview }`，`preview` 为有限枚举：

| 值 | 含义 |
| --- | --- |
| `requested` | HTTP 请求成功，已请求挥手预览，不代表已显示 |
| `overridden` | HTTP 请求成功，但发送时或返回时失败/等待用户优先于预览 |
| `failed` | 测试通信失败，连接类别见 diagnostic |
| `disabled` | 未启用或原请求代际已取消，即使已快速重开也不会误报旧请求成功 |

预览单独计时，不清空活动或成功/失败提示。回复同时检查发送时目标和返回时高优先级活动，避免在途变化被误报为未覆盖。前端以 Ajv 验证完整结果、仍通过诊断 revision 防倒退，并按 preview 显示一次双语 Toast；普通后台恢复不触发该 Toast。命令名与注册不变，不增加向 Petdex 发送的字段。

## 只读重新检测与诊断详情（阶段 4）

阶段 4 新增 `petdex_check_health`，返回 `{ diagnostic, health }`。`health` 仅为 `reachable/unavailable/disabled`，通过 Ajv 验证；`reachable` 需要 HTTP 200 和有效的 `{ok:true, port:7777}`，只表示匿名健康接口响应。请求复用固定 loopback 客户端与请求锁，等待锁、网络与 JSON 读取均受取消和总计 1500ms 超时约束；关闭时不读凭证、不通信。检测不修改仲裁、预览、退避、诊断 revision 或 `lastSuccessAt`，不把匿名健康成功当作认证成功。返回当前诊断用于前端恢复读取，沿用 revision 规则；前端同时重试状态订阅。后台重试静默，主动检测只给一次完成 Toast，有限健康结果留在按需展开的详情内。快速重复触发用同步 busy ref 去重，配置变化和卸载用操作代际丢弃旧反馈。

诊断详情显示有限状态对应的处理建议、六种动作的双语可读 label、最近成功发送动作时间及无记录空态。历史时间保留但明确不保证当前连接或动画显示。GitHub 反馈保持固定表单 URL，无应用数据附带；表单新增问题分类，聚合评估同意改为可选，不提交或上传数据。

## AI 生命周期与分类配置（阶段 3）

- AI 的活动由 `AgentSessionStore` 持有，`append_payloads_locked` 在磁盘提交成功后、仍持有存储锁时观察生命周期事件。没有通过 token、React 渲染或解锁后的事件订阅推断状态。观察器只处理生命周期边界，不因流式片段重新扫描日志。
- 实际 driver 开始时登记准备期；TurnStart 将该活动绑定到真实回合，下一回合使用新的 ActivityGuard 运行 ID。终态只认本批已提交事件和对应回合，不能把历史 TurnEnd 套到尚未开始的新回合。driver 使用单调代际结算，旧代际不能清理新活动。
- `WaitingApproval` 和 `WaitingQuestion` 使用已有恢复投影，分别映射 Approval/Answer。网络恢复等内部等待保持 running；单个工具被拒绝不表示整回合失败。driver 暂时返回 Waiting 只释放 driver 代际，活动继续由 SessionStore 持有。
- 对应回合的 completed、明确的 Completed/Failed/Cancelled 终态分别产生成功、失败或中性结束；不完整输出和恢复/预算边界不自行推断最终失败，后续 Idle 中性清理。driver 异常退出由观察租约按真实取消令牌兜底；正常 Waiting 返回不触发 Drop 失败。
- 重建存储时只登记当前尚未结束的审批/问题等待；历史成功、失败不重放，崩溃时留下的普通 running 日志不冒充活着的 worker。实际恢复 driver 时再登记运行。观察器只增加内部观察，不改变 Agent v5 外部事件协议。
- `petdex_set_enabled` 保留原命令与注册，增加可选 `categories: { ssh: boolean, sftp: boolean, ai: boolean }`。省略时保持后台已有分类；首次默认 SSH/SFTP 开、AI 关。前端迁移保留原 `petdexEnabled`，分类单独持久化。总开关仍默认关闭。
- 分类设置在总开关关闭时仍可提交，但不启动协调器、不读取 Petdex token、不通信。前端把稀疏分类修改串行合并到最近一次后台确认值；只有确认值进入持久化，失败回退不会覆盖其他已成功分类。
- 仲裁保存所有来源真实活动；分类只过滤展示。成功/失败短提示按来源分别保存，关闭分类只清除该来源的提示，保留其他来源和独立预览；重新开启只读取当前活动，不补播已被清除或关闭期间的结果。
- 分类改变会取消旧请求代际，再建立协调器并读取当前目标；其他来源短提示保留原截止时间。已经由 Petdex 接收或入队的请求仍无法撤回，分类开关不能提供桌宠端的来源释放或抢占。

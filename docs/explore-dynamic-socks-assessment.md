# EXPLORE 动态 SOCKS 转发候选评估

> 基线：`8d7166b`
> 审核日期：2026-08-23
> 路线图范围：基于真实使用场景评估动态 SOCKS 转发、串口、Mosh 或其他协议，一次只验证一个方向
> 唯一研究对象：受限的本地动态 SOCKS5 转发

## 结论

本项保持 `candidate` / `researching`，`necessary` 为 `false`，候选基础实现门禁保持 `blocked`。本次先比较动态 SOCKS、串口、Mosh 与“其他协议”，然后只保留**受限的本地动态 SOCKS5 转发**作为唯一研究对象；没有实现任何协议、配置格式、命令、UI 或依赖。

- TermBridge 自身公开 issue 中没有 SOCKS、serial/串口或 Mosh 请求，且 issue 创建受限。零结果不能证明没有需求，更不能支撑产品承诺。
- 动态 SOCKS 与现有本地/远程 SSH 端口转发最接近，能复用 SSH 认证、Known Hosts、跳板机、钥匙串、操作 ID、停止/重试和隔离 SSH 测试基础；它是比较后维护面最小的研究对象。
- 现有转发仍是预先声明单一目标的 `local | remote` TCP 转发，没有 SOCKS 协商、逐请求目标授权、活动连接总量、握手大小/超时、子连接强制取消或目标策略测试。不能把“已有端口转发通过测试”当成动态代理已经安全。
- 串口需要新增 Windows COM 与 macOS TTY 枚举、权限、驱动、热插拔和真实硬件夹具；Mosh 需要 UDP、远端 `mosh-server`、会话密钥、漫游状态和客户端/服务端版本兼容。两者均没有 TermBridge 用户证据，也不与动态 SOCKS 同时研究。
- “其他协议”不是具体可验证对象；在出现明确协议、用户任务与维护边界前不进入比较后的研究队列。

因此本次不新增动态 SOCKS，也不顺带实现串口、Mosh、Telnet、RDP、插件运行时、第三方代码执行、云账户、市场或团队服务。

## 真实场景与用户证据

2026-08-23 的公开仓库快照中，以下查询均为 0 结果，页面同时显示 `Issue creation is restricted in this repository`：

- [SOCKS issue 查询](https://github.com/hi-fullmoon/TermBridge/issues?q=is%3Aissue+SOCKS)
- [serial issue 查询](https://github.com/hi-fullmoon/TermBridge/issues?q=is%3Aissue+serial)
- [串口 issue 查询](https://github.com/hi-fullmoon/TermBridge/issues?q=is%3Aissue+%E4%B8%B2%E5%8F%A3)
- [Mosh issue 查询](https://github.com/hi-fullmoon/TermBridge/issues?q=is%3Aissue+mosh)

动态 SOCKS 的候选用户群是假设中的个人运维人员与开发者：已经通过 SSH/跳板机进入受限网络，需要让本地浏览器、数据库客户端或其他支持 SOCKS5 的 TCP 工具访问多个、会变化的内网端点。价值假设是用一个有界代理替代反复创建多个静态本地转发规则。OpenSSH 的 `-D` 也把该能力定义为本地动态应用层转发，并由本地 SOCKS 客户端逐连接给出目标；[OpenSSH ssh(1)](https://man.openbsd.org/ssh#D) 与 [RFC 1928](https://www.rfc-editor.org/info/rfc1928/)只证明协议和场景存在，不是 TermBridge 用户需求证据。

准入前至少需要：

1. 5 名独立意向用户，分别记录真实任务类别、当前静态转发数量、频率、配置耗时、失败成本，以及是否必须使用远端 DNS；不得记录真实主机、URL、用户名、凭据或流量内容。
2. 至少 3 名用户愿意在隔离或脱敏环境完成候选试用，覆盖浏览器/HTTP、数据库客户端和一个非 HTTP TCP 工具；每人验证启动授权、策略拒绝、SSH 中断、取消、重试和 N-1 配置升级。
3. 对照现有静态本地转发，证明动态代理能显著减少规则数量或任务时间，并且目标 allowlist、端口限制和手动启动不会消除主要价值。
4. 明确 SOCKS5 `CONNECT` 是否足够；没有真实 UDP 任务证据时，`UDP ASSOCIATE`、`BIND`、SOCKS4 与反向动态代理保持排除。

当前没有上述样本、基线或试用队列，用户群和用户价值均未满足，必要性不能成立。

## 候选比较与唯一选择

| 方向 | 真实任务假设 | 可复用基础 | 新增维护与安全边界 | 本轮决定 |
| --- | --- | --- | --- | --- |
| 受限动态 SOCKS5 | 通过一个 SSH/跳板机访问多个变化的内网 TCP 端点 | 现有 SSH2、Known Hosts、钥匙串、跳板机、本地回环监听、转发生命周期、操作记录和隔离 SSH 服务 | SOCKS5 状态机、逐请求目标策略、DNS 语义、连接总量、子通道取消、协议故障测试 | **唯一研究对象**；不实现 |
| 串口 | 网络设备初始配置、嵌入式调试或故障恢复 | 可复用 xterm 显示和部分会话 UI | COM/TTY 枚举、设备权限、驱动差异、波特率/流控、热插拔、独占锁、真实硬件矩阵；跨平台库本身也建议用真实设备验证，[serialport 文档](https://docs.rs/serialport/latest/serialport/)不能替代产品证据 | 不选择，不并行研究 |
| Mosh | 弱网、漫游和高时延交互终端 | 可复用 profile、SSH 启动认证和 xterm 显示 | UDP 端口/NAT/防火墙、远端 `mosh-server` 安装与版本、会话密钥、漫游、预测显示和二进制供应链；[Mosh 官方说明](https://mosh.org/)明确依赖 SSH 启动后转为 UDP | 不选择，不并行研究 |
| 其他协议 | 尚未定义 | 无法审计 | 没有具体协议、用户、威胁模型、升级面或测试对象 | 不进入研究 |

选择动态 SOCKS 只表示后续发现工作一次围绕一个方向开展，不表示它已优先于现有承诺、允许实现或进入发行计划。

## 现有端口转发与 SSH/会话边界

| 边界 | 已有证据 | 对动态 SOCKS 的缺口 |
| --- | --- | --- |
| 配置模型 | `PortForwardKind` 只有 `local | remote`；profile 持久化和连接导出会清洗 ID、名称、端口与远端回环约束 | 没有 `dynamic` 语义、目标策略、协议版本或逐请求目标；不能把任意新 kind 静默塞进 v3 导出 |
| 本地监听 | 本地转发在命令返回前绑定 `127.0.0.1:port`，端口冲突立即失败；远程转发只允许远端回环 | 动态代理仍需明确只允许本机回环、禁止 `0.0.0.0`/`::`，并决定 IPv4/IPv6 双栈语义 |
| SSH 与凭据 | 转发通过同一 `open_authenticated_session`/跳板链路在 Known Hosts 路径可用时先校验再认证；密码、私钥与 passphrase 从现有钥匙串边界准备，日志只记录秘密是否存在 | 启动命令当前把 `known_hosts_path` 错误用 `.ok()` 降级为无路径，候选必须改为失败关闭；不能新增独立明文凭据、绕过未知/不匹配 host-key 或复用未经用户选择的 profile |
| 终端/PTY | 远端终端使用独立 SSH session、PTY、非阻塞读写、keepalive、关闭分类和重连 UI | SOCKS 不需要 PTY，也不得借终端通道执行远端命令；不能把终端“可重连”误解为可无损恢复代理 TCP 流 |
| 生命周期 | manager 拒绝同 profile/rule 重复活动项，保存状态与字节计数；手动停止、所有者关闭、应用退出/重启会请求停止，完成历史超过 200 后裁剪 | 没有活动转发总上限；每个已接受连接会再启动桥接线程，取消只停止接收循环，未登记并强制关闭既有子连接；这不满足动态代理的并发与失败关闭要求 |
| 目标校验 | 静态目标在开始前校验空值、长度、端口和显式 link-local/metadata IP；SSH TCP 连接还会解析 DNS 后复查地址 | `direct-tcpip` 由远端解析目标，现有静态转发不会在远端解析后复查；动态客户端可逐请求给出域名/IP，必须有明确 allowlist、端口和 DNS 决策，不能成为无限制内网代理 |
| 可见性与审计 | Tauri 调用层为启动/停止写操作记录，失败分类为端口、host-key、认证、连接、配置或其他；日志不保存流量内容 | 逐请求目标是敏感元数据；必须在“不记录流量/域名”与可审计授权策略之间定义边界，错误不得回显 SOCKS 载荷或凭据 |

## 未来最小候选的强制安全契约

以下边界是重新准入后的最低门槛，不是本次实现设计或承诺：

### 明确授权、目标与凭据

- 只允许用户从一个已选择的 SSH profile 手动启动；首次候选不允许自动启动、后台静默恢复或由 AI/Runbook 启动。启动预览必须显示 SSH 目标、跳板链、`127.0.0.1` 监听端口、允许的目标/端口策略、超时和并发上限。
- 只实现 SOCKS5 `CONNECT` 和 `NO AUTHENTICATION` 的本机回环监听。明确拒绝 SOCKS4、`BIND`、`UDP ASSOCIATE`、用户名/密码子协商、反向动态转发和非回环绑定。安全来自本机回环范围、显式用户启动和 SSH 加密，不宣称 SOCKS 层自身有加密或强认证。
- 初始策略不得是任意目标。用户必须批准最多 32 条规范化目标规则和最多 32 个单端口/闭区间；默认从精确主机/IP与精确端口开始，不提供 `*:*`。link-local、unspecified、云 metadata 名称/IP及其等价写法始终失败关闭；远端 DNS 的解析后地址无法证明符合策略时不得宣称安全模型已完成。
- 复用现有 profile、Known Hosts、钥匙串和跳板认证；不新增 SOCKS 密码、凭据导出、明文回退或新的秘密读取器。Known Hosts 路径创建/读取失败以及未知/不匹配 host-key 都必须在发送凭据前停止，不能沿用当前转发命令把路径错误降级为 `None` 的行为；信任只能走现有显式流程。

### 大小、并发、超时与重试

- SOCKS 方法协商帧最多 257 字节，请求帧最多 262 字节，域名最多 253 个 ASCII/规范化 IDNA 字节；只接受 IPv4、IPv6 或规范化域名目标，截断或未知 ATYP/CMD/METHOD 返回确定错误后关闭。单次读取中紧随完整请求的应用数据不得被误解析为请求字段，成功答复前最多暂存 16 KiB，超限即关闭。
- 最多 8 个活动动态转发、每个转发 16 个活动客户端连接、应用总计 64 个活动代理连接；达到上限立即拒绝，不排无限队列。每方向固定 16 KiB 流缓冲，不把完整载荷、DNS 名称或应用数据持久化。
- SOCKS 握手 5 秒、SSH/目标建连 12 秒；数据空闲上限需由真实试用决定，在确定前不得实现无限空闲连接。所有计时器必须可取消且使用单调时钟。
- 启动或单次目标连接失败不自动重试；每次用户手动重试动作只发起一个新的 operation ID 并记录 `retryOfOperationId`，失败后不在该动作内循环重试。SSH 断开不重放现有 TCP 流，也不把断开的代理标为恢复成功。

### 失败关闭、取消与恢复

- 无效协商、越界目标、上限耗尽、SSH host-key/认证/握手失败、direct-tcpip 拒绝、读写错误或应用退出都必须关闭对应监听、客户端 TCP、SSH channel 与桥接 worker；不能只停止 accept loop 后遗留既有通道。
- 停止操作需等待全部子连接在有界期限内结束；超时则强制关闭并显示未优雅完成的连接计数。任何部分清理失败保持 `failed`，不得宣称 `stopped`。
- 运行时只保留 operation/profile/config ID、状态、时间、总字节计数、活动/拒绝连接计数和稳定错误类别。目标域名、IP、请求字节、应用载荷、Cookie、Authorization 和 SOCKS 协商内容不写日志、诊断或操作记录。
- 崩溃或升级重启后恢复为已停止状态；用户必须重新查看策略并手动启动。不能恢复旧监听、旧 SSH channel 或旧客户端连接。

## 版本与升级策略

当前连接导出 `schemaVersion: 3` 将转发作为 profile 的嵌套 `local | remote` 规则，内部 `organizationJson` 本身没有独立公共版本。动态目标策略包含新的必需语义，不能通过一个可选 `kind` 让旧客户端静默丢弃：

- 若未来实现，连接导出必须进入显式 v4，提供固定 v3、v4、较新版本和未知动态字段夹具；v3 迁移后保持原静态规则，v4 动态规则必须完整校验或整条失败，不降级成静态转发。
- 旧应用读取 v4 应在任何写入前显示“版本过新”并保持本地 profile 不变；当前解析器把不支持版本折叠为 `[]`，因此升级策略准入尚未满足。
- 内部存储需要独立、版本化的策略对象和上限；目标 allowlist、端口范围、DNS 模式或协议命令集合变化都属于必需 schema 变更，不以宽松未知字段跳过替代迁移。
- N-1 应用升级必须停止所有监听和子连接、原子迁移配置、启动为 stopped；迁移失败回滚配置并保持代理关闭。回滚配置不等于允许应用二进制或数据库降级。

## 跨平台实现与维护成本

动态 SOCKS 的核心可建立在 Rust `std::net`/现有 `ssh2::Session::channel_direct_tcpip` 上，不需要串口驱动、PTY 或远端二进制，理论上能共享 Windows x86_64 与 macOS ARM 实现。但当前只有两平台常规 Rust 测试，隔离 SSH E2E 只在 Ubuntu runner 执行；Windows/macOS 没有真实监听、端口释放、休眠/网络切换、防火墙或退出清理证据。

持续成本至少包括 SOCKS5 解析器与模糊测试、目标策略和 DNS 安全评审、跨平台 socket 生命周期、连接/线程上限、SSH 服务端策略差异、v3→v4 迁移、故障注入、两平台 E2E 和安全公告响应。仓库没有候选实现后的 CI 时长、线程/内存基线、缺陷率或月度维护数据，因此维护成本与跨平台实现均保持 `unknown`。

## 自动化测试证据与缺口

### 已有可复用证据

- `src-tauri/src/port_forward.rs`：本地/远程转发校验、回环绑定、端口冲突、流量计数、停止、远端回环限制，以及隔离 SSH 中的双向转发和端口释放。
- `src/stores/__tests__/portForwardStore.test.ts`、`src/hooks/__tests__/useReconnectSession.test.ts` 与 `useMonitorEvents.test.ts`：失败状态、启动竞态、连接所有者、断线/重连和停止行为。
- `src-tauri/src/connection.rs`：DNS/IP 阻断、host-key 先于认证、跳板机、超时与隔离 SSH 主机密钥/PTY 链路。
- `src/lib/__tests__/connection-import.test.ts`、`src/stores/__tests__/profileStore.test.ts`：v1–v3 转发配置清洗、无秘密导出、钥匙串与 SQLite 补偿基础。
- `src/lib/__tests__/operation-history.test.ts` 与 `src-tauri/src/operation_history.rs`：启动/停止操作关联、标识和脱敏导出基础。

这些测试只证明现有静态转发可复用，不是动态 SOCKS 已验证。

### 准入前必须新增

| 层级 | 必需测试 |
| --- | --- |
| 协议解析 | RFC 1928 金色帧；分片/合并读取；IPv4/IPv6/域名；所有 CMD/ATYP/METHOD；截断、尾随、超长、Unicode/IDNA、零字节与随机模糊语料；拒绝 SOCKS4/BIND/UDP/auth |
| 目标策略 | 精确主机/IP/端口与边界值；大小写/尾点/IPv4-mapped IPv6；metadata/link-local/unspecified；域名重绑定与远端 DNS 决策；拒绝不记原始目标 |
| 资源上限 | 8 个转发、16/64 连接边界；慢速握手、半开、空闲、快速建连/断开；无无限线程/队列/缓冲；计数在错误和取消后归零 |
| SSH 安全 | 未知/不匹配 host-key 时不发送凭据；密码/私钥/跳板机；服务端禁止 forwarding；direct-tcpip 拒绝；SSH keepalive/transport 断开；错误不含秘密 |
| 失败与恢复 | 启动竞态、端口占用、每个解析/策略/建连/读写失败；停止/所有者关闭/应用退出/崩溃/升级时强制关闭全部子连接；手动 retry 新 operation ID，绝不重放流 |
| 版本 | v3→v4、v4 当前、较新版本、未知必需字段、超限策略、迁移写入故障、原子回滚与旧应用失败关闭 |
| 跨平台 E2E | Windows x86_64、macOS ARM 和隔离 SSH 服务上的浏览器/HTTP、数据库样例、非 HTTP TCP、跳板机、端口释放、休眠/网络切换、防火墙拒绝和退出清理 |

仓库当前没有 SOCKS 解析器、策略、资源故障测试、v4 夹具或两个正式平台的真实代理 E2E，自动化测试准入未满足。

## 复盘触发条件

1. 用户发现达到最小样本，并能证明受限动态 SOCKS 相对静态转发的可测量增量价值和必要性。
2. 目标/端口 allowlist、远端 DNS、回环监听、凭据/host-key、大小/并发/超时/重试上限通过独立安全评审。
3. 子连接登记与强制取消、失败关闭、手动恢复、v3→v4 升级及较新版本拒绝均有自动化故障证据。
4. Windows x86_64、macOS ARM 与隔离 SSH E2E 持续通过，并取得可量化 CI、内存/线程和维护成本。
5. 七项准入均为 `met`、`necessary: true`、`status: verified` 后，审计才可把 `protocolGates.implementationGate` 改为 `eligible`；这仍只允许独立评审最小候选基础，不自动实现或承诺发布。

在该复盘完成前，动态 SOCKS 保持唯一但未准入的研究对象；串口、Mosh 和其他协议不并行验证。

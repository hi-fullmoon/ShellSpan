# Windows sandbox 阶段 A 验收交接

日期：2026-10-07（Asia/Shanghai）。结果：**NO-GO，阶段 A 未完成验收；不得启动 B**。
设计：[首版设计](agent-shell-sandbox-windows-v1-design.md)。前序会话：`01a116f1-2d8e-7070-8a10-a2d38102f7f3`。

## 本次改动

新增 `tests/windows-sandbox-account/` 独立 Windows Rust crate、锁文件、运行脚本与说明。
未引用 PSEC/minifilter，未修改生产 Rust/TS/IPC/UI，生产 `verified()` 仍为 false。
新目录独立忽略 target，未手改现有依赖或生成文件，未 commit/tag/push。
修改设计仅记录本次原型结果和验证方案修正。原有大量未提交文件均保留。

实现了普通账户、单一 call restricting SID、DISABLE_MAX_PRIVILEGE、增量非继承 ACE、
NTFS/固定卷/祖先 reparse 拒绝、受保护自有 fixture、四层持久账户 SID ALE block、
WFP 事务、内存一次性凭据、调用拥有回执与正常失败清理。默认入口无系统副作用。
明确设置开关 `run.ps1 -RunOwnedFixture` 使用 RunAs/UAC，构建本身不提权。

检查 readOnly/workspace 的普通文件、外部 fixture、现有 .env.secret、根 .env.local、
.git、敏感对象 DELETE/WRITE_DAC、祖先 DELETE、父目录 DELETE_CHILD、构建产物创建重开。
这些文件检查在专用账户受限 Token impersonation 下执行，不能冒充完整进程验收。
网络使用自有 IPv4/IPv6 回环 TCP/UDP 接收端，并先做宿主正对照；同时记录 API 和接收端。

## 实机与测试证据

- `cargo test --locked --manifest-path tests/windows-sandbox-account/Cargo.toml`：2/2 通过，无忽略项。
  一项为权限掩码约束；另一项真实调用 Windows CreateRestrictedToken/AccessCheck，证明普通 SID
  与 restricting SID 必须双重允许、Everyone 不足以通过、显式 deny 有效。
- `cargo clippy --locked --manifest-path tests/windows-sandbox-account/Cargo.toml --all-targets -- -D warnings`：通过。
- 独立 crate 构建通过。默认实机入口退出 2：当前为 medium Token，未提升，不改系统。
- UAC 设置入口实际运行，退出 2。**27/32 通过，5 项失败**，不是跳过或 mock。
  原始脱敏结果：[JSON 回执副本](evidence/windows-stage-a-2026-10-07.json)。

失败项目：workspace 构建产物创建/重开；IPv4/IPv6 的回环 TCP 和 UDP 各一项。
TCP API 实际连接成功且接收端观察到连接；UDP Send 成功且接收端收到包。
不能以“有规则”或“API Send 行为”宣称网络已阻断。

## 设计调整与具体阻塞

1. 非继承 ACE 只证明现有对象访问，新对象权限尚未成立。构建检查使用真实创建并重开，
   当前失败记录未进一步区分创建与重开错误。下一轮必须分离错误码并验证父级继承与
   Token default DACL，设计可逐对象追踪/撤销的权限传播；不得放宽 restricting SID。
2. 网络 sockets 来自宿主主 Token 进程中的 impersonation 线程。因此接收端反例否定了
   该验证形态，不能当成专用账户 primary Token 的完整网络判定。必须实现真实受限主 Token
   子进程与身份查询后再验证 WFP，不能以 impersonation 代替命令运行。
3. 尚无私有桌面、PowerShell/Git/Node 最小启动权限、根/后代受限身份、宿主/broker/其他槽
   句柄反例、私网/入站/DNS/COM/RPC 服务代办、hardlink/ADS/短名称/链接竞争的证据。
4. 尚未实现完整敏感快照扫描/预算/次次派发刷新、已知宿主 HOME/钥匙串/存储对象矩阵。
   external.txt 是自有外部拒绝 fixture，不能代表宿主所有敏感对象。
5. 目前账户只在同一进程内一次性使用，密码未落盘。尚不是阶段 B 的受保护 credential reference、
   账户池、身份验证管道或 crash-safe object-identity journal。回执只是自有 fixture 实验入口。

上述不足阻止阶段 A 验收，不能把后续 B/C/D 的实现当作补齐 A 证据的理由。

## 本机拥有资源与清理

本次 fixture：`C:\ProgramData\ShellSpan-stage-A-c15557a4-e498-429c-892b-ca883fc0770b`。
原回执：该目录 `ownership.json`。账户：`SSPAc15557a4e498`，SID 与四个过滤器 GUID 见 JSON。
未创建任何沙箱 child/process Job 或服务；没有待证明终止的受限子进程。

回执 `cleanup_debt=[]`：正常流程禁用/删除自有账户、逐 SID 增量撤销 fixture ACE、
删除四个确切 WFP 过滤器均未返回错误。之后 `Get-LocalUser -Name SSPAc15557a4e498` 未找到账户。
WFP 证据是删除 API 返回成功，未追加独立过滤器枚举或重启核查；不得外推为 crash/reboot 恢复通过。

fixture 保留是明确的证据保留债务，未直接删除文件。为了普通宿主读取原始回执，另经 RunAs/UAC
对**该确切 ownership.json** 添加当前宿主 SID 的 Read ACE；它不授予实验账户或 restricting SID。
首次未提升 Get-Content/Get-Acl 尝试均被拒绝；该读取辅助只针对本次自有回执。
回执副本已保存仓库，无密码、Token/Job 句柄或秘密内容。

验收审阅后，通过项目回收站机制退役这一确切 fixture；不要按名称前缀批量删除任何资源。
当前代码在崩溃/激活窗口/ACL 对象替换/回执写入失败时仍可能留下清理债务，README 已列出限制。
不应无人值守重复运行或在企业策略冲突时放松配置。必要时管理员按受保护回执核对精确账户 SID、
过滤器键与对象后恢复；不能依据 PID、名称前缀或历史记录认领资源。

## 串行后续

**不创建阶段 B 会话。** 下一步仍是阶段 A：解决新对象权限、实现并验证真实 primary Token
子进程，然后补齐本阶段文件/敏感对象/网络负例。A 真正验收通过后才 list_projects/create_thread，
在 ShellSpan 本地项目创建 B，并传递设计、最新交接路径、前序会话 ID 和 A→B→C→D 串行要求；
不得并发修改此工作区。B/C/D 继续保持 unavailable，D 全部必要证据通过后最多 partial。

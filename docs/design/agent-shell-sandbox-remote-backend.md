# 远端执行后端契约（阶段 4）

2026-10-07：已接入真实 macOS SSH Seatbelt Direct、原生签名审批和进程控制。远端逐目标预检通过后才报告 `partial`；Host 始终表示账户访问未隔离。真实 Wry NativeAdapter 与重连证据见[阶段 4 记录](agent-shell-sandbox-phase-4-acceptance.md)。基础设施探测仍不打开 admission，不将 fixture 证据泛化为所有远端或完整阶段验收。

## 推荐实施路径与前置条件

沿用 `ssh2`、项目连接层、SFTP 和远端 `/usr/bin/sandbox-exec`。远端必须已有支持的 Python 解释器；静态控制脚本通过 SSH exec 进入已有解释器，不写入远端程序文件。控制请求、短期令牌和命令内容只经过加密 SSH stdin，不进入 argv、环境、审计或普通配置。标准库 JSON、subprocess、UnixStreamServer 负责控制，隔离由 Seatbelt 实施。本机隔离不证明 SSH 目标已受限。

远端组件均须预先存在。探测不运行安装器，不修改 sysctl、sudo、systemd、SSH 或 Docker 安全设置。组件安装、运行服务或增加系统权限不是能力探测的一部分；缺组件或权限时报告具体事实，再由用户独立授权。当前只读探测不启动 systemd 服务，也没有隐式远端安装流程。

## 冻结与授权

调用绑定 Agent 创建时间、bindingRevision、完整 profile/host/port/username、认证方式、跳板身份、主/跳板 credential reference、终端连接 generation、Database 掌管的配置 nonce、执行方式、策略及远端规范化根目录。凭据只在连接层加载，不写入模型、审计、结果或 child 环境。TEMP SQLite 触发器在产品 Database 同一连接的 INSERT/UPDATE/DELETE 中原子替换 nonce，不信 UI updated_at；删除重建和新连接产生新值。独立外部 SQLite 写入及恶意同账户宿主修改不在该保证内。

当前 `RemoteExecutionBinding` 在生产 NativeAdapter prepare 时捕获，在 execute 中签发能力前重读验证。连接 generation 由 SessionManager 在插入连接和连接状态变化时替换；同身份重连不能恢复旧审批。当前远端没有资源 grant，旧记录或基础设施探测结果不生成 grant。未迁移的 jump inline password/privateKeyData/passphrase 被拒绝，不在本阶段顺带迁移配置。

远端事实额外绑定真实 SSH host-key SHA256、SFTP root、远端 pwd UID/home、解释器及临时目录。固定公钥在 authenticate **之前**比较，不将旧密码交给新 peer。NativeEngine prepare 捕获原生 backend stamp，签发前复核，将 stamp 纳入能力 sandbox digest，并在派发时交叉检查；配置改回原值并重新 verify 也不能恢复旧 pending 或已签能力。相同 source/config 内事实保持不可变，hostkey 信任变化要求重连。受限跳板的双跳 pin 尚未验证，明确拒绝；Host 跳板继续原契约。

## 远端文件、网络与生命周期

目录只在远端通过 SFTP realpath/stat 规范化，home/UID 与远端 pwd 核对；本机 canonicalize、cwd 和 localRoot 不证明远端隔离。冻结 readAllow/writeAllow/deny 与实际 Seatbelt profile 同源并严格校验，远端路径用项目 POSIX helper。工作区仅增加冻结根写入，只读仅允许专用最小临时资源写入。账户私钥、凭据、钥匙串、整个应用支持目录（含生产/dev 标识）和项目敏感文件优先拒绝，项目根 .env.local 可读不可写。控制 socket/回执在 child 可写 work 目录之外。既有硬链接别名和同账户恶意修改仍是明确限制，不承诺对象隔离，不重试此前中止反例。

默认 deny network* 由远端 Seatbelt 对任意程序及 child 实施，不以 HTTP_PROXY 或本机隔离代替。远端网络/本地服务 grant 当前拒绝。TCP 目标只表示传输 host/port，不能推断 HTTPS 路径、TLS 内容或 HTTP 重定向验证。Host HTTP 保持目标 loopback 契约，受限 HTTP 不借 SSH forwarding 绕过。没有实施的范围不开放授权。

控制请求先以有界 JSON 行送入 SSH stdin；独立签名 ready 出现前暂存用户输入，避免 BufferedReader 抢读首段 stdin。原生 handle/owner 约束 stdin/wait/kill，并共享原有单向 ShutdownAdmission barrier/lease。控制器持有真实 Popen/process group，Native 从冻结 peer 的独立控制调用核对 HMAC 回执（jobId、根、命令/契约摘要、started、controllerFinished、group termination），确认后才移除自有目录。stdout、普通 exit code、PID/名字或 SSH close 不充当清理证据。source/config 变化停止旧受限作业；未知清理保留 uncertain/暂停，不 Host 回退、不自动重放。敌对后代逃离 group、崩溃和长期断网仍按证据说明，processLifecycle=false，不承诺完整后代控制。

当前 Host 使用独立 SSH exec channel。真实取消结果保持 `terminationConfirmed: false` 和 `terminationUnconfirmed`，不新增 root/sudo。正常退出码证明 channel 命令完成，不证明所有后台后代结束。

## 非 Shell 工具

`require_native_tool_boundary` 同时用于 Native prepare 和 execute；MCP prepare、签发及执行各有门禁。受限本地 Direct 只允许已接入的 Shell/所属进程控制和所属服务 HTTP probe。后者仍须核对活跃服务 socket、会话、任务、冻结授权及端口；工具名允许不替代这些检查。

受限远端仅允许已接入的 Exec/stdin/wait/kill。结构化文件、HTTP、SFTP/transfer、部署、运维和 MCP 不继承 Shell sandbox，继续拒绝宿主替代路径。项目文件资源读取只沿用已支持的本地入口，远端资源扩展不开放。用户直接操作 SFTP/部署页属于原有用户功能，不宣称受 Agent Shell 隔离。

## 当前环境与剩余验收

项目自有 `tests/agent-shell-sandbox-phase-4/Dockerfile` 在既有 OpenSSH 镜像中预装 bubblewrap 0.12.0。普通 Docker 配置下，远端账户真实启动得到 `No permissions to create a new namespace`。没有 privileged、cap-add、seccomp 变更或宿主 sysctl 修改。本环境可验收 Host SSH、身份/审批失效、SFTP 和 HTTP；不能验收受限远端文件、网络和清理边界。

Mac fixture 使用已有 OpenSSH，以普通账户、自己生成的临时密钥、严格 known_hosts、loopback 高端口和临时配置运行，不启用系统 SSH。已经完成真正 SSH+Seatbelt、NativeEngine 签名和 Wry 生产 NativeAdapter 的对应正常/拒绝/输入/取消/超时/断线/同身份重连检查。支持逐目标验证后的 macOS 普通账户直接 SSH、Direct、只读/工作区和默认网络拒绝；root、受限跳板、远端扩展 grant、其他系统保持拒绝。Windows 实机、真实一般部署、长期断线/崩溃残留、用户 UI/模型和并发场景，以阶段 4/5 对应记录为准，不提前勾选整体。

# 阶段 4：远程与非 Shell 工具一致性

2026-10-07。已实现并实测 macOS 普通账户、直接 SSH、Seatbelt Direct、原生签名审批/进程控制与身份失效。逐目标真实预检成功才开放 `partial`；未验证目标、不支持系统、root 账户、受限跳板和远端资源扩展不开放。Host 准确表示账户访问未隔离。整体阶段仍按下面范围与剩余项验收，不以探测或单个 fixture 代替全部要求。

## 当前交付

| 项目 | 实现与实际范围 |
| --- | --- |
| Host 事实 | 结果显示 host-account、冻结目标和 files/network/process 隔离 false；审批与取消保留。真实 cancel 后短时 PID 残留和自然退出已核对，仍报 terminationUnconfirmed。 |
| 真实远端后端 | 沿用成熟 SSH/SFTP、已有 Seatbelt 和解释器；无远端程序安装。远端 realpath/stat、pwd UID/home、主机密钥及规范化根绑定；实际 profile 消费冻结 readAllow/writeAllow/deny，网络默认由远端内核拒绝。 |
| 审批与失效 | NativeAdapter pending 绑定 source generation、主/跳板身份与 reference、Database nonce；NativeEngine prepare/issue/execute 交叉检查 backend stamp。配置和 timestamp 改回、删除重建、再 verify、真实同身份重连均不恢复旧 pending/已签能力。 |
| 生命周期 | 原有句柄 stdin/wait/kill；控制请求/token 经 SSH stdin，签名 ready 前队列暂存用户输入；独立控制回执证实 controller/group cleanup 后清理自有目录。未知清理继续暂停，共享退出 admission barrier。 |
| 非 Shell 一致性 | prepare/execute/MCP issuance 均检查实际边界；受限远端 file/HTTP/SFTP/部署/运维/MCP 拒绝，不作为宿主绕行。Host HTTP 修复共享阻塞 SSH session 的双向死锁，专用有界非阻塞桥保留一般端口转发行为。 |
| 首次选择接口 | typed target-only verify 返回完整 target、policy、Direct、canonicalRoot、UID、host-key SHA256、source binding digest 与真实 capability；不创建持久 Agent、不切 Host、不签 grant。UI 接入和最终显示由阶段 3 对应验收核对。 |

## 实际证据

首轮部分测试 stdout 没有 redirect：以下仓库 `.log` 明确保存原始工具输出摘录及 unified-exec chunk 来源，不冒充当时已存在的原始文件。后续专项直接将完整 stdout/stderr 落盘。

| 证据 | 结果 | 可以证明的范围 |
| --- | --- | --- |
| `tests/agent-shell-sandbox-phase-4/evidence/ssh-binding-native-output.log` | 2 passed | 真 SSH shell 的同身份重连、主/跳板 reference、inline secret 拒绝、后端配置 nonce 改回/删除重建/新 DB 生命周期；Host 实际审批/Direct cancel、独立 PID 残留观察与自然退出，源输入 0。 |
| `tests/agent-shell-sandbox-phase-4/evidence/ssh-http-native-output.log` | 1 passed | Host 实际 SSH forwarding 到目标 loopback HTTP，响应 200、原工具范围保持。 |
| `tests/agent-shell-sandbox-phase-4/evidence/ssh-duplex-native-output.log` | 1 passed | 2 MiB 实际双向精确字节、half-close/EOF、真实背压下 cancel/totaldeadline、worker is_finished 与 join；不是 HTTP/SOCKS 自制解析。 |
| `/tmp/shellspan-phase4-macos-controller-stdin.log` | 检查通过 | 自有普通 OpenSSH CLI + Seatbelt project RW、外部 marker 拒读/写、live loopback 对照拒绝；固定 controller selftest、取消、HMAC 回执与自有目录清理。不是生产 NativeAdapter 或 LLM。 |
| `/tmp/shellspan-phase4-macos-native-lower.log` | 1 passed | 真 SSH PTY 源、SFTP alias 的实际 canonical root、ready 前原生 stdin 队列、持久 project 写入、frozen .env marker 拒读、cancel/timeout/own cleanup、shutdown 后未派发，源 PTY 输入 0。 |
| `/tmp/shellspan-phase4-macos-native-engine.log` | 1 passed | 原生 HMAC 能力审批、实际 SSH 受限持久写/读、partial/result facts、非 Shell 拒绝、保留 timestamp 改回并 reverify 后旧已签 cap 仍拒且无副作用文件、target mismatch，源输入 0。 |
| `/tmp/shellspan-phase4-wry-a0csD1/remote-check.json` | passed=true | 实际 Wry、生产安装的 NativeSlot/NativeAdapter、共享 engine/session/profile；未批拒、真实批后执行/持久结果、后台 stdin、kill/cleanup、断线旧审批拒、源 SSH PTY 0。无 LLM 或 UI 渲染声明。 |
| `/tmp/shellspan-phase4-wry-reconnect-DbUTIz/remote-check.json` | passed=true | 上述生产链加同身份真实 SSH PTY 重连；断线 token 与未消费 reconnect token 分别拒，新冻结调用正常。 |
| `/tmp/shellspan-phase4-hostkey-pin.log` | 1 passed | 自有 sshd 真换 host key，自己的 known_hosts 更新；旧冻结 SHA 在 authenticate 前拒，server Accepted publickey 计数不增；Host 原 wrapper 可对新可信 key 正常认证。 |

NativeTool boundary/真正 restricted MCP prepare 回归 2 passed；早期相关前端/协议 31 passed、pnpm build 与 Rust includes 通过。后续变更的最终 DB/协议/全仓与 UI 结果由正在运行的收尾检查更新，不将历史结果当最新全部回归。

## 支持矩阵与限度

| 目标 | 状态 |
| --- | --- |
| 实测普通账户 macOS SSH Direct | 文件/默认网络限制与正常进程控制已接入；每个实际 target 真实预检后 partial。 |
| SSH Host | 未隔离，维持现有账户与工具独立契约；channel close 不证明远端进程树清理。 |
| 普通 Docker OpenSSH + bubblewrap 0.12.0 | bwrap namespace 真实权限不足，launcherAvailable=false、admission=false；没有提升 Docker/宿主权限。可提供 Host/HTTP/身份 fixture 证据。 |
| root、restricted jump、其他远端系统 | 未验证/不支持，拒绝，不静默转 Host、不去掉 jump 直连。 |
| Windows 桌面实机 | 用户后续提供；本次不能声称已实测。远端 POSIX helper 已独立于桌面分隔符。 |
| 远端资源读取/缓存/网络/本地服务 grant | 未开放；请求明确 unsupported，不借结构化工具扩权。 |

partial 明确保留硬链接别名、宿主同账户恶意并发、敌对后代逃离 process group 等限制。没有重试旧安全审查中止的反例。临时控制 token 不进入 argv/env/state/config/model/log；回执只保存签名与非敏感事实，不是可恢复 bearer grant。

## 未覆盖或仍在收尾

- 阶段 3 的实际用户入口、双语 capability gap、首次 remote root 选择与 source 变更后的 UI stale-result 清理，须在真实显示验证后计入产品闭环。
- 普通真实部署完整业务场景（artifact upload/hash/start/version HTTP/update/owned cleanup），不以普通文件写入代替；只允许项目自有 fixture，用户服务器安装/权限改变仍需独立授权。
- 长时间物理断网、应用强制崩溃后远端作业/临时资源、多个并发远端会话的最终残留与恢复清理，不从正常 cancel 或 SSH EOF 推断通过。当前控制器有自己的 deadline；receipt 不可确认时保持 uncertain/暂停，不恢复 grant、不重放。
- 未实测 Windows、其他远端成熟后端与双跳认证前 pin。

未创建 commit/tag/push。没有启用系统 Remote Login、操控认证窗口、改钥匙串 ACL、FDA/root/ES/helper、安装用户服务器组件或改 Docker 安全策略。自有 Mac fixture 使用自己的临时 RSA key 与严格 peer trust；Wry 已退出并清理本次 unique native credential reference，用户数据库及 LLM 凭据未读写。

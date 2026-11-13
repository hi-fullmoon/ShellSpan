# ZLE SSH 故障恢复实机交接清单

2026-11-12。Linux SSH/SFTP 本批已恢复，隔离传输回归 17/17、五个无模型 ZLE SSH 实机用例 5/5。逐案签名、原始证据、失败复验和清理见 [实机报告](../../.artifacts/tests/agent-terminal-input/20261112-zle-ssh-live/REPORT.md)。Windows 继续暂停，严格 Unicode 模型子项继续延期，完整远端 E08 留到正式发布前。前序资源构建、Bash 七项及原始结论见 [Linux SSH/SFTP 原交接](../../.artifacts/tests/agent-terminal-input/20261112-linux-ssh-offline-5346f103/REPORT.md)。本清单使用 [统一验收标准](agent-terminal-input-acceptance-checklist.md) 的 C01、C05、C06、D05、D06、E01、E07 编号。

本机续验通过接受键前后独立控制 EOF 4/4、真实 App 崩溃及同数据根重启 4/4。固定 ZLE Main/Core、模块、relay 的 SFTP 及进程映射均有实载证据。`ssh-recovery.mjs --list-cases` 列出无模型子案。Bash 5.3 使用独立 GNU 夹具和 `--bash`，ZLE 使用固定 Debian Main。各案单独创建夹具和数据目录，同一崩溃案使用原数据目录重启。 [双 Shell 本批报告](../../.artifacts/tests/agent-terminal-input/20261112-local-ssh-closeout/REPORT.md) · [逐案回执](../../.artifacts/tests/agent-terminal-input/20261112-local-ssh-closeout/attempts.json) · [余项清单](../../.artifacts/tests/agent-terminal-input/20261112-local-ssh-closeout/CHECKLIST.md)

ZLE 启动读取 OpenSSH 执行父进程的初始 `ZDOTDIR`。未设置和显式指定均从真实 PTY 验证了 `.zshenv`、`.zprofile`、`.zshrc` 顺序。签名 App 的五项 ZLE 历史、无 SFTP、未知 Main、后台作业和真实文件链均通过。人工系统复制、焦点、实际接管和 E06 继续独立取证。 [启动对照](../../.artifacts/tests/agent-terminal-input/20261113-zle-ssh-startup-transport/REPORT.md) · [候选 17 的显示和质量](../../.artifacts/tests/agent-terminal-input/20261113-ram-signing-preflight/REPORT.md)

候选 37 因重新构建后 Linux 模块摘要变化，用新夹具复验了实际 Zsh Main、Core、模块与 relay，四代重绑、接受前后控制 EOF、实际 App 崩溃及同数据根重启、WKWebView 与错误资源拒绝均通过。每次运行记录实际加载对象和 SFTP 回执。候选 39 隔离 SSH/SFTP 回归 17/17。 [当前回执](../../.artifacts/tests/agent-terminal-input/20261113-candidate20-local-resumption/REPORT.md) · [逐案台账](../../.artifacts/tests/agent-terminal-input/20261112-local-ssh-closeout/attempts.json)

候选 19 已完成 ZLE 本地正常提交及双 Shell 本地接受键前、后的实际 App 崩溃和同数据目录重启。Docker 恢复后已核验旧 Bash 夹具停止和 `61644` 释放。新回环夹具通过双 Shell 的接受键前显式取消、复杂源码及错误资源摘要拒绝，隔离传输再次通过 17/17。 [签名 App 和逐案回执](../../.artifacts/tests/agent-terminal-input/20261112-local-ssh-closeout/REPORT.md) · [本机续验](../../.artifacts/tests/agent-terminal-input/20261113-candidate20-local-resumption/REPORT.md)

## 源码和 Linux 资源

- 客户端基线为 `2e76d274ece38b3ace2a86c68bb8b00f508273a0`，基线树 `fed8380cd33309587c5f7d086112880f08fe745c`。本轮入口为该基线上的未提交变更。逐文件摘要、变更补丁及验证日志见 [本轮离线报告](../../.artifacts/tests/agent-terminal-input/20261112-zle-ssh-recovery-offline-2e76d274/REPORT.md)。恢复时冻结包含本轮变更的候选，从新封存根构建带 `native-input-acceptance` 的 macOS arm64 验收 App。
- 既有 Linux 资源由 `5346f10392b442bad326e50ddc8b2d6fed83507b` 产出。锁、配方、Bash/ZLE catalogue 的 60 个不同生产输入均与当前基线及工作区逐字节匹配，原批 `SHA256SUMS` 逐项校验通过。本轮可复用该 Linux 资源。固定平台为 Linux aarch64、glibc 2.36，Debian 账号的 `/usr/bin/zsh` 与 `/bin/zsh` 指向同一个固定 Main。恢复时仍须核对 App 所用候选、真实 Main、Core、模块和 relay 的绑定与加载。[本轮资源核对](../../.artifacts/tests/agent-terminal-input/20261112-zle-ssh-recovery-offline-2e76d274/linux-inputs.log)

| ZLE 资源 | SHA-256 |
| --- | --- |
| 固定 Zsh 5.9 Main | `1ebc9b7012541bdc45fe8cbb9f752c0dc49aeb47dea0fd76d755639e7554e6d3` |
| 私有 ZLE 5.9 Core `zle.so` | `c9e451bd49ad6481872af4a0b069719abc5083e7c2a03c8973b2d5e718186404` |
| `ss_nip.so` | `6274f470e23c9f5698f141ee2b40a607d9ffdfb352f20b333a3f7f836a8cbf18` |
| `native-input-relay` | `d05c9e24a61ba132721354816f1da71c183fde40f39e5ebc88ce6a694bbb2953` |
| ZLE catalogue | `16281e14e5680d7c3290c8072afd48bae6cef32258d25b03c26a0b926a0481cf` |

## 恢复后的执行顺序

1. 从新封存根核对源码索引、App 数据路径和本批 macOS 资源。在新根的 `.artifacts/tests/native-input-p2/resources/native-input/` 放入摘要匹配的 macOS 和 Linux catalogue 与对应资源。沿用原交接的资源暂存和 A01–A06 步骤。检查冻结源码和 App 启动记录后，先做隔离 SSH/SFTP 传输回归。
2. 按下表顺序串行运行 ZLE 无模型 App 用例。每案新建一个 `linux-peer --app` 夹具和一个独立数据目录。前台时段内设置 `SHELLSPAN_ALLOW_FOREGROUND_TESTS=1`。每案完成后核对该案的 SQLite 账本、远端文件、应用退出和清理回执，再开始下一案。失败或证据不足时保留原记录，查明阻塞后用新夹具和新身份复验。
3. 从本批台账核对 Bash 生命周期、原生作业和文件链、双 Shell 控制 EOF、App 崩溃重启及显示矩阵。按余项清单补齐控制切点和人工检查。ZLE 实际模型 `jobs` 和模型文件链在另行授权的时段使用新夹具。

离线可随时查看全部或单项。`--check-fixture` 只读取本地封存路径下的 `owner.json` 与 `fixture.json`，无需运行 Docker。实机入口再核对容器实际标签、镜像、源码挂载、回环端口、sshd 公钥、账户 Shell、平台、glibc 和 Main 摘要。App 使用同一公钥的指纹进行正常 SSH 主机信任校验。

```bash
node scripts/native-input-p3/ssh-recovery.mjs --list-cases
node scripts/native-input-p3/ssh-recovery.mjs --list-cases --case after-key-timeout
```

恢复授权后，在封存根定义以下命令。函数每次都创建新夹具，且须从该封存根运行。实机入口将空模型路由、正常审批、真实 relay、PTY、账本和终端重绑绑定到同一批次。

```bash
export SHELLSPAN_P3_LINUX_IMAGE=sha256:2b6f2533e0a616f729bcf070ee759c4359975f011a5460df947f339613a7dae8
sealed_root="$PWD"
zle_ssh_case() {
  local fixture
  fixture=$(node scripts/native-input-p3/linux-peer.mjs "$sealed_root" --app) || return
  printf '%s\n' "$fixture"
  node scripts/native-input-p3/ssh-recovery.mjs --check-fixture --fixture "$fixture" || return
  SHELLSPAN_ALLOW_FOREGROUND_TESTS=1 node scripts/native-input-p3/ssh-recovery.mjs \
    --case "$1" --fixture "$fixture"
}
```

| 顺序与命令 | 故障切点 | 账本、文件和旧流取证 |
| --- | --- | --- |
| 1. `zle_ssh_case reconnect-tail` | 旧 ZLE PTY 写出半 OSC 后等待。绑定新 native 代次并收到首个标记后才放行旧 PTY 的后半段及尾包。第二代次写出半 UTF-8 后自然关闭，再走 raw → native。 | 旧 PTY 的半 OSC 先解析，重绑发送标准 ST，随后新代次解析自身输出。独立真实 SSH 读流中留旧尾包，控制器屏幕、输入和门禁快照保持新代次，旧 transport 写入被拒。UTF-8 的 `e2 82` 先读，SSH 解码器于关闭前排空为 `U+FFFD`。屏幕保留历史。账本零行，效果文件缺席。 |
| 2. `zle_ssh_case before-key-timeout` | 完整证明、FULL 持久意图及武装后，在唯一接受键前等实际 5 秒期限。 | 接受键写入尝试与 peer 接受均为 0，效果文件缺席。身份匹配的真实 `DraftCleared` 结算这一条未提交意图。释放已清稿操作后送普通 Enter，再验证仍无文件效果。 |
| 3. `zle_ssh_case before-key-disconnect` | 同一接受键前切点，重置回环转发器持有的旧 SSH 套接字，确认 Broker 已看到真实关闭再释放切点。 | 接受键尝试、peer 接受及效果均为 0。缺少真实清稿，保留原意图及 `noAutoReplay`，SQLite `settled=0`。旧 transport 拒绝输入。 |
| 4. `zle_ssh_case after-key-timeout` | 唯一接受键实际写入后，在真正的 `SubmissionAccepted` 进入协调器前保留原回执，等实际期限。 | 原操作未知并保留输入门禁、同一持久意图、原调用与文件引用，恢复请求被拒。允许迟到真实回执继续流转，在 `Settled` 前核对 `Started` 只增加执行事实、Enter 仍阻止且账本未结算。仅放行绑定同一终端代次、操作身份和 Prepare 请求的真实 `Settled`，SQLite 最终 `settled=1`。一次接受键、一次 peer 接受，文件仅含一行调用 UUID。 |
| 5. `zle_ssh_case after-key-disconnect` | 唯一接受键从真实 SSH channel 写回成功后，重置旧套接字。源命令在追加文件后以 `exec /bin/sleep 30` 替换原 Shell。关闭观察窗口为 50 秒，覆盖 30 秒保活和 15 秒 I/O 期限。 | 只有一次接受键写入，peer 接受及文件效果至多一次。原调用恢复状态为 `executionInFlight/required`，SQLite `settled=0` 且 `noAutoReplay=true`。新 transport 不继承原输入门禁，原调用不能恢复为重放。 |

四个提交案都重新连接同一逻辑终端，检查 transport ID 变化、代次恰好加一、旧写入拒绝、`SSH_RECOVERY_OK` 从新 PTY 输出，以及原账本和远端效果未被重连更改。错误身份和旧代次的拒绝以组件回归单列，实机保留真实 peer 回执。双 Shell 的 App 进程崩溃重启和控制 EOF 已有独立切点记录。 [本批故障记录](../../.artifacts/tests/agent-terminal-input/20261112-local-ssh-closeout/REPORT.md)

原模型作业入口在其授权时段单独运行。

```bash
zle_fixture=$(node scripts/native-input-p3/linux-peer.mjs "$sealed_root" --app)
SHELLSPAN_ALLOW_FOREGROUND_TESTS=1 SHELLSPAN_P3_CASE=jobs \
  SHELLSPAN_P3_SSH_FIXTURE="$zle_fixture" node scripts/native-input-p3/app.mjs
```

## 留档和清理

- 单案目录为 `.artifacts/tests/native-input-p2/ssh-recovery/<fixture UUID>/`。保留 `inputs.json`、冻结源码和已签名 App 身份、逐阶段 `.command.json` / `.log` / `.exit.json`、`native-webview-evidence.json`、`native-p3-progress-*.json`、原始 `native-control-trace-*.jsonl`、接受键切点、旧套接字断开或尾包放行回执、`ledger-after-app.json`、`effect-after-app.json` 和 `result.json`。发布验收台账使用实际断言与这些原始证据。失败记录保留实际阶段、退出码、最后 Broker 快照、原调用及相关 PTY 字节。
- 入口按正常 API 关闭自己的终端、撤除并核对专属 CredentialRef，再确认容器归属、锁账号和停止容器。保留容器、数据目录、原意图及文件效果。若准备阶段中断且未进入自动清理，从夹具 `owner.json` / `fixture.json` 核对完整容器 ID、镜像 ID、回环映射和 `shellspan.native-input-p2=<UUID>`，确认没有该案运行中的 App、PTY 和转发器，再仅处理该夹具。参考 `credential-cleanup-command.json` 与本案输入中的引用，通过初始化入口执行 `--native-input-p2-credential cleanup`，经 stdin 传 `{"reference":"<本案引用>"}`，验证返回 0。只对已确认归属的容器执行 `docker exec "$container" usermod -L nativeZle` 与 `docker stop --timeout 5 "$container"`，记录 `.State.Running=false`。有仍运行或结果不明的原操作时保留账本和文件引用。密钥和密码不入档。

# 双 Shell SSH 故障恢复验收

本页覆盖[统一验收标准](agent-terminal-input-acceptance-checklist.md)中的 C01、C05、C06、D05、D06、E01、E07。旧回环批次与正式发布余项见[实施计划](agent-terminal-input-implementation-plan.md)。

## 源码和 Linux 资源

- 在冻结候选上构建带 `native-input-acceptance` 的 macOS arm64 验收 App。Linux 资源沿用 [构建入口](../../scripts/native-input/acceptance/linux-build.sh)，按本批清单核对镜像 ID、实际 Main、Core、模块、relay 及其摘要。ZLE 使用 Linux aarch64、glibc 2.36 的 Debian 夹具，Bash 5.3 用独立 GNU 夹具，加 `--bash`。

## 恢复后的执行顺序

1. 从新封存根核对源码索引、App 数据路径和本批 macOS 资源。在新根的 `artifacts/tests/native-input/integration/resources/native-input/` 放入摘要匹配的 macOS 和 Linux catalogue 与对应资源。按统一清单完成 A01–A06，检查冻结源码和 App 启动记录后，先做隔离 SSH/SFTP 传输回归。
2. 按下表顺序串行运行 ZLE 无模型 App 用例。每案新建一个 `linux-peer --app` 夹具和一个独立数据目录。前台时段内设置 `SHELLSPAN_ALLOW_FOREGROUND_TESTS=1`。每案完成后核对该案的 SQLite 账本、远端文件、应用退出和清理回执，再开始下一案。失败或证据不足时保留原记录，查明阻塞后用新夹具和新身份复验。
3. 从本批台账核对 Bash 生命周期、原生作业和文件链、双 Shell 控制 EOF、App 崩溃重启及显示矩阵。按余项清单补齐控制切点和人工检查。ZLE 实际模型 `jobs` 和模型文件链在另行授权的时段使用新夹具。

离线可随时查看全部或单项。`--check-fixture` 只读取本地封存路径下的 `owner.json` 与 `fixture.json`，无需运行 Docker。实机入口再核对容器实际标签、镜像、源码挂载、回环端口、sshd 公钥、账户 Shell、平台、glibc 和 Main 摘要。App 使用同一公钥的指纹进行正常 SSH 主机信任校验。

```bash
node scripts/native-input/acceptance/ssh-recovery.mjs --list-cases
node scripts/native-input/acceptance/ssh-recovery.mjs --list-cases --case after-key-timeout
```

恢复授权后，在封存根定义以下命令。函数每次都创建新夹具，且须从该封存根运行。实机入口将空模型路由、正常审批、真实 relay、PTY、账本和终端重绑绑定到同一批次。

```bash
: "${SHELLSPAN_P3_LINUX_IMAGE:?Set the image ID recorded for this batch}"
export SHELLSPAN_P3_LINUX_IMAGE
sealed_root="$PWD"
zle_ssh_case() {
  local fixture
  fixture=$(node scripts/native-input/acceptance/linux-peer.mjs "$sealed_root" --app) || return
  printf '%s\n' "$fixture"
  node scripts/native-input/acceptance/ssh-recovery.mjs --check-fixture --fixture "$fixture" || return
  SHELLSPAN_ALLOW_FOREGROUND_TESTS=1 node scripts/native-input/acceptance/ssh-recovery.mjs \
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

四个提交案都重新连接同一逻辑终端，检查 transport ID 变化、代次恰好加一、旧写入拒绝、`SSH_RECOVERY_OK` 从新 PTY 输出，以及原账本和远端效果未被重连更改。错误身份和旧代次的拒绝以组件回归单列，实机保留真实 peer 回执。崩溃案使用本案原数据根重启；真实模型复验使用新夹具、新数据根和 Agent 会话，由操作者在 App 实际审批面板决定。

## 留档和清理

- 单案目录为 `artifacts/tests/native-input/integration/ssh-recovery/<fixture UUID>/`。保留 `inputs.json`、冻结源码和已签名 App 身份、逐阶段 `.command.json` / `.log` / `.exit.json`、`native-webview-evidence.json`、`native-p3-progress-*.json`、原始 `native-control-trace-*.jsonl`、接受键切点、旧套接字断开或尾包放行回执、`ledger-after-app.json`、`effect-after-app.json` 和 `result.json`。发布验收台账使用实际断言与这些原始证据。失败记录保留实际阶段、退出码、最后 Broker 快照、原调用及相关 PTY 字节。
- 入口按正常 API 关闭自己的终端、撤除并核对专属 CredentialRef，再确认容器归属、锁账号和停止容器。保留容器、数据目录、原意图及文件效果。若准备阶段中断且未进入自动清理，从夹具 `owner.json` / `fixture.json` 核对完整容器 ID、镜像 ID、回环映射和 `shellspan.native-input-p2=<UUID>`，确认没有该案运行中的 App、PTY 和转发器，再仅处理该夹具。参考 `credential-cleanup-command.json` 与本案输入中的引用，通过初始化入口执行 `--native-input-p2-credential cleanup`，经 stdin 传 `{"reference":"<本案引用>"}`，验证返回 0。只对已确认归属的容器执行 `docker exec "$container" usermod -L nativeZle` 与 `docker stop --timeout 5 "$container"`，记录 `.State.Running=false`。有仍运行或结果不明的原操作时保留账本和文件引用。密钥和密码不入档。

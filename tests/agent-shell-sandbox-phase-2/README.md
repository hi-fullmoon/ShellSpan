# 阶段 2 真实后端实验

历史候选实验不是生产沙箱、同步实现或阶段 2 完成证明；反例通过表示缺口被复现。历史反例与容器实验只使用专用资源，不读取真实凭据。新增原生模型验收经用户授权使用开发版默认 MiniMax-M3 的既有凭据引用，规则见下节；不修改用户数据库、凭据、现有项目或服务器。

## 真实模型与原生 Direct 验收

仅在用户明确选择并允许调用开发版当前默认 MiniMax-M3 后运行。`--native-agent-check` 为 macOS debug-only 入口，用真实 Wry App、LLM runtime、NativeAdapter、Session store 和 PTY，不使用模型响应替身；不重复 GUI 生命周期测试。输入目录必须已存在、为绝对路径且为空。只读查询开发版数据库的 routes 文档，复制该非敏感文档到独立数据库；凭据管理器只允许读取所选默认模型的既有钥匙串引用，禁止写入、删除及 SSH/MCP/其他模型凭据访问。凭据不进入 Shell 环境或报告。

```bash
cargo build --manifest-path src-tauri/Cargo.toml
mktemp -d /tmp/shellspan-real-model-XXXXXX
# Use the exact directory returned above:
src-tauri/target/debug/ShellSpan --native-agent-check EMPTY_DIRECTORY normal
```

normal 只批准固定项目文件写入/读取命令；检查真实文件、Seatbelt tool result、两次模型请求、completed turn 和源 PTY 零写入。cancel 使用另一个新目录、参数 `cancel`；只批准固定 `sleep 30` 后台请求，随后通过生产会话取消入口停止进程，核对捕获的真实进程句柄为 cancelled/terminationConfirmed，且会话结束。其他模型操作拒绝，不据模型文本伪造结果。未知或失败的回合保留日志与失败报告，不自动重放；release/其他平台拒绝该入口。

2026-10-06 两项均通过，报告分别为 `/tmp/shellspan-real-model-y2xHvP/model-check.json` 与 `/tmp/shellspan-real-cancel-VOz6up/model-check.json`。这些结果不开放资源扩展授权，也不代表完整对象隔离或 Windows 验收通过。

历史反例脚本已保留为证据，续行不重试或扩展它们。普通软件功能验证只运行新增 Rust 控制器测试，使用已存在的专用本地镜像，不启动宿主共享目录或进行攻击测试：

```bash
SHELLSPAN_CONTAINER_TEST_IMAGE=sha256:4bb13341f79d2ef8750db781b7c04bf64b85f08a73f88ad913eeba2b1c18f8ae cargo test --manifest-path src-tauri/Cargo.toml agent_runtime::native::container_backend::tests -- --include-ignored --skip container_process_crash_child --quiet
cargo test --manifest-path src-tauri/Cargo.toml agent_runtime::native::process::tests -- --skip operator_workspace --quiet
cargo test --manifest-path src-tauri/Cargo.toml sandbox -- --skip operator_workspace --quiet
```

镜像缺失就拒绝，不自动重建、拉取或切换无限制执行。以下其余章节记录早期实验的历史可重复方法，不属于续行常规测试清单。

新增拥有记录测试使用真正的系统钥匙串、SQLite 和 Engine，创建唯一测试凭据并在验证后删除，不使用内存凭据替身。未确认的创建状态只验证债务保留，不被算作“没有资源”的成功。Node 项目测试已命名为 `sum.node-check.mjs`，仍由包内 `node --test` 执行；可用 `pnpm --dir tests/agent-shell-sandbox-phase-2/projects/node test` 单独验证，不再被 Vitest 收集。

## 当前系统的普通兼容性验证

隔离原生 GUI 退出/重启使用 debug 构建的 `--gui-lifecycle-check` 入口，复用生产 `app_exit::handle_event`。测试窗口和 app directories 均指向新建 fixture 根目录，WebView 使用 incognito/about:blank；不加载用户现有数据库、共享凭据 vault、终端、LLM 或 Docker 资源。活动场景只用真实 native store 的专用测试凭据、实际创建的 Session header 和自身容器。release 构建拒绝此入口，不回退到用户应用启动。

```bash
cargo build --manifest-path src-tauri/Cargo.toml
SHELLSPAN_CONTAINER_TEST_IMAGE=sha256:4bb13341f79d2ef8750db781b7c04bf64b85f08a73f88ad913eeba2b1c18f8ae python3 tests/agent-shell-sandbox-phase-2/verify_gui_lifecycle.py src-tauri/target/debug/ShellSpan /tmp/shellspan-gui-lifecycle-results.json
```

验证实际 ExitRequested/Exit 事件、重复退出幂等及 restart 后的新 PID，再核对新进程正常退出。5 个场景覆盖空资源退出/重启、活动自身容器退出/重启、持久清理债务退出。活动资源通过实际创建回执及 Engine 查询验证移除；债务停在真实准备发送持久点，不发出 create 请求，验证 uncertain 债务不会因 404 遗忘，不伪造执行成功。债务 fixture 目录及其专用 key 保留供复核，其余确认完成的测试凭据和目录清理。此验收不加载整个主工作台或执行模型任务，不能推断受限执行已可用。

进程恢复新增用例实际创建辅助进程、保存容器回执、强制结束该辅助进程，然后由新的协调器读取持久记录并清理；不是 GUI 应用退出的桌面验收。辅助用例 `container_process_crash_child` 只由父用例以完整过滤名启动，不能脱离指定私有 fixture root 手动当普通用例运行。多会话用例实际并发创建两只容器，停止一只后另一只仍接收 stdin 并完成。

完整项目兼容性使用 `prepare_build_compat.py` 为当前 Git 列出的源码、构建配置和测试输入生成独立快照，保存逐文件摘要。它只服务于受信当前代码的普通编译测试，拒绝的链接预检不构成已验证的安全导入；不允许将此脚本接入 Agent 工作区授权或宿主回写。

```bash
python3 tests/agent-shell-sandbox-phase-2/prepare_build_compat.py /tmp/shellspan-build-compat-new
docker build --pull=false -t shellspan-build-compat:local /tmp/shellspan-build-compat-new
docker image inspect shellspan-build-compat:local --format '{{.Id}}'
# Pass that immutable ID to the compatibility runner:
python3 tests/agent-shell-sandbox-phase-2/verify_build_compat.py IMAGE_ID /tmp/shellspan-build-compat.log
```

镜像准备阶段下载明确的公开工具/依赖；执行阶段为 network none、无宿主挂载、只读系统镜像、UID 1000、固定清理环境。项目和缓存使用本轮专用 Docker 本地卷，避免 tmpfs 编译产物挤占 VM 内存；运行前离线安装锁定依赖。执行 pnpm build、全范围前端测试、cargo 离线构建及常规 Rust 测试；仍明确跳过原四项边界实验。资源调优仅设置编译并行数和调试符号，不修改断言或功能逻辑。当前 Linux 环境不替代 macOS 原生、Windows 原生或 Linux 发行版 runner；GUI、授权与完整沙箱边界也不由此推断通过。

## Docker Desktop 上的 Linux 候选

```bash
docker build -t shellspan-sandbox-phase2:local tests/agent-shell-sandbox-phase-2
/usr/bin/python3 tests/agent-shell-sandbox-phase-2/prepare_seccomp.py /tmp/shellspan-phase2-seccomp.json 2ceae35d351c156cb5a8efc0fdc4a08cf94569d8
SANDBOX_SECCOMP_PROFILE=/tmp/shellspan-phase2-seccomp.json /usr/bin/python3 tests/agent-shell-sandbox-phase-2/verify_container.py
```

Moby 原策略 SHA-256：`6416b47770785a41ac59073cdc77d9fe98517df2799dc83ef207e622de3053f6`。衍生策略：`7f9a563a95da48d63ef2abf4e0610f9ae1bae8cb4ad9f7ce3808214412a21307`。JSON 由标准解析器读取；只移除网络与 io_uring 的允许规则，保留其余上游默认拒绝规则。网络授权、代理和本地服务不在本实验中开放。socketpair 仅用于私有进程通信。

容器的 `/workspace`、`/tmp`、`/cache` 是三个专用 tmpfs，不挂载宿主项目、HOME、Docker socket 或 SSH agent。项目和临时目录允许执行生成的程序；缓存保留 noexec。独立文件系统用例从镜像内的真实小项目复制，运行 pnpm 的语法检查、Node 测试及 cargo 离线编译、测试。它们不能替代 ShellSpan 完整构建或原宿主工具链兼容性验收。

反例用例有明确例外：两个共享目录测试仅挂载测试自行创建的标记目录；导入反例使用可写 intake 容器根目录，证明 `docker cp` 不会判断宿主硬链接对象是否允许读取。它们绝不能作为生产配置。普通 candidate 一律只读根文件系统。

## 原生 macOS 候选

将研究运行器安装到新临时目录，禁止全局安装和执行安装脚本：

```bash
sandbox_review_dir=$(mktemp -d /tmp/shellspan-srt-review.XXXXXX)
npm install --prefix "$sandbox_review_dir" --ignore-scripts --no-audit --no-fund @anthropic-ai/sandbox-runtime@0.0.78
SANDBOX_SRT_BIN="$sandbox_review_dir/node_modules/.bin/srt" /usr/bin/python3 tests/agent-shell-sandbox-phase-2/verify_native.py
SANDBOX_SRT_BIN="$sandbox_review_dir/node_modules/.bin/srt" /usr/bin/python3 tests/agent-shell-sandbox-phase-2/verify_volume.py
```

第二项仅挂载新建的 128 MiB APFS 稀疏映像，finally 卸载后清理临时文件；不迁移真实项目、不修改安全配置。它证明跨文件系统硬链接被 EXDEV 拒绝，同时复现项目内敏感文件别名绕过；因此专用卷也尚未通过门禁。

## 回写反例

```bash
/usr/bin/python3 tests/agent-shell-sandbox-phase-2/verify_writeback.py
```

证明普通复制覆盖会修改外部硬链接对象；已经打开的目录描述符也不会阻止宿主把该目录移出原项目路径。测试不是生产导出器。

# EXPLORE 便携性候选准入评估

> 基线：`052cb09`
> 审核日期：2026-08-23
> 范围：Linux x86_64 正式发行，以及 macOS Intel / Windows ARM 的需求评估

## 结论

三个目标均保持候选/调研状态，不进入正式阶段，也不修改现有发行矩阵：

- **Linux x86_64**：代码已有部分 Linux 适配，Tauri 发行与更新链路也存在可复用基础，但清晰用户群、支持基线、真实 Secret Service 安全验证、完整升级路径和自动化发行测试均未满足。当前不能称为“正式发行”。
- **macOS Intel**：仓库曾构建 `darwin-x86_64`，后于提交 `0ccd396` 移除；没有保留下来的用户需求或目标机器验收证据。GitHub 当前仍提供 Intel runner，但 runner 镜像按支持策略滚动弃用；重新承诺前必须证明需求并给出镜像迁移或托管 runner 不再可用时的维护方案。
- **Windows ARM**：Tauri 与 GitHub Actions 已提供技术入口，但仓库没有目标架构构建、原生依赖、Credential Manager、ConPTY、安装器或升级验证，也没有用户需求证据。

本次没有发布实验包。证据不足时向稳定 `latest.json` 增加平台会把探索项变成隐含承诺，并可能让未验证的凭证、安装和更新路径直接面向用户。

## 用户需求证据

2026-08-23 通过公开 GitHub 仓库与 API 取得以下快照：

| 观察项 | 快照 | 判断边界 |
| --- | --- | --- |
| 仓库规模 | 2 stars、1 fork、0 open issues | 样本太小，不能据此推断平台占比 |
| 平台请求 | `linux`、`intel`、`arm64`、`Windows ARM` 的 issue 搜索均为 0 | 只能说明公开 issue 中没有证据；不是“没有需求”的证明 |
| 反馈入口 | GitHub 显示 issue creation is restricted | 当前入口会漏掉外部需求，不能把 0 issue 当作有效需求验证 |
| 最新稳定版 | v2.0.49 只有 `darwin-aarch64` 与 `windows-x86_64` 应用/更新产物 | 现有下载量无法衡量无法下载的候选平台需求 |

可复核来源：

- [仓库概览](https://github.com/hi-fullmoon/TermBridge)
- [Issues](https://github.com/hi-fullmoon/TermBridge/issues)
- [Linux issue 查询](https://github.com/hi-fullmoon/TermBridge/issues?q=is%3Aissue+linux)
- [Intel issue 查询](https://github.com/hi-fullmoon/TermBridge/issues?q=is%3Aissue+intel)
- [ARM64 issue 查询](https://github.com/hi-fullmoon/TermBridge/issues?q=is%3Aissue+arm64)
- [v2.0.49 发行](https://github.com/hi-fullmoon/TermBridge/releases/tag/v2.0.49)
- [v2.0.49 Releases API](https://api.github.com/repos/hi-fullmoon/TermBridge/releases/tags/v2.0.49)

### 待验证用户群

| 候选 | 用户群假设 | 当前证据 | 准入前最小发现包 |
| --- | --- | --- | --- |
| Linux x86_64 | 在 Linux 桌面上管理远端主机、需要终端与 SFTP 共用凭证的个人运维用户 | 只有产品定位与代码适配，未记录发行请求、桌面环境或发行版分布 | 至少 5 名独立意向用户；记录发行版、桌面环境、Secret Service、安装格式与核心任务；至少 3 人愿意完成候选包验收 |
| macOS Intel | 仍使用 Intel Mac 的个人运维用户 | 历史构建配置存在过，但无用户验收；2026-08-03 已从正式矩阵移除 | 至少 5 名独立意向用户；确认仍受支持的 macOS 版本、机器架构与更新需求；至少 3 台真实 Intel Mac 完成验收 |
| Windows ARM | 使用 ARM64 Windows 设备且希望原生运行的个人运维用户 | 无仓库需求、构建或运行证据 | 至少 5 名独立意向用户；确认 x64 模拟的实际阻断和原生收益；至少 3 台真实 ARM64 设备完成验收 |

上述数量是产品发现的最低样本，不是市场规模结论。收集必须显式选择加入、只记录平台与任务信息，不收集凭证、终端输出、文件内容或 AI 对话。

## 现有实现与链路审计

### 可复用基础

- `src/lib/platform.ts` 已把运行平台归一化为 macOS、Windows、Linux 或 other；非 macOS 的窗口控件与快捷键路径可覆盖 Linux，但尚无 Linux GUI 验收。
- Rust 的终端与网络实现大量复用 `unix`/`windows` 分支。Linux 已有 `xdg-open`、线程计数与本地文件打开路径；SSH/SFTP 主链路本身不按 CPU 架构分叉。
- `src-tauri/Cargo.toml` 为 Linux/FreeBSD 声明 `dbus-secret-service-keyring-store`，`src-tauri/src/keychain.rs` 在原生凭证服务不可用时失败关闭，不回退到明文存储。
- `quality-gate.yml` 的隔离 SSH/SFTP job 在 Ubuntu x86_64 安装 Tauri 依赖并编译/运行指定 Rust E2E，说明仓库已有 Linux 编译入口；它不等价于全量 Rust 门禁、桌面运行或发行验证。
- `build-updater-json.mjs` 已识别 `.AppImage.tar.gz`，并能把任意 `OS-ARCH` 元数据合入静态更新清单；脚本单元测试仍覆盖 `darwin-x86_64`。

### 阻断正式发行的缺口

| 链路 | Linux x86_64 | macOS Intel | Windows ARM |
| --- | --- | --- | --- |
| 常规 CI | Rust 全量矩阵只有 Windows x86_64 与 macOS ARM；Ubuntu job 只执行筛选后的 SSH/SFTP E2E | 没有 Intel runner 门禁 | 没有 ARM runner 门禁 |
| 缓存/构建 | `cache-warm.yml` 无 Linux | Intel 于 `0ccd396` 移除 | 无 ARM target、缓存或原生构建 |
| 打包 | `release.yml` 的非 macOS 分支假定目标是 Windows，会查找 `*-setup.exe` | 历史路径已移除 | Windows 分支未校验 PE 架构，也未验证 ARM64 NSIS |
| 发布 | 资产白名单不包含 `.AppImage`、`.AppImage.tar.gz` 及其 `.sig` | 发布校验只期望 ARM macOS | 发布校验不期望 `windows-aarch64` |
| 更新 | 生成器可表达 `linux-x86_64`，但没有 Linux 产物、N-1 升级或失败恢复验证 | 生成器单测可表达，正式链路未构建 | 没有目标清单项或升级验证 |
| 平台集成 | 未覆盖 WebKitGTK、窗口透明/控件、`xdg-open`、本地 PTY、桌面 `$PATH` 差异 | 未在真实 Intel 机器覆盖 Keychain、PTY、窗口与更新 | 未在 ARM64 覆盖 Credential Manager、ConPTY、原生依赖与安装器 |

Tauri 官方文档进一步限定了维护边界：Linux 构建依赖 WebKitGTK 4.1 等系统包；AppImage 应在希望支持的最老基础系统上构建；Linux updater 使用 AppImage 或其 v1-compatible 压缩包。参考 [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/)、[AppImage](https://v2.tauri.app/distribute/appimage/) 与 [Updater](https://v2.tauri.app/plugin/updater/)。

## 六项准入复核

### 1. 用户群：未满足

三个候选都只有用户群假设，没有可复核的直接需求、平台分布或试用队列。应先恢复一个可用的显式反馈入口，按上表完成最小发现包；在此之前不得用同类产品的平台覆盖率替代 TermBridge 自身需求。

### 2. 维护成本：未知

- Linux 不是单一运行环境。正式支持必须先锁定最低 glibc/WebKitGTK、发行版/桌面环境、Secret Service 实现和首选包格式；每增加 `.deb`、RPM、Flatpak 等格式都会增加独立安装与升级责任。
- macOS Intel 当前可使用 `macos-15-intel` 或 `macos-26-intel` runner；GitHub 的支持策略会在新 GA 镜像发布后弃用旧镜像。准入前必须验证当前 label，并明确镜像迁移以及 Intel runner 最终不可用时停止支持或维护隔离真实/自托管 runner 的策略。参考 [runner image 列表与支持策略](https://github.com/actions/runner-images)。
- Windows ARM 的标准托管 runner 仍标注 public preview；依赖与安装器必须在原生 ARM runner 上验证，不能以 x64 交叉 `cargo check` 代替。参考 [GitHub hosted runner 列表](https://docs.github.com/en/actions/how-tos/write-workflows/choose-where-workflows-run/choose-the-runner-for-a-job)。

在得到候选包真实构建时长、缓存体积、失败率和每月平台专项缺陷前，无法证明新增目标可由当前维护者持续承担。

### 3. 跨平台实现：部分存在，未满足

Linux 的条件编译和通用 Unix 路径降低了起步成本，macOS Intel 与 Windows ARM 也可复用同一 OS 分支；但 CPU 架构复用不证明原生库、桌面集成、安装器或运行时行为相同。三个候选均缺目标机器上的完整主链路证据。

### 4. 安全模型：设计部分成立，运行证据不足

- 必须继续保持现有边界：秘密仅进入系统原生凭证存储；不可用时失败关闭；不得为 Linux/headless 或新架构增加明文数据库、环境变量或文件回退。
- 当前钥匙串单元测试使用 mock backend，没有在真实 Linux D-Bus Secret Service 上验证锁定、解锁、缺失 session bus、删除和跨重启，也没有目标架构的 Keychain/Credential Manager 集成证据。
- Tauri updater 的 `.sig` 可保护更新包，但不能替代首次下载的发布者身份验证。Tauri 文档说明 AppImage 的嵌入式 GPG 签名不会自动验证；若采用它，必须在受认证渠道发布公钥与人工校验说明。参考 [Linux code signing](https://v2.tauri.app/distribute/sign/linux/)。
- macOS 当前 CI 使用 ad-hoc signing，Windows workflow 未配置 Authenticode。新增“正式”目标前必须明确首次安装信任、平台签名/公证、更新签名与密钥轮换职责，不能把现有缺口复制到新目标。

### 5. 升级策略：未满足

候选正式化前必须先固定每个平台的安装技术和兼容边界：

- Linux 首个候选只能选择一种主要更新载体。若选 AppImage，需要验证原位 N-1 → N 更新、只读目录/权限不足、下载中断、签名失败、运行中传输/转发退出保护，以及旧版本保留或人工恢复方式；`.deb`/RPM 的包管理器升级不能默认为同一 updater 语义。
- macOS Intel 必须独立生成 `darwin-x86_64` 清单项、验证 x86_64 app/DMG、签名/公证和 N-1 → N；不得向 Intel 客户端下发 ARM 包。
- Windows ARM 必须保持稳定 identifier、productName 与 NSIS install mode，并生成 `windows-aarch64`；需要验证安装目录、架构、重启与失败后原版本可用性。
- 数据库与配置格式继续共用当前版本化迁移；任何降级若无法安全读取前向迁移后的数据，恢复说明必须明确禁止直接降级，而不是承诺不存在的回滚。

### 6. 自动化测试方案：方案已形成，执行证据未满足

| 层级 | Linux x86_64 | macOS Intel | Windows ARM |
| --- | --- | --- | --- |
| 每次 PR | Ubuntu x86_64 全量 fmt、Clippy、Rust tests；前端平台测试 | Intel runner 全量 Rust tests | 原生 ARM runner 全量 Rust tests |
| 凭证安全 | `dbus-run-session` 下真实 Secret Service round-trip、locked/unavailable fail-closed、重启后读取/删除 | 临时 Keychain round-trip、ACL、删除与失败关闭 | Credential Manager round-trip、删除与失败关闭 |
| 桌面冒烟 | Xvfb/真实桌面启动，窗口控件、WebKitGTK、`xdg-open`、本地 PTY | 真实 Intel 启动、窗口、Keychain、本地 PTY | 原生 ARM 启动、ConPTY、Credential Manager |
| 核心链路 | 复用隔离 SSH/SFTP：host key、终端、SFTP、取消、重连、转发、Runbook 只读边界 | 同左 | 同左 |
| 发行 | 最老受支持构建基线生成 AppImage 与 updater archive；`file`/`readelf` 校验 x86_64，校验资产与签名 | `lipo` 校验 x86_64，codesign/notary、DMG 与 updater archive | PE 工具校验 ARM64，NSIS 与 updater archive |
| 升级 | 安装 N-1，模拟成功、网络中断、签名错误、不可写目录并验证数据完整性 | N-1 → N、错误架构拒绝、签名失败 | N-1 → N、安装目录不漂移、错误架构与签名失败 |
| 发布后 | `latest.json` 精确包含获准平台，逐项 HEAD/签名/架构检查；实验平台不得进入 stable manifest | 同左 | 同左 |

最少还需为 `build-updater-json.mjs` 增加 Linux/ARM 组合、重复 platform、缺失签名、错误后缀与稳定平台集合的回归测试。只有目标平台的上述门禁连续通过候选发布，才能把“方案存在”升级为“可自动验证”。

## 复盘触发条件

每四周复盘一次或在以下任一事件发生时提前复盘：

1. 某一目标达到最小用户发现包，并有真实设备试用队列。
2. 维护者确定单一支持基线、包格式、runner 生命周期与每月维护预算。
3. 真实凭证存储、首次安装信任、更新签名/密钥轮换与失败恢复设计通过安全审核。
4. 目标平台 PR、发行、N-1 升级和发布后验证能够自动执行。

即使六项证据齐全，也只能形成一次“是否纳入正式阶段”的独立评审；不得由审计脚本或候选包自动改写为路线图承诺。

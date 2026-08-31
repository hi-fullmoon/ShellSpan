# TermBridge × Petdex Phase 0 验证记录

> 验证日期：2026-08-28
>
> 范围：PETDEX-001、PETDEX-002、PETDEX-003；未开始 Phase 1 功能实现
>
> 结论：PETDEX-001 和 PETDEX-003 已完成；PETDEX-002 已增加可在 `windows-2025` / `macos-15` 自动复核的无安装契约探针，但 Windows 真机 Petdex 和 ACL 仍待验证。Phase 0 暂不关闭。

## 1. 证据分级与基线

本文严格区分三类证据：

- **实测**：本线程对实际安装的 Petdex Desktop 或生产网络端点执行命令得到的结果。
- **源码证据**：对 Petdex 官方仓库固定 commit 的阅读结果；它能说明实现意图，不替代指定平台的真机验证。
- **待验证**：当前环境不具备条件，只记录预期，不计为通过。

验证基线：

| 项目 | 基线 | 证据 |
| --- | --- | --- |
| TermBridge 工作区 | `main`；开始时已有用户本地改动，本次未修改它们 | **实测** `git status --short --branch` |
| macOS | macOS 26.6.2 (25G83), arm64 | **实测** `sw_vers` / `uname -m` |
| Petdex Desktop | `/Applications/Petdex.app`，0.8.0，bundle id `dev.petdex.desktop-native`，Notarized Developer ID | **实测** `defaults` / `codesign` / `spctl` |
| Petdex 当前发布版 | `desktop-v0.8.0`，commit `f2ea48aac6f89fbaeedd6a639faf4e208864ae5d` | **网络实测** GitHub Releases API |
| Petdex 当前源码快照 | commit `493defbea9d4ae6e687da5bbc40976b0ff838c36` | **网络实测** shallow clone + `git rev-parse HEAD` |
| Petdex 生产 manifest | 2026-08-28 生成，v1/v2 均为 4667 个条目 | **网络实测** `https://petdex.dev/api/manifest` 及 `/v2` |
| TermBridge 跨平台 CI | Rust matrix 已在 `windows-2025` 和 `macos-15` 运行 `cargo test --all-targets` | **TermBridge CI 配置证据** `.github/workflows/quality-gate.yml` |

当前发布 tag 与当前源码快照之间，本文所依赖的主路由、Token、动作集合和授权边界没有发现不兼容变化。本机实测以发布版 0.8.0 为准，源码结论以上述固定 commit 为准。

## 2. PETDEX-001：Desktop 状态接口契约

### 2.1 TermBridge 允许使用的最小契约

| 字段 | 当前契约 | 证据 |
| --- | --- | --- |
| 目标 | 仅 `http://127.0.0.1:7777/state`；不使用 `localhost`，不接受前端或配置传入 URL | **实测 + 源码** 监听器为 IPv4 loopback `127.0.0.1:7777` |
| 方法 | `POST` | **实测 + 源码** |
| 请求头 | `Content-Type: application/json` 和 `X-Petdex-Update-Token: <token>` | **实测 + 官方文档 + 源码** |
| 必选 body | `{"state":"<enum>"}` | **实测 + 源码** |
| 可选 body | `duration` 为非负数字，服务端上限 30000 ms；不传则返回 `duration: null` | **实测 + 源码** |
| 成功 | HTTP 200，`{"ok":true,"state":"...","duration":...,"queued":...}` | **实测** |
| 失败 | 无效/缺失 Token 为 401；非法状态或时长为 400；共享限流超限为 429；未知路由为 404 | **401/400/404 实测；429 源码证据** |
| 限流 | `/state` 与 `/bubble` 共享 30 次/秒 Token Bucket | **源码证据** |
| 连接 | 单请求短连接，`Connection: close`；服务端读取超时 5 s | **源码证据** |

Petdex 0.8.0 实测接受的完整动作集合为：

```text
idle
running
running-left
running-right
waving
jumping
failed
review
waiting
```

TermBridge roadmap 当前只使用其中的 `idle`、`waiting`、`waving`、`running`、`jumping`、`failed`，这 6 个值均实测返回 HTTP 200。不应将 `review`、`running-left` 或 `running-right` 暴露为 TermBridge 业务事件。发送裸 `running` 时，Petdex 在当前会话内交替应用 `running-right` / `running-left`；POST 响应仍回显 `running`，`GET /state` 可能读到实际应用的方向变体。

`GET /health`、`GET /whoami` 和 `GET /state` 当前不需要 Token。TermBridge 如使用它们，只能用于有界状态判定，不应把返回内容当作可信数据或写入详细日志。

### 2.2 Token 位置、权限与轮换

| 平台 | 路径 | 权限结论 | 验证级别 |
| --- | --- | --- | --- |
| macOS / Linux | `$HOME/.petdex/runtime/update-token` | 源码以 `0600` 写入；本机实测为 owner `zhengbiwen`、mode `600`、size 64 | **macOS 实测 + 源码** |
| Windows | `%USERPROFILE%\.petdex\runtime\update-token` | 源码明确说明 `0600` 仅为 POSIX 保证；Windows 依赖父目录 ACL 继承 | **源码/CI 路径证据；ACL 待 Windows 真机验证** |

轮换行为：

- 每次 Desktop 启动都从系统 CSPRNG 生成 32 随机字节，写成 64 个十六进制字符。**源码证据**
- 本机连续三次启动都观察到 Token 指纹变化；新会话中，旧 Token 返回 401，当前 Token 返回 200。全程没有输出 Token 内容。**macOS 实测**
- Desktop 退出后 Token 文件仍存在，但端口已拒绝连接。因此不得以“Token 文件存在”作为“Petdex 正在运行”的证据。**macOS 实测**
- Phase 1 适配器必须在连接失败或 401 后重新读取文件；不能在进程生命周期内永久缓存 Token。

### 2.3 loopback 安全约束

符合预期的证据：

- 本机 `lsof` 显示 Petdex 只监听 `TCP 127.0.0.1:7777`，源码也显式构造 IPv4 loopback 地址。
- 无 Token 的 `POST /state` 返回 401。Token 以恒定时间比较。
- 带 `Origin` 和自定义 Header 请求的 `OPTIONS /state` 返回 404，响应不提供 CORS 允许头；普通网页无法通过标准浏览器 CORS 流程携带 Token Header。

不能过度声明的边界：

- 这不是对同一用户身份下其他本地进程的隔离边界；能读取该用户文件的进程也能读取 Token。
- 当前服务器没有校验 HTTP `Host` Header。CORS 和 loopback bind 能降低远程网页直接驱动的风险，但 TermBridge 仍必须固定 IP/端口/路由，不允许代理环境变量、DNS 或前端输入改写目标。
- Windows Token 是否确实只有当前用户可读，必须在真机检查 ACL；官方文档的概括性 `0600` 表述不足以作为 Windows 证据。
- Petdex 还提供 `/bubble`，但 TermBridge 契约明确禁止使用它，也不发送 `agent_source`、`title`、会话标识、路径或自由文本。

### 2.4 最小兼容性样例

样例只用于手工验证，不是 Phase 1 适配器实现：

```sh
token_path="$HOME/.petdex/runtime/update-token"
token="$(tr -d '\r\n' < "$token_path")"
printf 'header = "X-Petdex-Update-Token: %s"\n' "$token" | \
  curl --config - \
    --noproxy '*' \
    --connect-timeout 0.3 \
    --max-time 1 \
    -X POST 'http://127.0.0.1:7777/state' \
    -H 'Content-Type: application/json' \
    --data-raw '{"state":"waving","duration":1200}'
```

样例通过 curl stdin config 避免将 Token Header 放入 curl 的进程参数。生产实现仍应直接使用 HTTP 客户端库，不调用外部 shell/curl。

## 3. PETDEX-002：失败与重启路径

### 3.1 macOS 验证记录

| 场景 | 观察结果 | 结论 |
| --- | --- | --- |
| 已安装、未启动 | 无 Petdex 进程，7777 无监听；`GET /health` 为 curl exit 7 / HTTP 000；历史 Token 文件仍存在 | **实测通过**；状态应判定为“Petdex 未运行”，不是鉴权异常 |
| 首次受控启动 | 健康检查就绪；只监听 `127.0.0.1:7777`；Token 更新且为 `0600` | **实测通过** |
| 动作请求 | 9 个官方状态都返回 200 和 `queued:true`；`GET /state` 计数更新 | **实测通过** |
| 无 Token / 非法输入 | 无 Token 401；非法状态 400；负数时长 400 | **实测通过** |
| 退出 | 进程退出，健康检查再次为 exit 7 / HTTP 000；Token 文件未删除 | **实测通过** |
| 重启 | 健康检查恢复；Token 指纹变化；旧 Token 401，新 Token 200 | **实测通过** |
| 未安装 | 本机已安装 0.8.0，未为了测试而破坏性卸载；在 HTTP 层预期与“未启动”相同，另加 app bundle 不存在 | **待真实未安装 macOS 环境验证**；不计为通过 |

测试前 Petdex 未运行，测试后已恢复为未运行，没有保留启动的 Petdex 进程。

### 3.2 Windows 验证记录

TermBridge 现有 Quality Gate 的 Rust matrix 同时覆盖 `windows-2025` 和 `macos-15`，并已执行 `cargo test --all-targets`。因此本次在 [Petdex Phase 0 契约探针](../src-tauri/tests/petdex_contract_probe.rs) 中新增了一个完全自包含的 Rust integration test，并在 Quality Gate 中增加显式命名的执行步骤：

```text
cargo test --manifest-path src-tauri/Cargo.toml --locked \
  --test petdex_contract_probe -- --test-threads=1
```

该探针不依赖真实 Petdex 安装，不读取用户目录，只使用临时目录、固定的假 Token 和临时 IPv4 loopback 端口。它只是 Phase 0 可执行契约，位于 `src-tauri/tests` 且不编入产品 crate，不是 Phase 1 适配器。

| 自动契约 | 可复核结果 | 不代表的事项 |
| --- | --- | --- |
| Token 缺失 | 在任何网络 I/O 前返回 `TokenMissing` | 不代表真实 Windows 安装检测已通过 |
| Token 残留 + 端口已关闭 | 分类为 `Transport`，不将残留 Token 误判为服务在线，也不删除它 | 不固定匹配 OS 本地化的连接拒绝文案 |
| 首次请求 401，Token 文件已轮换 | 重读 Token 并且只重试一次；第二次请求携带新 Token | 不代表真实 Petdex 重启时序已在 Windows 通过 |
| 401 后 Token 未变 | 返回 `Unauthorized`，不进行鉴权重试风暴 | 不替代 Phase 2 的失败退避 |
| 目标边界 | 产品契约字面值为 `http://127.0.0.1:7777/state`；测试拒绝 HTTPS、`localhost`、IPv6、`/bubble`、query 和 URL 凭据 | 临时端口只为无冲突测试夹具，不是产品可配置项 |

契约探针的 5 个测试已在本机 macOS 通过。`windows-2025` 的结果必须以 GitHub Actions 真实运行为准；本地通过不会被记录为 Windows 通过。

| 项目 | 已有证据 | 尚缺证据 |
| --- | --- | --- |
| 路径 | 上游 Windows CI 从 `%USERPROFILE%\.petdex\runtime\update-token` 读取 Token；TermBridge 探针跨平台验证 `.petdex/runtime/update-token` 路径组装 | Windows 真机 ACL |
| 启动与接口 | 上游 CI 在 Windows runner 启动 native exe，检查 7777 监听，并向 `/state` 发送带 Token 的 `running`；TermBridge 探针可在无安装 runner 验证失败分类与轮换策略 | 本 TermBridge 项目控制的 Windows 真机 Petdex 安装包行为 |
| 未安装 | 预期 Token 路径不存在且 7777 连接失败 | **待 Windows 真机验证；未通过** |
| 已安装、未启动 | 源码的进程内服务器表明进程不在时不应有监听；已知 Token 可能残留 | **待 Windows 真机验证具体 PowerShell 异常类型/文案；未通过** |
| 重启/轮换 | CSPRNG、Token 重写和恒定时间比较为跨平台源码；上游 CI 有 Windows 接口回路测试 | **待 Windows 真机验证旧 Token 401、新 Token 200 和重启恢复时间；未通过** |

Windows 的结论只是“实现与上游 CI 存在对应路径”，不是“TermBridge 的 Windows 验收已通过”。真机验证时不应固定匹配 PowerShell 的本地化错误文本；应匹配结果类别：Token 缺失/不可读、连接拒绝/超时、401 和恢复成功。

## 4. PETDEX-003：社区资产授权边界

### 4.1 可以依赖的权限

- Petdex 仓库源码为 MIT License。这只授权使用仓库中受该许可覆盖的软件和文档，不自动授权由提交者或第三方拥有的宠物角色、商标和图片。**源码证据**
- 官方 README/文档明确说明：宠物是用户提交的 fan art，Petdex 不声称底层 IP 权利，资产由提交者按其自行声明的许可持有，并提供 takedown 流程。**官方文档 + 源码证据**

### 4.2 manifest 实际不能证明的权限

2026-08-28 对生产 v1/v2 manifest 的实测结果：

- v1 字段为 `slug`、`displayName`、`kind`、`submittedBy`、`spritesheetUrl`、`petJsonUrl`、`zipUrl`、`spriteVersionNumber`。
- v2 的紧凑字段与 v1 语义一致。
- 两者都没有 `license`、`rights`、`copyright` 或 `attribution` 字段。
- 抽样的生产 `pet.json` 只有 `description`、`displayName`、`id`、`spritesheetPath`，同样没有授权字段。
- `submittedBy` 只是署名，不是授权；“已上架”也不等于“可由 TermBridge 再分发”。

### 4.3 Phase 0 风险结论

1. TermBridge **不随安装包分发、镜像、预置或二次托管任何 Petdex 社区资产**。
2. Phase 1 只驱动用户已安装的 Petdex Desktop 当前宠物，不读取 manifest，不下载资产，不实现目录或宠物选择。
3. 如未来进入 Phase 4，在每个资产具有可机读许可、署名要求、来源、版本和下架状态之前，不得实现内嵌分发。
4. Petdex 的 takedown 机制可以减少上游持续供应风险，但不会自动撤回 TermBridge 已打包或已缓存副本，因此不能代替授权字段。

## 5. 退出条件审核

| 退出要求 | 结果 | 证据/缺口 |
| --- | --- | --- |
| 本地接口能稳定驱动动作 | **macOS 满足** | 0.8.0 上 9 个状态连续返回 200，退出/重启后结果符合契约 |
| 无需向 Petdex 发送 TermBridge 业务数据 | **满足** | `/state` 最小 body 只需固定状态枚举；禁止使用 `/bubble` |
| macOS 未安装/未启动/重启失败表现 | **部分满足** | 未启动和重启已实测；真实未安装环境待验证 |
| Windows 未安装/未启动/重启失败表现 | **部分满足** | 无安装契约探针已覆盖 Token 缺失/残留、端口拒绝和 401 重读；真机 Petdex 时序、安装包与 ACL 仍未验证 |
| 社区资产授权边界 | **满足** | manifest/pet.json 无许可字段；已确定不随包分发第三方资产 |

**Phase 0 整体判定：部分满足退出条件，不关闭。** 不影响将已确认的最小契约作为后续设计输入，但在补齐 Windows 真机和 macOS 真实未安装环境之前，不得将 PETDEX-002 或 Phase 0 标记为完成。

### 5.1 有条件的 Phase 1 开发准入建议

原始技术退出条件是“本地接口能稳定驱动动作，且无需向 Petdex 发送 TermBridge 业务数据”。macOS 0.8.0 真机证据和新增跨平台契约探针已足以支持一个**有条件的 Phase 1 开发准入**，但不是 Phase 0/PETDEX-002 完成或发布准入。本次变更没有开始 Phase 1。

未来的 Phase 1 实现必须以以下条件为入口：

1. 功能默认关闭，且关闭时不读 Token、不发请求。
2. Rust 产品代码自行实现最小适配器，不导入测试探针；产品测试必须继承同等的契约断言。
3. 目标必须固定为 `http://127.0.0.1:7777/state`，禁止代理、DNS、前端 URL 和 `/bubble`。
4. Token 只在后端内存中使用；401 后重读，仅在 Token 变化时受控重试一次。
5. 连接拒绝、超时、401、400、429 和非 JSON 响应都不得更改 SSH/SFTP/AI 业务结果，也不记录 Token 或自由文本。

### 5.2 必须保留到 Phase 2 的发布门禁

以下项目在完成前，Petdex 联动不得从内部/实验开发状态提升为可宣称跨平台可用的发布功能：

- Windows 真机完成未安装、已安装未启动、启动顺序交换、退出、重启、旧 Token 401/新 Token 200 和安装包路径验证。
- Windows 真机证明 `%USERPROFILE%\.petdex\runtime\update-token` 的有效 ACL 不开放给其他普通本地用户；如不满足，不能靠文案提示规避。
- macOS 在真实未安装环境重复无文件/无监听的静默降级验收。
- `windows-2025` 与 `macos-15` 的 Phase 0 契约探针、产品适配器测试、Clippy 和全量 Rust 测试持续通过。
- 真实 Petdex 重启、进度事件风暴和持续失败下，完成去重、节流、退避和业务耗时不受影响的 Phase 2 验收。
- 日志、错误详情和诊断包的秘密扫描证明不含 Token、终端内容和 TermBridge 业务数据。

当前产品桥接的队列、仲裁、恢复探测和失败退避参数见 [Petdex 运行时边界](./petdex-runtime.md)。该实现说明不替代上述真机与发布证据。

## 6. 复核命令与结果摘要

下列上游研究命令均在 TermBridge 仓库外的临时目录或只读端点上运行，未修改 Petdex 源码，未输出 Token：

```sh
git clone --depth 1 https://github.com/crafter-station/petdex.git <temp>/petdex
git -C <temp>/petdex rev-parse HEAD

defaults read /Applications/Petdex.app/Contents/Info CFBundleIdentifier
defaults read /Applications/Petdex.app/Contents/Info CFBundleShortVersionString
codesign -dv --verbose=2 /Applications/Petdex.app
spctl -a -vv /Applications/Petdex.app

lsof -nP -iTCP:7777 -sTCP:LISTEN
stat -f 'mode=%Lp size=%z owner=%Su' "$HOME/.petdex/runtime/update-token"
curl --noproxy '*' --connect-timeout 0.3 --max-time 1 http://127.0.0.1:7777/health

curl -fLsS https://petdex.dev/api/manifest -o <temp>/manifest-v1.json
curl -fLsS https://petdex.dev/api/manifest/v2 -o <temp>/manifest-v2.json
jq '{generatedAt,total,firstPetKeys:(.pets[0]|keys)}' <temp>/manifest-v1.json
jq '{v,generatedAt,total,assetBase,fields}' <temp>/manifest-v2.json
```

TermBridge Phase 0 契约探针的独立复核命令：

```sh
cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check
cargo test --manifest-path src-tauri/Cargo.toml --locked \
  --test petdex_contract_probe -- --test-threads=1
cargo clippy --manifest-path src-tauri/Cargo.toml \
  --test petdex_contract_probe --locked -- -D warnings
```

本机结果：5 个契约测试通过，无 warning；这不记为 `windows-2025` 已运行。

受控启动/退出/重启脚本的输出摘要：

```text
first launch: health ready; token changed; mode 600; 127.0.0.1:7777 LISTEN
unauthenticated POST /state: HTTP 401 unauthorized
browser preflight OPTIONS /state: HTTP 404 not_found
9 valid states: HTTP 200, queued true
invalid state: HTTP 400 invalid_state
negative duration: HTTP 400 invalid_duration
stop: process absent; health curl exit 7 / HTTP 000; token file remains
restart: health ready; token changed; current token HTTP 200
stale token after restart: HTTP 401 unauthorized
final: Petdex process absent (restored to initial stopped state)
```

## 7. 官方证据链接

- [Petdex Desktop 官方文档](https://petdex.dev/docs#desktop-app)
- [Petdex Desktop 0.8.0 发布](https://github.com/crafter-station/petdex/releases/tag/desktop-v0.8.0)
- [当前 hook server 源码（固定 commit）](https://github.com/crafter-station/petdex/blob/493defbea9d4ae6e687da5bbc40976b0ff838c36/packages/petdex-desktop-native/src/hook_server.zig)
- [动作行与精灵图定义（固定 commit）](https://github.com/crafter-station/petdex/blob/493defbea9d4ae6e687da5bbc40976b0ff838c36/packages/petdex-desktop-native/src/sprite.zig)
- [Windows native CI 工作流（固定 commit）](https://github.com/crafter-station/petdex/blob/493defbea9d4ae6e687da5bbc40976b0ff838c36/.github/workflows/desktop-native-ci.yml)
- [public manifest 结构（固定 commit）](https://github.com/crafter-station/petdex/blob/493defbea9d4ae6e687da5bbc40976b0ff838c36/src/lib/public-manifest.ts)
- [Petdex 源码 MIT License（固定 commit）](https://github.com/crafter-station/petdex/blob/493defbea9d4ae6e687da5bbc40976b0ff838c36/LICENSE)
- [Petdex takedown 模板（固定 commit）](https://github.com/crafter-station/petdex/blob/493defbea9d4ae6e687da5bbc40976b0ff838c36/.github/ISSUE_TEMPLATE/takedown.yml)
- [Petdex public manifest v1](https://petdex.dev/api/manifest)
- [Petdex public manifest v2](https://petdex.dev/api/manifest/v2)

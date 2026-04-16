# TermBridge

TermBridge 是一个基于 Tauri 2、React 和 Rust 构建的跨平台 SSH 桌面工具，当前主要面向 macOS 和 Windows。

它把常用的 SSH 终端能力和远程文件管理放进同一个桌面应用里，适合作为轻量的 SSH / SFTP 工作台。

## 项目定位

TermBridge 关注的是一条尽量顺手的远程运维主链路：

- 快速创建 SSH 连接
- 在同一窗口管理多个终端会话
- 复用历史连接配置
- 直接浏览和操作远程文件
- 在桌面端统一处理日志与更新

如果你想要一个比纯命令行更直观、又比重量级 IDE 更轻的桌面 SSH 客户端，这个项目就是围绕这个方向设计的。

## 当前能力

### 连接与会话

- 支持密码认证和私钥认证
- 支持保存连接信息
- 密码认证下可选保存密码
- 支持多标签终端会话
- 支持会话状态展示与异常关闭提示
- 支持会话标签切换与排序
- 支持历史连接复用、重命名、收藏、置顶、删除

### 文件管理

- 内置远程文件管理器
- 支持目录浏览和手动输入路径跳转
- 支持新建文件、新建文件夹、重命名、复制、删除
- 支持查看文件属性
- 支持复制名称、文件路径、目录路径
- 支持使用系统默认应用打开远程文件
- 支持拖拽上传文件或文件夹
- 支持上传进度展示与上传取消
- 支持删除进度展示

### 桌面能力

- 前后端统一日志
- 应用启动后自动检查更新
- 支持手动触发更新检查
- 已配置应用图标与打包产物

## 技术栈

- 桌面框架：Tauri 2
- 前端：React 18 + TypeScript + Vite
- UI 样式：Tailwind CSS
- 终端渲染：xterm.js
- 文件表格：AG Grid
- 状态管理：Zustand
- 后端：Rust
- SSH / SFTP：`ssh2`

## 快速开始

### 环境要求

- Node.js 18 及以上
- Rust 工具链，并确保 `cargo` 可用
- 满足 Tauri 2 对当前系统的构建依赖

仓库当前使用 `pnpm-lock.yaml`，推荐使用 pnpm 9；如果你习惯 npm，也可以直接运行脚本。

如果终端里找不到 `cargo`，先执行：

```bash
source "$HOME/.cargo/env"
```

### 安装依赖

```bash
pnpm install
```

### 启动前端预览

```bash
pnpm dev
```

这会只启动浏览器预览环境，用于调试前端界面。此模式下无法使用真实 SSH 连接、文件管理和桌面端更新能力。

### 启动桌面开发模式

```bash
pnpm tauri:dev
```

这个命令会启动完整的 Tauri 桌面应用，适合联调 SSH、SFTP、日志和更新逻辑。

### 运行测试

```bash
pnpm test
```

### 构建桌面应用

```bash
pnpm tauri:build
```

构建完成后，可在 `src-tauri/target/` 下查看对应平台的构建产物。

## 开发说明

### 浏览器预览与桌面运行的区别

`pnpm dev` 只运行 Vite 前端，因此：

- UI 可以正常调试
- SSH 连接不可用
- 远程文件管理不可用
- 本地日志文件不会生成
- 更新检查不会生效

`pnpm tauri:dev` 才会加载 Tauri 和 Rust 后端，完整功能都依赖这个模式验证。

### 项目结构

```text
.
├── src/                     # React 前端入口与界面逻辑
├── src/components/          # 终端、侧栏、文件管理器等 UI 组件
├── src/hooks/               # 前端自定义 hooks
├── src/lib/                 # 状态、日志、更新、配置等通用逻辑
├── src/stores/              # Zustand 状态存储
├── src-tauri/               # Tauri 配置与 Rust 后端
├── scripts/                 # 发布辅助脚本
├── docs/                    # 设计说明与实施计划
├── CONTRIBUTING.md          # 提交与注释规范
└── README.md
```

## 数据与安全说明

- 历史连接信息保存在前端本地存储中
- 只有勾选“保存密码”时，密码才会随连接信息一起保存在本地
- 私钥口令仅参与当前连接，不会持久化保存
- 日志不会记录明文密码、私钥内容、私钥口令或终端实时输入输出内容

当前实现更偏向“可用的桌面客户端基础版”，安全能力仍有继续增强空间，见下方“当前限制”。

## 日志说明

前端与 Tauri / Rust 后端共用统一日志体系：

- 开发环境默认记录 `debug` 及以上级别
- 生产环境默认记录 `info` 及以上级别
- 日志文件名为 `termbridge.log`
- 日志会自动轮转，最多保留一组近期归档
- 浏览器预览模式只输出到控制台，不写本地日志文件

本地日志常见位置：

- macOS：`~/Library/Logs/com.termbridge/termbridge.log`
- Windows：`%LOCALAPPDATA%\\com.termbridge\\logs\\termbridge.log`

macOS 下可以直接执行：

```bash
open ~/Library/Logs/com.termbridge
tail -f ~/Library/Logs/com.termbridge/termbridge.log
```

## 更新机制

- 应用启动后约 8 秒会自动执行一次静默更新检查
- 内置节流策略，避免频繁重复检查
- 检测到新版本后会在后台下载
- 下载完成后会提示用户重启应用完成安装
- macOS 菜单和 Windows 托盘菜单都提供手动检查更新入口

当前 updater 元数据地址配置为：

```text
https://github.com/hi-fullmoon/TermBridge/releases/latest/download/latest.json
```

### 发布 GitHub Release

仓库内置了一键发布脚本：

```bash
# 首次使用时创建本地发布配置
cp .env.example .env.local

# 在 .env.local 中填写：
# TAURI_SIGNING_PRIVATE_KEY_PASSWORD=...

gh auth login
pnpm release:github -- --version 0.1.1 --notes "Release v0.1.1"
```

如果你直接执行脚本，也可以这样调用：

```bash
bash scripts/release-github.sh --version 0.1.1 --notes "Release v0.1.1"
```

发布脚本会按以下优先级读取根目录环境文件：

- 先读取 `.env`
- 再读取 `.env.local`
- `.env.local` 中的值会覆盖 `.env`

推荐做法：

- 把示例变量保留在 `.env.example`
- 把真实密钥口令写在本地 `.env.local`
- `.env` 和 `.env.local` 都已加入 Git 忽略，不会被提交

这个脚本会处理版本同步、构建、生成 updater 元数据并上传 Release 资产。

## 当前限制

- 暂未实现 `known_hosts` / 主机指纹校验管理
- 暂未接入系统钥匙串级别的密码安全存储
- 暂未实现端口转发、代理跳板、分屏窗格等高级连接能力
- 上传暂不支持符号链接
- 使用系统默认应用打开远程文件时，会先下载到本地临时目录
- 删除进度当前支持展示，但不支持取消
- 当前主要以 macOS 和 Windows 作为目标平台

## 常见排查

### `cargo metadata` 执行失败

通常是 Rust 未安装，或者 `cargo` 还没有加入 PATH。先确认：

```bash
cargo --version
```

如果依然失败，重新加载 Rust 环境：

```bash
source "$HOME/.cargo/env"
```

### 只看到前端页面，但 SSH 不能用

大概率是你运行了 `pnpm dev`。真实 SSH / SFTP 功能需要通过 `pnpm tauri:dev` 启动桌面端。

### 构建后应用图标没有更新

先重新执行：

```bash
pnpm tauri:build
```

如果安装后的图标仍然是旧的，通常是系统图标缓存未刷新，删除旧安装包后重新安装即可。

## 后续方向

这个项目已经覆盖了 SSH 会话和常用文件管理的主链路，后续可以继续沿这些方向演进：

- 更完善的安全能力
- 更强的连接编排能力
- 更丰富的终端高级特性
- 更完整的发布与升级体验

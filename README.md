# TermBridge

TermBridge 是一个基于 Tauri 2、React 和 Rust 构建的跨平台 SSH 桌面工具，当前面向 macOS 和 Windows。

它提供多会话终端、历史连接管理和内置远程文件管理，适合用作轻量 SSH / SFTP 工作台。

## 技术栈

- 桌面框架：Tauri 2
- 前端：React + TypeScript + Tailwind CSS
- 终端渲染：xterm.js
- 后端：Rust + `ssh2`
- 支持平台：macOS、Windows

## 当前功能

- SSH 连接表单，支持密码认证和私钥认证
- 历史连接保存、删除
- 可选保存连接信息
- 可选保存密码
- 多标签终端会话
- 终端尺寸自动同步远端 PTY
- 会话状态提示与异常关闭提示
- 远程文件管理器
- 远程目录手动输入和跳转
- 文件 / 文件夹右键菜单
- 新建文件、新建文件夹
- 远程重命名、复制、粘贴、删除
- 文件属性查看
- 复制名称、文件路径、目录路径
- 使用系统默认应用打开远程文件
- 拖拽上传文件或文件夹
- 上传进度展示
- 上传取消
- 删除进度展示
- 右上角 Toast 操作提示
- 应用图标打包配置

## 项目结构

```text
.
├── src/                     # React UI
├── src/components/          # 终端、侧栏、文件管理器等组件
├── src/lib/                 # 前端工具函数与 profile 持久化
├── src-tauri/               # Tauri / Rust 后端
├── src-tauri/icons/         # 应用图标资源
├── package.json
└── README.md
```

## 环境要求

### Node.js

建议使用 Node.js 18 及以上。

### Rust

需要安装 Rust 工具链，并确保 `cargo` 在终端可用。

macOS:

```bash
curl https://sh.rustup.rs -sSf | sh
```

Windows:

- 安装 Rustup
- 安装 Visual Studio C++ Build Tools

### Tauri 前置

首次构建 Tauri 应用前，请确认本机已经满足 Tauri 2 的系统依赖。

如果终端提示 `cargo: command not found`，说明 Rust 环境变量还没有生效。可以先执行：

```bash
source "$HOME/.cargo/env"
```

或者重新打开终端后再运行。

## 安装依赖

```bash
npm install
```

## 开发

启动前端开发服务器：

```bash
npm run dev
```

启动 Tauri 桌面开发模式：

```bash
npm run tauri:dev
```

当前脚本会优先从 `~/.cargo/bin` 查找 `cargo` 和 Tauri CLI。

## 构建

```bash
npm run tauri:build
```

构建完成后，可在 `src-tauri/target/` 下查看对应平台产物。

## 数据存储说明

- 历史连接信息保存在前端本地存储中
- 勾选“保存密码”后，密码会随连接信息一起保存在本地存储
- `passphrase` 当前不会持久化保存

## 当前限制

- 暂未实现 known_hosts / 主机指纹校验管理
- 暂未实现系统钥匙串级别的密码安全存储
- 暂未实现端口转发、代理跳板、分屏窗格
- 上传暂不支持符号链接
- “使用默认应用打开远程文件”会先把文件下载到本地临时目录再打开
- 删除进度当前支持展示，不支持取消

## 常用排查

### `cargo metadata` 执行失败

一般是 Rust 未安装，或 `cargo` 不在 PATH 中。

### 安装后没有显示应用图标

请重新执行：

```bash
npm run tauri:build
```

项目已经配置好打包图标资源。若系统仍显示旧图标，通常是系统缓存导致，删除旧安装包后重新安装即可。

## 说明

这个项目目前更接近可持续迭代的桌面客户端基础版本，已经具备 SSH 会话和常用文件管理主链路，后续可以继续在安全性、连接能力和终端高级特性上扩展。

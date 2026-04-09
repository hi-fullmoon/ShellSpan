# TermBridge

一个跨端 SSH 桌面工具骨架，目标体验参考 WindTerm，产品名为 TermBridge，技术栈如下：

- UI: Tauri 2 + React + TypeScript
- Terminal: xterm.js
- Backend: Rust + `ssh2`
- Target: macOS / Windows

## 当前已实现

- 左侧连接面板：主机、端口、用户名、认证方式配置
- 已保存主机列表：本地 `localStorage` 持久化，不保存密码和 passphrase
- 多标签终端工作区：类似桌面 SSH 客户端的 tab 体验
- xterm.js 终端渲染：自动适配窗口尺寸并同步 PTY 大小
- Rust 侧 SSH 会话线程：连接、认证、启动 shell、收发数据、关闭会话
- Tauri 事件桥：`ssh-status`、`ssh-data`、`ssh-closed`

## 项目结构

```text
.
├── src/                     # React UI
├── src-tauri/               # Rust / Tauri backend
├── package.json
└── README.md
```

## 启动方式

### 1. 安装 Node 依赖

```bash
npm install
```

### 2. 安装 Rust 与 Tauri 前置

macOS:

```bash
curl https://sh.rustup.rs -sSf | sh
```

Windows:

- 安装 Rustup
- 安装 Visual Studio C++ Build Tools

然后安装 Tauri CLI 依赖并确认 `cargo` 可用。

## 开发模式

```bash
npm run tauri:dev
```

如果你只想先调 UI：

```bash
npm run dev
```

## 构建

```bash
npm run tauri:build
```

## 后续建议迭代

- 主机指纹校验与 known_hosts 管理
- 密码/密钥的系统级安全存储
- SFTP 文件管理
- 端口转发与隧道配置
- 多窗格分屏
- 命令片段、主题、快捷键体系
- 连接配置的 JSON / SQLite 持久化

## 注意事项

- 当前实现优先保证“终端会话主通路”可落地，适合作为第一版基础架构。
- Rust 侧使用 `ssh2`，跨平台能力较强，但首次编译依赖 Rust 工具链。
- 项目默认按 UTF-8 处理终端输出；如果后续需要 GBK/Shift-JIS，可在 Rust 侧加编码转换层。

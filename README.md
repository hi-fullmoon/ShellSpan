# ShellSpan

> 产品路线图：[docs/product-roadmap.md](./docs/product-roadmap.md)

ShellSpan 是一个面向运维场景的桌面 SSH 客户端，把终端、SFTP 文件管理与凭证安全整合进同一个应用。

无需在多个工具之间来回切换：一个窗口里快速连接服务器、开终端执行命令、拖拽传输文件，密码与私钥统一托管在系统钥匙串中，轻量、顺手、开箱即用。

最新版本与安装包可从 [GitHub Releases](https://github.com/hi-fullmoon/ShellSpan/releases/latest) 获取。

> [!IMPORTANT]
> ShellSpan 正在积极开发中，功能、界面和配置格式可能会持续调整。欢迎通过 [GitHub Issues](https://github.com/hi-fullmoon/ShellSpan/issues) 反馈问题和建议。

## 功能特性

### 终端

- 快速创建 SSH 连接，在同一窗口内管理多个终端标签页
- 支持密码与私钥两种认证方式，凭证可保存到系统钥匙串
- 支持跳板机（Jump Host）连接，打通内网主机
- 主机密钥校验与 Known Hosts 管理，拦截中间人攻击
- 连接断开可一键重连，支持本地终端会话
- 终端外观可定制：字体、配色方案、字号、光标样式、右键行为等
- 支持端口转发（Port Forwarding）

### SFTP 文件管理

- 远程 / 本地双栏文件浏览，支持拖拽、右键菜单
- 上传 / 下载带实时进度、速率与取消能力
- 远程到远程复制，走临时文件暂存、支持断点续传
- 批量删除带 rsync 式进度反馈
- 文件书签、内容预览、属性查看与权限编辑
- 冲突策略可配置（询问 / 覆盖 / 跳过）

### 工作台

- 连接管理：增删改查、搜索、最近连接
- Known Hosts 管理
- 钥匙串面板：集中管理已保存的密码与私钥
- 日志面板：查看前端 / 后端日志，支持筛选与导出
- 设置中心：外观、通用、终端、SFTP、快捷键五个分区
- 内置自动更新（Tauri Updater）

### 终端 Agent

- 通过结构化工具调用在发起任务的同一个 PTY 中执行、读取结果并验证状态，不从普通文本或 Markdown 猜测命令
- 提供“请求批准”“帮我批准”“完全访问权限”三档权限；新连接始终默认“请求批准”
- 冻结任务发起时的终端身份，切换标签、断线、重连或目标变化都不会把命令转移到其他会话
- 支持逐条批准或拒绝、停止、超时和 Ctrl-C；模型请求与工具等待会一起收敛
- 模型回传、会话持久化和本地操作历史均经过秘密脱敏，应用重启不会重放命令或恢复完全访问权限
- Stable 默认开放，仍可在“设置 → AI 助手 → 终端 Agent”中关闭

## 技术栈

| 层 | 技术 |
|----|------|
| 前端 | React 19 · TypeScript · Vite · Tailwind CSS 4 |
| 终端 | xterm.js |
| 状态管理 | Zustand |
| UI | shadcn/ui 风格组件 · lucide-react · @dnd-kit · TanStack Virtual |
| 国际化 | react-intl-universal（zh-CN / en-US） |
| 后端 | Tauri 2 · Rust |
| 远程能力 | ssh2 · portable-pty |
| 存储 | rusqlite · 系统钥匙串（keyring） |

## 开发

### 环境要求

- Node.js ≥ 24（< 25）
- pnpm
- Rust 与 Tauri 2 所需系统依赖，参见 [Tauri 官方文档](https://v2.tauri.app/start/prerequisites/)

### 常用命令

```bash
pnpm install          # 安装依赖
pnpm dev              # 仅启动前端（Vite，端口 1420）
pnpm tauri:dev        # 启动完整 Tauri 桌面应用（开发模式）
pnpm build            # 前端类型检查 + 构建
pnpm test             # 运行单元测试（Vitest）
pnpm tauri:build      # 构建桌面安装包
```

## 终端 Agent 与 MiniMax

ShellSpan v2.1 内置 MiniMax 官方兼容接口预设，不需要 OpenAI 帐号或 OpenAI API Key：

1. 打开“设置 → AI 助手”，选择“添加厂商 → MiniMax 官方兼容接口”。
2. 确认协议为“OpenAI Chat Completions 兼容”、服务地址为 `https://api.minimaxi.com`、模型为 `MiniMax-M2.7`。
3. 在应用内输入自己的 MiniMax API Key，测试连接，并按需设为默认厂商。
4. 在终端中打开 AI 面板，显式选择 Agent 模式和当前连接的权限档位后再发送任务。

API Key 只应在应用的厂商设置中输入；不要把凭证写入仓库、命令行、聊天、日志或提交记录。厂商 API Key 保存在本机 ShellSpan 数据库中。高权限模式可能执行修改或破坏性命令，批准前应核对完整冻结目标与命令；“完全访问权限”只对当前连接实例生效，重连或重启后不会恢复。

完整配置、安全边界、停止与审批行为见[终端 Agent 使用指南](./docs/terminal-agent.md)。

## 项目定位

ShellSpan 当前专注于两条简洁、顺手的远程运维主链路：

- 快速创建 SSH 连接，并在同一窗口管理多个终端会话
- 通过 SFTP 浏览和管理远程文件

如果你想要一个比纯命令行更直观、又比重量级 IDE 更轻的桌面 SSH 客户端，这个项目就是围绕这个方向设计的。

## 开源协议

本项目基于 [MIT License](./LICENSE) 开源。

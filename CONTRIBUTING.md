# 贡献指南

感谢你的贡献！请遵循以下规范，以确保代码质量和一致性。

## 开发环境

- **Node.js**: >=24 <25（推荐使用 nvm）
- **包管理器**: pnpm 10.33.0
- **Rust**: latest stable（用于 Tauri）

```bash
# 安装依赖
pnpm install

# 启动开发服务器
pnpm dev

# 启动 Tauri 开发模式
pnpm tauri:dev

# 构建
pnpm build

# 运行测试
pnpm test
```

## 提交规范

> **注意**: 所有 git commit message 必须使用英文。

我们遵循 [Conventional Commits](https://www.conventionalcommits.org/) 规范。

### 格式

```
<type>(<scope>): <subject>

<body>

<footer>
```

### 类型

| 类型 | 用途 | 示例 |
|------|------|------|
| `feat` | 新功能 | `feat(term): add split pane support` |
| `fix` | 修复 bug | `fix(ui): resolve button click issue` |
| `docs` | 文档更新 | `docs(readme): update install guide` |
| `style` | 代码格式 | `style: format code` |
| `refactor` | 代码重构 | `refactor(store): refactor settings store` |
| `perf` | 性能优化 | `perf(term): optimize terminal rendering` |
| `test` | 测试相关 | `test(hooks): add useTerminal tests` |
| `chore` | 工具/构建 | `chore(deps): upgrade dependencies` |
| `ci` | CI 配置 | `ci: add automated tests` |
| `build` | 构建系统 | `build: configure vite optimization` |
| `revert` | 回滚 | `revert: revert feat(term) split pane` |

### 作用域

- `ui` - UI 组件
- `term` - 终端功能
- `settings` - 设置面板
- `i18n` - 国际化
- `store` - Zustand 状态存储
- `hook` - 自定义 Hook
- `tauri` - Tauri 后端/命令
- `deps` - 依赖更新
- `build` - 构建配置
- `test` - 测试

### 示例

```
feat(term): add split pane support

- implement left/right split layout
- add drag-to-resize split panes
- each pane has independent session

Closes #123
```

```
fix(ui): resolve settings panel scroll lag

- remove unnecessary re-renders
- optimize with React.memo
```

```
chore(deps): upgrade React to 19.2.5
```

## 代码规范

### TypeScript

- 启用严格模式 (strict: true)
- 禁用 `any`，使用 `unknown` + 类型守卫
- interface: PascalCase（例如 `TerminalConfig`）
- type 别名: PascalCase（例如 `ThemeType`）

### React

- 使用箭头函数的函数组件
- props 类型命名为 `XxxProps`（例如 `ButtonProps`）
- 自定义 Hook 以 `use` 为前缀
- useEffect 依赖数组必须完整
- 使用函数式状态更新

### 文件组织

```
src/
  components/       # 可复用 UI 组件
    Button.tsx
    Terminal/
      index.tsx
      Terminal.tsx
      TerminalHeader.tsx
      types.ts
  hooks/            # 自定义 Hooks
    useTerminal.ts
  stores/           # Zustand 状态存储
    settingsStore.ts
  lib/              # 工具函数
    utils.ts
  types.ts          # 全局类型
  locales/          # 国际化
```

### 命名规范

- 组件文件: PascalCase.tsx
- 工具文件: camelCase.ts
- 常量: UPPER_SNAKE_CASE
- CSS 类: 优先使用 Tailwind，自定义类使用 kebab-case

## 提交前检查清单

提交前请确认：

- [ ] `pnpm build` 成功（tsc + vite build）
- [ ] `pnpm test` 通过
- [ ] 无 `console.log` / `debugger` / `TODO`
- [ ] commit message 符合规范
- [ ] Tauri 命令已测试（如修改了 `src-tauri/`）

## 自动化提交前检查

Git Hooks 已配置为自动检查：

1. **提交信息格式** - 必须符合 Conventional Commits
2. **调试代码检测** - 标记 console.log / debugger / TODO
3. **大文件警告** - 改动超过 500 行时警告
4. **TypeScript 检查** - 运行 `tsc --noEmit`

## 代码审查

所有提交都需要经过代码审查。审查重点：

### 安全性
- Tauri 命令参数校验
- 不得暴露敏感路径
- 终端输入净化

### 性能
- 避免不必要的重渲染
- 大数据列表使用虚拟滚动
- 终端输出缓冲区管理

### 可访问性
- 键盘导航
- 正确的 ARIA 标签
- 颜色对比度

## 问题反馈

发现 bug 或有功能建议？请创建 issue：

1. 使用清晰的标题
2. 描述复现步骤（针对 bug）
3. 说明预期行为
4. 提供环境信息（操作系统、Node 版本等）

## 许可证

提交代码即表示你同意以 MIT 许可证授权。

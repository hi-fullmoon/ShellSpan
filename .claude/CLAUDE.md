# TermBridge 项目规范

## 项目信息
- **技术栈**: React 19 + TypeScript 6 + Vite 8 + Tauri 2 + Tailwind CSS 4
- **包管理器**: pnpm 10.33.0
- **Node 版本**: >=24 <25
- **测试框架**: Vitest + @testing-library/react + jsdom

## 提交规范

> **注意**: 所有 git commit message 必须使用英文。

### 格式
```
<type>(<scope>): <subject>

<body>

<footer>
```

### 类型
| 类型 | 用途 |
|------|------|
| feat | 新功能 |
| fix | 修复 bug |
| docs | 文档更新 |
| style | 代码格式（无功能改动） |
| refactor | 代码重构 |
| perf | 性能优化 |
| test | 测试相关 |
| chore | 构建/工具/依赖 |
| ci | CI/CD 配置 |
| build | 构建系统 |
| revert | 回滚 |

### 作用域
- `ui` - UI 组件
- `term` - 终端功能
- `settings` - 设置面板
- `i18n` - 国际化
- `store` - Zustand 状态管理
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
- enum: PascalCase + UPPER_SNAKE_CASE 值（例如 `enum ColorScheme { DARK = 'dark' }`）
- 泛型参数: T, K, V 或有意义的名称

### React
- 使用箭头函数的函数组件
- props 类型命名为 `XxxProps`（例如 `ButtonProps`）
- 使用 React.FC 或显式返回类型
- 自定义 Hook 以 `use` 为前缀
- useEffect 依赖数组必须完整
- 使用函数式状态更新（例如 `setState(prev => ...)`）

### 文件组织
```
src/
  components/       # React 组件
    ui/             # 基础 UI 组件（shadcn/ui 风格）
    layout/         # 布局组件
    terminal/       # 终端功能组件
    sftp/           # SFTP 功能组件
    workbench/      # 工作台组件
    titlebar/       # 标题栏组件
  hooks/            # 全局自定义 Hooks
  stores/           # Zustand 状态存储
  lib/              # 工具函数 / logger
  types/            # 全局类型定义
  locales/          # 国际化资源
  styles/           # 全局样式 / CSS 变量
```

### 命名规范
- 组件文件: PascalCase.tsx
- 工具文件: camelCase.ts
- 常量: UPPER_SNAKE_CASE
- CSS 类: 优先使用 Tailwind，自定义类使用 kebab-case

### 禁止事项
- 提交中不得包含 console.log / debugger
- 不得有无对应 issue 的 TODO
- 不得硬编码密钥/密码
- 不得有无用导入
- 不得有类型错误（tsc 必须通过）

## 审查重点

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

## Tauri 特定规范

### 命令命名
- snake_case
- 模块前缀: `term_`, `settings_`, `window_`

### 错误处理
- 所有命令返回 `Result<T, String>`
- 前端统一处理错误

### 权限
- 最小权限原则
- 新权限需在 capabilities 中声明

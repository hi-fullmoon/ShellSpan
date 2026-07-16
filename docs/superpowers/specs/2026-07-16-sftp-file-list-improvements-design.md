# SFTP 文件列表与面包屑交互改进设计

## 日期

2026-07-16

## 背景

当前 TermBridge SFTP 模块使用自定义虚拟列表（`SftpFileList`）展示文件。为了提升操作效率，需要在文件列表顶部固定显示“..”返回上一层，支持表头三态排序，并改进路径面包屑的展示与溢出处理。

## 目标

1. 文件列表最顶部固定展示“..”行，用于返回上一层目录，不随排序改变位置。
2. 表头点击支持“升序 / 降序 / 默认”三种状态切换。
3. 面包屑根目录显示 `/`。
4. 面包屑根据容器宽度动态防溢出，超出时中间用 `...` 表示，每个分段最大宽度 200px。

## 范围

- 修改 `SftpFileList` 及相关子组件。
- 修改 `PathBreadcrumb` 组件。
- 影响 `SftpPane` 以透传必要的导航回调。
- 不改动后端命令或 store 数据结构。

## 非目标

- 不引入新的后端能力。
- 不改变文件列表的视觉风格或列布局。
- 不改动 SFTP 重构计划（2026-07-16-sftp-refactor）中的右键菜单、弹窗等任务。

## 关键设计决策

- “默认”排序状态：恢复为初始默认排序，即 `name` 列升序、目录优先。`default` 状态下不显示排序箭头。
- 溢出处理：保留根目录和当前目录两段可见，中间被折叠的分段用 `...` 按钮替代。
- 实现方式：采用模块化提取方案，保持与现有 SFTP 重构风格一致。

## 详细设计

### 1. “..” 返回上一层行

#### 新增组件：`SftpParentRow`

- 文件：`src/components/sftp/sftp-parent-row.tsx`
- 视觉与 `SftpFileListRow` 保持一致，使用相同的网格列布局。
- 名称列显示“..”图标 + “..”文字。
- 其他列（修改时间、大小、类型等）显示 `--` 或省略，保持行高一致。
- 不响应拖拽（不绑定 `useDraggable`）。
- 批量模式下不显示勾选框。
- 点击或双击均触发 `onParentDirectory()`。
- 右键点击触发与空白区域相同的上下文菜单（通过 `onBlankContextMenu`）。

#### 修改 `SftpFileList`

- 接收新属性 `currentPath?: string` 和 `onParentDirectory?: () => void`。
- 判断当前路径是否为根目录：
  - `path === ''` 视为根目录。
  - `path === '/'` 视为根目录。
  - 本地路径以 Windows 盘符开头（如 `C:/`）且分割后只有一段时，视为根目录，不显示“..”。
- 在非根目录时，把“..”行作为 `sortedEntries` 的第一项，且不参与 `compareEntries` 排序。
- 过滤搜索时仅过滤真实 `entries`，不隐藏“..”行。
- 选择逻辑：
  - 批量模式下点击“..”不进入选择范围，而是触发返回上一层。
  - 非批量模式下点击“..”不更新 `selectedPaths`。
- 虚拟列表 count = `sortedEntries.length + (showParent ? 1 : 0)`，渲染时 index 0 对应“..”行。

### 2. 表头三态排序

#### 状态定义

```ts
type SftpFileListSortColumn = 'name' | 'modifiedAt' | 'size' | 'kind';
type SftpFileListSortDirection = 'asc' | 'desc' | 'default';
```

#### 状态机

- 当前未排序或 `default` 状态：点击某列 → 该列 `asc`。
- 当前列 `asc`：再次点击 → 该列 `desc`。
- 当前列 `desc`：再次点击 → `default`。
- 点击不同列 → 切换到新列 `asc`。

#### 排序实现

- `default` 状态下，实际排序使用初始默认规则：`name` 升序，目录优先。
- 当 `sortDirection !== 'default'` 时，按 `sortColumn` 和 `sortDirection` 排序。
- 目录优先规则只在按 `name` 或 `kind` 排序时生效。

#### 表头渲染

- 只在 `sortDirection !== 'default'` 时显示排序箭头。
- 当前列处于 `default` 时，表头无高亮箭头，但保持可点击 hover 效果。

### 3. 面包屑根目录显示 `/`

#### 修改 `PathBreadcrumb`

- 根目录（`path === ''` 或 `path === '/'`）时，仅显示一个 `/` 按钮。
- 非根目录时，第一个按钮显示 `/`，后面依次显示各分段。
- 点击 `/` 调用 `onNavigate('/')`。
- 去掉根目录的 `FolderIcon` + `homeLabel` 组合，统一为纯文字 `/`。
- 每段仍保留 `FolderIcon` 作为文件夹图标（可选，保留现有风格）。

### 4. 面包屑溢出处理

#### 容器测量

- 使用 `ResizeObserver` 监听面包屑容器宽度。
- 内部维护所有分段的自然宽度（`span` 测量或预设 `max-width`）。
- 每个分段按钮最大宽度 200px，文本 `truncate`。

#### 溢出策略

- 如果所有分段总宽度 + 分隔符宽度 <= 容器宽度，则全部显示。
- 如果超出：
  - 始终保留第一段（`/`，根目录）和最后一段（当前目录名）可见。
  - 中间被折叠的分段用一个 `...` 按钮替代。
  - 动态调整：
    - 从中间向两侧折叠，直到总宽度 <= 容器宽度。
    - 当容器变宽时，逐步展开被折叠的分段。
- 被折叠的分段数 > 1 时，仍只显示一个 `...` 按钮。

#### 数据结构

- 使用 `useMemo` 根据 `path` 生成分段数组：`segments: string[]`。
- 使用状态 `visibleRange: { start: number, end: number }` 控制显示哪些分段。
- 使用 `useLayoutEffect` 根据测量结果调整 `visibleRange`。

## 组件拆分

| 文件 | 职责 |
|------|------|
| `src/components/sftp/sftp-parent-row.tsx` | 渲染“..”返回上一层行 |
| `src/components/sftp/sftp-file-list.tsx` | 管理排序状态、注入“..”行、虚拟列表 |
| `src/components/sftp/sftp-file-list-header.tsx` | 表头渲染，支持三态排序指示 |
| `src/components/sftp/path-breadcrumb.tsx` | 渲染面包屑，根目录 `/`，溢出处理 |
| `src/components/sftp/sftp-pane.tsx` | 传递 `currentPath` 和 `onParentDirectory` 给 `SftpFileList` |

## 数据流

1. `SftpPane` 计算 `currentPath` 和 `handleParentDirectory`，传递给 `SftpFileList`。
2. `SftpFileList` 根据 `currentPath` 决定是否显示“..”行，并管理 `sortColumn` / `sortDirection`。
3. `SftpFileList` 渲染 `SftpFileListHeader` 和虚拟列表；index 0 渲染 `SftpParentRow`，其余渲染 `SftpFileListRow`。
4. `PathBreadcrumb` 独立测量容器宽度并计算可见分段。

## 测试策略

- 为 `SftpFileList` 补充测试：
  - 非根目录显示“..”行。
  - 排序切换不改变“..”位置。
  - 过滤搜索保留“..”行。
  - 三态排序循环 `asc -> desc -> default`。
  - 点击“..”触发 `onParentDirectory`。
- 为 `PathBreadcrumb` 补充测试：
  - 根目录显示 `/`。
  - 非根目录以 `/` 开头。
  - 溢出时渲染 `...`。
  - 每个分段最大宽度 200px。
- 运行 `pnpm test` 和 `pnpm tsc --noEmit`。

## i18n

- 无新增用户可见字符串。`..` 为固定符号，`...` 为固定符号。

## 风险与缓解

| 风险 | 缓解 |
|------|------|
| 虚拟列表注入“..”行后索引偏移影响选择/范围选择 | 在选择逻辑中把“..”行单独处理，不参与选择和范围计算。 |
| 面包屑测量导致布局抖动 | 使用 `useLayoutEffect` 和 `ResizeObserver` 同步调整，避免多次渲染闪烁。 |
| 路径以 Windows 盘符开头时根目录判断错误 | 本地路径检测增加 `parts.length === 1 && /^[A-Za-z]:$/.test(parts[0])` 分支。 |
| 三态排序与现有 `SftpFileListSortDirection` 类型冲突 | 扩展类型为 `'asc' \| 'desc' \| 'default'`，并在组件中兼容。 |

## 批准

本设计已由用户确认，按方案 2（模块化提取）实施。

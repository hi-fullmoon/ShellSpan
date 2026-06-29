# 设置弹框 UI 调整实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让设置弹框在切换 tab 时高度固定、滚动条紧贴右边缘，并移除数字设置项的右侧滑动条。

**架构：** 重构滚动容器方案。将滚动容器从 `SettingsPanel` 上提到 `SettingsDialog`，由弹窗层级统一管理滚动；`SettingsPanel` 仅负责渲染当前 tab 内容；`PreferenceNumber` 只保留数字输入框。

**技术栈：** React + Tailwind CSS + 自定义 CSS

---

## 文件结构

| 文件 | 职责 | 变更类型 |
|------|------|----------|
| `src/components/SettingsDialog.tsx` | 设置弹框容器，负责固定高度和滚动容器 | 修改 |
| `src/components/SettingsPanel.tsx` | 设置面板，负责 tab 切换和各类设置项渲染 | 修改 |
| `src/styles/settings.css` | 设置弹框相关样式 | 修改 |

---

## Task 1: 修改 SettingsDialog.tsx 固定高度并上移滚动容器

**Files:**
- Modify: `src/components/SettingsDialog.tsx:20-31`

**Interfaces:**
- Consumes: `SettingsPanel` 保持现有 props 不变（`preferences`、`onChange`）。
- Produces: `DialogPanel` 增加固定高度；新增滚动容器包裹 `SettingsPanel`。

- [ ] **Step 1: 修改 DialogPanel 高度并添加滚动容器**

将 `DialogPanel` 改为固定高度，并在 `SettingsPanel` 外侧增加滚动容器：

```tsx
// 修改前
<Dialog open={open} onClose={onClose}>
  <DialogPanel className="flex max-h-[80vh] w-full max-w-lg flex-col overflow-hidden">
    <DialogHeader
      className="flex items-start justify-between gap-3 px-4 pt-4 pb-2 shrink-0"
      closeLabel={t('settings.close')}
      description={t('settings.description')}
      kicker={t('settings.subtitle')}
      onClose={onClose}
      title={t('settings.title')}
    />
    <SettingsPanel onChange={onChange} preferences={preferences} />
  </DialogPanel>
</Dialog>

// 修改后
<Dialog open={open} onClose={onClose}>
  <DialogPanel className="flex h-[560px] max-h-[80vh] w-full max-w-lg flex-col overflow-hidden">
    <DialogHeader
      className="flex items-start justify-between gap-3 px-4 pt-4 pb-2 shrink-0"
      closeLabel={t('settings.close')}
      description={t('settings.description')}
      kicker={t('settings.subtitle')}
      onClose={onClose}
      title={t('settings.title')}
    />
    <div className="min-h-0 flex-1 overflow-y-auto">
      <SettingsPanel onChange={onChange} preferences={preferences} />
    </div>
  </DialogPanel>
</Dialog>
```

- [ ] **Step 2: 验证修改**

检查 `src/components/SettingsDialog.tsx`：
1. `DialogPanel` 包含 `h-[560px]` 和 `max-h-[80vh]`。
2. `SettingsPanel` 被包裹在 `div.min-h-0.flex-1.overflow-y-auto` 中。

- [ ] **Step 3: Commit**

```bash
git add src/components/SettingsDialog.tsx
git commit -m "feat(settings): fix dialog height and move scroll container to dialog level"
```

---

## Task 2: 修改 SettingsPanel.tsx 移除内容区滚动和 range slider

**Files:**
- Modify: `src/components/SettingsPanel.tsx:78-109`, `src/components/SettingsPanel.tsx:228-242`

**Interfaces:**
- Consumes: `preferences` 和 `onChange` props 不变。
- Produces: `PreferenceNumber` 不再渲染 range slider；`settings-content` 不再负责滚动。

- [ ] **Step 1: 移除 PreferenceNumber 中的 range slider**

将 `PreferenceNumber` 组件中右侧的 `type="range"` 输入框删除，只保留左侧数字输入框：

```tsx
// 修改前
<label className="settings-field" htmlFor={id}>
  <span className="settings-field-label">{label}</span>
  <div className="flex items-center gap-2">
    <Input
      className="settings-select w-20 text-center"
      id={id}
      max={max}
      min={min}
      size="sm"
      onChange={(event) => {
        const next = Number(event.target.value);
        if (!Number.isNaN(next)) {
          onChange(Math.max(min, Math.min(max, next)));
        }
      }}
      step={step ?? 1}
      type="number"
      value={value}
    />
    <Input
      className="flex-1"
      max={max}
      min={min}
      onChange={(event) => {
        const next = Number(event.target.value);
        if (!Number.isNaN(next)) {
          onChange(Math.max(min, Math.min(max, next)));
        }
      }}
      step={step ?? 1}
      type="range"
      value={value}
    />
  </div>
  <span className="settings-field-hint">{hint}</span>
</label>

// 修改后
<label className="settings-field" htmlFor={id}>
  <span className="settings-field-label">{label}</span>
  <Input
    className="settings-select w-20 text-center"
    id={id}
    max={max}
    min={min}
    size="sm"
    onChange={(event) => {
      const next = Number(event.target.value);
      if (!Number.isNaN(next)) {
        onChange(Math.max(min, Math.min(max, next)));
      }
    }}
    step={step ?? 1}
    type="number"
    value={value}
  />
  <span className="settings-field-hint">{hint}</span>
</label>
```

- [ ] **Step 2: 移除 settings-content 的 overflow-auto**

将 `settings-content` 的滚动职责去掉，仅保留 padding：

```tsx
// 修改前
<div className="settings-content h-0 flex-1 overflow-auto px-2 pb-2">

// 修改后
<div className="settings-content px-2 pb-2">
```

- [ ] **Step 3: 验证修改**

检查 `src/components/SettingsPanel.tsx`：
1. `PreferenceNumber` 只保留一个 `type="number"` 的 `Input`。
2. `settings-content` 不再包含 `h-0 flex-1 overflow-auto`。

- [ ] **Step 4: Commit**

```bash
git add src/components/SettingsPanel.tsx
git commit -m "feat(settings): remove range slider and content scrolling from SettingsPanel"
```

---

## Task 3: 清理 settings.css 并验证测试

**Files:**
- Modify: `src/styles/settings.css:107-109`
- Test: `src/__tests__/appSettings.test.tsx`

**Interfaces:**
- Consumes: 修改后的 `SettingsDialog` 和 `SettingsPanel` 样式。
- Produces: 清理不再需要的 `.settings-content` 最小高度定义。

- [ ] **Step 1: 调整 .settings-content 样式**

`.settings-content` 不再负责滚动，移除 `min-height`：

```css
/* 修改前 */
.settings-content {
  min-height: 340px;
}

/* 修改后 */
.settings-content {
  /* min-height removed; height is now controlled by the dialog-level scroll container */
}
```

或直接删除 `.settings-content` 规则块（如果不再需要任何样式）。

- [ ] **Step 2: 运行相关测试**

```bash
npm test -- src/__tests__/appSettings.test.tsx
```

预期：所有测试通过。

- [ ] **Step 3: 运行完整测试套件（可选但推荐）**

```bash
npm test
```

预期：全部测试通过。

- [ ] **Step 4: Commit**

```bash
git add src/styles/settings.css
git commit -m "style(settings): clean up settings-content css after scroll container move"
```

---

## Task 4: 启动应用并手动验证

**Files:**
- 验证对象：`src/components/SettingsDialog.tsx`、`src/components/SettingsPanel.tsx`、`src/styles/settings.css`

- [ ] **Step 1: 启动开发服务器**

```bash
npm run dev
```

- [ ] **Step 2: 手动验证**

打开应用后打开设置弹框，验证：
1. 切换不同 tab 时，弹框高度保持不变。
2. 内容区滚动条紧贴弹窗右边缘。
3. 数字设置项（终端字体大小、行高、历史记录上限）只显示数字输入框，没有滑动条。
4. 在较小窗口下，`max-h-[80vh]` 仍然生效，弹框不会超出视口。

---

## 自审检查

### Spec 覆盖检查

| Spec 要求 | 对应 Task |
|-----------|-----------|
| 切换 tab 时设置弹框高度固定 | Task 1 |
| 内容滚动条紧贴弹窗右边缘 | Task 1, Task 2 |
| 数字设置项移除右侧滑动条 | Task 2 |
| 样式清理与测试通过 | Task 3, Task 4 |

### Placeholder 检查

- [x] 无 "TBD"、"TODO" 等占位符
- [x] 所有步骤包含具体代码
- [x] 所有步骤包含具体命令

### 类型一致性检查

- [x] `SettingsPanel` props 未改变（`preferences`、`onChange`、`showTabs`）
- [x] `PreferenceNumber` 参数签名未改变

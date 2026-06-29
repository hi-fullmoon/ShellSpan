# 设置弹框 UI 调整设计文档

## 日期

2026-06-29

## 背景

当前 TermBridge 应用的设置弹框在切换 tab 时，弹窗高度会随当前 tab 内容变化；内容滚动条与弹窗右边缘之间存在内边距；数字设置项同时包含数字输入框和滑动条，视觉上较拥挤。

## 目标

1. 切换 tab 时设置弹框高度保持固定。
2. 内容滚动条紧贴弹窗右边缘。
3. 数字设置项移除右侧滑动条，仅保留数字输入框。

## 设计方案

采用**重构滚动容器方案（方案 B）**：将滚动容器上提到弹窗层级，header 和 tab bar 固定，下方内容统一滚动。

### 固定弹窗高度

- `SettingsDialog.tsx` 中 `DialogPanel` 设置固定高度，例如 `h-[560px] max-h-[80vh]`，并保持 `flex flex-col overflow-hidden`。
- 切换 tab 时，弹窗整体高度不再随内容变化，仅内容区滚动。

### 滚动条贴右边框

- 在 `SettingsDialog.tsx` 中新增滚动容器包裹 `SettingsPanel` 的内容区，由该容器负责 `overflow-y-auto`。
- `SettingsPanel.tsx` 中的 `settings-content` 不再负责滚动（去掉 `overflow-auto`），仅渲染当前 tab 内容。
- Tab bar 固定在最上方，滚动容器紧贴 tab bar 下方到弹窗底部。
- 滚动容器不加右侧内边距，内容卡片保留原有 `px-2 pb-2` 内边距，使滚动条视觉上与弹窗右边缘对齐。

### 数字输入框调整

- `SettingsPanel.tsx` 的 `PreferenceNumber` 组件中删除 `type="range"` 的 `Input`，只保留左侧 `type="number"` 的 `Input`。
- 保留数字输入框的 `w-20` 宽度并居左显示。

## 涉及文件

1. `src/components/SettingsDialog.tsx` - 固定弹窗高度并新增滚动容器。
2. `src/components/SettingsPanel.tsx` - 移除内容区滚动、移除 range slider。
3. `src/styles/settings.css` - 微调 `.settings-content` 的样式，去掉 `min-height` 或 `overflow` 相关定义。

## 实施计划

1. 修改 `src/components/SettingsDialog.tsx`，固定高度并上移滚动容器。
2. 修改 `src/components/SettingsPanel.tsx`，移除 `settings-content` 的 `overflow-auto` 并删除 `PreferenceNumber` 中的 range input。
3. 调整 `src/styles/settings.css` 中 `.settings-content` 的样式。
4. 运行现有测试，确认不破坏设置弹框相关功能。

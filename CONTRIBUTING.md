# Codex 提交与注释规范

本规范用于约束 Codex 在本仓库中的提交行为与注释风格。

## 1. 提交原则

1. 单一职责：一次提交只做一件事。
2. 最小变更：只提交与当前任务直接相关的文件。
3. 可追踪：提交信息必须说明「改了什么」和「为什么改」。
4. 不混入无关改动：若工作区有其他改动，先只暂存目标文件再提交。

## 2. Commit Message 格式

统一使用 Conventional Commits：

```text
<type>(<scope>): <subject>
```

要求：

1. `type` 必填，使用小写。
2. `scope` 可选，建议填写模块名（如 `ssh`、`terminal`、`ui`、`file-manager`）。
3. `subject` 必填，使用英文，简洁明确，建议不超过 72 个字符。
4. 不使用句号结尾，不写空泛描述（如 `update code`）。

常用 `type`：

1. `feat`: 新功能
2. `fix`: 缺陷修复
3. `refactor`: 重构（不改行为）
4. `perf`: 性能优化
5. `docs`: 文档变更
6. `test`: 测试相关
7. `chore`: 构建/工具/杂项
8. `style`: 纯样式或格式调整（不改逻辑）

示例：

```text
fix(ssh): improve session stability with keepalive
feat(file-manager): add upload progress indicator
docs(readme): rewrite quick start section
```

## 3. 提交注释（Body）规范

当改动较大、风险较高或行为有变化时，必须添加 body：

```text
<type>(<scope>): <subject>

Why:
- 背景问题/触发场景

What:
- 关键改动点 1
- 关键改动点 2

Risk:
- 可能影响面
- 回滚或验证方式
```

## 4. Codex 提交前检查清单

提交前必须满足：

1. `git diff --staged` 仅包含本任务相关改动。
2. 本地编译/测试至少通过与改动相关的最小检查。
3. 不得把无关文件一起提交。
4. 不使用 `--amend` 覆盖无关已暂存内容；如必须 amend，先确认 staged 内容。

建议命令：

```bash
git add <target-files>
git diff --staged
git commit -m "fix(ssh): improve keepalive handling"
```

## 5. 代码注释规范（给 Codex）

目标：注释解释「为什么」，不是重复「做了什么」。

1. 优先写在复杂逻辑、边界条件、协议约束处。
2. 避免无信息注释（如“给变量赋值”）。
3. 注释应与代码一致，修改逻辑时同步更新注释。
4. TODO 注释必须包含责任和意图。

TODO 格式：

```text
TODO(<owner>): <next action or constraint>
```

示例：

```rust
// Keepalive is required here to reduce idle disconnects behind NAT.
session.set_keepalive(true, SSH_KEEPALIVE_INTERVAL_SECS);
```

## 6. 给 Codex 的执行指令（可复制到提示词）

```text
请严格遵守仓库根目录 CONTRIBUTING.md 的「Codex 提交与注释规范」：
1) 使用 Conventional Commits；
2) 一次提交只包含当前任务相关文件；
3) 大改动必须写 Why/What/Risk body；
4) 注释解释 why，不重复 what。
```

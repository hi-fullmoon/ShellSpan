# TermBridge × Petdex Phase 4 准入评估

<!-- petdex-phase4-decision: blocked -->
<!-- petdex-phase4-implementation: not-authorized -->

> 评估日期：2026-08-28
>
> 决策：`BLOCKED — Phase 4 未准入`
>
> 范围：仅准入评估；本轮是“记录阻断结论”，未实施 Phase 4 产品能力
>
> 机器可读快照：[admission-evaluation.json](./petdex-phase4/admission-evaluation.json)

## 1. 结论

Phase 4 **不准入**。前置的严格命令：

```bash
pnpm petdex:phase3:gate -- --as-of 2026-08-28
```

返回 `collecting` 和退出码 `1`。真实台账仍为观察第 0 天、0 名明确 opt-in 用户、0 条等量需求证据、Day-7 为 0/0、0 条定性反馈，且安全复核未完成。`collecting` 不是 `pass`，所以仅这一项已经阻断 Phase 4；其余五组实现前证据也都尚未补齐。

本轮没有打开或镜像 Petdex 目录，没有下载、解压或缓存资产，没有加入内嵌角色、独立悬浮窗口或原生渲染代码，也没有用计划、假数据、上游字段推断或本地自动化替代真实用户证据。

## 2. 证据口径

- Phase 3 用户证据以 [运行手册](./petdex-phase3-study.md)、[真实聚合台账](./petdex-phase3/evidence-ledger.json)、[严格 schema](./petdex-phase3/evidence-ledger.schema.json) 和 [门禁脚本](../scripts/petdex-phase3-gate.mjs) 为准。
- 资产字段与上游能力只引用 [Phase 0 固定日期验证记录](./petdex-phase0-validation.md)，本轮不访问目录端点，也不刷新、下载或缓存生产资产。
- “仓库中没有 Phase 4 实现”来自对当前工作区中 Petdex、manifest、spritesheet、checksum、cache、window、resource baseline 和 rollback 相关路径的只读检索；既有 loopback 状态桥接不算目录、资产或原生渲染证据。
- 每项状态都必须由可复核证据满足；计划、设计意图和其他阶段的局部证据只记录为输入，不计为通过。

## 3. 逐项准入审计

| 准入项 | 当前证据 | 当前缺口 | 状态 |
| --- | --- | --- | --- |
| Phase 3 真实用户门禁 | 2026-08-28 严格门禁为 `collecting` / exit 1；真实台账为 opt-in 0、等量证据 0、Day-7 0/0、定性反馈 0、安全复核未完成 | 必须在真实 14–28 天截止后满足 ≥30 名/等量有引用证据、全部试用用户 Day-7 覆盖且保持启用率 ≥30%、有引用的安全复核确认严重事件为 0，并有引用的状态感知价值反馈 | **阻断**（硬前置） |
| 资产可机读许可、署名、来源、版本、下架状态 | Phase 0 快照记录 manifest 有 `submittedBy`、资产 URL、`spriteVersionNumber`，上游有 takedown 流程 | 没有逐资产 `license` / `rights` / `copyright`；`submittedBy` 不能表达完整署名义务；URL 不是不可变来源证明；`spriteVersionNumber` 不是资产内容版本或摘要；manifest 没有 active/withdrawn 状态。还缺 TermBridge 对已预览、已下载、已打包和已缓存副本的撤回规则 | **阻断** |
| 下载校验和缓存清理 | 路线图只列出未来应限制内容类型、文件数、大小、解压总量、图片尺寸和缓存总量；仓库没有 Phase 4 下载器、摘要台账或缓存策略 | 缺可信摘要来源、失败关闭校验、原子写入、归档/图片验证、损坏恢复、配额、离线语义；缺用户清理、自动逐出、下架清理、卸载清理及相应测试 | **阻断** |
| 跨平台窗口原型 | 当前仅有固定 loopback 的外部 Petdex Desktop 状态桥接；没有 Phase 4 窗口原型或平台结果矩阵 | Phase 3 通过后才可定义支持平台并验证透明/置顶/穿透点击/拖拽、焦点与无障碍、虚拟桌面、多屏与 DPI、生命周期、签名和权限；还需记录平台失败与回滚 | **阻断** |
| 资源占用基线 | 现有性能工具针对终端路径；没有目录、内嵌角色或悬浮渲染器基线 | 缺经批准的 OS/硬件矩阵、对照构建、采样时长和资源预算；缺 idle/动画/多屏场景的 CPU、内存、GPU、唤醒、启动影响及超预算失败口径 | **阻断** |
| Petdex 格式版本兼容与回滚 | Phase 0 已记录 manifest v1/v2、`spriteVersionNumber` 以及已知 8×9 / 8×11 精灵图族；TermBridge 当前不解析这些格式 | 缺受支持版本矩阵、固定 fixtures、未知/损坏版本失败关闭；缺 last-known-good 元数据/资产回滚、应用降级兼容、缓存 schema 迁移、下架处置和完整关闭功能的回滚路径 | **阻断** |

上述六项中任何一项阻断，都不能把 Phase 4 标为准入。当前是六项全部阻断，而不是“已准入、待实现”。

## 4. 自动防误宣称检查

运行：

```bash
pnpm petdex:phase4:audit
```

该命令重新计算真实 Phase 3 台账，核对机器可读 Phase 4 快照，并检查本文件与 roadmap 的决策/实现授权标记。当前正确结果应是“一致地 blocked”，因此审计命令成功；这只证明阻断记录自洽，不代表准入。

真正执行 Phase 4 准入硬门禁时使用：

```bash
pnpm petdex:phase4:gate
```

它在当前状态必须非零退出。测试还覆盖：当 Phase 3 不是 `pass` 时，即使有人把快照或文档标成 `admitted`，一致性审计也会失败。

## 5. 重新评估的确切触发条件

只有同时出现以下可复核变化，才重新作 Phase 4 准入决定：

1. 在 2026-09-11 至 2026-09-25 的真实截止日冻结 Phase 3 台账，完成全部证据引用，并让 `pnpm petdex:phase3:gate -- --as-of <真实截止日>` 返回 `pass` / exit 0。
2. 提供逐资产可机读的许可、署名要求、不可变来源、内容/格式版本和 active/withdrawn 状态，并有能撤回 TermBridge 全部副本的下架流程证据。
3. 提供不依赖生产资产下载的完整下载/校验/缓存/清理设计与自动化证据；随后仅在重新授权的阶段任务中验证实现。
4. Phase 3 通过后，在明确支持的平台矩阵上完成可复现窗口原型记录，并同时产出经批准预算下的资源基线。
5. 提供格式兼容矩阵、固定测试 fixtures、未知版本失败关闭、last-known-good 与完整禁用/降级回滚演练证据。
6. 将机器快照六项改为有证据的 `met`，同步两份文档标记，再让 `pnpm petdex:phase4:audit` 和 `pnpm petdex:phase4:gate` 都通过。

仅时间到达、样本仍在收集、某一项局部完成、上游发布新版本或自动化测试本身通过，都不会触发准入。

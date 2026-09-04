# Stage 7：唯一批准的 Phase 5 基线变化

场景：`pagination-560-light-completed-1x`。

旧截图第二轮前重复显示相同 system prompt。main `31ce4343` 的 prompt snapshot
去重使这个重复 marker 消失，第二轮内容相应上移。正文、统计、面板宽度和 composer 均未改变。
其余 17 场景在首次逐场景比较中像素及语义均一致，没有更新。

- [原语义](pagination-before.json)
- [当前截图](../ai-panel-phase5/evidence/screenshots/pagination-560-light-completed-1x.png) /
  [当前语义](../ai-panel-phase5/evidence/semantic/pagination-560-light-completed-1x.json)
- 更新原因保存在 [原基线 manifest](../ai-panel-phase5/evidence/manifest.json)。

更新使用原脚本的单场景 `--update` / `--reason`，没有批量重录或降低像素判断。
Stage 7 为原脚本增加失败时的 before/after 截图及 JSON 保留；连续 capture 不一致时也保存两份证据，
仍直接失败，不自动重试。最终完整 18 场景套件连续两次通过，每场景内部仍比较两次独立 capture。

一次与另一浏览器套件并行的诊断运行出现 provider-error 场景连续截图不同；未更新该场景基线。
后续新增证据保留并独立运行后未复现，不能据此断言已确认其根因或修复。

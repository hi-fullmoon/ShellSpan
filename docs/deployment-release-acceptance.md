# Deployment Runbook v2 阶段 5 发布验收

验收基线：阶段 1 `53c077d` → 阶段 2 `82cc472` → 阶段 3 `d7fccf1` → 阶段 4 `424a1ef` → 阶段 5 当前提交。

## 产品闭环

- [x] Workbench 有独立 **部署** 入口；后续移除 Runbook v1 不影响此部署入口与语义执行链。
- [x] 两套内置模板通过 v2 解析器；占位符、制品摘要、release/systemd/health/rollback 摘要可见。
- [x] 支持文件导入/导出和只读规范化 JSON。
- [x] profile 显式选择、有序 rollout、canaryRolling 和人工批次门可见。
- [x] 后端 review 返回后冻结 document/target/order/policy；编辑只能废弃 review。
- [x] 单主机、金丝雀和下一批次分别使用精确审批文案。
- [x] 批次/主机结果、健康证据、部分成功、熔断原因和 recoveryRequired 可见。
- [x] Rollback suggestion 只进入独立 rollback review/approval，不触发自动回滚。

## 安全与恢复

- [x] UI 不生成 Shell，不成为执行授权源；所有执行仍消费后端 review/approval。
- [x] 凭证只经现有 profile/keychain prompt 临时传给 IPC，不进入草稿、localStorage、operation history 或 DOM。
- [x] 后端不可用、目标漂移、review 过期和迟到结果失败关闭。
- [x] 重启恢复必须新 review；已成功主机跳过，未完成主机不自动重放。
- [x] 回滚审批绑定 source operation、target、current/previous release、plan 和 risk。

## 自动化证据

- `src/lib/__tests__/deployment-workflow.test.ts`：模板、v1 分流、冻结/失效、顺序与秘密快照。
- `src/components/workbench/__tests__/deployment-panel.test.tsx`：单主机 review 冻结、明确审批和成功结果。
- `src/components/workbench/__tests__/deployment-workflow.e2e.test.tsx` + `tests/fixtures/deployment-runbook/v2/ui-workflow-e2e.json`：不依赖真实 SSH 的 canary 失败熔断、未启动主机、回滚建议与独立回滚审批。
- 阶段 2–4 既有 TypeScript/Rust 测试继续覆盖执行状态机、取消、重启封存、跳过成功主机、批次门、迟到结果和持久化秘密清理。

## 发布门禁结论

2026-08-28 发布候选验收结果：

- `pnpm exec tsc --noEmit`：通过。
- 聚焦 Deployment/v1/IPC 测试：8 个文件、63 项通过。
- `pnpm test`：160 个文件、1284 项通过。第一次并发运行仅 `useI18n` 的 5 秒等待偶发超时；该文件单独复跑通过，未改产品代码，随后默认全量复跑全部通过。
- `pnpm build`：通过；保留 Vite 既有大 chunk 警告，不影响本阶段验收。
- `pnpm test:scripts`：4 个文件、43 项通过；`pnpm check:roadmap`：通过，20 个产品 workstream 审计一致。
- 1280 × 900 与 390 × 844 的独立面板实渲染检查通过：无水平溢出，双栏可降为单栏，头部操作可换行，Dialog 有标题，Esc 关闭后焦点返回触发按钮。完整浏览器壳因缺少 Tauri 原生 IPC 按既有错误边界关闭；没有伪造后端成功。
- `cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check`：通过。
- `cargo test --manifest-path src-tauri/Cargo.toml --locked deployment -- --test-threads=1`：被已知 Windows GNU/OpenSSL 环境问题阻断。`openssl-sys` 选择 `MSWin32-x64-multi-thread` Perl，因不能生成 Unix 路径而退出；已立即停止环境排查，未提交 workaround。

结论：阶段 5 前端、契约集成、mock/fixture E2E、构建、脚本和审计门禁通过，可作为 Deployment Runbook v2 用户工作流发布候选；Rust 运行门禁仍受既有 Windows GNU/OpenSSL 工具链阻断，需在受支持的 Rust CI/开发环境复核后签署二进制发布。

## 保留限制

流量/负载均衡器、动态发现、任意 Shell、无人审批自动回滚和后台 GC 均不在本阶段发布范围内。

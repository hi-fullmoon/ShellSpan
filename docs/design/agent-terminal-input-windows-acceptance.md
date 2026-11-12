# Windows 原生终端历史验收记录

本页保留 2026-11-07 批次的一期自动安全结果及原始证据索引。当前安排见[后续实施计划](agent-terminal-input-implementation-plan.md)，执行标准见[统一验收标准](agent-terminal-input-acceptance-checklist.md)。

## 验收基线与边界

本批基线为 `0bf9ec139fc2747a07c5b5184118d45d8a157891`。证据只覆盖对应冻结范围。C02/C03/E04 的人工分支未执行，当时未开放生产配置。

| 本地绑定 | 独立核验要求 |
| --- | --- |
| Windows PowerShell 5.1.26100.9818/private PSReadLine 2.4.5-shellspan6 | 实际 Shell/程序集/模块摘要、编辑器线程、ConsoleHost、ConPTY 及实际 App |
| PowerShell 7.6.9/private PSReadLine 2.4.5-shellspan6 | 同上；不得用另一宿主的结果替代 |

ConPTY 记录实际来源/版本，历史绑定为 1.25.260930003。系统安装及用户执行策略不修改。升级版本须登记新绑定，旧结果保留原版本。

模型曾将 8192 字节输入改为 8189 字节，或返回字面转义，相关调用均未批准。D04 的横向重排批次只有光标查询和定位控制帧，新增正文时的视口行为仍缺证据。

## 保护账本与旧失败

沿用用户授权的替代保护基线：`.artifacts/tests/agent-terminal-input/20261107-windows-946/authorized-baseline.json`。本批最新已核验附加清单为 `20261107-windows-phase1-1142/additional-protection.json`，含 370 条附加保护；另有原基线 20 条和原始不可变记录 7 条。清单含账本与证据，不能把全部数量写成 SQLite 数量；后续执行须核对最新有效清单及实际摘要。最终交付封存索引见1118，不以本文数字替代现状。

原 203 账本目录丢失和 872 整案失败永久保留原事实，未恢复、未通过。任何新增丢失、内容漂移或旧缺失路径重新出现都停止依赖批次，不建立空账本、不移除记录或重放原操作。新账本仅在该案确认结束后追加保护。本文清理的只是冗余 Markdown，不触碰任何账本、证据、凭据或构建目录。

## 历史证据索引

以下仅证明原冻结范围。本地证据在 Git 忽略目录，跨机器须取得原归档并核验；摘要、正文记录或代码合入不能替代原始证据。

| 历史范围 | 索引与结论 |
| --- | --- |
| C02 自动安全矩阵 | 968/973/976/979，981 汇总；两宿主七阶段×两动作共 28/28，人工触发分支未关闭 |
| D01/横向重排显示 | 1035 冻结、1037 原生 App、1038 审计、1042 八组合、1043 独立复核、1044 代表图；168 完整状态与 120 视口检查点匹配；D04 新增正文仍缺 |
| 前端/工具链复核 | 1040 原 3449/3失败/6跳过保留；1048 定向39通过；1049 完整报告3452通过/6跳过但原汇总后置失败、子进程退出码未持久化；1051 MSVC Rust契约0；1052 Cargo条件文件补充发现后有效3452名称匹配，不声称原整条门禁0 |
| 最新历史台账 | 1047/coverage-matrix.json：350 行中4通过、55待验、7失败、262阻塞、22不适用；通过是旧冻结的 A01/D01×两个 Windows 绑定，不能直接用于当前 HEAD |
| 已封存归档 | 1045/sdk6-windows-d04-visible-output-evidence.zip，66361553字节，SHA-256 `3a91cffbba34e7bb86a49244d3a2c869a150fa884c31ac03102867a700c47885`，逐对象解压回验；对应1047索引归档保留最终文档及范围审查 |

以上数字目录均相对 `.artifacts/tests/agent-terminal-input/`。旧日期版 Windows 长篇记录和候选批次工具说明已合并至本文及统一标准；原文保留于 Git 历史和本机 `.artifacts/tests/acceptance-docs-reorg-20261107/originals/`，原始验收记录不删。

## 一期本批结果

本 Goal 在 HEAD `0bf9ec139fc2747a07c5b5184118d45d8a157891` 加保留的工作区改动上重新冻结2151个文件，源码清单 SHA-256 `7e6d03e5de27c13e507b30ac693c87724b023a31daf2767a5b1a2aa43b69907c`。运行前后源码与实际工作区逐项一致；交付阶段仅本文状态更新另作差异冻结。MSVC 子进程显式选择1.95.0，不修改系统默认工具链。

一期自动安全规范子案183项通过：每个宿主90项，另3项Windows公共账本组件探针；其中原生App逻辑子案90项（84有模型、6无模型）、组件93项。C02自动28项、存储22项、真实原生进程崩溃/重启12项、尾部捕获4项及raw拒绝2项均有当前直接证据；独立持久化探针、组件、API模拟输入与人工证据分别统计。人工执行为0，完整C02/C03/E04父项仍待验。

当前相关回归：前端选中671通过/4跳过，脚本319通过/1跳过；Rust terminal219通过/14忽略、agent_runtime643通过/19忽略，分别保留原过滤器和逐名报告，不相加冒充唯一全量测试。显式补跑资源准备14条件和真实管道8条件；最终普通测试发现仍为同一3506个名称，新增验收测试/嵌套快照未进入发现。3506发现不等于3506执行通过。

重建并实际加载的原生模块SHA-256为 `0ef7ae48c0b67704142e15e0f8b9c3cb00419fea73eb9b961045cc01983919da`，私有PSReadLine程序集为 `065630b6224d8a0f47f192ec4a51e532812665f3e63743a4183f544029847e65`。SDK绑定为ConPTY1.25.260930003，实际文件版本1.25.2609.30003。202份实际App PE留存逐字节核验、98种实际PE摘要、68份实际ConsoleHost程序集回执与8组精确PDB/源码绑定分开索引，不声称所有测试使用同一个PE。

规范成功模型子案记录114次模型请求启动、96次已批准工具调用；实际HTTP重试/网络请求总数无法完整证明，保留未知。raw在正常准备层拒绝，未产生审批请求或原生调用，不把它写成已审批执行。原203丢失、872失败及本次所有失败/未知原件不改写；各新复验使用新目录与身份。全局只读审计核验878个原身份和206个案例目录，无所属活动残留。证据/未知意图及故障物理文件留存，不建立空账本绕过围栏。

最终依赖核验覆盖35900个文件和2085个链接。固定code-inspector插件在本批构建期间产生的唯一record.json新增项，已按同一固定源码在隔离目录逐字节复现并精确纳入冻结，未扩大排除、未手工修改node_modules。其余安装依赖字节/链接不变。

- [一期报告与结论](../../.artifacts/tests/agent-terminal-input/20261107-windows-phase1-1118/report.md)
- [双宿主逐子案表](../../.artifacts/tests/agent-terminal-input/20261107-windows-phase1-1118/subcases.md)和[34条一期范围义务](../../.artifacts/tests/agent-terminal-input/20261107-windows-phase1-1118/requirements.md)
- [命令与实际退出码](../../.artifacts/tests/agent-terminal-input/20261107-windows-phase1-1118/command-exit-index.json)、[制品/进程/程序集索引](../../.artifacts/tests/agent-terminal-input/20261107-windows-phase1-1118/artifact-process-identity-index.json)
- [修复与新复验关联](../../.artifacts/tests/agent-terminal-input/20261107-windows-phase1-1118/fixes-and-retests.md)、[后续阶段交接](../../.artifacts/tests/agent-terminal-input/20261107-windows-phase1-1118/handoff.md)

结论仅为一期自动安全范围通过。未开放生产能力、发布、部署、创建worktree/commit/tag或推送；二期完整功能/模型、三期人工/显示和四期最终质量/SSH门禁仍独立待验。

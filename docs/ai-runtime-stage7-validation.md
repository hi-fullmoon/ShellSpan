# Stage 7 — 最终累计集成与验收（2026-09-04）

## 结论与证据等级

累计 Stage 1–6D 及本轮修复已安全接入 `/Users/zhengbiwen/Developer/ShellSpan`。
HEAD 保持 `31ce4343b9a834503c43db1b04b81fe0128e4ea0`，未暂存、提交、推送或运行远端 CI。
本机可执行范围已验收；**Windows 原生编译、运行、junction/reparse 仍为 NOT RUN，不能宣称总目标完成**。

| 证据 | 实际范围 | 不能推导的结论 |
| --- | --- | --- |
| macOS arm64 Rust/前端 | Node24.15.0、pnpm11.1.1、Rust1.95.0；本地文件/日志/取消/恢复 | 不是 Windows 原生验证 |
| 本地实际 HTTP/SSE | 生产 Provider adapter、真实套接字、请求体、usage、分块/断连/重试；模型响应为确定性 fixture | 不是外部模型 live |
| 隔离 Linux SSH/SFTP | Docker disposable project、生产 SSH/profile/known-host 路径、normal/missing-Python | 不是 Windows 文件系统或任意远端主机验证 |
| Chromium UI/桥接 | 生产 controller/adapter/IPC payload/Rust；仅桌面传输替换为 loopback | 不是原生 Tauri 应用完整桌面验收 |
| 外部 live | 本项目现有配置：MiniMax、DeepSeek high/off，3执行/3通过/5跳过 | 不代表 Qwen/GLM/Kimi/OpenAI/通用兼容已 live 通过 |

Rust 仅使用已授权的命令级缓存
`CARGO_TARGET_DIR=/Users/zhengbiwen/.codex/worktrees/ad7b/ShellSpan/src-tauri/target`。
没有读取或复制其他项目密钥，没有改变全局工具链。最终命令时间、退出码、日志 SHA-256 和摘要在
[结构化结果](ai-runtime-stage7-validation-results.json)，完整本机诊断日志位于 `/tmp/shellspan-stage7-irjMaV/`。
失败的中间运行保留为诊断，不覆盖或计作最终 PASS。

## 接收与保留

1. 冻结源 `6461/ShellSpan` 的 HEAD 与 main 相同；核对 inventory SHA-256
   `ae5faca192b2fe6471f2b33dd6221e2b60208f209d3ee4bdb0c27e3c4dbce633`。
2. 核对 stage patch `6dd0b7ee1e1ffa96fd75458cf30d11d9c2dff304c634025c9f64cb28617bf78d`
   与 cumulative patch `87371fcf0d21a0485b546cf8601df7d7627fa2b014ba6afa78dfd082abcb5ddc`。
3. 先在 `7f92` 隔离目录 check/apply，复制68个新增产品及14份历史元数据，160/160累计文件匹配；
   再检查 main HEAD/index/用户差异/同名文件冲突，按同样程序安全接收，160/160再次匹配。
4. 用户既有 `input-group.tsx` 完整 SHA-256 始终为
   `b88fb8fb45dc6f988a553d31174915c34ad6fc1e2aa327548b8cdacacc1d5418`；
   index 字节始终为 `7deee642128e942abef40bb5a6e858b84a487a553a3cfe25ea6c5d9248cabe16`。
5. 保留 main `1ac0c1e4` 跨 series Turn 聚合、`31ce4343` request/start/prompt snapshots 去重和 pnpm 修复。
   6D源、历史6A–6D元数据和 Harness 保持只读。最终 AI 补丁排除用户 InputGroup 差异，单独记录它。

[最终 inventory](ai-runtime-stage7-handoff/inventory.json) 列明累计产品、全部新增文件、历史元数据、
相对6D的最终差异及各自哈希。两个精确基线的临时重建结果和清单哈希见同目录 `reconstruction.json`。
迁移不能只拿 tracked patch；必须另外复制清单内全部新增产品。

## 完整行为复核矩阵

以下将原修复清单逐组映射到最终累计代码的可执行 gates，不把 UI 枚举或 mock JSON 自洽当成 Runtime 实现。
历史阶段文档仅提供测试定位；最终 PASS 来自主目录本轮命令及最终全量测试。

| 原始要求 | 最终累计证据与边界 |
| --- | --- |
| Golden/门禁/保留 | 全文 `prompt_golden_crlf_checkout_matches_the_current_full_prompt`；LF属性；scripts/CI引用和所有脚本文件存在性测试；8个 include! 文件独立 rustfmt；接收/封存哈希。CRLF模拟不替代 Windows |
| 目标、约束、决定、理由、工作、文件/命令、阻塞/下一步 | `checkpoint_preserves_latest_constraints_decisions_work_and_tool_evidence` 与 semantic success 测试；旧checkpoint+新增对话共同参与，重启后仍保留决定 |
| >100KiB、早期约束、尾部撤销、预算 | `semantic_large_conversation_sees_early_constraints_and_explicit_tail_revocation`；累计输入/输出/尝试/总45s摘要期限；true budget exhaustion不替换Surface，失败/空/非法/不完整响应不能提交已知遗漏的checkpoint |
| 压缩证据/安全边界/原子恢复 | 完整Turn和未完成工具/审批阻挡；artifact/hash/引用、重算请求预算、扁平连续压缩；失败/取消/写artifact后取消、append-only batch/generation和重启。Stage4 17项compaction及全量通过 |
| 重试合同与可取消等待 | Provider可配置策略、迁移/快照/子任务继承、指数/jitter/Retry-After秒/日期/毫秒和上限；connect/header/首字节/idle独立限制，持续有输出不受固定120s总时长误杀；ready response/chunk取消优先 |
| partial/empty恢复、不重复副作用 | Stage3B同Session/step/series、新requestId、有界重试；真实HTTP partial text/reasoning/tool args→断连→503→成功，所有history相同；失败只保留审计。前一step write只执行一次，重启不重放不确定dispatch |
| finish后usage/错误边界（新增） | 独立HTTP chunk中的usage+[DONE]被保留；finish后clean EOF接受未知usage，异常chunked EOF不提交；取消与虚拟时间idle终止；完整text/tool finish后断连也走同一安全重试。实际工具不从失败attempt执行 |
| Provider共享与wire | TS/Rust同一显式contract与fixtures，profile优先hostname；Qwen/GLM/DeepSeek/MiniMax/Kimi/generic三协议实际HTTP请求/流/历史；接收reasoning≠用户thinking开关≠历史保留；MiniMax opaque details无损，GLM clear_thinking/Qwen开关按支持范围；schema/并行参数/usage/预算一致 |
| Provider live入口 | 运行全部配置条目，单个失败不提前阻止其他已配置Provider；3 PASS、5 SKIP分列。未知usage不伪造。vision仅Qwen精确白名单且未执行其外部live |
| 有界rolling pool/顺序/屏障 | 默认4、有效1–16；控制call0未完时后续补位，默认/2/1峰值、逆序完成仍按模型顺序持久化；read→write/审批/Session/update_plan/编排屏障 |
| 动态权限、子任务预算、取消/故障 | 启动前重核before-hook和能力；已保留+已提交合计预算，剩余1不启动整组；取消/after-hook/worker panic/dispatch/result/artifact/store失败停止补位并join已启动工作；not-started配对明确，不确定副作用需reconcile。18 scheduler及恢复/审批/重启专项通过 |
| 6A实际答案推进与授权 | 单答案入口重附原Session/Turn/Step；read→question→write→question保持审批；改变当前凭据后真实HTTP恢复，结构化answer不是工具授权；活跃子Agent不得调用，历史child重新作为root规则明确 |
| 6A九组风险 | 每个完整JSONL前缀、answer/result/step幂等修复；request/answer/cancel/lease可控顺序；6字段identity、operation重复/冲突、敏感原始指纹与redaction冲突、存储失败、严格schema/UTF8字节限、无自动推荐、丢事件reconnect及双投影；普通草稿保留。17 native和8浏览器场景 |
| 6B发现/策略/刷新 | 真本地flat/bundle/仓库shadcn元数据、浅层边界、duplicate winner；4策略组合/默认、YAML歧义/重复/类型/CRLF；body/policy/delete/rename刷新与空目录清空，incomplete保留last-good但revoked必须retire，退休跨压缩保留 |
| 6B调用/完整正文/恢复 | slash严格来源/token/Unicode/空白，Form答案不触发；真实模型skill工具、目录注入、完整正文和provenance；执行时重核current policy/path/hash，>8KiB正文完整抵达HTTP；XML/UTF8/完整batch/目录候选/总8MiB限；每个claim/RequestHeader/StepEnd前缀恢复，历史正文不可被后改文件替换 |
| 6B权限/目标/取消 | scoped handle/no-follow/root/component替换；remote无local fallback；真实SSH/profile/root漂移；load后预算不足零模型请求；held read、SSH handshake/deadline/owned bridge join；barrier和子Agent继承限域。32 native、controller1+1、SSH1、8浏览器；Windows未验 |
| 6C输入与不可变存储 | 4种实际解码格式、MIME/base64/名称/大小/像素、metadata去除/EXIF旋转/ICC拒绝/GIF规则/16bit→RGBA8；同hash复用、不覆盖、tampered/missing拒绝和跨Session预览拒绝 |
| 6C原子性与持久边界 | 非法第2张/第2blob失败/log失败零部分Inbox和模型调用；5取消边界，commit赢时原operation重试去重；并发相同/冲突入参；每个完整/半行前缀、压缩/restart保留typed refs |
| 6C草稿/vision/wire | A→B→A异步remove/save/cancel/import归属、durable intent先于IPC、失败固定operation、真实IndexedDB CAS；未知模型/第五张history图拒绝；Qwen plus/flash、ChatCompletions、128000保守应用预算；HTTP接收端实际decode pixels对比immutable文件，恢复follow-up保持同图。14 native、8浏览器 |
| 6D语法/交互/所有权 | 起始/空白@，邮箱排除，caret/整token替换/前后缀/空格引号/目录；键盘/指针/IME229、空/错时不误发；AbortSignal→Session+UUID取消、RAII、stale success/error/finally与A→B→A |
| 6D范围/身份/SSH | 真实目录empty/absent/denied/40结果/1024扫描/路径与component/deadline/4worker限；文件内容read sentinel禁止，补全只插普通文本；no-follow、独立目录游标、持久root身份、Skills-first/file-first；SSH空间路径/chmod000/nonUTF8/symlink/profile/root漂移/取消，missing-Python明确Unavailable无本地回退 |
| 6D真实提交/恢复/竞态 | 6种image/skill/file顺序+2text-only，exact普通prompt、无文件内容泄露、cold root明确、restart复用Session；empty/absent/plain三种回复排列控制屏障；dismiss后改写返回同词可重新查询。7 native、SSH normal1/missing-Python1、8浏览器 |
| 初始化历史与新草稿（新增） | 5个controller测试覆盖late list在draft/root/newSession之后、late open、已建立auto订阅显式撤销，显式Session正常订阅不受影响；浏览器让真实Rust历史查询延后到image+root+menu建立再返回，draft/image owner/menu全部保持 |
| UI/投影/视觉/性能 | Phase3–6、Agent Runtime、单一MessageScroller、320/400/560/720×light-en/dark-zh，32输入场景；18精确像素/语义场景；5,000消息、7,500节点、20stream revisions，preflight和有效样本检查，不新增或放宽延迟阈值 |

各组详细原测试名称见 [6A九组](ai-runtime-stage6a-validation.md)、[6B](ai-runtime-stage6b-validation.md)、
[6C](ai-runtime-stage6c-validation.md)、[6D](ai-runtime-stage6d-validation.md)、[3B](ai-runtime-stage3b-validation.md)、
[4](ai-runtime-stage4-validation.md) 和 [5](ai-runtime-stage5-validation.md)。以上没有将Windows分支实现等同于验证完成。

## 最终命令与结果

| 命令 | main结果 |
| --- | --- |
| `pnpm test` | 1502通过、1跳过；176通过文件/1跳过。唯一普通Vitest bridge跳过由专用controller入口实际执行 |
| `pnpm test:ai:phase3` / `phase4` / `phase6` | 50 / 71 / 90通过 |
| `pnpm test:agent:runtime` / `pnpm test:scripts` | 82 / 32通过 |
| `pnpm test:ai:stage6:frontend` | 71通过/9文件 |
| `pnpm test:ai:stage3` | 前端82，Rust 21+252通过 |
| `pnpm test:ai:stage4` | 前端54，Rust contract3/model25/compaction17通过 |
| `pnpm test:ai:stage3b` | 前端57，Rust 109+6+1+17通过 |
| `pnpm test:ai:stage5` | scheduler18，其他1+2+2+1+12通过 |
| `pnpm test:ai:stage6:rust` | question17/skill32/image14/file7通过；依赖fixture的ignored由下列专用入口执行 |
| `pnpm test:ai:stage6:browser` | question8/Skills8/images8/files8场景；Skills controller前端1+Rust1；图片/文件实际HTTP bridge各1 |
| `pnpm test:ai:stage6d` | 7 native、57前端、SSH normal1+missing-Python1、8浏览器通过 |
| `pnpm test:ai:phase5`，随后 `pnpm test:ai:phase5:visual` | 73前端；完整18像素/语义场景连续两次通过，每场景内部两次capture |
| `pnpm benchmark:ai-panel` | 3个普通preflight、3个实际采样工作负载通过；准确timing和样本数见结构化结果 |
| `pnpm exec tsc --noEmit` / `pnpm build` | 通过；保留既有 >500kB bundle advisory |
| `cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check` | 通过 |
| `pnpm check:rust:includes` | 8个include!文件通过 |
| `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --all-features -- -D warnings` | 通过，无lint suppression |
| `cargo test --manifest-path src-tauri/Cargo.toml --all-features --no-fail-fast` | lib601通过/26 ignored，integration5通过，binary/doc0；ignored不是通过 |
| `git diff --check` | 通过；最终清单另做哈希和精确基线重建 |

最末Rust完整验收后只改了前端所有权、性能入口及文档；Rust源哈希再次封存核验。
最末前端修改重新执行全量、focused、类型和构建；完整6D gate再次验收。
CI配置补齐 portable frontend/native、macOS browser/pixels、Linux disposable SSH 分工；
只验证了本机对应命令，没有声称 GitHub 托管流水线已经运行或通过。

## 本轮发现及修复过程

- **MiniMax live缺usage**：旧Chat parser见finish_reason即退出，忽略之后独立HTTP chunk的usage。
  现在finish与传输结束分离：只在[DONE]结束读取，clean EOF仍兼容，原idle/取消边界保留。
  增加真实分块barrier、clean/broken EOF、cancel/idle和完整tool finish失败重试测试；修复后live三项通过。
- **路径dismissed key**：Escape/Tab后离开查询再回同一文本被永久抑制。新增回归先失败后通过；
  再增加真实native empty/absent/plain回复三排列。历史6D的plain超时原因当时未建立，
  不把这个独立回归冒称为历史超时唯一根因。
- **Skills菜单消失**：本轮两次menuitem点击前detached。初始化list/open可能在新root/图片/draft之后发布旧历史。
  4个延迟回归在修复前失败，5个最终回归通过；真实Rust迟到历史屏障复验通过。
  没有延长点击等待、force click或重录截图。reload测试现等待真实恢复答案后再编辑，不拿初始空composer当恢复完成。
- **性能假通过**：原5,000消息实际还生成2,500过程节点，旧5,000节点断言报错；实验bench仍exit0/NaNx。
  保留所有输入和20次投影，修正实际7,500节点计数；抽出同一工作负载给普通测试，拒绝缺失/非法/少于5的样本。
  JSON reporter会清空raw samples但保留sampleCount，验收按实际sampleCount和有限正timing，未篡改样本。
- **格式/类型**：included Rust测试出现3处Clippy细节（slice引用、Unix权限、read量），以及新延迟测试Promise类型缺失，均修正并重新验证。

## 视觉与live证据

Phase5第一次发现唯一基线差异 `pagination-560-light-completed-1x`：main31ce去掉第二个重复system prompt marker，
第二Turn上移48px，正文/统计/输入框语义不变。只更新这一场景；before PNG/JSON和理由保存在
[视觉说明](ai-runtime-stage7-visual/README.md)，after仍在正式Phase5 baseline。其余17场景未更新。
曾有一次并行浏览器诊断的provider-error两次capture不一致；未改其基线，随后串行完整18场景连续通过。
此观察不宣称已证明其具体根因；runner现在保留不一致的两张图和语义供诊断，严格像素比较不放宽。
32个输入场景检查单一滚动系统、无页面横溢；本轮人工查看320px深浅色问答、菜单、图片草稿和路径补全截图。
遵循现有shadcn primitives和主题，保留用户InputGroup样式，没有引入第二套chat组件或更新依赖。

| 实际外部测试 | 请求数 | 结果（Provider上报，非估算） |
| --- | --- | --- |
| MiniMax-M2.7 | 1 | reasoning155 bytes/text15；input38/output58/reasoning51/total96；stop |
| deepseek-v4-flash high | 1 | reasoning96 bytes/text15；input107/output44/reasoning37/total151/cacheRead0；stop |
| deepseek-v4-flash off | 1 | text5、无reasoning块；input17/output2/total19/cacheRead0；stop |
| Qwen / GLM / Kimi / OpenAI | 0 | 缺本项目测试配置，SKIP |
| Generic OpenAI-compatible | 0 | 缺base URL/model配置，SKIP |

最初MiniMax缺usage诊断还发过1次真实请求，因此本轮总外部请求为4，最终验收3次。
只加载当前项目已有 `.env.local`，不输出响应正文、密钥或账户信息，不运行有外部副作用的模型工具。
MiniMax协议说明参考[官方OpenAI兼容接口](https://platform.minimax.io/docs/api-reference/text-openai-api)。
Qwen vision whitelist和128000应用预算来自本地显式合同；本轮没有外部Qwen看图验证。

## 剩余平台条件与真实限制

- **Windows NOT RUN**：本机仅macOS Rust target，没有可用Windows VM/Wine/MSVC执行环境。
  Docker是Linux引擎；Unix symlink/CRLF仿真、旧Stage4/5的Windows结果都不能覆盖新增6B–6D。
- 需要原生Windows checkout（包括CRLF）、Rust `1.95.0-x86_64-pc-windows-msvc`、MSVC Build Tools/Windows SDK、
  项目OpenSSL构建依赖和WebView2、Node24/pnpm冻结安装，然后运行fmt/includes、stage3/4/3B/5/6:rust、
  all-target/all-feature Clippy和全量cargo。还须做真实junction/reparse/root与中间component替换的受控竞态、
  驱动器/UNC边界、权限失败及原生桌面图片/目录交互。当前CI入口就绪不代表这些运行已发生。
- SSH normal/missing-Python保持Linux隔离服务验证；不借用真实生产目录、不将远端缺Python降级成local读取。
- 问答未发送答案草稿仅页面生命周期；图片草稿是当前设备IndexedDB，不提供跨设备迁移。
  图片无完整色彩管理/自动blob GC；目录是单层prefix发现，不提供递归fuzzy/glob/ignore语义或自动文件附件。
- 本地OS文件调用不能被强行中断，取消在调用之间检查；未持久结果的已dispatch副作用仍需人工reconcile，不自动重放。
- 总目标保持未完成；本轮只交付已证明的本机结果和封存清单，等待协调复核，不操作Goal。

# Agent 原生终端输入

当前代码采用无版本后缀命名，不提供旧命名别名、协议翻译或旧客户端兼容入口。本文说明当前实现与待验范围，不把历史结果作为当前源码的运行证明。历史实现记录保留在Git历史；原始采样字节不重写。

## 实现边界

- 原始源码、光标、输入推进和回显属于Shell编辑器及同一PTY数据流。前端不保存另一套显示源码，不改写buffer、选择、搜索或公开方法。
- Broker维护生命周期和输入准入，协调器绑定不可变源码、计划、审批、目标及完整输入证明。持久提交意图完成后再次校验，最多进行一次可能提交；不明结果不自动重放。
- 只有`native-inline`与`raw`。原生能力由实际Shell/Core/模块和私有通道验证；raw保留普通终端，但不能接收Agent源码或作业输入。
- Bash使用原生适配扩展及只读提示符列接口；ZLE使用`ZLE_NATIVE_APPEND`；PSReadLine使用公开编辑器API及PowerShell语法树。具体依赖的真实版本和校验值保留在构建配方中。
- 经明确授权的通用xterm光标重排、软换行复制修复及同流显示切换保留在维护补丁中；应用层不维护替代编辑器。
- 未验收编辑器的生产准入仍关闭。GNU目标仍要求来源清单、绑定Shell及模块摘要精确匹配，不根据名字或屏幕文字授予执行权。

## 代码与协议

| 范围 | 入口 |
| --- | --- |
| 控制协议与schema | `protocol/agent/runtime/native-input.md`、`native-input.schema.json` |
| 协调、状态、账本、资源 | `src-tauri/src/terminal_command/` |
| Shell适配扩展 | `src-tauri/native-input-adapter/`、`src-tauri/native-input-editors/` |
| 资源目录 | 仓库正式暂存 `.artifacts/releases/native-input/generated/`；包内 `native-input/generated/` |
| 原生显示 | `src/lib/terminal/native-input-display.ts`、terminal registry |
| 原生列接口 | `rl_native_prompt_columns` |
| Bash内置命令 | `ss_native_input`及同前缀私有操作 |
| 只读装饰 | `terminal-command-decorations.ts` |
| 静态边界 | `scripts/check-terminal-command-boundary.mjs` |

原生协议标识为`shellspan.native-input`，显示常量为`NATIVE_INPUT_DISPLAY`，不注册旧名称。参数类型中的必要格式校验不等于兼容实现。

## 允许的检查

当前仅允许编译、类型和静态检查，不启动App、浏览器、模型、Shell/PTY/SSH实机验收。App验收父入口默认拒绝；未来只有用户明确安排统一前台验收，才可为该次命令设置`SHELLSPAN_ALLOW_FOREGROUND_TESTS=1`，不能写入用户配置或默认脚本。

```text
pnpm build
cargo check --locked --manifest-path src-tauri/Cargo.toml --tests
pnpm check:rust:includes
pnpm check:terminal:boundary
git diff --check
```

第三方依赖版本、系统标准路径、标准API名称和原始采样数据保留真实内容。不能为去掉字样修改依赖校验值、伪造捕获或删除提交意图。发现非当前账本命名空间时仍拒绝建立空账本，以防重复执行；不迁移、重放或自动恢复旧数据。

静态审查已修正实验与正式配置标识冲突：实验配置不属于生产清单，不获得正式输出捕获与后台作业能力；正式本地配置必须匹配当前平台。对应回归已加入源码，本轮仅编译，未运行。

## 统一待验

逐项执行及证据登记以[验收清单](agent-terminal-input-acceptance-checklist.md)为准。建立清单不代表开始运行验收。

- 重新构建原生目标与资源，冻结当前源码、依赖和制品。命名及协议标识已改变，旧制品不能作为当前运行证明。
- 全新捕获验证完整输入、单次提交、取消/停止/恢复、父Shell语义、后台任务、输出与复制/搜索、Unicode、动态尺寸及历史视口。
- 核验默认拒绝的raw路径、关闭/重连和半控制序列排空；不验收旧客户端兼容。
- Windows PowerShell与ConPTY仍需受控实机验收；本轮不连接测试机。
- 已记录的焦点失败尚未定因；仅在明确验收时段用被动时间线定位，不用强制恢复焦点或另一轮通过掩盖。
- 尚有一个测试临时CredentialRef待经正常API清理。不得为清理启动App、导出密码、改写共享vault或修改系统信任/执行策略。
- 后续完整质量门禁和发布需另行安排。当前不启用未验收生产路径，不提交、推送或发布。

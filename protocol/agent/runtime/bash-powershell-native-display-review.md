# Bash 与 PowerShell 原生命令回显复查

日期：2026-10-26（上海）。基础 HEAD：`88eecce58a3024e92aa1db67677888c26e912cdf`。
修复位于主检出，保留此前 Zsh 修复；未创建提交、tag、推送或发布。

## 当前实现

- Bash 4.1+ 的前台完整脚本显示 `(exit "$?"); builtin eval -- Q`，Q 由 shlex
  引用原始脚本。状态恢复子 Shell 不包含用户脚本；脚本继续在当前 Shell 顶层执行。
  原生接收器独立校验原文和实际接受行，保留前序退出状态、别名、函数、环境与取消语义。
- Bash 后台任务显示短 `job-*` 标记与 `builtin eval -- Q` 的原生异步组，Q 由 shlex
  引用原文。标记先恢复父 Shell 的 `expand_aliases` 选项，再返回子 Shell 顶层执行 eval，
  保留脚本内逐行定义、调用别名的语义。内部校验、trap、完成通知不进入编辑器；
  查询和停止使用一次性私有描述符。
- Bash 4.x 的 READLINE_POINT 使用 UTF-8 字节偏移，Bash 5.x+ 使用字符偏移；
  字节数由已校验帧的编码总长度减去原文编码长度后除以 4 得到，不修改 LC_ALL，
  支持用户将其设为只读，调用者 locale 与原生多字节编辑保持正常。
  Bash 私有接收键使用 Ctrl-X/Ctrl-R，避免旧 Readline 让 macOS VDISCARD 吞掉 Ctrl-O。
  语法拒绝后的提示符刷新保留现有按键绑定，等真正的 PROMPT_COMMAND 再重绑，
  避免 Bash 4.x 释放其正在执行的 bind-x 命令字符串。
- Bash 的有界数据帧包含原文长度、实际行、PTY 行列与新 nonce。原生 Readline 对
  超高输入清除视口前，先将现有屏幕滚入终端历史，保留窄窗口中的早期编号输出。
  不复制命令文本或输出；显示与捕获继续使用真实原始流。
- Bash 的固定字节读取在同步命令替换子 Shell 中完成。读取子 Shell 不创建子进程，
  不接收父 Shell 后台作业退出产生的 SIGCHLD，避免旧版 read 设置终端属性时被中断。
  读取描述符只在子 Shell 中打开；成功、超时或中断后随进程关闭。原截止时间、帧格式、
  完整回执、取消/恢复门禁保留，不重放输入，也不替换用户 trap 或父 Shell 作业控制。
- PowerShell 使用短 `job-* Q` 命令，Q 为原生单引号脚本参数。PowerShell AST
  的 StringConstantExpressionAst.Value 解码原文；临时全局标记在调用者上下文探测
  StrictMode、函数和语言模式，再传给既有 console worker 与 Windows Job Object。
  原文不在标记函数中执行，prompt 只删除仍匹配本次定义的函数。
- PowerShell 的只读缓冲区确认及后台管理不再调用提示符重绘；只有真正插入源码时
  重建原生编辑器位置。管理描述符在提交前消费，查询和停止不进入屏幕或历史。
- Bash/PowerShell 私有接收器使用独立的 W 就绪事件，普通 A 缓冲区确认不能代替
  接收器就绪。只有同一操作收到正确 nonce 和空缓冲区的 M 才能提交管理动作。
- Windows PowerShell 5.1 使用应用私有的 PSReadLine 2.4.5。模块按内嵌内容摘要缓存在
  应用数据目录，仅设置子进程的 PSModulePath；系统模块和用户 profile 不改写。
  原始 DLL、签名脚本与 BSD 2-Clause 许可保留，初始化沿用旧版的无预测默认值，
  用户 profile 继续按正常顺序设置自己的选项。PowerShell 7 使用现有模块。

权限、代际、integration、Agent/task、租约和冻结源码仍逐次校验；丢失回执、迟到回执
与不确定执行不会自动重放。源码上限继续为 8192 UTF-8 字节。Bash 私有编码预算为
131072 字节，用于同时传输有界原文和实际引用行，不扩大源码或实际行上限。

## 真实验证

回显续修冻结轮次使用 macOS 原生 Bash 5.3 PTY、Windows 测试机上的 PowerShell 5.1/7 ConPTY，
实际执行源码、读写验证专用文件并等待真实进程结束。原始流通过 vt100 与 xterm 检查；
不以返回对象中的 commandLine 代替终端显示证据。

| 范围 | 当前结果 |
| --- | --- |
| Bash 180×30 | 完整脚本、heredoc、CR/Tab、8192 字节、多行别名、前序状态、取消/超时/接管、后台观察/停止通过 |
| Bash 32×30 | 长/短输入与每秒输出重叠；12 条编号输出在原始流及实际单元格中各一次且有序，通过 |
| Bash 丢失/迟到 M | 保存真实完整 BUFFER 的 M 帧，验证取消、接管、旧 nonce 不确认继任操作、截止时间后的真实 M 不解除恢复门禁，通过 |
| Windows PowerShell 5.1，32×30 | 1 passed / 187.87s；实际模块为应用私有 2.4.5，默认预测 None，连续输出及源码/进程组门禁通过 |
| Windows PowerShell 5.1，180×30 | 1 passed / 186.34s；同一源码和正常原生路径通过 |
| PowerShell 7，180×30 | 1 passed / 131.56s；既有编辑器配置、完整源码、连续输出、状态及停止通过 |
| PowerShell 7，32×30 | 1 passed / 122.40s；同一源码和正常原生路径通过 |

上述 Windows 四组由统一入口顺序执行，均实际退出 0；独立就绪 W、完整 M 与私有
接收器输入序列共同验证。临时输入计时代码已移除后再运行此轮，未延长原接收或执行
期限，未缩短 8192 字节、多字节边界及 15ms 连续输出刺激。

回显续修冻结轮次的 macOS 全量 Rust：1187 passed / 0 failed / 59 ignored（64.27s）；两份协议/入口
测试共 24 项通过，cargo fmt、56 份 Rust include、AI 样式边界、LLM catalog 和
TypeScript/Vite 构建通过。ignored 不计通过。Bash 真实宽/窄与故障注入用例另行显式执行。

最终证据保存在主检出忽略目录 `.phase4-acceptance/bash-powershell-display-20261026/`，
Windows 自有副本为 `D:\Developer\ShellSpan-display-20261026`；该目录包含各组日志、
真实原始流/单元格、编辑器元数据、默认历史摘要及统一矩阵完成记录。

Windows 原生模块实际元数据记录于各次 `*.editor.json`；默认历史使用前后解析后的字段
比较，包含路径、大小、SHA-256 与最后写入时间，不比较 JSON 对象的属性顺序。

Linux 原生桌面、其他架构、SSH 新数据接收器及完整桌面/模型 E2E 不据此扩大验收范围。

## 审核后 Bash P2 修复与兼容回归

新增真实终端回归先在旧实现上复现了两处问题：后台同批别名调用返回 127；Bash 4.4
接收 `printf '中文🙂'` 后，在 Readline 左移并插入 X，得到错误的 `printf '中X文🙂'`。
修复后的检查使用生产接收器写入完整 BUFFER，再让真实 Readline 处理移动和插入，
通过独立 bind-x 快照读取实际 BUFFER；不只检查赋给 READLINE_POINT 的数字。

Bash 4.1.0、4.4.0 从 GNU 官方
[4.1 源码](https://ftp.gnu.org/gnu/bash/bash-4.1.tar.gz)和
[4.4 源码](https://ftp.gnu.org/gnu/bash/bash-4.4.tar.gz)在本机编译为 arm64 可执行文件，Bash 5.3 使用
此前独立安装。没有提高 Bash 4.1+ 的版本下限，也没有替换系统 Bash。
正式用例在每次真实 PTY 中使用独立 HOME/HISTFILE；本轮未写用户默认历史。
后台回归同时检查 `expand_aliases` 开启时同批定义/调用成功、关闭时仍不展开，
且子任务中的别名与工作目录变化不泄漏到父 Shell。

本轮证据目录为 `.phase4-acceptance/bash-p2-20261026/`；原 Windows 结果继续绑定上方
冻结轮次，本轮未重新执行 Windows ConPTY。Bash 宽窄窗口和丢失回执的最终矩阵结果
由该目录的 `matrix-complete.json` 记录。

最终矩阵在 macOS arm64 顺序执行完成，各格均为真实的 1 passed / 0 failed：

| Bash | 180×30 PTY | 32×30 PTY | 丢失/迟到 M 与取消/接管 |
| --- | --- | --- | --- |
| 4.1.0 | 50.53s，通过 | 46.20s，通过 | 11.60s，通过 |
| 4.4.0 | 45.52s，通过 | 45.83s，通过 | 11.41s，通过 |
| 5.3 | 46.30s，通过 | 46.61s，通过 | 11.40s，通过 |

完整用例包含中文/emoji 的真实光标编辑、后台同批别名及关闭展开选项、原文语法拒绝后的
提示符恢复、8192 字节源码、heredoc、CR/Tab、父 Shell 状态、前序退出状态、连续输出
重叠、取消/超时/接管、后台观察与进程组停止。丢失回执用例保存真实完整 M，再验证
旧 nonce 和迟到回执无法确认后继操作或解除恢复门禁。未延长接收/执行截止时间。

审核后增量的全量 Rust：1188 passed / 0 failed / 59 ignored（68.24s），包含新增的
后台原文/实际 eval 行经原生 printf 解码的独立回归。三份协议/验证入口测试共 26 项通过；
cargo fmt、56 份 Rust include 格式、AI 样式边界及 TypeScript/Vite 构建通过。
验证脚本只把已记录的原始流交给 xterm，截图定位到第一处实际内容并等待原生绘制；
不因保留的空白历史行而生成空白截图，不修改、合成或过滤终端流。

## 只读 LC_ALL 光标修复

Bash 4.x 直接使用已校验帧的实际行字节数：`(编码总长度 - 原文编码长度) / 4`。
每个字节由 ASCII `\xHH` 传输，长度与对齐检查及完整读取仍在设置 BUFFER 前完成。
不设置局部或全局 LC_ALL；Bash 5.x+ 继续使用当前 locale 下的字符偏移。

真实 PTY 回归先在旧代码上复现了只读 locale 下的错误插入位置，然后覆盖普通 locale
的原文长度为 0 的帧，以及 `readonly LC_ALL` 下同时包含原文和实际 eval 行的帧。
两种情况均通过生产接收器设置 BUFFER，让真实 Readline 左移并插入 X，再读取实际
编辑缓冲区。测试同时确认没有只读变量错误，LC_ALL 保持 `C.UTF-8`，并通过子 Shell
实际尝试赋值，确认其只读属性仍然生效。完整前后台用例继续在该只读状态下运行。

本轮证据位于 `.phase4-acceptance/bash-readonly-locale-20261026/`。全量 Rust 为
1188 passed / 0 failed / 59 ignored（64.92s），协议/验证入口 26 项、cargo fmt、
56 份 Rust include 格式检查通过。本轮没有重新验证 Windows ConPTY、Linux 桌面或模型/UI E2E。

首轮 Bash 4.1 宽窗口与全量 Rust 同时运行时，在后台任务退出后发生
`read: error setting terminal attributes: Interrupted system call`，管理描述符未确认，
恢复门禁停止输入，没有自动重放。该轮 FAILED 的日志和原始流保留在证据根目录，
不计作通过；该只读 locale 轮次未修复终端属性中断，后续修复见下节。

最终顺序矩阵已完成，`serial-matrix/matrix-complete.json` 中六组均退出 0，每格为
真实的 1 passed / 0 failed；没有放宽接收或执行期限：

| Bash | 180×30 PTY | 32×30 PTY |
| --- | --- | --- |
| 4.1.0 | 46.63s，通过 | 46.73s，通过 |
| 4.4.0 | 45.98s，通过 | 46.48s，通过 |
| 5.3 | 46.86s，通过 | 47.11s，通过 |

各版本的普通/只读光标 BUFFER、原始终端流和完整脚本显示证据与日志一并保存；
三版窄窗口的完整脚本原始流另经 xterm 检查，未合成源码回显或输出。

## 后台退出期间的 EINTR 修复

Bash 4.1 的 `read -N/-s` 会调用 `tcsetattr(TCSADRAIN)` 设置终端属性，旧实现没有
在该调用被中断时重试。失败发生在后台任务 TERM/退出之后，原路径在收取这些作业
SIGCHLD 的父 Shell 中执行读取。本轮将读取移入同步命令替换子 Shell：它与父 Shell
保持同一前台进程组，使用 builtin exec/read/printf/exit，不创建自己的子进程，
因此不会收到父 Shell 后台子进程退出产生的 SIGCHLD。

固定字节描述符、编码数据、65 字节描述符中的 nonce 绑定和完整 BUFFER 回执保持原格式。
子 Shell 只接收数据，不执行用户源码；读取状态和确切长度均成功后才将结果复制回
原生编辑器。TTY 描述符在读取子 Shell 内打开，结束时关闭。读取时间从 fork 前的
原预算扣除；不延长截止时间，不重新发送输入，不替换用户 trap 或父 Shell 作业控制。

真实终端用例新增 24 轮快速自然退出（退出码 19）及 TERM/CONT 停止的重叠验证，
同时断言源码效果恰好 24 次、作业状态正确、无终端属性错误、无私有实现泄漏。
还直接发送真实截断描述符，验证原超时后读取结束，下一条用户命令正常执行；
原有只读 LC_ALL、8192 字节、连续输出、取消/超时/接管及丢失/迟到 M 用例继续运行。

最终 macOS arm64 真实 PTY 矩阵九组全部通过，每格为 1 passed / 0 failed；
六组完整用例累计新增 144 轮“自然退出＋停止”，没有终端属性错误：

| Bash | 180×30，完整用例＋24 轮退出/停止 | 32×30，完整用例＋24 轮退出/停止 | 丢失/迟到 M |
| --- | --- | --- | --- |
| 4.1.0 | 61.76s，通过 | 61.41s，通过 | 12.53s，通过 |
| 4.4.0 | 61.94s，通过 | 61.68s，通过 | 11.47s，通过 |
| 5.3 | 62.40s，通过 | 62.70s，通过 | 11.42s，通过 |

证据目录为 `.phase4-acceptance/bash-eintr-20261026/`，最终矩阵位于 `final-matrix/`。
本轮首次并发全量 Rust 中，独立的直接 `/usr/bin/printf` PTY 冒烟用例曾读到空输出；
该用例不经过 Bash 接收器，失败日志保留在 `rust-lib.log`，未修改该测试或 PTY 实现。
其单项复核通过；随后完整 `cargo test --lib -- --test-threads=4` 为 1188 passed /
0 failed / 59 ignored（76.50s）。协议/验证入口 26 项、cargo fmt、56 份 Rust include
格式检查通过。首组 Bash 4.1 宽窗口与首次全量 Rust 并发运行并通过。

Windows ConPTY、Linux 桌面、SSH 新接收器及完整模型/UI E2E 仍按各自冻结边界，
不将本轮 macOS arm64 结果外推。没有修改系统 Bash、用户 profile 或默认历史文件，
没有提交、推送或发布。

## 诊断副作用

回显续修时一次独立 Bash 基线诊断漏配 HISTFILE，当时在用户 `.bash_history` 观察到
15 条匹配该轮探测模式的记录。未清空、截断、回滚或删除用户历史。后续诊断及正式 PTY 用例使用
独立历史文件；没有把缺少前置摘要的诊断声称为“历史完全无变化”。

应用私有 PSReadLine 来源、原始包摘要与许可见
[依赖说明](../../../src-tauri/resources/powershell/README.md)。

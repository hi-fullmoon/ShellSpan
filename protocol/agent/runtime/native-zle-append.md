# ZLE native append API

标识：`shellspan.zle-native-append`。固定源码、补丁、主程序及构建目标由
`scripts/dependency-builds/zsh/pin.json`记录；实际Core必须通过严格哈希和加载映射校验。
参数存在或peer自报版本不能单独证明支持，也不能授予输入或执行权。

`ZLE_NATIVE_APPEND`是ZLE widget作用域内的special整数参数：0为普通ZLE默认绘制，1为
owned native append，其他值拒绝。它是模式开关，不是行数、终端高度、缓存或输入预算。
每次新的原生读取恢复0；普通Shell配置、COLUMNS/LINES及实际PTY尺寸不因此改变。

模式1只从ZLE自己的真实BUFFER读取新增字节，保留真实CURSOR和原生缓冲区。终端负责
换行、滚动、选择和尺寸变化；前端不维护源码副本、不投影或补写已显示内容。CR按原生
控制表示显示为`^M`，LF保留，Tab由原生提示符宽度与实际编辑前缀计算合法空格展开；
不能直接透传在右边界被裁短的HT。源码与私有完整证明保留原始LF/Tab/CR字节。

后台输出可以自然穿插输入。此场景按完整combined流、真实原生缓冲证明和每条后台记录
保全验收；无后台场景独立验证连续纯源码、搜索与光标。

真正接受时，Core在任何line-finish hook之前完成已显示源码的换行和静默交接，隐藏计划
不能再次绘制。job通知造成的暂时失效只暂停显示并保留新增偏移，不能冒充接受或丢掉真实
源尾。清稿、私有EOF及下一次读取分别恢复自己的状态，不自动提交或重放。

适配器只在owned输入范围开启1，记录并在仍匹配本操作时恢复原值。NIP的完整身份、
实际BUFFER/CURSOR证明、FULL持久意图、最终单次接受键和不明结果门禁保持原契约。
显示API或屏幕内容不能代替上述事实。生产profile准入独立关闭，逐平台待验项见
[统一验收清单](../../../docs/design/agent-terminal-input-acceptance-checklist.md)。

已绑定精确私有Main/Core的macOS Zsh 5.9组合发布Unicode 11及`unicodeScope=session`。
同一Core也使用该宽度处理普通ZLE编辑，因此普通输入和输出保持同一已验证provider，
不在原生输入结束OSC后恢复旧provider；换行重排开关仍只在owned输入区间开启。
有序排空并关闭该transport后恢复先前provider，native/raw重绑不能继承旧会话范围。
这只是显示元数据，不改变用户Shell选项、输入/审批/执行权或生产profile准入；
其他profile的显示范围不由这个macOS组合推断。

## 同一读取的源码与计划交接

macOS原生验证组合同时绑定私有Zsh 5.9主程序和Core的精确摘要。主程序从同一固定归档、
显示补丁及`native-history.patch`构建，使用固定安装前缀和隔离DESTDIR；系统`/bin/zsh`
保持原样。资源中的`{profileId}/zsh`与`zle.so`必须匹配pin，不能把新Core配给旧主程序。

`shellspan.zle-native-history`接口版本1提供`zle_native_history_api()`与
`zle_native_bind_handoff(source, plan)`。绑定只允许在已接受的顶层ZLE读取内进行，
读取真实BUFFER并与source比较，保存本次不可变plan；所有finish hook结束后再次核对
实际交出行。主程序单次消费该映射，在原生历史过滤、hook及保存策略运行之前选择
source作为历史行，以Zsh自己的lexer生成词边界。它不向已保存历史强插、删行或改写。
取消、EOF、出错或下一次读取清除映射，嵌套lexer上下文分别保存和恢复自己的状态。
主程序在keyboard-hack处理后、实际输入通道进入lexer之前再次比较计划字节；历史转义后的
文本不作为执行计划比较对象。若固定计划耗尽后仍请求续行，拒绝未绑定的额外输入并阻止执行。

读取已验证计划时不引入交互历史展开；用户的BANG_HIST选项以及普通手工输入路径不变。
历史hook得到原始源码及其正常结束换行，原HISTSIZE、SAVEHIST、HISTFILE、去重与过滤
仍由Zsh处理。`ZLE_NATIVE_HANDOFF`和只读`ZLE_NATIVE_HISTORY_API`参数用于该公开接口的
独立PTY验证，不是原生提交或执行授权。

已验证provider只在绑定后台启动计划后为对应fork子进程标记自动历史保存归父进程所有。
预先解析并核对来自同一Core的`zle_native_history_child(parentPid)`，child侧atfork回调仅
调用已绑定函数及异步信号安全的PID检查/标量赋值；不查符号、不分配内存、不执行Shell
callback或Rust状态。子进程的用户历史选项及显式`fc`写入保持可用，普通/TERM退出不重复
自动保存父历史。该接口不生成任何NIP回执，也不替代完整证明、持久意图或单次接受键。

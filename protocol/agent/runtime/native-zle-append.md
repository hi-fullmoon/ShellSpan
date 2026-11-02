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
[实现说明](../../../docs/design/agent-terminal-input.md)。

# SFTP 性能优化停止点与后续路线图

本文记录 SFTP 性能优化 Goal 在停止时的权威状态，并规定后续恢复方式。状态核对基于当前 `main` 中的两个已提交检查点：

- `5323e847351d3036bb98fc6241c2c046b3394f57`（`feat(sftp): add transfer performance baseline`）
- `b10a86585943df0059ea92130b16478ba365eded`（`perf(sftp): reuse transfer buffers`）

同时核对了 [性能基线](sftp-performance-baseline.md)、[基准脚本](../scripts/run-sftp-benchmark.ps1)、两个提交的差异和执行记录。本文不是完成报告：**当前完整 Goal 尚未完成**。

## 结论先行

| 类别 | 当前结论 |
|---|---|
| 已完成且有门禁证据 | 批次级 `connect / scan / transfer / finalize` 指标、字节数/文件数/端到端吞吐记录、指标与完整性测试、可复现 Docker 基准入口。 |
| 已提交但只是基础设施 | 上传、下载和远端复制已改为每批次一次堆缓冲分配，并跨文件、递归和重试复用；增加了仅测试构建可见的 64 KiB–2 MiB 候选入口。 |
| 不能宣称 | 不能宣称大缓冲带来性能收益，不能给出候选相对提升百分比，不能把本机 Docker debug 数据外推为 release、真实 WAN 或高 RTT 结论。 |
| 生产行为 | 生产默认仍为 **64 KiB**；候选环境变量只在 `cfg(test)` 下生效，不是生产配置面。 |
| 候选运行覆盖 | 64 KiB、256 KiB、1024 KiB 完成了相同工作负载的 debug 完整性运行；**2 MiB 未运行**。 |
| 已终止工作 | 一次 release 候选基准长时间失联，已终止并清理；没有产生可采信的 release 数据。 |
| 未完成 Goal | 大缓冲最终选型、传输连接复用与健康检查 single-flight、递归 manifest/元数据复用、受控并发与公平/取消语义、同主机服务器端复制及回退、目录请求/缓存刷新合并、最终全量集成与前后对比。 |

## 证据分级与声明规则

后续会话必须继续使用以下分级，避免把“代码存在”写成“性能已经改善”：

1. **门禁证据**：确定性的单元测试、完整测试、Clippy、脚本语法检查和传输内容/清单校验，可以证明实现与完整性约束。
2. **本机 debug 观测**：只能证明该次 debug 构建、Docker Desktop、本机负载和指定工作集下的运行结果。它不是 release 性能基线，也不是 WAN 结论。
3. **受控选型数据**：必须来自相同机器、相同构建配置、相同工作负载、相同网络条件、固定迭代数的候选对照；原始输出、失败和超时都要保留。只有这一层数据才能支持默认值选择。
4. **最终收益证据**：必须对固定的前置提交与最终提交做交错或等价的 A/B 运行，覆盖本地低延迟与代表性高 RTT 条件，并报告中位数、离散度、资源开销和完整性结果。

任一数据缺失时应明确写“未运行”“被有界终止”或“无合格数据”，不得补算、推断或伪造。

## 已完成：阶段指标与可复现基线

检查点 `5323e847351d3036bb98fc6241c2c046b3394f57` 已完成以下工作：

- 上传、下载、跨远端复制和旧同连接复制路径在每批次结束或失败时记录一条 `sftp_transfer_metrics`。
- 指标包含 `connect_us`、`scan_us`、`transfer_us`、`finalize_us`、`total_us`、`total_bytes`、`file_count` 和 `throughput_bytes_per_second`。
- 日志不包含凭证、主机名或传输路径，且没有在逐块传输热路径增加日志。
- Docker 基准覆盖 16 MiB 大文件以及 128 个 4 KiB 小文件，逐项校验指标字段与上传→远端复制→下载后的字节/文件清单。
- 基准默认使用 release、3 次迭代；`-DebugBuild` 只用于快速环境和完整性验证。

该检查点的已记录门禁证据：

- `cargo fmt --check`：通过。
- `cargo check --all-targets --locked`：通过。
- `cargo clippy --all-targets --locked -- -D warnings`：通过。
- `cargo test --all-targets --locked`：231 通过、7 ignored、0 失败。
- 新增目标单测：3 通过。
- PowerShell 脚本语法检查：通过。
- Docker debug 基准：1 个基准测试通过，6 个传输批次的指标和文件完整性均通过。

### 已有 16 MiB debug 基线

以下数字按原执行报告引用；构建为 debug、单次迭代、Docker 本机链路。**它们不是 WAN、高 RTT 或 release 结论。**

| 场景 | 操作 | connect / scan / transfer / finalize | 总耗时 | 吞吐 |
|---|---|---:|---:|---:|
| 16 MiB | 上传 | 91.730 / 18.517 / 879.963 / 0.030 ms | 990.247 ms | 16,942,445 B/s |
| 16 MiB | 远端复制 | 96.217 / 12.973 / 1247.686 / 1.271 ms | 1358.152 ms | 12,352,971 B/s |
| 16 MiB | 下载 | 87.114 / 1.326 / 374.302 / 0.004 ms | 462.750 ms | 36,255,456 B/s |
| 128×4 KiB | 上传 | 89.210 / 12.670 / 753.336 / 0.003 ms | 855.223 ms | 613,042 B/s |
| 128×4 KiB | 远端复制 | 84.260 / 90.288 / 922.295 / 0.897 ms | 1097.744 ms | 477,604 B/s |
| 128×4 KiB | 下载 | 76.579 / 116.191 / 602.154 / 0.004 ms | 794.932 ms | 659,537 B/s |

快速复现命令：

```powershell
pwsh -File scripts/run-sftp-benchmark.ps1 -Iterations 1 -DebugBuild
```

## 已提交但未完成选型：每批次堆缓冲复用

检查点 `b10a86585943df0059ea92130b16478ba365eded` 已提交以下基础设施：

- 上传、下载、新旧远端复制改为每批次创建一次 `Vec<u8>`，并跨文件、递归和远端复制重试复用。
- 抽取全量写入的块传输函数，覆盖短读、短写和精确进度字节计数。
- 修正远端复制重试/续传时已计入前缀不应重复增加进度的问题。
- 基准脚本增加 `-TransferBufferBytes`，允许 65536–2097152 字节；对应环境变量只在测试构建中读取。
- 生产常量 `DEFAULT_TRANSFER_BUFFER_SIZE` 保持 64 KiB，没有新增运行时用户配置。

该检查点的已记录门禁证据仅限：

- `cargo fmt --check`：通过。
- `cargo check`：通过。
- 5 个 `transfer_` 目标测试：通过。
- 1 个远端复制重试/续传进度目标测试：通过。
- 收口时匹配的基准 `cargo/rustc` 进程、容器和卷均为 0，工作区干净。

这些证据证明缓冲复用和相关语义测试通过，**不证明吞吐提高**。尤其是：

- 生产默认仍为 64 KiB。
- 64/256/1024 KiB 只完成了 debug 完整性运行。
- 2 MiB 未运行。
- 没有合格的 release 四候选对照。
- 没有受控高 RTT/WAN 数据。
- 没有据此调整默认值，也没有可报告的相对收益百分比。

### 已有 32 MiB 候选 debug 原始输出

运行条件均为 debug、3 次迭代、32 MiB 大文件和 128×4 KiB 小文件，每个候选有 8 分钟外层上限。下列 `SFTP_BENCHMARK` 行按已有输出原样保留，便于后续核对；它们只证明这些完整性运行已完成，**不能用于 WAN 或最终缓冲选型结论**。

<details>
<summary>64 KiB（65536 字节）</summary>

```text
SFTP_BENCHMARK scenario=large-file iteration=1 transfer_buffer_bytes=65536 sftp_transfer_metrics operation=upload operation_id="sftp-benchmark-large-file-1-upload" status=completed connect_us=76793 scan_us=14273 transfer_us=1057294 finalize_us=13 total_us=1148377 total_bytes=33554432 file_count=1 throughput_bytes_per_second=29218998
SFTP_BENCHMARK scenario=large-file iteration=1 transfer_buffer_bytes=65536 sftp_transfer_metrics operation=remote_copy operation_id="sftp-benchmark-large-file-1-copy" status=completed connect_us=83193 scan_us=7188 transfer_us=2187407 finalize_us=2078 total_us=2279871 total_bytes=33554432 file_count=1 throughput_bytes_per_second=14717684
SFTP_BENCHMARK scenario=large-file iteration=1 transfer_buffer_bytes=65536 sftp_transfer_metrics operation=download operation_id="sftp-benchmark-large-file-1-download" status=completed connect_us=89450 scan_us=1866 transfer_us=667748 finalize_us=12 total_us=759082 total_bytes=33554432 file_count=1 throughput_bytes_per_second=44203933
SFTP_BENCHMARK scenario=large-file iteration=2 transfer_buffer_bytes=65536 sftp_transfer_metrics operation=upload operation_id="sftp-benchmark-large-file-2-upload" status=completed connect_us=91636 scan_us=10260 transfer_us=1143336 finalize_us=5 total_us=1245242 total_bytes=33554432 file_count=1 throughput_bytes_per_second=26946106
SFTP_BENCHMARK scenario=large-file iteration=2 transfer_buffer_bytes=65536 sftp_transfer_metrics operation=remote_copy operation_id="sftp-benchmark-large-file-2-copy" status=completed connect_us=85300 scan_us=5928 transfer_us=2223579 finalize_us=2938 total_us=2317752 total_bytes=33554432 file_count=1 throughput_bytes_per_second=14477143
SFTP_BENCHMARK scenario=large-file iteration=2 transfer_buffer_bytes=65536 sftp_transfer_metrics operation=download operation_id="sftp-benchmark-large-file-2-download" status=completed connect_us=89041 scan_us=1776 transfer_us=699949 finalize_us=7 total_us=790778 total_bytes=33554432 file_count=1 throughput_bytes_per_second=42432155
SFTP_BENCHMARK scenario=large-file iteration=3 transfer_buffer_bytes=65536 sftp_transfer_metrics operation=upload operation_id="sftp-benchmark-large-file-3-upload" status=completed connect_us=97966 scan_us=12491 transfer_us=1465556 finalize_us=3 total_us=1576021 total_bytes=33554432 file_count=1 throughput_bytes_per_second=21290599
SFTP_BENCHMARK scenario=large-file iteration=3 transfer_buffer_bytes=65536 sftp_transfer_metrics operation=remote_copy operation_id="sftp-benchmark-large-file-3-copy" status=completed connect_us=99997 scan_us=11712 transfer_us=2406603 finalize_us=1844 total_us=2520162 total_bytes=33554432 file_count=1 throughput_bytes_per_second=13314394
SFTP_BENCHMARK scenario=large-file iteration=3 transfer_buffer_bytes=65536 sftp_transfer_metrics operation=download operation_id="sftp-benchmark-large-file-3-download" status=completed connect_us=87541 scan_us=2080 transfer_us=763444 finalize_us=9 total_us=853078 total_bytes=33554432 file_count=1 throughput_bytes_per_second=39333327
SFTP_BENCHMARK scenario=many-small-files iteration=1 transfer_buffer_bytes=65536 sftp_transfer_metrics operation=upload operation_id="sftp-benchmark-many-small-files-1-upload" status=completed connect_us=91782 scan_us=20168 transfer_us=591269 finalize_us=2 total_us=703226 total_bytes=524288 file_count=128 throughput_bytes_per_second=745546
SFTP_BENCHMARK scenario=many-small-files iteration=1 transfer_buffer_bytes=65536 sftp_transfer_metrics operation=remote_copy operation_id="sftp-benchmark-many-small-files-1-copy" status=completed connect_us=81463 scan_us=161833 transfer_us=1244315 finalize_us=854 total_us=1488469 total_bytes=524288 file_count=128 throughput_bytes_per_second=352232
SFTP_BENCHMARK scenario=many-small-files iteration=1 transfer_buffer_bytes=65536 sftp_transfer_metrics operation=download operation_id="sftp-benchmark-many-small-files-1-download" status=completed connect_us=83684 scan_us=62972 transfer_us=642082 finalize_us=3 total_us=788745 total_bytes=524288 file_count=128 throughput_bytes_per_second=664710
SFTP_BENCHMARK scenario=many-small-files iteration=2 transfer_buffer_bytes=65536 sftp_transfer_metrics operation=upload operation_id="sftp-benchmark-many-small-files-2-upload" status=completed connect_us=84284 scan_us=16814 transfer_us=725502 finalize_us=3 total_us=826614 total_bytes=524288 file_count=128 throughput_bytes_per_second=634259
SFTP_BENCHMARK scenario=many-small-files iteration=2 transfer_buffer_bytes=65536 sftp_transfer_metrics operation=remote_copy operation_id="sftp-benchmark-many-small-files-2-copy" status=completed connect_us=79208 scan_us=62503 transfer_us=678382 finalize_us=738 total_us=820835 total_bytes=524288 file_count=128 throughput_bytes_per_second=638724
SFTP_BENCHMARK scenario=many-small-files iteration=2 transfer_buffer_bytes=65536 sftp_transfer_metrics operation=download operation_id="sftp-benchmark-many-small-files-2-download" status=completed connect_us=82180 scan_us=68492 transfer_us=554342 finalize_us=3 total_us=705021 total_bytes=524288 file_count=128 throughput_bytes_per_second=743648
SFTP_BENCHMARK scenario=many-small-files iteration=3 transfer_buffer_bytes=65536 sftp_transfer_metrics operation=upload operation_id="sftp-benchmark-many-small-files-3-upload" status=completed connect_us=88799 scan_us=7533 transfer_us=596591 finalize_us=2 total_us=692929 total_bytes=524288 file_count=128 throughput_bytes_per_second=756624
SFTP_BENCHMARK scenario=many-small-files iteration=3 transfer_buffer_bytes=65536 sftp_transfer_metrics operation=remote_copy operation_id="sftp-benchmark-many-small-files-3-copy" status=completed connect_us=81758 scan_us=77808 transfer_us=768985 finalize_us=854 total_us=929409 total_bytes=524288 file_count=128 throughput_bytes_per_second=564108
SFTP_BENCHMARK scenario=many-small-files iteration=3 transfer_buffer_bytes=65536 sftp_transfer_metrics operation=download operation_id="sftp-benchmark-many-small-files-3-download" status=completed connect_us=76626 scan_us=78743 transfer_us=500289 finalize_us=3 total_us=655665 total_bytes=524288 file_count=128 throughput_bytes_per_second=799626
```

</details>

<details>
<summary>256 KiB（262144 字节）</summary>

```text
SFTP_BENCHMARK scenario=large-file iteration=1 transfer_buffer_bytes=262144 sftp_transfer_metrics operation=upload operation_id="sftp-benchmark-large-file-1-upload" status=completed connect_us=102956 scan_us=31333 transfer_us=1643901 finalize_us=12 total_us=1778208 total_bytes=33554432 file_count=1 throughput_bytes_per_second=18869798
SFTP_BENCHMARK scenario=large-file iteration=1 transfer_buffer_bytes=262144 sftp_transfer_metrics operation=remote_copy operation_id="sftp-benchmark-large-file-1-copy" status=completed connect_us=118118 scan_us=4868 transfer_us=1477690 finalize_us=1883 total_us=1602565 total_bytes=33554432 file_count=1 throughput_bytes_per_second=20937951
SFTP_BENCHMARK scenario=large-file iteration=1 transfer_buffer_bytes=262144 sftp_transfer_metrics operation=download operation_id="sftp-benchmark-large-file-1-download" status=completed connect_us=86752 scan_us=1941 transfer_us=648763 finalize_us=5 total_us=737466 total_bytes=33554432 file_count=1 throughput_bytes_per_second=45499620
SFTP_BENCHMARK scenario=large-file iteration=2 transfer_buffer_bytes=262144 sftp_transfer_metrics operation=upload operation_id="sftp-benchmark-large-file-2-upload" status=completed connect_us=99279 scan_us=15052 transfer_us=1026814 finalize_us=5 total_us=1141155 total_bytes=33554432 file_count=1 throughput_bytes_per_second=29403913
SFTP_BENCHMARK scenario=large-file iteration=2 transfer_buffer_bytes=262144 sftp_transfer_metrics operation=remote_copy operation_id="sftp-benchmark-large-file-2-copy" status=completed connect_us=99027 scan_us=12007 transfer_us=1985888 finalize_us=3165 total_us=2100094 total_bytes=33554432 file_count=1 throughput_bytes_per_second=15977584
SFTP_BENCHMARK scenario=large-file iteration=2 transfer_buffer_bytes=262144 sftp_transfer_metrics operation=download operation_id="sftp-benchmark-large-file-2-download" status=completed connect_us=98147 scan_us=3499 transfer_us=923464 finalize_us=11 total_us=1025126 total_bytes=33554432 file_count=1 throughput_bytes_per_second=32731994
SFTP_BENCHMARK scenario=large-file iteration=3 transfer_buffer_bytes=262144 sftp_transfer_metrics operation=upload operation_id="sftp-benchmark-large-file-3-upload" status=completed connect_us=110289 scan_us=132660 transfer_us=1782846 finalize_us=3 total_us=2025803 total_bytes=33554432 file_count=1 throughput_bytes_per_second=16563520
SFTP_BENCHMARK scenario=large-file iteration=3 transfer_buffer_bytes=262144 sftp_transfer_metrics operation=remote_copy operation_id="sftp-benchmark-large-file-3-copy" status=completed connect_us=94251 scan_us=8582 transfer_us=1824425 finalize_us=1775 total_us=1929070 total_bytes=33554432 file_count=1 throughput_bytes_per_second=17394089
SFTP_BENCHMARK scenario=large-file iteration=3 transfer_buffer_bytes=262144 sftp_transfer_metrics operation=download operation_id="sftp-benchmark-large-file-3-download" status=completed connect_us=108706 scan_us=3242 transfer_us=860617 finalize_us=7 total_us=972578 total_bytes=33554432 file_count=1 throughput_bytes_per_second=34500501
SFTP_BENCHMARK scenario=many-small-files iteration=1 transfer_buffer_bytes=262144 sftp_transfer_metrics operation=upload operation_id="sftp-benchmark-many-small-files-1-upload" status=completed connect_us=97800 scan_us=35224 transfer_us=1399378 finalize_us=3 total_us=1532409 total_bytes=524288 file_count=128 throughput_bytes_per_second=342133
SFTP_BENCHMARK scenario=many-small-files iteration=1 transfer_buffer_bytes=262144 sftp_transfer_metrics operation=remote_copy operation_id="sftp-benchmark-many-small-files-1-copy" status=completed connect_us=87735 scan_us=120547 transfer_us=1386546 finalize_us=2017 total_us=1596850 total_bytes=524288 file_count=128 throughput_bytes_per_second=328326
SFTP_BENCHMARK scenario=many-small-files iteration=1 transfer_buffer_bytes=262144 sftp_transfer_metrics operation=download operation_id="sftp-benchmark-many-small-files-1-download" status=completed connect_us=84301 scan_us=125259 transfer_us=973551 finalize_us=13 total_us=1183130 total_bytes=524288 file_count=128 throughput_bytes_per_second=443136
SFTP_BENCHMARK scenario=many-small-files iteration=2 transfer_buffer_bytes=262144 sftp_transfer_metrics operation=upload operation_id="sftp-benchmark-many-small-files-2-upload" status=completed connect_us=101254 scan_us=20596 transfer_us=1374220 finalize_us=3 total_us=1496077 total_bytes=524288 file_count=128 throughput_bytes_per_second=350441
SFTP_BENCHMARK scenario=many-small-files iteration=2 transfer_buffer_bytes=262144 sftp_transfer_metrics operation=remote_copy operation_id="sftp-benchmark-many-small-files-2-copy" status=completed connect_us=91301 scan_us=118936 transfer_us=1447856 finalize_us=1352 total_us=1659450 total_bytes=524288 file_count=128 throughput_bytes_per_second=315940
SFTP_BENCHMARK scenario=many-small-files iteration=2 transfer_buffer_bytes=262144 sftp_transfer_metrics operation=download operation_id="sftp-benchmark-many-small-files-2-download" status=completed connect_us=85362 scan_us=151684 transfer_us=1048724 finalize_us=6 total_us=1285781 total_bytes=524288 file_count=128 throughput_bytes_per_second=407758
SFTP_BENCHMARK scenario=many-small-files iteration=3 transfer_buffer_bytes=262144 sftp_transfer_metrics operation=upload operation_id="sftp-benchmark-many-small-files-3-upload" status=completed connect_us=101598 scan_us=20136 transfer_us=1159139 finalize_us=3 total_us=1280881 total_bytes=524288 file_count=128 throughput_bytes_per_second=409318
SFTP_BENCHMARK scenario=many-small-files iteration=3 transfer_buffer_bytes=262144 sftp_transfer_metrics operation=remote_copy operation_id="sftp-benchmark-many-small-files-3-copy" status=completed connect_us=96343 scan_us=192140 transfer_us=1354969 finalize_us=2448 total_us=1645905 total_bytes=524288 file_count=128 throughput_bytes_per_second=318540
SFTP_BENCHMARK scenario=many-small-files iteration=3 transfer_buffer_bytes=262144 sftp_transfer_metrics operation=download operation_id="sftp-benchmark-many-small-files-3-download" status=completed connect_us=95226 scan_us=273616 transfer_us=1413698 finalize_us=5 total_us=1782550 total_bytes=524288 file_count=128 throughput_bytes_per_second=294122
```

</details>

<details>
<summary>1024 KiB（1048576 字节）</summary>

```text
SFTP_BENCHMARK scenario=large-file iteration=1 transfer_buffer_bytes=1048576 sftp_transfer_metrics operation=upload operation_id="sftp-benchmark-large-file-1-upload" status=completed connect_us=109869 scan_us=32539 transfer_us=1384121 finalize_us=22 total_us=1526554 total_bytes=33554432 file_count=1 throughput_bytes_per_second=21980499
SFTP_BENCHMARK scenario=large-file iteration=1 transfer_buffer_bytes=1048576 sftp_transfer_metrics operation=remote_copy operation_id="sftp-benchmark-large-file-1-copy" status=completed connect_us=147280 scan_us=13305 transfer_us=2391675 finalize_us=4453 total_us=2556720 total_bytes=33554432 file_count=1 throughput_bytes_per_second=13124012
SFTP_BENCHMARK scenario=large-file iteration=1 transfer_buffer_bytes=1048576 sftp_transfer_metrics operation=download operation_id="sftp-benchmark-large-file-1-download" status=completed connect_us=113031 scan_us=3875 transfer_us=988263 finalize_us=7 total_us=1105181 total_bytes=33554432 file_count=1 throughput_bytes_per_second=30361012
SFTP_BENCHMARK scenario=large-file iteration=2 transfer_buffer_bytes=1048576 sftp_transfer_metrics operation=upload operation_id="sftp-benchmark-large-file-2-upload" status=completed connect_us=103764 scan_us=12955 transfer_us=1197026 finalize_us=7 total_us=1313757 total_bytes=33554432 file_count=1 throughput_bytes_per_second=25540812
SFTP_BENCHMARK scenario=large-file iteration=2 transfer_buffer_bytes=1048576 sftp_transfer_metrics operation=remote_copy operation_id="sftp-benchmark-large-file-2-copy" status=completed connect_us=125240 scan_us=17744 transfer_us=1987460 finalize_us=1552 total_us=2132003 total_bytes=33554432 file_count=1 throughput_bytes_per_second=15738451
SFTP_BENCHMARK scenario=large-file iteration=2 transfer_buffer_bytes=1048576 sftp_transfer_metrics operation=download operation_id="sftp-benchmark-large-file-2-download" status=completed connect_us=96143 scan_us=2166 transfer_us=722986 finalize_us=9 total_us=821310 total_bytes=33554432 file_count=1 throughput_bytes_per_second=40854741
SFTP_BENCHMARK scenario=large-file iteration=3 transfer_buffer_bytes=1048576 sftp_transfer_metrics operation=upload operation_id="sftp-benchmark-large-file-3-upload" status=completed connect_us=114500 scan_us=12461 transfer_us=1075544 finalize_us=10 total_us=1202520 total_bytes=33554432 file_count=1 throughput_bytes_per_second=27903408
SFTP_BENCHMARK scenario=large-file iteration=3 transfer_buffer_bytes=1048576 sftp_transfer_metrics operation=remote_copy operation_id="sftp-benchmark-large-file-3-copy" status=completed connect_us=113524 scan_us=10586 transfer_us=1666318 finalize_us=2877 total_us=1793310 total_bytes=33554432 file_count=1 throughput_bytes_per_second=18710887
SFTP_BENCHMARK scenario=large-file iteration=3 transfer_buffer_bytes=1048576 sftp_transfer_metrics operation=download operation_id="sftp-benchmark-large-file-3-download" status=completed connect_us=95635 scan_us=2086 transfer_us=907201 finalize_us=8 total_us=1004935 total_bytes=33554432 file_count=1 throughput_bytes_per_second=33389640
SFTP_BENCHMARK scenario=many-small-files iteration=1 transfer_buffer_bytes=1048576 sftp_transfer_metrics operation=upload operation_id="sftp-benchmark-many-small-files-1-upload" status=completed connect_us=133381 scan_us=31802 transfer_us=1862926 finalize_us=4 total_us=2028117 total_bytes=524288 file_count=128 throughput_bytes_per_second=258509
SFTP_BENCHMARK scenario=many-small-files iteration=1 transfer_buffer_bytes=1048576 sftp_transfer_metrics operation=remote_copy operation_id="sftp-benchmark-many-small-files-1-copy" status=completed connect_us=109036 scan_us=241435 transfer_us=3275390 finalize_us=2985 total_us=3628853 total_bytes=524288 file_count=128 throughput_bytes_per_second=144477
SFTP_BENCHMARK scenario=many-small-files iteration=1 transfer_buffer_bytes=1048576 sftp_transfer_metrics operation=download operation_id="sftp-benchmark-many-small-files-1-download" status=completed connect_us=132386 scan_us=265740 transfer_us=1654062 finalize_us=5 total_us=2052201 total_bytes=524288 file_count=128 throughput_bytes_per_second=255475
SFTP_BENCHMARK scenario=many-small-files iteration=2 transfer_buffer_bytes=1048576 sftp_transfer_metrics operation=upload operation_id="sftp-benchmark-many-small-files-2-upload" status=completed connect_us=107912 scan_us=23505 transfer_us=2573786 finalize_us=6 total_us=2705215 total_bytes=524288 file_count=128 throughput_bytes_per_second=193806
SFTP_BENCHMARK scenario=many-small-files iteration=2 transfer_buffer_bytes=1048576 sftp_transfer_metrics operation=remote_copy operation_id="sftp-benchmark-many-small-files-2-copy" status=completed connect_us=118039 scan_us=340008 transfer_us=8545069 finalize_us=6600 total_us=9009724 total_bytes=524288 file_count=128 throughput_bytes_per_second=58191
SFTP_BENCHMARK scenario=many-small-files iteration=2 transfer_buffer_bytes=1048576 sftp_transfer_metrics operation=download operation_id="sftp-benchmark-many-small-files-2-download" status=completed connect_us=197095 scan_us=887163 transfer_us=2507366 finalize_us=15 total_us=3591647 total_bytes=524288 file_count=128 throughput_bytes_per_second=145974
SFTP_BENCHMARK scenario=many-small-files iteration=3 transfer_buffer_bytes=1048576 sftp_transfer_metrics operation=upload operation_id="sftp-benchmark-many-small-files-3-upload" status=completed connect_us=158955 scan_us=38883 transfer_us=2511993 finalize_us=6 total_us=2709842 total_bytes=524288 file_count=128 throughput_bytes_per_second=193475
SFTP_BENCHMARK scenario=many-small-files iteration=3 transfer_buffer_bytes=1048576 sftp_transfer_metrics operation=remote_copy operation_id="sftp-benchmark-many-small-files-3-copy" status=completed connect_us=111554 scan_us=334396 transfer_us=4931772 finalize_us=7789 total_us=5385519 total_bytes=524288 file_count=128 throughput_bytes_per_second=97351
SFTP_BENCHMARK scenario=many-small-files iteration=3 transfer_buffer_bytes=1048576 sftp_transfer_metrics operation=download operation_id="sftp-benchmark-many-small-files-3-download" status=completed connect_us=170072 scan_us=871280 transfer_us=4345457 finalize_us=9 total_us=5386826 total_bytes=524288 file_count=128 throughput_bytes_per_second=97327
```

</details>

**2 MiB（2097152 字节）：未运行，没有数据。**

## 已终止并清理：release 失联尝试

候选对照最初尝试使用 release、3 次迭代、32 MiB 和 128×4 KiB。该次运行从约 00:42 持续到约 08:09；观察时相关 `cargo/rustc` 仅累计约 2–65 秒 CPU，而 Docker 基准容器已存活约 7 小时，判定为失联/挂起，不再视为正常编译。

已执行的收口动作：

- 终止该基准的 `cargo/rustc` 子进程。
- 执行基准 compose 的 `down --volumes --remove-orphans`。
- 后续确认匹配构建进程、`termbridge-sftp-benchmark` 容器和卷均为 0。
- 不再重试该次 release，不保留其不完整输出，不将等待时长或零散 CPU 时间写成性能数据。

这次尝试只提供了“运行环境需要有界 watchdog 和可靠清理”的工程教训，没有提供任何可用的 release 性能结论。

## 恢复执行协议

后续工作必须按下列顺序执行，且**每个任务都必须开启一个新的 Codex 会话**：

1. 同一时间只允许一个 SFTP 性能任务会话修改项目，不并行实现。
2. 新会话先核对 `git status --short --branch` 和 `git rev-parse HEAD`，其基线必须是上一任务已审查并接受的提交。
3. 严格执行该任务的范围；不得顺手提前实现后续任务。
4. 运行该任务列出的门禁，检查 `git diff --check`、`git diff` 和工作区状态。
5. 每个任务形成独立、可审查、可回退的提交；提交后报告完整 hash、原始测试结果和未完成项。
6. 主线确认提交已串行集成且工作区干净后，才创建下一个新会话。
7. 若门禁、release 基准或受控网络环境被有界终止，应停止并记录阻塞；不得为了继续序列而把任务标为完成。

推荐恢复顺序：**缓冲最终选型 → 传输连接复用/健康检查 single-flight → 递归 manifest → 受控并发/公平/取消 → 同主机服务器端复制 → 目录请求/缓存刷新合并 → 最终集成与前后对比**。

## 后续任务 1：大缓冲最终选型

**新的会话标题**：`SFTP 恢复 1/7：大缓冲受控选型`

**严格范围**

- 只完成 64/256/1024/2048 KiB 的受控选型、最终生产默认值决定和对应基准文档。
- 可以完善基准的有界 watchdog、原始结果保存和可重复的延迟整形入口。
- 不做连接复用、manifest、并发、目录合并或服务器端复制。

**依赖**

- 基线提交为 `b10a86585943df0059ea92130b16478ba365eded` 及本路线图提交。
- Docker、Rust release 构建和延迟整形环境必须可用；若不可用，本任务不能宣称选型完成。

**实施要点**

- 四个候选使用完全相同的 release 二进制配置、机器、工作负载和网络条件；每个条件至少 1 次预热、5 次计入结果的迭代。
- 覆盖低延迟本机环境和一个固定的代表性高 RTT 条件；若为基准新增 `-NetworkDelayMs` 等参数，必须只影响隔离测试环境，并验证清理恢复。
- 大文件作为流水深度判断的主要场景，同时覆盖多小文件；至少记录端到端吞吐、四阶段耗时、峰值内存和失败/超时。
- 按预先写明的规则选值；如果数据不支持修改，则明确保留 64 KiB，而不是强行选择更大值。
- 原始输出与汇总算法一同提交；debug 结果与 release 结果严格分栏。

**风险与不变量**

- 上传的临时文件、大小校验和原子重命名不退化。
- 远端复制的重试/续传、进度不重复计数、取消检查和超时不退化。
- 下载的现有失败/取消语义不被无意改变。
- 生产不得暴露任意大小的环境变量或无界内存配置。
- 所有基准均须有硬超时，并在 `finally` 中清理进程、容器和卷。

**可复现命令**

当前低延迟四候选命令模板：

```powershell
65536, 262144, 1048576, 2097152 | ForEach-Object {
  pwsh -File scripts/run-sftp-benchmark.ps1 `
    -Iterations 5 `
    -LargeBytes 67108864 `
    -SmallFileCount 1000 `
    -SmallFileBytes 4096 `
    -TransferBufferBytes $_
}
```

若本任务新增隔离延迟参数，提交前还必须固定并运行对应命令，例如：

```powershell
pwsh -File scripts/run-sftp-benchmark.ps1 `
  -Iterations 5 `
  -LargeBytes 67108864 `
  -SmallFileCount 1000 `
  -SmallFileBytes 4096 `
  -TransferBufferBytes 65536 `
  -NetworkDelayMs 100
```

`-NetworkDelayMs` 当前不存在；它是本任务可选择新增并必须测试、文档化的隔离基准能力，不能在新增前假装可用。

**验收证据**

- 四个候选均有完整 release 原始输出；2 MiB 不再缺失。
- 相同条件的中位数、离散度和内存数据可由提交内脚本复算。
- 高 RTT 环境的实际延迟及整形恢复有证据。
- 所有传输内容/清单完整性通过。
- `cargo fmt --check`、`cargo check --all-targets --locked`、Clippy `-D warnings`、相关单测和 Docker 基准通过。
- 文档明确最终默认值及选择/保留理由；若任一必要数据缺失，本任务状态仍为未完成。

**建议提交边界**

- 单一提交：`perf(sftp): select transfer buffer size`。
- 只包含缓冲默认值、基准/结果处理、必要测试和性能文档，不混入其他优化。

## 后续任务 2：传输连接复用与健康检查 single-flight

**新的会话标题**：`SFTP 恢复 2/7：传输连接复用与健康检查 single-flight`

**严格范围**

- 为上传、下载、同主机复制和跨主机复制增加独立的传输连接复用。
- 将过期连接健康检查做成按连接键/连接实例 single-flight。
- 不做文件并发、manifest、服务器端复制或前端目录请求合并。

**依赖**

- 后续任务 1 已完成并串行集成。
- 复用现有 `SftpPool` 的连接键、认证、跳板机、TTL、连接建立 single-flight 和失效语义，但不能让长传输占用目录浏览连接。

**实施要点**

- 使用与浏览池隔离的传输池或明确的池分区；每目标保持有界空闲连接，租约必须用 RAII 归还或丢弃。
- 同一连接不能被并发 SFTP 操作共享；跨主机复制按稳定顺序租用两个连接，避免 ABBA 死锁。
- 并发调用发现连接需要健康探测时，只允许一个 leader 执行探测；followers 等待同一结果或在有界时间后失败。
- 探测失败、认证失效、socket/协议错误时丢弃连接；普通远端文件错误不得污染整个池。
- 指标应能区分新建与复用连接，且不记录凭证、路径或敏感连接细节。

**风险与不变量**

- 目录浏览连接始终可用，不被长传输锁住。
- 不跨不同凭证、用户名、端口或跳板机配置复用连接。
- 连接池容量、空闲 TTL、等待时间均有上限。
- 取消或 panic 不得泄漏租约；失败连接不得回池。
- host-key 与认证校验路径保持不变。

**可复现命令**

```powershell
cargo test --manifest-path src-tauri/Cargo.toml --lib sftp_pool::tests
cargo test --manifest-path src-tauri/Cargo.toml --lib remote_fs::tests::isolated_sftp_transfer_benchmark -- --ignored --exact --nocapture --test-threads=1
pwsh -File scripts/run-sftp-benchmark.ps1 -Iterations 5 -SmallFileCount 128 -SmallFileBytes 4096
```

**验收证据**

- 并发 miss、并发健康检查、leader 成功/失败/panic、follower 超时、TTL、失效和租约归还均有确定性测试。
- 连续小批次的连接建立次数显著少于批次数，并由计数或指标证明；不能只凭总耗时推断。
- 浏览操作在传输占用连接时仍能完成。
- 上传、下载、同主机和跨主机复制的完整性、取消、重试和错误分类通过隔离 E2E。
- Rust 格式、check、Clippy、完整测试和基准均通过。

**建议提交边界**

- 单一提交：`perf(sftp): reuse dedicated transfer connections`。
- 连接池、single-flight、指标和对应测试同提交；不包含文件调度或目录缓存改动。

## 后续任务 3：递归 manifest 与元数据复用

**新的会话标题**：`SFTP 恢复 3/7：递归 manifest 与元数据复用`

**严格范围**

- 把递归下载和远端复制的预扫描结果变成一次性 manifest，传输阶段直接复用。
- 复用 `readdir` 已返回的 `FileStat`，消除同一批次中可避免的第二次递归和重复 `lstat/readdir`。
- 不引入文件并发或服务器端复制。

**依赖**

- 后续任务 2 已完成，传输连接生命周期已经稳定。

**实施要点**

- manifest 至少保存源路径、相对路径、类型、大小、权限/时间等实际需要的元数据和确定的目标路径。
- 扫描阶段一次完成冲突检查、递归深度、symlink 策略、文件/字节计数；传输阶段不重新发现同一目录树。
- 下载、同连接复制和跨连接复制共享可验证的数据模型，同时保留各自目标端语义。
- 对超大目录设置显式条目/内存边界或分段策略，不能把网络往返问题换成无界内存问题。
- 通过测试计数远端 `readdir/lstat`，而不是仅依赖耗时判断是否消除重复调用。

**风险与不变量**

- 不跟随目录 symlink 导致环路；递归深度上限保持生效。
- 扫描后源端发生变化时必须安全失败或重新校验关键属性，不能静默复制错误内容。
- 冲突策略、权限/时间复制、临时文件/原子收尾、进度总量和取消语义不退化。
- manifest 不记录或输出敏感路径到日志。

**可复现命令**

本任务新增测试统一使用 `recursive_manifest_` 前缀：

```powershell
cargo test --manifest-path src-tauri/Cargo.toml --lib remote_fs::tests::recursive_manifest_
pwsh -File scripts/run-sftp-benchmark.ps1 -Iterations 5 -LargeBytes 16777216 -SmallFileCount 1000 -SmallFileBytes 4096
```

**验收证据**

- 空目录、深目录、很多小文件、symlink、权限/时间、源端变化、取消和边界限制均有测试。
- 远端调用计数证明每个目录只做必要的一次发现，传输阶段没有第二次同树递归。
- `scan_us` 与 `transfer_us` 的语义仍与基线文档一致；若定义变化，必须同步更新并说明不可直接比较的字段。
- 1000 个小文件的 Docker 完整性通过，且保存阶段指标；收益仍待最终 A/B 验收。

**建议提交边界**

- 单一提交：`perf(sftp): reuse recursive transfer manifests`。
- 只包含 manifest 模型、远端操作接入、调用计数测试和必要文档。

## 后续任务 4：受控并发、公平与取消语义

**新的会话标题**：`SFTP 恢复 4/7：受控传输并发与公平取消`

**严格范围**

- 对同一批次中路径互不冲突的文件增加有界并发。
- 完成跨批次/每主机的公平排队和 queued/active 取消语义。
- 不做服务器端复制或目录缓存合并。

**依赖**

- 后续任务 2 的传输连接租约和后续任务 3 的确定性 manifest 已完成。

**实施要点**

- 先实现可测试的调度器，再接入上传、下载和远端复制；全局、每主机和每批次并发数均有固定上限。
- 默认并发度只能由受控数据选择，候选建议 1/2/4；不得直接使用无界线程或按文件创建无限任务。
- FIFO 或明确记录的公平策略必须防止大批次永久饿死小批次，也不能让重试插队无限占用资源。
- 同一路径、父子路径、目标名冲突和冲突对话相关工作保持串行；与现有前端路径任务/上传 FIFO 语义对齐。
- 聚合进度必须单调、去重且不超过总量；结果顺序稳定，不依赖 worker 完成顺序。

**风险与不变量**

- queued 取消不建立连接、不创建临时文件；active 取消在既有安全检查点停止并释放全部 permit/租约。
- 上传和远端复制仍只在完整校验后原子替换最终目标；下载保留现有部分文件语义，除非另立任务明确改变。
- 单文件失败不掩盖同批次其他结果；批次取消与普通部分失败可区分。
- 并发不会突破连接池上限或造成每 worker 一份无界大缓冲。

**可复现命令**

若新增独立模块，测试统一使用 `transfer_scheduler::tests`：

```powershell
cargo test --manifest-path src-tauri/Cargo.toml --lib transfer_scheduler::tests
cargo test --manifest-path src-tauri/Cargo.toml --lib remote_fs::tests::concurrent_transfer_
pnpm test -- src/components/sftp/__tests__/sftp-upload-queue.test.tsx src/stores/__tests__/transferStore.test.ts
pwsh -File scripts/run-sftp-benchmark.ps1 -Iterations 5 -SmallFileCount 1000 -SmallFileBytes 4096
```

**验收证据**

- permit 上限、FIFO/公平、无饥饿、queued 取消、active 取消、重试、panic/失败释放和稳定结果顺序均有确定性测试。
- 连接数、并发 worker 数和峰值内存有观测证据，均未超过配置上限。
- 1/2/4 并发候选在相同 release 条件下完成完整性对照，默认值有书面理由。
- 前端上传队列、路径互斥、取消和卸载测试不回归。

**建议提交边界**

- 单一提交：`perf(sftp): add bounded fair transfer concurrency`。
- 调度器、三类传输接入、前后端测试和必要文档同提交，不夹带复制模式或缓存改动。

## 后续任务 5：同主机服务器端复制与安全回退

**新的会话标题**：`SFTP 恢复 5/7：同主机服务器端复制与回退`

**严格范围**

- 对确认处于同一服务器命名空间的复制优先使用服务器端能力。
- 能力不可用或在安全的未提交状态失败时，回退到现有客户端中转路径。
- 不处理跨主机服务器端复制，不改目录缓存。

**依赖**

- 后续任务 3 的 manifest 和后续任务 4 的调度/取消语义已经稳定。

**实施要点**

- 优先使用可探测的 SFTP `copy-data` 等服务器端扩展；若库不支持且选择受控远端命令，必须通过严格参数编码、能力探测和最小权限设计，禁止拼接不受信任 shell 文本。
- “同主机”判断必须包含 host、port、username、跳板机和远端命名空间约束，不能只比较显示名称。
- 服务器端复制写入临时目标，校验大小/必要元数据后原子 rename；记录 `server` 或 `client_fallback` 模式但不记录路径。
- 只有在确认最终目标未提交、临时目标已清理或可安全复用时才允许回退；模糊的部分成功不得自动重复覆盖。
- 目录复制按 manifest 的条目执行，明确 regular file、directory 和 symlink 的支持/回退策略。

**风险与不变量**

- 文件名中的空格、引号、换行、前导 `-` 和非 UTF-8 可表示路径不得造成命令注入或选项注入。
- 冲突策略、权限/时间、取消、超时、重试和原子目标语义不退化。
- 服务器端能力探测有缓存和失效策略，不在每个文件重复探测。
- 不因优化而绕过 host-key、认证或审计边界。

**可复现命令**

新增测试统一使用 `server_side_copy_` 前缀，并为隔离 E2E 提供可强制“支持/不支持”的测试入口：

```powershell
cargo test --manifest-path src-tauri/Cargo.toml --lib remote_fs::tests::server_side_copy_
pwsh -File scripts/run-ssh-e2e.ps1
pwsh -File scripts/run-sftp-benchmark.ps1 -Iterations 5 -LargeBytes 67108864 -SmallFileCount 1000 -SmallFileBytes 4096
```

**验收证据**

- 能力支持、不支持、权限拒绝、复制中断、取消、校验失败、临时目标清理和客户端回退均有测试。
- 恶意/边界路径的注入测试通过。
- 隔离 E2E 证明服务器端模式内容正确，回退模式也正确；模式选择由明确指标或计数证明。
- 同主机大文件在服务器端模式下不经过客户端字节循环，并有可审计证据；最终收益留到最终 A/B。

**建议提交边界**

- 单一提交：`perf(sftp): prefer server-side same-host copies`。
- 能力抽象、回退、测试和指标同提交，不混入连接池或前端改动。

## 后续任务 6：目录请求与缓存刷新合并

**新的会话标题**：`SFTP 恢复 6/7：目录请求与缓存刷新合并`

**严格范围**

- 合并同一连接侧、规范化路径和缓存代次上的重复目录请求/后台刷新。
- 保持 stale-while-revalidate、手动刷新、突变失效和最新请求获胜语义。
- 不修改传输热路径或服务器端复制。

**依赖**

- 后续任务 2 的后端健康检查 single-flight 已完成，避免前端合并掩盖后端重复探测问题。

**实施要点**

- 为目录请求建立 in-flight registry，键至少包含连接身份隔离、pane side、规范化路径和缓存 generation。
- 相同 generation 的相同请求共享 Promise；失败或完成必须移除槽位。
- 突变前增加 generation 并失效缓存，绝不能复用突变前已经在途的响应；旧响应即使完成也不得回填新缓存。
- 手动刷新、历史导航、缓存命中后的后台 revalidate 和认证恢复重试要有明确合并规则。
- 保留当前 latest-request 防护；合并只减少远端调用，不改变 UI 加载/错误状态所有权。

**风险与不变量**

- 不跨不同凭证、profile、连接侧或目录路径共享结果。
- 失败不会形成永久 rejected Promise 缓存；组件卸载后不更新已失效 pane。
- 缓存 TTL、最大 key 数和 owner name 回填保持一致。
- 创建、重命名、删除、上传、下载和复制后的刷新必须看到突变后内容。

**可复现命令**

```powershell
pnpm test -- src/hooks/__tests__/useSftpConnection.test.ts
pnpm test -- src/components/sftp/__tests__/sftp-upload-queue.test.tsx
pnpm test -- src/lib/__tests__/directory-listing-cache.test.ts
pnpm build
```

若新增缓存测试文件，使用上面的 `src/lib/__tests__/directory-listing-cache.test.ts` 路径，确保命令可直接复现。

**验收证据**

- 同 key 并发请求只调用一次后端；不同路径/身份不合并。
- 失败后可重试，manual refresh 和后台 refresh 的规则有测试。
- 突变时旧在途结果不能污染缓存；新 generation 请求能正确落地。
- stale response、tab 切换、卸载、keychain 恢复和 owner 回填测试通过。
- 前端完整测试和 build 通过；后端目录 E2E 无回归。

**建议提交边界**

- 单一提交：`perf(sftp): coalesce directory refreshes`。
- 只包含 in-flight/cache generation、hook 接入和前端测试。

## 后续任务 7：最终全量集成与前后对比

**新的会话标题**：`SFTP 恢复 7/7：全量集成与性能验收`

**严格范围**

- 不再引入新的优化设计；只修复集成缺陷、补齐基准矩阵、执行最终门禁并形成前后对比报告。
- 权威 before 固定为 `5323e847351d3036bb98fc6241c2c046b3394f57`；after 固定为本任务开始时已串行集成的最终候选提交，加上必要的纯集成修复。

**依赖**

- 后续任务 1–6 全部完成、已审查并串行集成。
- release 构建、Docker、受控高 RTT 环境和足够的有界运行时间可用。

**实施要点**

- 在独立 worktree 或等价隔离目录中构建 before/after，避免产物和环境变量相互污染。
- A/B 交错运行相同的 release 工作负载；至少覆盖大文件、很多小文件、深递归目录、重复小批次、同主机复制和受控并发。
- 低延迟与代表性高 RTT 分开报告；每个场景至少 5 个计入结果的样本，报告中位数、离散度、四阶段耗时、吞吐、连接/远端调用计数和峰值内存。
- 原始输出、汇总脚本、确切提交、工具链版本、机器/网络条件和所有超时/失败一并保留。
- 检查指标定义在 before/after 间是否可比；不可比字段必须解释，不能直接计算百分比。

**风险与不变量**

- 不为得到漂亮数字而删除失败样本或改变工作负载。
- 不把本地 Docker 数字写成 WAN 结论，不把 debug 与 release 混合。
- before 与 after 都必须通过相同完整性校验；任何数据损坏、取消/公平回归或资源越界均否决性能收益。
- 所有长运行有 watchdog，清理只针对明确的基准进程、容器、卷和经验证的临时 worktree。

**可复现命令**

最终代码门禁：

```powershell
cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check
cargo check --manifest-path src-tauri/Cargo.toml --all-targets --locked
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --locked -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml --all-targets --locked
pnpm test
pnpm build
pwsh -File scripts/run-ssh-e2e.ps1
```

最终基准至少保留以下固定入口；若前述任务扩展场景/延迟参数，应在最终报告中列出完整命令矩阵：

```powershell
pwsh -File scripts/run-sftp-benchmark.ps1 `
  -Iterations 5 `
  -LargeBytes 67108864 `
  -SmallFileCount 1000 `
  -SmallFileBytes 4096
```

**验收证据**

- Rust/TypeScript 全量门禁、SSH/SFTP E2E 和全部性能完整性校验通过。
- before/after 的原始 release 数据、复算脚本和环境说明已提交。
- 每项优化都有直接证据：缓冲默认值、连接复用/探测次数、manifest 远端调用数、并发上限与公平取消、服务器端/回退模式、目录请求合并次数。
- 最终报告分别给出低延迟和高 RTT 结果，只对定义一致、样本合格的场景给出百分比。
- 所有进程、容器、卷和临时环境已清理，主工作区干净。

**建议提交边界**

- 如无代码修复：单一文档/数据提交 `docs(sftp): record final performance validation`。
- 如发现集成缺陷：先提交最小修复 `fix(sftp): preserve integrated transfer semantics` 并重跑完整矩阵，再单独提交最终报告；不得把修复与结果混为一个不可审查提交。

## 总体验收清单

只有以下项目全部满足，才能把完整 SFTP 性能 Goal 标记为完成：

- [ ] 64/256/1024/2048 KiB 四候选均有合格的 release、低延迟和代表性高 RTT 数据。
- [ ] 最终生产缓冲值有明确、可复算的选型证据；若保留 64 KiB，同样有书面结论。
- [ ] 传输使用独立、有界、按身份隔离的连接复用，目录浏览不被长传输占用。
- [ ] 连接建立和过期健康检查均为 single-flight，失败/超时/panic 不泄漏槽位。
- [ ] 递归下载/复制使用一次 manifest 和已有 `FileStat`，无可避免的第二次同树扫描。
- [ ] 并发度有界，公平策略、queued/active 取消、重试和资源释放有确定性证据。
- [ ] 进度单调且不重复计数，部分失败、取消、重试/续传和结果顺序语义不退化。
- [ ] 同主机复制优先服务器端能力，能力/失败回退安全，临时目标与原子提交语义正确。
- [ ] 目录 list/refresh 合并正确，突变 generation、缓存失效和 stale response 不污染 UI。
- [ ] 上传临时文件、大小校验、权限/时间和原子 rename 等可靠性不变量保持通过。
- [ ] host-key、认证、跳板机和凭证隔离不退化，日志不泄露主机、路径或秘密。
- [ ] Rust 格式、check、Clippy、全量测试以及 TypeScript 测试/build 全部通过。
- [ ] SSH/SFTP 隔离 E2E 与所有性能工作负载的字节/文件清单全部通过。
- [ ] before/after 使用固定提交、相同 release 配置和相同环境，原始输出与汇总可复算。
- [ ] 低延迟与高 RTT/WAN 结论严格分开；debug 数据未被包装成生产性能收益。
- [ ] 所有长任务有硬超时和精确清理，最终无残留进程、容器、卷或未审查工作区改动。
- [ ] 后续 7 个任务各自在新的 Codex 会话中完成，并按本文顺序串行集成。

在清单全部勾选之前，文档、提交信息和对外说明都必须继续将该 Goal 标记为“进行中/未完成”。

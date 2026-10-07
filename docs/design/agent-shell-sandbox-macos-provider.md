# macOS 原生文件对象后端接入条件

> 当前决策（2026-10-06）：用户确认首版采用常规原生进程沙箱，macOS 接入 Seatbelt，不采用本文讨论的 Endpoint Security 系统服务或完整对象隔离承诺。下文保留为历史候选调查，不再是首版授权或部署前提。已验证的对象别名限制须在当前产品能力中如实说明。

2026-10-06：这是实施前的依赖审查，尚未安装或启用任何 provider。桌面目标为 macOS 和 Windows；Windows 实机验收后续提供，不阻止 macOS 工作。Linux 容器不作为新增产品执行环境。

## 当前机器的真实能力

系统 `sw_vers` 为 macOS 26.7.1 / 25G241。本机 Xcode SDK 的 `EndpointSecurity/ESClient.h` 声明 `es_new_descendants_client` 和 `es_set_deadline_miss_mode` 从 macOS 27.0 起可用。只读 `dlopen/dlsym` 探测结果：

```text
es_new_client=present
es_new_descendants_client=absent
es_set_deadline_miss_mode=present
```

符号存在不等于受支持 API，更不等于获准创建客户端。探测没有创建 ES client、订阅事件、执行 Shell、读取用户项目或修改系统配置。可复现命令：

```bash
xcrun clang -Wall -Wextra -Werror tests/agent-shell-sandbox-phase-2/macos_provider_probe.c -o /tmp/shellspan-macos-provider-probe
/tmp/shellspan-macos-provider-probe
```

当前 `tauri.conf.json` 未配置 Endpoint Security entitlement；本轮原 GUI 测试二进制已不在原 target 路径，因此没有把其签名状态当作当前证据。

Apple 官方文档的 HTML 正文需要 JavaScript，Markdown 获取也失败；API条件采用本机完整 SDK 声明核对，官网搜索可见正文用于交叉核对：[后代客户端](https://developer.apple.com/documentation/endpointsecurity/es_new_descendants_client(_:_:))、[超时行为](https://developer.apple.com/documentation/endpointsecurity/es_set_deadline_miss_mode(_:_:))、[entitlement 申请](https://developer.apple.com/system-extensions/)。

## 接入判断

推荐继续审查签名原生执行服务与 Endpoint Security 对象授权组合，先证明其覆盖范围，再决定实现；不把它预先标记可用。ES 消息包含 `es_file_t.stat`，可用于设备号、inode 与对象事实判断，但不能仅凭一次 stat、路径前缀或 hardlink 数量推断对象来源合法。项目现有硬链接反例仍有效。

macOS 27 的后代客户端将观察范围限制到服务自身及后代，不需要 root 或 TCC，但仍需要 Apple 授予的 Endpoint Security entitlement。当前机器无法使用该 API。macOS 26 的 `es_new_client` 是系统级客户端，需要 entitlement 及用户授予完整磁盘访问权限；不能直接在桌面主进程中启用。ES 不是网络沙箱，必须另外落实网络默认拒绝；现有 Seatbelt 只能作为辅助层。

尚须证明：既有及新增文件别名的对象归属、并发替换、既有文件描述符和映射、全部必要写操作的授权覆盖、授权缓存失效、进程树绑定、服务死亡/队列丢失时拒绝行为。SDK 对新版 fail-closed 的说明覆盖消息队列满时拒绝，但不构成服务崩溃后命令也必然停止的证明。缺任一项时均不开放生产 Direct，不使用仅有路径限制的后备执行。

## 若采用 macOS 26 原生服务，安装审查范围

以下为需要单独审查与授权的具体设计，不是已获准安装步骤：

- 发布新增由 Developer ID 签名的专用执行服务；先申请 Apple entitlement，再评估通过 SMAppService 安装的 launch daemon。服务文件限于应用包内代码、服务专用配置和状态目录，不改用户项目或 HOME 的属主、ACL、权限，不创建账户作为默认实现。
- 用户明确批准服务注册，并按系统要求授权完整磁盘访问。不得关闭 SIP、自动修改 TCC 数据库或以调试签名规避 entitlement。管理员服务只负责策略/生命周期协调，待执行命令使用请求者账户身份；环境、文件描述符、临时目录与缓存必须独立收敛。
- IPC 使用经过系统审计身份验证的连接及签名要求，只接受当前应用；绑定 session 创建时间、target、bindingRevision、call 与新鲜授权。不得提供任意 root exec、任意文件读写或由客户端自报 PID/路径即可生效的通用接口。需要权限的动作必须是固定受限操作。
- 注册与启动后首先核验客户端、事件订阅、网络层和对象边界；整个核验成功前不开命令入口。取消、过期、客户端断开或策略服务故障先拒绝新派发，已运行进程的可靠停止必须有独立机制和真实证据。
- 回滚先关闭 admission、撤销授权并停止所有确切归属资源；未确认清理记录继续保留。随后注销自身服务并确认退出，清理仅自身状态。完整磁盘访问授权由用户在系统设置撤回，不擅自改系统授权。失败时保留诊断，不报告卸载或清理成功。

当前尚无经过验证的对象 provider，也没有获批 entitlement 与部署链。仅安装 helper 不能解决对象边界，本设计不得作为阶段 2 完成证明。下一步需要先确定上述原生服务授权是否可接受，并证明平台 API 覆盖；未获得条件前可继续普通代码审查和构建，不能以添加永久不可用接口冒充接入。

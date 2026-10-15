# ECS / APK 专用队列验收（2026-10-16）

已部署实际 ECS，APK 0.4.0 已覆盖安装荣耀；入队、排队取消、处理中协作取消、状态、结果、刷新恢复和丢失交付响应后的核对均通过。只开放下面这一份显式授权，没有开放其他项目或恢复原生发送路径。

## 部署与范围

| 项目 | 实测值 |
| --- | --- |
| ECS | `i-2zefnzrsukslova9192y`，`cn-beijing` |
| 入口 | `https://47.95.141.18/devices/mac/`，重定向至 `/devices/mac-owner-inbox-test/` |
| release | `/opt/rmtagt-business/releases/20261015T164911Z-owner-queue` |
| 部署包 SHA-256 | `bdb191c1f4136757f5b520264fb68d1e9e03f86deca18c57da5f05b1339b095c` |
| 设备 / 项目 | `mac-owner-inbox-test` / `rmtcdx-owner-inbox-test` |
| 桌面实际聊天 | `rmtcdx companion lifecycle`，`01a13fef-a018-7303-a2a6-f5903548537f` |
| 授权文件 | ECS `/etc/rmtagt-business/queue-scope.json`，root:rmtagt-business 0640 |
| 配置入口 | `RMT_BUSINESS_QUEUE_SCOPE_FILE`；必须 `mode=dedicated-test`、完整且唯一的 device/project/conversation ID、HTTPS |
| APK | `artifacts/codex-remote-owner-queue-debug.apk`，versionCode 6 / versionName 0.4.0 |
| APK SHA-256 | `1dc82d4f3843ea3bc225295632ac4bdcc4e2c24af8cf64498c39bdc967597431` |
| 真机 | 荣耀 LGE-AN00，Android 15，`ACTH022325002169`；未操作华为 |

服务仍由原 `rmtagt-business.service` 托管，Node 22.22.3；没有新增端口、修改 RAM/安全组、部署旧 control 或在 ECS 安装 Codex。证书正常通过系统信任链和主机名校验，当前叶证书到期为 2026-10-22 04:44:54 UTC。未关闭 TLS 校验或修改手机全局 CA。

Mac 新增独立 worker：`scripts/start-desktop-queue-agent.mjs`，由用户级 LaunchAgent `com.liutw.rmtcdx.owner-queue-test` 托管，启动文件位于 `~/Library/LaunchAgents/com.liutw.rmtcdx.owner-queue-test.plist`。仅使用已运行的 MCP 私有控制 socket，以及本项目 Inbox 的只读正文投影；不启动 Codex、不继承桌面 thread/pipe 环境。设备凭据和固定授权在 `.runtime/owner-queue-ecs/`，不提交 Git。启动时先登记并核对唯一目录，避免手机首次查询时会话尚未注册。

## 手机行为

- 首屏提供输入框、入队、刷新和电脑/领取窗口状态，任务按最新在前排列；Android 为原生菜单预留空间。
- `queued` 可直接取消，`leased` 只能请求协作取消，并显示“等待取消确认”。不会中断整个桌面 turn。
- `completed` 展示并可复制回答；任务正文和结果从电脑重建，刷新或重新打开 APK 后仍可读取。
- `unknown` 显示结果未知；旧的显式放弃保留 `outcomeUncertain`，不能解释为确定未执行。手机没有强制解除未知结果的入口。
- 交付 202 / job succeeded 不等于模型任务完成，只有回执 completed 才展示为完成。
- 发送标识及正文哈希保存在手机 origin 的 localStorage，正文不写入该存储。响应丢失时按原 intent 核对；找到已入队回执后清除对应草稿与待确认标识，不换 ID 重发。
- 没有远程新建会话、附件、审批、native start/steer/interrupt 或其他项目入口。

**领取仍需桌面显式开启有限窗口。** 窗口关闭后手机可以入队，但任务会等待，不自动唤醒桌面。需要处理时在这一个专用桌面聊天明确要求调用 `companion_inbox_open`，在同一 turn 反复 take、checkpoint、complete/ack_cancel，到期或达到任务上限后退出。整个桌面重启仍未测试，不能用本次 ECS 服务重启代替。

## 验收结果

| 检查 | 结果 |
| --- | --- |
| 默认门禁 | 无显式授权时仍关闭远程队列；原 loopback 测试开关保持 loopback 限制 |
| API 越界 | 普通 Mac 项目 API 404；原 acceptance 聊天入队 404；授权聊天的 native turns 403；非授权配对 403 |
| 返回目录 | 仅一设备、一项目、一聊天；worker 返回外部项目会被服务器拒绝 |
| APK 排队取消 | 未开启消费窗口时入队并取消，未被领取 |
| APK 第一条回答 | `APK_QUEUE1 TULIP-7386` completed |
| APK 处理中取消 | leased → cancelRequested → 桌面 ack_cancel → cancelled |
| APK 第二条回答 | `APK_QUEUE2 TULIP-7386` completed；与第一条及协作取消共用真实 turn `01a14073-f071-79a1-823a-874517d6845a` |
| 自动收尾 | maxJobs=3 后消费窗口 closed，专用聊天 idle，无 inflight |
| 页面恢复 | APK 刷新、进程重新打开及 ECS 服务切换后均恢复正文和两条回答；不补发旧任务 |
| 丢失响应 | Playwright 将实际已送达的入队响应中断；自动核对原 intent，只有一条 job.enqueued、零领取；随后通过页面取消，草稿已清除 |
| 云端落盘抽查 | 元数据文件 0600；元数据和服务 journal 未发现本轮及原队列测试标记正文 |
| 桌面隔离 | 桌面 42738、app-server 43367、MCP owner 20629 未变；原 acceptance 仍 9 轮，native 发送回执 SHA-256 未变 |

最终 Inbox 为 completed 7、cancelled 7，包含此前测试；没有 leased/unknown 阻塞或遗留排队任务。此前显式放弃的一条 cancelled 仍保留结果未知标记。

## 自动化与视觉检查

- 实际部署内容导出后业务 **55/55**；不包含旧工作区未提交的端点发现修复/额外一项测试。工作区全套为 56/56。
- MCP 原型 **43/43**；business 与原型 build 通过。
- ECS 构建及选定的 API/协议/worker/状态测试 **23/23**。
- Android assembleDebug、assembleDebugAndroidTest、lintDebug 通过。
- 荣耀完整队列验收 **1/1**（59.898 秒），最终版本只读重开验收 **1/1**（2.259 秒）。仅运行 `OwnerQueueSmokeTest#testQueueReadOnlyReopen` 可复核现有结果；完整写入验收使用本次固定标记，不应无核对地重跑。
- Browser 插件未提供，使用 Playwright CLI / Chrome，412×915 与 1280×900；页面 URL/title、非空、无框架错误、无横向溢出、刷新及取消交互通过，真机物理截图为 1224×2664。
- 控制台无未解释的应用异常；`favicon.ico` 404 为未配置图标，`ERR_FAILED` / `network_unavailable` 为主动注入的丢失响应探针。

私有证据位于 `.runtime/owner-queue-ecs/`：`honor-queue.log`、`honor-queue-final.log`、`browser-lost-ack-final.log`、`desktop-evidence.json`、`final-state.json`、`server-audit.json`、`final-deploy.log`、`package-tests.log`、`android-build.log`。Playwright 截图位于 `/tmp/rmtcdx-queue-ui/{mobile,desktop}-final.png`。证据和手机临时密码文件不提交；手机临时密码已清除。旧 thin-bridge 和端点发现的已有改动保持原状。

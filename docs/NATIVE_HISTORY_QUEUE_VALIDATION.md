# 历史会话按需接入

2026-10-21。专用 `rmtcdx companion acceptance` 已完成原 ID、原上下文、忙时排队、未加载恢复，以及荣耀通过 ECS 的发送、分段、历史关联与刷新恢复。最初仅向 RN 配置接收，不能据此宣称所有 RN 历史会话已经端到端可用。用户反馈切换会话仍为空后，确认遗漏了“只查看、不发送”的加载入口，补验记录见下。

## RN 历史切换补验

- 复现：荣耀选择“配置新挡板假车”时持续连接、历史为空；Mac 同 ID 的 follower 返回 `desktop_owner_unavailable`，该会话没有待办。只加载无 prompt 的原生视图后，原历史立即可读，证实与重新发送命令无关。
- 修复：本机 publisher 在手机历史读取需求出现且 native owner 未加载时，调用显式启用的 `historyLoader`。仅加载原生历史视图，不追加输入、不启用消费者、不改变归档。每次检查原 15 个 ID 范围、实时命名项目归属、cwd/archive、精确 CLI 版本和既有桌面进程，并串行/限频导航。桌面不在时不启动应用。可能切换桌面显示的会话，不中断模型。
- 专用验收：仅专用会话归档/恢复后触发只读需求，日志观察到 `desktop.history.view_requested` → `desktop.observer.ready`；原生队列没有新增消息。
- 荣耀真实触屏切换：“查找未提交的 testID 修改”显示 30 项（2 用户 / 12 回复 / 16 工具）；“修复遥控泊出按钮与导航栏重叠”显示 314 项（6 用户 / 37 回复 / 271 工具）。两条各执行一次真正 document 重载后恢复，未发送消息。初次加载约 0.74 / 18.95 秒；最终缓存/gzip 版本再次触屏选择、两次刷新通过，约 1.47 / 9.63 秒，不能承诺固定加载时延。
- 原 ID 接续：“配置新挡板假车”通过 ECS 发出一次限定文本的只读请求，真实 completed，耗时 19.48 秒；随后荣耀真实触屏发送第二条，模型从原上下文回忆上一条随机验收标记（第二次提示没有提供完整值），completed、原生 turn 关联与一次真正刷新恢复均通过。没有继续旧假车任务。
- 手机历史加载错误由历史区域展示；不再把首次快照尚不可用错误显示成“请求未完成”的发送失败。加载期间明确显示“正在加载历史记录”。
- 逐条只读核对原授权 12 条按需会话：共 9433 项、未压缩约 40.5 MB，均已完整读通。首次核对有 2 条失败，不能计入成功；修复后分别重读通过（3126 / 2519 项），结果合并保存，未向这些其他会话发测试消息。
- 修复两个后续问题：完整原生历史请求原先复用 20 秒超时，现独立使用 120 秒，审批仍为 20 秒；ECS 原先同时保留多个旧选择，累计达到 32 MB 上限后拒绝新投影，现只需求当前活跃订阅与最新直接读取的会话，释放已离开的历史，忽略其迟到正文。缺少云端快照时通过 `resyncIds` 请求 ready follower 重发，不需要新 native revision。32 MB 上限保留，没有扩大内存预算。
- 仅历史 JSON 协商 gzip；SSE 不压缩、不引入缓冲。最大一条 3126 项分 63 页，解码 12,283,328 字节，网络传输 3,508,366 字节，本次完整获取约 17.55 秒；未压缩前约 53.24 秒。冷热状态与网络有差别，不把它当成固定延迟承诺。
- ECS 缓存/压缩代码部署后，荣耀只观察同两条已完成意图，登录恢复、两次真正刷新、原生历史/结果关联和绿色“已同步”再次通过，耗时约 5.1 秒，没有重发手机消息。临时验收配置已移除，用户原地址和选择保留。
- 独立接收器/观察器重载与桌面重启分开记录；本次仍未重启桌面、app-server 或队列 worker。归档历史的自动加载尚未补验，仍不唤醒/不写入。新增项目成员不扩权。

私有证据目录：`.runtime/history-select-20261021/`。`history-selection.json/png`、`honor-selection-final.log` 是最终缓存/gzip 版本的真实荣耀切换/刷新结果，`before-cache-history-selection.json/png` 保留初次结果；`rn-send.json/log` 是 ECS 首轮接续回执；`rn-history-phone-continuation.json/png`、`honor-rn-send.log` 是真实荣耀第二轮发送/上下文/刷新结果。测试初次因另一项 Appium 占用前台而失败，不计通过。用户允许切回后完成触屏验收，测试助手已增加前台包名核对，避免向其他 App 注入点击。

`all-rn-history-before-capacity.json` 保留初次 10/12 的失败；`all-rn-history-retry.json` 是修复后两条重读，`all-rn-history-final.json` 为逐 ID 合并结果。`history-gzip-metrics.json` 保存实际线上压缩比与总量；`rn-post-cache-recovery.json/png` 是最终服务版本的荣耀观察验收。

本次 ECS 只更新已核对 SHA 的历史模块、JSON 响应和静态页，业务服务因模块变更重载两次（57868 → 58672 → 58755）；并非“整个系统零重启”。桌面 37325、app-server 37963、队列 worker 3368/3369 启动时间不变。除“配置新挡板假车”两条只读测试外，其余 14 条 Inbox jobs hash 不变；原长期领取继续同一 turn，其他会话无新增用户输入/任务启动事件。原生查看可能更新其内部会话元数据，不能以 rollout 文件 byte hash 不变作为保证。

最终本机 companion 87 项、business 77 项与各自 build 通过；Android instrumentation 构建和 lint 通过。ECS 新模块定向测试、实际 gzip 历史读取以及最终荣耀观察通过。未重新验收原生审批、整个桌面重启、所有网络状态或其他项目；仍只沿用既定授权范围。

## 当前使用

- APK 0.4.1 无需升级。手机发送后，Mac 常驻接收服务按需接入原历史会话；处理完当前已排队的一批便结束本轮，下一批再次自动接入。
- Mac 需开机联网并保持 Codex 运行；退出桌面时消息保留排队，不由本服务自动启动桌面应用。
- 原名单仍为 15 个 ID，没有随当前项目增加到 29 个成员而扩权。12 条新增按需接收；“补充蓝牙未连接恢复步骤”保留原长期领取与进行中 turn。
- 当前两条归档不唤醒：“补充车控 AD 与便捷换胎统计”（本轮发现新归档）和原先的归档会话。本机投影补充“仅查看”，原生追加前再次检查实时 archive 元数据。
- 页面显示“历史已同步 · 可直接发送”，未加载时显示“发送后接入原会话 · 历史同步中”。不要求用户手工开启 MCP 窗口。
- 在手机选择原授权的未归档会话也会按需加载历史，无须先发送一条消息。首次加载受桌面视图加载及完整历史大小影响。
- 接入会通过无 prompt 的原生 URL 加载桌面会话视图，建立实时历史和审批 owner，**可能切换桌面当前显示的会话**；不向其他会话发消息或中断其模型。仅查看目录不会批量启动模型。

## 实现与边界

旧研究针对 CLI 0.162。本轮安装包为 26.1013.40934，CLI **0.163.0-alpha.10.2**。新核查发现独立原生 `queue_1.sqlite`、外部修订监听与 `start_turn_if_idle` 路径。

这是当前内部格式的本地适配器，不是公开承诺兼容的桌面 API：

1. `HistoryInboxReader` 只读本项目 Inbox 的待办和消费者元数据，不读正文、不执行 recover/expire、不改其他消费者。
2. `HistoryReceiver` 为待办生成稳定接入 ID；已有活跃消费者时沿用，遗留在途/unknown 阻止自动接入。普通接入只领取当前一批，不开启模型空轮询。
3. `NativeHistoryQueue` 先 fsync prepared 回执，再按原生表结构执行单条原子追加，由原有唯一索引和触发器维护顺序/修订，不替换整份队列。**原生队列仅追加接入控制消息，手机正文仍走现有 Inbox。**
4. 原桌面在 idle 时原子启动。手机、ECS、本适配器均不调用 start/steer/interrupt，不另起共享 HOME 的 app-server，不修改安装包或数据库 schema。原 native 停用守卫保留。
5. `codex://threads/wake/<id>` 只能恢复 Core，不能保证 follower owner 存在；最终使用 `codex://threads/<id>` 加载原生视图。
6. prepared 且原生项已不在时返回 unknown，不重新插入；accepted 也只等待实际 MCP 消费回执，不冒充业务完成。服务恢复继续用原 ID/回执，不以文本相同进行跨消息去重。

只允许专用 ID 和原 RN ID 集合；RN 追加前重读命名项目归属、只读原生 metadata 的 cwd/archive。队列 schema SHA-256 固定为 `b1d0caf9abeec1744bc84b2373a312e0c09bdeb3c808c9bf8b0fcc5dcc7e24c5`，两项 SQLx migration checksum 均核对；常驻入口也检查 CLI 精确版本。升级不匹配时停写，保留业务队列，不回退其他执行器。

源码参照：[原生队列处理器](https://github.com/openai/codex/blob/main/codex-rs/app-server/src/request_processors/thread_queue_processor.rs)、[队列服务](https://github.com/openai/codex/blob/main/codex-rs/ext/queue/src/service.rs)、[原子持久化](https://github.com/openai/codex/blob/main/codex-rs/state/src/runtime/queued_items.rs)。上游 main 会变化，本轮以安装包、migration 校验及真机记录为准。

## 验证

| 项目 | 结果与证据边界 |
| --- | --- |
| 并发 | 临时原生结构库：2 个独立手机写者与模拟桌面 SQL 共 60 条全部保留、顺序唯一；不是桌面人工同时键入压测 |
| 忙时排队 | 专用第一轮执行 12 秒只读等待时追加第二条；形成不同 turn，第二条记住第一条未在第二次提示中提供的随机口令 |
| 未加载恢复 | 仅官方归档/恢复专用聊天，确认 notLoaded 后原生队列/URL 恢复同 ID；记住最新口令和最初 `LANTERN-4826` |
| 荣耀公网 | 两批共 4 条真实触屏发送均完成；后一批从 notLoaded 开始，处理之间消费者关闭，下一条重新按需接入 |
| 实时/历史 | 后一批第一条观察到 6 次真实累计正文增长；两条与原生 turn 精确关联，完整文字历史恢复 |
| 真正刷新 | 修复验收助手等待旧 document 的误判；针对同两条已完成任务，执行 2 次带 document 标记的重载，等待 WebView visual-state，截图实际看到结果与绿色“已同步”；没有重发 |
| 接收服务恢复 | 专用/RN 独立 LaunchAgent 重启后 idle，无新增 RN 原生消息；丢回执、消费后重复意图、unknown 不重放有定向测试 |
| 范围保护 | RN 15 条 jobs hash 全部不变；14 个其他消费者 hash 不变，原长期会话仅正常续窗，仍是 `01a15e46-4e1f-7f63-ba4c-fce14e83a0b7`。新增 12 条只配置接收，没有批量启动模型 |
| 生命周期 | 桌面 37325、app-server 37963、队列 worker 3368/3369 的 PID/启动时间不变；只重连本项目独立 observer，新增独立接收服务 |
| 构建 | companion 81 项、business 74 项通过，各自 build 通过；Android instrumentation 构建、lint 通过 |

后一批冷接入：两条从入队到真实领取约 9.17 / 8.80 秒；六段回答首次 progress 16.20 秒、完成 48.10 秒；短回答完成 12.67 秒。原生外部队列监听有约 10 秒周期，加上模型/工具耗时，**不承诺首次接入固定秒数**。回答使用真实增量，不制造逐字动画。

新入口本轮只执行专用只读测试，权限沿用现有桌面配置。没有向 RN 其他会话发测试任务，没有重新制造审批。整个桌面退出/重启、睡眠、弱网和高负载尚未端到端验收，不能与独立接收服务重启混为一谈。

## 部署与私有证据

- Mac：`com.liutianwei.rmtcdx-history-receiver-test`、`com.liutianwei.rmtcdx-history-receiver-rn`；入口 `scripts/start-history-receiver.mjs`。
- ECS：沿用 `/opt/rmtagt-business/releases/20261021T112904Z-personal-desktop`，仅更新 `business/{web,dist}/queue-app.js` 和 `desktop-history.mjs`，PID 57868 不变，未重启服务。
- `.runtime/history-entry-20261021/`：`busy-context/report.json`、`unloaded-wake/attempt.json`、`history-auto-phone-report.json`、`history-auto-phone-recovery.json`、`cold-phone-metrics.json`、`rn-enable-{baseline,readback}.json` 及构建/服务日志。凭据和手机临时配置不提交。
- 初始一条原生探针真实完成，但快照不保留 client message ID，脚本等待超时；未重放该意图，改用专用消息 hash 观察，并通过实际 MCP intent/turn 关联完成手机验收。初次手机探针因 owner 缺失失败在发送之前，改用原生视图路径解决。

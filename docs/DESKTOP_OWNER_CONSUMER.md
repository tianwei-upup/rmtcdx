# 持续领取、取消恢复与业务队列协议

> 最新：已授权专用项目的 ECS/APK 队列接入通过，见 [部署与验收记录](ECS_APK_OWNER_QUEUE_VALIDATION.md)；其他项目与 native 写入继续关闭，桌面仍需显式开启领取窗口。下文保留原阶段边界。

**本机专用验收已通过：空队列长轮询后继续领取、排队取消、协作取消、停止后保留任务、MCP 恢复后阻塞 unknown、显式放弃后恢复新任务。业务协议只在显式启用的 loopback 测试服务中验证；ECS/APK 写入仍关闭。**

本阶段沿用 `rmtcdx companion lifecycle`（`01a13fef-a018-7303-a2a6-f5903548537f`）及“专用测试项目”。原 acceptance 聊天保持 9 个 completed turn。只卸载/恢复空闲的专用控制聊天来加载 MCP；桌面 PID `42738`、app-server PID `43367` 未变，没有重启桌面或操作其他活跃聊天。

## 消费窗口

1. 桌面显式调用 `companion_inbox_open`，绑定宿主注入的真实 thread/turn ID。默认 120 秒、10 条任务；上限 600 秒、100 条任务，同时只允许一个窗口。
2. 使用返回的 `sessionId` 调用 `companion_inbox_take(waitMs:20000)`。空队列返回 `empty + continuePolling=true`，模型在同一 turn 继续领取。停止、到期、任务数上限或 unknown 阻塞时结束。
3. 任务顺序领取；每条先 checkpoint，完成前再确认取消状态，然后 complete 或 ack_cancel。数据库保证一个处理中租约，多个 frontend 不能额外抢占。
4. `companion_inbox_close` 或业务停止请求停止领取新任务；正在处理的任务可正常收尾。没有处理中的任务时立即 closed，其余 queued 保留。

窗口有明确时限，不留下无限模型轮询。MCP 服务继续常驻；窗口结束后新消息只排队，不自动唤醒聊天。进入下一窗口需要新的显式 open，不调用 native start/steer 兜底。

## 取消和恢复语义

| 状态/操作 | 结果 |
| --- | --- |
| queued + cancel | 原子变为 cancelled，不会被领取；同意图重提仍返回取消回执 |
| leased + cancel | 保持 leased，设置 `cancelRequested=true`；不调用 native interrupt |
| checkpoint 发现取消 | 模型停止该任务并 `ack_cancel`，随后可继续领取下一条 |
| 取消已到、complete 后到 | complete 被 `inbox_cancel_requested` 拒绝，要求显式 ack_cancel |
| complete 先提交 | 保留 completed；取消不能覆盖已完成结果 |
| 消费停止/超时 | 停止新增领取；queued 保留，已领取任务不自动释放或重发 |
| 等待中的 MCP 请求取消 | 关闭对应窗口，取消的轮询不会在后台领取后来任务 |
| 服务退出/重启 | 窗口关闭，leased 转 unknown；unknown 保留单租约阻塞，新 open 被拒 |

取消使用 `expectedRevision`；过时请求被拒，不能覆盖更新后的状态。租约 token 和真实消费 turn 必须同时匹配，新的 turn 不能凭历史 token 完成旧租约。协作取消发生在 checkpoint，不保证立即终止模型正在进行的工作，也不能把 cancelled 解释为“从未执行”。

桌面手动中断或模型退出而未收尾时，租约保守保持 leased/unknown 阻塞；窗口到期不会把它自动重排。本轮恢复验收使用的是专用 MCP 重载，不是整个桌面重启。

unknown 没有自动重排路径。仅本机操作者可调用 `OwnerInbox.resolveUnknown(intentId, expectedRevision, reason)` 显式放弃后续跟进；此操作不对 MCP 或业务 HTTP 开放，要求当前版本与理由并保留审计。放弃后回执为 `cancelled + resolution=abandoned_unknown + outcomeUncertain=true`，明确保留“执行结果未知”，不冒充完成或确定未执行。后续无关任务可恢复，旧意图永不自动重放。

## 业务协议 v2

三个身份分别保存：业务传递请求的 `jobId`、手机任务的稳定 `intentId`、桌面轮次的 `consumerTurnId`。消费窗口另有 `sessionId`。`leaseToken` 只给桌面 MCP 消费者，不进入手机/业务回执。

| 操作 | 本机 HTTP 入口 | 输入（省略 conversationId） | 输出 |
| --- | --- | --- | --- |
| `queue.enqueue` | `POST /api/conversations/:id/queue` | `clientIntentId, text`；intentId 使用 clientIntentId | `conversationId, receipt` |
| `queue.status` | `POST .../queue/status` | `clientIntentId, intentId?` | `conversationId, receipts, consumer` |
| `queue.cancel` | `POST .../queue/cancel` | 新 `clientIntentId, intentId, expectedRevision` | `conversationId, receipt` |
| `queue.consumer.stop` | `POST .../queue/stop` | 新 `clientIntentId, sessionId` | `conversationId, consumer` |

请求仍先返回业务 job，使用现有 `/api/jobs/:jobId` 查询交付结果。**enqueue 的业务 job succeeded 仅表示已持久化入队；只有 receipt.state=completed 表示模型任务完成。**不为队列项生成假 turn ID，不合成旧 `turn.started/assistant.delta` 事件。当前通过 queue.status 刷新状态，尚未为队列开放 APK UI 或新的 SSE 事件。

回执包含 `intentId, threadId, state, revision, cancelRequested, consumerTurnId|null, sessionId|null, outcomeUncertain`；完成时才有 result。未知放弃额外带 resolution。queued 没有消费 turn。消费状态包含窗口身份、期限、任务上限、已领取数、waiting 和 stopReason。

服务端保留现有登录、Origin 校验、设备令牌、已登记项目/聊天范围。输出必须与请求聊天/任务/窗口匹配。正文、回答和查询结果仅保存在服务端 RAM；持久化服务元数据只保存请求身份、指纹和状态。重启后的正文/结果需重新从本机状态查询，不能自动用新意图补发。

### 默认关闭的边界

- `OPERATIONS` 保持原有列表；新队列操作只放在 `SUPPORTED_OPERATIONS`，常规 worker 不会默认注册。
- 服务必须程序化传入 `enableLocalQueueTest:true`；origin 和实际 listen host 均限 `127.0.0.1/localhost`。没有自动读取的公网启用环境变量。
- 测试 adapter 和 agent 各自还需显式启用本机模式；adapter 只允许精确专用聊天，拒绝附件、任意 RPC、host/cwd 覆盖。
- 普通服务器返回 `queue_protocol_disabled`，本机模式拒绝 LAN 监听；原 ECS 启动器仍使用默认只读 adapter。
- adapter 每 5 秒核对伴随服务身份/协议；断线时 ready 关闭，恢复后重新核对。未知写入依旧不重放。

## 真实验收证据

| 项目 | 结果 |
| --- | --- |
| 持续空轮询 | 真实 20 秒 empty 返回后继续同一 turn，随后领取新任务 |
| 正常任务 | `STREAM1 BIRCH-6428` completed |
| 领取中取消 | 首次 checkpoint 后请求取消；第二次 checkpoint 识别，ack_cancel；与正常任务同属 turn `01a14056-e4cb-77a2-8d08-6d1f53eab98b` |
| 停止/保留 | waiting 时停止，后入队占位仍 queued；原 turn 正常结束 |
| 未确认恢复 | 占位只领取一次，未执行工作；仅重载专用 MCP 后变 unknown |
| 恢复门禁 | 真实 MCP open 失败，`inbox_outcome_unknown`；marker `exec-a6a613e5-e676-480c-8ba9-17545f9c11c8` |
| 显式核对后恢复 | 放弃占位并保留 outcomeUncertain；新任务 `STREAM_RESUMED BIRCH-6428` completed，turn `01a14059-53cb-7c33-96ab-3c48c97374f8` |
| 数据/范围 | native 发送回执 hash 未变，acceptance 目标仍 9 轮，服务端持久化文件没有任务/回答正文 |
| 收尾 | 窗口 closed，无处理中任务；测试 worker、loopback HTTP 服务已停止，MCP ready |

本机证据：`.runtime/owner-consumer-validation/report.json`、`final-state.json`、`progress.json`、`blocked-probe-confirmed.json`；SQLite audit 记录全部状态转换、revision、窗口身份、取消与核对理由，不记录正文或租约 token。原三条已完成任务经过 v2 原子迁移保留。

自动化测试：提交版本独立导出后，原型 **43/43**、business **51/51**；原型/business build 通过。旧工作区的 52 项结果包含一项未纳入本次提交的端点发现测试。新增覆盖版本冲突、关闭/截止窗口、跨 turn 租约拒绝、unknown 显式放弃的结果标记、worker 断连恢复、本机协议全链路、默认拒绝及 LAN 监听拒绝。整个桌面重启仍未测试，不能用本轮 MCP 重载替代。

复现入口 `scripts/verify-desktop-owner-consumer.mjs` 只编排本机业务协议，不向聊天发消息。它以阶段文件等待主控制端在专用聊天执行 open/停止/恢复；固定测试意图已存在时拒绝自动重跑，不删除数据库或重置 unknown 来获得“通过”。本阶段运行未新增依赖、未修改 Android、未部署 ECS。

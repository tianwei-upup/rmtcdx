> 2026-10-21 最新授权：手机与桌面同权限已完成专用写入及 RN 复验；原只读描述为历史阶段，当前状态见 [APK 自用模式](APK_PERSONAL_MODE.md)。

# 一次启用的只读队列待命

2026-10-21 19:17 更新：已对先前中断的 RN 指定会话显式重新启用长期领取，并完成荣耀 3 条真实任务与 APK 正常启动验收；当前保持 active / waiting，见 [恢复验收](RN_UI_STANDBY_RESUME_VALIDATION.md)。


2026-10-16。本轮目标是在原桌面会话中一次启用、持续领取、正常结束后继续，以及队列伴随进程退出后的恢复。先在已注册的“专用测试项目”验证，不重启桌面，不向其他活跃会话发送消息。

## 工作方式

`standby.mjs` 在本项目自己的 Inbox SQLite 中保存启用状态，并绑定 MCP 提供的实际 thread / turn。只有本机配置显式列入 `standby.threadIds` 的未归档会话有三个额外工具：`rmt_queue_standby_enable`、`resume`、`pause`。手机不能启用、指定消费 turn 或扩大名单。

一次 `enable` 后，每个内部消费窗口仍最多十分钟、100 条；到期或达到条数后在原 turn 自动续窗。模型必须使用每次 job / reply.next 返回的 `sessionId`。启用状态检查、过期处理、开窗和绑定放在同一个 SQLite 写事务中，避免中断暂停与续窗交错。

已信任的项目 Stop Hook 只在启用且原 turn 完全匹配、没有 leased / unknown 任务时阻止正常结束，要求模型调用 `resume`。每分钟最多六次 Hook 续接，防止 MCP 故障导致快速循环。Hook 不调用 native start / steer / interrupt，也不读取桌面聊天正文。

| 事件 | 行为 |
| --- | --- |
| 没有手机消息 | 原 turn 继续长轮询；内部窗口到期自动续窗 |
| 模型正常结束 | 可信 Stop Hook 在同一 turn 继续领取 |
| 本地队列 worker 退出 | 启用意图保留；原 turn 可连接恢复后的 worker |
| worker 退出时有未完成租约 | 标为 unknown，阻塞后续领取；不重放 |
| 手机停止当前窗口 / 桌面 pause | 持久化停用，Hook 不重新开启 |
| 用户中断原 turn | Interrupt Hook 停用并将未完成租约标为 unknown |
| 整个桌面应用或原生 turn 已消失 | 此机制不能凭空唤醒新 turn；未做桌面重启验收 |

云端仍只处理已有队列协议，正文不新增云端持久化。待命会使桌面 turn 长期处于工作状态，并产生定期 MCP 调用；电脑离线、睡眠、MCP 不可用时不能保证实时回答。

手机停止请求按启用时的 policy revision 关联内部窗口。点击时若已经自动续窗，仍会暂停同一次待命；已暂停后重新启用，则旧窗口迟到的停止请求不能影响新的待命。真实项目 Hook 也会重新检查显式项目成员关系，同目录的其他命名项目不获得续领权限。

## 专用原生验收

- 项目：`专用测试项目`，ID `54e5cb30-3486-42d8-9612-d0f2c23aea19`。
- 原会话：`rmtcdx companion lifecycle`，ID `01a13fef-a018-7303-a2a6-f5903548537f`。
- 目录：`/Users/liutianwei/Documents/Codex/2026-10-15/rmtcdx-companion-lifecycle-20261015`。
- 本轮使用独立本机真实 Inbox 和实际桌面 MCP；不冒充 ECS / APK 端到端结果。之前 ECS / APK 的实时性证据见 [队列实时性验收](QUEUE_REALTIME_VALIDATION.md)。
- 本地专用 owner：`scripts/start-standby-test-owner.mjs`，LaunchAgent `com.liutw.rmtcdx.standby-lifecycle-test`。脚本固定专用测试 ID，只接纳 `localOnly=true` 配置。
- Hook：项目 `.codex/hooks.json` 调用 `scripts/queue-standby-hook.mjs`。用户已在设置中分别信任 Stop 和 Interrupt；没有修改信任哈希或绕过审查。

已确认原生 Stop Hook 执行：探测 turn `01a1429b-6517-77c1-a35f-a243619f8ce8` 留下实际 `standby.hook_seen`。

托管验收原 turn 为 `01a1429d-1b70-7a32-83d6-8f585a121557`。一次启用后完成 `STANDBY-FIRST`，模型按验收指令正常结束，原生 Hook 留下 `standby.continued`；随后 `STANDBY-AFTER-STOP` 在相同原 turn 完成，未再发送桌面唤醒消息。

原 turn 总时长 **665,708 ms（11 分 5.7 秒）**；审计只有一次 `standby.enabled`，所有被领取任务的 `consumer_turn` 均为上述同一 ID。

| 验收项 | 实际结果 |
| --- | --- |
| 原生 Stop Hook | 产生 `standby.continued`，正常结束后同 turn 完成第二条回声 |
| 跨真实十分钟 | 原窗口以 deadline 关闭，新 session 自动打开；第 607 秒完成 `STANDBY-AFTER-TEN-MINUTES`，未再次 enable 或发送桌面唤醒消息 |
| 边界后实时领取 | 本机入队到 leased 为 47 ms，入队到完整回声为 4,849 ms；仅此单次本机样本，不替代 ECS / APK 延迟数据 |
| 已领取取消 | lease 后提出取消，最终 cancelled、revision=4，没有发布被取消的结果 |
| 本地 worker 强制退出 | 仅 `launchctl kickstart -k` 专用 owner，PID 25682 → 66820；原 turn 连接恢复后的 worker，新 session 回答 `STANDBY-AFTER-WORKER-EXIT`，从重启起约 12.35 秒完成 |
| 主动停止及恢复 | 手机协议的 consumer stop 后持久化 disabled；再次只重启该 worker，PID 66820 → 67482，仍 disabled。随后消息保持 queued 五秒且没有消费 turn，最后取消清理 |
| 原 turn 退出 | managed thread 状态 completed / idle，error=null；最终 Stop Hook 没有重新开启托管 |
| 清理 | 4 completed、2 cancelled、无 inflight，专用待命已关闭 |

以上是实际本机队列与原生桌面模型试验。真实 Interrupt Hook 的人工中断、MCP stdio 前端被杀、桌面应用 / 整机重启、长时间睡眠恢复和全天稳定性尚未验收；Interrupt 的隔离行为目前有单元测试。没有把本地 worker 恢复描述为桌面退出后自动唤醒。

桌面主进程 PID 42738、app-server PID 43367 保持不变。没有给其他活跃会话发送消息。

## 自动检查

`prototype/desktop-companion` 的 `npm run build && npm test`：59/59 通过；覆盖一次启用跨窗口、同 turn 恢复、异 turn 拒绝、缺少 opt-in 拒绝、unknown 不重放、暂停恢复后仍停用、停止请求跨续窗与跨启用代次隔离、停止续接故障上限、共享目录项目移出后 Hook 拒绝、长等待快速取消与后续任务不被误领。真实等待一秒后自动续窗的加速测试与原生十分钟验收分别记录。

`business` 的 `npm run build && npm test`：63/63 通过。尚未为本轮重部署 ECS 或扩展其他项目。

私有证据在 `.runtime/standby-validation/`，不提交运行数据库、私人配置或凭据。

## 项目启用要求

专用验收通过后，已为“壳工程RN UI相关”的原固定名单配置 opt-in：14 个未归档会话，原 1 个归档会话仍禁用。配置在 `.runtime/project-queue-rn/config.json`，项目 Hook 在 `/Users/liutianwei/Projects/android/carapp-intl/shell/apps/main/.codex/hooks.json`。MCP tool timeout 初始为 75 秒，后续长等待优化调整为 650 秒。

应用配置前确认 15 个队列无 active / stopping consumer、无 inflight，然后仅重启 RN 队列 worker，PID 68852。检查 14 个有待命能力、启用数为 0、归档 opt-in 为 false；实际 stdio MCP 注册 13 个工具，但这不代表已有桌面前端已重载。ECS 授权和服务均未修改，没有扩展项目或会话名单。

用户随后分别信任了 RN 项目两个 Hook。只对已经结束且无在途任务的“补充蓝牙未连接恢复步骤”（`01a1392d-9340-70d0-b5ad-642c63c448db`）归档 / 取消归档以卸载旧 MCP 前端，未对其他会话执行该操作。原生探测 turn `01a142b3-f4ff-73b1-8b22-a1502fa4f023` 加载三个待命工具，Stop Hook 实际审计证明信任生效。

### RN / ECS / 荣耀 APK 验收

荣耀 `ACTH022325002169`，已安装 APK 0.4.0 / versionCode 6，使用真实表单、HTTPS ECS、SSE 和 RN 桌面模型。没有重装主 APK 或改用 mock；Appium 使用独立端口 4737 / systemPort 8317，华为设备未操作。

验收 turn `01a142b5-6129-7090-92e0-ad4c3865acfc` 总时长 **659,277 ms（10 分 59 秒）**，只启用一次：

| 验收项 | 实际结果 |
| --- | --- |
| 手机首条回声 | APK 完成并显示 `RN_STANDBY_FIRST` |
| 正常结束后继续 | Stop Hook 留下 `standby.continued`；手机提交的 `RN_STANDBY_AFTER_STOP` 在同一 turn 完成，没有额外桌面唤醒消息 |
| 手机取消 | 正确定位后的取消测试最终 cancelled / revision=4、无 result；后续领取仍正常 |
| 手机刷新 | 选中会话、历史结果、active consumer 和实时同步恢复 |
| 跨真实十分钟 | session `706daa9d-026c-4219-bf82-6b72396be929` 到期后自动续为 `a2c7a6f1-cd7f-4f84-9027-4e2e52e1485f`；手机表单提交 `RN_STANDBY_AFTER_TEN_MINUTES` 后完成，原 turn 未变。电脑入队到 leased 为 10 ms，到完成为 4,853 ms |
| 手机停止 | 点击“停止领取新任务”后 disabled / owner_paused、consumer closed、无 inflight；原 turn completed / error=null，Hook 没有重开 |
| 其他会话 | 名单中其余 14 个队列没有消息和 active consumer；归档会话仍禁用 |

最初的 Appium 脚本连续滚动，把最新结果和取消按钮滚出了屏幕，导致第二条“35 秒可见”、一次取消定位超时和一次回声定位被终止。电脑审计和页面自身观测显示结果实际已提前到达。脚本改为确认输入框清空后，用 `UiScrollable.scrollIntoView` 定位对应任务，随后回声、取消、刷新和十分钟边界测试均通过；这些脚本失败没有计为产品通过。

### 实时性慢样本及长等待优化

验收暂停后曾显式恢复 turn `01a142bf-9ed3-7600-ab66-e204386acf8d`。回声 `RN_STANDBY_READY_FOR_PHONE` 出现了**真实 38.4 秒**的手机结果渲染延迟，不能归因于上述滚动脚本：本机入队到 leased 为 10,459 ms，leased 到完成为 27,557 ms。该轮手机八条请求的入队展示范围为 0.36–3.63 秒、领取展示 0.36–10.85 秒、完整结果 3.27–38.40 秒；取消请求展示约 446 ms，确认约 2,797 ms。样本少，不以 P95 宣称 SLA。

已明确暂停并结束该 turn 后，只重启空闲的 RN 队列 worker（68852 → 33294），只重新加载这个验收会话。MCP v0.8 为显式 opt-in 的 standby enable / resume / reply 提供 **600 秒空闲等待**，对应桌面 tool timeout 为 650 秒；有限模式不获得长期等待权限。服务端仅对已启用且原 turn / session 匹配的待命放宽 60 秒上限，协作停止仍在下一次 100 ms 轮询处理。

此修改减少每 25 秒空返回后重新经过模型调度的空档；不能约束模型生成、网络和高负载的耗时。用户不能据此期待所有回答都在几秒完成。

长等待原生试验 turn `01a142c4-a787-7e92-bdd8-cbfe3afec4a6` **在同一次工具调用中空等 92 秒**，没有 consumer.empty / 提前关闭 / 再次 waiting。随后荣耀通过真实表单发送 `RN_STANDBY_LONG_WAIT`，电脑入队到领取 **7 ms**、到完成 **4,190 ms**，Appium 含定位和截图的可见结果检查为 6,010 ms。证据在 `.runtime/standby-validation/rn-native-long-wait.json`。

此后手机再次点击停止，consumer 从 closed 到 wait_ended 相隔 **7 ms**，长等待没有阻塞停止；原 turn 正常 completed / error=null。确认停用后，按用户长期使用要求显式恢复同一个会话，当前待命 turn 为 **`01a142c7-972c-7733-9816-0df25cd870c6`**，policy revision=7，active / waiting、无 inflight；这次恢复有明确指令，未由手机队列或 Hook 暗中开启新 turn。

最终该队列累计 10 completed、1 cancelled（包含之前的 2 条历史测试），其余 14 个名单内队列均无消息、无活跃消费者。只为当前这个会话保留长期待命，其他 13 个未归档会话尚未启用，归档会话保持禁用。桌面 / app-server PID 42738 / 43367 不变，没有给其他活跃会话发消息或重载其前端。已结束本轮 Appium；主 APK 留在所选 RN 会话，未重装或更新。

### 以后使用

1. APK 选择“Mac” → “壳工程RN UI相关” → “补充蓝牙未连接恢复步骤”，直接发只读问题；当前已留在长期待命。内部十分钟 / 100 条计数自动续窗，无需每十分钟回电脑。
2. 其他原名单会话首次需明确要求“启用本会话的长期只读手机待命”，调用 `rmt_queue_standby_enable` 一次。未启用时手机只排队。看不到新工具的旧会话应在空闲后单独加载，不为此重启桌面或打断正在进行的工作。
3. 手机“停止领取新任务”或桌面明确暂停 / 中断后保持停用；要继续时再次明确启用。电脑须保持开机联网。完整桌面退出或原生 turn 消失后，队列不能自动唤醒新 turn。

ECS 授权名单和部署未改变，本轮未提交或 push；旧 thin-bridge 等无关本地改动继续保留。

官方 Hook 语义与信任说明：[审查和信任](https://learn.chatgpt.com/docs/hooks#review-and-trust-hooks)、[Stop](https://learn.chatgpt.com/docs/hooks#stop)、[Interrupt](https://learn.chatgpt.com/docs/hooks#interrupt)。实际运行结论以本轮原生审计为准。

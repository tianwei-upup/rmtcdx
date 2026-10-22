# 桌面 owner 原子接纳缺口

> 2026-10-21 更新：CLI 0.163 的独立原生队列已找到并验证[原子追加与按需恢复路径](NATIVE_HISTORY_QUEUE_VALIDATION.md)，未复用本文的非原子发送接口。下文保留 0.162 时期的接入限制和已证伪路径。

日期：2026-10-15。MCP 加载已解决，见 [当前验收](DESKTOP_COMPANION_MCP.md)。**当前可调用接口不足以在原有桌面聊天中安全接纳手机消息，业务默认只读；这不是已完成的原子互斥实现。**

> 后续已选择并通过专用本机测试的替代方案：[桌面 MCP 主动领取队列](DESKTOP_OWNER_PULL.md)。它原子追加本项目 Inbox，不调用 native start/steer；多条任务可在同一 turn 内处理。本文的缺口仍针对原生输入接纳，ECS/APK 写入继续关闭。

## 接纳需要保证什么

桌面用户与手机同时操作同一聊天时，检查 idle 和开始 turn 必须由已有 owner 在一次串行操作中完成。远程请求只能得到“接纳并返回精确身份”“安全排队”或“冲突拒绝”，不能改变正在运行的 turn，也不能覆盖桌面排队消息。

本地进程锁、先查询再发送、手机关闭发送按钮，都无法约束桌面输入。因此不能用它们替代 owner 侧保证。

## 本机证据与边界

安装包为 26.1007.71326，随包 CLI 为 `0.162.0-alpha.17.2`。以下判断来自本机安装包代码、生成协议与专用测试只读探测；上游 main 源码仅作辅助，不当作安装版本的运行证明。

| 接入面 | 已确认事实 | 判定 |
| --- | --- | --- |
| native App Tools | `send_message_to_thread` 最终调用 `submitPrepared(..., "send-now", false)`；schema 没有 expected-idle、expected-turn 或 queue 参数 | 存在检查后桌面先启动的竞态；切换 Queue 默认值不能解决 |
| native App Tools 路由 | 当前工具与外层消息 schema 不暴露通用 app-server RPC、MCP reload 或队列 API | 不可通过塞入未知参数获得能力 |
| 已有 owner IPC | 用真实新客户端身份注册，成功发现两个专用聊天的 owner，并读取 model settings；未申请接管或修改队列 | 证明可只读联系 owner，不能推出可安全发送 |
| follower 队列接口 | `thread-follower-set-queued-follow-ups-state` 接受整份 state；`acceptFromFollower` 整体替换，除 outcome-unknown 项外不保留 owner 同时新增项；没有 revision/CAS | 读出后追加再写回可能丢失桌面消息，未调用该写接口 |
| follower start/steer | 暴露启动/steer 操作，没有原子的 idle-only 前置条件 | 不作为手机接纳替代 |
| 实验 app-server 协议 | 随包 CLI 可生成 `thread/queue/add/list/update/delete/reorder/start` 类型；API 位于桌面持有的 app-server transport，未暴露给本 MCP | 协议存在不等于当前可安全调用；未劫持 stdio、未启动第二个共享 HOME app-server |
| MCP reload | 生成参数不含 thread ID，不能保证只刷新专用聊天 | 未调用；使用专用 idle 聊天卸载/恢复验证加载 |
| UserPromptSubmit Hook | 运行在执行输入处理层；上游路径对 FunctionCallOutput 不执行该 Hook，且运行中输入被阻止可能影响当轮退出 | 不能证明覆盖所有 native 委派输入；未安装 Hook |

只读 IPC 探测仅针对 `rmtcdx companion acceptance` 与 `rmtcdx companion lifecycle`。以自有 clientType 初始化，使用路由分配的 client ID，拒绝承接任何聊天 owner；没有冒充桌面客户端、订阅其他聊天或操作其队列。

本机证据保留于 `.runtime/desktop-companion-mcp/owner-probe.json`、`probe-owner.mjs`；随包实验协议位于 `.runtime/companion-owner-protocol/`；安装包只读提取位于 `.runtime/desktop-control-research/asar/`。这些私有目录不提交、不上传 ECS，后续升级后必须重新验证。

## 新增候选：上下文启动的 busy 检查仍不原子

owner `startTurn` 对非空 `context.responseItems` 有两次 busy 检查，错误为 `App context must wait until the current turn finishes`。专用控制聊天在执行本轮探测命令期间提交一次该请求，真实 owner 返回此错误；当前 turn ID 不变，没有新增 turn。证据：`owner-busy-self.json`，脚本 `scripts/verify-desktop-owner-busy-self.mjs` 只允许在实际专用控制聊天执行，禁止当作 idle sender。

但检查后还有 `await thread/inject_items`。另一条桌面请求可以已在准备阶段，随后先启动；上下文请求恢复后仍调用 `turn/start`，可能 steer 新启动的 turn。`scripts/verify-desktop-owner-admission-race.mjs` 从当前安装包只读提取实际 `Uun` 函数，在隔离 VM 中运行两条交错请求，复现了此反例。`turnStartObservations` 只管理观察者，不取消前一条实际请求，不能作为互斥。

这项反例属于**安装源码的隔离执行验证**，传输为 fake app-server，未在真实桌面制造竞争。证据 `owner-context-race.json` 含源码 SHA-256、调度顺序和 `atomicAdmissionPassed=false`。脚本退出 0 表示反例复现成功，不表示原子接纳通过。真实 busy 拒绝通过也不能据此开放 idle 发送。

## 已落地的门禁

- `CompanionService.status()` 显式返回 `atomicIdleAdmission=false`、`atomicQueueAppend=false` 和 `productionGate=desktop_atomic_admission_unverified`。
- scope 只接受 `mode=test`、专用控制聊天 ID、测试目标 ID 与精确 cwd。MCP `companion_send_test` 保留为隔离测试能力，不对真实项目授权。
- 业务适配器默认仅注册 `projects.sync`、`sessions.sync`、`conversation.snapshot`；直接调用 `turn.start` 在任何 native 操作前拒绝。
- `allowNonAtomicTestSends=true` 仅用于隔离协议测试；当前 worker 启动脚本无启用入口，业务 worker 保持停止。
- 已存在的整轮锁、意图去重、unknown 持久化不重发继续生效，但只保证伴随服务内部一致性。

## owner 最小接口合同

推荐由已有桌面 owner 暴露窄接口，或在提供等价保证的版本中接入；当前不修改签名应用包、不注入 renderer、不绕过宿主工具路由。

1. 请求包含精确 `threadId`、稳定 `intentId`、正文 hash、明确的 `idle-only` 或 `enqueue` 策略，并校验本机授权范围。
2. owner 在其唯一队列/turn 协调处原子检查状态并接纳。`idle-only` 遇忙直接冲突；`enqueue` 仅原子追加，绝不 steer、替换或清空已有队列。
3. 同 intent 和 hash 重试返回原回执；同 intent 不同内容拒绝。接纳结果持久化，断线后可按 intent 查询，不靠前后历史差分猜测关联。
4. 回执明确区分 rejected、queued、started、unknown；返回精确 `submissionId`，启动后返回精确 `turnId`。队列在 idle 时启动的判断也必须原子完成。
5. 队列新增与桌面输入走同一串行接纳机制。只新增 MCP 外层锁或仅增加一个布尔参数而未改变 owner 实现，不满足合同。

## 取得接口后的专用测试验收

- 同时提交桌面输入与手机 idle-only 请求：至多一个启动，其余明确拒绝或排队；不能出现 steer。
- 桌面排队新增与手机 enqueue 并发：所有消息保留且顺序可解释，不能覆盖原有项。
- 相同 intent 并发与 ACK 丢失后重试：只接纳一次，回执关联精确；内容变化返回冲突。
- owner 在接纳前后异常退出：重启后不补发 unknown，不丢已持久化排队项。
- 服务与整个桌面分别重启：原测试 ID、历史、锁与回执一致，使用新 pipe，其他活跃聊天不受操作。

以上先在专用测试聊天通过，再进行 ECS/APK 接入与逐项目授权。桌面整体重启仍需等待用户允许的空闲窗口，本轮未执行。

# 伴随 MCP：恢复与并发验收

> 当前后续：[持续领取、取消恢复与本机业务队列协议](DESKTOP_OWNER_CONSUMER.md) 已通过专用本机验收；MCP 共 11 项工具，原型 43/43、business 51/51。整个桌面重启、ECS/APK 写入仍未开放。

日期：2026-10-15。**桌面已实际加载项目级 MCP，直接托管伴随 owner；标准 stdio MCP、整轮会话锁、服务重启与异常退出恢复已验证。整个桌面重启恢复尚未验收，当前可调用接口仍缺少原子接纳能力，业务写入默认关闭，未开放真实项目手机访问。**

> 已通过专用本机测试的替代入口：**[桌面主动领取队列](DESKTOP_OWNER_PULL.md)**。三条任务通过本项目原子 Inbox 交付，由专用聊天主动消费，不使用 native start/steer。原生接纳缺口仍存在，业务/ECS/APK 写入门禁保持关闭。

## 授权范围与当前状态

仅操作既有专用测试会话 `rmtcdx companion acceptance`（`01a13feb-ce80-7ca3-aa1e-17814542b353`）；专用控制会话仍为 `rmtcdx companion lifecycle`（`01a13fef-a018-7303-a2a6-f5903548537f`）。没有向用户此前的活跃会话发送消息、中断或修改归属，没有重启桌面或现有 app-server，没有新增 Mac 账户。

当前 MCP 直接由桌面已有 app-server（PID `43367`）托管，真实 `companion_status` 返回 ready；控制模型轮次结束后仍可用。MCP owner PID 随专用控制聊天卸载/恢复而变化，以本机 `owner-pull-final.json` 状态为准。原生测试能力通过 desktop pipe 操作精确授权目标；Inbox 不调用该写入路径。没有启动第二个 Codex 执行器，历史测试客户端已退出。

测试控制工程使用项目级 `.codex/config.toml`，全局配置仅追加该专用目录的 trust 条目；没有全局 MCP 条目。原配置备份在本机私有 `.runtime/desktop-companion-mcp/config-before.toml`。此前控制聊天未加载工具的记录已被下面的真实调用结果取代。

用户已添加“专用测试项目”（项目 ID `54e5cb30-3486-42d8-9612-d0f2c23aea19`），路径 `/Users/liutianwei/Documents/Codex/2026-10-15/rmtcdx-companion-lifecycle-20261015`。只将专用控制聊天归入其中；没有移动测试目标或其他聊天。

为避免旧实现继续写入，旧测试伴随进程及 `mac-companion` 业务 worker 已停止，旧 `companion.mjs` CLI 明确拒绝启动。新 MCP 保留测试范围常驻；ECS 服务未部署、未重启，真实项目均未开放。业务 worker 的后续入口已指向新 MCP runtime，恢复前仍需验收门槛通过。

## 实现

- 使用官方 MCP SDK，提供原五项工具及 `companion_inbox_take`、`companion_inbox_complete`。校验控制会话 metadata，Inbox 额外绑定原 turn；不提供任意 RPC 或 shell 工具。
- 多 MCP frontend 可复用同 scope 的唯一 owner；owner 锁竞争时转为 proxy，不启动第二个 native 写者，proxy 退出不停止 owner。scope 不匹配则拒绝。
- scope 仅接受 `mode=test`，绑定精确 thread ID 与 cwd；scope/状态文件 0600、目录 0700。桌面 native pipe 来自每次宿主启动的新环境，不持久化旧地址。
- SQLite 排他事务持有内核文件锁，进程退出自动释放；它只锁本项目 runtime，不访问桌面数据库。owner JSON 原子写入，阻止双 owner 同时回收陈旧文件后成为写者。需要带 `node:sqlite` 的随包签名 Node，本机已验证可用。
- 每个会话在第一次异步操作前预留锁；发送 ACK 后继续持有，直到真实 turn 到达 completed/interrupted/failed。不同授权测试会话可以独立运行。
- 发送前 fsync 持久化 unknown；同 intent 返回原回执，文本 hash 不同则冲突。发送超时/断线不重发，unknown 跨重启保持阻塞，不用新观察到的 turn 猜测已执行成功。
- 已确认发送的 turn 在重连/重启后继续对账；关联出现多条候选时保留 unknown。后台只重试连接与读取，指数退避上限 30 秒。
- stdio 关闭或父进程退出清理本实例；测试客户端可恢复异常退出的 MCP 子进程。正式桌面宿主的重启行为仍需独立验收。
- 业务适配器在 await 前预留会话，使用服务回执 turn ID；快照透传原生分页。仍是桌面摘要投影，不能声称完整原始 transcript 或 token 流。
- 业务适配器默认只注册三项读取操作；`turn.start` 在任何 native 调用前拒绝。非原子发送仅保留显式隔离测试开关，worker 启动脚本未开启。

## 桌面 MCP 加载问题：已解决

1. 专用控制目录原先没有 Git 根；仅在该目录补齐空 Git 标记，并保留精确目录 trust 与项目 MCP 配置。
2. 使用**随桌面 CLI、实际工作目录指向该目录**执行 `mcp get rmtcdx_companion`，确认配置可见。npm CLI 的 `-C ... mcp get` 在本机返回缺失，不能拿该结果判断桌面实际加载情况。
3. 既有控制聊天继续缓存旧工具。仅对已确认 idle 的专用控制聊天做归档/恢复，卸载其运行上下文后以原 ID 续聊；没有重启共享 app-server 或桌面。第一次恢复曾返回加载错误，随后同 ID 续聊成功；第二次恢复成功。
4. 专用控制聊天实际执行 `companion_status`，native 标记类型为 `mcpToolCall`。归入新项目后再次通过：turn `01a14031-5942-7992-a8e9-9a98ac6dcf96`，marker `exec-532722b4-de37-4ab0-9a34-d208bccc435e`。

这组操作验证的是本专用聊天的配置加载。没有证明添加项目本身就会刷新已加载的聊天，也没有将其作为其他活跃聊天的通用重载方案。当前 PID/状态属于验收时点，后续以真实调用核对。

## 验证结果

| 验证 | 结果 |
| --- | --- |
| SDK initialize/tools/list/tools/call | 通过；缺失/错误 caller metadata 拒绝；参数 schema 校验通过 |
| 真实桌面连接 | 签名 Node MCP 子进程成功读取原测试 ID，控制模型轮次结束后仍可用 |
| 桌面项目级 MCP 接管 | **通过**；桌面 app-server 直接托管 owner，真实 MCP 工具调用完成，归入新项目后复验通过 |
| 第二个 MCP frontend | **通过**；连接已有 owner，关闭 frontend 后 owner 仍存活；没有新增 native 写者 |
| 业务默认写入门禁 | **通过**；不注册 `turn.start`，直接提交也在 native 调用前拒绝 |
| 桌面主动领取 Inbox | **本机专用测试通过**；同一 turn 连续两条，忙时另入队一条仍在原 turn 完成，详见独立记录 |
| 同会话并发 | 首轮运行中，第二个意图被 `test_thread_busy` 拒绝，没有调用桌面发送 |
| 运行中服务重启 | MCP PID `13884 → 14519`；原 turn `01a14010-2ff9-7af0-9a24-4fda26064234` 的运行锁恢复，未重复发送 |
| 原 ID 第二轮续聊 | `MCPRESTART LANTERN-4826 \| PREVIOUS LOCK1 LANTERN-4826`；turn `01a14010-7746-7db0-9622-27b93155b58e` |
| MCP 子进程异常退出 | 专用测试子进程 SIGKILL 后 `16629 → 17268`，测试客户端自动重启，ready 恢复；没有杀桌面或 app-server |
| 新桌面 socket + 进程重启 | **模拟集成测试**通过：mock native endpoint A 关闭，MCP 被 SIGKILL，endpoint B 注入新进程；原意图只发送一次 |
| 发送 ACK 丢失 + 重启 | **模拟集成测试**通过：写入一次、回执 unknown、重启后仍阻塞，不补发 |
| 整个桌面重启 | **待验证**；为保护活跃任务，本轮没有执行 |
| 桌面输入原子互斥 | **未具备**；见下节，生产门槛关闭 |

真实测试会话现在包含原有 7 轮加本阶段 2 轮，共 9 个 completed turn。测试标记沿用原记忆，没有换 ID。MCP 真实验证脚本的 intent ID 固定；重复运行只取回执与快照，不再新增写入。

本机私有证据：`.runtime/desktop-companion-mcp/desktop-activation.json`、`proxy-acceptance.json`、`owner-probe.json`、`live-acceptance.json`、`crash-recovery.json`、`mcp-handshake.json`、`service.jsonl`。服务日志只记录元数据；快照证据仅留本机，未上传 ECS。

- 原型测试：33/33（新增跨进程 Inbox、单租约、turn 绑定、SIGKILL 后 unknown、取消及 proxy 检查）。
- 原型 `npm run build`：通过。
- business 测试：上一阶段 50/50；本轮 `npm run build`：通过，未修改 business 源码。
- `git diff --check`：通过。
- Android 本轮未改动、未重新构建或操作设备；上一阶段 APK 结果不能替代本轮桌面恢复验收。
- 只读 MCP 问答评估集已保存于 `prototype/desktop-companion/evaluation/acceptance.xml`，未单独运行外部模型评估。

## 为什么还不能开放现有项目

安装包当前实现为：`send_message_to_thread → Moc → Boa → sendFollowUpMessage → submitPrepared(..., "send-now", false)`。没有 expected-idle/expected-turn 参数，走的是 follow-up/steer，不采用桌面默认 Queue 设置。伴随检查到 idle 后，桌面用户可能先开始新 turn；随后 native send 仍可能成为 steering。**本机整轮锁只能排除本服务内的并发，无法原子阻止桌面输入。**

因此实现显式返回 `productionGate=desktop_atomic_admission_unverified`，scope 不接受生产模式。不能用“先查状态再发”假装已经解决桌面全局互斥，也不能通过绕过 owner 或恢复旧 app-server 达成。

只读 owner IPC 探测成功，但现有队列接口是整体替换，不支持 CAS/原子追加；底层 app-server 的实验队列 API 没有暴露给本 MCP。没有调用队列写接口、全局 MCP reload 或安装输入 Hook。具体证据边界、已排除路径和所需 owner 接口见 [DESKTOP_OWNER_ADMISSION.md](DESKTOP_OWNER_ADMISSION.md)。下一步应先取得 owner 的安全接口；这些条件通过前，不自动放开原有活跃会话。

## 空闲窗口桌面恢复验收

1. 等用户活跃任务结束，记录只读状态与测试会话原 ID；不要在仍有任务运行时结束整个桌面。
2. 当前已由桌面直接托管 MCP，无需恢复历史测试客户端。保留项目级 MCP 配置、scope 和回执。
3. 在专用控制聊天实际调用 `companion_status`，记录 caller、scope、父进程与 ready；只读核对目标 ID 与当前锁。
4. 在安全空闲窗口重启桌面；只使用宿主新注入的 pipe 地址。确认服务恢复、旧 intent 不重发、原 ID/历史与锁状态一致。
5. 桌面与手机并发接纳门槛通过后，按明确项目 ID 分批授权；默认不纳入历史活跃会话。

配置依据：[官方 MCP 配置文档](https://learn.chatgpt.com/docs/extend/mcp)。该文档支持 stdio 和可信项目级配置；本文的加载状态以实测结果为准。

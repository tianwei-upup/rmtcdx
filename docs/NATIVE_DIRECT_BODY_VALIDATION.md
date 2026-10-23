# 手机正文直入原生队列验收

日期：2026-10-23。**专用会话功能通过；低延时推广门槛尚未通过，保持专用试点。**

后续即时通知已完成专用验收：原子接纳后使用桌面已有的 `threads/wake` 路由，荣耀接纳至原生开始降至 0.32–0.88 秒；忙时、重复通知和刷新通过。最新结果与推广边界见 [原生队列即时通知验收](NATIVE_QUEUE_WAKE_VALIDATION.md)。下文保留此前未加 wake 的历史样本。

## 范围与结果

- 仅 `rmtcdx companion acceptance`，原 ID `01a13feb-ce80-7ca3-aa1e-17814542b353`，原 cwd `/Users/liutianwei/Documents/Codex/2026-10-15/rmtcdx-companion-acceptance-20261015`。
- 荣耀 `ACTH022325002169`，APK 0.4.4，ECS `mac-realtime-test`；全部提示词只读，禁止工具、文件、命令、外网和旧任务。
- 五条手机正文逐条核对：原生 UserMessage 的 client_id 精确关联、正文与本机 Inbox 完全相等，各只有一次入队、一次预留、一次原生输入、一次原生完成；没有 MCP/命令/其他工具调用。最终无 queued / leased / unknown 或本测试原生排队残留。
- 未重启桌面、全局 MCP 或 ECS 服务；其他项目仍采用原领取模式。没有启用个人全项目 worker 的直入，未提交 / push。

## 实现

新路径：手机 queue.enqueue → ECS 业务意图 → Mac 原子 Inbox 预留 → 原会话原生原子队列 UserInput → 原生公开增量 / 完成事件 → 手机。

`NativeDirectInbox` 独立于 MCP 消费者：

1. 自有 SQLite 事务持久化手机 intent → 稳定原生 client_id 的映射，同时预留唯一 inflight。原生 UserInput 只含实际正文，模型不承担 listen / progress / reply 等运输职责。
2. 原生队列继续使用既有版本、schema / migration 校验与 fsync 回执；原子追加保留桌面原有排队项。异常窗口沿用同一个 client_id，prepared / unknown 不盲目重放。
3. 通过原生 UserMessage.client_id 或 turn.params.clientUserMessageId 匹配精确 turn，不按相同文字、时间接近或最近一轮猜测。原生接纳、队列行消失、生成过文字均不单独证明完成。
4. 公开原生文字形成真实进度，只有对应原生 task_complete 才形成 completed；失败或中断保留 unknown 并阻止后续任务越过。历史文件提供持久完成证据，原生 follower 提供公开增量。
5. 服务恢复保留 native_dispatch 预留；旧消费者不能接管未完成直入任务，旧历史激活器识别直入模式后跳过。
6. 桌面投影只给精确原生 client_id 添加既有 queueLinks。手机合并同一正文，保留原生 commentary / final / 工具历史；已有原生回复时隐藏重复的队列答复。

模式默认关闭，只允许上述专用 ID。`start-project-queue-agent.mjs` 的 `nativeDirect` 显式配置必须同时满足 dedicated-test、相同 ID 和原 cwd / 当前未归档 / 当前 CLI 校验；不能为 RN 或个人项目启用。专用 publisher 使用同一 scope 和只读 native_dispatch 关联。其他实例启动参数及进程保持原状。

## 真机与恢复

| 检查 | 结果 |
| --- | --- |
| 三条相同测试正文，分别物理点击发送 | 每条各执行一次，未调用领取工具 |
| 每条运行时另发两次相同意图 | 均 202 且返回原业务任务 ID，原生输入仍一次 |
| 三条完成后真实页面 reload | 原 ID、原 turn、完成结果、完整历史均恢复 |
| 第四条原生运行时退出 / 恢复专用 Mac worker | 91561 → 10079；原 turn 继续执行，恢复后核对完成；正文未重发 |
| 第五条原生运行时真实页面 reload | 刷新前 leased；新文档恢复 leased；随后同一 turn completed，只显示一个手机正文 |
| 完成后相同意图 / 正文再次提交 | 202，原业务任务 ID，未新增原生输入 |
| 相同意图但正文冲突 | 409 intent_conflict，未送到原生执行 |
| 原上下文 | 第四 / 五条未提供原值，均正确回忆 BOOTSTRAP 标记 LANTERN-4826 |

第四条的测试脚本最初将优雅退出上限设为 10 秒，worker 因等待既有 HTTPS claim 长轮询结束而更晚退出；脚本先报超时。随后只恢复该 worker，并核对同一条已持久化任务，没有重发正文。第五条的初版 HTTP 断言错误地 stringify Promise 得到空对象；改用等待实际响应后，同一已完成意图的 202 / 409 与原生只执行一次均已核实。两次测试脚本问题及首次记录保留在私有证据中。

## 首段延迟对照

同一专用会话、相同正文，保持 `gpt-6.1-sol / xhigh`，不切模型、改推理强度或裁剪历史。统一以至少 10 个字符的真实公开输出计时，不含占位文字，不承诺固定 SLA。此前过程更新用最早可见文字（有时只有一个真实生成的字）；本表重新用一致阈值对齐桌面与手机。

| 路径 | 样本 1 | 样本 2 | 样本 3 |
| --- | ---: | ---: | ---: |
| 桌面 owner 正常启动入口 → 本机公开首段 | 3.471s | 2.629s | 2.982s |
| Mac 本机原生原子入队 → 本机公开首段 | 8.371s | 11.710s | 12.530s |
| 荣耀 APK → 手机首段可见 | 12.482s | 6.444s | 8.533s |
| 对应 APK 回合，本机公开首段 → 手机可见 | 0.089s | 0.137s | 0.400s |

桌面基线通过已有 owner 的正常 start-turn 入口，在确认专用聊天、原生队列、Inbox 均空闲后发送；只用于本机测量，不加入生产 sender 或开放给手机。它沿用桌面设置，没有使用 `send_message_to_thread` 的 app_tool_send_message 触发类型；早期该管理工具的约 7 秒样本不计入对照。不是人工按键计时，也不证明该非原子启动接口适合远程接纳。

三组路径依次采样，模型服务负载并未受控；不同回合不能直接相减归因全部性能收益。APK 时间由手机 DOM 变化记录并校准时钟；本机首段取原生 follower 的公开文字增量。手机也记录了完整段落落盘前的真实文字，因此新路径不必等整段 JSONL 落盘才开始显示。

### 剩余瓶颈

APK 三条发送 → 本机 Inbox 为 0.192–0.264s；本机原生队列写入完成为发送后 0.459–0.513s。对应原生 turn 启动却为发送后 9.290s / 0.752s / 5.198s；原生自身报告的首 token 指标为 2.936s / 5.246s / 2.509s（它与 follower 的首条公开增量不是同一个计时边界）。

因此额外 MCP 领取往返已消除，相同公开文字阈值下的输出到达本轮约 0.09–0.40 秒；主要剩余接入开销是原生外部队列的拾取。多条原子入队样本在约相同的 10 秒相位启动，与已留存上游 `watch_external_messages` 每 10 秒检查外部 SQLite 变更的实现一致。本机原子入队也出现 8 秒以上的同类等待，进一步排除手机 / ECS 是这段空档的主要来源。上游源码仅作解释，不将其当作当前安装二进制每一分支的运行证明。

**下一步应找已有 owner / app-server 的原子队列接纳或队列变更通知入口，消除外部队列检查空档。** 当前可调用 follower 接口中的 start / steer 和整份队列替换，仍不作为真实项目的忙时安全接纳方案。没有为降低延迟绕过原子接纳、修改签名桌面包、共享 HOME 启动第二执行器、重启桌面或操作其他活跃聊天。

## 当前限制与上线状态

- 直入任务在进入原生预留后暂不提供取消 / 停止；手机隐藏该不支持的动作，后端也拒绝，不虚报取消。预留前的本地排队仍可取消。
- 正文受既有 Inbox 16000 字符、原生写入 32768 UTF-8 字节上限约束；队列长回复为带标记摘要，完整公开内容保留在原生历史。
- 荣耀连接状态中检测到 VPN 网络，本轮没有改变手机网络设置，因此不把本次结果表述为已经完成“断开 VPN”的专项复验。
- 归档 / 原 cwd / 版本校验仍拒绝写入。未验证本轮模式的桌面整体重启、原生忙时桌面与手机混合并发、手机审批或真实项目扩围。
- ECS 只热更新四个页面模块（queue-app / queue-state / desktop-merge / desktop-history），保存旧文件和 hash 并逐文件读回。线上 PID 73214 不变，原有鉴权、项目授权和后端协议未修改。
- 原测试队列 worker 和专用 publisher 更新；旧专用激活器卸载运行，未来重新启动时也识别 native_dispatch 跳过。其他进程未重启。收尾恢复荣耀原页面与草稿，移除临时 ADB 转发和只读观察器。
- companion 构建与 126/126 测试通过，business 构建与 112/112 测试通过。新增 10 项直入状态机 / 真实 SQLite 异常窗口回归，以及旧激活器、client_id 关联和手机合并验证。

私有证据：`.runtime/native-direct-20261023/` 的 phone-1..3.json、local-1..3.json、desktop-direct-1..3.json、timeline.json、audit.json、recovery.json、inflight-refresh.json、native-events.jsonl、构建 / 测试日志、ECS 资源前后 hash 和进程记录。原始状态及手机正文不提交。

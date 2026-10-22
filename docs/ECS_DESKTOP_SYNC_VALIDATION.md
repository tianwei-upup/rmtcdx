> 2026-10-21 最新授权：手机与桌面同权限已完成专用写入及 RN 复验；原只读描述为历史阶段，当前状态见 [APK 自用模式](APK_PERSONAL_MODE.md)。

# ECS 桌面历史、队列合并与原生审批验收

2026-10-21 19:17 后续：用户已明确授权恢复“补充蓝牙未连接恢复步骤”的长期领取，荣耀 3 条消息、分段、刷新与正常 APK 启动均通过，当前 active / waiting。下文 closed 是本阶段先前快照；最新结果见 [长期领取恢复验收](RN_UI_STANDBY_RESUME_VALIDATION.md)。


2026-10-21。专用 acceptance 的公网 HTTPS / 荣耀实机闭环已通过；随后仅按既定 15 个会话名单接入“壳工程RN UI相关”的只读历史、输出和工具状态。未重启 Codex 桌面，未向真实项目发送消息或恢复其已中断的领取。未提交或 push。

## 实现与权限

- `business/src/desktop-relay.mjs`：精确 device / project / conversation 授权；独立发布者 epoch、8 秒存活检查、RAM 历史与审批信箱。历史正文、工具内容、审批明细和决定不写服务器状态文件或日志。
- `business/src/server.mjs`：沿用 HTTPS、管理员 HttpOnly / Secure / SameSite cookie、Origin 校验；设备侧使用配对 Bearer token，拒绝携带网页 Origin 的 agent 请求。新增固定业务接口，不接受 RPC 方法名、任意命令或原始桌面帧。
- `prototype/desktop-companion/src/desktop-publisher.mjs` / `scripts/start-desktop-publisher.mjs`：独立 follower，不重启现有队列 worker，不接管 owner，不调用 native start / steer / interrupt。审批仍在本机用原生请求的 owner / epoch / request / 内容指纹校验。
- 云端通过 `/api/agent/desktop/{hello,ping,projection,claim,result}` 收取公开投影、返回一次性审批意图；浏览器通过 `desktop/{history,events,approvals}` 访问。`approvals/<intentId>` 查询回执。云端 claim 前即标为已领取，30 秒无回执为 unknown；不重新分配。不把 ACK 当成执行成功，以 owner 待审消失及工具终态确认。
- 新增配置 `RMT_BUSINESS_DESKTOP_SCOPE_FILE`，内容为精确 `{deviceId,projectId,conversations:[{id,approvals}]}` 数组，必须是现有队列 grant 的子集。队列准入与历史可见性、审批写入互相独立。
- RN 发布者使用 `lazy=true`：手机实际选中会话后才订阅，离开后闲置超时释放；每次核对本地命名项目成员资格。不按共享 cwd 扩权，不批量载入其余聊天。未加载的 owner 不会被手机自动创建或唤醒。
- 两个独立 LaunchAgent `com.liutianwei.rmtcdx-desktop-sync-{test,rn}` 托管观察进程；不是桌面模型待命进程。重启观察者不恢复或重新执行队列任务。

## 消息合并

`business/web/desktop-merge.mjs` 只按 MCP 工具记录中的 `intentId` 关联手机消息；多条手机任务共享同一原生 turn 仍分别展示一次。已关联的队列传输工具行由对应消息/进度/结果替代，其他原生工具与公开回答保留。不根据相同文字猜测重复消息。

旧的未领取/取消记录按入队时间插入历史，原生项使用 turn 时间（或 UUIDv7 时间）；不会挤到更新的桌面答复之后。还未领取的手机消息、发送状态及取消入口继续显示。原生文字直接来自 owner 增量，不用定时器拆字；不承诺一 token 一帧。

队列工具的 leaseToken 等凭据在本机投影前剔除。真实历史中抽取的 13 个不同 lease 样本均未出现在 ECS 公开历史里。

## 专用实机闭环

测试会话 `01a13feb-ce80-7ca3-aa1e-17814542b353`，设备 `mac-realtime-test`，项目 `rmtcdx-companion-test`。荣耀 `ACTH022325002169` 直接使用 `https://47.95.141.18`，没有本轮 ADB reverse；原有 8081 映射保留。只更新测试 APK，主 APK 未重新安装。

1. 手机从真实聊天输入框入队两条文本任务；真实桌面 turn `01a15dd5-dc0c-70c0-bf11-d2c097b975b2` 通过 MCP 处理。每条 8 次公开累计 progress，最终两条完成且各显示一次，原生 MCP 身份关联及真实页面刷新通过。手机实际观察到 12 次中间变化，部分网络批次合并了相邻更新。
2. 人工审批测试 turn `01a15dd8-7fb6-7533-8ea5-9322d2d8a7d7`，实际执行上下文为 GPT-5.6 Sol / `:read-only` / `on-request` / `user`。先生成公开长文本，再执行一次 `curl --head --max-time 10 https://example.com/`。沙箱 DNS 失败后申请同一命令的原生人工审批。
3. 原生 request 571；荣耀实际触屏点击“拒绝”，公开 approval ID `ec04f1ab22ae8bcc48bf9e24e603d25230324b23b168ffc907535d57e18f3780`。本机持久 ledger 只有 1 个 decline，状态 submitted；随后 owner 清除待审，命令项 `exec-38f57e87-fab9-4a46-80ca-21147931c7f9` 为 declined。模型报告审批后未执行，未重试，最终标记 `ECS_NATIVE_DECLINE_DONE_20261021`。手机最终答复和刷新恢复通过。
4. 本次原生文字增量在荣耀观察到 48 次；触屏到手机显示电脑确认耗时 **355ms**。两条手机入队到展示回执分别约 **206ms / 239ms**。仅为此次 Wi-Fi 公网小样本，不代表 4G/5G、弱网或固定延迟保证。
5. 队列首段输出约 33.7s / 82.6s，包含等待手动开启验收消费、模型调度及前一条串行任务，不能把回执耗时当作模型首字时延。回答生成期间按真实增量更新，未伪造实时性。

验收后恢复专用会话原模型、effort、权限和审批控制；全局 `config.toml` SHA 未变。原生无 active turn、无 pending request。恢复时显式设置 canonical `permissions`，再核对 latestThreadSettings 的 profile / sandbox；只恢复显示字段会被旧 canonical 权限覆盖。最后一次执行的 currentPermissions 仍描述只读验收 turn，不篡改历史元数据。

## RN UI 范围与当前状态

只新增既定项目 `c28d39c4-620e-41ca-a8bc-8c6f0e78ccb3` 的 15 个精确会话历史权限，名单与现有 queue-scope 相同。14 个未归档会话继续原只读队列政策，1 个归档会话不能入队；不扩大其他项目。

真实项目所有 `approvals=false`：可显示工具和待审状态，审批继续在电脑处理，未授权手机执行命令、写文件或授予长期权限。专用人工审批通过不自动授予真实项目执行权限。

只打开已结束的“补充蓝牙未连接恢复步骤”历史视图，用荣耀验证完整公开历史、工具状态及刷新；**发送消息为 0**。其余会话未发送消息、未启动模型 turn。RN 的观察者按手机选中会话订阅，其余没有批量连接。

该会话旧待命 turn 已于此前中断，当前 consumer 为 closed。此次保留中断后的停用状态；历史已同步不等于模型正在领取。手机现在分别显示“历史已同步 · 等待电脑开启接收”，避免误导。恢复待命属于显式重新启用，不由观察者或手机自动代办。

## 发布与验证

- ECS：`i-2zefnzrsukslova9192y` / `cn-beijing`，服务 `rmtagt-business`；未部署 Codex、旧 control / thin-bridge 或新公网端口。
- 最终 release：`/opt/rmtagt-business/releases/20261021T095054Z-desktop-sync`；归档 SHA-256 `9accb2e0822b60f80dfbc2c2eadb7da83e79fdcf5e6539b988c4a24fe8af51b4`。
- 最终静态提示补丁同时更新该 release 的 web/dist `queue-app.js`，SHA-256 `04cdd613cf54c129f1337dc14b08a5973f4b16d9c55584e0dcc7169ea703a2cd`；静态补丁没有重启服务。归档哈希不包含这个补丁。
- 本机 business build / tests **73/73**；companion build / tests **67/67**；Android assembleDebugAndroidTest / lintDebug 通过。
- ECS 适用测试 **68/68**。本机完整测试通过；Linux 部署排除两个已有桌面环境测试文件：`attach-integration` 在 Linux 挂起、`existing-executor-discovery` 的 macOS `/tmp` 符号链接 fixture 不适用于 Linux，未将其算为云端通过，也未改无关实现。
- 先验收后开 RN gate；每次服务版本切换前确认没有排队/运行中的业务任务，失败不切换 current。ECS API 服务做过版本切换，既有 Mac 队列 worker 和 Codex 桌面没有重启。
- 首轮荣耀发现 `desktop-merge.mjs` 静态路由漏放行；修复后增加真实 HTTPS 静态模块回归，后续实机通过。

私有证据位于 `.runtime/desktop-ecs-validation/`：`closed-loop-evidence.json`、`actual-turn-policy.json`、`honor-{queue,native}-report.json`、`honor-rn-readonly.json`、`cloud-audit.json`、`latency-observations.json`、`preservation.json`、构建与实机日志。包含正文的私有证据不进入 Git。

## 尚未验收

4G/5G / 弱网 / 长时间后台、全天负载、桌面或主机重启后的模型唤醒、允许一次与真实文件变更审批、其他模型人工审批兼容性仍不算通过。新功能没有扩大已有真实项目的写权限。

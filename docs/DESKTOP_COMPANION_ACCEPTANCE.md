# 桌面原会话 → ECS → APK 验收

> 后续阶段见 [伴随 MCP 恢复与并发验收](DESKTOP_COMPANION_MCP.md)。本文保留第一阶段时点证据；当前启动器和运行状态以后续记录为准。

日期：2026-10-15。结论：**同一 Mac 账户内，桌面工具托管的伴随进程已通过原 ID 续聊、桌面同步、受托管生命周期、ECS 业务任务及荣耀 APK 纵向验证。** 当前仅开放本轮新建的测试会话，不是全项目生产接入。

## 测试对象

- 对话：`rmtcdx companion acceptance`，ID `01a13feb-ce80-7ca3-aa1e-17814542b353`。
- 控制聊天：`rmtcdx companion lifecycle`，ID `01a13fef-a018-7303-a2a6-f5903548537f`。
- 工程目录分别位于 `/Users/liutianwei/Documents/Codex/2026-10-15/rmtcdx-companion-acceptance-20261015` 与 `rmtcdx-companion-lifecycle-20261015`。桌面工具未提供创建命名项目的能力，因此使用新建的独立工程目录与未归类聊天；没有修改原有项目归属。
- Mac 账户沿用当前 `liutianwei`，没有创建或切换账户。
- ECS 沿用 `i-2zefnzrsukslova9192y` / `cn-beijing`，既有 HTTPS 业务服务；新增测试设备 `mac-companion`，不替换原 `mac` 设备或其历史目录。
- 手机：荣耀 `ACTH022325002169`、Android 15。没有操作华为设备。

## 验收结果

| 项目 | 结果与证据 |
| --- | --- |
| 初始化 | 新会话回复 `BOOTSTRAP LANTERN-4826` |
| 同 ID 第一轮续聊 | `ROUND1 LANTERN-4826`，提示词没有重发标记 |
| 重启伴随进程后第二轮续聊 | `ROUND2 LANTERN-4826 \| PREVIOUS ROUND1 LANTERN-4826`，原 ID 不变 |
| 桌面同步 | 用户明确确认三条回复都显示；后续桌面工具读取到相同 ID 下的 ECS/APK 回复 |
| 重复意图 | 重启后重查第一轮意图返回原回执，没有新增模型轮次 |
| 非白名单目标 | 本机控制端在进入桌面写路径前拒绝，`test_thread_not_allowed` |
| 启动方轮次结束 | 伴随进程仍由桌面 app-server 托管，能够继续读取、重连并发送；收到 `LIFECYCLE LANTERN-4826` |
| 重连 | 保持桌面父进程的情况下关闭再建立 native pipe 连接成功 |
| 显式停止 | 本实例 socket 与 owner 文件均清理 |
| 父进程退出 | detached 负向实验最初复现“存量连接可读、重新连接被拒”；增加父进程监测后，实测记录 `parent_lost → stopped`，无残留 owner/socket |
| ECS 业务任务 | 原会话回复 `ECS LANTERN-4826`；项目、目录、快照、真实 turn ID、完成事件一致 |
| 荣耀 APK | 两轮回复为 `APK1 LANTERN-4826`、`APK2 LANTERN-4826 \| PREVIOUS APK1 LANTERN-4826`；刷新后重选原会话仍含初始化与最终 APK 回复，16.443 秒通过 |
| 云端正文留存抽查 | 业务元数据与服务 journal 均未包含测试标记；仅返回检查布尔值，没有下载服务器正文 |

最终桌面读取显示同一 thread ID 下 **7 个 completed turn**，与初始化、两次本机续聊、生命周期、ECS、APK 两轮逐项对应；`hasMore=false`。没有向本轮之前的活跃会话发送消息。

所有私有原始证据位于 `.runtime/desktop-companion-acceptance/`：`final-report.json`、`local-gate.json`、`owned-lifecycle.json`、`owned-lifecycle-final.json`、`run-orphan/companion.jsonl`、`ecs-verification.json`、`ecs-audit.json`、`honor-final.log`、`honor-final.png`。截图 1224×2664，仅含测试聊天。测试密码配置已从手机及本轮临时文件删除。

## 实现与边界

链路为 APK → ECS 固定业务任务 → Mac 普通业务 worker → 本机受保护控制 socket → 桌面伴随客户端 → App Tools → 桌面原 session。

- 新增 `prototype/desktop-companion/`，使用安装包随附的签名 Node，由现有桌面工具会话直接托管。伴随进程不启动任何 Codex/app-server，不读写桌面配置或状态库。
- 伴随进程白名单只有上面的验收对话。控制聊天是身份来源，不是远程写入目标。
- `business/src/agent.mjs` 增加适配器能力子集与事件接入点；native 停用守卫保留。新增测试适配器只领取 `projects.sync`、`sessions.sync`、`conversation.snapshot`、`turn.start`。
- 写入前持久化未知回执，断线或回执不明时不重复发送；新 turn 无法唯一关联则保留未知结果，不能编造轮次 ID。
- ECS 现网版本不接受消息 `kind` 字段，测试投影使用原有文本契约。没有部署、重启 ECS 服务或修改端口、安全组；新增设备通过既有配对业务 API 登记。
- 桌面 `read_thread` 是摘要接口；原型仅覆盖少于十轮的短文本验收历史，拒绝把 `hasMore=true` 的结果报告成完整历史。ECS 增量由完成快照生成，没有声称原生 token 流式传输已接入。

## 生命周期结论

**通过的是“桌面工具会话直接托管”的启动合同。** 当前启动方模型轮次可以结束，真正的进程父节点仍是桌面 app-server，所以连接能够重新鉴权。

普通 Node、中间父进程退出后的 detached 启动均不能替代此合同。父进程退出时现在自动清理。没有安装全局 MCP、LaunchAgent 或另一个执行器，也没有证明桌面重启后可以自动恢复。MCP 常驻包装属于后续工作，不能写成已完成。

为保留用户正在运行的任务，本轮没有重启整个桌面、让 Mac 睡眠或结束桌面 app-server。也没有在用户真实活跃会话上测试并发抢占。

## Android TLS 修正

最初真机停留空白页，诊断为 `SSL_UNTRUSTED / Trust anchor for certification path not found`。手机实际证书 SHA-256 与本机一致：`206474ca832fd0109a999bfc0bf42522967bfe4a9c68883271af966e96a77a71`。服务现在提供 Let’s Encrypt `YE2` 签发的公共证书；生成目录中的旧 debug IP 配置只信任测试 CA，所以拒绝了当前链。

移除 `android/app/build/localTlsRes/xml/network_security_config.xml` 中针对该公网 IP 的过时独占 CA 覆盖，恢复默认 system 信任后，真机 HTTPS 与完整流程通过。该文件是被忽略的本机构建资源；没有调用 `SslErrorHandler.proceed()`、修改 TrustManager、安装手机全局 CA 或放宽 release TLS。

新的调试 APK：`artifacts/codex-remote-companion-debug.apk`，已通过 `adb install -r` 保留数据覆盖安装。

SHA-256：`cf2716ce607a4757f981c029b6d58edbcbc66ba38ed3ab16755fbbceb563e10a`。

## 构建与测试

- `npm --prefix prototype/desktop-companion test`：9/9。
- `npm --prefix prototype/desktop-companion run build`：通过。
- `npm --prefix business test`：50/50；调整后的 worker 专项再次通过，覆盖能力子集及事件 sink。
- `npm --prefix business run build`：通过。
- Android `assembleDebug`、`assembleDebugAndroidTest`、`lintDebug`：通过。Mac 使用完整 Corretto 21 JDK；裁剪过的 JBR 缺少 jlink，不能用于此构建。
- 荣耀 `DesktopCompanionSmokeTest#testOriginalDesktopSessionViaEcs`：1/1，16.443 秒。

本轮代码未提交、未推送。伴随与业务 worker 保留运行以继续查看测试入口；它们只允许该新测试会话。下一阶段应先完善常驻包装、权限/能力展示、长历史与并发控制，再考虑逐项目开放。

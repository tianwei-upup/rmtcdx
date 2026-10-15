# 业务任务服务（本地及 ECS 验证）

> 2026-10-15：真实执行器目前停用，受控启动入口会拒绝运行。共享桌面 Codex profile 的旧配置不再允许；隔离验收完成前不要按下方历史命令启动。详见仓库 `docs/CODEX_RUNTIME_ISOLATION_AUDIT.md`。

本实现用独立业务实体、异步任务、租约和结果投影替代旧中转。电脑通过 HTTPS 领取固定类型任务，直接调用 Codex app-server stdio；不连接 `3210` HTTP bridge，不开放电脑服务端口，不转发网络请求或原生协议帧。

## 本地启动

依赖 Node 22、已登录的 Codex CLI，以及已经应用本仓库补丁并构建的 `services/rmtcdx/apps/bridge`。

1. `npm --prefix services/rmtcdx/apps/bridge run build`
2. `npm --prefix business run build`
3. `node scripts/setup-business-local-tls.mjs <电脑的局域网 IPv4>`
4. `NODE_EXTRA_CA_CERTS="$PWD/.runtime/business/tls/ca.pem" RMT_BUSINESS_LAN_IP=<同一 IP> node scripts/start-business-local.mjs`

首次启动自动创建本地管理员密码、配对 Mac 执行器，仅登记 `.runtime/compat-workspace`。凭据保存在 `.runtime/business/local.json`（0600），不要提交、截图或粘贴到日志。已有配置不会被环境变量覆盖；IP 变化时应先停服务，再更新该文件的 origin、重新生成服务器证书和调试 APK。

手机和电脑必须位于可互通的局域网。Android 调试构建读取 `android/app/build/localTlsRes` 中生成的专用信任资源；只有指定 IP 信任此开发 CA，正常校验主机名。release 构建不包含该资源。不安装全局 CA、不忽略证书错误、不使用 ADB reverse。

独立生产入口为 `business/src/server.mjs` 和 `business/src/agent.mjs`，后者通过 `RMT_BUSINESS_AGENT_CONFIG` 读取配置。ECS 的独立 systemd 单元与部署说明位于 `deploy/business/`；本地启动器使用固定隔离项目，不能直接用作生产配置。

## 契约与状态

- 用户接口创建 job 后立即返回 202；随后读取 `/api/jobs/:id`。
- 固定任务：`projects.sync`、`directory.sync`、`sessions.sync`、`conversation.create`、`conversation.snapshot`、`turn.start`、`turn.cancel`、`approval.resolve`、`attachment.stage`。
- 执行器有两条路径：native（spawn 本机 app-server，当前被停用守卫拒绝）与 attach（附加到已运行的 app-server）。attach 只接受本地 Unix socket 或本地 ws 端点，缺失时失败关闭，不回落 native、不自动拉起第二个执行器。详见 [附加型执行器接入实现](../docs/ATTACH_TRANSPORT_IMPLEMENTATION.md)。
- 任务参数拒绝 `path`/`cwd`/`absPath`、目标 URL、HTTP method 与通用 RPC 操作名（ADR 001 禁令，已有测试固化）。
- 执行器接口只有配对、心跳、领取/确认/结果核对、结构化业务事件。不存在 HTTP method/path/header、目标 URL 或任意 RPC 入口。
- SSE 从服务拥有的业务事件日志发布；最多每设备 256 条/1 MiB，5 分钟 TTL。断线或重启后通过快照重新核对；手机断线不取消轮次。
- 同一 clientIntentId 必须匹配同一设备、操作及参数指纹。写任务过租约后进入 unknown；执行器在本机落盘执行意图和终结回执，核对回执不会重新执行。
- 服务端只持久化设备、项目和会话 ID、任务状态/指纹、轮次元数据。提示词、标题、消息、图片、事件正文仅在有容量限制的内存中短期保留。重启丢失载荷后明确过期/未知，不静默重投。
- 提示词和结果各受内存预算限制，结果与投影各最多 32 MiB；附件最多 100 个/16 MiB，单图 2 MiB、5 分钟 TTL；快照/目录使用版本化游标分页，目录变化时游标失效。

## 当前能力边界

本地配置始终使用只读 sandbox。远程审批仅支持拒绝/取消命令和文件变更审批，不开放权限提升、任意权限配置或 MCP 表单/URL 处理。此路径已有 schema 和归属校验，真实审批弹窗尚未验收。

图片支持 PNG/JPEG/WebP 上传、专用暂存任务和传给 Codex；不读取任意本地文件，不提供生成图片回传或 `attachment.publish`。历史消息主要展示文本；本次页面内新发图片可保留预览，跨页面重建后的图片历史缩略图尚未实现。

当前是单管理员的本地纵向实现。电脑端的已完成回执与图片保存在本机；100 张图片或回执容量到达上限会拒绝新任务，尚无管理界面和自动清理策略。未知写意图应先核对真实会话，页面不会自动换 ID 重发；发送意图提供显式人工核对入口。

服务商是否接受实际用途仍需服务商针对真实数据流确认；业务协议不是合规保证。

## 验证

- `npm --prefix business test`：本次部署内容 55 项（工作区另有一项旧端点发现回归未纳入部署）。状态机、跨目录隔离、参数校验、幂等、租约丢失、重启与执行器回执、队列契约，以及附加型执行器的离线协议与失败关闭测试（真实 Unix socket + RFC 6455 + JSON-RPC，不使用真实 Codex）。
- `npm --prefix business run check` 和 `npm --prefix business run build`。
- `NODE_EXTRA_CA_CERTS="$PWD/.runtime/business/tls/ca.pem" node scripts/verify-business-local.mjs`：真实新建/续聊、快照、分页、事件与落盘正文检查。
- 同样环境运行 `scripts/verify-business-advanced.mjs`：真实图片输入及指定轮次中断。
- 荣耀 `BusinessSmokeTest`：LAN HTTPS、隔离项目、新建/续聊、切换主机保留 WebView、重新请求快照。

本地记录见 `docs/BUSINESS_LOCAL_VALIDATION.md`，实际 ECS 验证见 `docs/ECS_BUSINESS_VALIDATION.md`。旧 `CloudSmokeTest` 和旧 control 验证不能证明新业务架构。

## 聊天界面

0.3.0 使用会话抽屉、底部输入栏和独立会话状态。静态模块位于 `web/`，构建时将本地 Phosphor 图标打包到 dist/icons，带上许可证，不加载外部 CDN。开发构建先 `npm ci`，部署包携带已构建图标，不需要在服务器安装前端依赖。交互验证见 `docs/UI_INTERACTION_VALIDATION.md`。

## 本机 Inbox 队列协议

桌面主动领取协议 v2 的本机验收见 [持续领取与取消恢复](../docs/DESKTOP_OWNER_CONSUMER.md)。新增 `queue.enqueue/status/cancel/consumer.stop`，入队交付 job succeeded 不等于模型任务完成；使用独立 intentId、consumerTurnId 与 revision，不生成假 turn ID。

默认 `OPERATIONS`、服务器和原 ECS 启动器不开放队列写入。`enableLocalQueueTest` 仍只允许 loopback。用户授权的 ECS 专用测试模式必须在 server、agent、adapter 配置一致的 `queueTestScope`，强制 HTTPS 与精确设备/项目/聊天白名单；正文和结果不写入服务端持久化元数据。手机页面、部署及验收见 [ECS/APK 专用队列](../docs/ECS_APK_OWNER_QUEUE_VALIDATION.md)。原生发送、新建、附件及其他项目继续关闭。

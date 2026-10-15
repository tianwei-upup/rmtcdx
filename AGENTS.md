# Codex Remote Android

- `android/`: Java 原生双主机 WebView 客户端，无第三方运行时依赖。
- `services/rmtcdx/`: 独立上游 checkout，不把它的 Git 历史并入本项目。
- `business/`: 当前方案；服务端业务状态、HTTPS 任务领取、Codex stdio 执行、SSE 结果投影，见 `business/README.md`。
- `control/`: 旧 HTTP/WS 中转，仅限 loopback 回归，禁止公网部署或扩展透传；新方向为服务端业务任务与电脑主动领取，见 `docs/adr/001-business-task-architecture.md`。
- 上游功能改动导出至 `patches/remote-control.patch`；安装脚本按固定提交幂等应用，不恢复旧的独立补丁。
- 云端不持久化聊天正文；真实会话验证仅向隔离测试项目发送只读提示词，不修改用户已有活跃会话。
- `scripts/`: 本机启动、停止、验证和 Android 构建脚本。
- `prototype/desktop-companion/`：桌面已加载的标准 MCP、唯一 owner/proxy 与持久化整轮锁；仅专用测试会话授权。业务默认只读；桌面整体重启与原子接纳通过前不逐项目开放，见 `docs/DESKTOP_COMPANION_MCP.md`、`docs/DESKTOP_OWNER_ADMISSION.md`。
- 当前消息入口采用桌面通过 MCP 主动领取本项目原子 Inbox，三条本机专用任务已通过；不调用 native start/steer，多条任务可共享 turn。消费退出后只排队、不自动唤醒；ECS/APK 写入仍关闭，见 `docs/DESKTOP_OWNER_PULL.md`。
- 持续领取、取消恢复与业务队列协议 v2 已通过专用本机验收；开启有限消费窗口，取消采用 revision 和协作确认，unknown 仅本机显式放弃且保留结果未知标记。协议只允许显式 loopback 测试启用，默认服务/worker 不开放，见 `docs/DESKTOP_OWNER_CONSUMER.md`。
- 远程 Mac 执行器只读发现全部 Codex 本地项目，保留同目录的命名项目；App 项目置顶仅写 WebView localStorage，不修改桌面状态。详见 `docs/PROJECT_CATALOG_VALIDATION.md`。
- 当前真实 Codex 执行器因运行隔离审计停用；禁止恢复共享桌面 HOME/profile 或继承桌面上下文的启动方式。见 `docs/CODEX_RUNTIME_ISOLATION_AUDIT.md`。
- 旧直连 bridge 仅监听 `127.0.0.1:3210`。新业务本地验证监听 LAN HTTPS `3230`，ECS 验证使用 HTTPS `443`，详见 `docs/ECS_BUSINESS_VALIDATION.md`；执行器不依赖 bridge HTTP；禁止静默回退 mock。
- Android 远程地址要求 HTTPS，仅 loopback 和 Android 模拟器地址允许 HTTP。
- 切换主机保留各自 WebView，不自动刷新正在进行的会话。
- 不加入 JavaScript 原生桥，不绕过 TLS 错误，不向远程页面暴露本地文件。
- 本机验证：`pwsh -File scripts/verify-local.ps1`。
- Android 验证：`pwsh -File scripts/build-android.ps1`（assembleDebug、lintDebug）。

## Agent skills

- Issue tracker：远端为 `tianwei-upup/rmtcdx`，完整项目分支 `codex/remote-control-cloud`；诊断和任务继续使用本地 Markdown，见 `docs/agents/issue-tracker.md`。
- Triage labels：使用标准状态名称，见 `docs/agents/triage-labels.md`。
- Domain docs：单一上下文，见 `docs/agents/domain.md`；不存在的上下文或 ADR 不阻塞诊断。

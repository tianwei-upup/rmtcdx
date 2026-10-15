# Codex Remote Android

- `android/`: Java 原生双主机 WebView 客户端，无第三方运行时依赖。
- `services/rmtcdx/`: 独立上游 checkout，不把它的 Git 历史并入本项目。
- `control/`: 自有云端中转与电脑连接客户端；仅允许白名单接口转发到 loopback bridge。
- 上游功能改动导出至 `patches/remote-control.patch`；安装脚本按固定提交幂等应用，不恢复旧的独立补丁。
- 云端不持久化聊天正文；真实会话验证仅向隔离测试项目发送只读提示词，不修改用户已有活跃会话。
- `scripts/`: 本机启动、停止、验证和 Android 构建脚本。
- 服务仅监听 `127.0.0.1:3210`，`CODEX_MODE=real`；禁止静默回退 mock。
- Android 远程地址要求 HTTPS，仅 loopback 和 Android 模拟器地址允许 HTTP。
- 切换主机保留各自 WebView，不自动刷新正在进行的会话。
- 不加入 JavaScript 原生桥，不绕过 TLS 错误，不向远程页面暴露本地文件。
- 本机验证：`pwsh -File scripts/verify-local.ps1`。
- Android 验证：`pwsh -File scripts/build-android.ps1`（assembleDebug、lintDebug）。

## Agent skills

- Issue tracker：远端为 `tianwei-upup/rmtcdx`，完整项目分支 `codex/remote-control-cloud`；诊断和任务继续使用本地 Markdown，见 `docs/agents/issue-tracker.md`。
- Triage labels：使用标准状态名称，见 `docs/agents/triage-labels.md`。
- Domain docs：单一上下文，见 `docs/agents/domain.md`；不存在的上下文或 ADR 不阻塞诊断。

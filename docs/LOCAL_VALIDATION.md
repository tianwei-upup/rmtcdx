# Mac 本地验证（2026-10-15）

> 后续状态：荣耀旧方案真机验证见 [荣耀记录](HONOR_LOCAL_VALIDATION.md)。根据用户新增架构约束，旧中转与 USB 映射现已停止，本文的运行状态与入口说明仅保留历史记录；新方案见 [ADR 001](adr/001-business-task-architecture.md)。

结论：Mac 直连、本地中转和浏览器真实发送均通过。所有服务只监听 loopback，没有公网部署，没有向原有工作会话发送消息。改动尚未提交或推送。

## 本次修复

- 上传图片只允许 bridge 自有 `upload_<UUID>` 批次中的单层文件。电脑读取二进制，以 base64 帧转发；云端验证图片 MIME、编码和解码后大小，返回原始字节及 sandbox CSP。禁止遍历路径、嵌套路径、双重编码分隔符和任意本地文件。
- 执行电脑在终结回执持久化后返回 `x-rmtagt-receipt: complete`。前端收到匹配请求 ID 的明确 4xx 后，下一次用户操作可使用新 ID；失联、鉴权失败及未知结果继续保留旧 ID，不自动重跑。
- 普通读取最多并发 3 条、目录扫描最多 2 条，总读取仍最多 4 条，为运行状态与健康检查预留容量。当前会话读取优先于排队目录扫描；相同过滤条件的并发原生目录扫描共享分页，结束后不缓存结果。
- Android 诊断识别 `rmtagt` / `__Host-rmtagt` Cookie，仅记录是否存在，不保存 Cookie 值。
- 本地启动器在 macOS 默认绑定 `mac`，补充安全检查进程身份的停止脚本、Mac 验证标记和操作说明。

## 环境与验证

- macOS arm64，Node.js 22.22.3，Codex CLI 0.162.1，真实模式；使用当前用户既有登录态。
- bridge `127.0.0.1:3210`，本地中转 `127.0.0.1:3220`，设备 `mac`。
- Android：Gradle 8.9、Amazon Corretto JDK 21.0.12、Android SDK 34。Android Studio 自带的 JDK 25 不适用于该 Gradle 版本。

| 检查 | 结果 |
| --- | --- |
| control 协议测试 | 21 项通过，包括图片二进制/MIME、25 MiB 传输、32 MiB 边界、终结失败回执、并发公平性和断线取消 |
| control 与本地脚本语法检查 | 通过 |
| bridge 单元/兼容测试 | 69 项通过 |
| Web 测试 | 122 项通过，Puppeteer 使用本机 Chrome |
| 上游生产构建与 lint | 通过；生产构建包含 Web、TypeScript 检查与 bridge |
| Android assembleDebug / lintDebug / assembleDebugAndroidTest | 通过；lint 0 错误、7 条警告 |
| 干净上游补丁重放 | 固定提交 `82433524e8fb431185fbc7556d1e8a1cf2f2976d` 上应用成功，21 个文件内容逐字节一致 |

真实直连与中转各自在 `rmtagt-compat` 隔离项目中新建会话，完成首轮、续聊、重命名、读取、选择与审批列表查询；均收到真实流式事件，测试工作区 README 未变化。直连抽查 1,125 条历史中的 5 条；中转验收枚举 1,127 条历史并抽查 5 条。最终版本补充目录读取返回 HTTP 200、1,128 条历史。

浏览器在隔离会话发送只读提示词并收到 `RMTAGT_MAC_UI_OK`。最终版本重新登录与重连后，项目、会话、消息、审批、模型和额度等已观察请求全部返回 200，没有页面运行时异常；430×932 与 1440×1000 未出现横向溢出。真实 bridge 上传目录中的 1×1 PNG 经中转字节与 SHA-256 校验一致，浏览器实际解码尺寸为 1×1。

本地证据（均在 Git 忽略目录，包含会话标识的记录不要对外分享）：

- `.runtime/mac-compat-result.json`、`.runtime/cloud-compat-result.json`
- `.runtime/final-catalog-result.json`、`.runtime/final-browser-probe.log`、`.runtime/final-desktop-probe.log`
- `.runtime/image-relay-result.json`、`.runtime/browser-image-result.log`、`.runtime/patch-replay-result.json`
- `output/playwright/local-mac-mobile.png`
- `android/app/build/reports/lint-results-debug.html`

APK：`artifacts/codex-remote-debug.apk`，版本 0.2.0，SHA-256 `6a776121f3e048ec1f6ea2f1c96c83da89c93b175c726faa63edc69fee99ca75`。

## 使用与边界

浏览器打开 `http://127.0.0.1:3220`，本地登录信息见 `.runtime/control-admin.json`。停止中转与电脑客户端执行 `node scripts/stop-control-local.mjs`；bridge 在启动终端按 Ctrl-C 停止。

本地大量历史仍需要十余秒加载，合并并发扫描不等于完成分页或目录性能优化。生产构建保留大于 500 kB 的分包警告。Android lint 警告涉及备份配置与文案资源；本次没有模拟器或真机安装、instrumentation 运行结果。未验证公网 HTTPS/WSS、服务器重启恢复、跨运营商网络或 Desktop 活跃任务接管。

汇报话术：已完成 Mac 本地完整链路验证，修复图片转发、失败操作重试、读取拥塞和登录诊断问题；212 项自动化测试及 Android 构建通过，真实新建/续聊/流式与浏览器发送通过，公网和手机运行验收待后续补齐。

# 荣耀本地真机验证记录（旧方案）

2026-10-15。该记录只证明旧中转方案的本地功能；根据用户随后提出的架构约束，旧服务和 USB 映射已经停止，不能将本记录作为新业务任务架构的验收结果。

## 环境

- HONOR LGE-AN00，序列号 `ACTH022325002169`，Android 15，屏幕 1224×2664。
- WebView：`com.google.android.webview` 153.0.8010.57。
- APK 0.2.0，versionCode 4，SHA-256 `6a776121f3e048ec1f6ea2f1c96c83da89c93b175c726faa63edc69fee99ca75`。
- Mac bridge 与中转均只监听 127.0.0.1；当时通过 USB 3220 映射访问，未接入公网服务器。

## 结果

| 验证 | 结果 |
| --- | --- |
| APK 与测试包安装 | PASS |
| 原生配置、地址策略、升级保留、双 WebView 保持 | 4 项 instrumentation PASS |
| 本地中转登录、真实历史与隔离会话读取 | PASS |
| 隔离历史续聊、UI 新建并显式选择 `rmtagt-compat` | PASS |
| 切换未绑定 Windows 页后返回 Mac，保持 WebView 与会话 | PASS；不代表真实 Windows 设备接入已验证 |
| WebView 加载本地中转 1×1 测试图片 | PASS；未验证系统图片选择器上传 |
| 停止/恢复本项目电脑客户端，离线提示、实时健康与消息回读、页面保持 | PASS |
| 最终完整测试 | 1 项 instrumentation PASS，79.633 秒 |
| Android assembleDebug / assembleDebugAndroidTest / lintDebug | PASS，lint 0 错误、7 条警告 |

首轮测试被新建项目守卫拦下，未向其他项目发送；测试已改为明确选择隔离 workspace。后续补上每次运行唯一回复标记，以及重连后真实 HTTP 与消息回读、绘制等待，防止缓存页面造成误判。最终截图已目视检查，没有离线提示。

同时定位并修复 Codex 0.162 新会话刚落盘时的短暂空 rollout 读取错误：只针对该明确只读错误重试 50、150、300 毫秒，持续空文件及其他错误仍暴露。新增 2 项回归通过，bridge 测试现为 71 项、Web 122 项，生产构建与 lint 通过。最终真机运行的 bridge 日志没有 HTTP 5xx；该轮没有触发额外空 rollout 重试。

所有发送限定在 `rmtagt-compat`，新会话使用 read-only sandbox；对已核验的新会话，用户消息与 assistant 回复各 1 条，隔离 README 未变。没有操作另一台连接中的华为手机，手机全局网络未切换。

## 证据与后续状态

- `.runtime/honor-local/native-tests.log`
- `.runtime/ACTH022325002169-local/CloudSmokeTest.log`、`CloudSmokeTest-result.json`、`cloud-smoke.png`、`transport.log`
- `.runtime/honor-local/final-summary.json`、`session-evidence.json`、`build.log`
- `scripts/test-android-local.mjs`：可复用的本地 instrumentation 执行器；旧协议仅供 loopback 回归。

测试配置已从 App 私有目录删除，本轮桌面临时配置也已删除。APK 保留安装，但已停止 App、旧中转与连接客户端，并移除荣耀的 USB 3220 映射。

后续按 [ADR 001](adr/001-business-task-architecture.md) 实现普通业务 HTTPS API、固定类型任务、电脑主动领取和业务结果同步。新架构尚未实现，没有公网部署或服务商认可结论。

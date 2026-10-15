# 验证记录

当前架构状态：旧中转已停止作为远程方案推进，新业务任务架构尚未实现，见 [ADR 001](adr/001-business-task-architecture.md)。以下为旧方案功能证据。

荣耀真机补充：4 项原生测试、1 项完整本地中转测试通过，最终完整测试 79.633 秒；旧链路已停止，见 [荣耀本地记录](HONOR_LOCAL_VALIDATION.md)。

## Mac 本地补充验证

2026-10-15，Mac 直连与本地中转的真实新建、续聊和流式验证通过；本次修复后的测试、构建、浏览器验证及边界见 [Mac 本地验证](LOCAL_VALIDATION.md)。后续荣耀结果见上方记录，公网仍未验收。

## Windows 和 Android 原验证结果

2026-10-15，原 Windows 本机部署的云端服务、Windows 连接客户端和真实 Codex 链路通过；Android 模拟器已完成登录、历史续聊和 UI 新建会话。以下保留原验证记录，不代表当前 Mac 或真实公网服务器验收结果。

## 环境

- Node.js 22.23.2，Codex CLI 0.160.0，真实模式；bridge 只监听 `127.0.0.1:3210`。
- 本机云端 `http://127.0.0.1:3220`；Android 通过 `adb reverse` 访问，不代表公网 HTTPS 已验证。
- Android 模拟器 `emulator-5554`，APK 0.2.0，包名 `com.liutw.codexremote`。
- 测试发送只使用 `rmtagt-compat` 项目和禁止工具、禁止文件修改的提示词；未向已有工作会话发送消息。

## 真实功能

- 本机历史列表可读取；首次验证枚举 69 条原生历史，抽查 5 条消息读取。
- 通过 API 创建空会话、发送首轮、同一会话续聊、重命名并重新读取标题、选择会话、查询待审批列表，通过。
- 经云端登录、设备路由和电脑客户端后，相同基本功能通过；两轮均正常完成，收到真实 WS 流式事件。
- Android 实际操作「配置 → 统一云端地址 → 登录 → 搜索并打开指定历史 → 续聊 → 切换设备再返回 → UI 新建 → 发送」，得到真实 assistant 回复；切换时 WebView 和会话保持。
- 真实原生长历史经直连与中转读取的完整性另见 `.runtime/large-history-result.json`。

## 自动化检查

- 云端/客户端协议集成测试：18 项通过；测试桥为可控 fake bridge，覆盖双设备隔离、鉴权、Origin、配对与撤销、连接代次、重连、去重、未知结果、队列取消及大历史边界。
- 上游 bridge 兼容性与回归测试：68 项通过；Web 测试：121 项通过。
- 上游 typecheck、lint、build 通过；control 语法检查通过。
- Android assembleDebug、lintDebug 通过；原生 instrumentation 4 项通过。
- Android 真实云端 CloudSmokeTest：1 项通过，19.226 秒；日志 `.runtime/android-cloud-results.log`，截图 `.runtime/android-cloud-smoke.png`，已目视检查。
- Browser 插件本轮不可用；补充使用内置 Playwright 和本机 Chrome 检查 430×932、1440×1000。登录、设备路由、已有会话显示和 WS 正常，无运行时异常、失败请求或横向溢出；未登录时 `/api/devices` 返回 401 属于预期认证检查。
- control 生产依赖审计 0 漏洞；上游生产依赖审计剩余 2 项 low，moderate/high/critical 为 0。
- `patches/remote-control.patch` 已在干净的固定提交源码上应用并核对重建内容；上游 Git 历史未并入本项目。

## 修复的兼容问题

- Desktop 临时图片被误当作公开上传，导致历史整体 500：改为现有图片占位，继续禁止公开任意本地文件。
- Codex 0.160 空会话返回 `list_turns is not supported yet`：使用元数据回退；本进程刚创建且尚未发送首轮的线程直接发起 turn，不重复 resume 空历史。
- 名称变更未推进原生 `updatedAt`，旧缓存遮盖新标题：成功重命名后只失效该线程缓存。
- 已执行请求丢失响应后被当新请求重发：发送前持久化请求 ID，失败和页面重载均保留，成功读取确认结果后才清除。
- 重连后缺少模式握手或残留 delta：明确设备状态握手，并清临时流状态、刷新原生快照。
- 大历史误触写入限额、前端正常查询突发 429：拆分请求/响应限额，以有界只读队列控制并发，写操作使用独立额度。

## 当前边界

- Mac 接入与当前本地验证见 `docs/MAC_SETUP.md`、`docs/LOCAL_VALIDATION.md`；Desktop 活跃轮次接管仍未验证。
- 尚无真实云服务器目标，未验证公网域名、TLS、运营商网络或服务器重启恢复；部署模板在 `control/deploy/`。
- 云端采用单进程原子 JSON 元数据，无多用户/集群、TOTP 和端到端加密。传输经 TLS 后，云端运行进程仍可接触转发内容。
- 单次写入限额 4 MiB，响应限额 32 MiB；超长历史需要后续分页。端侧回执有容量上限，不自动过期；未知结果需要人工核对，不能自动重跑。
- 本轮没有真实触发危险命令审批或强制中断业务任务；相关协议路径由可控测试覆盖。

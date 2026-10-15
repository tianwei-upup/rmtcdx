# 新业务架构本地验证：2026-10-15

本页记录本地阶段。后续用户已购买 ECS 并授权云端验证，最新结果见 [ECS 验证](ECS_BUSINESS_VALIDATION.md)。

结论：核心业务链路已实现并完成真实 Codex + 荣耀 LAN HTTPS 验证。当前仅用于本地只读验证，未部署公网，不能视为服务商合规确认或完整产品验收。

## 当前链路

荣耀 WebView → 局域网 HTTPS 业务服务 `3230` → 独立任务/状态/结果投影 → Mac 主动领取 → Codex app-server stdio。

手机入口为 `https://10.121.197.232:3230/devices/mac/`。执行器只登记 `rmtagt-compat` 隔离项目，所有测试轮次明确使用 read-only sandbox，不修改文件，不向现有用户活跃会话发送内容。

旧 `3220` 中转保持停止；荣耀 `adb reverse --list` 为空。新执行器没有访问本机 `3210` bridge 的代码。服务器拒绝旧设备代理 API、WebSocket upgrade、CONNECT 和非固定任务类型。

## 已验证

| 验证 | 结果 / 证据 |
| --- | --- |
| 业务测试 | 9/9 PASS，状态机、幂等、写任务不重投、归属、容量、拒绝透传/提权、执行器和重启；`.runtime/business/tests.log` |
| 上游适配层 | 71/71 PASS，typecheck、lint、build 通过；`.runtime/business/upstream-tests.log` |
| 补丁可恢复性 | 在干净上游快照应用 patch，22 个修改/新增文件逐字节一致；`scripts/verify-upstream-patch.mjs` |
| 真实 API 链路 | 新建、两轮发送/续聊、业务事件、快照、游标分页、项目范围、落盘无提示词/回复 PASS；`.runtime/business/verification.json` |
| 图片 | 专用图片暂存任务、真实 Codex 接收 PNG 后返回测试标记 PASS；`.runtime/business/advanced-verification.json` |
| 中断 | 对隔离会话的指定运行轮次提交中断，真实 Codex 返回 interrupted PASS，同上 |
| 重启 | 已实际停止并重新启动服务/执行器，再次通过真实 API 与荣耀流程；自动测试确认旧 pending 载荷失效、terminal 元数据保留、结果需重建、离线拒绝新意图 |
| Android | assembleDebug、assembleDebugAndroidTest、lintDebug PASS；`.runtime/business/android-build.log` |
| 荣耀真机 | HONOR LGE-AN00 / Android 15，`ACTH022325002169`；LAN HTTPS、新建、两轮真实回复、保留 WebView 的主机切换、重新读取服务器快照 PASS；最终一轮 36.54 秒，`.runtime/business/honor-smoke.log` |
| TLS | 仅调试包为指定 LAN IP 加入开发 CA，主机名正常校验；未安装系统 CA，未绕过 TLS 错误 |

最新截图为 `.runtime/business/honor-business-smoke.png`，1224×2664，内容仅为隔离测试对话。测试密码配置文件已从手机应用目录移除。没有操作华为手机或已有 Appium 测试。

APK：`artifacts/codex-remote-business-local-debug.apk`，外壳版本 0.2.0 / code 4，已安装荣耀。

SHA-256：`4567d2f5988d3add35d287e1907a106a8227a6246ddf5e812d7729af5a63193d`。

该 APK 的开发证书只适用于本次指定 IP 与有效期；更换 IP/CA 后需重新生成调试资源并构建安装，不可拿该包作为公网 release。

## 仍未验收

- 真实审批弹窗流程：当前只读配置仅提供命令/文件审批的拒绝或取消；授权同意、用户问答、权限提升和 MCP 表单处理不开放。
- 生成图片回传、历史图片缩略图、`attachment.publish` 尚未实现。已验证的是用户上传图片并交给 Codex。
- 未在真机上制造“执行已发生而终结回执丢失”的故障；unknown 不重放和回执核对已有状态机测试，页面提供发送意图人工核对入口。
- 未购买/部署公网服务器，未验证 Windows 实际执行器、生产证书、多用户授权和长期运行容量回收。

这是一条已经能用的本地纵向链路；上述未验收项不计为 PASS。启动与限制见 `business/README.md`。

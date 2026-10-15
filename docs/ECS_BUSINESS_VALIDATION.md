# ECS 新业务架构验证：2026-10-15

结论：已按用户授权部署到实际 ECS，Mac 执行器与荣耀通过公网 HTTPS 完成真实 Codex 验证。当前服务和执行器正常运行，仅登记只读隔离项目；未使用 FRP、隧道、HTTP/WS 中转或手机端口映射。

## 实际部署

| 项目 | 结果 |
| --- | --- |
| ECS | `i-2zefnzrsukslova9192y`，`cn-beijing`，Ubuntu 22.04.5 LTS |
| HTTPS | `https://47.95.141.18`，手机路径 `/devices/mac/` |
| Node | 官方 v22.22.3 Linux x64 发行包，SHA-256 校验通过；不覆盖系统 Node |
| 服务 | `rmtagt-business.service`，开机启动、异常重启，用户 `rmtagt-business` |
| 应用 | `/opt/rmtagt-business/releases/20261015T080505Z`，`current` 链接 |
| 状态 | `/var/lib/rmtagt-business/server.json`，0600；服务端只保存业务元数据 |
| 权限 | 只读代码、独立状态目录、低端口绑定能力、NoNewPrivileges、MemorySwapMax=0、LimitCORE=0 |
| 网络 | 新服务仅监听 HTTPS 443；未修改已有安全组、RAM 权限或 SSH 配置 |
| 连接工具 | 用户指定的 [aliyun-ecs-workbench Skill](/Users/liutianwei/.agents/skills/aliyun-ecs-workbench/SKILL.md)，实测远程命令成功 |

安全组检查时已有 TCP 443 允许规则，直接复用。首次外网探测曾超时，后续正常证书校验的 HTTPS 请求已成功；未通过关闭保护或透传绕过。

手机访问业务服务；Mac 主动通过 HTTPS 领取固定任务，直接调用本机 Codex app-server stdio。服务器没有安装 Codex、电脑 bridge 或旧 control 服务。旧本地 3230 测试服务已停止，荣耀 `adb reverse --list` 为空。

## 验证结果

| 检查 | 结果 / 原始证据 |
| --- | --- |
| ECS 远端构建和测试 | build 通过，9/9 PASS；`.runtime/business-ecs/install.log` |
| 公网认证与协议边界 | health 200、未登录业务 API 401、旧代理路径 404、WebSocket upgrade 404；`transport-audit.json` |
| 真实 API | 项目、新建、发送、续聊、事件、历史快照、游标分页 PASS；`real-verification.log`、`verification.json` |
| 图片 | PNG 专用暂存任务 → 本机真实 Codex → 测试标记 PASS；`advanced-verification.json` |
| 中断 | 绑定指定会话和运行轮次，真实 Codex 返回 interrupted PASS；同上 |
| Mac 离线 | 实际停止云端执行器，云端检测心跳过期，拒绝新写任务 409/device_offline；`offline-verification.json` |
| ECS 重启恢复 | 实际重启业务服务，重新连接执行器；项目/会话元数据和设备凭据保留，原会话重新生成快照，包含之前两轮回复；`recovery-verification.json` |
| 荣耀云端流程 | HONOR LGE-AN00、Android 15，`ACTH022325002169`；公网 HTTPS、新建、两轮真实回复、主机切换保留 WebView、刷新重新读取快照 PASS；首轮 50.674 秒，重启后再验 24.594 秒 |
| 荣耀证据 | `honor-smoke.log`、`honor-after-restart.log`、`honor-after-restart.png`（1224×2664，仅隔离对话） |
| 正文落盘抽查 | ECS 实际元数据文件和服务 journal 均未发现本轮聊天标记/提示词，元数据为 0600；`final-server-audit.log` |
| Android | assembleDebug、assembleDebugAndroidTest、lintDebug PASS；`android-build.log` |

以上未注明绝对路径的证据文件位于本机 `.runtime/business-ecs/`，不提交 Git。所有真实写入均为 `rmtagt-compat` 中新建的隔离会话，所有轮次为 read-only；没有操作用户现有活跃会话、真实业务项目或华为手机。

APK：`artifacts/codex-remote-ecs-test-debug.apk`，已覆盖安装荣耀并配置云端地址。

SHA-256：`84d97c10228fba0b1b5ffb9caea746af6f3bff89978af9a6f1840c879785d675`。

## 测试证书和接续

用户选择 IP 测试证书。服务器私钥在 ECS 生成；本机专用 CA 签发 SAN=47.95.141.18 的证书，CA 私钥没有上传。叶证书到期为 **2026-10-29 16:03:37（北京时间）**。

Android debug 包只为该 IP 信任测试 CA，正常校验证书和主机名；未绕过 TLS、未安装手机全局 CA。普通浏览器默认不信任该 CA，正式使用需要换受信任证书。release 构建不包含调试信任资源。

本机管理员信息保存在 `.runtime/business-ecs/local.json`（0600）；独立设备凭据在同目录 agent.json。手机测试密码文件已删除，不把密码写入报告。

Mac 执行器当前作为本机前台进程运行；关闭进程或电脑休眠会使设备离线。恢复命令见 [部署说明](../deploy/business/README.md)。ECS 服务由 systemd 托管，状态与重启命令为 `systemctl status rmtagt-business`、`systemctl restart rmtagt-business`，通过 Workbench 在目标实例执行。

## 当前限制

依然是单管理员、只读隔离验证：完整审批授权、生成图片回传、Windows 实际执行器、长期容量回收尚未完成/验收。没有在真机上制造“副作用已发生但终结回执丢失”的故障；该状态机有自动测试。

此次验证证明部署与功能链路可用，不等同于完整生产验收，也不替代服务商对实际用途的确认。新服务保持业务终点和任务模型，不恢复任何通用流量转发能力。

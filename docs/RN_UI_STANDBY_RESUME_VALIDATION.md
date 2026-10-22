> 2026-10-21 最新授权：手机与桌面同权限已完成专用写入及 RN 复验；原只读描述为历史阶段，当前状态见 [APK 自用模式](APK_PERSONAL_MODE.md)。

# RN UI 长期只读领取恢复与荣耀验收

2026-10-21 19:17（北京时间）。用户明确授权恢复“补充蓝牙未连接恢复步骤”的长期领取后，已恢复并保持开启；荣耀通过真实发送、分段回复、刷新恢复及 APK 正常启动验收。未重启桌面或 ECS，未恢复其他会话的领取。

## 当前可用状态

- 项目“壳工程RN UI相关”，精确会话 `01a1392d-9340-70d0-b5ad-642c63c448db`。
- 旧 turn 因 `owner_interrupted` 停用。恢复前确认 consumer closed、无 active native turn、无 pending approval、无 inflight/unknown。
- 通过官方聊天消息入口向这个已空闲会话发送用户授权的恢复指令；不使用自建 native start/steer/interrupt 或伪造消费者。
- 新真实 turn `01a15e28-9f90-76f1-a2c4-45aee6fe6d4a` 只调用 `rmt_queue_status`、`rmt_queue_standby_enable`、`rmt_queue_progress`、`rmt_queue_reply`。没有 shell、文件、网络、设备操作或其他工具。
- policy revision 8 → 9，enabled=true；原生 turn inProgress；consumer active / waiting=true，已完成 3 条，仍等待新消息。验收后没有 close、pause 或中断。
- 内部窗口仍每段 600000ms / 100 条，按已实现的待命规则自动续段；idle wait 600000ms、MCP timeout 650 秒。此次没有再次做完整跨十分钟计时；原生跨十分钟证据见 `QUEUE_STANDBY_VALIDATION.md`。

## 荣耀实际结果

荣耀 `ACTH022325002169` 通过 `https://47.95.141.18/devices/mac-rn-ui-queue/`，原主 APK 未重新安装，仅更新测试 APK；未添加 ADB reverse，未使用 Appium。

`DesktopEcsTest#testRnStandbyPhoneChat`：**PASS，31.861 秒**。

| 验证 | 结果 |
| --- | --- |
| 实际触屏发送 | 3 次触屏发送，3 条都 completed，均绑定同一真实 turn |
| 第一条回声 | 完整往返约 5,649ms，精确返回随机验收标记 |
| 真实分段 | 3 次 progress，手机在 completed 前实际观察到 3 次增长，文本长度 73 → 112 → 151 |
| 页面刷新 | 两次真实 WebView reload，保留选中会话、已完成结果和 active consumer；每条只展示一次 |
| 刷新后发消息 | 第三条在刷新后发送并正常回复；不需要回桌面重新开窗 |
| 结束状态 | 同一原生 turn 继续运行，consumer active / waiting=true |

三个意图 ID：

- `9f2888e5-df69-484c-a847-9bdd29cf88f5`
- `36e06e88-df3c-4627-9f9e-298b1c5e8960`
- `e2567a06-484b-45c8-95e2-027e1c9e93bf`

`DesktopEcsTest#testRnNativeLaunchReady`：**PASS，1.779 秒**。删除临时验收配置后，按主 APK 原有启动逻辑进入：Mac → 配置的云端地址 → RN 项目 → 已保存的目标会话。这个测试不手动加载验收 URL、不改 host 配置、不发送消息。页面显示“手机接收已开启”。最后已正常打开主 APK 留在该会话。

本次 Wi-Fi 小样本不能代表 4G/5G、弱网、后台或固定模型首字时延。

## 隔离与检查

- 其余 14 个业务队列的 consumer 和 receipts 与恢复前完全一致。
- Codex 桌面与两个原有队列 worker 的 PID、启动时间、命令均不变（3 个进程）。
- 全局 Codex config、RN MCP config、Hooks 文件 SHA-256 均不变；没有调整模型或权限设置。
- Android `assembleDebugAndroidTest`、`lintDebug` 通过。
- 首轮手机测试在导航后立即 evaluateJavascript，回调在文档切换中丢失，尚未发消息。测试助手改为等待目标文档真实 `onPageStarted/onPageFinished` 后再查询，修复后通过；未以加长 JS 超时掩盖导航竞态。
- 私有证据在 `.runtime/rn-standby-resume-20261021/`：`honor-report.json`、`native-launch.json`、`final-evidence.json`、原生和手机日志、截图；临时手机密码配置已移除，不进入 Git。既有手机 host 配置与 8081 映射保持原样。

## 使用

打开现有 APK，保持 Mac 主机及“补充蓝牙未连接恢复步骤”选中即可发送只读问答。Mac 需保持开机联网，保留该会话运行；不必每十分钟回电脑开窗。手机停止接收、桌面中断或整个桌面退出后仍按停用/恢复规则处理，不承诺自动唤醒已经消失的原生 turn。

本次未提交或 push；无关本地改动保留。

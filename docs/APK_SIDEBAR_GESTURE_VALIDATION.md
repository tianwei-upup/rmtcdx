# APK 侧栏手势与返回验收

2026-10-22：聊天正文区单指向右滑动，抬手后展开会话侧栏。更新的是 ECS 前端脚本，现有 APK 重新打开或刷新页面即可使用，无需重新安装。

提交范围复验：从暂存区单独导出本次代码，`npm run build`、业务测试 82/82、Android `assembleDebug assembleDebugAndroidTest lintDebug` 均通过。下文工作区的 83 条测试包含另一个未提交的发现逻辑测试；旧默认连接配置与 thin-bridge 等无关改动继续留在本地。荣耀验收及 APK 哈希对应当时的工作区产物，本次独立构建仅验证提交代码，不覆盖安装手机。

## 项目选择面板

- 项目入口改为与侧栏一致的文件夹图标、项目名与会话数；展开后在同一侧栏搜索项目，当前项目显示选中标记，支持浅色和深色。会话数量只统计未归档会话。
- 重复选择当前项目保留会话与草稿；左滑、返回关闭侧栏，重新展开时恢复会话列表。只更新 ECS 的 HTML、CSS、JS，0.4.2 无需重装。
- 原 select 隐藏，仅保留已有值与 change 事件的兼容入口；用户操作使用新面板。新 JS 兼容旧 HTML，按 JS、CSS、HTML 的顺序热更新，不重启服务。
- 荣耀 `testCustomProjectPickerVisualAndSelection`、右滑回归、左滑与返回回归各 `OK (1 test)`；项目搜索、空结果、当前项目标记、草稿保留、浅深色均通过，仅专用会话，零消息和控制写请求。业务测试 83/83、构建及 Android lint 通过。
- 结果与浅深色截图：`.runtime/project-picker-20261022/`；原有无关改动、APK 与桌面进程保持不变。

## 0.4.2：左滑与返回键

- 侧栏内左滑关闭，可从会话行上起手，关闭时不会误选中该行；短滑、反向滑和竖向列表滚动保持侧栏打开。搜索输入框及项目选择控件保留自身触摸操作。
- Android 返回优先关闭页面中已打开的侧栏，关闭后继续原有网页历史或退出逻辑。固定 UI 检查使用原生向页面调用，不添加 JavaScript 原生接口。检查回调超时允许重试，不假定侧栏已关闭。
- 左滑更新已部署 ECS；Android 返回兼容处理需升级 APK 至 0.4.2，荣耀已覆盖安装，保留原连接配置与登录态。
- 新增 `SidebarGestureTest#testLeftSwipeAndBackCloseSidebar`：实际触摸验证侧栏左滑、竖向滚动、会话行防误点、搜索输入保护，以及在存在网页历史时系统返回先关侧栏、下一次返回才回退。仅专用测试会话，未发送消息或控制写请求。
- 最终左滑与返回测试、原有右滑回归均为 `OK (1 test)`；另外验证 Activity 返回兼容入口，诊断记录包含 `drawer_closed` 和 `history` 固定动作。正常启动 APK 后，再实际点击荣耀底部返回按钮，侧栏关闭且应用、原会话保持显示。
- `npm run build`、业务测试 83/83、Android 构建及 lint 通过。仅替换 ECS 前端脚本，服务和桌面未重启；原有无关改动保留。
- 最终 APK：`artifacts/codex-remote-0.4.2-debug.apk`，SHA256 `86ddd12b1f33d227e80ca4b911a459cf91e79cae5400829d0df815a9d1a57478`。本轮前端 SHA256 `724d981e360c761a67a42fa952f58eb98ddba97b0a11afe9f782d9fcad5b78ca`。
- 本轮证据位于 `.runtime/sidebar-close-20261022/`，包括 `honor-close.log`、`honor-close-report.json`、`honor-open-regression.log` 和 `deploy-result.json`；下文保留初版右滑的验收记录。

## 实现

- 仅聊天记录区域识别手势，保留原侧栏按钮和关闭方式。
- 第一个可取消的移动事件出现明确向右意图时接管；抬手须达到最小距离且以水平方向为主。短滑、左滑、竖滑、多指和取消事件不展开侧栏。
- 避开交互控件、代码块、表格、内部横向滚动区域以及已有文本选区。输入框不参与侧栏手势。
- 初版 12px 意图阈值在荣耀轻缓起手时漏响应：首个移动约 11.37px，下一事件已不可取消。改为首个明确向右的可取消事件即接管，复测各次移动均保持可取消，侧栏正常展开。

## 验证

- 荣耀 `ACTH022325002169`，公网 ECS 页面，仅选择专用测试项目的会话 `01a161a3-e9ff-7691-8cd7-3de4e49fcfbe`。
- `SidebarGestureTest#testRightSwipeAndScrollSelectionGuards`：实际触摸注入验证右滑展开、左滑和短滑不展开、竖向历史滚动、横向代码滚动、DOM 文本选区保护、输入框防误触、当前会话与未发送草稿保留，`OK (1 test)`。
- 滚动与选区测试使用临时 DOM 内容，结束即移除；未发送消息、没有写请求，没有创建或中断模型 turn。
- `npm run build`、工作区业务测试 83/83、Android `assembleDebugAndroidTest lintDebug` 通过。
- ECS 仅原子替换 `business/dist/queue-app.js`，替换前核对 SHA256 并备份；服务 PID 68937 未变。桌面及原有队列进程 PID 未变，33 个既有本地改动文件哈希未变。
- 最终脚本 SHA256：`ede4a4d9babf5858d63e4480fc90b4590f78fd5a51eba2fd7cdfe970b2b134bc`。

本机详细结果、首个移动事件轨迹和截图位于忽略目录 `.runtime/swipe-sidebar-20261022/`，包括 `honor.log`、`honor-report.json`、`validation.json` 和 `deploy-v2-result.json`。首次两次测试在页面导航时丢失脚本回调，未执行手势；最终测试使用正常 APK 启动路径，未依赖测试中的强制页面重载。

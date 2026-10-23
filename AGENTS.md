# Codex Remote Android

- 2026-10-23 新会话补验通过：用户批准后在“专用测试项目”通过原生工具新建 `01a1681d-6320-7933-b540-27f6511d4e68`，短口令初始化完成后自动出现在荣耀；首次手机正文自动建 Inbox、原 ID / 上下文 / 模型权限保持，分段、真实刷新、同 intent 两次 202 同业务 ID、冲突 409 通过。原生手机正文一次、工具和长篇启动说明零次；接纳→开始 250ms，手机首段 2.553s，仅本次样本。无业务源码或服务配置变更，各桌面 / 接收服务 PID 不变，手机原状态恢复。该项补齐下条待验收项；仅 session_meta 的完全空 ID 仍为隔离回归边界。详见 `docs/NATIVE_DELIVERY_ROLLOUT.md`。

- 2026-10-23 正文直入已按项目推广：先通过专用未加载原会话和荣耀原生拒绝审批，再通过 RN 已结束历史及 oisUpload 压缩历史的正文发送 / 分段 / 刷新，逐项目启用并设置后续发现项目自动采用。个人 / RN 服务分别保留原 Inbox，不迁移活跃消费者、已领取 / 未知任务或启用待命；原生活跃回合等待自然结束。持久 `native_delivery` 标记固定 project / cwd / binding，数据库拦截旧领取器，旧激活路径在异步读取后再检查归属；新路径不追加长篇接收说明。zstd 旧历史只读内存解压、纳秒代次缓存布尔证据，新 live 文件优先，缺明确完成仍等待。归档只读、目录缺失禁写、未归档沿用原生权限。荣耀三条原生接纳→开始 415–594ms，首段 11.221–17.510s，主要受原生首 token 9.761–15.899s 影响，不宣称达到 ChatGPT App 时延。companion 181/181、business 117/117 及 build 通过，补修服务停止时晚到任务误标未知和已预留任务假取消。只更新队列 / publisher 服务并停用 RN 旧 receiver，桌面 / MCP / ECS 未重启。真实新建会话首条手机消息补验结果见上条；详见 `docs/NATIVE_DELIVERY_ROLLOUT.md`。本条替代下两条“仅 acceptance 启用”的历史范围。

- 2026-10-23 续验：当前桌面原生 `codex://threads/wake/<ID>` 只检查 / 恢复精确队列，不导航、不提交正文。acceptance 原子入队后改发此提示，并固定校验已安装 bootstrap/main SHA-256；接纳前拦截未知版本，通知 ACK 与原生开始 / 完成分离，丢失提示不重插正文。荣耀三条接纳→原生开始 0.877 / 0.316 / 0.423 秒，忙时重复通知保留第二条、两个独立回合完成，运行中刷新 / 去重 / 冲突通过；本轮 12 个原生回合均无工具调用，134/134 回归通过。同口径桌面首段 3.79–4.27 秒、APK 4.69–8.19 秒，输出传输仍有 0.34–1.81 秒波动。**即时通知专用验收通过，其他项目直入尚未推广**；仅更新专用 worker，桌面、MCP、ECS、RN / personal 进程未重启。详见 `docs/NATIVE_QUEUE_WAKE_VALIDATION.md`，补充下条历史结论。

- 2026-10-23 手机正文直入原生队列已仅在 acceptance 原 ID 验证：新增 `NativeDirectInbox` / 专用 runtime，持久化 intent→client_id→turn 关联，消除模型 MCP 领取，原生完成驱动状态，旧激活器不接管；荣耀五条正文各执行一次、重复意图 / 冲突、运行中刷新及专用 worker 恢复通过。相同设置桌面 owner 正常入口首段 2.63–3.47 秒，APK 6.44–12.48 秒（统一至少 10 字真实输出）；原生对应输出到手机约 0.09–0.40 秒，主要剩余额外等待为原生外部队列约 10 秒检查周期。**实时性推广门槛未过，未向其他项目启用直入**；不以非原子 start / steer 或整队列替换绕过。直入已预留任务暂不提供取消；未重启桌面、全局 MCP、ECS，其他 worker 原样。详见 `docs/NATIVE_DIRECT_BODY_VALIDATION.md`。

- 2026-10-22 追加上线两项用户批准改动。**登录态持久化**：`server.mjs` 的 sessions 落盘到已有 `server.json`（0600、仅服务账户可读，存 token 的 sha256 摘要不含明文），重启不再踢手机回登录页；恢复时**不延长**已接近过期的会话，存量文件缺 `sessions` 键自动补空对象；新增 `business/test/session-persistence.test.mjs` 2 项回归，线上实测重启后同一 cookie 仍 200、伪造 cookie 仍 401，真机重启应用直接进聊天页。**队列页真实时间戳**：更正此前"元数据库无 `updated_at` 列"的误判（错因是测试 fixture 的最小表结构，真实表有 `updated_at`/`updated_at_ms`/`recency_at_ms`），`personal-discovery.mjs` 按既有 `columns.has()` 模式取列，scope 契约放行可选 `updatedAt`（**纯展示元数据，不改授权语义**），前端用真实时间排序与显示、项目「最近使用」改按真实活跃度；真实核对 47 项目 / 860 会话 / 227 归档、859 条带时间、`binding` 未变，真机会话行显示真实"3 小时前 / 6 小时前"。发布 `20261022T092641Z-ui-opt`，服务器 **85/85 测试通过**，personal-queue-agent 以 `launchctl kickstart -k` 重启（PID 7665→28423）后自动 publish 新目录，catalogRevision 变更；桌面与全局 MCP 未重启。另记：登录限流按 IP 5 次/分钟且**成功也计数**，同一出口 IP 下多设备会互相挤掉配额，前端把 429 误报为"连接失败"，属既有问题待另开一轮。

- 2026-10-22 UI 优化已上线 ECS 并在荣耀 `ACTH022325002169` 复验。批次 A/B/C 落地：字号下限 12px（原 7 处 10–11px）、触摸目标经 `elementFromPoint` 实测全部 ≥44px 命中区、桌面历史复制按钮改图标且流式时隐藏、顶栏加分隔线并计入 `env(safe-area-inset-top)`、侧栏改 88vw/360px（遮罩 29→47px）、正文行距 1.85→1.7、输入区 `+` 与发送键成组靠右、跳转按钮改用 `--composer-offset`。业务页列表/搜索/数量只统计未归档会话（`codex-adapter` 新增 `archived` 字段 + 输出契约放行），新增「显示/隐藏归档会话」开关；会话行显示相对时间与状态并按 `updatedAt` 倒序，项目按活跃度排序；队列页项目面板按端侧 recency 分「最近使用 / 全部项目」。原生壳深色模式菜单按钮改用主题背景色；网页移除手动主题选择。**深色割裂的根因是应用主题 `Theme.Material.Light` 让 WebView 恒报 `prefers-color-scheme: light`**，改为原生层用 `?theme=dark|light` 传参 + 同源同步脚本 `business/web/theme.js`（CSP `script-src 'self'` 禁内联脚本），302 重定向需保留 query。队列授权契约 `queue-scope.mjs` **未放宽**。发布：前端 44 文件热补丁服务 PID 68937 未变；完整发布 `20261022T084725Z-ui-opt` 服务器 **83/83 测试通过**、PID 变 71827。`workbench exec` 有 30 秒超时，发布须后台执行并轮询日志。APK 0.4.4（versionCode 10）`artifacts/codex-remote-0.4.4-debug.apk`。方案与证据见 `docs/UI_OPTIMIZATION_PLAN.md`。

- 2026-10-22 最新授权与实现：新增本机项目 / 会话已改为持续发现接入，不再维护本轮固定名单。兼容旧桌面目录和新版原生项目表 / `threads.name`；已配对个人服务通过版本 CAS 更新 ECS 精确成员，APK 用独立目录 SSE 与版本查询自动刷新，保留草稿 / 当前页面；默认列表 / 搜索 / 数量仅显示未归档会话，启动不恢复已归档会话。归档只读、未归档沿用桌面权限；新消息绑定当前项目 / cwd，源确认过期拒写。原 RN 15 条与独立 acceptance 仍归原进程，未重启桌面或全局 MCP。荣耀新建专用任务、两次原 ID 只读回复、刷新及归档 / 解除归档通过；真实新建项目仍仅隔离元数据链路验证。见 `docs/AUTO_DISCOVERY_VALIDATION.md`。

- **2026-10-22 最新授权与上线范围**：当前 Mac 本机 47 个项目、848 条已有历史会话已接入（快照含 226 条归档），替代下文“仅 RN 15 ID”的历史限制。归档只读；未归档按原桌面会话沙箱/审批执行；目录不存在仍可读历史但不能执行。原 RN 15 个队列和长期消费者不迁移，新独立 `mac-personal` worker 负责其余 833 条，按项目 ID/会话 ID/原 cwd/实时归档状态核对；同目录命名项目保持独立。历史读原生 JSONL/zstd，不加载或取消归档；原生 follower 仅选中订阅，队列仍使用带回执的原子追加，无第二模型执行器、不 start/steer/interrupt。全局 `rmtcdx_mobile` MCP 已配置但没有热加载/重启桌面；已加载会话可通过绑定当前原生 turn/client_id 的普通命令兼容入口领取，仍受原沙箱/审批约束。超长工具详情展示带标记的首尾摘要，省略上传二进制正文，聊天文字/工具顺序保留。完整证据与限制见 `docs/PERSONAL_PROJECT_HISTORY_ACCESS.md`。

- 2026-10-21 补验：已修复只查看时 owner 未加载的空白、原生大历史 20 秒超时、ECS 旧选择缓存累计超过 32 MB。读取需求经显式 `historyLoader` 加载无 prompt 原生视图，实时检查精确 ID/归属/cwd/archive、桌面和 CLI；历史 JSON gzip，SSE 原样。原名单 12 条按需历史已逐 ID 读通；荣耀两条切换/刷新和“配置新挡板假车”原 ID 只读续聊通过。不能把 API 检查说成 12 条均做过荣耀发送验收；归档、新项目、桌面整体重启仍未覆盖。见 `docs/NATIVE_HISTORY_QUEUE_VALIDATION.md`。
- 2026-10-21 历史会话按需接入已通过专用原 ID、忙时排队、未加载恢复及荣耀 ECS 验收。仅原 RN 15 个授权 ID 内当前 12 条历史会话新增按需接收，原 1 个长期消费者不动，当前 2 个归档不唤醒；新增成员不扩权。独立 LaunchAgent 只读观察本项目 Inbox 元数据，以带回执的原子 INSERT 追加当前版本原生队列控制消息，再通过无 prompt 原生 URL 加载原会话视图；可能切换桌面显示，不中断其他 turn。CLI 精确版本/队列结构不符即停写，不恢复旧共享 HOME 执行器。见 `docs/NATIVE_HISTORY_QUEUE_VALIDATION.md`；本条替代下文历史阶段“未启用会话不能自动接收”的限制。
- `android/`: Java 原生双主机 WebView 客户端，无第三方运行时依赖。
- 2026-10-21 最新用户授权：自用 APK 0.4.1 内置 ECS 默认地址并默认 Mac；RN UI 既定 15 个会话改为沿用桌面权限，可改代码、执行命令，14 个未归档会话允许手机响应原生审批，归档仍禁写。仅“补充蓝牙未连接恢复步骤”长期领取已开启。此授权替代下文历史阶段对该项目的只读限制；其他项目不扩权、不操作其他活跃会话。专用文件写入和 RN 荣耀实测见 `docs/APK_PERSONAL_MODE.md`。
- `services/rmtcdx/`: 独立上游 checkout，不把它的 Git 历史并入本项目。
- `business/`: 当前方案；服务端业务状态、HTTPS 任务领取、Codex stdio 执行、SSE 结果投影，见 `business/README.md`。
- `control/`: 旧 HTTP/WS 中转，仅限 loopback 回归，禁止公网部署或扩展透传；新方向为服务端业务任务与电脑主动领取，见 `docs/adr/001-business-task-architecture.md`。
- 上游功能改动导出至 `patches/remote-control.patch`；安装脚本按固定提交幂等应用，不恢复旧的独立补丁。
- 云端不持久化聊天正文；默认向隔离测试项目发送只读提示词。用户显式授权的真实项目仅按固定会话名单接入只读队列，不打断或修改其他活跃会话。
- `scripts/`: 本机启动、停止、验证和 Android 构建脚本。
- `prototype/thin-bridge/`: 单执行器薄桥原型（唯一 owner launcher、桌面 JSONL↔WS 适配器、attach-only worker、单写者守卫）。非生产代码。**接续此项前先读 `docs/THIN_BRIDGE_HANDOVER.md`**——其中记录了已完成项、对真实 CLI 测得的 17 条事实、已证否的接入路径（不要重复尝试）与未闭环缺口。
- `prototype/desktop-companion/`：桌面已加载的标准 MCP、唯一 owner/proxy 与持久化整轮锁；旧非原子 native 发送仅专用测试会话授权。业务默认只读；真实项目只允许下述显式授权的主动领取试点，见 `docs/DESKTOP_COMPANION_MCP.md`、`docs/DESKTOP_OWNER_ADMISSION.md`。
- 当前消息入口采用桌面通过 MCP 主动领取本项目原子 Inbox，三条本机专用任务已通过；不调用 native start/steer，多条任务可共享 turn。消费退出后只排队、不自动唤醒；原型阶段记录见 `docs/DESKTOP_OWNER_PULL.md`。
- 持续领取、取消恢复与业务队列协议 v2 已通过专用本机验收；开启有限消费窗口，取消采用 revision 和协作确认，unknown 仅本机显式放弃且保留结果未知标记。默认服务/worker 不开放队列；loopback 验收见 `docs/DESKTOP_OWNER_CONSUMER.md`。
- ECS/APK 队列已按用户授权仅向专用测试项目开放，强制 HTTPS 与单设备/项目/聊天白名单，native 写入口仍拒绝。手机入队、取消、状态、结果、刷新恢复及丢失响应核对已通过；Mac 只读 Inbox worker 由独立 LaunchAgent 托管，不重启桌面。部署与范围见 `docs/ECS_APK_OWNER_QUEUE_VALIDATION.md`。
- 远程 Mac 执行器只读发现全部 Codex 本地项目，保留同目录的命名项目；App 项目置顶仅写 WebView localStorage，不修改桌面状态。详见 `docs/PROJECT_CATALOG_VALIDATION.md`。
- 当前真实 Codex 执行器因运行隔离审计停用；禁止恢复共享桌面 HOME/profile 或继承桌面上下文的启动方式。见 `docs/CODEX_RUNTIME_ISOLATION_AUDIT.md`。
- 旧直连 bridge 仅监听 `127.0.0.1:3210`。新业务本地验证监听 LAN HTTPS `3230`，ECS 验证使用 HTTPS `443`，详见 `docs/ECS_BUSINESS_VALIDATION.md`；执行器不依赖 bridge HTTP；禁止静默回退 mock。
- 真实项目试点仅“壳工程RN UI相关”的 15 个已有会话（含 1 个归档只读）；按项目 ID 和固定会话 ID 授权，不按共享 cwd 扩权。常驻队列与 MCP 消费前端分离，每个会话独立 Inbox；手机不能自动唤醒或 native start/steer/interrupt。桌面重启和高负载延迟仍未验收，完整桌面文字历史已合并展示，见 `docs/RN_UI_PROJECT_QUEUE_ACCESS.md`。
- 实时队列采用独立写入通道、ECS RAM 投影 / SSE 和 MCP listen / reply / progress；荣耀已验证 100 次入队取消及 11 条原生模型任务，见 `docs/QUEUE_REALTIME_VALIDATION.md`。只保持上述真实项目和专用测试的精确授权；正常推送不轮询业务任务，离线 / epoch / 成员撤权须使状态失效，不自动唤醒或重放。真实项目已加载的 MCP 不强制重启，新工具等正常加载时生效。
- 一次启用待命由精确会话 opt-in、持久策略、自动续窗和可信 Stop / Interrupt Hook 实现；专用原生 11 分钟及 RN/ECS/荣耀跨十分钟功能验收已通过。RN Hook 已人工信任，仅“补充蓝牙未连接恢复步骤”用于启用，其余 13 个未归档会话未开启、1 个归档仍禁用。v0.8 对启用的待命使用 600 秒空闲等待 / 650 秒工具超时以减少模型调度空档，真实回答曾有 38.4 秒慢样本，不承诺固定时延。队列 worker 恢复不等于桌面重启唤醒，不重载或注入其他活跃会话。见 `docs/QUEUE_STANDBY_VALIDATION.md`。
- ECS 桌面历史 / 工具状态已按原有 15 个 RN UI 会话精确名单开放，独立 follower 按手机选中订阅；RN 未归档会话已按最新用户授权允许手机响应审批，不自动批准。专用荣耀公网拒绝审批、队列合并和刷新已通过；历史同步不恢复已中断的模型领取，详见 `docs/ECS_DESKTOP_SYNC_VALIDATION.md`。
- 2026-10-21 已按用户明确授权恢复“补充蓝牙未连接恢复步骤”的长期只读领取；荣耀 3 条真实消息、分段、两次刷新和正常 APK 启动通过，其他 14 队列未变。当前保留 active / waiting，不在验收收尾时关闭；见 `docs/RN_UI_STANDBY_RESUME_VALIDATION.md`。
- Android 远程地址要求 HTTPS，仅 loopback 和 Android 模拟器地址允许 HTTP。
- 切换主机保留各自 WebView，不自动刷新正在进行的会话。
- 不加入 JavaScript 原生桥，不绕过 TLS 错误，不向远程页面暴露本地文件。
- 本机验证：`pwsh -File scripts/verify-local.ps1`。
- Android 验证：`pwsh -File scripts/build-android.ps1`（assembleDebug、lintDebug）。

## Agent skills

- Issue tracker：远端为 `tianwei-upup/rmtcdx`，完整项目分支 `codex/remote-control-cloud`；诊断和任务继续使用本地 Markdown，见 `docs/agents/issue-tracker.md`。
- Triage labels：使用标准状态名称，见 `docs/agents/triage-labels.md`。
- Domain docs：单一上下文，见 `docs/agents/domain.md`；不存在的上下文或 ADR 不阻塞诊断。

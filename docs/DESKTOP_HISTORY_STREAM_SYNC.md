# 专用会话：完整文字历史、原生增量与工具 / 审批同步

2026-10-21 后续：ECS 鉴权通道、手机队列合并、荣耀公网原生拒绝审批已通过，并按既定名单开放 RN UI 只读历史。最新范围、发布与当前领取状态见 [ECS 桌面同步验收](ECS_DESKTOP_SYNC_VALIDATION.md)。下文保留此前各阶段记录。


2026-10-16。本轮只在 `rmtcdx companion acceptance`（`01a13feb-ce80-7ca3-aa1e-17814542b353`）验证。**本机原型已实现；真实审批闭环待桌面正常输入触发，不作为全量通过。ECS、RN UI 白名单、队列 worker 与 Codex 桌面均未重启或扩权。**

2026-10-21 17:20 更新：**acceptance 专用会话的真实命令审批 → 荣耀实际点击拒绝 → 原生工具 declined → 手机最终答复及刷新恢复闭环已通过**。已定位 Auto-review 模型条件及旧 `permissions=:danger-full-access` 覆盖只读显示字段的问题；本轮采用已实测的 GPT-5.6 Sol / 原生 `:read-only` / `on-request` / `user` 组合。点击至手机显示桌面确认耗时 162ms，仅代表本机 USB 转发样本。原模型、推理强度、权限和审批控制均已恢复，全局配置哈希未变；未重启桌面、修改其他活跃会话、部署 ECS 或开放真实项目新能力。详细条件与证据见文末。

## 接入面与范围

采用已有桌面 owner 的 follower 协议，不启动第二个 app-server，不读取或写入其他聊天的状态，不接管 owner。客户端以自己的类型初始化，使用路由分配的 client ID，对 owner 发现请求一律回答 `canHandle:false`。

`DesktopStream` 只接受固定 conversation ID、精确 cwd、当前 owner 及已验证的 version 11 帧。向该 owner 发送 `thread-stream-following-changed`，通过 `thread-follower-load-complete-history` 加载完整 canonical 历史，再接受带 `baseRevision/revision` 的补丁。丢帧、换 owner、断线、非法路径均失效并重新获取快照；不借此 resume/start/steer/interrupt，也不重发手机消息。

这是安装版本的内部 IPC 能力，不能当作官方稳定第三方接口承诺。[官方 App Server 文档](https://learn.chatgpt.com/docs/app-server)说明的原生消息和审批概念仅用于协议对照，不证明当前桌面允许直接 attach app-server transport。

## 实现

- `prototype/desktop-companion/src/desktop-stream.mjs`：带源身份与 revision 校验的只读 follower；原子应用补丁、拒绝原型链路径。
- `prototype/desktop-companion/src/desktop-view.mjs`：按 canonical islands 顺序投影所有已加载的公开文字、工具状态与结果。排除 reasoning、权限配置、原始状态及未知认证请求内容。不从 assistant 文本制造 user 消息。
- `business/src/desktop-projection.mjs`：RAM-only 快照、变化投影和可重试分页游标；分页期间保持同一版本。完整性来自 owner 的 `isComplete`，不由有多少条数据猜测。
- `business/web/desktop-live.mjs` / `desktop-history.mjs`：分页加载、原生文字增量、工具详情、单次审批卡片、离线禁用与最新消息跟随。仅 `desktopSync` 显式启用时加载。
- `scripts/start-desktop-sync-test.mjs`：仅接受两个既有专用 ID 与各自精确 cwd，仅绑定 `127.0.0.1`；lifecycle 强制只读，acceptance 可显式启用审批验收。有访问密码、HttpOnly 会话 cookie、Origin/Host 校验。手机队列写入关闭；无通用 RPC 或 native 启动入口。

文字更新来自实际 owner 补丁，不用定时器拆分完整答案。owner 可以合并传输批次，因此能力声明为 `nativeIncrementalText=true`、`rawTokenBoundaries=false`，不保证一 token 一帧。图片、特殊消息类型和不支持的审批类型会明确提示，不静默伪装完整支持。

## 审批语义

仅对当前原生待审请求提供“允许一次 / 拒绝”，目前支持 commandExecution 与 fileChange，其他类型显示“在电脑处理”。凭证绑定 owner、会话、原生 request、turn/item、内容及 epoch。持久化本机 intent 日志在发出 RPC 之前记录 unknown；同一次原生审批跨断线也不能重复发送。

owner ACK 仅表示“选择已提交”，不能据此宣称“已允许”。随后以 owner 移除该待审请求为“电脑已处理”的证据。离线、换 owner、请求过期及 unknown 不会自动重放，不授予 session / always 权限。

## 本轮证据与门禁

| 项目 | 结果 |
| --- | --- |
| 真实历史 | PASS：初次读取13个 canonical 实体、48个公开展示项，`isComplete=true`，含最早 BOOTSTRAP 回答；后续新 turn 连续同步 |
| 原生文字增量源 | PASS：专用 `pwd` + 长文本 turn 完成前观察到125次真实文字变化，见 `native-stream-metrics.json`；没有定时拆字 |
| 工具状态源 | PASS：实际 commandExecution 的执行中、完成及输出已投影；只读 `pwd` 和 HEAD 请求已执行 |
| 荣耀原生 WebView | PASS：完整分页（60个公开项）、最初 assistant 回答、最新 assistant 回答、真实 commandExecution `pwd`、刷新恢复及无横向溢出。报告 `honor-history-tools-report.json` |
| UI 状态夹具 | PASS：80项分页、精确审批 ID、单次提交、增量更新、桌面处理确认、离线失效、360px布局；这不是原生审批验收 |
| 故障 / 安全回归 | PASS：补丁原子性、错序 / epoch / 来源、正文不截断、敏感字段剔除、旧请求拒绝、unknown 跨重连禁重放、分页中 reset 不恢复旧审批 |
| observer 退出恢复 | PASS：仅关闭本次 observer，页面先失效、再换 epoch 自动恢复，原60项历史均保留；桌面未重启，见 `reconnect-result.log` |
| 真实命令审批拒绝 | **PASS（2026-10-21）**：专用 acceptance 原生 request 543，荣耀真实触摸拒绝，唯一 intent，原生工具 declined、未在审批后执行；手机最终答复与刷新恢复通过。此前复合用例超时保留为失败记录，不计 PASS。允许一次、文件审批及其他模型的人审条件未据此扩大验收 |
| 自定义 native 启动候选 | **已被自动审批审查拒绝，未执行**：直接 IPC `thread-follower-start-turn` 违反项目禁用约束。不得换包装或间接执行该脚本 |

第一轮浏览器“STREAM_DONE”检测曾匹配到转发指令自身，记录到的0次 DOM样本不能证明实时显示通过；后续断言限定 assistant 类型及 commandExecution 类型，避免提示词自带标记、命令名称造成误判。125次计数属于真实 owner 源；完整真机组合用例只有实际完成后才可计通过。

私有运行证据位于 `.runtime/desktop-sync-validation/`，UI截图位于 `/tmp/rmt-desktop-sync-qa/`，均不提交。源码 / 原型64项与 business 68项测试分别由各自 `npm run build && npm test` 验证；Android使用 `assembleDebug assembleDebugAndroidTest lintDebug`。

## 10月16日初次审批尝试（历史记录，勿复用旧配置）

下列为当时的手动尝试；当前复验应使用文末已经跑通的运行时条件及新鲜基线。旧 `permission-mode.mjs` 会混用显示字段与遗留 `permissions`，不可复用它来证明权限已生效。

从正常桌面输入触发，避免 App Tools 转发启动覆盖权限：

1. 在该专用会话选择“只读”，手动发送：只在当前专用目录执行 `curl --head --max-time 10 https://example.com/`；需要网络权限时正常申请，被拒后停止。
2. 暂不在桌面批准；只在存在真实 commandExecution 待审请求时运行荣耀 `DesktopSyncTest#testApprovalOnlyFromManualDesktop`，由手机实际触摸点击“拒绝”。
3. 核对 owner 待审消失、原生执行结果、同 intent 不重发、桌面 / 手机一致，之后恢复专用会话原设置。不得据 UI fixture 宣称原生通过。

专用会话临时权限已恢复为本轮开始前的 `never / :danger-full-access`，owner 状态已只读核对；当前没有活跃 turn 或待审请求。再次验证时应由用户在桌面选择“只读”。

本机启动配置在私有 `config.json`，需要 `localOnly=true`、精确测试 ID/cwd、随机访问密码、private runtime、固定 loopback 端口及当前测试 queueRuntime。`node scripts/start-desktop-sync-test.mjs <private-config>` 不修改任何桌面配置。用于故障测试的 SIGUSR1 只关闭本服务自己的 observer，不触碰桌面进程。

验收未闭环前，不部署 ECS 历史 / 审批通道，不为 RN UI 或其他项目打开 `desktopSync`。当前生产 APK 仍是之前的队列聊天界面。本机专用视图为只读验收，手机队列发送被明确关闭；原生历史与手机队列回执的合并、ECS 认证投影通道仍需后续接入，不能仅为现有项目打开标志即推广。

本次使用 Playwright CLI 和荣耀原生 WebView instrumentation；Browser 插件未安装，可补装以简化后续浏览器验收。未提交或 push。

收尾：测试入口仅本机有效；荣耀原页面已恢复，临时设备配置与 ADB reverse 会清理，专用 observer 会停止。手动审批触发后，下一轮重新开启同一专用验收入口即可继续。

## 2026-10-21 手动触发复核：尚未产生真实审批

用户确认发送后，只读回查发现新消息位于 `rmtcdx companion lifecycle`（`01a13fef-a018-7303-a2a6-f5903548537f`），turn 为 `01a15d8b-f549-7430-b273-c533848b7836`。该轮实际配置为 `approval_policy=never`、`sandbox_policy.type=danger-full-access`；指定 HEAD 命令退出码为 0、返回 `HTTP/2 200`，没有申请审批。仅在提示词里写“需要权限时申请”不会改变这一权限配置。

原定手机测试固定绑定的 `rmtcdx companion acceptance` 当时为 `notLoaded`，只读 follower 初始化成功，但找不到该会话的已加载 owner（discovery 超时）。未尝试启动、恢复或接管 owner。

荣耀 `ACTH022325002169`（LGE-AN00）已连接，但因没有真实待审请求，未运行会点击拒绝的 instrumentation，不能计为手机拒绝或桌面审批同步通过。本轮没有修改 APK、设备临时配置、ADB reverse、桌面权限或其他聊天；桌面进程未重启。私有复核记录位于 `.runtime/desktop-sync-validation/manual-20261021/preflight.json`。

继续验收需在正常桌面打开原定 `rmtcdx companion acceptance`，将**该会话**切为只读且允许按需询问，再手动发送同一只读命令。只在 owner 出现真实待审请求后执行手机拒绝验收；未出现审批时继续如实保留待验状态，不用 fixture 或自定义 native start 替代。

### 同日第二次复核与荣耀实际连接

用户询问审批在哪里查看后，通过桌面导航工具打开上述固定 acceptance ID，未发送模型消息或启动 turn。原有 owner 随正常打开恢复可用，荣耀复用现有主 APK，通过本机专用入口登录并加载完整历史，页面显示“已同步”（`manual-20261021/honor-waiting.png`）。

只读核对当前 owner 的 `latestThreadSettings`，实际仍为 `approvalPolicy=never`、`activePermissionProfile.id=:danger-full-access`、`sandboxPolicy.type=dangerFullAccess`，当前无活跃 turn 和待审请求。荣耀运行一次 `testApprovalOnlyFromManualDesktop`，进入等待真实审批阶段后 150 秒超时（总耗时 151.37 秒），未进行任何拒绝点击。连接与历史展示得到实机确认，真实审批拒绝及其桌面同步仍未验收；不得把等待阶段的标记当作审批通过。

结束后恢复验收前已有的手机私有配置及原页面，仅移除本次 `tcp:38441` 转发，保留原 `tcp:8081`；停止本次 server / watcher，未重装主 APK。桌面及原有 Codex CLI 进程的 PID、启动时间均与基线一致。结果和恢复读回分别见 `manual-20261021/honor-approval-result.json`、`current-settings.json`、`cleanup.json`（均位于私有 `.runtime/desktop-sync-validation/`）。

### 16:48 截图复核：下一轮配置与上一轮权限应分别判断

用户截图里的 16:20 执行记录对应 lifecycle 专用会话。再次只读查询两个 owner：lifecycle 的 `latestThreadSettings` 已为 `on-request / :workspace / workspaceWrite / networkAccess=false`，而 `currentPermissions` 仍保留上一轮 `never / :danger-full-access`；acceptance 的这两组字段均仍为 `never / :danger-full-access`。两个会话均无新 turn 或待审请求，复核记录见 `manual-20261021/screenshot-permissions.json`。

因此不能仅凭上一轮的 `currentPermissions` 断言用户没有更改下一轮设置；也不能将输入框下方“请求批准”模式按钮当作已产生真实审批。后续必须核对准确会话 ID、下一轮实际执行权限及真实待审请求三者。当前固定手机验收程序只绑定 acceptance；其下一轮配置也需要在正常桌面选择相应审批模式，不能把 lifecycle 的更改视为已应用到 acceptance。本次仅检查，未更改任何权限、发送消息、启动模型任务或运行外网命令。

## 2026-10-21 17:01：Auto-review 根因及荣耀只读同步通过

最新真实执行仍位于 lifecycle（`01a13fef-a018-7303-a2a6-f5903548537f`），turn `01a15da8-5026-7101-8e38-e6ba345f1b31`。该轮实际执行上下文为 `approval_policy=on-request`、`approvals_reviewer=auto_review`、工作区沙箱且 `network_access=false`。第一次 HEAD 因 DNS 受限退出 6；模型正常申请同一命令的网络权限后，原生 Guardian 在 16:51:33.934（北京时间）给出 `outcome=allow / risk_level=low / user_authorization=high`，重试返回 `HTTP/2 200`、退出 0。此结论来自该轮上下文、审核最终结果与真实工具记录，不能把 owner 界面保存的 `approvalsReviewer=user` 当作该轮实际采用的人审方式。

这次没有可供手机点击的原生待审请求，不能事后拒绝已经批准并完成的命令，也没有制造高风险操作或更改审批策略来强行触发人审。acceptance 原固定 ID 仍没有新的模型 turn。此前只检查固定 acceptance 导致会话错位，又未及时核查实际 `auto_review`，因此本轮补齐两项验收约束：

- `desktop-test-scope.mjs` 将本机入口绑定到两个既有专用 ID 和各自的精确 cwd；未知 ID、ID/cwd 错配、非 localOnly 均拒绝。acceptance 保留原有显式审批验收能力；**lifecycle 仅允许只读历史，任何启用审批响应的配置均在启动前拒绝**。未增加真实项目范围。
- 荣耀新增只读用例仅核对固定 lifecycle 的指定 turn：真实 DNS 失败项、HTTP 200 成功项、最终公开答复、无待审卡片、刷新后的同一记录、无横向溢出。不点击按钮，不发送聊天或队列消息。

荣耀 `ACTH022325002169`（LGE-AN00）最终结果 `OK (1 test)`，耗时 2.12 秒；此耗时是历史与刷新验收耗时，**不是模型首字延迟或执行期实时性指标**。首次尝试在刷新时过早读取旧 DOM，导致 evaluateJavascript 回调随页面卸载丢失；已改为等待原生新文档加载完成，再校验历史，之后完整通过。

验证：companion `npm run build` 及 65/65 测试通过；Android `assembleDebugAndroidTest lintDebug` 通过；`git diff --check` 通过。隔离沙箱内的 socket 测试曾因 `EPERM` 失败，获准在沙箱外使用模拟临时 socket 重跑后通过，没有接入真实桌面写入口。

私有证据在 `.runtime/desktop-sync-validation/auto-review-20261021/`：`native-approval-evidence.json`、`honor-report.json`、`honor-readonly.log`、`honor-auto-review-outcome.png`、`companion-tests.log`、`android-build.log`、`cleanup.json`。结束后原手机页面已由用例恢复，临时私有配置恢复为原先不存在的状态；仅移除本次 38441 转发、保留 8081，并停止本次 server。13 个基线桌面 / Codex CLI 进程的 PID 和启动时间均保留。仅更新测试 APK，未重装主 APK、重启桌面、修改其他聊天或部署 ECS；未提交、push。

门禁仍为：人工待审的手机拒绝未验收；本轮通过的是已完成真实记录的只读同步和刷新恢复。后续应先识别实际审核方式，再在原生支持的人审条件下验收拒绝；不再要求用户仅靠重复发送同一低风险命令来保证出现人审卡片。

## 2026-10-21 17:20：真实人工审批、荣耀拒绝和桌面同步闭环通过

### 已验证的人审条件

1. 判断**实际执行轮次**的 `approvals_reviewer=user` 与 `approval_policy=on-request`；输入框标签、下一轮缓存设置和上一轮 `currentPermissions` 均不能单独作为有效人审证据。[官方 Auto-review 文档](https://learn.chatgpt.com/docs/sandboxing/auto-review)明确自动审查替换的是审批者，切换审批策略本身不等于切换审查方式。
2. 本机模型缓存把 GPT-6.1 Sol 的 `node_repl_auto_review_required` 标为 true，GPT-5.6 Sol 为 false；此前 6.1 的实际运行走 Auto-review。本轮只在 acceptance 临时使用原生可选的 GPT-5.6 Sol 做兼容对照，最终 turn 的执行上下文实际为 `gpt-5.6-sol / on-request / user / read-only / restricted network`。这是已实测组合，不宣称所有模型或运行模式均已支持人审。
3. 当前桌面版本使用规范的命名权限字段 **`permissions=:read-only`**。旧快照残留 `permissions=:danger-full-access`；仅更改 `activePermissionProfile` 显示字段会留下相互矛盾的设置。初次兼容模型对照因此仍直接联网成功，未触发审批；纠正规范字段后，同一只读命令在沙箱内确实因 DNS 受限退出 6，再出现人审。原生 API 还明确拒绝同时提交 `permissions` 与旧 `sandboxPolicy`，应选择命名 profile 格式，不能混传。
4. 只读命令真实越过网络边界并产生 `item/commandExecution/requestApproval`，且没有被已有允许规则直接放行，才能进行手机拒绝。不得用模拟卡片、已自动处理的记录或已完成命令代替待审请求。

研究读取了当前安装包的资源副本（未修改签名应用），其 app-shared SHA256 为 `64e2b99444d28f5a0067e309a56912749763af09f9b27f083fce2d702a2b9fc3`；旧10月16日缓存与当前包不同，因此本轮按当前原生 API 校验格式。只更改 acceptance 的临时设置，保存新鲜基线并以模型/推理强度条件校验更新；全局 config.toml 全程哈希相同。

### 闭环证据

通过官方 `send_message_to_thread` 工具对用户授权、空闲的 acceptance 发送专用只读验收消息，没有调用或恢复被拒绝的自定义 `thread-follower-start-turn`。本轮有两次专用对照：第一次发现规范权限残留，HEAD 直接成功且按要求停止；修正后第二次完成真实拒绝。没有要求用户再次重发命令，没有向其他会话发送消息。此发送方式仍仅为专用测试例外，不改变业务层禁止 native start/steer/interrupt 的门禁。

- conversation：`01a13feb-ce80-7ca3-aa1e-17814542b353`。
- 通过的 turn：`01a15dbe-0f90-7051-955c-94ceae50ee17`，native request ID `543`，类型 `item/commandExecution/requestApproval`。
- 原生首次待审观测：17:15:05.041（北京时间）；荣耀实际触摸“拒绝”，手机审批 ID 与 ledger 完全一致。
- 手机从实际触摸至显示“电脑已处理”耗时 **162ms**（同一手机时钟）；该数值是本机 ADB USB 转发单样本，不是 ECS 或移动网络时延承诺。
- ledger 对同一 native request 只有 **1** 条 `decision=decline`、`state=submitted` intent；owner 后续待审数变为 0。并非只依据 ACK 判断完成。
- 原生升级执行项为 **declined**，没有审批后的网络执行；桌面最终回复明确“申请：是、拒绝：是、审批后执行：否”，未重试或绕过。
- 荣耀物理拒绝用例 `OK (1 test)`；额外只读终态用例 `OK (1 test)`，确认同一 turn 的“已拒绝”、最终“未执行”答复和刷新恢复。补充用例防止把“卡片刚消失但工具暂仍执行中”的中间态当作完整结束。

Android `assembleDebugAndroidTest lintDebug` 通过；本轮仅修改 instrumentation 以记录审批 ID、时间及校验完整终态，没有部署新的业务静态页面。私有证据位于 `.runtime/desktop-sync-validation/human-review-20261021/`：`actual-turn-permissions.json`、`closed-loop-evidence.json`、`honor-report.json`、`honor-final-report.json`、`honor-decline.log`、`honor-final-outcome.log`、`honor-pending.png`、`honor-resolved.png`、`honor-final.png`、`restoration.json`、`cleanup.json`。

### 恢复与范围

已恢复原 `gpt-6.1-sol / xhigh / :danger-full-access / never / user` 控制设置，读回无活跃 turn 和待审，global config 哈希未变。原生执行补全了 modelProvider、summary、personality 及协作运行上下文字段，因此状态快照不是字节级复原；模型、强度、权限和审批控制已与基线逐项核对。这些运行元数据差异单独记录在 `settings-restoration-comparison.json`，不伪称全快照相同。

手机原页面及原先不存在的临时私有配置已恢复；仅移除本次 tcp:38441，保留原 tcp:8081。仅更新测试 APK，主 APK未重装。本次 server / watcher 均已停止，11个基线桌面 / Codex CLI进程的 PID、启动时间保留。未重启桌面、修改其他活跃会话、扩展真实项目或部署 ECS；未提交、push。

当前门禁：本机专用会话的**原生命令审批拒绝闭环已通过**；允许一次、文件变更审批、其他模型兼容性与 ECS 鉴权审批通道仍需各自验收，不扩大本轮结论。

# 桌面已有执行器接入：操作与验证交接

更新：2026-10-15。仓库：`/Users/liutianwei/Projects/util/rmtcdx`，分支：`codex/remote-control-cloud`。

**当前执行入口已更新为 [codextest 单执行器薄桥原型](CODEXTEST_THIN_BRIDGE_PROTOTYPE_RUNBOOK.md)。** 用户已指定 MiniMax 在 codextest 内做原型；正常用户 Codex 保持不动。本文阶段 A 是基础复测，阶段 B 按新文档执行；阶段 C 仍未授权。

## 给接手 agent 的任务

可以直接复制以下任务描述：

> 阅读 AGENTS.md、本文件和 `docs/CODEXTEST_THIN_BRIDGE_PROTOTYPE_RUNBOOK.md`，在 codextest 拥有的源码工作副本中实现并验证单执行器薄桥原型。使用新文档的身份预检、阶段顺序和 B01–B18 矩阵。已允许操作本轮 codextest 测试桌面、专用会话及自身组件，按前置条件运行和恢复；不再询问是否选择薄桥。禁止连接、修改、终止或重启正常用户 liutianwei 的 Codex，禁止复用其 profile/认证/工具管道，禁止第二个同 profile writer，保留默认 native 停用守卫。不做 ECS、手机或公网验证，不改共享安装包，不提交/推送，不启动其他 agent。保留工作区既有改动，提交独立证据和准确范围报告。

本交接允许阶段 A 及 codextest 专用阶段 B 原型。授权不扩展到正常用户的桌面、会话、profile、启动设置，以及 ECS 部署或发布 APK。

## 目标与当前状态

**验收目标**：APK 与桌面将请求交给同一个 app-server，使用相同 thread ID 和原上下文；APK/业务 worker 退出不能结束桌面执行器，也不能改变桌面权限。

| 内容 | 上一轮结果 | 本轮要求 |
|---|---|---|
| 独立 HOME 的离线初始化 | 已通过 | 重跑并保存当前结果 |
| 两个协议客户端共享一条合成历史 | 已通过 | 重跑并核对断言 |
| 断开/重连客户端后原执行器继续存在 | 隔离 fixture 已通过 | 重跑 |
| 业务 build / 测试 | 已复测至 41 项通过，含附加适配器骨架测试 | 以本轮实际数量及新增覆盖为准 |
| 当前桌面可直接附加 | 上次 socket 不存在 | 被动复查，不主动连接 |
| codextest 真实桌面配置兼容 | 测试用户和桌面已观察到在运行，兼容性未验收 | 按新薄桥文档验证，不改变正常用户 |
| APK → ECS → worker → 原执行器续聊 | 尚未实现和验收 | 阶段 C，当前不能报告通过 |

`rmtcdx_fixture_desktop` / `rmtcdx_fixture_apk` 是探针里的协议客户端名称，**不是运行中的桌面 UI 或实际 APK**。不能把隔离探针 PASS 写成荣耀端到端 PASS。

## 必读材料

1. [运行隔离审计](CODEX_RUNTIME_ISOLATION_AUDIT.md)：为什么旧执行器停用。
2. [已有执行器接入研究](DESKTOP_EXECUTOR_ATTACH_RESEARCH.md)：候选入口、协议和版本限制。
3. [官方移动端接入核查](OFFICIAL_MOBILE_CONNECTION_RESEARCH.md)：官方 relay 与单一执行器架构。
4. [业务任务架构](adr/001-business-task-architecture.md)：ECS 接口和数据保留边界。

研究对应的安装包 CLI 为 `0.162.0-alpha.17.2`，SHA-256 为 `0d5ac7aae20c4eda6242428d5e218c55ba96d8763fda2a271088ff37104b9d28`。这只是已验证版本基线；版本变化时停止并重新核查，不升级/降级用户正在使用的 Codex 来迁就探针。

## 阶段 A：当前可以执行

### A0. 范围与前提

- 使用本机现有工作区。关键代码尚未提交；新 clone 或新 worktree 可能根本不包含这些文件，不能直接用远端旧版本复测。
- 当前授权下应交接该源码至 codextest 拥有的工作副本；下方路径已按测试用户调整。不要修改正常用户 HOME 的权限来获取源码，不复制其认证或运行目录。
- macOS、Node.js 22 或以上、`/usr/bin/sandbox-exec`；脚本写死当前桌面安装路径。Windows/其他安装路径属于本轮未覆盖范围。
- `business/node_modules` 中构建依赖已安装；`services/rmtcdx/node_modules/ws` 存在。缺失则报告 BLOCKED，不运行上游 start/dev，不自动升级依赖或重装全局 CLI。
- 同一时间只运行一套本交接验证。不要把两个探针并行启动，也不要与另一位 agent 同时修改这些文件。
- 阶段 A 不需要 ECS、登录凭据、手机、adb、Appium 或公网服务。不要读取 `.runtime/business-ecs/local.json`、agent token、认证配置来完成它。

### A1. 一次执行预检和验证

以下整个命令块在**同一个 shell 进程**执行。其他 agent 的多次 exec 调用通常不保留 shell 变量，不能只复制后半段。失败时 `set -e` 会停止；先查看对应日志，不降低隔离条件继续跑。

```bash
set -eu
umask 077
test "$(id -un)" = codextest
test "$HOME" = /Users/codextest
cd /Users/codextest/Projects/rmtcdx
TASK_ATTACH_EVIDENCE="$PWD/.runtime/attach-validation/$(date +%Y%m%d-%H%M%S)-$$"
mkdir -p "$TASK_ATTACH_EVIDENCE"
chmod 700 "$TASK_ATTACH_EVIDENCE"
export TASK_ATTACH_EVIDENCE

git status --short > "$TASK_ATTACH_EVIDENCE/checkout-before.txt"
git branch --show-current > "$TASK_ATTACH_EVIDENCE/branch.txt"

node --input-type=module > "$TASK_ATTACH_EVIDENCE/preflight.json" <<'NODE'
import fs from 'node:fs';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
if (process.platform !== 'darwin') throw new Error('BLOCKED: macOS only');
if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('BLOCKED: Node >=22 required');
const files = [
  'scripts/check-desktop-attach.mjs',
  'scripts/probe-isolated-codex.mjs',
  'scripts/probe-shared-executor.mjs',
  'business/src/runtime-isolation.mjs',
  'business/src/existing-executor-discovery.mjs',
  '/usr/bin/sandbox-exec',
  'business/node_modules/@phosphor-icons/core/package.json'
];
for (const file of files) fs.accessSync(file);
const require = createRequire(import.meta.url);
const ws = require.resolve('./services/rmtcdx/node_modules/ws');
const bundle = '/Applications/ChatGPT.app/Contents/Resources/codex-cli';
const version = JSON.parse(fs.readFileSync(bundle + '/codex-package.json')).version;
const binary = bundle + '/CodexCLI.app/Contents/MacOS/codex';
const sha256 = crypto.createHash('sha256').update(fs.readFileSync(binary)).digest('hex');
console.log(JSON.stringify({ node: process.version, version, sha256, ws }));
if (version !== '0.162.0-alpha.17.2' || sha256 !== '0d5ac7aae20c4eda6242428d5e218c55ba96d8763fda2a271088ff37104b9d28') {
  throw new Error('BLOCKED: bundled CLI changed; review compatibility before probing');
}
NODE

node scripts/check-desktop-attach.mjs \
  > "$TASK_ATTACH_EVIDENCE/desktop-before.json" \
  2> "$TASK_ATTACH_EVIDENCE/desktop-before.stderr.log"

if node business/src/runtime-isolation.mjs \
  > "$TASK_ATTACH_EVIDENCE/native-guard.stdout.log" \
  2> "$TASK_ATTACH_EVIDENCE/native-guard.stderr.log"; then
  echo 'FAIL: native guard unexpectedly allowed execution' >&2
  exit 1
fi
rg -q 'native_runtime_suspended_pending_isolation' \
  "$TASK_ATTACH_EVIDENCE/native-guard.stderr.log"

node scripts/probe-isolated-codex.mjs \
  > "$TASK_ATTACH_EVIDENCE/offline-probe.json" \
  2> "$TASK_ATTACH_EVIDENCE/offline-probe.stderr.log"

node scripts/probe-shared-executor.mjs \
  > "$TASK_ATTACH_EVIDENCE/shared-probe.json" \
  2> "$TASK_ATTACH_EVIDENCE/shared-probe.stderr.log"

npm --prefix business run build > "$TASK_ATTACH_EVIDENCE/build.log" 2>&1
npm --prefix business test > "$TASK_ATTACH_EVIDENCE/tests.log" 2>&1

node scripts/check-desktop-attach.mjs \
  > "$TASK_ATTACH_EVIDENCE/desktop-after.json" \
  2> "$TASK_ATTACH_EVIDENCE/desktop-after.stderr.log"
git status --short > "$TASK_ATTACH_EVIDENCE/checkout-after.txt"
printf 'Evidence: %s\n' "$TASK_ATTACH_EVIDENCE"
```

预检失败时，证据目录仍然存在。执行工具若不返回变量，按本轮刚生成的独立目录查日志，不要覆盖上一轮证据。

探针按当前用户 HOME 查找桌面状态 canary；codextest 缺少该文件时，记录前置缺失，不复制或改指向正常用户文件。当前进程检查工具会列出多个用户的 app-server，必须额外记录 UID 并分组比较，不能把跨用户实例当成重复 writer。

`build` 仅构建本地静态资源，不会部署 ECS。探针创建专用临时目录及自身子进程，不启动业务 worker；合成 fixture 的改名和 resume 不作用于用户会话。

### A2. 核对输出，不能只看退出码

| 文件 / 字段 | 预期 | 证明范围 |
|---|---|---|
| `native-guard.stderr.log` | 包含固定停用错误码，命令非零退出 | 真实 native 默认入口仍阻止启动 |
| `offline-probe.json` | initialize、空目录、桌面读取/越界写入/网络监听拒绝均 PASS | 新 profile 离线初始化隔离 |
| `shared-probe.json` 的 8 个 PASS 字段 | 全部 PASS | 下表的共享协议检查 |
| `shared-probe.json.inference` | `NOT_EXECUTED` | 没有模型推理证据 |
| `shared-probe.json.existingDesktop` | `NOT_CONNECTED` | 没有连接当前桌面 |
| `shared-probe.json.stderrBytes` | 基线为 0；非零需解释 | 不能把 stderr 计数当成完整诊断日志 |
| `tests.log` | 全部通过、无失败/取消；记录实际数量 | 仓库协议与守卫回归 |
| `build.log` | 构建退出码 0 | 本地构建通过 |
| 两份 `desktop-*.json` | `connected/started/changedDesktop` 均 false | 检查工具自身未主动连接/修改 |
| 两份 `desktop-*.json.appServers` | PID/parentPid/监听结构一致 | 未观察到执行器替换，不证明完整 UI 正常 |

共享探针必须有以下 8 个字段：

```text
missingProxyDoesNotStartServer
twoClientsShareLoadedThread
resumePreservesThreadId
metadataVisibleAcrossClients
detachDoesNotStopServer
reconnectPreservesLoadedThread
tcpDenied
fixtureChildrenStopped
```

这些字段由脚本断言汇总，不是逐帧 RPC 日志。特别核对脚本中的合成历史标记断言，防止用“同 ID 但没有上下文”替代接续验证。

若当前桌面 `endpoint.reason=socket_missing`，这是正常的研究阻塞条件，**不是让你启动 daemon 的指令**。若 `attachable=true`，它也只表示文件元数据符合条件，尚未证明 listener 属于桌面正在使用的执行器，不能立即连接。

若前后 PID 变化，先区分用户手动重启、桌面自动更新和测试行为，报告事实；不能凭变化就认定 rmtcdx 导致故障，也不能忽略变化继续宣布无影响。

### A3. 清理与失败处理

- 正常退出时脚本会清理自身客户端和执行器；临时 profile/合成历史保留供取证。其路径在成功 JSON 的 `root` 字段中。
- Unix 实际 socket 位于 `/private/tmp/codex-daemon-<uid>/`，与 HOME 无关。脚本仅操作自己随机路径的 hash 文件和 `.lock`；该共享目录本轮创建且为空时才移除。
- 中断/异常退出不能只凭报告宣称已完全清理。核对本轮自身进程与精确文件路径；失败 JSON 可能为空，不要用旧报告代替。
- 禁止 `pkill codex`、`killall`、删除整个 `~/.codex` 或共享 socket 目录。不能按通配符批量清理其他运行的 Codex。
- 沙箱 EPERM、握手超时、socket 权限不符或协议字段变化时，保存日志后停止；不得取消沙箱、扩大共享目录写权限或跳过证书/身份检查。
- 本轮前后工作区差异应能解释为构建产物或本轮明确修改；不得 reset/clean/stash 用户未提交工作。

## 阶段 B：已选择 codextest 单执行器薄桥原型

完整操作及 B01–B18 验收见 [codextest 原型专用文档](CODEXTEST_THIN_BRIDGE_PROTOTYPE_RUNBOOK.md)。这是新启动链路实验，当前没有可以直接热接入正常用户 stdio 进程的命令。

- 桌面经 JSONL↔WebSocket 适配器连接唯一 codextest app-server；本机模拟 worker 使用另一条原生连接。不是 tee、字节广播或自行混合客户端 request ID。
- 用户已授权本轮 codextest 原型及必要的测试桌面启动/恢复；运行前必须核对 UID、空闲测试状态、独占 profile、端点身份及回退范围。正常用户的桌面完全不操作。
- 保留桌面全部配置参数、codextest 自己的登录/插件/MCP/工具环境；不清空 factory 覆盖，不修改 app.asar，不继承正常用户上下文。
- worker 只有附加连接权，不能启动/停止执行器。测试 launcher 只管理本轮唯一 owner；缺少 endpoint 不回退 native/mock。
- 旧 native 停用守卫保持原样。骨架尚未真实连通，不得把新增测试通过当作原型已完成。
- 缺少实际实现、独立登录或隔离证据时，报告该项 BLOCKED；不需要再向用户询问是否接受已选定的 codextest 薄桥路线。

## 阶段 C：APK 原会话端到端，前置未满足时不执行

这一阶段需要阶段 B 通过、业务附加适配器完成、确定测试环境及单独的部署/设备操作范围。当前默认 NOT_EXECUTED；本轮 codextest 薄桥授权不包含阶段 C。

### 测试对象与链路

- 荣耀设备基线序列号：`ACTH022325002169`；包名：`com.liutw.codexremote`。先重新确认在线设备，仅操作指定荣耀，不操作其他华为设备。
- 业务架构：APK → HTTPS 业务 API/状态 → 电脑主动领取固定任务 → 本机附加连接 → 桌面唯一执行器。
- ECS 不接收原始 app-server 帧、不做端口/HTTP/WS 透传。TLS 正常校验，云端不持久化聊天正文；不要把私有证书/账号凭据放进报告。
- 当前 native 执行器停用，统一侧栏尚未部署；旧云端页面或旧截图不能代替新版验收。
- 如需构建：遵循 `AGENTS.md`；构建主包/测试包及 lint。构建成功不能替代设备运行。若用 Appium，先检查占用并使用独立端口。

### 首次原 ID 续聊用例

1. 在已经验证隔离的测试桌面，选择专用隔离测试项目，创建一条测试会话。发送只读提示词：`只回复 ATTACH_A_<本轮唯一标记>，不要执行命令或修改文件。`
2. 等桌面完成，记录 thread ID、该 turn ID、完成状态和标记内容。业务服务/日志只存 ID 和状态，正文证据保存在本地受限目录。
3. APK 通过项目侧栏打开这条**已有测试会话**，验证同 thread ID、原完成记录可见。不能点击“新建会话”后用相同标题替代。
4. APK 发送：`只回复上一条标记，并追加 ATTACH_B_<本轮唯一标记>；不要执行命令或修改文件。` 验证确实保留上下文。
5. 等完成后在桌面回读：同 thread ID、同新增 turn ID、两端结果一致且只有一次执行。仅截图看起来相同不够。
6. 关闭 APK/断开网络/停止本次 worker 连接，验证测试桌面执行器仍存在、能读取原会话。重连后能读取该完成 turn，不能自动重发提示词。
7. 重复打开/关闭侧栏，验证已有缓存立即显示、收起时目录能后台更新；项目置顶只写 App 本地状态。
8. 汇总后先恢复测试环境。用户原有会话仍只读；需要对用户旧会话实际发送时，应另行明确指定目标和权限，禁止任选活跃会话试发。

### 故障与正常桌面回归

| 用例 | 判定 |
|---|---|
| worker 连接断开/进程退出 | 桌面执行器继续工作；只关闭自己的连接 |
| 原执行器不可用 | 明确离线/拒绝新写入，无自动拉起第二执行器 |
| 写任务响应丢失、重连 | 依据原 intent/receipt 核对，不能盲目再执行 |
| 桌面活跃 turn 与 APK 再发送 | 遵循既定并发策略，不中断原 turn、不改权限 |
| 审批事件 | 正确归属；不得自动允许或扩权 |
| 桌面历史/侧栏/打开项目 | 无白屏或持续重载；观察 UI 与日志，不主动制造桌面故障 |
| 桌面专用测试会话一次只读问答 | 正常完成，原有其他会话不被写入 |
| 停止 rmtcdx 业务客户端 | 桌面继续可用，且后台没有 rmtcdx 重启循环 |

遇到白屏、桌面执行器意外退出、第二个共享 profile writer、未知审批归属或越界写入，停止本次新增连接并保留证据；不要通过反复重启正常桌面“确认是否偶现”。

## 结果报告模板

报告保存到本轮证据目录的 `REPORT.md`。必须填写范围分母和未执行项，不写笼统的“全链路通过”。

```text
结论：阶段 A PASS/FAIL/BLOCKED；阶段 B ...；阶段 C ...
时间、机器、仓库分支、当前工作区是否包含未提交实现：
CLI 版本 / SHA-256、Node 版本：
证据目录：

执行范围：
- 业务测试：PASS n/n；FAIL n；BLOCKED n；NOT_EXECUTED n
- 隔离探针：通过字段及失败字段
- 真实桌面 / 模型推理 / APK：分别说明执行与否

正常桌面影响：
- 前后执行器 PID、parentPid、transport 结构
- 是否主动连接/改配置/重启/发消息；如有，目标及明确授权
- UI 回归是否实际观察；仅 PID 一致不能替代 UI 验证

失败或阻塞：触发步骤、原始错误、当前假设、缺失条件
清理与恢复：自身进程、独有 socket/lock、临时 profile、配置、设备状态
代码变更：精确文件清单；有无解除守卫/部署/提交/推送
下一步：最小必要行动及所需前置条件
```

本轮仅复测阶段 A 时，正确结论通常是“隔离协议验证通过；当前桌面附加与 APK 原会话端到端仍未完成”，不能写成“APK 已能正常接续桌面原会话”。

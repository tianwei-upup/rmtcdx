# 当前方案：业务任务服务

已切换到独立业务 API、电脑主动领取任务和本机 Codex stdio 执行。已完成局域网及 ECS 公网 HTTPS 验证，旧 `control/` 中转保持停用。

- [0.3.0 聊天 UI 与交互验证](docs/UI_INTERACTION_VALIDATION.md)
- [ECS 验证记录](docs/ECS_BUSINESS_VALIDATION.md)
- [附加型执行器接入实现](docs/ATTACH_TRANSPORT_IMPLEMENTATION.md)
- [codextest 薄桥原型（并行进行中）](docs/CODEXTEST_THIN_BRIDGE_PROTOTYPE_RUNBOOK.md)
- [启动与能力边界](business/README.md)
- [架构决定](docs/adr/001-business-task-architecture.md)
- [新方案本地验证](docs/BUSINESS_LOCAL_VALIDATION.md)

以下为原直连/旧中转实现资料，不能据此部署公网：

# rmtagt Codex Remote

> **架构调整（2026-10-15）**：现有 `control/` HTTP/WS 中转停止作为远程部署方案，仅保留 loopback 回归；代码拒绝远程 origin 与非 loopback 监听。后续采用业务任务与结果同步，禁止隧道和请求透传，见 [架构决定](docs/adr/001-business-task-architecture.md)。下文服务器部署内容为旧方案记录，不能据此上线；新业务服务与本地验证见上方入口。

Android App 通过统一云端入口，访问 Windows / Mac 上的本机 Codex 历史、创建会话和继续对话。电脑主动连接云端，项目、历史和 Codex 登录态保留在对应电脑。

完整应用维护在 `tianwei-upup/rmtcdx` 的 `codex/remote-control-cloud` 分支，具有独立项目历史；远端 `main` 保留原 rmtcdx 上游代码。获取完整应用：

```bash
git clone --branch codex/remote-control-cloud https://github.com/tianwei-upup/rmtcdx.git rmtagt
```

## 结构

- `control/`：自有云端服务和电脑连接客户端，Node.js 22+；接口和部署见 [control/README.md](control/README.md)。
- `services/rmtcdx/`：独立上游 checkout，来源 `tianwei-upup/rmtcdx`，固定提交 `82433524e8fb431185fbc7556d1e8a1cf2f2976d`。
- `patches/remote-control.patch`：本项目所需的设备路径、浏览器请求回执、重连恢复、历史图片和 Codex 0.160 空会话兼容补丁，以及依赖更新。安装不再应用旧的分散补丁。
- `android/`：Java 双 WebView 外壳；统一云端配置自动生成 Windows / Mac 设备页面，并保留直连配置。
- `scripts/`：安装、启动、验证和打包；`docs/MAC_SETUP.md` 为 Mac 配合操作清单。

## Windows 本机运行

```powershell
pwsh -File scripts/setup-local.ps1
pwsh -File scripts/start-local.ps1
node scripts/start-control-local.mjs
```

本地 bridge 为 `http://127.0.0.1:3210`，中转服务为 `http://127.0.0.1:3220`。本机启动脚本自动生成管理员密码并绑定设备 ID `windows`；登录信息保存在被 Git 忽略的 `.runtime/control-admin.json`，不输出到日志。

需要停止时：

```powershell
pwsh -File scripts/stop-control-local.ps1
pwsh -File scripts/stop-local.ps1
```

第一条只停止云端和连接客户端，第二条会停止本项目 bridge 及其 app-server 子进程，结束它们发起的活动任务。

## App 和模拟器

APK 为 `artifacts/codex-remote-debug.apk`，版本 0.2.0，Android 8.0+。

1. 模拟器调试时执行 `adb -s emulator-5554 reverse tcp:3220 tcp:3220`。
2. App 点击「配置」→「统一云端地址」，填写 `http://127.0.0.1:3220`；此 HTTP 例外只用于 loopback 调试。
3. 使用本地管理员信息登录，选择 Windows 即可浏览本机项目和历史。
4. 正式手机使用云服务器的 HTTPS 域名；Mac 完成绑定前，其入口显示未绑定或不可用。

切换电脑会保留各自 WebView；不通过刷新来切换会话。App 无 JavaScript 原生桥，不忽略 TLS 错误，不向页面暴露本地文件。

## 验证

本轮结果与未验证边界见 [验证记录](docs/VALIDATION.md)。

```powershell
pwsh -File scripts/verify-local.ps1
node scripts/verify-compat.mjs
npm --prefix control test
npm --prefix control run check
pwsh -File scripts/build-android.ps1
pwsh -File scripts/test-android.ps1
```

`verify-compat.mjs` 默认只读抽查已有原生历史和真实 WS 握手。加 `--run` 会在 `rmtagt-compat` 隔离项目中创建会话并进行两轮只读发送，消耗少量模型额度；必须先用包含该项目的 `.runtime/compat-repos.json` 启动 bridge。

本轮真实云端验证使用 `RMT_TEST_BASE=http://127.0.0.1:3220/devices/windows`，同一脚本经过鉴权和中转执行。隔离测试结果保存在 `.runtime/windows-compat-result.json`、`.runtime/cloud-compat-result.json`。

完整模拟器云端流程：

```powershell
pwsh -File scripts/test-android.ps1 -CloudConfig .runtime/android-cloud-test.json
```

配置文件由云端 `verify-compat.mjs --run` 生成，含本地测试登录信息和隔离会话标题；脚本运行后清除模拟器中的临时测试配置，配置文件不得分享或提交。

## Mac 和云端部署

Mac 按 [操作清单](docs/MAC_SETUP.md) 先验证本机，再使用 `mac` 配对码接入云端。云端部署使用 `control/deploy/` 的 Docker、Caddy 和环境配置示例，公网入口必须 HTTPS，服务端口不直接暴露。

尚无云服务器时也可以验证完整链路：保持 `bash scripts/start-mac.sh` 运行，另开终端执行 `node scripts/start-control-local.mjs`，浏览器访问 `http://127.0.0.1:3220`。macOS 默认接入 `mac` 设备，登录信息保存在 `.runtime/control-admin.json`；停止中转使用 `node scripts/stop-control-local.mjs`。

第一版单用户、单云端进程，设备元数据使用原子 JSON 文件和单写入锁；没有引入 SQLite。云端不持久化聊天正文，电脑执行端保存本机请求回执以防重复执行；浏览器在收到确认结果前保留原请求 ID，发生未知结果时只能以相同负载查询原回执，不能当成失败自动重跑。

传输由 TLS 保护，云端进程仍能接触转发内容；第一版未实现端到端加密和 TOTP。电脑休眠后不能接受新任务，Desktop 活跃任务接管不作保证。Windows 的本地验证不代替真实 Mac 和公网部署验收。

旧 Cloudflare 安装脚本保留供原有环境参考，不参与当前中转链路；当前 APK 默认不会打包旧隧道地址。

项目加载与 App 本地置顶：见 [验证说明](docs/PROJECT_CATALOG_VALIDATION.md)。

2026-10-22：已接入当前 Mac 全部 47 个本机项目的 848 条既有会话。APK 会话列表可切换项目；归档只读，未归档沿用桌面权限。部署和真机验收见 [全部项目历史接入](docs/PERSONAL_PROJECT_HISTORY_ACCESS.md)。

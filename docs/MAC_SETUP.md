# Mac 接入和兼容性验证

Mac 需要由平时使用 Codex Desktop 的同一个系统用户运行 bridge 和 rmtagt 客户端。项目和历史继续保留在 Mac；Windows 的验证结果不能代替 Mac 验收。

## 你需要准备

1. 确认工作电脑允许安装该客户端，并允许相关会话经你的云服务器转发。
2. 使用 Node.js 22 或更新版本，确保 `node`、`npm`、`git`、`codex` 在终端可用。
3. 在 Codex Desktop 正常登录后，运行 `codex --version`、`codex login status`，确认本机 CLI 的账号状态。不要发送登录文件或密钥。
4. 将提供的桌面端源码包解压到个人目录，例如 `~/Projects/rmtagt`。包里不包含 Windows 的 `.runtime`、登录态、电脑凭据或聊天记录。

## 先验证 Mac 本机

在解压后的项目根目录执行：

```bash
bash scripts/setup-mac.sh
bash scripts/start-mac.sh
```

第二条命令在当前终端前台运行，保持终端开启。它仅监听 `127.0.0.1:3210`，使用 `CODEX_MODE=real`，沿用当前用户的 Codex 环境。

另开一个终端，进入相同目录：

```bash
node scripts/verify-compat.mjs
node scripts/verify-compat.mjs --run
```

第一条只读验证已有历史与 WebSocket；第二条在隔离的 `.runtime/compat-workspace` 中创建测试会话并完成两轮只读对话，不续聊你的现有工作任务。两条命令均应返回 `result: PASS`。

然后用 Mac 浏览器打开 `http://127.0.0.1:3210`，找到一条你认识的、已经结束的 Desktop 会话，核对末尾消息。若要进一步验证该原有会话续聊，只发送“请只回复 MAC_DESKTOP_RESUME_OK，不要使用工具、不要读写文件、不要执行命令”，确认回复正常；不要选择正在执行的会话。

## 连接云端

云端部署并配置有效 HTTPS 域名后，在手机登录云端，生成设备 ID 为 `mac` 的五分钟一次性配对码。

Mac 另开一个终端，在项目根目录执行：

```bash
export RMT_SERVER_URL='https://你的云端域名'
export RMT_DEVICE_ID='mac'
export RMT_CLIENT_CONFIG="$PWD/.runtime/mac-client.json"
printf '配对码: '; read -r RMT_PAIR_CODE
export RMT_PAIR_CODE
node control/src/client.mjs pair
unset RMT_PAIR_CODE
node control/src/client.mjs
```

客户端主动通过 WSS 连接云端。bridge 和连接客户端这两个终端都需要保持运行；电脑休眠后无法接受新的任务，恢复网络后客户端自动重连。

第一轮先使用前台终端定位问题。登录自启动可在验收后通过当前用户的 LaunchAgent 配置，避免 root 或系统服务读取错误用户的 Codex 环境。

## 手机验收

1. 统一云端地址配置为你的 HTTPS 域名，登录后切换到 Mac。
2. 检查 Mac 的项目和历史，不应显示为 Windows 的列表。
3. 打开已结束的原有会话并发送上面的只读提示词。
4. 在 `rmtagt-compat` 项目中新建会话，发送一轮，再在同一个会话发送第二轮。
5. 切换 Windows 再切回 Mac，检查页面与会话位置保留。
6. Mac 断网后手机应提示重连；恢复网络后重新读取当前历史，不重复发送提示词。

## 需要反馈给我的信息

- macOS、Node、Codex CLI 和 Desktop 版本。
- 两次验证命令是否 PASS，以及手机六项检查结果。
- 失败时提供接口路径、HTTP 状态、去敏错误文本和发生步骤。
- 不需要提供源码内容、聊天全文、`.codex` 文件、配对码或客户端配置文件。

已知边界：Desktop 活跃任务接管尚未验证；新建后尚未发送第一条消息的空会话依赖当前 bridge 进程，首轮验证请在同一次启动中完成创建和发送。

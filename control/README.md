# rmtagt 云端中转与电脑客户端

> 此为旧中转协议，现仅限 loopback 回归；远程配对、远程 origin 及非 loopback 监听已被代码拒绝。下文公网部署与 WSS 接入内容仅保留历史参考，不再适用于新方案。新业务任务架构见 [ADR 001](../docs/adr/001-business-task-architecture.md)，尚未实现。

第一版面向单用户、自有云服务器、Windows/Mac Codex。运行环境 Node.js 22+；电脑继续使用本机已有的 `rmtcdx bridge` 和 Codex 登录态。云端不运行 Codex，不保存项目、聊天正文或模型凭据。

## 本机运行

在 `control/` 执行 `npm ci`。先使用现有脚本启动真实 bridge，监听 `127.0.0.1:3210`、`CODEX_MODE=real`，并构建上游 Web 资源。云端默认读取 `services/rmtcdx/apps/bridge/web-dist`，也可以设置 `RMT_STATIC_DIR`。

PowerShell 云端窗口（密码在会话中输入，不写入命令历史）：

```powershell
$credential = Get-Credential -UserName admin -Message '设置 rmtagt 管理密码，至少 24 个字符'
$env:RMT_ADMIN_USERNAME = $credential.UserName
$env:RMT_ADMIN_PASSWORD = $credential.GetNetworkCredential().Password
$env:RMT_PUBLIC_URL = 'http://127.0.0.1:3220'
npm start
```

浏览器打开 `http://127.0.0.1:3220`，登录后生成设备 ID 为 `windows` 的配对码。电脑客户端窗口：

```powershell
$env:RMT_SERVER_URL = 'http://127.0.0.1:3220'
$env:RMT_DEVICE_ID = 'windows'
$env:RMT_PAIR_CODE = Read-Host '输入配对码'
npm run client -- pair
Remove-Item Env:RMT_PAIR_CODE
npm run client
```

手机/Android 模拟器可使用 `adb reverse tcp:3220 tcp:3220` 后访问 `http://127.0.0.1:3220`。真机跨网络访问必须部署 HTTPS；HTTP 只接受 loopback URL。默认服务绑定 `127.0.0.1`，本机 bridge 地址固定 `127.0.0.1`，仅 `RMT_BRIDGE_PORT` 可配置。

## Mac 配合验证

1. 在与 Codex Desktop 相同的 macOS 用户下安装 Node.js 22+、Codex CLI，并确认 `codex login status`。不要用 `sudo` 运行。
2. 将本项目放到 Mac，进入 `services/rmtcdx` 安装和构建上游；按上游 README 启动真实 bridge。指定 `CODEX_MODE=real`、监听 `127.0.0.1:3210`，仓库目录配置为 Mac 上真实存在的路径。
3. 用本机 `curl http://127.0.0.1:3210/healthz` 确认 `codex.mode` 为 `real`，检查 `/api/sessions` 中能找到自己的历史会话。云端不能补齐本机缺失的 Codex 历史。
4. 在云端页面生成设备 ID 为 `mac` 的配对码。在 `control/` 执行 `npm ci`，设置如下环境变量后完成配对与连接：

```sh
export RMT_SERVER_URL='https://你的云端域名'
export RMT_DEVICE_ID='mac'
read -r -s RMT_PAIR_CODE; export RMT_PAIR_CODE; printf '\n'
npm run client -- pair
unset RMT_PAIR_CODE
npm run client
```

5. 手机选择 Mac，核对历史列表；打开一个无运行中任务的历史会话续聊；新建会话并发送无副作用提示词；验证审批、中断与断网恢复。记录失败接口的状态码与错误内容，不发送 token、配对码或聊天私密正文。
6. 暂不承诺接管 Codex Desktop 正在执行的任务。Mac 休眠时设备离线；唤醒后客户端重连，手机重新获取会话、消息、运行与审批快照。

客户端默认凭据位于 `control/.client/config.json`。可使用 `RMT_CLIENT_CONFIG` 将其放入仅当前用户可读的用户目录；Mac/Linux 创建权限 `0600`，Windows 请依赖个人用户目录 ACL（Node 的 mode 不能替代 Windows ACL）。客户端不负责安装 Codex、启动 bridge 或配置系统常驻服务。

## 云端部署

- 使用 `deploy/Caddyfile.example` 配置 HTTPS/WSS，代理到 `127.0.0.1:3220`。不要启用记录请求/响应正文的调试代理。
- 推荐 `RMT_ADMIN_PASSWORD_HASH`，格式为 `scrypt:32位hex盐:128位hex派生值`。在安全的环境中设置 `RMT_ADMIN_PASSWORD` 后运行 `node src/hash-password.mjs`，保存输出至服务环境配置，再移除明文环境变量。不要把凭据放进 Git。
- 单实例运行；`RMT_STATE_FILE` 指向持久化卷。云端重启后需重新登录，配对码失效；设备 token 继续有效。
- `RMT_PUBLIC_URL` 必须等于手机实际使用的 HTTPS origin；反向代理保持浏览器 `Origin`。服务不信任 `X-Forwarded-For`，代理后限流以代理 IP 计数，适合单用户场景。
- 容器示例在仓库根目录执行 `docker build -f control/deploy/Dockerfile -t rmtagt-control .`。先构建上游 Web 资源；设置容器 `RMT_HOST=0.0.0.0`，端口只发布到宿主 `127.0.0.1:3220`。
- 本轮没有 TOTP、找回密码、多用户权限和端到端加密。云服务器运行进程能读取正在转发的内容；TLS 仅保护传输。上线前由用户配置域名、证书、凭据及持久化卷。

## HTTP 接口

云端登录使用 `HttpOnly; SameSite=Strict` cookie；HTTPS 增加 `Secure` 与 `__Host-` 前缀。管理写接口必须携带与 `RMT_PUBLIC_URL` 相同的 `Origin`，设备配对使用一次性 code，设备长连接使用独立 Bearer token。

- `GET /healthz`：仅返回云端存活状态。
- `POST /api/login`：`{username,password}`，默认 username `admin`。单 IP 每分钟最多 5 次失败尝试；会话固定 12 小时。
- `POST /api/logout`：退出并关闭该登录会话的浏览器 WS。
- `GET /api/devices`：`{devices:[{id,name,online,createdAt}]}`，online 表示设备隧道连接，具体 bridge/Codex 状态看设备 healthz。
- `POST /api/pairing`：`{deviceId,name}` → `{code,deviceId,expiresAt}`，5 分钟有效。再次生成同设备配对码会替换旧码。
- `POST /api/pair`：`{deviceId,code}` → `{deviceId,token}`，仅用于电脑配对，code 单次消耗。重新绑定相同设备会废弃旧 token。
- `DELETE /api/devices/:id`：撤销设备，立即关闭设备和浏览器连接。
- `GET /devices/:id/healthz`：转发本机 bridge 诊断。
- `/devices/:id/api/*`：按白名单转发到本机 `/api/*`，不允许任意 URL、通知订阅或开发模拟接口。
- `GET /devices/:id/` 及其前端路由：返回上游 Web index；`/assets/*` 在同源下提供且要求登录。

每个写请求应使用唯一 `x-request-id`（16–100 位字母、数字、下划线或连字符，推荐 UUID）。未提供时云端生成，并在响应 `x-request-id` 返回。重试必须复用原 ID、原路径和原正文；新用户意图使用新 ID。

`GET /devices/:id/api/uploads/upload_<UUID>/<文件名>` 仅转发 bridge 上传批次中的单层文件，要求登录；禁止目录穿越、嵌套路径和任意本地文件。图片通过 base64 帧传输，浏览器收到原始二进制与受限图片 MIME；保持 32 MiB 解码后上限，并附加 `nosniff` 和 sandbox CSP。

电脑确认终结回执已经保存后，响应才包含 `x-rmtagt-receipt: complete`。前端校验该标记及匹配的请求 ID，允许明确 4xx 失败后的下一次用户操作使用新 ID。云端鉴权/离线错误、结果未知或回执 ID 不匹配均保留原 ID，禁止自动重跑。

## 设备协议与断线语义

- 电脑连接 `WSS /agent/connect`，请求头 `Authorization: Bearer <token>`、`X-Device-Id`。禁止带浏览器 Origin。每设备仅一条有效连接；新连接使旧连接失效，旧客户端停止争抢连接。
- 云端发 `http` 帧：`{type,id,requestId,method,path,body}`；电脑回 `{type:'response',id,status,body}`。传递的是本机严格白名单接口；不转发浏览器 Authorization、cookie 或任意请求头。
- 电脑每次连接首先发送 `agent.status` 帧，明确当前 bridge 是否为 `real`，恢复模式状态不依赖旧事件重播。本机 HTTP 请求使用 Node 原生 HTTP 直连 loopback，不经过系统或环境代理。
- 手机连接 `WSS /devices/:id/ws`，必须有登录 cookie 与匹配 Origin。原生事件增加 `_relay:{epoch,seq}`；可选 query `epoch=...&since=...` 补发有界内存缓存，缓存不足时发送 `backend.degraded`，reason 前缀 `relay.snapshot-required:`。
- 前端在每次 WS 重连后重新获取会话、消息、运行和待审批快照。设备/bridge 断开先发送 `backend.degraded`，再以 `1012` 关闭手机 WS；手机自行重连。不得仅凭旧 WS 状态继续显示在线。
- 心跳 15 秒；设备网络异常按指数退避重连至最多约 30 秒。云端不保存离线命令。手机离线、退出或关闭页面不会向 Codex 发送中断。
- 云端待处理请求上限 200。电脑只读 GET 并发 4，其余最多 64 条在当前连接内等待，等待超过 10 秒返回 `504 / timeout`；设备断线或本机 bridge 断线取消等待请求，重连不补发。写操作独立并发 2，不进队列，避免启动查询挤占发送能力。HTTP 写入正文上限 4 MiB，bridge 响应上限 32 MiB；WS 帧/发送缓冲上限 64 MiB + 64 KiB，用于容纳响应 JSON 二次转义和协议封装，不无限缓存。只读历史响应超限明确返回 `413`、`state: too_large`，不会误报设备离线；写操作响应超限仍按执行结果未知处理。更长历史后续需要分页。
- 客户端每次执行写操作前持久化 `unknown` 标记；完成后保存回执。相同 ID 并发或重连重试复用回执。超时、HTTP 5xx、进程崩溃、结果保存失败可能使结果未知，此时禁止自动重跑，要求人工核对。
- 这是防重复执行策略，不是跨进程 exactly-once。若删除/迁移回执文件、换设备 ID 或将同一操作换成新 ID，无法阻止重复执行。收到 HTTP 4xx 会保存为终结回执；修正参数时使用新 ID。
- 回执仅落在执行电脑，可能包含会话响应内容；云端磁盘只有设备元数据和 token hash，聊天事件仅在有界内存中保留。云端日志不记录正文、token、cookie 或管理密码。
- 回执不自动过期；最多 10,000 条、单状态文件 64 MiB，达到容量拒绝新操作。归档前必须确认没有未决操作；归档后旧 ID 的去重保证失效。

读取仍最多并发 4 条；普通读取最多占 3 条，项目/会话目录扫描最多占 2 条，为当前会话、运行状态和健康检查留出空间。队列优先派发运行状态和健康检查，再派发当前会话读取；相同过滤条件的上游并发目录扫描共享分页请求，完成或失败后即释放，不缓存旧目录结果。

## 存储和验证

使用受控原子 JSON 代替 SQLite：当前设备/绑定元数据很少，单进程写入，临时文件 + fsync + 原子 rename，并用进程锁阻止双写。损坏数据失败退出，不清空回退；不支持集群、多进程共享写和跨文件事务。迁移到多用户/多实例时应换成数据库。

`npm run check` 检查语法；`npm test` 使用两个可控 fake bridge 做协议测试，含 15,331,058 字节历史响应的 SHA-256 完整性校验、写入超过 4 MiB 返回 413、响应超过 32 MiB 返回 413。测试不调用真实 Codex，不代表 Windows/Mac Codex 兼容性已通过；真实 Windows 历史、续聊、新建、审批和中断由项目验收单独验证。

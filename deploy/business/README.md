# ECS 业务服务验证部署

> 最新：已授权专用项目的 ECS/APK 队列接入通过，见 [部署与验收记录](../../docs/ECS_APK_OWNER_QUEUE_VALIDATION.md)；其他项目与 native 写入继续关闭，桌面仍需显式开启领取窗口。下文保留原阶段边界。

> 2026-10-15：真实执行器目前停用，受控启动入口会拒绝运行。共享桌面 Codex profile 的旧配置不再允许；隔离验收完成前不要按下方历史命令启动。详见仓库 `docs/CODEX_RUNTIME_ISOLATION_AUDIT.md`。

本目录只部署 `business/`，不部署旧 `control/`、不部署 Codex 或电脑 bridge。业务服务自身处理 HTTPS，不需要流量代理、隧道或端口映射。Mac 使用 `scripts/start-business-remote-agent.mjs` 主动连接服务。

当前目标与实测记录见 `docs/ECS_BUSINESS_VALIDATION.md`。测试 IP、实例和证书属于本项目事实，不写入全局 Skill。

## 服务布局

- Node 22.22.3：`/opt/rmtagt-node/current/bin/node`，从官方发行包下载并核对 SHA-256。
- 应用：`/opt/rmtagt-business/releases/<timestamp>`，`current` 指向已验证版本。
- 配置/证书：`/etc/rmtagt-business`；admin.json 和 service.env 为 root 0600，服务器私钥 root:rmtagt-business 0640。
- 业务元数据：`/var/lib/rmtagt-business/server.json`，服务账户 0600。
- systemd：`rmtagt-business.service`；专用无登录用户 `rmtagt-business`，仅授权绑定低端口，代码只读、只允许状态目录写入，禁用进程 core 和服务 swap。
- 网络：业务 HTTPS 443；没有新增 SSH、数据库或电脑服务端口。

## 打包与验证

先执行 `npm --prefix business run build` 和 `npm --prefix business test`。

macOS 打包时使用 `COPYFILE_DISABLE=1 tar --no-xattrs`，打包内容仅为 business 的 src/web/dist/test/scripts/package.json 及本服务单元。排除 `.runtime`、凭据、私钥、聊天和 AppleDouble `._*` 文件。上传后校验整包 SHA-256，再运行远端构建和测试，成功后切换 release 并启动服务。

Workbench 每次 exec 为独立 shell，上传操作串行执行。安装依赖使用固定路径，不覆盖系统 node，不修改现有 RAM 权限、安全组或其他服务。需要开放 HTTPS 时先核对实际安全组规则，禁止扩大至任意端口。

## IP 测试证书与本机执行器

本轮按用户选择使用专用测试 CA：服务器生成私钥和 CSR，本机 CA 签发 IP SAN 证书，再把公开的证书上传。CA 私钥保留本机，手机不安装全局 CA；只在 debug 资源中为指定公网 IP 配置信任，仍正常校验 hostname。浏览器默认不信任该测试 CA。

本机保护目录 `.runtime/business-ecs` 保存 local.json、agent.json 和测试 CA，全部被 Git 忽略。启动执行器：

```sh
NODE_EXTRA_CA_CERTS="$PWD/.runtime/business-ecs/tls/ca.pem" node scripts/start-business-remote-agent.mjs
```

首次启动会登录并生成一次性设备配对，后续复用独立设备凭据。远程执行器只读加载 Codex 全部本地项目，并保留隔离验证入口；所有轮次仍为 read-only。项目置顶只保存在 App 本地，见 [项目验证](../../docs/PROJECT_CATALOG_VALIDATION.md)。

验证：

```sh
NODE_EXTRA_CA_CERTS="$PWD/.runtime/business-ecs/tls/ca.pem" RMT_BUSINESS_TEST_RUNTIME=.runtime/business-ecs node scripts/verify-business-local.mjs
NODE_EXTRA_CA_CERTS="$PWD/.runtime/business-ecs/tls/ca.pem" RMT_BUSINESS_TEST_RUNTIME=.runtime/business-ecs node scripts/verify-business-advanced.mjs
```

服务端正文不下载到本机做检查：通过 Workbench 在服务器运行脱敏探针，只返回检测布尔值与元数据计数。

本配置用于用户授权的实际云服务器验证。IP 测试证书、单管理员和只读权限均不能替代正式域名证书、完整权限产品设计或服务商对真实用途的确认。

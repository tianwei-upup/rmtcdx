# 阿里云 ECS 远程连接指南（Workbench CLI）

记录日期：2026-10-15。

## 连接方式

在本机安装 Workbench CLI，配置阿里云 API 凭证后，通过实例 ID 和地域执行远程命令。Workbench 支持连接无公网 IP 的 ECS；浏览器控制台登录态不能代替 CLI 凭证。

官方文档：<https://skills.aliyun.com/skills/alibabacloud-workbench-cli>。

## 1. 安装 CLI

官方安装命令：

```bash
curl -fsSL https://workbench-cli.oss-cn-hangzhou.aliyuncs.com/install.sh | bash
workbench version
```

默认安装目录为 `/usr/local/bin`。本次为避免使用 sudo，下载并查看安装脚本后，指定用户目录安装：

```bash
curl -fsSL https://workbench-cli.oss-cn-hangzhou.aliyuncs.com/install.sh \
  -o /tmp/aliyun-workbench-install.sh
bash /tmp/aliyun-workbench-install.sh --dir "$HOME/.local/bin"
"$HOME/.local/bin/workbench" version
```

本次安装版本为 `v1.0.4`（macOS arm64），安装脚本的 SHA-256 校验通过。

若提示 `command not found: workbench`，可直接使用完整路径，或将以下内容加入 `~/.zshrc`，再重新打开终端：

```bash
export PATH="$HOME/.local/bin:$PATH"
```

## 2. 配置认证

在本机终端执行：

```bash
workbench config
```

本次选择 `1. AK (AccessKey)`，依次输入：

1. RAM 用户的 AccessKey ID。
2. AccessKey Secret。
3. 语言：直接回车，默认中文。

推荐使用具备所需权限的 RAM 用户凭证，避免使用主账号 AccessKey。已有临时 STS 凭证时，可选择 `2. StsToken`；权限要求参见官方文档的 RAM Permissions 部分。

配置保存位置为 `~/.workbench/config.json`，权限应为 `600`：

```bash
chmod 600 ~/.workbench/config.json
workbench config list
```

密钥只在本机终端输入，不发送到聊天，不写入本文档，不提交到 Git。排查时不要直接输出整个配置文件。

## 3. 确认实例

在 ECS 控制台记录实例 ID、地域和运行状态，也可以通过 CLI 查询指定地域的实例：

```bash
workbench list ecs --region cn-beijing --output json
```

本次连接目标：

| 项目 | 值 |
| --- | --- |
| 实例 ID | `i-2zefnzrsukslova9192y` |
| 地域 | `cn-beijing`（华北2，北京） |
| 控制台状态 | 运行中 |
| 实测系统 | Ubuntu 22.04.5 LTS |
| 实测登录用户 | `root` |
| 实测内核 | Linux 5.15.0-191-generic |

连接其他实例时，替换命令中的实例 ID 和地域。不要仅根据 IP 或主机名判断连接目标。

## 4. 验证远程命令执行

先执行只读命令，确认主机身份和运行状态：

```bash
workbench exec \
  --instance-id i-2zefnzrsukslova9192y \
  --region cn-beijing \
  --command 'whoami && hostname && uname -sr && cat /etc/os-release && uptime' \
  --output json
```

本次验证于 2026-10-15 15:32（北京时间）成功，返回 `exit_code: 0`、空 `stderr`，主机名为 `iZ2zefnzrsukslova9192yZ`。仅执行只读命令，未修改服务器配置。

注意：每次 `exec` 使用独立 shell，上一次的 `cd`、`export` 不会保留。有关联的操作应写在同一个 `--command` 中。

## 5. 交互式连接

需要在终端中交互操作时，可使用：

```bash
workbench connect \
  --instance-id i-2zefnzrsukslova9192y \
  --region cn-beijing
```

本次已验证的是 `exec` 远程命令执行；交互式 `connect` 未实际验证。当前安装版本提供该命令，可通过 `workbench connect --help` 查看参数。

## 常见问题

| 现象 | 排查方式 |
| --- | --- |
| `config file not found`，退出码 `4` | 先执行 `workbench config`，确认使用当前本机用户保存配置 |
| 浏览器已登录，CLI 仍无法认证 | CLI 需要独立配置凭证，不能直接复用浏览器登录态 |
| AccessKey 认证失败 | 检查凭证是否有效、是否填写完整；STS 模式还需检查过期时间 |
| RAM 权限不足 | 按官方文档核对当前用户或角色的权限与资源范围 |
| 找不到实例 | 核对实例 ID、地域及凭证所属账号 |
| 网络超时或 WebSocket 错误 | 检查本机到阿里云服务端点的网络连通性，以及实例和云助手状态 |
| 配置文件权限不安全 | 执行 `chmod 600 ~/.workbench/config.json` |

本次首次连接失败的原因是凭证文件不存在；完成 `workbench config` 后，同一实例的只读命令执行成功。

## 汇报话术

已完成 Workbench CLI 安装与认证配置，成功连接北京 ECS，并通过只读远程命令验证主机身份、操作系统和运行状态。当前已具备远程命令执行能力，可用于后续部署与运维；本次未修改服务器配置。

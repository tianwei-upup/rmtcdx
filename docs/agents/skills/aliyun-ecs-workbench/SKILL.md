---
name: aliyun-ecs-workbench
description: 使用阿里云 Workbench CLI 安装或配置本机认证、连接指定 ECS、执行只读连接验证和排查认证或网络故障。适用于用户要求连接阿里云 ECS、配置 workbench 或复用现有 ECS 连接的场景。
---

# 阿里云 ECS Workbench 连接

完成用户指定 ECS 的连接，并用实际远程输出证明结果。使用本机 Workbench CLI；不将连接请求扩展为部署、重启、开放端口或创建 RAM 权限。

## 确认目标与本机状态

- 优先使用本轮用户提供的实例 ID、地域和 profile。用户指向“之前连接的 ECS”时，读取 [已验证实例记录](references/verified-instance.md)，将其作为候选并核对当前返回信息；存在多个候选且无法确定时询问用户。
- 检查 `command -v workbench`；找不到时检查 `$HOME/.local/bin/workbench`。先运行 `version`，遇到参数差异以已安装版本的 `--help` 为准。
- 使用 `config list` 检查 profile。不要输出完整配置文件、AccessKey、Secret 或 STS Token；浏览器已登录控制台不代表 CLI 已配置认证。

## 安装（仅缺失时）

官方文档：<https://skills.aliyun.com/skills/alibabacloud-workbench-cli>。

在 macOS/Linux 上可下载并查看官方安装脚本，再安装到用户目录：

```bash
curl -fsSL https://workbench-cli.oss-cn-hangzhou.aliyuncs.com/install.sh \
  -o /tmp/aliyun-workbench-install.sh
bash /tmp/aliyun-workbench-install.sh --dir "$HOME/.local/bin"
"$HOME/.local/bin/workbench" version
```

确认安装脚本报告校验通过。校验失败时停止安装并报告，不跳过校验。使用完整路径即可继续，不为解决 PATH 自动重复追加 shell 配置；用户需要时再添加 `$HOME/.local/bin`。

## 配置认证

复用已有有效 profile，不覆盖其他配置。缺少凭证时，请用户在本机终端执行 `workbench config` 并自行输入凭证，无需把密钥发到聊天。

- 已有 RAM AccessKey：选择 `AK`。
- 已有临时凭证：选择 `StsToken`，需同时填写 Token。
- 已有其他凭证来源：按当前 `config --help` 选择；不要仅为连接任务创建新角色或扩大权限。
- 配置文件位于 `~/.workbench/config.json`，权限应为 `600`。修正权限可使用 `chmod 600 ~/.workbench/config.json`。

菜单编号可能变化，以当前菜单名称为准。用户完成配置后继续验证，不要求其透露密钥。

需要 RAM 权限细节时查阅官方文档的 RAM Permissions；不要凭记忆授予管理员权限或自动修改策略。

## 查找实例与验证

已知地域但缺少实例 ID 时，可查询该地域列表，并根据用户提供的名称等信息确定目标：

```bash
workbench list ecs --region <region-id> --output json
```

未知地域时，从用户指定的 ECS 控制台页面或用户信息确认，不逐个扫描所有地域。

用确定的实例 ID、地域和必要的 `--profile` 执行只读探针：

```bash
workbench exec \
  --instance-id <instance-id> \
  --region <region-id> \
  --command 'whoami && hostname && uname -sr && cat /etc/os-release && uptime' \
  --output json
```

检查进程退出状态、响应的 `exit_code`、`stderr` 和主机信息。只有远程命令成功并返回目标主机信息，才报告连接验证成功；本机安装成功或凭证保存成功不能代替连接验证。

每次 `exec` 是独立 shell，`cd`、`export` 不会跨调用保留；关联命令放在同一次 `--command` 中。

用户需要交互式终端时，先检查 `connect --help`，再在支持交互的终端运行：

```bash
workbench connect --instance-id <instance-id> --region <region-id>
```

不要把 `exec` 成功表述为交互式终端已验证。

## 故障处理与停止条件

| 现象 | 处理 |
| --- | --- |
| 配置文件不存在 | 引导本机 `workbench config`，等待用户填写凭证 |
| 认证失败或 STS 过期 | 检查所选 profile、凭证来源和有效性；不打印密钥，不重复重试无效凭证 |
| RAM 权限不足 | 报告实际缺失 action/resource，按官方文档提出所需权限，不自动扩权 |
| 实例不存在 | 核对实例 ID、地域、profile 所属账号 |
| 超时或 WebSocket 失败 | 检查本机到阿里云端点连通性、实例状态与云助手；保留脱敏错误，不直接开放公网或关闭安全保护 |
| 配置权限不安全 | 将配置文件权限修正为 `600` 后重试 |

有明确可修复原因时做针对性修复并复测；缺少凭证、目标信息或权限时，报告具体阻塞及用户需要完成的一步。不要无限重试，不关闭其他用户正在使用的会话或 daemon。

## 结果汇报

简要给出实例、地域、实测用户/系统、验证结果及是否修改服务器。对密钥与 Token 脱敏。已验证事实与历史记录分开表达；需要用户接续时给出具体操作。

# 已验证实例记录

仅在用户指向本次购买或之前连接的 ECS 时使用。历史记录不是当前状态，也不授权在该实例部署或修改配置。

| 项目 | 历史实测值 |
| --- | --- |
| 验证时间 | 2026-10-15 15:32，北京时间 |
| 实例 ID | `i-2zefnzrsukslova9192y` |
| 地域 | `cn-beijing` |
| 主机名 | `iZ2zefnzrsukslova9192yZ` |
| 用户 | `root` |
| 系统 | Ubuntu 22.04.5 LTS |
| 内核 | Linux 5.15.0-191-generic |
| CLI | v1.0.4，macOS arm64 |
| 本机安装路径 | `/Users/liutianwei/.local/bin/workbench` |
| 使用的 profile | `default`，AK 模式；不含密钥 |

本次先因缺少 `~/.workbench/config.json` 返回认证错误（退出码 4）；用户在本机完成 `workbench config` 后，`exec` 只读探针返回 `exit_code: 0`、空 `stderr`。未修改服务器配置。交互式 `connect` 未实测。

当时没有 `~/.aliyun/config.json` 和 `~/.alibabacloud/credentials`；后续应重新检查，不据此断言当前仍不存在。

原始整理文档位于 `/Users/liutianwei/Projects/util/rmtcdx/docs/ALIYUN_ECS_CONNECTION.md`，仅供追溯；本 Skill 不依赖该仓库文档即可使用。

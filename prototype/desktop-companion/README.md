# 桌面伴随 MCP 原型

同一 Mac 账户内，通过已有桌面 owner 操作原 session，不启动第二个 Codex/app-server。当前仅授权专用测试会话。最新结果见 [MCP 恢复与并发验收](../../docs/DESKTOP_COMPANION_MCP.md)，早期 ECS/APK 纵向验证见 [第一阶段记录](../../docs/DESKTOP_COMPANION_ACCEPTANCE.md)。

当前可落地的消息入口为 [桌面主动领取 Inbox](../../docs/DESKTOP_OWNER_PULL.md)：本机原子入队，专用聊天通过 MCP 顺序领取并完成，多条任务可共享同一 turn；本机三条真实任务已通过。业务 worker 仍停止、默认只读。

持续领取、取消恢复与业务协议 v2 已通过[专用本机验收](../../docs/DESKTOP_OWNER_CONSUMER.md)。先 open 有限窗口，再带 sessionId 领取；empty 可继续等待，stopped 结束。排队取消立即生效，处理中协作取消；unknown 只允许本机显式核对，不重放。原型 43/43，business 51/51。

## 组件

- `src/mcp-server.mjs`：标准 SDK stdio 服务、本机 0600 控制 socket、父进程/stdio 生命周期清理。
- `src/proxy.mjs`：已有唯一 owner 时作为 MCP frontend 接入；不新增 native 写者，frontend 关闭不停止 owner。
- `src/inbox.mjs`：本项目私有 SQLite 队列；事务追加、意图去重、单处理中租约、绑定消费 turn、unknown 不重放；不访问桌面数据库。
- `src/consumer.mjs`：绑定真实 turn 的消费窗口、长轮询、停止与期限/任务数限制。
- `src/inbox-business-adapter.mjs`：仅显式 loopback 测试启用的队列协议；默认不注册写入，断线后重新核对身份，不调用 native start/steer。
- `src/mcp.mjs`：原五项工具及 Inbox 的 open、take、checkpoint、complete、ack_cancel、close，共 11 项；校验真实调用方 metadata，Inbox 额外要求实际 turn ID。没有任意 RPC、shell 或项目授权透传。
- `src/service.mjs`：按会话的整轮锁、持久化意图回执、重连退避、终态恢复；未知写入不重发、不自动解除锁。
- `src/state.mjs`：私有状态权限、原子 fsync 写入、唯一 owner 与残留 owner 恢复。
- `src/app-tools.mjs`：桌面 native pipe 客户端，长度分帧、请求关联、超时不重发。
- `src/business-adapter.mjs`：默认只读，仅投影授权测试会话；隔离协议测试显式启用写入时，使用服务回执中的 turn ID；支持原生摘要分页。
- `src/acceptance-host.mjs`：历史专用测试 MCP 客户端，目前已停止；正式 MCP 已由桌面直接托管。
- 旧 `companion.mjs` CLI 已停用，避免继续使用仅锁发送 ACK 的实现。`start-detached.mjs` 仅保留历史负向实验入口，不能用于启动当前服务。

## 配置与生命周期

使用随桌面安装的签名 Node 作为 MCP `command`，`args` 为 `mcp-server.mjs` 的绝对路径与本机私有 `scope.json`。只转发 `CODEX_APP_TOOLS_PIPE_PATH`，不要把它的旧值写进持久化配置。scope 绑定实际专用控制聊天 ID、允许的测试 ID、精确 cwd 与 runtime；只接受 `mode=test`。

项目级 `.codex/config.toml` 仅放专用控制工程，不写全局 MCP 条目。桌面重新加载配置是否成功，必须通过真实工具调用验证，不能以配置文件存在代替。

专用控制工程已由用户添加为“专用测试项目”。仅对空闲专用控制聊天执行归档/恢复后，桌面实际加载 MCP；归属新项目后再次调用 `companion_status` 通过。没有重启桌面或共享 app-server。此方法仅验证本测试聊天，不应批量应用到其他聊天。

第一个 MCP 进程持有唯一 owner 锁；同 scope 的其他 frontend 复用私有控制 socket，不新增 native 写者。scope 不匹配则拒绝启动，frontend 退出不停止 owner。桌面当前直接托管 owner，历史测试客户端已退出；整个桌面重启仍安排在用户活跃任务结束后验证。

恢复时，新 MCP 进程只使用宿主新注入的 native pipe。已确认的运行中 turn 继续观察至终态；断线时未确认的 send 保持 unknown，不自动恢复写入。未知结果需核对后另行处理，当前没有自动清锁命令。

## 验证

```sh
npm --prefix prototype/desktop-companion test
npm --prefix prototype/desktop-companion run build
npm --prefix business run build
node scripts/verify-desktop-companion-mcp.mjs
node scripts/verify-desktop-owner-pull.mjs report
```

`verify-desktop-companion-mcp.mjs` 要求专用测试 MCP 已运行，意图 ID 固定并持久化，重跑不会以新 ID 重复发送。它验证 MCP 服务重启，不是整个桌面重启。

上述脚本是历史 native 隔离发送/服务重启验收；Inbox `report` 仅核对已完成任务，不自动启动聊天。消费端未在领取时，新任务保留队列，不自动唤醒桌面；没有 send-now 兜底。

本机控制接口支持 `status`、`snapshot`、`receipt`、`send`、`reconnect`、`stop`，不对公网监听。远程业务 worker 的入口仍为 `scripts/start-desktop-companion-agent.mjs`，只允许专用测试设备与测试会话；本阶段默认停止，完成桌面重启及原子接纳验证前不逐项目开放。

业务适配器默认仅注册 `projects.sync`、`sessions.sync`、`conversation.snapshot`，直接调用 `turn.start` 也会在任何 native 操作前拒绝。`allowNonAtomicTestSends` 只供隔离协议测试，worker 启动脚本没有开启入口。

## 已知边界

桌面发送使用 `send-now` follow-up/steer，原生工具没有原子的 idle-only 参数。本地整轮锁能排除伴随服务内的重复发送，但不能原子阻止桌面用户在检查空闲后立刻输入。owner IPC 的队列整体替换同样不具备原子追加保证。调查、所需接口合同与验收条件见 [原子接纳缺口](../../docs/DESKTOP_OWNER_ADMISSION.md)。生产门槛保持关闭。

摘要分页已接通；不等于完整原始 transcript。超长单页超过业务消息上限会拒绝，不能静默截断后宣称完整。暂不支持附件、审批、远程新建或中断。

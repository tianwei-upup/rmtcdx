# 附加型执行器接入：transport 实现记录

更新：2026-10-15 20:00。仓库 `/Users/liutianwei/Projects/util/rmtcdx`，分支 `codex/remote-control-cloud`。

本文记录「让 rmtcdx 连上桌面已有 app-server」这一步的**实现**结果与验证边界。目标仍然是
[接入研究](DESKTOP_EXECUTOR_ATTACH_RESEARCH.md) 与 [README 原会话接续](APK_SESSION_CONTINUATION.md)
描述的那个目标：APK 与桌面共用同一个 app-server，接续原 thread ID，不启动第二个写桌面 profile 的执行器。

## 本轮做了什么

之前 `attach-adapter.mjs` 只是「验证传输、但不连」的空壳，`getState()` 永远
`attach_not_implemented`。本轮补齐了它缺的那一块：**一个能真正连上 app-server 的客户端**。

关键决定是**不复制协议层**。上游 `real-client.ts`（1182 行）与事件解析器
`parsers/bridge-events.ts`（673 行）承载了请求记账、事件投影、审批归属、分页游标等全部语义。
在业务侧重写一份会得到两份会漂移的实现，且那份新的从未被上游 fixture 测试覆盖。
因此改为在上游抽出 **transport 接缝**，让 stdio 与 attach 共用同一个客户端。

## 上游改动（`patches/remote-control.patch`，26 个文件可逐字节重放）

| 文件 | 作用 |
|---|---|
| `src/codex/transport.ts` | **新增**。`CodexTransport` 接口；`StdioTransport`（原 spawn 行为，逐字保留）；`WebSocketTransport`（attach-only） |
| `src/codex/websocket-client.ts` | **新增**。基于 `node:net` 的最小 RFC 6455 客户端，用于拨 Unix socket。避免把 `ws` 提成运行时依赖 |
| `src/codex/real-client.ts` | 改。`child: ChildProcess` → `transport: CodexTransport`；新增可选第 4 个构造参数；attach 模式不自动重启 |
| `src/business-attach.ts` | **新增**。`createAttachClient()` 工厂 |
| `src/business-runtime.ts` | 改。导出 attach 入口 |
| `test/codex-compat/attach-transport.test.ts` | **新增**。6 项离线协议测试 |

`StdioTransport` 的行为与改动前逐条对应，因此既有 stdio 路径不受影响：上游测试
**77/77 通过**（原 71 + 新增 6）。

### 为什么不用 `ws`

`node_modules/ws` 只是 `@fastify/websocket` 的传递依赖，并非直接依赖，且不携带类型。
为一个 attach 通道提升依赖不值得，因此用 `node:net` + 少量帧编解码实现，并配套测试。

### 为什么不用薄桥

上一轮的 `PHASE_B_PLAN.md` 曾提议「stdio-to-WS 薄桥」。该方案**无法成立**：桌面
app-server 的 stdin/stdout 由 Electron 主进程独占持有，外部无法接第二个读者；照此实现
只会 spawn 一个新的 `codex app-server`，那就是第二个共享 profile writer，与本项目
[运行隔离审计](CODEX_RUNTIME_ISOLATION_AUDIT.md) 冲突。该文档已加废弃横幅。

## 业务层改动

| 文件 | 作用 |
|---|---|
| `src/attach-client.mjs` | **新增**。把已校验的 endpoint 绑到上游客户端；单独成文件是为了不破坏 `attach-adapter.mjs` 的反回归断言 |
| `src/attach-adapter.mjs` | 改。新增可选 `createClient` 注入；不注入时仍是 `validated_only` 空壳 |
| `src/agent.mjs` | 改。调度优先级 `config.adapter` → `config.transport` → native；attach 模式不再要求隔离 HOME |
| `src/codex-adapter.mjs` | 改。归档会话可见；item 投影扩展 |
| `src/contracts.mjs` | 改。消息新增可选 `kind`（显式 required 列表，保持旧载荷兼容） |

### 失败关闭语义

- endpoint 不可用 → `start()` 抛错，不回落 `nativeAdapter`，不 spawn 执行器
- 执行器消失 → 上报 `backend.degraded`，`restarts` 保持 0，**不自动重连**
- `assertNativeExecutionAllowed()` 仍然硬拒所有会创建 Codex 进程的路径

## 历史读取的三层改进

1. **归档会话可见**：`catalogThreads()` 同时读 active 与 archived。此前 9 个归档会话在目录里完全不可见，但 `resumeArchivedThread` 又能读它们。
2. **对话保真度**：`projectItem()` 现在投影 `commandExecution` / `fileChange` / `mcpToolCall` / `webSearch` / `reasoning` / `plan` / `imageGeneration`，并带 `kind` 标签。此前只有 `agentMessage` 与 `userMessage`，命令与补丁全部丢失。
3. **本机路径不外泄**：`imageView` 只产出空（其载荷是本机路径）；测试断言 `/Users/.../screenshot.png` 不出现在投影里。

## 验证

| 范围 | 结果 |
|---|---|
| 上游测试 | **77/77 PASS**（71 原有 + 6 新增） |
| 上游 typecheck / lint / build | PASS |
| 业务测试 | **49/49 PASS**（44 原有 + 5 新增） |
| 补丁可重放性 | `scripts/verify-upstream-patch.mjs` → 26 文件逐字节一致 |
| 离线 attach 协议 | 真实 Unix socket + RFC 6455 + JSON-RPC，`initialize` / `thread/list` / `thread/read` 全通 |
| 业务集成 | `attachAdapter` + 真实客户端 + 模拟 app-server：`projects.sync` / `directory.sync` / `conversation.snapshot` 全通 |
| 失败关闭 | 缺 endpoint 时 `socket_missing`；执行器消失后 `restarts === 0` |

`attach-transport.test.ts` 与 `attach-integration.test.mjs` 都是**离线**的：自建 Unix socket
上的 JSON-RPC server double，不使用真实 Codex、不连桌面、不做模型推理。

### 仍未验证（不计 PASS）

- **真实桌面**：`endpoint.reason` 仍为 `socket_missing`，桌面执行器未开 listen。本轮的客户端从未连过真实桌面。
- **共享 daemon 分支**：仍受 `STAGE_1_COMPAT_REPORT.md` 的结论约束——需要维护窗口改桌面启动参数，`assertNativeExecutionAllowed()` 不解除。
- **APK 端到端**：阶段 C，前置为真实桌面可用。

## 下一步

1. **可丢弃桌面**（方案 A 新建 `codextest` 用户 / 方案 D VM）——需要用户一次管理员操作。
2. 在可丢弃桌面验证 wrapper 能把桌面带入 shared daemon 分支。
3. 用本轮的客户端连上去，跑 [runbook](DESKTOP_EXECUTOR_ATTACH_TEST_RUNBOOK.md) §B 验证表 8 项。
4. 真实桌面维护窗口 + APK `ATTACH_A_` / `ATTACH_B_` 标记验收。

前两步没有用户授权无法推进；本轮把不依赖授权的部分做完了。

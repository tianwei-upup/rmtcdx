# Codex 白屏与 rmtcdx 运行隔离排查

日期：2026-10-15。当前结论：白屏根因未确定；rmtcdx 确实存在不应保留的运行状态耦合，真实执行器已停用，并增加不可通过环境开关绕过的启动拦截。没有修改、清理或重启桌面 Codex。

## 已确认的风险

1. `business/src/codex-adapter.mjs` 原先创建 `RealCodexClient` 时未传独立 HOME。客户端另起 `codex app-server --listen stdio://`，但默认沿用桌面 `~/.codex`。独立子进程不等于独立数据库、配置和会话存储。
2. 上游 `process-env.ts` 在没有独立 HOME 时完整继承父进程环境。当前工具环境含 `CODEX_THREAD_ID`、`CODEX_SESSION_ID`、`CODEX_APP_TOOLS_PIPE_PATH`、`CODEX_INTERNAL_ORIGINATOR_OVERRIDE` 等桌面上下文变量；旧启动链没有剥离这些变量。
3. PATH 所解析的 npm CLI 为 `@openai/codex 0.162.1`；当前桌面运行环境报告 `CODEX_VERSION=0.162.0-alpha.17.2`。两者默认指向相同 profile，存在版本和状态格式耦合。没有证据证明已发生数据库迁移冲突。
4. `sandbox: read-only` 约束模型工具权限，不阻止 app-server 自身维护数据库或会话。原链路的 create/turn.start 会在共享 profile 新建会话，续聊会执行 thread/resume。之前验证仅向隔离测试项目发消息，没有向用户现有会话发送消息；但测试项目隔离不能替代运行目录隔离。
5. 父进程异常退出时，旧执行器没有经过独立生命周期和资源配额验收。新侧栏的周期性目录同步尚未部署，不能作为本次白屏已触发的原因。

## 白屏证据的边界

- macOS 日志显示旧桌面主进程 PID 20612 在 17:41:03 退出，launchd 记录 `(0, 0, 0)`；17:41:06 新进程 PID 98496 启动。该信息没有给出白屏根因，也不足以判断是谁发起重启。
- 重启后的桌面日志存在 shell snapshot 超时、连接重试和 `ResizeObserver loop completed with undelivered notifications`。这些发生在新进程启动后，不能倒推为之前白屏的原因。
- 未找到与白屏对应的 Codex 崩溃栈或可归因于 rmtcdx 的系统终止记录。没有通过重复启动、故障注入或压测桌面应用进行复现，以免干扰用户正常工作。
- 原始只读探针输出保存在被 Git 忽略的 `.runtime/business-ecs/codex-white-system.log`、`codex-white-exit.log`。日志中其他应用的退出记录不作为 Codex 白屏证据。

## 已实施的防护

- `assertNativeExecutionAllowed()` 当前固定拒绝真实执行器启动，错误码 `native_runtime_suspended_pending_isolation`，无环境变量绕过入口。
- `startAgent` 和 `nativeAdapter` 双重拦截，位于状态文件、云端配对、上游客户端导入及子进程创建之前。测试注入的纯内存适配器仍可运行协议测试。
- 业务远程/本地启动脚本、旧 Mac 和 Windows 启动脚本均增加拦截。直接在独立上游 checkout 自行启动不属于这些受控入口，不能据此宣称所有任意命令已被操作系统禁止。
- 独立 profile 的预检组件拒绝桌面目录重叠、错误 CODEX_HOME、桌面 CODEX_* 上下文、符号链接及硬链接共享文件。该组件通过测试不代表已开放真实运行。
- 当前没有 rmtcdx 原生执行器或旧 bridge/control 进程；3210、3220、3230 无监听。未发现 rmtcdx 的 LaunchAgent/LaunchDaemon 自动启动项。保留桌面和 VS Code 自身的 Codex 进程。

## 验证

- 红灯测试先暴露缺失的运行隔离入口，随后新增守卫测试通过。
- `npm --prefix business run build` 通过；业务全部 24 项测试通过，包括启动前拒绝、环境隔离预检、共享符号链接/硬链接拒绝、目录缓存与既有任务协议。
- 实际执行受控远程和旧 Mac 启动入口，均非零退出且未启动 Codex 子进程；不通过启动真实 Codex 验证这一防护。
- Windows 脚本未在 Windows 机器运行，不能报告 Windows 真机验证通过。
- 原始证据：`runtime-isolation-red.log`、`runtime-isolation-green.log`、`runtime-safety-tests.log`、`runtime-block-remote.log`、`runtime-block-legacy.log`，位于 `.runtime/business-ecs/`。

## 恢复前必须完成

真实运行继续保持停用。后续需要共同验收独立运行 HOME/CODEX_HOME、独立登录与状态库、会话目录读取边界、CLI 版本固定、子进程生命周期、内存/CPU 限额和扫描频率。不能把原会话库直接复制后即认为已隔离：库中绝对 rollout 路径仍可能指向原 profile。

目录展示应使用有界的只读元数据快照。不能再让第二个 app-server 直接接管桌面正在使用的原会话；远程续聊的所有权和回传方式必须明确设计。旧的共享 profile 模式不恢复。

统一侧边栏和批量目录同步已有本地实现及测试，但尚未部署，也未做这一版本的真机验证。部署和真实 Codex 回归留待运行隔离问题解决后再继续。所有改动未提交、未推送。

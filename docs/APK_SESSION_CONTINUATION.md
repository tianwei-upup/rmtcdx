# APK 会话接续验收记录

更新：2026-10-15。优先目标仍是接续桌面原会话；用户允许独立副本作为备选，但随后再次强调最好接续已有会话。不能据此把副本默认为等价的桌面续聊。

## 当前确认

- 只读检查当前桌面进程：本地 app-server 未显式指定 `--listen`，其打开的 Unix socket 中没有发现可连接的命名监听路径。没有重启、附加调试或向桌面进程发送 RPC。
- 当前安装包代码中的本地连接和 SSH 启动路径不同；查到 SSH 路径使用 Unix socket，不代表当前本地桌面进程开放相同接口。没有修改安装包。
- 官方 App Server 文档区分 `thread/resume`（已有会话）与 `thread/fork`（新 ID）。独立启动一个 app-server 不能证明接入了桌面原进程。
- 官方远程连接文档描述了官方 Android/iOS 客户端接入桌面、使用原项目和聊天的方式。该文档没有提供本项目自研 APK 接入该远程控制服务的第三方授权协议，不能把官方移动端能力直接当成本项目已具备的接口。

来源：
- https://learn.chatgpt.com/docs/app-server
- https://learn.chatgpt.com/docs/remote-connections

## 独立运行离线实测

`node scripts/probe-isolated-codex.mjs` 是诊断工具，不是恢复业务执行器的开关。

- 使用桌面安装包中的绝对 CLI 路径，记录文件 SHA-256，避免通过 PATH 混用 npm 版本。
- 新建权限 0700 的临时 HOME/CODEX_HOME；不复制配置、认证、数据库或会话，不继承 CODEX_*、代理、Node 注入变量。
- macOS 系统沙箱禁止网络、禁止写入专用临时目录之外的位置、禁止读取桌面 `.codex` 和 Keychains 目录。
- 实际尝试读取已存在的桌面状态文件及写入沙箱外文件，均得到 `Operation not permitted`；沙箱内写入成功。实际监听 loopback 被拒绝为 EPERM。
- 在此限制下，真实 CLI 完成 initialize 和 thread/list，返回空列表，stderr 为 0 字节。未调用登录、thread/resume、thread/start 或 turn/start。
- 超时和退出清理只面向本诊断工具新建的独立进程组，不使用全局进程名终止。

证据在忽略目录 `.runtime/business-ecs/isolated-offline-probe.json`。诊断 profile 保留在该记录中的临时路径，仅供本地检查，不含导入的桌面数据。

这证明离线初始化可隔离运行，不证明联网认证、模型执行、导入上下文、生产资源配额或桌面原会话接续已通过。业务执行器的固定停用守卫保持不变。

## 恢复边界

后续完成了[官方移动端接入核查](OFFICIAL_MOBILE_CONNECTION_RESEARCH.md)：官方采用主机出站 WSS，并将远程客户端请求送入已有 app-server，因此不能从“没有本地命名 socket”推断官方远程接入不可行。第三方 APK 的受支持授权和接入点仍未确认。

优先找可由桌面原进程统一执行的、受支持且有身份和生命周期约束的接口。在接口未确认前，不通过共享 profile、继承工具管道身份或第二个进程 resume 原会话来追求同一个 ID。

独立副本路线需明确来源和截取时刻，保留原会话入口；不得显示为与桌面自动同步。必须先完成有界只读历史导出、独立登录、导入和只读提示词验证。不能只复制数据库、沿用原 rollout 绝对路径或把导入的历史权限设置直接应用到新执行器。

## 本轮其他验证

- 业务 build 成功，24/24 测试通过。
- Android assembleDebug、assembleDebugAndroidTest、lintDebug 成功。
- 统一侧边栏仍未部署或执行新版真机测试。没有恢复本地执行器，没有更换云端静态资源，没有改动桌面登录或设置。

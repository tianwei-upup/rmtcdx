# Domain documentation

使用单一上下文。诊断前读取已有的 `CONTEXT.md` 和相关 `docs/adr/`；不存在时直接继续。
现有旧实现为 Android WebView → 中转 → 电脑 WSS 客户端 → 本机 bridge → Codex app-server，已经停止作为远程方案推进，仅允许 loopback 回归。当前 `business/` 已实现普通业务 HTTPS API → 固定类型任务与业务状态 → 电脑主动领取 → 本机 Codex app-server 适配器，并完成 LAN 与实际 ECS 公网 HTTPS 荣耀验证；见 `docs/adr/001-business-task-architecture.md`。不得通过改名或重新封装继续流量透传，旧 Cloudflare 脚本不参与新方案。
区分页面资源可访问、认证会话有效、API 可交互、Codex 后端可用，不能用单项验证替代完整链路。

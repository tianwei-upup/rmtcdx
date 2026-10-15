# Domain documentation

使用单一上下文。诊断前读取已有的 `CONTEXT.md` 和相关 `docs/adr/`；不存在时直接继续。
当前调用链是 Android WebView → rmtagt 云端登录与设备路由 → 电脑主动 WSS 客户端 → 本机 rmtcdx HTTP API / WebSocket → Codex app-server；旧 Cloudflare 脚本不参与新链路。
区分页面资源可访问、认证会话有效、API 可交互、Codex 后端可用，不能用单项验证替代完整链路。

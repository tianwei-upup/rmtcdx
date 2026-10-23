# 刷新、历史基线与目录确认修复复验

2026-10-22。已部署修复，功能复验部分通过；不把剩余实时性和首次历史加载问题记为通过。

## 实现与验证

- BusinessClient 同时捕获请求与响应体超时，保留未知写入的原意图，不自动重放；CatalogBootstrap 在只读初始化失败后自动重连，401 不自动重试登录。浏览器定时器绑定缺陷已修正并新增回归。
- 配置 JSON 协商 gzip；历史/目录以外的 SSE 不压缩或缓冲。
- ScopedHistoryStream 合并持久历史前缀和原生实时状态，保持自己的单调版本；审批仍走原 owner。新增按原 thread ID、ordinal/byte 边界只读解析 thread_history_1.sqlite 的 history_base，避免遗漏 paginated JSONL 引用的更早历史；缺失/外部基线不冒充完整。
- 精确执行成员确认与展示元数据上传解耦；归档、binding、目录可用性、项目归属变化不确认旧目录。手机仅对明确的入队前 catalog_source_stale 响应、以同一意图自动有界重试；未知写入、权限拒绝和其他操作不重试。
- 新消息定向触发接收，保留周期检查；纯文本 activation v3 避免多余 checkpoint，旧控制消息与回执保持兼容。
- business build、102/102 测试；companion build、112/112 测试；真实只读原生探针确认三个目标聊天文字没有缺失。首次并行完整 companion 回归出现原生并发锁忙，复跑全套 112 项通过，未放宽原子锁。

## 荣耀复验

| 项目 | 原 ID 消息 | 首轮完成时间 | 观察到的首轮中间结果长度 |
| --- | --- | --- | --- |
| dvr-demo | 两轮完成，无重复执行 | 34.4 秒 | [] |
| ecs qq | 两轮完成，无重复执行 | 49.0 秒 | [8, 52] |
| oisUpload | 两轮完成，无重复执行 | 39.2 秒 | [8] |

六条消息各一次 job.enqueued/job.leased/job.completed，结果正确回忆上一轮验证号。各目标最后消费者 closed，无 queued/leased/unknown。消息均仅允许队列必要操作和基于已有上下文的文本回答。

所有目标最终刷新恢复结果与完整历史标记；没有手动开启领取窗口，本轮发送未出现目录过期拒收。该结果不能替代故障注入：源过期自动重试、取消重试、401/归档拒绝由回归验证。

## 未通过项与边界

- dvr-demo 首轮本机有两次 progress，但手机未分辨出中间状态；oisUpload 首轮只分辨一段，ecs qq 首轮两段可见。比旧样本更快不代表实时传输稳定，不承诺秒回或逐 token。
- oisUpload 首次历史加载超过 120 秒未就绪，尚未发送消息；普通刷新后恢复，再完成两轮。该首次失败已保留，不能把它当作无失败通过。
- 桌面进程启动时间在操作过程中已变为 19:21，原因未核实；本任务没有执行桌面重启命令，不声称原 PID 全程不变。ECS 业务服务在确认无 pending/leased/running 任务后更新（72846→73214），个人 worker 在本机队列全空且无 active/stopping 消费者时优雅更新；未主动重启全局 MCP 或原 RN/test worker。
- 页面空白曾由本次 CatalogBootstrap 的浏览器定时器接收者错误引入，已现场修复、增加 Window 接收者回归并重新部署；保留日志。

## 部署与收尾

只替换原 release 中受影响的三个 web/dist 模块及 history-json，逐文件校验旧 SHA、备份、语法检查；服务器专项 9/9。远端保留其原有登录处理，没有部署本地无关登录、Android、thin-bridge 改动。备份位于 `/opt/rmtagt-business/releases/20261022T092641Z-ui-opt/.recovery-fix-backup-20261022`；定时器随后定向热修复，未再重启业务服务。

荣耀已恢复原 rmtcdx 会话、空草稿与登录状态；本轮 ADB forward 已移除。没有发送消息到其他活跃会话；未提交或 push。详细记录在忽略目录 `.runtime/recovery-fix-20261022/`。

后续重点是追踪 progress 从本机发布到 ECS/手机可见的每段时延，以及首次大历史加载的恢复，复验通过前维持上述部分通过结论。

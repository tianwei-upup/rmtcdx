# 安卓 APK 页面 UI 优化方案

2026-10-22。基于对 APK 实际渲染页面的本地复现、DOM 审计与源码核对，产出可落地的分批优化清单。
本文件只记录方案与证据，未实施任何代码改动。

## 1. 结论速览

APK 页面**不是功能缺失型问题，而是"密度、可读性、一致性"问题**。当前页面在 360px 宽手机上存在
3 类硬伤：

| 级别 | 数量 | 性质 | 是否需要重装 APK |
| --- | --- | --- | --- |
| P0 真实缺陷 / 口径不一致 | 4 | 功能或视觉错误 | 2 项需要 |
| P1 触控与可读性 | 4 | 低于移动端基本标准 | 否（纯前端热更新） |
| P2 信息架构 | 6 | 规模放大后暴露 | 否 |

**核心判断**：848 条历史会话 + 47 个项目的真实规模下，当前列表设计（只有标题、无时间、无分组）
是最需要优先解决的瓶颈；字号 10px、触摸目标 34px、遮罩仅 29px 是最容易被手机用户直接感知的
"廉价感"来源。

## 2. 现状

### 2.1 页面结构

APK 是 Java 原生壳 + WebView 加载 ECS 页面（`android/app/src/main/java/com/liutw/codexremote/MainActivity.java:549` 行）。

| 层 | 文件 | 说明 |
| --- | --- | --- |
| 原生壳 | `MainActivity.java` | 双 WebView（Windows/Mac 各一）、原生 ⋮ 菜单、返回键、文件选择、日志导出 |
| 业务页 | `business/web/index.html` | 业务任务模式：项目树 + 会话 + 完整工具详情 + 审批 |
| 队列页 | `business/web/queue.html` | 自用个人模式：APK 实际使用（`server.mjs:180` 按 queueScope 决定） |
| 样式 | `business/web/style.css` (13.5 KB) + `queue.css` (7.1 KB) | 均已压缩为单行规则 |

### 2.2 已完成的两轮优化（不在本方案重复）

- **0.4.1** 项目选择器：`<select>` 改为文件夹图标 + 项目名 + 会话数的卡片，展开为可搜索面板，
  当前项目带选中标记，支持浅深色。见 `docs/APK_SIDEBAR_GESTURE_VALIDATION.md`。
- **0.4.2** 侧栏手势：聊天区右滑展开、侧栏内左滑关闭、系统返回优先关侧栏。

本方案的所有建议都在这两轮成果之上增量修改，不回退既有交互。

## 3. 实测方法（可复现）

在 `.scratch/ui-review/` 用本地 mock 服务 + Playwright 复现线上页面，脚本为
`mock-server.mjs` / `shoot.mjs` / `audit.mjs` / `measure.mjs`（目录已 gitignore）。
模拟环境：UA 带 `CodexRemoteAndroid/0.4.1`（触发 `native-shell` 样式），视口 360×780 与 393×852。

> 说明：以下结论来自**代码与本地渲染的交叉验证**。第 4.3 / 4.4 / 4.5 / 6.2 条为真机相关，
> 已在文中单独标注需荣耀复验，本地结果不能替代真机结论。

## 4. P0：真实缺陷与口径不一致

### 4.1 业务页把归档会话混入列表，且前端无从识别

**现象**：队列页只显示未归档会话，业务页 `index.html` 的项目树里归档会话与普通会话混排，
且没有任何视觉标记。

**证据链**：

- `business/src/codex-adapter.mjs:93-98` `catalogThreads()` 明确把 `archived:true` 的线程合并进目录，
  注释写着"Archived threads are readable but excluded from an ordinary list"。
- `business/src/codex-adapter.mjs:114-116` `conversation()` 返回
  `{ id, projectId, title, status, updatedAt }` —— **没有 `archived` 字段**，前端拿不到标记。
- `business/web/app.js:124-165` `renderCatalog()` 直接渲染 `directory.conversations(project.id)`，
  **没有任何 archived 过滤**。
- 对比 `business/web/queue-app.js` 的 `normalChats = (p?.conversations??[]).filter(c=>!c.archived)`，
  队列页**有**过滤。

**影响**：与 `AGENTS.md` 中"默认列表 / 搜索 / 数量仅显示未归档会话"的口径不一致；两页用户看到
不同的会话集合，且业务页无法区分归档项。

**修改点**：

1. `codex-adapter.mjs` `conversation()` 增加 `archived: Boolean(thread.archived)`。
2. `app.js` `renderCatalog()` 按 `!c.archived` 过滤，并让"显示更多"的分页计数与搜索计数
   同步只统计未归档项。
3. 若产品希望业务页仍可查看归档历史，应做成**显式入口**（如"显示归档"开关），
   而不是默认混排——这与队列页口径一致，也解决 adapter 注释与实现的自相矛盾。

> 备选实现：不改后端字段，前端按 `title` 无法判断，必须改后端。**后端字段是必需项。**

### 4.2 原生菜单按钮在深色模式下是纯白圆

**现象**：`MainActivity.java:94` `circle.setColor(Color.WHITE)` 硬编码白色。浅色主题下勉强成立，
深色主题（页面底色 `#212121`）下，右上角会出现一个刺眼的纯白圆形浮块。

**影响**：深色模式首屏第一眼最突兀的视觉瑕疵；白色块还会遮住网页顶栏右侧内容。

**修改点**：复用已计算的 `background` 变量（`MainActivity.java:74`）替代硬编码 `Color.WHITE`，
并把 `⋮` 文字色在深色下改为 `var(--muted)` 等效色（约 `#aaaaaa`），保证对比度。

**需重装 APK**（原生层）。

### 4.3 网页主题选择与原生状态栏脱节

**现象**：

- `app.js:299-300` `theme()` 允许手动选"跟随系统 / 浅色 / 深色"，写入 `localStorage` 的
  `rmt-theme`。
- `MainActivity.java:72-79` 原生层按**系统**深浅设置状态栏、导航栏和系统栏图标明暗。
- 两者互不知情：用户在网页里选"浅色"而系统处于深色时，**网页白底、状态栏深色**。
- `queue.html` 则根本没有主题选择，只能跟随系统。

**影响**：主题割裂；`queue.html` 与 `index.html` 的主题行为不一致。

**修改点（推荐，零原生改动、不违反"不加 JS 原生桥"约束）**：

- 业务页**移除手动主题选择**，统一为跟随系统（与 `queue.html` 一致）。
  原生壳已经按系统设置状态栏，天然对齐。
- 保留 `theme()` 函数但只保留 `system` 一档，或直接删掉设置项里的"外观"行。
- 后续若确需手动深色，应走"原生读取同一存储"或"URL 参数携带初始主题"的方案，
  **不要**为此新增 JS 原生桥。

**需重装 APK**（若同时把原生菜单按钮改成跟随系统色，见 4.2，可合并到同一版）。

### 4.4 顶栏未处理顶部安全区

**现象**：实测 `.topbar` 的 `padding-top` 为 `6px`，**没有 `env(safe-area-inset-top)`**。
页面 meta 已声明 `viewport-fit=cover`。

**风险**：`android/app/build.gradle:22` 当前 `targetSdk 34`，不触发 Android 15 强制
edge-to-edge；但荣耀/华为等部分 ROM 会自行进入 edge-to-edge 模式，届时顶栏标题会被状态栏遮挡。
升级 targetSdk 35+ 后必然暴露。

**修改点**：

- `.topbar` 改为 `padding-top: calc(6px + env(safe-area-inset-top))`，
  `.app` 的 `grid-template-rows` 首行同步 `calc(62px + env(safe-area-inset-top))`。
- 抽屉 `.drawer-top` 同样需要顶部安全区内边距。
- 纯 CSS 改动，可热更新，无需重装 APK。

## 5. P1：触控与可读性

### 5.1 10–11px 小字号共 7 处

实测（360×780）：

| 元素 | 选择器 | 字号 | 内容 |
| --- | --- | --- | --- |
| `.composer-hint` | `style.css:5` | **10px** | "Codex 可能会出错，请核对重要信息" / "回答与电脑同步" |
| `.connection-state` | `queue.css:3` | **10px**（≤480px） | "历史已同步" / "连接中" |
| `.context-label` | `style.css:5` | 11px | 顶栏项目名 |
| `.composer-context` | `style.css:5` | 11px | "历史已同步 · 消息将排队" |
| `.directory-status` | `style.css:9` | 11px | "目录已更新" |
| `.history-scope` | `queue.css:7` | 11px（≤480px 10px） | "以下是手机接入后的消息与回复" |
| `.project-count` / `.project-list-heading` | `style.css:9` / `queue.css:16` | 11px | 会话数、项目数 |

**修改点**：状态类文字下限提到 **12px**，正文类不低于 12px；`.composer-hint` 与
`.connection-state` 提到 12px。中文在 10px 下笔画糊成一团，这是"廉价感"最直接的来源。

### 5.2 触摸目标小于 44px（6 类）

审计实测（`audit.mjs` 输出）：

| 元素 | 实测尺寸 | 位置 |
| --- | --- | --- |
| `.context-button` | 178×**36** | 队列页**最常用的"切换会话"入口**只有 36px 高 |
| `.message-actions .icon-button` | **34×34** | 复制 / 取消回复 |
| `.text-button`（桌面历史"复制"） | 41×**32** | 每条桌面消息下方 |
| `.jump-bottom` | **38×38** | 回到最新消息 |
| `.icon-button.small` | **32×32** | 关闭提示条 |
| `.project-pin` | **36**×44 | 置顶项目 |
| `.project-sessions .session-row` | 274×**42** | 项目展开后的会话行 |

**修改点**：**保持视觉尺寸不变**，用透明 padding 把可点区域撑到 44×44
（`min-height:44px` + 负 margin，或 `::after` 绝对定位扩展命中区），
避免破坏现有紧凑排版。`.context-button` 优先级最高——它是队列页的主入口。

### 5.3 桌面历史的"复制"文字按钮裸露且与队列页语言不一致

**现象**（见截图 `q01/q02`）：桌面历史每条消息下方都有一行灰色文字"复制"，占据独立一行；
而队列页自己的消息用的是图标按钮。两种视觉语言混在同一屏。
且 `desktop-history.mjs` 中 `row.actions.hidden = !row.text` —— **流式生成中的消息也会显示"复制"**。

**修改点**：

- `desktop-history.mjs` 的 copy 按钮改用 `icon-button` + `/icons/copy.svg`，与
  `queue-app.js` 的队列消息一致。
- `status === 'running'` 时隐藏复制按钮。
- 复制成功后沿用 `.message-actions [data-copied=true]` 的既有反馈样式。

### 5.4 顶栏无底边框，消息从栏下穿过

**现象**（见截图 `q01`）：首条消息被顶栏裁掉上半截，视觉上像渲染错误，而不是"内容滚过去了"。

**修改点**：`.topbar` 增加 `border-bottom:1px solid var(--line)`；或在 `.chat-scroll` 顶部加
`mask-image` 渐隐。推荐加边框——更省事且在深色下也稳定。

## 6. P2：信息架构（848 会话 / 47 项目规模下暴露）

### 6.1 会话行只有标题，没有时间与状态

后端 `codex-adapter.mjs:115` **已经下发 `updatedAt`**（秒级时间戳），但前端
`app.js` 与 `queue-app.js` **完全没有使用**。

**修改点**：

- 会话行加副标题：`相对时间 · 状态`，例如 "2 小时前 · 12 条消息"或"2 小时前 · 归档"。
- 用 `updatedAt` 对会话列表**降序排序**（当前是目录原序）。
- 队列页 `queue-app.js` 的 `.session-row` 同样处理；`queue.css:7` 已有
  `.session-archived` 样式类，说明原设计就预留了副标题位。

### 6.2 47 个项目平铺，没有"最近"分组

项目面板每行 64px（`queue.css:14` `.project-trigger` / `.project-option`），
47 个项目 = 3008px 纯滚动，没有锚点。

**修改点**：

- 面板顶部加"最近使用"分组（按项目下会话的 `updatedAt` 取最大），最多 3–5 项。
- 其余项目按名称排序，行高从 64px 降到 56px。
- 面板滚动时项目卡片吸顶。

### 6.3 侧栏遮罩只剩 29px

实测：360px 宽下两页侧栏均为 **331px**，遮罩仅 **29px**（`min(92vw,380px)`）。
侧栏内左滑是主要关闭方式，但 29px 的点击关闭区在部分机型上太窄。

**修改点**：`width: min(88vw, 360px)`，保证 360px 屏上遮罩 ≥ 40px；小屏用 86vw。

### 6.4 两页视觉语言不一致

| 项 | `index.html` | `queue.html` |
| --- | --- | --- |
| 复制按钮 | 图标 | 桌面历史用文字"复制" |
| 主题 | 可手动选 | 仅跟随系统 |
| `body` 定位 | `static` | `position:fixed`（`queue.css:9`） |
| `jump-bottom` 定位 | `bottom:165px` 硬编码 | `bottom:var(--composer-offset,150px)` |
| 正文行距 | 1.85 | 1.65 |

**修改点**：抽一份共享基线（新增 `base.css` 或在 `style.css` 统一），
`queue.css` 只保留队列页特有规则；行距统一到 **1.7**（1.85 在中文长回复上每屏信息量偏少，
滚动次数多）。

### 6.5 composer 布局割裂

`index.html` 的 composer 是"textarea 一行 + 下面一行 `+` …大片空白… 发送"，
中间的 `.composer-context` 为空时形成明显断层。

**修改点**：`+` 与发送键作为一组靠右排列，或 textarea 与按钮同行（后者在 Android 上
输入体验更好，但改动面大，建议先做前者）。

### 6.6 `jump-bottom` 位置硬编码

`index.html` 的 `bottom:165px` 写死，composer 变高或键盘弹起时会错位；
`queue.html` 已用 CSS 变量但无回退正确性保障。

**修改点**：统一用 `--composer-offset`，由 JS 在 composer 高度变化时更新（`resizeInput()`
已经存在，顺带更新即可）。

## 7. 落地批次

### 批次 A — 纯 CSS / HTML，零后端改动（可热更新 ECS，**不需重装 APK**）

- 5.1 字号下限 12px（7 处）
- 5.2 触摸目标撑到 44px（7 类，视觉尺寸不变）
- 5.3 复制按钮图标化 + 流式隐藏
- 5.4 顶栏底边框
- 4.4 顶部安全区
- 6.3 侧栏宽度
- 6.4 行距统一 1.7
- 6.5 composer 按钮成组
- 6.6 `jump-bottom` 变量化

### 批次 B — 前后端联动（后端字段是前置项，**不需重装 APK**）

- 4.1 `conversation()` 增加 `archived` + 业务页过滤 + 归档显式入口
- 6.1 会话行副标题（用已有 `updatedAt`）+ 按时间排序
- 6.2 "最近使用"分组 + 吸顶 + 行高压缩

### 批次 C — 原生壳（**需升 APK 0.4.3**）

- 4.2 深色模式菜单按钮改用背景色变量
- 4.3 主题策略统一（业务页移除手动选择，随系统）

## 8. 明确不建议做

- 不新增 JS 原生桥（`AGENTS.md` 约束，且 4.3 有零原生替代方案）。
- 不新增语音、重新生成、会话删除等无业务支撑的入口（`docs/UI_INTERACTION_VALIDATION.md:16` 已有结论）。
- 不改队列写入口与审批语义（属业务边界，非 UI）。
- 不动 0.4.1/0.4.2 已验收的项目选择器与侧栏手势实现。

## 9. 待真机验证（本地结论不可替代）

1. 荣耀真机深色模式下的原生菜单按钮（4.2）。
2. 荣耀/华为 ROM edge-to-edge 下的顶栏安全区（4.4）。
3. 软键盘弹起时 composer 是否被遮挡——`queue.css:9` 的 `body{position:fixed}` 与
   `MainActivity` 的 `adjustResize` 组合在部分 WebView 版本下有已知风险。
   本地合成缩放测试通过（composer 底边 400 = 视口 400，未被遮挡），但**未在真机软键盘下验证**。
4. 侧栏遮罩 29px 收窄到 40px+ 后的点按手感。
5. 批次 A/B 全部改动需在荣耀 393×852 与 360×780 双尺寸、浅深色各复验一次。

---

# 实施记录：2026-10-22

方案已按批次落地。改动分三层，部署方式不同，见 11。

## 10. 实际改动

### 10.1 批次 A —— 纯前端（`business/web/`）

| 项 | 文件 | 改动 |
| --- | --- | --- |
| 字号下限 12px | `style.css` `queue.css` | `.composer-hint` 10→12、`.connection-state` 10/11→12、`.context-label`、`.composer-context`、`.directory-status`、`.history-scope`、`.delivery`、`.project-count`、`.project-list-heading`、`.session-archived` 全部提到 12px；`@media(max-width:480px)` 里的 10px 一并提升 |
| 触摸目标 ≥44px | `style.css` `queue.css` | 视觉尺寸不变，用 `::after` 透明扩展命中区：`.icon-button.small`(-6)、`.message-actions .icon-button`(-5)、`.text-button`(-6/-2)、`.project-pin`(-4/-8/0)、`.jump-bottom`(-3)；`.context-button` 加 `min-height:44px`；`.project-sessions .session-row` 42→44px；`.search-box input` 撑满 44px |
| 复制按钮图标化 | `desktop-history.mjs` | 文字"复制"→ `/icons/copy.svg` 图标，与队列页一致；`status==='running'` 时隐藏 |
| 顶栏分隔 | `style.css` | `.topbar` 增加 `border-bottom:1px solid var(--line)`，消息不再"穿透"顶栏 |
| 顶部安全区 | `style.css` | `.app` 首行与 `.topbar`/`.drawer-top` 计入 `env(safe-area-inset-top)` |
| 侧栏宽度 | `style.css` | `min(92vw,380px)` → `min(88vw,360px)`，360px 屏遮罩 29px→47px |
| 行距 | `style.css` | `.message-content` 1.85 → 1.7 |
| 输入区布局 | `index.html` | `.composer-actions` 顺序改为 context → 附件 → 发送，`+` 与发送键成组靠右（与队列页一致） |
| 跳转按钮定位 | `style.css` `app.js` `queue-app.js` | `bottom:165px` 硬编码 → `var(--composer-offset)`，由 JS 按 composer 实际高度更新 |

### 10.2 批次 B —— 前后端联动

| 项 | 文件 | 改动 |
| --- | --- | --- |
| 归档标记 | `business/src/codex-adapter.mjs` `business/src/contracts.mjs` | `catalogThreads()` 按来源给 thread 打 `archived` 标记；`conversation()` 输出 `archived` 布尔字段；输出契约 `conversation()` 允许该字段 |
| 归档默认隐藏 | `business/web/app.js` `index.html` | 业务页列表、搜索、计数**只统计未归档会话**；抽屉底部新增「显示/隐藏归档会话」开关，归档项带「已归档」标记 |
| 会话行时间 | `business/web/app.js` `chat-state.mjs` | 会话行副标题显示 `相对时间 · 状态`（进行中 / 已归档），并按 `updatedAt` 倒序排列 |
| 项目按活跃度排序 | `business/web/app.js` | 置顶项在前，其余项目按其最新会话 `updatedAt` 倒序，分组名「最近更新」 |
| 最近使用分组 | `business/web/queue-app.js` `queue.css` | 队列页项目面板按端侧 recency（localStorage）分「最近使用」/「全部项目」两组；会话行显示端侧最近访问时间 |

> **未改动的边界**：`business/src/queue-scope.mjs` 的授权契约**没有**放宽。
> 队列页的 scope 对象里没有 `updated_at`（元数据库 `threads` 表无该列），
> 要补真实时间戳需要改发现管道并重启 Mac 端 agent，超出 UI 范围。
> 因此队列页用端侧 recency 代替，不触碰权限模型。

### 10.3 批次 C —— 原生壳（APK 0.4.3）

| 项 | 文件 | 改动 |
| --- | --- | --- |
| 深色模式菜单按钮 | `android/.../MainActivity.java` | `circle.setColor(Color.WHITE)` 硬编码 → 复用主题背景色；`⋮` 文字色深色下改为 `#aaaaaa` |
| 主题一致性 | `business/web/index.html` `app.js` | 业务页**移除手动主题选择**，只跟随系统，与原生状态栏同源；旧 `rmt-theme` 偏好自动清除 |

## 11. 部署方式（按层区分）

| 层 | 改动文件 | 部署方式 |
| --- | --- | --- |
| 静态前端 | `business/web/style.css`、`queue.css`、`index.html`、`app.js`、`queue-app.js`、`chat-state.mjs`、`desktop-history.mjs` | 替换 ECS 上的 `business/dist/` 对应文件即可，**不需重装 APK** |
| 服务端 | `business/src/codex-adapter.mjs`、`contracts.mjs` | `archived` 字段由适配器产出，**需重启 ECS 业务服务**才生效；只替换前端时归档开关会没有数据 |
| 原生壳 | `android/app/src/main/java/.../MainActivity.java` | **需安装 APK 0.4.3**（`versionCode 9`） |

APK：`artifacts/codex-remote-0.4.3-debug.apk`
SHA-256：`90cefbce15430e41167511d6a75179b7ef5155d50f0b6ff35e6f37a75749c31c`

## 12. 验证结果

### 12.1 本地（Playwright 复现线上页面，UA 带 `CodexRemoteAndroid/0.4.1`）

| 检查 | 结果 |
| --- | --- |
| 业务单元测试 | **83/83 PASS**（改动前基线同为 83/83；改 `contracts.mjs` 前一度 8 条失败，已修复） |
| 功能验证（13 项） | **13/13 PASS**：归档默认隐藏 / 开关可见 / 归档标记 / 计数只算未归档 / 相对时间 / 状态标记 / 项目按活跃度排序 / 分组标题 / 按钮成组 / 主题项已移除 |
| 字号审计 | **0 处 < 11px**（改动前 7 处 10–11px） |
| 横向溢出 | **0 处**页面级横向滚动 |
| 真实命中区（`elementFromPoint`） | 复制图标 34×34 → 命中区 **44×44**（四向外扩 5px 实测全部命中）；置顶按钮 36×44 → 命中区 **44×52** |
| 顶栏标题 | 360px 宽下「补充蓝牙未连接恢复步骤」**完整显示**（`scrollWidth == clientWidth`），改前被截断 |
| 键盘弹出合成测试 | composer 底边 400 = 视口 400，未被遮挡（**非真机软键盘**） |
| Android 构建 | `assembleDebug` + `lintDebug` **BUILD SUCCESSFUL** |

### 12.2 仍需真机

见第 9 节。荣耀真机需复验：深色原生按钮、安全区、软键盘遮挡、归档开关与最近分组的实际观感。

---

# 13. 真机复验与追加修复（2026-10-22 晚）

方案落地后装到荣耀 `ACTH022325002169` 复验，发现并修复了 3 个**只有真机才暴露**的问题。

## 13.1 深色模式：原生与网页割裂（根因在应用主题，不在页面）

**现象**：系统切到深色后，原生状态栏、导航栏、⋮ 按钮都变深，**网页却仍是浅色**；
强制停止应用重新启动仍然浅色。网页与原生始终不同源。

**根因**（证据链）：

| 证据 | 结果 |
| --- | --- |
| `adb shell cmd uimode night` | `yes` |
| `dumpsys activity top` 的 `mCurrentConfig` | 含 `night` 标志 → 应用的 Configuration 确实是夜间模式，原生层读到的 `uiMode` 正确 |
| `AndroidManifest.xml` 的 `android:theme` | `@android:style/Theme.Material.Light.NoActionBar` —— **显式浅色主题** |
| 页面 `@media(prefers-color-scheme:dark)` | 从不生效 |

Android WebView 的 `prefers-color-scheme` 由**应用主题**决定，而不是设备的 `uiMode`。
应用用的是显式浅色主题，WebView 因此永远上报 `prefers-color-scheme: light`，
页面的深色分支永远进不去——而原生层读 `uiMode` 读到的却是 `night`，于是两者割裂。

**修复**：不让页面去猜，改由原生层把系统主题**通过 URL 参数**告诉页面。

- `MainActivity.java` 新增 `themedUrl()`，加载页面时追加 `?theme=dark|light`；
  `uiMode` 变化会重建 Activity（`configChanges` 不含 `uiMode`），重建时重新取值。
- 新增 `business/web/theme.js`（同源**同步**脚本，放在 `<head>`，首屏即生效、无白闪）。
  用外部文件而不是内联脚本，是因为服务端 CSP 是 `script-src 'self'`，**内联脚本会被拦截**。
- `server.mjs` 的 302 重定向现在**保留 query**：
  `/devices/mac/?theme=dark` → `/devices/mac-personal/?theme=dark`
  （此前重定向丢弃 query，参数到不了页面）。
- `app.js` 的 `theme()` 与 `queue-app.js` 保持一致；页面内切换电脑时也保留该参数。

**为什么不用"把应用主题改成 DayNight"**：那会改变原生控件在 EMUI 下的外观，
且 API 26–28 需要 fallback，还要赌各厂商 WebView 是否真的跟随。URL 参数是确定性的，
跨 API 与 WebView 版本都成立，也不是 JS 原生桥。

浏览器场景不受影响：无参数时仍按 `prefers-color-scheme` 跟随系统。
已用 6 种组合验证（系统浅/深 × 无参数/dark/light），结果全部正确。

## 13.2 队列页长标题挤压时间标签

`queue.css` 的 `.session-title` 是 `flex:1` 但没有 `min-width:0`，
flex item 的 `min-width:auto` 会让它无法收缩到内容以下，长标题会把端侧时间标签挤出可视区。
已补 `min-width:0`。

## 13.3 发布会话失效

服务重启后 RAM 里的登录会话丢失，手机端出现"登录已过期，请重新登录"。
这是内存态会话的固有行为，重新登录即可恢复（已在本机用保存的凭据恢复，密码未回显）。

## 14. 实际发布记录

| 步骤 | 方式 | 结果 |
| --- | --- | --- |
| 前端热补丁 | 打包 44 个 web/dist 文件 → 上传 → SHA256 校验 → `node --check` → `os.replace` 原子替换 | 成功，**服务 PID 68937 未变**（零重启） |
| 完整发布 | 新 release `20261022T084725Z-ui-opt` → 服务器上 `build.mjs` + **83/83 测试** → 切 symlink → `systemctl restart` | 成功，新 PID **71827** |

完整发布必须带后端改动（`archived` 字段、`/theme.js` 路由、重定向保留 query），因此需要重启。

**发布过程中发现并解决的两个流程问题**：

1. `workbench exec` 有 **30 秒超时**，而 83 项测试在服务器上要跑约 10 秒、
   加上构建与重启会超时。解决办法是**后台执行 + 轮询日志**，
   安装脚本以 `INSTALL_OK` 标记结尾。
2. 发布包原本跑不通两个测试：
   - `attach-integration.test.mjs` 依赖包外的上游 bridge 构建产物
     （`services/rmtcdx/apps/bridge/dist/`），模块找不到会**挂死**（exit 124）。
     服务端运行时只执行 `src/server.mjs`（systemd `ExecStart`），
     上游 bundle 不是服务端运行时依赖，因此把这两个 70 KB 的构建产物一并打进发布包，
     让服务器端测试与本地完全对齐。
   - `existing-executor-discovery.test.mjs` 的 fixture 依赖 **macOS 特有行为**
     （`/tmp` → `/private/tmp` 符号链接），在 Linux 上"父目录是符号链接"的前提不成立。
     已改为**显式创建符号链接父目录**，fixture 不再依赖平台特性，macOS 与 Linux 都能跑。

## 15. 真机复验结果（荣耀 ACTH022325002169）

| 项 | 结果 |
| --- | --- |
| 浅色模式 | 顶栏分隔线、图标化复制、12px 字号、原生 ⋮ 按钮与顶栏同色 |
| 深色模式 | 页面/状态栏/导航栏/⋮ 按钮**全部同源**；深色侧栏、图标反色正常 |
| 软键盘 | 键盘弹起后输入框、状态、发送键、底部提示**全部完整可见**，消息区自动收窄，未被遮挡 |
| 顶部安全区 | 该 ROM 未进入 edge-to-edge，顶栏未被状态栏遮挡；安全区改动为防御性 |
| 端侧 recency | 侧栏会话行显示"刚刚" |
| 最近使用分组 | 项目面板显示「最近使用 / 全部项目」，**46 个真实项目**，行高压缩后一屏可见 8 个 |
| 系统深浅切换 | 原生与网页同步跟随，无割裂 |

## 16. 未覆盖 / 后续

- **业务页（`index.html`）的归档开关未在真机验证**：APK 连的是 `mac-personal`，
  服务端按 scope 契约返回 `queue.html`（队列页），归档过滤在队列页本来就由 scope 保证；
  业务页是另一条路径，需要以业务模式连接才能看到开关。
- 队列页**没有真实时间戳**（元数据库 `threads` 表无 `updated_at` 列），
  补齐需要改发现管道并重启 Mac 端 agent，超出 UI 范围。
- 服务重启会导致登录态失效，若频繁发布建议把会话落盘。



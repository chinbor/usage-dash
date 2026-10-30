# usage-dash 整体设计

本文讲 usage-dash 插件整体怎么工作：从启动、读数、显示到改配置。怎么用见 [操作说明](guide.md)，怎么接入新平台见 [写一个数据源适配器](providers.md)。

## 目标

- 在 Claude Code 里一眼看到各个 AI 订阅还剩多少额度：Claude、Codex（ChatGPT）、Agnes、DeepSeek，以及任何有 JSON 接口的平台。
- 平时不占地方，只在需要注意时说话：折叠时只显示告警，额度低时弹一次提示。
- 订阅会变，数据源要能随时增删、停用，不用改代码。
- 不碰密钥：配置里只写环境变量名，key、token、密码从不落盘。

## 代码结构

插件是一个 Claude Code mod（hooks 模块），入口在 `hooks/hooks.json`，只加载 `hooks/register.tsx`。

| 文件 | 职责 |
| --- | --- |
| `.claude-plugin/plugin.json` | 插件清单：版本、两个插件选项 `display`（显示位置）和 `configPath`（配置文件位置） |
| `hooks/register.tsx` | 注册所有钩子：会话启动、命令、工具、回复完成、横条和设置面板的绘制；读写配置、刷新调度 |
| `hooks/providers.ts` | 各类数据源的读取：`fetchSource` 按类型分发，统一超时和出错处理 |
| `hooks/catalog.ts` | 数据源类型目录 `PROVIDERS`：名称、图标、说明、需要什么、添加时写入的模板 |
| `hooks/settings.ts` | 配置校验 `validateConfig` 和按点路径修改 `setPath` |
| `hooks/lib.ts` | 纯函数：解析配置、把各平台返回转换成统一的额度格式、分级、文字和 SVG 绘制 |
| `hooks/env.ts` | 按名读取环境变量（Windows 还读注册表里的用户变量） |
| `scripts/codex-limits.mjs` | 用 node 调 `codex app-server` 读 Codex 额度，失败时读本地会话记录 |
| `schema/config.schema.json` | 配置文件的 JSON Schema，供编辑器提示 |
| `types/index.d.ts` | 插件状态 `$.state` 的类型 |
| `tests/usage-dash.test.tsx` | 用 `claude-code/testing` 模拟引擎跑的测试 |

## 数据模型

每个数据源读完都变成一个 `DashItem`：

- `id`、`type`、`label`、`icon`、`color`：身份和外观。
- `parts`：每个额度窗口一项。有百分比的写 `remaining`（剩余百分比），可带 `used`、`limit`、`resetsAt`（重置时间）；只有数值的（比如余额）写 `text`。
- `warnPercent`：这个源的告急线（没单独设就用全局的）。
- `error`、`unavailable`：读取失败；`unavailable` 表示本机还没配好（缺环境变量、没装 codex），默认不在横条里出现。
- `note`：附注，比如“12 分钟前的读数”“读取超时，显示上次读数”。

所有数据源的 `DashItem` 合在一起是一份快照（`snapshot`，带 `updatedAt`），横条、状态栏、面板都只从快照取数。

**分级**：剩余低于 `warnPercent` 为告急（红），低于两倍为偏紧（黄），其余充足（绿）。DeepSeek 余额按 `warnBalance` 分级（默认 5，设 0 关闭）。一个数据源的级别取它最紧的那个窗口。

## 运行流程

### 1. 会话启动

`session.start` 时：

1. 注册 `/usage-dash` 命令和 `usage_config` 工具。
2. **先显示上次的读数**：当前会话还没有快照时，从跨会话存储（`$.store` 的 `lastSnapshot`）取上一个会话的快照，标注“N 分钟前的读数”，横条一打开就有内容。
3. 读一遍所有启用的数据源，再按 `refreshSeconds`（默认 300 秒）定时重读。

### 2. 读取数据源

`refresh` 并发读取所有启用的数据源，彼此不等待：

- **读到一个显示一个**：每个源一返回就写进快照，横条立即更新，慢的源只拖慢自己。
- **超时**：每个源最多等 20 秒（`SOURCE_TIMEOUT_MS`），超时记为“读取超时，下一轮再试”。Codex 子进程的超时比它少 2 秒。
- **失败保留旧读数**：一个源之前读成功过、这次失败了，就继续显示上次的读数，附注失败原因。
- 出错不会抛到外面：`fetchSource` 总是返回一个 `DashItem`，错误放在 `error` 里。
- 一轮全部读完后，把快照存进 `lastSnapshot` 给下一个会话用。

各类型怎么读：

| 类型 | 读法 |
| --- | --- |
| `claude` | 引擎的 `$.session.usage().rateLimits`。Claude Code 只在回复时带回额度，没有实时查询（见下节） |
| `codex` | `scripts/codex-limits.mjs` 调 `codex app-server` 实时读；失败时读本地会话记录，并注明是几小时前的记录 |
| `agnes-plan` | 用 `AGNES_EMAIL` / `AGNES_PASSWORD` 登录拿 token（只存内存，同时发起的刷新共用一次登录），或直接用 `AGNES_PLATFORM_TOKEN`；token 失效自动重登一次 |
| `deepseek` | `https://api.deepseek.com/user/balance`，只有余额 |
| `openai-billing` | new-api / one-api 中转站的 `/dashboard/billing/subscription` 和 `/usage` |
| `http-json` | 按配置里的 `url`、`auth` 请求，再按字段路径取 `windows` 和 `values` |

### 3. Claude 读数的时间

Claude 的额度只在每次回复时由接口带回，引擎里存的是“本会话最后一次回复时”的数字。所以：

- 一次读数的时间按**带来它的那次回复**算，不按轮询时间算。轮询只是把同一份旧数字再读一遍，不会把它变“新”。
- 本会话每次回复完（`turn.complete`，不含子代理）都把读数时间更新为现在；额度变化时（`session.measure`）也立即刷新 Claude 这一项。
- 多个会话共用一份最新的读数（`$.store` 的 `claudeReading`）：只有更新的读数才会覆盖存储，每个会话都显示最新的那份。
- 读数超过 5 分钟就标注“N 分钟前的读数”。别处用掉的额度，要等某个会话下一次回复才会反映出来。

### 4. 显示

由插件选项 `display` 决定：

- **`band`（默认）**：在输入框上方画横条（`AbovePrompt`），和其他插件的横条叠放。
  - 折叠时一行：总状态（“▲ N 项告警” / “○ N 项异常” / “● 全部充足”）、每条告警的平台 · 窗口 · 剩余，正常和异常的平台叠成小图标。
  - 展开后每个平台一张卡片：环形仪表显示最紧的窗口，每个窗口一格（剩余、进度条、次数、重置倒计时）；窗口太多时合并成“+N 个窗口 · 最低 X%”。
  - 分页：桌面每页 2 个平台，终端按可用行数；翻页按钮放在“收起”左边，首尾循环。这样横条不会超出它的位置，也就不会自己滚动、不和对话抢滚轮。
  - 窄窗口：告警栏按实际宽度绘制，放不下时先收起右侧的正常 / 异常图标，再只留总状态，按钮仍放不下就换到下一行。
  - 桌面版用 SVG 绘制，带各平台图标；终端里用彩色字符进度条。
- **`status`**：状态栏只在有告警时显示一行，没有告警就清空。
- **`off`**：不显示，需要时用 `/usage-dash list` 查看。

**提示**：某个窗口刚降到告急时弹一次提示（多个合成一条），恢复之前不再重复提醒。

**隐藏未配置的源**：`hideUnavailable`（默认开）时，`unavailable` 的源不进横条，只在面板和 `/usage-dash list` 里列出缺什么。

## 配置

### 配置文件

默认在 `~/.claude/usage-dash.json`（插件选项 `configPath` 可改），首次运行自动生成，默认只有 Claude 和 Codex：

```json
{
  "refreshSeconds": 300,
  "warnPercent": 20,
  "hideUnavailable": true,
  "sources": [{ "id": "claude", "type": "claude" }, { "id": "codex", "type": "codex" }]
}
```

完整字段见 `schema/config.schema.json` 和 README。

### 三种修改入口，同一套规则

设置面板、`/usage-dash` 子命令、Claude 调用的 `usage_config` 工具，最后都走 `editConfig`：

1. 读出原始配置。文件不是合法 JSON 时直接拒绝，提示先手动修好，**不会用默认配置覆盖**。
2. 在副本上改，然后用 `validateConfig` 完整校验：类型是否存在、阈值范围、id 是否重复、必填字段（`openai-billing` 的 `baseUrl`、`http-json` 的 `url`），以及 `keyEnv` / `auth.env` 是否误填成了 key 本身。
3. 校验通过才写回文件，然后把 `configRev` 加一（面板据此重画），并立即重新读取、重设定时器。

校验分宽严两种：面板和命令只拒绝**这次改动新带来的**问题，配置里原有的问题不挡编辑；`usage_config` 用严格模式，改完后有任何问题都不保存。

`usage_config` 的 `reset` 会先把原文件备份成 `.bak`，再写入默认配置。

显示位置 `display` 不在配置文件里，而是插件选项：面板和工具通过 `$.config.set` 改它，改完 usage-dash 会自动重新加载。

### 按点路径修改

`setPath` 支持：`warnPercent`、`sources.codex.enabled`（数组里用 id 指定项，也可以用下标）、`sources.-`（追加一项）；值为空表示删除这个键或这一项。

## 设置面板

`/usage-dash` 不带参数时打开一个 Pane（没有地方放面板时退回文字列表）。面板状态存在 `$.state`：当前页 `tab`、配置版本 `configRev`、待确认删除的源 `confirmRemove`。

- **数据源**页：顶部是汇总（几个启用、几个停用、几项告警），每个源一张圆角卡片，边框颜色跟随级别；卡片里有状态徽标、当前读数、启用 / 停用、删除（要二次确认）、单独的提醒线。
- **添加数据源**页：每种类型一张卡片，写明显示什么、需要准备什么、已添加几个。
- **显示与提醒**页：显示位置、全局提醒线、刷新频率、未配置的源是否显示，每项附一句说明。

**单选控件**：桌面上用下拉框；手机 App 画不出下拉框，就换成一排按钮，当前选中的高亮。

## 安全

- 配置文件只写环境变量名，从不写 key、token 或密码；校验会拦下看起来像 key 的值。
- 环境变量按名读取：macOS / Linux 用 `printenv`；Windows 先读进程环境，再读注册表里的用户变量，所以设置后不用重启。
- Agnes 的登录 token 只放在内存里。

## 已知限制

- Claude 额度没有实时查询，只能在回复后更新（见上文）。
- 本地 marketplace 安装的插件，新会话加载的是插件缓存里的版本；改了源码要更新安装（`claude plugin update usage-dash@<marketplace>`），当前会话用 `/reload-plugins`。
- 窄窗口下告警栏宽度是按终端列数估算的（约 8 px 一列），估得偏大时按钮会换行。

## 测试

```bash
claude plugin validate .
claude plugin test .
```

测试用模拟引擎覆盖：配置解析和校验、各平台数据转换、横条和面板在桌面 / 手机上的绘制、面板操作写回配置、`usage_config` 拒绝非法值、Claude 读数计时和跨会话、慢源超时、新会话从上次快照开始。

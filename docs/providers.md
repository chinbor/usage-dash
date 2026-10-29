# 写一个数据源适配器

先看能不能用 `http-json`（README 里有例子）：只要有一个返回 JSON 的接口，写字段路径就行，不用改代码。

需要登录、多步请求、或者要调本地命令时，写一个适配器：

1. **`hooks/catalog.ts`**：在 `PROVIDERS` 里加一项，`title`、`icon`、`color`、`summary`、`needs`（给 `/usage-dash types` 看的）和 `template`（`/usage-dash add` 写入配置的字段）。
2. **`hooks/providers.ts`**：写一个顶层函数 `async function fetchXxx($, s, base)`，返回 `DashItem`：
   - `parts`：每个时间窗口一项，`{ name, remaining, used?, limit?, resetsAt? }`，`remaining` 是剩余百分比，`resetsAt` 是毫秒时间戳；没有百分比的数值用 `{ name, text }`。
   - 没配好凭据时返回 `unavailable(base, '缺少环境变量 XXX')`：横条里自动隐藏，`/usage-dash` 会列出缺什么。
   - 接口出错直接 `throw`，`fetchSource` 会把它变成「出错：…」。
   - key 用 `readEnv($, s.keyEnv)` 读，不要写进任何文件。
   - 再在 `fetchSource` 的 `switch` 里加一个 `case`。
   - 函数必须是顶层声明：引擎只允许把 `$` 传给顶层函数。
3. **`schema/config.schema.json`**：把新类型加进 `type` 的 `enum`，有新字段也加上。
4. **`tests/`**：用 `http.fetch` / `process.run` 钩子模拟接口，写一个测试，跑 `claude plugin test .`。

纯数据转换（接口返回 → `parts`）放 `hooks/lib.ts`，方便单测。

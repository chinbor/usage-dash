import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { DashItem, DashSnapshot, SettingsTab } from '../types'
import { PROVIDERS } from './catalog'
import { setPath, validateConfig } from './settings'
import type { RawConfig } from './settings'
import { homeDir } from './env'
import {
  alerts,
  barCells,
  carriedParts,
  countText,
  DEFAULT_CONFIG,
  DEFAULT_WARN_BALANCE,
  fmtDuration,
  iconOf,
  itemLevel,
  itemText,
  LEVEL_LABEL,
  parseConfig,
  partFigure,
  partLevel,
  partText,
  pageOf,
  resetText,
  svgAlertStrip,
  svgDashboard,
  statusLine,
} from './lib'
import type { DashConfig, Level, SourceConfig } from './lib'
import { fetchSource } from './providers'
import type { TokenCache } from './providers'

type $ = EngineInterface

// Change the tag when DashSnapshot's fields change.
const snapshot = atom({ plugin: 'usage-dash', key: 'snapshot' } as const, null, { shape: 'snap-3' })
const isExpanded = atom({ plugin: 'usage-dash', key: 'isExpanded' } as const, false)
const detailsFrom = atom({ plugin: 'usage-dash', key: 'detailsFrom' } as const, 0)
const tab = atom({ plugin: 'usage-dash', key: 'tab' } as const, 'sources' as SettingsTab)
const configRev = atom({ plugin: 'usage-dash', key: 'configRev' } as const, 0)
const confirmRemove = atom({ plugin: 'usage-dash', key: 'confirmRemove' } as const, null as string | null)

const PANE = 'usage-dash'

async function configFile($: $, configPath: string) {
  return configPath.trim() ? configPath.trim().replace(/\\/g, '/') : `${await homeDir($)}/.claude/usage-dash.json`
}

async function loadConfig($: $, configPath: string): Promise<{ config: DashConfig; error?: string; path: string }> {
  const path = await configFile($, configPath)
  let text: string | undefined
  try {
    text = await $.fs.read(path)
  } catch {
    try {
      await $.fs.write(path, JSON.stringify(DEFAULT_CONFIG, null, 2) + '\n')
    } catch {}
  }
  return { ...parseConfig(text), path }
}

type RawEdit = { sources: SourceConfig[] } & Record<string, unknown>

/** The config file as written, unknown fields kept; the defaults where there is none. */
async function readRaw($: $, path: string): Promise<RawEdit> {
  let text: string
  try {
    text = await $.fs.read(path)
  } catch {
    return JSON.parse(JSON.stringify(DEFAULT_CONFIG))
  }
  // A file that is there but not JSON is the person's to fix: never written over.
  const raw = JSON.parse(text)
  if (!Array.isArray(raw.sources)) raw.sources = []
  return raw
}

/**
 * Reads the config file, applies `fn` to a copy, checks it and writes it back,
 * then redraws the pane and reads the sources again. Strict, any problem
 * refuses the save; else only one `fn` brought in, so a file with an old
 * problem can still be edited. Refused, `errs` says why and nothing is written.
 */
async function editConfig($: $, ctx: Ctx, fn: (raw: RawEdit) => string, strict = false): Promise<{ message: string; errs: string[] }> {
  const path = await configFile($, ctx.configPath)
  let raw: RawEdit
  try {
    raw = await readRaw($, path)
  } catch (err) {
    return { message: '', errs: [`配置文件不是合法 JSON，先手动修好：${(err as Error).message}`] }
  }
  const before = strict ? [] : validateConfig(raw)
  const draft: RawEdit = JSON.parse(JSON.stringify(raw))
  const message = fn(draft)
  const errs = validateConfig(draft).filter(e => !before.includes(e))
  if (errs.length) return { message, errs }
  await $.fs.write(path, JSON.stringify(draft, null, 2) + '\n')
  await update($, configRev, n => n + 1)
  // Restarts the timer too, for a changed refreshSeconds.
  await start($, ctx)
  return { message, errs }
}

/** A command's or the pane's edit, in one line: what it did, or why nothing was saved. */
const said = ({ message, errs }: { message: string; errs: string[] }) => (errs.length ? `没保存：${errs.join('；')}` : message)

/** Sets the display row of `/config`, which reloads the module with the new value. */
async function setDisplay($: $, ctx: Ctx, value: string): Promise<string> {
  if (!DISPLAYS.some(([v]) => v === value)) return `显示位置只能是 ${DISPLAYS.map(([v]) => v).join(' / ')}`
  const row = (await $.config.list()).find(r => r.key.endsWith('.display') && r.provider.plugin.split('@')[0] === 'usage-dash')
  if (!row) return '没找到 usage-dash 的显示位置设置：到 /config 里改 usage-dash 的「显示位置」。'
  const done = await $.config.set({ key: row.key, value })
  if ('deny' in done) return `没改：${done.deny}。可以到 /config 里改 usage-dash 的「显示位置」。`
  ctx.display = value
  return `显示位置已改为 ${value}。`
}

const DISPLAYS: [string, string][] = [
  ['band', '输入框上方的横条（推荐）'],
  ['status', '状态栏：有告警时才显示一行'],
  ['off', '不显示：需要时输入 /usage-dash list 查看'],
]

type Ctx = {
  display: string
  configPath: string
  config: DashConfig
  configError?: string
  timer?: { cancel: () => void }
  warned: Set<string>
  tokens: TokenCache
}

/** What the band, status line and toasts show: unavailable sources left out unless asked for. */
const visible = (ctx: Ctx, items: DashItem[]) =>
  ctx.config.hideUnavailable ? items.filter(i => !i.unavailable) : items

async function show($: $, ctx: Ctx, snap: DashSnapshot) {
  const now = await $.clock.now()
  const items = visible(ctx, snap.items)
  if (ctx.display === 'status') {
    // The status line carries alerts only, and clears when there are none.
    const lines = alerts(items).map(
      ({ item, part, level }) => `${level === 'low' ? '▲' : '●'} ${item.label} ${LEVEL_LABEL[level]} ${partText(part, now)}`,
    )
    $.ui.status(lines.length ? lines.join('  ') : undefined)
  }
  // Windows newly low, each once until it recovers; several at once are one toast.
  const fresh: string[] = []
  for (const item of items) {
    for (const p of item.parts) {
      const k = `${item.id}:${p.name}`
      if (partLevel(p, item.warnPercent) === 'low') {
        if (!ctx.warned.has(k)) {
          ctx.warned.add(k)
          fresh.push(`${item.label} ${partText(p, now)}`)
        }
      } else ctx.warned.delete(k)
    }
  }
  if (fresh.length === 1) $.ui.toast(`${fresh[0]}，额度偏低`)
  else if (fresh.length > 1) {
    const head = fresh.slice(0, 3).join('；')
    $.ui.toast(`${fresh.length} 项额度偏低：${head}${fresh.length > 3 ? ` 等` : ''}`)
  }
}

/** Where the last full snapshot is kept for the next session to start from. */
const LAST_KEY = 'lastSnapshot'

/**
 * Reads the enabled sources again (only those of type `only`, when given). Each
 * one is drawn as soon as it answers, so a slow or stuck source holds back only
 * itself. A source that fails after a good reading keeps that reading, marked.
 */
async function refresh($: $, ctx: Ctx, only?: string) {
  const loaded = await loadConfig($, ctx.configPath)
  ctx.config = loaded.config
  ctx.configError = loaded.error
  const sources = ctx.config.sources.filter(s => s.enabled !== false)
  const wanted = sources.filter(s => !only || s.type === only)
  const order = sources.map(s => s.id)
  await Promise.all(
    wanted.map(async s => {
      const item = await fetchSource($, s, ctx.config.warnPercent, ctx.tokens)
      const now = await $.clock.now()
      await update($, snapshot, prev => {
        const byId = new Map((prev?.items ?? []).map(i => [i.id, i]))
        const before = byId.get(item.id)
        byId.set(
          item.id,
          item.error && !item.unavailable && before && !before.error && before.type === item.type
            ? { ...before, note: `${item.error}，显示上次读数` }
            : item,
        )
        const items = order.map(id => byId.get(id)).filter((i): i is DashItem => !!i)
        return { items, updatedAt: now }
      })
    }),
  )
  const snap = await read($, snapshot)
  if (snap) {
    if (!only) await $.store.set(LAST_KEY, snap)
    await show($, ctx, snap)
  }
  return snap
}

/**
 * A new session's band starts from the last session's snapshot, each source
 * dated, until its own reading replaces it: the band is there from the start.
 */
async function seed($: $) {
  if (await read($, snapshot)) return
  const last = (await $.store.get(LAST_KEY)) as DashSnapshot | undefined
  if (!last || !Array.isArray(last.items) || !last.items.length) return
  const now = await $.clock.now()
  const age = `${fmtDuration(Math.max(0, now - last.updatedAt))}前的读数`
  await update($, snapshot, prev =>
    prev ?? {
      items: last.items.map(i => ({ ...i, parts: carriedParts(i.parts, now), note: i.error ? i.note : age })),
      updatedAt: last.updatedAt,
    },
  )
}

async function start($: $, ctx: Ctx) {
  await seed($)
  await refresh($, ctx)
  ctx.timer?.cancel()
  ctx.timer = $.clock.every(ctx.config.refreshSeconds * 1000, () => void refresh($, ctx))
}

const HELP = [
  '用法：',
  '- `/usage-dash` 打开设置面板（数据源 / 添加 / 显示）',
  '- `/usage-dash list` 刷新并列出全部数据源',
  '- `/usage-dash types` 可用的数据源类型',
  '- `/usage-dash add <类型> [id]` 添加一个数据源（写入模板，按提示补环境变量）',
  '- `/usage-dash remove <id>` 删除',
  '- `/usage-dash enable <id>` / `disable <id>` 启用 / 停用',
  '- `/usage-dash path` 配置文件位置',
].join('\n')

/** `/usage-dash <sub> ...`: edits the config file; never touches a key. */
async function runCommand($: $, ctx: Ctx, args: string): Promise<string> {
  const [sub = '', a, b] = args.trim().split(/\s+/).filter(Boolean)
  switch (sub) {
    case 'list':
    case 'sources': {
      const snap = await refresh($, ctx)
      const now = await $.clock.now()
      const lines = (snap?.items ?? []).map(i => `- ${itemText(i, now)}${i.unavailable ? '（未配置，横条里隐藏）' : ''}`)
      const off = ctx.config.sources.filter(s => s.enabled === false).map(s => `- ${s.label ?? s.id}（已停用）`)
      if (ctx.configError) lines.push(`- 配置：${ctx.configError}`)
      // The host puts "usage-dash: " before the text: a heading keeps the list a list.
      const all = [...lines, ...off]
      return all.length ? ['当前数据源：', '', ...all].join('\n') : '没有数据源。`/usage-dash types` 看看能加什么。'
    }
    case 'types':
      return [
        '可添加的数据源类型（`/usage-dash add <类型>`）：',
        '',
        '| 类型 | 显示什么 | 需要准备 |',
        '| --- | --- | --- |',
        ...Object.entries(PROVIDERS).map(([type, p]) => `| \`${type}\` | ${p.summary} | ${p.needs} |`),
      ].join('\n')
    case 'path':
      return `配置文件：${await configFile($, ctx.configPath)}`
    case 'add': {
      if (!a || !PROVIDERS[a]) return `未知类型 ${a ?? ''}。\n\n${await runCommand($, ctx, 'types')}`
      return said(await addSource($, ctx, a, b))
    }
    case 'remove':
    case 'enable':
    case 'disable': {
      if (!a) return HELP
      return said(await editSource($, ctx, sub, a))
    }
    default:
      return HELP
  }
}

/** Adds a source of `type` from its template, under `want` or the type's name, numbered past those taken. */
function addSource($: $, ctx: Ctx, type: string, want?: string) {
  const p = PROVIDERS[type]!
  return editConfig($, ctx, raw => {
    const taken = new Set(raw.sources.map(s => s.id))
    const base = want ?? type.replace(/-.*$/, '')
    let id = base
    for (let n = 2; taken.has(id); n++) id = `${base}${n}`
    raw.sources.push({ id, type, ...p.template } as SourceConfig)
    return `已添加 \`${id}\`（${type}）。需要：${p.needs}。可在配置文件里改 label / icon / 字段。`
  })
}

function editSource($: $, ctx: Ctx, action: 'remove' | 'enable' | 'disable', id: string) {
  return editConfig($, ctx, raw => {
    const i = raw.sources.findIndex(s => s.id === id)
    if (i < 0) return `没有 id 为 ${id} 的数据源。`
    if (action === 'remove') {
      raw.sources.splice(i, 1)
      return `已删除 ${id}。`
    }
    const s = raw.sources[i]!
    if (action === 'enable') delete s.enabled
    else s.enabled = false
    return `已${action === 'enable' ? '启用' : '停用'} ${id}。`
  })
}

// ---------- usage_config, the tool Claude edits the config with ----------

type ConfigInput = { action?: 'get' | 'set' | 'reset'; path?: string; value?: unknown; remove?: boolean }

async function configTool($: $, ctx: Ctx, input: ConfigInput): Promise<string> {
  const path = await configFile($, ctx.configPath)
  if (input.action === 'reset') {
    try {
      await $.fs.write(`${path}.bak`, await $.fs.read(path))
    } catch {}
    // Written whole, so a file that is not JSON can be reset too.
    await $.fs.write(path, JSON.stringify(DEFAULT_CONFIG, null, 2) + '\n')
    await update($, configRev, n => n + 1)
    await start($, ctx)
    return `已恢复默认配置，旧配置备份在 ${path}.bak`
  }
  if (input.action === 'set') {
    if (!input.path) return '缺 path，例如 "sources.codex.enabled"、"warnPercent"、"display"'
    if (input.path === 'display') return setDisplay($, ctx, String(input.value))
    let done
    try {
      done = await editConfig($, ctx, raw => {
        setPath(raw as RawConfig, input.path!, input.remove ? undefined : input.value)
        return ''
      }, true)
    } catch (err) {
      return `没改：${(err as Error).message}`
    }
    if (done.errs.length) return `没改，校验不通过：\n- ${done.errs.join('\n- ')}`
    return `已保存 ${input.path}，横条已按新配置刷新。`
  }
  let raw: unknown
  try {
    raw = await readRaw($, path)
  } catch (err) {
    raw = `（不是合法 JSON：${(err as Error).message}）`
  }
  return [
    `配置文件：${path}`,
    `显示位置（display）：${ctx.display}`,
    `数据源类型：${Object.keys(PROVIDERS).join(', ')}`,
    '```json',
    typeof raw === 'string' ? raw : JSON.stringify(raw, null, 2),
    '```',
  ].join('\n')
}

export const register: Register = (on, options) => {
  const ctx: Ctx = {
    display: String(options.display ?? 'band'),
    configPath: String(options.configPath ?? ''),
    config: DEFAULT_CONFIG,
    warned: new Set(),
    tokens: { tokens: new Map(), logins: new Map(), claude: { at: 0 } },
  }

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({
      name: 'usage-dash',
      description: '各平台额度：刷新列表，或 add / remove / enable / disable / types',
      argumentHint: '[list | types | add <类型> [id] | remove <id> | enable <id> | disable <id> | path]',
    })
    await $.tool.register({
      name: 'usage_config',
      isDeferred: true,
      description:
        'Read or change the usage-dash config (~/.claude/usage-dash.json): which quota sources the band above the prompt shows, their thresholds, refresh interval, and where it is shown. Use it when the user asks to change usage-dash in words. ' +
        "action=get returns the config JSON, the source types and the current display; action=set changes one value by a dotted path, where a source is named by its id (path 'sources.codex.enabled' value false; path 'sources.deepseek.warnBalance' value 10; path 'warnPercent' value 25; path 'sources.-' value {id,type,...} appends one; path 'display' value band|status|off); remove=true deletes the key (path 'sources.codex' removes that source); action=reset restores defaults with a .bak backup. " +
        'Every change is validated before it is saved and refused whole if invalid. Keys are never written: keyEnv / auth.env hold the name of an environment variable.',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['get', 'set', 'reset'] },
          path: { type: 'string' },
          value: {},
          remove: { type: 'boolean' },
        },
        required: ['action'],
      },
    })
    void start($, ctx)
    return started
  })

  on('tool.call', { tool: 'mcp__usage-dash__usage_config' }, async ($, e) => ({
    result: await configTool($, ctx, e as unknown as ConfigInput),
  })).catch(($, _e, next) => ({ deny: `usage_config 出错：${next.error?.message ?? '未知'}` }))

  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('rateLimits')) void refresh($, ctx, 'claude')
    return next(e)
  })

  // A reply came in: the windows the engine holds are as of now, moved or not.
  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.reason === 'answer' && !e.agentId && ctx.tokens.claude.key) {
      ctx.tokens.claude.at = await $.clock.now()
      void refresh($, ctx, 'claude')
    }
    return done
  })

  on('command.run', { command: 'usage-dash' }, async ($, e) => {
    if (e.args.trim()) return { text: await runCommand($, ctx, e.args) }
    const { isPlaced } = await $.ui.open({ id: PANE, title: 'usage-dash' })
    // Nowhere to show a pane: the list, as before the pane.
    if (!isPlaced) return { text: await runCommand($, ctx, 'list') }
    void refresh($, ctx)
    return { text: '设置面板已打开。改动直接写回配置文件，横条随即刷新；也可以直接跟 Claude 说要怎么改。' }
  })

  // ----- the settings pane -----

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const { Box, Text, Button } = els
    // The phone lists Select but draws none: a row of buttons there, the current one marked.
    type Opt = { value: string; label: string }
    const choice = (p: { key: string; label?: string; value?: string; options: Opt[]; onSelect: (v: string) => void }) =>
      'Select' in els && e.surface !== 'mobile' ? (
        <els.Select key={p.key} label={p.label} value={p.value} options={p.options} onSelect={v => p.onSelect(v)} />
      ) : (
        <Box key={p.key} flexDirection="row" flexWrap="wrap" columnGap={1}>
          {p.label ? <Text>{p.label}</Text> : null}
          {p.options.map(o => (
            <Button key={`${p.key}-${o.value}`} variant={o.value === p.value ? 'primary' : 'secondary'} label={o.label} onPress={() => p.onSelect(o.value)} />
          ))}
        </Box>
      )
    // A failed save says why; a good one shows in the redraw.
    const act = (work: () => Promise<{ message: string; errs: string[] } | string>) => () =>
      void work().then(r => {
        if (typeof r === 'string') $.ui.toast(r)
        else if (r.errs.length) $.ui.toast(said(r))
      })
    const setTop = (key: string, value: unknown) =>
      act(() => editConfig($, ctx, raw => (setPath(raw as RawConfig, key, value), '')))

    await read($, configRev)
    const { config, error, path } = await loadConfig($, ctx.configPath)
    const current = await read($, tab)
    const now = await $.clock.now()
    const snap = await read($, snapshot)
    const byId = new Map((snap?.items ?? []).map(i => [i.id, i]))

    const hint = (key: string, text: string) => (
      <Text key={key} size="footnote" dimColor>
        {text}
      </Text>
    )
    // One setting or source: a rounded card, its title on top.
    const card = (key: string, children: (JSX.Element | null)[], borderColor = 'subtle') => (
      <Box key={key} flexDirection="column" borderStyle="round" borderColor={borderColor} paddingX={1}>
        {children}
      </Box>
    )
    const section = (key: string, title: string, about: string, control: JSX.Element) =>
      card(key, [
        <Text key={`${key}-title`} weight="semibold">
          {title}
        </Text>,
        hint(`${key}-about`, about),
        <Box key={`${key}-control`} marginTop={1}>
          {control}
        </Box>,
      ])

    const enabledCount = config.sources.filter(s => s.enabled !== false).length
    const TABS: [SettingsTab, string, string][] = [
      ['sources', `数据源 ${config.sources.length}`, '横条里显示哪些平台。停用只是暂时不显示，配置保留；删除会从配置文件里移除。'],
      ['add', '添加数据源', '选一个平台类型加入。需要环境变量的，设好变量后横条里会自动出现数据。'],
      ['display', '显示与提醒', '横条放在哪里、额度低到多少提醒、多久刷新一次。'],
    ]
    const header = (
      <Box key="header" flexDirection="column" marginBottom={1}>
        <Text size="heading" weight="semibold">
          额度仪表盘设置
        </Text>
        <Box flexDirection="row" flexWrap="wrap" columnGap={1} marginTop={1}>
          {TABS.map(([id, name]) => (
            <Button key={`tab-${id}`} variant={id === current ? 'primary' : 'secondary'} label={name} onPress={() => void update($, tab, () => id)} />
          ))}
        </Box>
        <Box marginTop={1}>{hint('tab-about', TABS.find(([id]) => id === current)![2])}</Box>
      </Box>
    )
    const footer = hint('footer', `配置文件：${path}。也可以直接跟 Claude 说要怎么改，比如“DeepSeek 余额低于 10 就提醒我”。`)

    let body
    if (current === 'add') {
      const added = (type: string) => config.sources.filter(s => s.type === type).length
      body = (
        <Box key="add" flexDirection="column" rowGap={1}>
          {Object.entries(PROVIDERS).map(([type, p]) => {
            const n = added(type)
            return card(`type-${type}`, [
              <Box key="head" flexDirection="row" justifyContent="space-between" alignItems="center" columnGap={1}>
                <Box flexDirection="row" columnGap={1} alignItems="center" flexShrink={1}>
                  <Text weight="semibold">{`${p.icon} ${p.title}`}</Text>
                  {n ? (
                    <Text size="caption" color="success">
                      {`✓ 已添加 ${n} 个`}
                    </Text>
                  ) : null}
                </Box>
                <Button
                  key={`add-${type}`}
                  variant={n ? 'secondary' : 'primary'}
                  label={n ? '再加一个' : '添加'}
                  onPress={act(async () => {
                    const r = await addSource($, ctx, type)
                    return r.errs.length ? r : r.message
                  })}
                />
              </Box>,
              <Text key="summary">{p.summary}</Text>,
              hint('needs', `需要准备：${p.needs}`),
            ])
          })}
        </Box>
      )
    } else if (current === 'display') {
      body = (
        <Box key="display" flexDirection="column" rowGap={1}>
          {section(
            'where',
            '显示在哪里',
            '切换后 usage-dash 会自动重新加载。也可以在 /config 里改。',
            choice({
              key: 'display',
              value: ctx.display,
              options: DISPLAYS.map(([value, label]) => ({ value, label })),
              onSelect: v => act(() => setDisplay($, ctx, v))(),
            }),
          )}
          {section(
            'warn',
            '额度提醒',
            '剩余额度低于这个比例时标红，并弹一次提示；低于它的两倍时标黄。单个数据源可以在“数据源”页另设。',
            choice({
              key: 'warn',
              value: String(config.warnPercent),
              options: [10, 15, 20, 25, 30, 40].map(n => ({ value: String(n), label: `剩余低于 ${n}%` })),
              onSelect: v => setTop('warnPercent', Number(v))(),
            }),
          )}
          {section(
            'refresh',
            '刷新频率',
            '多久重新读一次各平台的额度。Claude 自己的额度每次回复后都会更新，不受这项影响。',
            choice({
              key: 'refresh',
              value: String(config.refreshSeconds),
              options: [60, 120, 300, 600, 1800].map(n => ({ value: String(n), label: `每 ${n / 60} 分钟` })),
              onSelect: v => setTop('refreshSeconds', Number(v))(),
            }),
          )}
          {section(
            'hide',
            '没配好的数据源',
            '缺环境变量、或还没有读数的数据源。隐藏时只在这个面板和 /usage-dash list 里看得到。',
            choice({
              key: 'hide',
              value: config.hideUnavailable ? 'hide' : 'show',
              options: [
                { value: 'hide', label: '横条里隐藏' },
                { value: 'show', label: '横条里也显示，提示缺什么' },
              ],
              onSelect: v => setTop('hideUnavailable', v === 'hide')(),
            }),
          )}
        </Box>
      )
    } else {
      const pending = await read($, confirmRemove)
      const alertCount = alerts((snap?.items ?? []).filter(i => config.sources.some(s => s.id === i.id && s.enabled !== false))).length
      const summary = [
        `${enabledCount} 个启用`,
        config.sources.length > enabledCount ? `${config.sources.length - enabledCount} 个停用` : '',
        alertCount ? `${alertCount} 项额度告警` : '',
      ].filter(Boolean)
      body = (
        <Box key="sources" flexDirection="column" rowGap={1}>
          {error ? <Text color="error">{error}</Text> : null}
          {config.sources.length === 0 ? (
            <Text>还没有数据源，到“添加数据源”页加一个。</Text>
          ) : (
            <Text key="summary" size="footnote">
              {summary.join(' · ')}
            </Text>
          )}
          {config.sources.map(s => {
            const off = s.enabled === false
            const item = byId.get(s.id)
            const label = s.label ?? item?.label ?? PROVIDERS[s.type]?.title ?? s.id
            const [glyph] = iconOf(s.type, label, s.icon)
            const lvl = item && !item.error ? itemLevel(item) : undefined
            // What the source is doing now, in a word, and the line under it.
            const [status, color, line] = off
              ? ['已停用', 'inactive', '横条里不显示，配置保留。点“启用”恢复。']
              : !item
                ? ['读取中…', 'inactive', '']
                : item.unavailable
                  ? ['○ 未配置', 'warning', `${item.error ?? '还没有读数'}${config.hideUnavailable ? '。设好前横条里先隐藏。' : ''}`]
                  : item.error
                    ? ['○ 读取失败', 'error', item.error]
                    : [
                        lvl === 'low' ? '▲ 告急' : lvl === 'warn' ? '▲ 偏紧' : '● 充足',
                        lvl === 'low' ? 'error' : lvl === 'warn' ? 'warning' : 'success',
                        item.parts.map(p => partText(p, now)).join(' · ') + (item.note ? `（${item.note}）` : ''),
                      ]
            const isBalance = s.type === 'deepseek'
            return card(
              `src-${s.id}`,
              [
                <Box key="head" flexDirection="row" justifyContent="space-between" alignItems="center" columnGap={1}>
                  <Box flexDirection="row" columnGap={1} alignItems="center" flexShrink={1}>
                    <Text weight="semibold" dimColor={off}>{`${glyph} ${label}`}</Text>
                    <Text size="caption" color={color}>
                      {status}
                    </Text>
                  </Box>
                  <Box flexDirection="row" columnGap={1} flexShrink={0}>
                    <Button
                      key={`toggle-${s.id}`}
                      variant={off ? 'primary' : 'secondary'}
                      label={off ? '启用' : '停用'}
                      onPress={act(() => editSource($, ctx, off ? 'enable' : 'disable', s.id))}
                    />
                    <Button key={`remove-${s.id}`} label="删除" onPress={() => void update($, confirmRemove, () => s.id)} />
                  </Box>
                </Box>,
                line ? (
                  <Text key="line" dimColor={off}>
                    {line}
                  </Text>
                ) : null,
                pending === s.id ? (
                  <Box key="confirm" flexDirection="row" flexWrap="wrap" columnGap={1} alignItems="center" marginTop={1}>
                    <Text color="error">{`确定删除“${label}”？会从配置文件里移除。`}</Text>
                    <Button
                      key={`confirm-remove-${s.id}`}
                      variant="primary"
                      label="删除"
                      onPress={act(async () => {
                        await update($, confirmRemove, () => null)
                        return editSource($, ctx, 'remove', s.id)
                      })}
                    />
                    <Button key={`cancel-remove-${s.id}`} label="取消" onPress={() => void update($, confirmRemove, () => null)} />
                  </Box>
                ) : null,
                off ? null : isBalance ? (
                  hint('warn', `余额低于 ${s.warnBalance ?? DEFAULT_WARN_BALANCE} 时提醒（可以让 Claude 改 warnBalance）`)
                ) : (
                  <Box key="warn" flexDirection="row" flexWrap="wrap" columnGap={1} alignItems="center" marginTop={1}>
                    <Text size="footnote" dimColor>
                      提醒：
                    </Text>
                    {choice({
                      key: `warn-${s.id}`,
                      value: s.warnPercent === undefined ? '-' : String(s.warnPercent),
                      options: [
                        { value: '-', label: `跟随全局（剩余低于 ${config.warnPercent}%）` },
                        ...[10, 20, 30, 50].map(n => ({ value: String(n), label: `剩余低于 ${n}%` })),
                      ],
                      onSelect: v => setTop(`sources.${s.id}.warnPercent`, v === '-' ? undefined : Number(v))(),
                    })}
                  </Box>
                ),
                hint('id', `id：${s.id} · 类型：${s.type}`),
              ],
              off ? 'subtle' : lvl === 'low' || item?.error && !item.unavailable ? 'error' : lvl === 'warn' ? 'warning' : 'subtle',
            )
          })}
        </Box>
      )
    }
    return (
      <Box flexDirection="column" rowGap={1}>
        {header}
        {body}
        {footer}
      </Box>
    )
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (ctx.display !== 'band' || e.props.hasSurvey) return next(e)
    const stored = await read($, snapshot)
    const items = stored ? visible(ctx, stored.items) : []
    if (items.length === 0) return next(e)
    const snap = { ...stored!, items }
    const expanded = await read($, isExpanded)
    const below = await next(e)
    const now = await $.clock.now()
    const toggle = () => update($, isExpanded, v => !v)
    const { Box, Text, Button } = $.ui.resolve(e)
    const tone = (lvl: Level) => (lvl === 'low' ? 'error' : lvl === 'warn' ? 'warning' : 'success')

    // Collapsed: alerts only, the whole line one press that opens the details.
    const found = alerts(snap.items)
    const broken = snap.items.filter(i => i.error)
    const okItems = snap.items.filter(i => !i.error && !found.some(f => f.item.id === i.id))
    const summary = (
      <Button key="toggle" plain onPress={toggle}>
        {found.length > 0 ? (
          <Text bold color={tone(found[0]!.level)}>{`▲ ${found.length} 项告警   `}</Text>
        ) : broken.length > 0 ? (
          <Text bold dimColor>{`○ ${statusLine(0, broken.length)}   `}</Text>
        ) : (
          <Text bold color="success">● 全部充足   </Text>
        )}
        {found.slice(0, 4).map(({ item, part, level }) => (
          <Text key={`${item.id}-${part.name}`} color={tone(level)}>
            {`${iconOf(item.type, item.label, item.icon)[0]} ${item.label}·${part.name} ${partFigure(part)}   `}
          </Text>
        ))}
        {found.length > 4 ? <Text dimColor>{`+${found.length - 4}   `}</Text> : ''}
        {/* One line however many sources: past a few, names give way to counts. */}
        {okItems.length > 0 ? (
          <Text dimColor>{okItems.length > 3 ? `✓ ${okItems.length} 项正常   ` : `✓ ${okItems.map(i => i.label).join(' ')}   `}</Text>
        ) : (
          ''
        )}
        {found.length > 0 && broken.length > 0 ? (
          <Text dimColor>{broken.length > 2 ? `○ ${broken.length} 项异常   ` : broken.map(i => `○ ${i.label} ${i.error}   `).join('')}</Text>
        ) : found.length === 0 && broken.length > 0 && broken.length <= 2 ? (
          <Text dimColor>{broken.map(i => `${i.label} ${i.error}   `).join('')}</Text>
        ) : (
          ''
        )}
        <Text dimColor>{expanded ? '收起 ▴' : '详情 ▾'}</Text>
      </Button>
    )
    // Expanded, the details show a page of sources at a time, turned by the
    // pager: the band never outgrows its slot, so it never scrolls, the header
    // stays on top and the wheel stays the transcript's.
    const perPage = e.surface === 'desktop' ? 2 : Math.max(1, e.props.maxRows - 4)
    const { start, page, pages } = pageOf(await read($, detailsFrom), perPage, snap.items.length)
    const turn = (to: number) => update($, detailsFrom, () => (to - 1) * perPage)
    // The page › turns to, coming round to the first after the last.
    const after = (page % pages) + 1
    const paging = expanded && pages > 1
    // Square buttons on the desktop, in the header beside the toggle: a row of
    // their own under the details outgrew the band; bare arrows on the terminal.
    const look = e.surface === 'desktop' ? {} : { plain: true as const }
    const back = <Button key="prev" {...look} label="‹" onPress={() => turn(((page - 2 + pages) % pages) + 1)} />
    const forth = <Button key="next" {...look} label="›" onPress={() => turn(after)} />
    // A cell is about 8 CSS px on the desktop (measured against the band as drawn).
    // No higher floor: a strip wider than a narrow window pushed the toggle off its right edge.
    const slotW = Math.min(1100, Math.max(240, e.props.bodyColumns * 8))

    let header = summary
    if (e.surface === 'desktop') {
      // The pills are an Svg, the presses Buttons of their own beside them.
      const { Svg } = $.ui.resolve(e)
      // The rest is the buttons': the toggle about 64 px, the pager about 100.
      const strip = svgAlertStrip(snap.items, now, slotW - (paging ? 196 : 92))
      header = (
        // Wraps when the estimate is still too wide, so the buttons drop a line rather than off the edge.
        <Box flexDirection="row" flexWrap="wrap" alignItems="center" justifyContent="space-between" columnGap={2}>
          <Svg source={strip.svg} alt={found.length ? found.map(f => `${f.item.label} ${LEVEL_LABEL[f.level]} ${partText(f.part, now)}`).join('；') : statusLine(0, broken.length)} width={strip.width} height={strip.height} />
          <Box flexDirection="row" alignItems="center" columnGap={1} flexShrink={0}>
            {paging ? back : null}
            {paging ? <Text dimColor>{`${page}/${pages}`}</Text> : null}
            {paging ? forth : null}
            <Button key="toggle" label={expanded ? '收起 ▴' : '详情 ▾'} onPress={toggle} />
          </Box>
        </Box>
      )
    }
    if (!expanded) {
      return (
        <Box flexDirection="column">
          {header}
          {below}
        </Box>
      )
    }

    const shown = snap.items.slice(start, start + perPage)
    const alt = shown.map(i => itemText(i, now)).join('；')
    if (e.surface === 'desktop') {
      const { Svg } = $.ui.resolve(e)
      // The drawing scales to the slot if the estimate is off.
      const { svg } = svgDashboard(shown, now, slotW)
      // No row gaps: each is a line tall, and with them the band outgrew its slot and scrolled.
      return (
        <Box flexDirection="column">
          {header}
          <Svg source={svg} alt={alt} />
          {below}
        </Box>
      )
    }
    const labelW = Math.max(...snap.items.map(i => i.label.length)) + 5
    return (
      <Box flexDirection="column">
        {header}
        {shown.map(item => {
          const lvl = itemLevel(item)
          const [glyph] = iconOf(item.type, item.label, item.icon)
          return (
            <Box key={item.id} flexDirection="row">
              <Box width={labelW} flexShrink={0}>
                <Text bold color={lvl ? tone(lvl) : undefined}>{`${glyph} ${item.label}`}</Text>
              </Box>
              {item.error ? (
                <Text dimColor>{item.error}</Text>
              ) : (
                <Box flexDirection="row" flexWrap="wrap" columnGap={3}>
                  {item.parts.map((p, i) => {
                    const pl = partLevel(p, item.warnPercent)
                    const [full, empty] = barCells(p.remaining ?? 0, 10)
                    const detail = [countText(p), resetText(p, now) && `↻${resetText(p, now)}`].filter(Boolean).join(' ')
                    return (
                      <Text key={`${item.id}-${i}`} wrap="truncate">
                        <Text dimColor>{p.name.padEnd(3)}</Text>
                        {p.remaining === undefined ? (
                          <Text>{p.text ?? ''}</Text>
                        ) : (
                          <Text>
                            <Text color={tone(pl)}>{full}</Text>
                            <Text dimColor>{empty}</Text>{' '}
                            <Text bold color={tone(pl)}>{`${p.remaining}%`.padStart(4)}</Text>
                          </Text>
                        )}
                        {detail ? <Text dimColor> {detail}</Text> : null}
                      </Text>
                    )
                  })}
                </Box>
              )}
              {item.note ? <Text dimColor> {item.note}</Text> : null}
            </Box>
          )
        })}
        {pages > 1 ? (
          <Box key="pager" flexDirection="row" justifyContent="flex-end" columnGap={1}>
            {back}
            <Text dimColor>{`${page}/${pages}`}</Text>
            {forth}
          </Box>
        ) : null}
        {below}
      </Box>
    )
  })
}

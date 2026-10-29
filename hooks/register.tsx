import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { DashItem, DashSnapshot } from '../types'
import { PROVIDERS } from './catalog'
import { homeDir } from './env'
import {
  alerts,
  barCells,
  countText,
  DEFAULT_CONFIG,
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

/** Reads the config file as written (unknown fields kept), applies `fn`, writes it back. */
async function editConfig($: $, configPath: string, fn: (raw: { sources: SourceConfig[] } & Record<string, unknown>) => string) {
  const path = await configFile($, configPath)
  let raw: { sources: SourceConfig[] } & Record<string, unknown>
  try {
    raw = JSON.parse(await $.fs.read(path))
  } catch {
    raw = JSON.parse(JSON.stringify(DEFAULT_CONFIG))
  }
  if (!Array.isArray(raw.sources)) raw.sources = []
  const message = fn(raw)
  await $.fs.write(path, JSON.stringify(raw, null, 2) + '\n')
  return message
}

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

async function refresh($: $, ctx: Ctx, only?: string) {
  const loaded = await loadConfig($, ctx.configPath)
  ctx.config = loaded.config
  ctx.configError = loaded.error
  const sources = ctx.config.sources.filter(s => s.enabled !== false)
  const wanted = sources.filter(s => !only || s.type === only)
  const fresh = await Promise.all(wanted.map(s => fetchSource($, s, ctx.config.warnPercent, ctx.tokens)))
  const order = sources.map(s => s.id)
  const now = await $.clock.now()
  const snap = await update($, snapshot, prev => {
    const byId = new Map((prev?.items ?? []).map(i => [i.id, i]))
    for (const i of fresh) byId.set(i.id, i)
    const items = order.map(id => byId.get(id)).filter((i): i is DashItem => !!i)
    return { items, updatedAt: now }
  })
  if (snap) await show($, ctx, snap)
  return snap
}

async function start($: $, ctx: Ctx) {
  await refresh($, ctx)
  ctx.timer?.cancel()
  ctx.timer = $.clock.every(ctx.config.refreshSeconds * 1000, () => void refresh($, ctx))
}

const HELP = [
  '用法：',
  '- `/usage-dash` 刷新并列出全部数据源',
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
    case '':
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
      const p = a ? PROVIDERS[a] : undefined
      if (!a || !p) return `未知类型 ${a ?? ''}。\n\n${await runCommand($, ctx, 'types')}`
      const message = await editConfig($, ctx.configPath, raw => {
        const taken = new Set(raw.sources.map(s => s.id))
        let id = b ?? a.replace(/-.*$/, '')
        for (let n = 2; taken.has(id); n++) id = `${b ?? a.replace(/-.*$/, '')}${n}`
        raw.sources.push({ id, type: a, ...p.template } as SourceConfig)
        return `已添加 \`${id}\`（${a}）。需要：${p.needs}。可在配置文件里改 label / icon / 字段。`
      })
      await refresh($, ctx)
      return message
    }
    case 'remove':
    case 'enable':
    case 'disable': {
      if (!a) return HELP
      const message = await editConfig($, ctx.configPath, raw => {
        const i = raw.sources.findIndex(s => s.id === a)
        if (i < 0) return `没有 id 为 ${a} 的数据源。`
        if (sub === 'remove') {
          raw.sources.splice(i, 1)
          return `已删除 ${a}。`
        }
        const s = raw.sources[i]!
        if (sub === 'enable') delete s.enabled
        else s.enabled = false
        return `已${sub === 'enable' ? '启用' : '停用'} ${a}。`
      })
      await refresh($, ctx)
      return message
    }
    default:
      return HELP
  }
}

export const register: Register = (on, options) => {
  const ctx: Ctx = {
    display: String(options.display ?? 'band'),
    configPath: String(options.configPath ?? ''),
    config: DEFAULT_CONFIG,
    warned: new Set(),
    tokens: { tokens: new Map(), logins: new Map() },
  }

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({
      name: 'usage-dash',
      description: '各平台额度：刷新列表，或 add / remove / enable / disable / types',
      argumentHint: '[types | add <类型> [id] | remove <id> | enable <id> | disable <id> | path]',
    })
    void start($, ctx)
    return started
  })

  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('rateLimits')) void refresh($, ctx, 'claude')
    return next(e)
  })

  on('command.run', { command: 'usage-dash' }, async ($, e) => ({ text: await runCommand($, ctx, e.args) }))

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
    const slotW = Math.min(1100, Math.max(560, e.props.bodyColumns * 8))

    let header = summary
    if (e.surface === 'desktop') {
      // The pills are an Svg, the presses Buttons of their own beside them.
      const { Svg } = $.ui.resolve(e)
      // The rest is the buttons': the toggle about 64 px, the pager about 100.
      const strip = svgAlertStrip(snap.items, now, slotW - (paging ? 196 : 92))
      header = (
        <Box flexDirection="row" alignItems="center" justifyContent="space-between" columnGap={2}>
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

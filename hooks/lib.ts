import type { DashItem, DashPart } from '../types'
import { PROVIDERS } from './catalog'

/** One entry of `sources` in usage-dash.json. */
export type SourceConfig = {
  id: string
  /** claude | codex | agnes-plan | openai-billing | deepseek | http-json */
  type: string
  label?: string
  /** A short glyph or emoji for the icon tile, and its color. */
  icon?: string
  color?: string
  enabled?: boolean
  warnPercent?: number
  /** deepseek: balance below which it is 告急, below twice this 偏紧 (default 5, 0 off). */
  warnBalance?: number
  /** openai-billing: API base ending in /v1. */
  baseUrl?: string
  /** Name of the environment variable holding the key. Never the key itself. */
  keyEnv?: string
  /** agnes-plan: env names of the login used to renew the token (default AGNES_EMAIL / AGNES_PASSWORD). */
  emailEnv?: string
  passwordEnv?: string
  /** codex: the codex executable (default "codex" on PATH). */
  bin?: string
  /** http-json (also deepseek's and agnes-plan's endpoint override). */
  url?: string
  method?: string
  headers?: Record<string, string>
  body?: string
  /** Where the key goes: env name, header (default Authorization), prefix (default "Bearer "). */
  auth?: { env: string; header?: string; prefix?: string }
  /** Dot path all other paths are under. */
  root?: string
  /** Quota windows read off the response. */
  windows?: WindowSpec[]
  /** Plain figures (a balance), shown as text. */
  values?: { name: string; path: string; unit?: string }[]
  /** Older single-figure form: dot path and unit. */
  path?: string
  unit?: string
}

/** One window of an http-json source: each field a dot path into the response. */
export type WindowSpec = {
  name: string
  used?: string
  limit?: string
  usedPercent?: string
  remainingPercent?: string
  /** Epoch seconds, epoch ms, or an ISO date. */
  resetsAt?: string
  resetInSeconds?: string
}

export type DashConfig = {
  refreshSeconds: number
  warnPercent: number
  /** Leave out of the band a source with no credentials or no reading (default true). */
  hideUnavailable: boolean
  sources: SourceConfig[]
}

export const DEFAULT_CONFIG: DashConfig = {
  refreshSeconds: 300,
  warnPercent: 20,
  hideUnavailable: true,
  sources: [
    { id: 'claude', type: 'claude' },
    { id: 'codex', type: 'codex' },
  ],
}

/** Reads the config text, falling back to defaults field by field. */
export function parseConfig(text: string | undefined): { config: DashConfig; error?: string } {
  if (text === undefined) return { config: DEFAULT_CONFIG }
  let raw: Partial<DashConfig>
  try {
    raw = JSON.parse(text)
  } catch (err) {
    return { config: DEFAULT_CONFIG, error: `配置文件不是合法 JSON：${(err as Error).message}` }
  }
  const num = (v: unknown, d: number, min: number) =>
    typeof v === 'number' && Number.isFinite(v) ? Math.max(min, v) : d
  const sources = Array.isArray(raw.sources)
    ? raw.sources.filter(
        (s): s is SourceConfig => !!s && typeof s.id === 'string' && typeof s.type === 'string',
      )
    : DEFAULT_CONFIG.sources
  return {
    config: {
      refreshSeconds: num(raw.refreshSeconds, DEFAULT_CONFIG.refreshSeconds, 30),
      warnPercent: num(raw.warnPercent, DEFAULT_CONFIG.warnPercent, 0),
      hideUnavailable: raw.hideUnavailable !== false,
      sources,
    },
  }
}

const WINDOW_NAMES: Record<string, string> = { five_hour: '5h', seven_day: '7d', spend_limit: '额度' }

export function claudeParts(
  limits: readonly { kind: string; percentUsed: number; resetsAt?: string }[],
): DashPart[] {
  return limits.map(l => ({
    name: WINDOW_NAMES[l.kind] ?? l.kind,
    remaining: clampPct(100 - l.percentUsed),
    resetsAt: l.resetsAt ? Date.parse(l.resetsAt) : undefined,
  }))
}

/** A reading kept from an earlier session: windows that have reset since are full again. */
export function carriedParts(parts: readonly DashPart[], now: number): DashPart[] {
  return parts.map(p => (p.resetsAt !== undefined && p.resetsAt <= now ? { ...p, remaining: 100, resetsAt: undefined } : p))
}

type CodexWindow = { usedPercent?: number; windowDurationMins?: number; resetsAt?: number }
export type CodexReport = {
  source: 'live' | 'recorded' | 'none'
  primary?: CodexWindow
  secondary?: CodexWindow
  planType?: string
  recordedAt?: string
  error?: string
}

export function codexWindowName(w: CodexWindow, fallback: string) {
  const m = w.windowDurationMins
  if (m === 300) return '5h'
  if (m === 10080) return '周'
  if (!m) return fallback
  return m % 1440 === 0 ? `${m / 1440}d` : m % 60 === 0 ? `${m / 60}h` : `${m}m`
}

/** A recorded window whose reset has passed counts as fully remaining. */
export function codexParts(report: CodexReport, now: number): DashPart[] {
  const parts: DashPart[] = []
  for (const [w, fb] of [
    [report.primary, '5h'],
    [report.secondary, '周'],
  ] as const) {
    if (!w || typeof w.usedPercent !== 'number') continue
    const resetsAt = w.resetsAt ? w.resetsAt * 1000 : undefined
    const isReset = resetsAt !== undefined && resetsAt <= now
    parts.push({
      name: codexWindowName(w, fb),
      remaining: isReset ? 100 : clampPct(100 - w.usedPercent),
      resetsAt: isReset ? undefined : resetsAt,
    })
  }
  return parts
}

/** new-api / one-api style `/dashboard/billing/*`: usage in cents. */
export function billingParts(sub: { hard_limit_usd?: number }, usage: { total_usage?: number }): DashPart[] {
  const used = (usage.total_usage ?? 0) / 100
  const limit = sub.hard_limit_usd
  if (typeof limit !== 'number' || limit >= 1e7) {
    return [{ name: '额度', text: '不限' }, { name: '已用', text: `$${fmtMoney(used)}` }]
  }
  return [
    { name: '余', remaining: limit > 0 ? clampPct(((limit - used) / limit) * 100) : 0 },
    { name: '', text: `$${fmtMoney(limit - used)}/${fmtMoney(limit)}` },
  ]
}

const CURRENCY: Record<string, string> = { CNY: '¥', USD: '$' }

/** The balance per currency; under `warnBalance` it is 告急, under twice that 偏紧 (0 turns it off). */
export function deepseekParts(
  body: {
    is_available?: boolean
    balance_infos?: { currency: string; total_balance: string }[]
  },
  warnBalance = DEFAULT_WARN_BALANCE,
): DashPart[] {
  const infos = body.balance_infos ?? []
  if (infos.length === 0) return [{ name: '余额', text: body.is_available ? '可用' : '不可用' }]
  return infos.map(i => {
    const n = Number(i.total_balance)
    const sign = CURRENCY[i.currency]
    const level = !Number.isFinite(n) || warnBalance <= 0 ? undefined : n < warnBalance ? 'low' : n < warnBalance * 2 ? 'warn' : undefined
    return { name: '余额', text: sign ? `${sign}${i.total_balance}` : `${i.total_balance} ${i.currency}`, level }
  })
}

export const DEFAULT_WARN_BALANCE = 5

export function pickPath(value: unknown, path: string | undefined): unknown {
  if (!path) return value
  let cur: unknown = value
  for (const key of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[key]
  }
  return cur
}

export const clampPct = (n: number) => Math.max(0, Math.min(100, Math.round(n)))
const fmtMoney = (n: number) => (Math.abs(n) >= 100 ? n.toFixed(0) : n.toFixed(2))

export function fmtDuration(ms: number): string {
  if (ms <= 0) return '0m'
  const min = Math.round(ms / 60000)
  if (min < 60) return `${min}m`
  const h = Math.floor(min / 60)
  if (h < 24) return `${h}h${min % 60 ? `${min % 60}m` : ''}`
  const d = Math.floor(h / 24)
  return `${d}d${h % 24 ? `${h % 24}h` : ''}`
}

export function partText(p: DashPart, now: number): string {
  const head = p.name ? `${p.name} ` : ''
  const count = countText(p)
  const body = (p.remaining !== undefined ? `${p.remaining}%` : (p.text ?? '')) + (count ? ` ${count}` : '')
  const tail = p.resetsAt !== undefined ? ` ↻${fmtDuration(p.resetsAt - now)}` : ''
  return `${head}${body}${tail}`
}

export type Level = 'ok' | 'warn' | 'low'
export function partLevel(p: DashPart, warnPercent: number): Level {
  if (p.level) return p.level
  if (p.remaining === undefined) return 'ok'
  if (p.remaining < warnPercent) return 'low'
  if (p.remaining < warnPercent * 2) return 'warn'
  return 'ok'
}

export function itemText(item: DashItem, now: number): string {
  if (item.error) return `${item.label} ${item.error}`
  const parts = item.parts.map(p => partText(p, now)).join(' · ')
  return `${item.label} ${parts}${item.note ? ` (${item.note})` : ''}`
}

/** "187/4000" for counted quotas, else nothing. */
export const countText = (p: DashPart) =>
  p.used !== undefined && p.limit !== undefined ? `${p.used}/${p.limit}` : ''

/** The reset as a short "2h10m", or nothing. */
export const resetText = (p: DashPart, now: number) =>
  p.resetsAt !== undefined ? fmtDuration(p.resetsAt - now) : ''

/** A bar of `width` cells, the filled share being what remains. */
export function barCells(remaining: number, width: number): [string, string] {
  const filled = Math.round((clampPct(remaining) / 100) * width)
  return ['━'.repeat(filled), '━'.repeat(width - filled)]
}

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** 充足 / 偏紧 / 告急, by the source's tightest window. */
export const LEVEL_LABEL: Record<Level, string> = { ok: '充足', warn: '偏紧', low: '告急' }
export const LEVEL_FILL: Record<Level, string> = { ok: '#22c55e', warn: '#f59e0b', low: '#ef4444' }

/** Default glyph and color per source type; `icon` and `color` in the config win. */
export function iconOf(type: string, label: string, icon?: string, color?: string): [string, string] {
  const p = PROVIDERS[type]
  return [icon ?? p?.icon ?? label.slice(0, 1).toUpperCase(), color ?? p?.color ?? '#64748b']
}

/** Two or more characters get the smaller monospace face; an emoji counts as one. */
const isWide = (glyph: string) => Array.from(glyph).length > 1

/**
 * What goes on an 18px icon tile whose top left is (x, y): the type's logo,
 * white, unless the config set its own `icon`; else the glyph as text, `cls`
 * and `cls small` being the face and its smaller variant.
 */
function tileMark(x: number, y: number, item: Pick<DashItem, 'type' | 'icon'>, glyph: string, cls: [string, string]) {
  const p = item.icon === undefined ? PROVIDERS[item.type] : undefined
  if (p?.logo) {
    // The logo's box fills the middle 14px of the tile.
    const [bx, by, side] = p.logoBox ?? [0, 0, 24]
    const k = 14 / side
    return `<path d="${p.logo}" fill="#fff" transform="translate(${(x + 2 - bx * k).toFixed(2)} ${(y + 2 - by * k).toFixed(2)}) scale(${k.toFixed(4)})"/>`
  }
  const wide = isWide(glyph)
  return `<text x="${x + 9}" y="${y + (wide ? 12.5 : 13.5)}" text-anchor="middle" class="${wide ? `${cls[0]} ${cls[1]}` : cls[0]}">${esc(glyph)}</text>`
}

/** The window with the least left, which the card's gauge shows. */
export function tightest(item: DashItem): DashPart | undefined {
  let best: DashPart | undefined
  for (const p of item.parts) {
    if (p.remaining === undefined) continue
    if (!best || p.remaining < (best.remaining ?? 100)) best = p
  }
  return best
}

const RANK: Record<Level, number> = { ok: 0, warn: 1, low: 2 }

/** The worst of the tightest window and any figure that has run low. */
export function itemLevel(item: DashItem): Level | undefined {
  const t = tightest(item)
  let level = t ? partLevel(t, item.warnPercent) : undefined
  for (const p of item.parts) if (p.level && (!level || RANK[p.level] > RANK[level])) level = p.level
  return level
}

/** What an alert shows of a part: its percentage, or its figure. */
export const partFigure = (p: DashPart) => (p.remaining !== undefined ? `${p.remaining}%` : (p.text ?? ''))

/**
 * The page of the expanded details that holds source `from`, `size` sources a
 * page: its first source, its number (from 1) and how many pages there are.
 */
export function pageOf(from: number, size: number, count: number): { start: number; page: number; pages: number } {
  const per = Math.max(1, Math.floor(size))
  const pages = Math.max(1, Math.ceil(count / per))
  const page = Math.min(pages, Math.max(1, Math.floor(Math.max(0, from) / per) + 1))
  return { start: (page - 1) * per, page, pages }
}

/** Windows below twice the threshold, tightest first: what the collapsed band and status line say. */
export function alerts(items: DashItem[]): { item: DashItem; part: DashPart; level: Level }[] {
  const out: { item: DashItem; part: DashPart; level: Level }[] = []
  for (const item of items) {
    for (const part of item.parts) {
      const level = partLevel(part, item.warnPercent)
      if (level !== 'ok') out.push({ item, part, level })
    }
  }
  return out.sort((a, b) => (a.part.remaining ?? 0) - (b.part.remaining ?? 0))
}

const ROW_H = 70
const ROW_GAP = 8
/** Room above the first card: the band's own gaps are a line tall, too much to spare. */
const PAD_T = 6
const ID_W = 196
const CELL_MIN = 118
const CELL_MAX = 176

/** A ring of `pct` with the number large in its middle. */
function gauge(cx: number, cy: number, r: number, pct: number, color: string) {
  const c = 2 * Math.PI * r
  const dash = (clampPct(pct) / 100) * c
  return [
    `<circle cx="${cx}" cy="${cy}" r="${r}" class="ring" fill="none" stroke-width="5"/>`,
    dash > 0
      ? `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${color}" stroke-width="5" stroke-linecap="round" stroke-dasharray="${dash.toFixed(1)} ${c.toFixed(1)}" transform="rotate(-90 ${cx} ${cy})"/>`
      : '',
    `<text x="${cx}" y="${cy + 5.5}" text-anchor="middle" class="big" style="fill:${color}">${clampPct(pct)}</text>`,
  ].join('')
}

/** A rounded bar, the lit share being what remains, cut into faint segments. */
function bar(x: number, y: number, w: number, pct: number, color: string) {
  const fw = (clampPct(pct) / 100) * w
  const ticks: string[] = []
  for (let i = 1; i < 10; i++) {
    const tx = (x + (w * i) / 10).toFixed(1)
    ticks.push(`<rect x="${tx}" y="${y}" width="1.5" height="6" class="tick"/>`)
  }
  return [
    `<rect x="${x}" y="${y}" width="${w}" height="6" rx="3" class="track"/>`,
    fw > 0 ? `<rect x="${x}" y="${y}" width="${Math.max(6, fw).toFixed(1)}" height="6" rx="3" fill="${color}"/>` : '',
    ticks.join(''),
  ].join('')
}

/**
 * The desktop band, expanded: one row per source, `width` px wide. On the left
 * the source (a gauge of its tightest window, icon, name, plan, status pill);
 * on the right a cell per window (name, percentage large, bar, count and reset).
 */
export function svgDashboard(items: DashItem[], now: number, width: number) {
  // As many cells as fit at their narrowest; a source with more shows the rest as one `+N` cell.
  const fit = Math.max(1, Math.floor((width - ID_W - 16) / CELL_MIN))
  const maxCells = Math.max(1, ...items.map(i => Math.min(i.parts.length, fit)))
  const cellW = Math.max(CELL_MIN, Math.min(CELL_MAX, (width - ID_W - 16) / maxCells))
  const W = Math.round(Math.max(width, ID_W + cellW * maxCells + 16))
  const H = PAD_T + items.length * ROW_H + (items.length - 1) * ROW_GAP
  const out: string[] = []
  items.forEach((item, ri) => {
    const y = PAD_T + ri * (ROW_H + ROW_GAP)
    const level = itemLevel(item)
    const accent = item.error ? '#94a3b8' : level ? LEVEL_FILL[level] : '#64748b'
    const [glyph, tint] = iconOf(item.type, item.label, item.icon, item.color)
    const id = `r${ri}`
    out.push(`<g transform="translate(0,${y})">`)
    out.push(`<clipPath id="${id}"><rect width="${W}" height="${ROW_H}" rx="14"/></clipPath>`)
    out.push(`<g clip-path="url(#${id})"><rect class="card" width="${W}" height="${ROW_H}"/><rect width="4" height="${ROW_H}" fill="${accent}"/></g>`)
    out.push(`<rect class="edge" x=".5" y=".5" width="${W - 1}" height="${ROW_H - 1}" rx="14" fill="none"/>`)

    // Identity: gauge, then icon and name over plan and status.
    const t = tightest(item)
    const gcx = 44
    const gcy = ROW_H / 2
    if (t && !item.error) out.push(gauge(gcx, gcy, 22, t.remaining ?? 0, LEVEL_FILL[partLevel(t, item.warnPercent)]))
    else out.push(`<circle cx="${gcx}" cy="${gcy}" r="22" class="ring" fill="none" stroke-width="5"/><text x="${gcx}" y="${gcy + 5}" text-anchor="middle" class="big dimfill">–</text>`)
    const nx = 80
    out.push(`<rect x="${nx}" y="${gcy - 22}" width="18" height="18" rx="5" fill="${tint}"/>`)
    out.push(tileMark(nx, gcy - 22, item, glyph, ['glyph', 'small']))
    out.push(`<text class="title" x="${nx + 25}" y="${gcy - 8}">${esc(fitText(item.label, ID_W - nx - 25 - 10, 14, true))}</text>`)
    const tag = item.error ? '异常' : level ? LEVEL_LABEL[level] : ''
    let sx = nx
    if (tag) {
      const tw = textWidth(tag, 11) + 22
      out.push(`<rect x="${sx}" y="${gcy + 5}" width="${tw}" height="20" rx="10" fill="${accent}" fill-opacity=".16"/>`)
      out.push(`<circle cx="${sx + 10}" cy="${gcy + 15}" r="3.5" fill="${accent}"/>`)
      out.push(`<text x="${sx + 17}" y="${gcy + 19}" class="pill" style="fill:${accent}">${tag}</text>`)
      sx += tw + 8
    }
    if (item.note) out.push(`<text class="dim" x="${sx}" y="${gcy + 19}">${esc(fitText(item.note, ID_W - sx - 10, 10.5))}</text>`)

    // Divider, then the windows.
    out.push(`<rect x="${ID_W}" y="14" width="1" height="${ROW_H - 28}" class="div"/>`)
    if (item.error) {
      out.push(`<text class="dim" x="${ID_W + 20}" y="${gcy + 4}">${esc(fitText(item.error, W - ID_W - 36, 10.5))}</text>`)
    } else {
      const { shown, hidden } = fitParts(item.parts, fit, item.warnPercent)
      shown.forEach((p, pi) => {
        const cx = ID_W + 16 + pi * cellW
        const inner = cellW - 24
        if (p.remaining === undefined) {
          out.push(`<text class="name" x="${cx}" y="25">${esc(fitText(p.name, inner, 11.5, true))}</text>`)
          out.push(`<text class="val" x="${cx}" y="45"${p.level ? ` style="fill:${LEVEL_FILL[p.level]}"` : ''}>${esc(fitText(p.text ?? '', inner, 12, true))}</text>`)
          return
        }
        const pl = partLevel(p, item.warnPercent)
        const color = LEVEL_FILL[pl]
        const pctW = textWidth(`${p.remaining}%`, 16, true)
        out.push(`<text class="name" x="${cx}" y="25">${esc(fitText(p.name, inner - pctW - 8, 11.5, true))}</text>`)
        out.push(`<text class="pct" x="${cx + inner}" y="26" text-anchor="end"${pl === 'ok' ? '' : ` style="fill:${color}"`}>${p.remaining}<tspan class="unit">%</tspan></text>`)
        out.push(bar(cx, 35, inner, p.remaining, color))
        const count = p.used !== undefined && p.limit !== undefined ? `${shortCount(p.used)}/${shortCount(p.limit)}` : ''
        const detail = [count, resetText(p, now) && `↻ ${resetText(p, now)}`].filter(Boolean).join(' · ')
        if (detail) out.push(`<text class="dim" x="${cx}" y="58">${esc(fitText(detail, inner, 10.5))}</text>`)
      })
      if (hidden.length) {
        const cx = ID_W + 16 + shown.length * cellW
        const inner = cellW - 24
        const low = hidden.reduce<number | undefined>((m, p) => (p.remaining === undefined ? m : Math.min(m ?? 100, p.remaining)), undefined)
        out.push(`<text class="name" x="${cx}" y="25">${esc(`+${hidden.length} 个窗口`)}</text>`)
        out.push(`<text class="dim" x="${cx}" y="45">${esc(fitText(low === undefined ? hidden.map(p => p.name).join('、') : `最低 ${low}%`, inner, 10.5))}</text>`)
      }
    }
    out.push('</g>')
  })
  const style = [
    'text{font-family:system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;font-size:12px;fill:#1f2328;font-variant-numeric:tabular-nums}',
    '.title{font-size:14px;font-weight:700}',
    '.glyph{font-size:11px;font-weight:800;fill:#fff}.glyph.small{font-size:8px;font-family:Consolas,monospace}',
    '.big{font-size:15px;font-weight:800}.dimfill{fill:#8c959f}',
    '.pct{font-size:16px;font-weight:700}.unit{font-size:10px;font-weight:600;fill:#8c959f}',
    '.pill{font-size:11px;font-weight:700}',
    '.name{fill:#57606a;font-size:11.5px;font-weight:600}.dim{fill:#8c959f;font-size:10.5px}.val{font-weight:700}',
    '.card{fill:rgba(127,127,127,.06)}.edge{stroke:rgba(127,127,127,.22)}.div{fill:rgba(127,127,127,.2)}',
    '.track{fill:rgba(127,127,127,.18)}.ring{stroke:rgba(127,127,127,.18)}.tick{fill:rgba(0,0,0,.18)}',
    '@media (prefers-color-scheme:dark){text{fill:#e6edf3}.glyph{fill:#fff}.name{fill:#9da7b3}.dim,.unit,.dimfill{fill:#7d8590}.tick{fill:rgba(0,0,0,.35)}}',
  ].join('')
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><style>${style}</style>${out.join('')}</svg>`
  return { svg, width: W, height: H }
}

type AgnesWindow = { used?: number; limit?: number; usage_pct?: number; reset_in_seconds?: number }
export type AgnesPlan = {
  plan_name?: string
  usage?: {
    text_generation?: { windowed?: AgnesWindow; weekly?: AgnesWindow }
    image_generation?: { daily?: AgnesWindow }
    video_generation?: { daily?: AgnesWindow }
  }
}

/** Agnes coding plan (`/api/cn/user/subscription`): text 5h and weekly, image and video daily. */
export function agnesPlanParts(plan: AgnesPlan, now: number): DashPart[] {
  const u = plan.usage ?? {}
  const rows: [string, AgnesWindow | undefined][] = [
    ['5h', u.text_generation?.windowed],
    ['周', u.text_generation?.weekly],
    ['图像', u.image_generation?.daily],
    ['视频', u.video_generation?.daily],
  ]
  const parts: DashPart[] = []
  for (const [name, w] of rows) {
    if (!w || typeof w.limit !== 'number') continue
    const used = w.used ?? 0
    const pct = typeof w.usage_pct === 'number' ? w.usage_pct : w.limit > 0 ? (used / w.limit) * 100 : 100
    parts.push({
      name,
      remaining: clampPct(100 - pct),
      used,
      limit: w.limit,
      resetsAt: typeof w.reset_in_seconds === 'number' ? now + w.reset_in_seconds * 1000 : undefined,
    })
  }
  return parts
}

/** A JWT's `exp` in epoch ms, or undefined when the token is not one. */
export function jwtExpiry(token: string): number | undefined {
  try {
    const seg = token.split('.')[1]
    if (!seg) return undefined
    const json = atob(seg.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(seg.length / 4) * 4, '='))
    const exp = (JSON.parse(json) as { exp?: number }).exp
    return typeof exp === 'number' ? exp * 1000 : undefined
  } catch {
    return undefined
  }
}

/** Rough text width in CSS px: CJK a full em, the rest about 0.58 em. */
export function textWidth(s: string, size: number, bold = false): number {
  let w = 0
  for (const ch of s) w += /[⺀-鿿＀-￯]/.test(ch) ? size : size * (bold ? 0.72 : 0.58)
  return w
}

/** 987654321 → "988M": a count that fits a cell; under ten thousand as it is. */
export function shortCount(n: number): string {
  const a = Math.abs(n)
  const [d, u] = a >= 1e9 ? [1e9, 'B'] : a >= 1e6 ? [1e6, 'M'] : a >= 1e4 ? [1e3, 'k'] : [1, '']
  if (d === 1) return String(n)
  const v = n / d
  return `${Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(1).replace(/\.0$/, '')}${u}`
}

/**
 * A card's windows when more than `fit` cells: the `fit - 1` tightest, in
 * their own order, and the rest for a `+N` cell; all of them when they fit.
 */
export function fitParts(parts: DashPart[], fit: number, warnPercent: number): { shown: DashPart[]; hidden: DashPart[] } {
  if (parts.length <= fit) return { shown: parts, hidden: [] }
  const rank = (p: DashPart) => [-RANK[partLevel(p, warnPercent)], p.remaining ?? 101] as const
  const keep = new Set(
    parts
      .map((p, i) => ({ i, r: rank(p) }))
      .sort((a, b) => a.r[0] - b.r[0] || a.r[1] - b.r[1] || a.i - b.i)
      .slice(0, Math.max(0, fit - 1))
      .map(x => x.i),
  )
  return { shown: parts.filter((_, i) => keep.has(i)), hidden: parts.filter((_, i) => !keep.has(i)) }
}

/** Icons stacked per group at the strip's right end before the rest are counted. */
const STACK = 3
/** The least an alert chip's name is cut to before the chip is left out. */
const MIN_NAME = 48
const ERROR_FILL = '#94a3b8'

/** The status badge: alerts first; with none, failures; else all clear. */
export const statusLine = (alertCount: number, brokenCount: number) =>
  alertCount ? `${alertCount} 项告警` : brokenCount ? `${brokenCount} 项异常` : '全部充足'

/** `s` cut to `maxW` px with an ellipsis, by the same rough measure. */
export function fitText(s: string, maxW: number, size: number, bold = false): string {
  if (textWidth(s, size, bold) <= maxW) return s
  let out = ''
  for (const ch of s) {
    if (textWidth(`${out}${ch}…`, size, bold) > maxW) break
    out += ch
  }
  return `${out}…`
}

/**
 * The desktop band, collapsed: one bar, `width` px wide. A status badge
 * (告警 count, or 全部充足); a chip per alerting window, tightest first, as
 * many as fit and then `+N`; at the right end the healthy sources as stacked
 * icons, and those that failed greyed.
 */
export function svgAlertStrip(items: DashItem[], now: number, width: number) {
  const H = 36
  const W = Math.max(100, Math.round(width))
  const out: string[] = []
  const tile = (x: number, item: DashItem, glyph: string, tint: string, ring = false) =>
    `${ring ? `<rect x="${x - 1.5}" y="7.5" width="21" height="21" rx="6.5" class="bgfill"/>` : ''}<rect x="${x}" y="9" width="18" height="18" rx="5" fill="${tint}"/>${tileMark(x, 9, item, glyph, ['g', 's'])}`

  const found = alerts(items)
  const worst = found[0]?.level
  const broken = items.filter(i => i.error)
  // With no alert, failures are what there is to say: never 全部充足 over them.
  const statusColor = worst ? LEVEL_FILL[worst] : broken.length ? ERROR_FILL : LEVEL_FILL.ok
  const statusText = statusLine(found.length, broken.length)
  const sw = textWidth(statusText, 12, true) + 30
  out.push(`<rect x="0" y="6" width="${sw}" height="24" rx="8" fill="${statusColor}" fill-opacity=".16"/>`)
  out.push(worst === 'low'
    ? `<path d="M11 12.5 L15.5 21 L6.5 21 Z" fill="${statusColor}"/>`
    : `<circle cx="11" cy="18" r="4" fill="${statusColor}"/>`)
  out.push(`<text x="21" y="22.5" class="st" style="fill:${statusColor}">${statusText}</text>`)

  // The right end: healthy sources stacked, failed ones greyed.
  const okItems = items.filter(i => !i.error && !found.some(f => f.item.id === i.id))
  const groups: { list: DashItem[]; label: string; grey: boolean }[] = []
  if (okItems.length) groups.push({ list: okItems, label: '正常', grey: false })
  if (broken.length) groups.push({ list: broken, label: '异常', grey: true })
  // At most `stack` icons a group, the rest counted, so the alerts keep their room.
  const layoutRight = (stack: number) => {
    let rx = W
    const right: string[] = []
    for (const g of [...groups].reverse()) {
      const label = g.list.length > stack ? `+${g.list.length - stack} ${g.label}` : g.label
      rx -= textWidth(label, 11)
      right.push(`<text x="${rx}" y="22" class="d">${label}</text>`)
      rx -= 6
      const icons = g.list.slice(0, stack)
      rx -= 18 + (icons.length - 1) * 13
      icons.forEach((i, k) => {
        const [glyph, tint] = iconOf(i.type, i.label, i.icon, i.color)
        right.push(`<g${g.grey ? ' opacity=".4"' : ''}>${tile(rx + k * 13, i, glyph, tint, k > 0)}</g>`)
      })
      rx -= 14
    }
    if (groups.length) right.push(`<rect x="${rx + 4}" y="10" width="1" height="16" class="div"/>`)
    return { rx, right }
  }
  // The first alert whole, its name up to 150 px, and `+N` after it: the stacks
  // shrink to one icon each before that chip is cut.
  const firstChip = (f: (typeof found)[number]) =>
    24 + Math.min(150, textWidth(`${f.item.label} · ${f.part.name}`, 12)) + 6 + textWidth(partFigure(f.part), 14, true) + (found.length > 1 ? 34 : 0)
  let { rx, right } = layoutRight(STACK)
  if (found[0] && sw + 14 + firstChip(found[0]) > rx - 4) ({ rx, right } = layoutRight(1))
  // Narrower still, the right end goes before it overlaps the status: the details list those sources.
  if (rx - 4 < sw + 14 + (found.length ? 34 : 0)) ({ rx, right } = { rx: W, right: [] })

  // The middle: the alerts, as many as fit before the right end; the first
  // one's name cut to the room there is rather than left out.
  let x = sw + 14
  const limit = rx - 4
  let shown = 0
  for (const { item, part, level } of found) {
    const color = LEVEL_FILL[level]
    const [glyph, tint] = iconOf(item.type, item.label, item.icon, item.color)
    const pct = esc(partFigure(part))
    const moreW = found.length - shown > 1 ? 34 : 0
    const room = limit - x - 24 - 6 - textWidth(pct, 14, true) - moreW
    const name = fitText(`${item.label} · ${part.name}`, shown === 0 ? Math.max(MIN_NAME, Math.min(150, room)) : 150, 12)
    const w = 24 + textWidth(name, 12) + 6 + textWidth(pct, 14, true)
    if (x + w + moreW > limit) break
    out.push(tile(x, item, glyph, tint))
    out.push(`<text x="${x + 24}" y="22.5" class="n">${esc(name)}</text>`)
    out.push(`<text x="${x + 24 + textWidth(name, 12) + 6}" y="23" class="p" style="fill:${color}">${pct}</text>`)
    x += w + 18
    shown++
  }
  if (shown < found.length && x + 30 <= W) {
    out.push(`<rect x="${x}" y="9" width="30" height="18" rx="9" class="more"/><text x="${x + 15}" y="22" text-anchor="middle" class="d">+${found.length - shown}</text>`)
  }
  out.push(...right)

  const style = [
    'text{font-family:system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;font-variant-numeric:tabular-nums}',
    '.bar{fill:rgba(127,127,127,.07);stroke:rgba(127,127,127,.22)}.bgfill{fill:#f6f8fa}',
    '.st{font-size:12px;font-weight:700}.n{font-size:12px;fill:#57606a}.p{font-size:14px;font-weight:800}',
    '.d{font-size:11px;fill:#8c959f}.div{fill:rgba(127,127,127,.25)}.more{fill:rgba(127,127,127,.16)}',
    '.g{font-size:11px;font-weight:800;fill:#fff}.g.s{font-size:8px;font-family:Consolas,monospace}',
    '@media (prefers-color-scheme:dark){.n{fill:#c9d1d9}.d{fill:#8b949e}.bgfill{fill:#262626}}',
  ].join('')
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><style>${style}</style>${out.join('')}</svg>`
  return { svg, width: W, height: H }
}

/** A reset given as epoch seconds, epoch ms or an ISO date → epoch ms. */
export function toEpochMs(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v < 1e12 ? v * 1000 : v
  if (typeof v === 'string' && v.trim()) {
    const n = Number(v)
    if (Number.isFinite(n)) return toEpochMs(n)
    const t = Date.parse(v)
    return Number.isNaN(t) ? undefined : t
  }
  return undefined
}

const num = (v: unknown) => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN)

/** http-json: the windows and values the config maps out of a response. */
export function httpJsonParts(body: unknown, s: SourceConfig, now: number): DashPart[] {
  const at = (path: string | undefined) => (path ? pickPath(pickPath(body, s.root), path) : undefined)
  const parts: DashPart[] = []
  for (const w of s.windows ?? []) {
    const used = num(at(w.used))
    const limit = num(at(w.limit))
    const usedPct = num(at(w.usedPercent))
    const leftPct = num(at(w.remainingPercent))
    const remaining = Number.isFinite(leftPct)
      ? leftPct
      : Number.isFinite(usedPct)
        ? 100 - usedPct
        : Number.isFinite(used) && Number.isFinite(limit) && limit > 0
          ? 100 - (used / limit) * 100
          : undefined
    const inSec = num(at(w.resetInSeconds))
    parts.push({
      name: w.name,
      remaining: remaining === undefined ? undefined : clampPct(remaining),
      text: remaining === undefined ? '无读数' : undefined,
      used: Number.isFinite(used) ? used : undefined,
      limit: Number.isFinite(limit) ? limit : undefined,
      resetsAt: Number.isFinite(inSec) ? now + inSec * 1000 : toEpochMs(at(w.resetsAt)),
    })
  }
  const values = s.values ?? (s.path ? [{ name: '', path: s.path, unit: s.unit }] : [])
  for (const v of values) {
    const value = at(v.path)
    parts.push({ name: v.name, text: `${value === undefined ? '—' : String(value)}${v.unit ? ` ${v.unit}` : ''}` })
  }
  return parts
}

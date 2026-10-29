import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { parseCmdSet, parseRegQuery } from '../hooks/env'
import { PROVIDERS } from '../hooks/catalog'
import {
  agnesPlanParts,
  billingParts,
  codexParts,
  deepseekParts,
  fitParts,
  fitText,
  fmtDuration,
  httpJsonParts,
  jwtExpiry,
  parseConfig,
  pageOf,
  shortCount,
  statusLine,
  svgAlertStrip,
  svgDashboard,
  textWidth,
} from '../hooks/lib'

// The kit's command.run takes the full input; the test needs only the name.
const RUN = { command: 'usage-dash', args: '' } as never
const NOW = Date.parse('2026-10-29T08:00:00Z')

const BAND = {
  plugin: 'usage-dash',
  component: 'AbovePrompt',
  requestId: 'above-prompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 120,
    scroll: { offset: 0, bodyRows: 9 },
    view: {},
  },
} as const

const CODEX = JSON.stringify({
  source: 'live',
  primary: { usedPercent: 0, windowDurationMins: 300, resetsAt: NOW / 1000 + 3600 },
  secondary: { usedPercent: 85, windowDurationMins: 10080, resetsAt: NOW / 1000 + 86400 * 3 },
  planType: 'plus',
})

const b64url = (o: object) => btoa(JSON.stringify(o)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')
// A login token that expires in three days.
const TOKEN = `${b64url({ alg: 'HS256' })}.${b64url({ sub: '1', exp: NOW / 1000 + 3 * 86400 + 60 })}.sig`

const win = (used: number, limit: number, inSec: number) => ({
  used,
  limit,
  usage_pct: Math.round((used / limit) * 1000) / 10,
  reset_in_seconds: inSec,
})
const PLAN = {
  code: 200,
  data: {
    plan_name: '入门版',
    usage: {
      text_generation: { windowed: win(0, 1500, 6249), weekly: win(9, 15000, 287049) },
      image_generation: { daily: win(187, 4000, 27849) },
      video_generation: { daily: { ...win(516, 500, 27849), usage_pct: 100 } },
    },
  },
}

const LOGIN_TOKEN = `${b64url({ alg: 'HS256' })}.${b64url({ sub: '1', exp: NOW / 1000 + 28 * 86400 })}.sig2`

/** The three sources the person had set up. */
const THREE = JSON.stringify({
  sources: [
    { id: 'claude', type: 'claude' },
    { id: 'codex', type: 'codex' },
    { id: 'agnes', type: 'agnes-plan', label: 'Agnes' },
  ],
})

type EngineOpts = {
  codexOut?: string
  agnesKey?: string
  login?: boolean
  logins?: string[]
  /** The config file's text; absent, the three sources above. `null`: no file. */
  config?: string | null
  /** What a write to the config file wrote, last first. */
  writes?: string[]
  vars?: Record<string, string>
  routes?: Record<string, unknown>
  /** The session has no reading yet, as before its first reply. */
  noReading?: boolean
  /** What `$.store` holds: read and written in place, so a test sees the writes. */
  store?: Record<string, unknown>
}

/** Stands for the engine on Windows: usage, codex helper, Agnes plan, the config file, `set NAME`. */
function engine(on: On, opts: EngineOpts = {}) {
  const vars: Record<string, string> = {
    ...(opts.agnesKey ? { AGNES_PLATFORM_TOKEN: opts.agnesKey } : {}),
    ...(opts.login ? { AGNES_EMAIL: 'me@example.com', AGNES_PASSWORD: 'pw' } : {}),
    ...opts.vars,
  }
  let file: string | undefined = opts.config === null ? undefined : (opts.config ?? THREE)
  mock.clock(on, { now: NOW })
  mock.env(on, { USERPROFILE: 'C:\Users\tester', OS: 'Windows_NT' })
  const store = opts.store ?? {}
  on('store.get', (_, e) => ({ value: store[e.key] }))
  on('store.set', (_, e) => {
    store[e.key] = JSON.parse(JSON.stringify(e.value))
    return { value: undefined }
  })
  on('command.register', () => ({ value: { command: 'usage-dash' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('fs.read', () => {
    if (file !== undefined) return { value: file }
    throw new Error('ENOENT')
  })
  on('fs.write', (_, e) => {
    file = e.text
    opts.writes?.unshift(e.text)
    return { value: undefined }
  })
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: {},
      rateLimits: opts.noReading ? [] : [
        { kind: 'five_hour', percentUsed: 18, resetsAt: new Date(NOW + 2 * 3600e3).toISOString() },
        { kind: 'seven_day', percentUsed: 36 },
      ],
    } as never,
  }))
  on('process.run', (_, e) => {
    if (e.argv[0] === 'node') return { value: { exitCode: 0, stdout: `${opts.codexOut ?? CODEX}\n`, stderr: '' } as never }
    if (e.argv[0] === 'cmd') {
      const name = e.argv[4] ?? ''
      const v = vars[name]
      return { value: { exitCode: v ? 0 : 1, stdout: v ? `${name}=${v}\r\n` : '', stderr: '' } as never }
    }
    return { value: { exitCode: 1, stdout: '', stderr: 'not found' } as never }
  })
  on('http.fetch', (_, e) => {
    if (opts.routes && e.url in opts.routes) {
      return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(opts.routes[e.url]) } as never }
    }
    if (e.url.endsWith('/api/user/login')) {
      opts.logins?.push(String(e.init?.body))
      const ok = JSON.parse(String(e.init?.body)).password === 'pw'
      const text = ok
        ? JSON.stringify({ code: 200, data: { access_token: LOGIN_TOKEN } })
        : JSON.stringify({ code: 401, message: 'Invalid username or password', data: null })
      return { value: { status: 200, ok: true, headers: {}, text } as never }
    }
    const auth = (e.init?.headers as Record<string, string> | undefined)?.Authorization
    if (auth !== `Bearer ${TOKEN}` && auth !== `Bearer ${LOGIN_TOKEN}`) {
      return { value: { status: 401, ok: false, headers: {}, text: '{"code":401,"message":"Not logged in","data":null}' } as never }
    }
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(PLAN) } as never }
  })
}

test('the command lists all three sources', async ($, on) => {
  engine(on, { agnesKey: TOKEN })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const { text } = await $.command.run(RUN)

  expect(text).toContain('Claude 5h 82% ↻2h')
  expect(text).toContain('7d 64%')
  expect(text).toContain('Codex 5h 100% ↻1h · 周 15% ↻3d')
  expect(text).toContain('Agnes 5h 100% 0/1500 ↻1h44m · 周 100% 9/15000 ↻3d7h · 图像 95% 187/4000 ↻7h44m · 视频 0% 516/500')
  expect(text).toContain('(入门版)')
})

test('a reading is kept for the next session', async ($, on) => {
  const store: Record<string, unknown> = {}
  engine(on, { agnesKey: TOKEN, store })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.command.run(RUN)

  const kept = store.claudeReading as { at: number; parts: { name: string; remaining: number }[] }
  expect(kept.at).toBe(NOW)
  expect(kept.parts.map(p => `${p.name} ${p.remaining}`)).toEqual(['5h 82', '7d 64'])
})

test('before its first reply, a session shows the last reading, dated, with reset windows full', async ($, on) => {
  const parts = [
    { name: '5h', remaining: 10, resetsAt: NOW - 3600e3 },
    { name: '7d', remaining: 64, resetsAt: NOW + 3 * 86400e3 },
  ]
  engine(on, { agnesKey: TOKEN, noReading: true, store: { claudeReading: { parts, at: NOW - 30 * 60e3 } } })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const { text } = await $.command.run(RUN)

  expect(text).toContain('Claude 5h 100% · 7d 64% ↻3d (30m前的读数)')
})

test('with no token and no login, the band says which variables are missing', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const { text } = await $.command.run(RUN)

  expect(text).toContain('Agnes 缺少环境变量 AGNES_EMAIL / AGNES_PASSWORD')
})

test('with a login only, it logs in once and keeps the token in memory', async ($, on) => {
  const logins: string[] = []
  engine(on, { login: true, logins })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.command.run(RUN)
  const { text } = await $.command.run(RUN)

  expect(text).toContain('Agnes 5h 100% 0/1500')
  expect(logins.length).toBe(1)
  expect(logins[0]).toContain('"username":"me@example.com"')
})

test('a stale token is renewed by logging in', async ($, on) => {
  engine(on, { agnesKey: 'stale', login: true })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const { text } = await $.command.run(RUN)

  expect(text).toContain('Agnes 5h 100% 0/1500')
})

test('a stale token with no login says so', async ($, on) => {
  engine(on, { agnesKey: 'stale' })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const { text } = await $.command.run(RUN)

  expect(text).toContain('Agnes token 失效，缺少环境变量 AGNES_EMAIL / AGNES_PASSWORD')
})

test('the band draws the dashboard and keeps what is beneath, on terminal and desktop', async ($, on) => {
  engine(on, { agnesKey: TOKEN })
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>other band</Text>
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.command.run(RUN)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    // Collapsed: only the alerts, tightest first, and no details yet.
    if (surface === 'desktop') {
      const strip = await ui.find({ type: 'Svg' })
      expect(String(strip?.props.alt)).toContain('Agnes 告急 视频 0% 516/500')
      expect(String(strip?.props.alt)).not.toContain('Claude 告急')
      expect(String(strip?.props.source)).toContain('2 项告警')
      expect((await ui.find({ type: 'Button', key: 'toggle' }))?.props.label).toBe('详情 ▾')
    } else {
      const line = await ui.find({ type: 'Button', key: 'toggle' })
      expect(line?.text).toContain('▲ 2 项告警')
      expect(line?.text).toContain('A Agnes·视频 0%')
      expect(line?.text).toContain('>_ Codex·周 15%')
      expect(line?.text).toContain('✓ Claude')
      expect(line?.text).toContain('详情 ▾')
      expect(await ui.find({ type: 'Svg' })).toBe(undefined)
    }
    expect((await ui.find({ type: 'Text', text: /other band/ }))?.text).toBe('other band')

    // A press opens the details.
    await ui.press({ key: 'toggle' })
    const toggled = await ui.find({ type: 'Button', key: 'toggle' })
    expect(surface === 'desktop' ? toggled?.props.label : toggled?.text).toContain('收起 ▴')
    if (surface === 'desktop') {
      const svg = (await ui.findAll({ type: 'Svg' }))[1]
      expect(String(svg?.props.alt)).toContain('Codex 5h 100% ↻1h · 周 15% ↻3d')
      expect(String(svg?.props.source)).toContain('告急')
    } else {
      expect((await ui.find({ type: 'Text', text: /^>_ Codex$/ }))?.text).toBe('>_ Codex')
      expect((await ui.find({ type: 'Text', text: /周\s+━+\s+15%/ }))?.text).toContain('↻3d')
    }
    expect((await ui.find({ type: 'Text', text: /other band/ }))?.text).toBe('other band')
    await ui.press({ key: 'toggle' })
    await ui.unmount()
  }
})

test('all clear says so in one line', async ($, on) => {
  engine(on, {
    agnesKey: TOKEN,
    codexOut: JSON.stringify({ source: 'live', primary: { usedPercent: 10, windowDurationMins: 300 } }),
    // Agnes left out: its video window is over its limit.
    config: JSON.stringify({ sources: [{ id: 'codex', type: 'codex', label: 'Codex' }] }),
  })
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.command.run(RUN)

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find({ type: 'Button', key: 'toggle' }))?.text).toContain('● 全部充足')
  await ui.unmount()
})

test('a low window raises one toast', async ($, on) => {
  engine(on, { agnesKey: TOKEN })
  const toasts: string[] = []
  on('ui.toast', (_, e) => {
    toasts.push(String((e as { text?: string }).text ?? JSON.stringify(e)))
    return { value: undefined } as never
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.command.run(RUN)
  await $.command.run(RUN)

  // Codex weekly at 15% and Agnes video at 0%: one toast naming both, once across two refreshes.
  expect(toasts.length).toBe(1)
  expect(toasts[0]).toContain('2 项额度偏低')
  expect(toasts[0]).toContain('Codex 周 15%')
  expect(toasts[0]).toContain('Agnes 视频 0%')
})

test('display off leaves the band to the engine', { options: { display: 'off' } }, async ($, on) => {
  engine(on, { agnesKey: TOKEN })
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.command.run(RUN)

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /Codex/ })).toBe(undefined)
  await ui.unmount()
})

test('helpers', async () => {
  expect(parseConfig('{bad').error).toContain('JSON')
  expect(parseConfig('{"refreshSeconds":5,"sources":[{"id":"x","type":"claude"}]}').config.refreshSeconds).toBe(30)
  expect(parseCmdSet('AGNES_EMAIL=a@b.c\r\nAGNES_EMAILX=no\r\n', 'AGNES_EMAIL')).toBe('a@b.c')
  expect(parseCmdSet('AGNES_EMAILX=no\r\n', 'AGNES_EMAIL')).toBe(undefined)
  expect(parseRegQuery('\r\nHKEY_CURRENT_USER\\Environment\r\n    K    REG_SZ    abc123\r\n')).toBe('abc123')
  expect(fmtDuration(3 * 86400e3 + 2 * 3600e3)).toBe('3d2h')
  expect(billingParts({ hard_limit_usd: 10 }, { total_usage: 250 })[0]?.remaining).toBe(75)
  // A recorded window whose reset has passed is full again.
  expect(agnesPlanParts(PLAN.data, NOW).map(p => p.remaining)).toEqual([100, 100, 95, 0])
  expect(jwtExpiry(TOKEN)).toBe(NOW + 3 * 86400e3 + 60e3)
  expect(jwtExpiry('not-a-jwt')).toBe(undefined)
  expect(codexParts({ source: 'recorded', primary: { usedPercent: 90, resetsAt: 1 } }, NOW)[0]?.remaining).toBe(100)
})

test('an unset source is hidden from the band, listed by the command', async ($, on) => {
  engine(on, {
    config: JSON.stringify({ sources: [{ id: 'codex', type: 'codex' }, { id: 'ds', type: 'deepseek' }] }),
  })
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const { text } = await $.command.run(RUN)
  expect(text).toContain('DeepSeek 缺少环境变量 DEEPSEEK_API_KEY（未配置，横条里隐藏）')

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find({ type: 'Button', key: 'toggle' }))?.text).not.toContain('DeepSeek')
  await ui.unmount()
})

test('add, disable and remove edit the config file', async ($, on) => {
  const writes: string[] = []
  engine(on, { config: JSON.stringify({ refreshSeconds: 120, sources: [{ id: 'codex', type: 'codex' }] }), writes })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const run = (args: string) => $.command.run({ command: 'usage-dash', args } as never)

  expect((await run('add deepseek')).text).toContain('已添加 `deepseek`')
  expect((await run('add deepseek')).text).toContain('已添加 `deepseek2`')
  let saved = JSON.parse(writes[0]!)
  expect(saved.refreshSeconds).toBe(120)
  expect(saved.sources.map((s: { id: string }) => s.id)).toEqual(['codex', 'deepseek', 'deepseek2'])
  expect(saved.sources[1].keyEnv).toBe('DEEPSEEK_API_KEY')

  await run('disable codex')
  await run('remove deepseek2')
  saved = JSON.parse(writes[0]!)
  expect(saved.sources).toEqual([{ id: 'codex', type: 'codex', enabled: false }, { id: 'deepseek', type: 'deepseek', keyEnv: 'DEEPSEEK_API_KEY', warnBalance: 5 }])
  expect((await run('add nope')).text).toContain('未知类型 nope')
  expect((await run('types')).text).toContain('`http-json`')
})

test('an http-json source maps windows and values from the config alone', async ($, on) => {
  engine(on, {
    vars: { MY_KEY: 'k' },
    config: JSON.stringify({
      sources: [
        {
          id: 'mm',
          type: 'http-json',
          label: 'MiniMax',
          url: 'https://api.example.com/usage',
          auth: { env: 'MY_KEY' },
          root: 'data',
          windows: [{ name: '5h', used: 'win.used', limit: 'win.limit', resetInSeconds: 'win.reset' }],
          values: [{ name: '余额', path: 'balance', unit: '元' }],
        },
      ],
    }),
    routes: { 'https://api.example.com/usage': { data: { win: { used: 30, limit: 120, reset: 3600 }, balance: 8.5 } } },
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const { text } = await $.command.run(RUN)

  expect(text).toContain('MiniMax 5h 75% 30/120 ↻1h · 余额 8.5 元')
})

test('a type with a logo draws it on the tile, unless the config sets an icon', async () => {
  const item = (id: string, type: string, icon?: string) => ({
    id,
    type,
    label: id,
    icon,
    parts: [{ name: '余额', text: '1 CNY' }],
    warnPercent: 20,
  })
  const whale = PROVIDERS.deepseek!.logo!
  const mark = PROVIDERS['agnes-plan']!.logo!
  const { svg } = svgDashboard([item('ds', 'deepseek'), item('ag', 'agnes-plan')], NOW, 800)
  expect(svg).toContain(`d="${whale}"`)
  expect(svg).toContain(`d="${mark}"`)
  expect(svgAlertStrip([item('ds', 'deepseek')], NOW, 600).svg).toContain(`d="${whale}"`)
  const own = svgDashboard([item('ds', 'deepseek', 'Q')], NOW, 800).svg
  expect(own).not.toContain(whale)
  expect(own).toContain('>Q</text>')
})

test('long names are cut to their room rather than run into the windows', async () => {
  expect(fitText('Claude', 80, 14, true)).toBe('Claude')
  const cut = fitText('一个名字特别长的中转站', 80, 14, true)
  expect(cut.endsWith('…')).toBe(true)
  expect(textWidth(cut, 14, true)).toBeLessThanOrEqual(80)
  const { svg } = svgDashboard([{ id: 'r', type: 'openai-billing', label: '一个名字特别长的中转站', parts: [{ name: '余', remaining: 5 }], warnPercent: 20 }], NOW, 760)
  expect(svg).not.toContain('一个名字特别长的中转站<')
})

test('too much to show: failures are never all clear, stacks and windows are capped, counts shortened', async () => {
  const src = (id: string, extra: object = {}) =>
    ({ id, type: 'claude', label: id, parts: [{ name: '5h', remaining: 90 }], warnPercent: 20, ...extra }) as never
  // Every source failed: the badge says so.
  const failed = svgAlertStrip(Array.from({ length: 12 }, (_, i) => src(`s${i}`, { parts: [], error: 'HTTP 502' })), NOW, 468)
  expect(failed.svg).toContain('12 项异常')
  expect(failed.svg).not.toContain('全部充足')
  expect(statusLine(0, 0)).toBe('全部充足')
  expect(statusLine(2, 5)).toBe('2 项告警')
  // Twelve healthy: three icons and the rest counted.
  const healthy = svgAlertStrip(Array.from({ length: 12 }, (_, i) => src(`s${i}`)), NOW, 468)
  expect(healthy.svg).toContain('+9 正常')
  expect(healthy.svg.match(/<rect x="[\d.]+" y="9" width="18"/g)?.length).toBe(3)
  // With both stacks full, an alert still gets its chip at the narrowest strip.
  const crowded = svgAlertStrip(
    [
      ...Array.from({ length: 6 }, (_, i) => src(`ok${i}`)),
      ...Array.from({ length: 6 }, (_, i) => src(`x${i}`, { parts: [], error: 'HTTP 500' })),
      src('low', { label: 'Low', parts: [{ name: '5h', remaining: 3 }] }),
    ],
    NOW,
    468,
  )
  expect(crowded.svg).toContain('Low · 5h')
  // Ten alerts and both stacks full at the narrowest: the stacks give way, one chip still shows.
  const tenAlerts = svgAlertStrip(
    [
      ...Array.from({ length: 6 }, (_, i) => src(`ok${i}`)),
      ...Array.from({ length: 6 }, (_, i) => src(`x${i}`, { parts: [], error: 'HTTP 500' })),
      ...Array.from({ length: 5 }, (_, i) => src(`a${i}`, { label: `告警${i}`, parts: [{ name: '5h', remaining: 3 }, { name: '周', remaining: 30 }] })),
    ],
    NOW,
    468,
  )
  expect(tenAlerts.svg).toContain('告警0 · 5h')
  expect(tenAlerts.svg).toContain('+5 正常')
  expect(tenAlerts.svg).toContain('+5 异常')

  // Ten windows in a 560 px card: no wider than the slot, the tightest kept, the rest one +N cell.
  const ten = Array.from({ length: 10 }, (_, i) => ({ name: `w${i}`, remaining: i === 7 ? 5 : 60 + i }))
  const card = svgDashboard([src('many', { parts: ten })], NOW, 560)
  expect(card.width).toBe(560)
  expect(card.svg).toContain('>w7<')
  expect(card.svg).toMatch(/\+\d+ 个窗口/)
  const { shown, hidden } = fitParts(ten, 3, 20)
  expect(shown.map(p => p.name)).toEqual(['w0', 'w7'])
  expect(hidden.length).toBe(8)
  expect(fitParts(ten.slice(0, 2), 3, 20).hidden).toEqual([])

  expect(shortCount(4000)).toBe('4000')
  expect(shortCount(15000)).toBe('15k')
  expect(shortCount(123456)).toBe('123k')
  expect(shortCount(1000000)).toBe('1M')
  expect(shortCount(987654321)).toBe('988M')
  expect(shortCount(1234567890)).toBe('1.2B')
})

test('on the terminal, many sources keep the summary to counts', async ($, on) => {
  engine(on, {
    config: JSON.stringify({
      sources: [
        ...Array.from({ length: 5 }, (_, i) => ({ id: `h${i}`, type: 'http-json', label: `H${i}`, url: `https://h${i}.test/u`, windows: [{ name: '5h', remainingPercent: 'p' }] })),
        ...Array.from({ length: 4 }, (_, i) => ({ id: `b${i}`, type: 'http-json', label: `B${i}`, url: `https://b${i}.test/u` })),
      ],
    }),
    routes: Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`https://h${i}.test/u`, { p: 90 }])),
  })
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run(RUN)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  const line = String((await ui.find({ type: 'Button', key: 'toggle' }))?.text)
  expect(line).toContain('○ 4 项异常')
  expect(line).toContain('✓ 5 项正常')
  expect(line).not.toContain('全部充足')
  await ui.unmount()
})

test('several windows going low at once are one toast', async ($, on) => {
  engine(on, {
    agnesKey: TOKEN,
    codexOut: JSON.stringify({ source: 'live', primary: { usedPercent: 95, windowDurationMins: 300 }, secondary: { usedPercent: 90, windowDurationMins: 10080 } }),
  })
  const toasts: string[] = []
  on('ui.toast', (_, e) => {
    toasts.push(String((e as { text?: string }).text ?? JSON.stringify(e)))
    return { value: undefined } as never
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.command.run(RUN)
  await $.command.run(RUN)

  // Codex 5h, Codex weekly and Agnes video, low together: one toast, and not again.
  expect(toasts.length).toBe(1)
  expect(toasts[0]).toContain('3 项额度偏低')
})

test('pages of the details', async () => {
  expect(pageOf(0, 2, 4)).toEqual({ start: 0, page: 1, pages: 2 })
  expect(pageOf(3, 2, 4)).toEqual({ start: 2, page: 2, pages: 2 })
  // Out of range, as after a source was removed: the nearest page.
  expect(pageOf(9, 2, 3)).toEqual({ start: 2, page: 2, pages: 2 })
  expect(pageOf(-2, 2, 3)).toEqual({ start: 0, page: 1, pages: 2 })
  expect(pageOf(0, 2, 0)).toEqual({ start: 0, page: 1, pages: 1 })
})

test('expanded on the desktop, the pager turns the details beneath the header', async ($, on) => {
  engine(on, { agnesKey: TOKEN })
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.command.run(RUN)

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  // Collapsed: no pager.
  expect(await ui.find({ type: 'Button', key: 'next' })).toBe(undefined)
  await ui.press({ key: 'toggle' })
  // The header strip and the details, and nothing under them: the pager sits in the header.
  const svgs = () => ui.findAll({ type: 'Svg' })
  const details = async () => String((await svgs())[1]?.props.alt)
  expect((await svgs()).length).toBe(2)
  expect((await ui.find({ type: 'Text', text: '1/2' }))?.text).toBe('1/2')
  expect(await details()).toContain('Claude')
  expect(await details()).toContain('Codex')
  expect(await details()).not.toContain('Agnes')
  // Square buttons, not plain text, beside the toggle.
  const nextBtn = await ui.find({ type: 'Button', key: 'next' })
  expect(nextBtn?.props.label).toBe('›')
  expect(nextBtn?.props.plain).not.toBe(true)
  expect((await ui.find({ type: 'Button', key: 'toggle' }))?.props.label).toBe('收起 ▴')

  await ui.press({ key: 'next' })
  expect((await ui.find({ type: 'Text', text: '2/2' }))?.text).toBe('2/2')
  expect(await details()).toContain('Agnes')
  expect(await details()).not.toContain('Claude')
  expect(String((await svgs())[0]?.props.source)).toContain('项告警')

  // Past the last page it comes round to the first.
  await ui.press({ key: 'next' })
  expect(await details()).toContain('Claude')
  await ui.press({ key: 'prev' })
  expect(await details()).toContain('Agnes')
  await ui.unmount()
})

test('a DeepSeek balance under its threshold alerts like a low window', async ($, on) => {
  const balance = (total: string) => ({ is_available: true, balance_infos: [{ currency: 'CNY', total_balance: total, granted_balance: '0.00', topped_up_balance: total }] })
  expect(deepseekParts(balance('0.29'))).toEqual([{ name: '余额', text: '¥0.29', level: 'low' }])
  expect(deepseekParts(balance('8.00'))[0]?.level).toBe('warn')
  expect(deepseekParts(balance('20.00'))[0]?.level).toBe(undefined)
  expect(deepseekParts(balance('0.29'), 0)[0]?.level).toBe(undefined)

  engine(on, {
    vars: { DEEPSEEK_API_KEY: 'k' },
    config: JSON.stringify({ sources: [{ id: 'ds', type: 'deepseek' }] }),
    routes: { 'https://api.deepseek.com/user/balance': balance('0.29') },
  })
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.command.run(RUN)
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  const strip = await ui.find({ type: 'Svg' })
  expect(String(strip?.props.alt)).toContain('DeepSeek 告急 余额 ¥0.29')
  expect(String(strip?.props.source)).toContain('1 项告警')
  await ui.unmount()
})

test('http-json helpers', async () => {
  const s = { id: 'x', type: 'http-json', windows: [{ name: 'd', usedPercent: 'p', resetsAt: 'r' }] }
  expect(httpJsonParts({ p: '12.5', r: '2026-10-30T00:00:00Z' }, s, NOW)[0]).toEqual({
    name: 'd',
    remaining: 88,
    text: undefined,
    used: undefined,
    limit: undefined,
    resetsAt: Date.parse('2026-10-30T00:00:00Z'),
  })
})

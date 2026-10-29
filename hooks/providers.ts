import type { EngineInterface } from 'claude-code'

import type { DashItem, DashPart } from '../types'
import { PROVIDERS } from './catalog'
import { readEnv } from './env'
import {
  agnesPlanParts,
  billingParts,
  carriedParts,
  claudeParts,
  codexParts,
  deepseekParts,
  fmtDuration,
  httpJsonParts,
  jwtExpiry,
} from './lib'
import type { AgnesPlan, CodexReport, SourceConfig } from './lib'

type $ = EngineInterface

/** Tokens a source logged in for, kept in memory only: never written to disk. */
export type TokenCache = {
  tokens: Map<string, string>
  logins: Map<string, Promise<{ token?: string; error?: string }>>
}

/** Not set up on this machine: hidden from the band while hideUnavailable is on. */
const unavailable = (base: DashItem, why: string): DashItem => ({ ...base, error: why, unavailable: true })

async function getJson($: $, url: string, key: string) {
  const res = await $.http.fetch(url, { headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' } })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return JSON.parse(res.text) as Record<string, unknown>
}

type ClaudeReading = { parts: DashPart[]; at: number }

/**
 * The engine has a reading only after a session's first reply, so the last one
 * is kept in `$.store` (shared by all sessions) and shown, dated, until then.
 */
async function fetchClaude($: $, base: DashItem): Promise<DashItem> {
  const { rateLimits } = await $.session.usage()
  const parts = claudeParts(rateLimits)
  if (parts.length) {
    await $.store.set('claudeReading', { parts, at: await $.clock.now() } satisfies ClaudeReading)
    return { ...base, parts }
  }
  const last = (await $.store.get('claudeReading')) as ClaudeReading | undefined
  if (!last?.parts?.length) return unavailable(base, '首次回复后显示')
  const now = await $.clock.now()
  const age = now - last.at
  return { ...base, parts: carriedParts(last.parts, now), note: age < 60000 ? '刚才的读数' : `${fmtDuration(age)}前的读数` }
}

async function fetchCodex($: $, s: SourceConfig, base: DashItem): Promise<DashItem> {
  const script = `${$.plugin.root.replace(/\\/g, '/')}/scripts/codex-limits.mjs`
  let stdout: string
  try {
    stdout = (await $.process.run(['node', script, s.bin ?? 'codex'], { timeoutMs: 25000 })).stdout
  } catch {
    return unavailable(base, '需要 node')
  }
  const report = JSON.parse(stdout.trim().split('\n').pop() || '{}') as CodexReport
  if (report.source === 'none' || !report.source) return unavailable(base, '未找到 codex 或未登录')
  const now = await $.clock.now()
  const note =
    report.source === 'recorded' && report.recordedAt
      ? `本地记录 ${Math.max(0, Math.round((now - Date.parse(report.recordedAt)) / 3600000))}h 前`
      : undefined
  return { ...base, parts: codexParts(report, now), note }
}

const AGNES_API = 'https://platform-backend.agnes-ai.cn'

async function agnesLogin($: $, s: SourceConfig): Promise<{ token?: string; error?: string }> {
  const emailEnv = s.emailEnv ?? 'AGNES_EMAIL'
  const passwordEnv = s.passwordEnv ?? 'AGNES_PASSWORD'
  const username = await readEnv($, emailEnv)
  const password = await readEnv($, passwordEnv)
  if (!username || !password) return { error: `缺少环境变量 ${emailEnv} / ${passwordEnv}` }
  const res = await $.http.fetch(`${AGNES_API}/api/user/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-User-Language': 'zh' },
    body: JSON.stringify({ username, password }),
  })
  let body: { code?: number; message?: string; data?: { access_token?: string } } = {}
  try {
    body = JSON.parse(res.text)
  } catch {}
  const token = body.data?.access_token
  return token ? { token } : { error: `登录失败：${body.message ?? `HTTP ${res.status}`}` }
}

/** Agnes coding plan: a login token from memory, the environment, or a fresh login. */
async function fetchAgnesPlan($: $, s: SourceConfig, base: DashItem, cache: TokenCache): Promise<DashItem> {
  const now = await $.clock.now()
  const fresh = (t: string | undefined) => {
    const exp = t ? jwtExpiry(t) : undefined
    return t && (exp === undefined || exp - now > 3600e3) ? t : undefined
  }
  let token = fresh(cache.tokens.get(s.id)) ?? fresh(await readEnv($, s.keyEnv ?? 'AGNES_PLATFORM_TOKEN'))
  let loggedIn = false
  const login = async () => {
    loggedIn = true
    // Refreshes that overlap share one login.
    let pending = cache.logins.get(s.id)
    if (!pending) {
      pending = agnesLogin($, s)
      cache.logins.set(s.id, pending)
      void pending.finally(() => cache.logins.delete(s.id))
    }
    const r = await pending
    if (r.token) cache.tokens.set(s.id, r.token)
    token = r.token
    return r.error
  }
  if (!token) {
    const err = await login()
    if (err) return err.startsWith('缺少') ? unavailable(base, err) : { ...base, error: err }
  }
  for (;;) {
    const res = await $.http.fetch(s.url ?? `${AGNES_API}/api/cn/user/subscription`, {
      headers: { Authorization: `Bearer ${token}`, 'X-User-Language': 'zh-CN', Accept: 'application/json' },
    })
    let body: { code?: number; data?: AgnesPlan } = {}
    try {
      body = JSON.parse(res.text)
    } catch {}
    if (res.status === 401 || body.code === 401) {
      if (cache.tokens.get(s.id) === token) cache.tokens.delete(s.id)
      if (loggedIn) return { ...base, error: '登录后仍未授权' }
      const err = await login()
      if (err) return { ...base, error: `token 失效，${err}` }
      continue
    }
    if (!res.ok || !body.data) throw new Error(`HTTP ${res.status}`)
    return { ...base, parts: agnesPlanParts(body.data, now), note: body.data.plan_name }
  }
}

async function fetchOpenAiBilling($: $, s: SourceConfig, base: DashItem): Promise<DashItem> {
  const key = await readEnv($, s.keyEnv)
  if (!key) return unavailable(base, `缺少环境变量 ${s.keyEnv ?? '(keyEnv)'}`)
  const root = (s.baseUrl ?? '').replace(/\/+$/, '')
  const sub = await getJson($, `${root}/dashboard/billing/subscription`, key)
  const usage = await getJson($, `${root}/dashboard/billing/usage`, key)
  return { ...base, parts: billingParts(sub, usage) }
}

async function fetchDeepseek($: $, s: SourceConfig, base: DashItem): Promise<DashItem> {
  const env = s.keyEnv ?? 'DEEPSEEK_API_KEY'
  const key = await readEnv($, env)
  if (!key) return unavailable(base, `缺少环境变量 ${env}`)
  const body = await getJson($, s.url ?? 'https://api.deepseek.com/user/balance', key)
  return { ...base, parts: deepseekParts(body, s.warnBalance) }
}

async function fetchHttpJson($: $, s: SourceConfig, base: DashItem): Promise<DashItem> {
  if (!s.url) return { ...base, error: '缺少 url' }
  const auth = s.auth ?? (s.keyEnv ? { env: s.keyEnv } : undefined)
  const headers: Record<string, string> = { Accept: 'application/json', ...(s.headers ?? {}) }
  if (auth) {
    const key = await readEnv($, auth.env)
    if (!key) return unavailable(base, `缺少环境变量 ${auth.env}`)
    headers[auth.header ?? 'Authorization'] = `${auth.prefix ?? 'Bearer '}${key}`
  }
  const res = await $.http.fetch(s.url, { method: s.method ?? 'GET', headers, body: s.body })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const parts = httpJsonParts(JSON.parse(res.text), s, await $.clock.now())
  return parts.length ? { ...base, parts } : { ...base, error: '配置里没有 windows 或 values' }
}

/** One source's reading, never a rejection: a failure is the item's `error`. */
export async function fetchSource($: $, s: SourceConfig, warnPercent: number, cache: TokenCache): Promise<DashItem> {
  const base: DashItem = {
    id: s.id,
    type: s.type,
    label: s.label ?? PROVIDERS[s.type]?.title ?? s.id,
    icon: s.icon,
    color: s.color,
    parts: [],
    warnPercent: s.warnPercent ?? warnPercent,
  }
  try {
    switch (s.type) {
      case 'claude':
        return await fetchClaude($, base)
      case 'codex':
        return await fetchCodex($, s, base)
      case 'agnes-plan':
        return await fetchAgnesPlan($, s, base, cache)
      case 'openai-billing':
        return await fetchOpenAiBilling($, s, base)
      case 'deepseek':
        return await fetchDeepseek($, s, base)
      case 'http-json':
        return await fetchHttpJson($, s, base)
      default:
        return { ...base, error: `未知类型 ${s.type}（/usage-dash types 查看可用类型）` }
    }
  } catch (err) {
    return { ...base, error: `出错：${(err as Error).message ?? String(err)}`.slice(0, 80) }
  }
}

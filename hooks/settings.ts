import { PROVIDERS } from './catalog'

/** The config file as written: what the panel, the commands and usage_config edit. */
export type RawConfig = Record<string, unknown> & { sources: Record<string, unknown>[] }

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
/** A key pasted where its variable's name goes: long, with lower case and digits mixed. */
const LOOKS_LIKE_KEY = /^(?=.*[a-z])(?=.*\d).{24,}$/

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/** Every problem with the config, in words; empty means it can be saved. */
export function validateConfig(raw: unknown): string[] {
  if (!isObj(raw)) return ['配置要是一个 JSON 对象']
  const errs: string[] = []
  const { refreshSeconds, warnPercent, hideUnavailable, sources } = raw
  if (refreshSeconds !== undefined && (!isNum(refreshSeconds) || refreshSeconds < 30)) errs.push('refreshSeconds 要是 ≥30 的数字（秒）')
  if (warnPercent !== undefined && (!isNum(warnPercent) || warnPercent < 0 || warnPercent > 100)) errs.push('warnPercent 要在 0–100 之间')
  if (hideUnavailable !== undefined && typeof hideUnavailable !== 'boolean') errs.push('hideUnavailable 要是 true / false')
  if (!Array.isArray(sources)) return [...errs, 'sources 要是数组']
  const seen = new Set<string>()
  sources.forEach((s, i) => {
    const at = `sources[${i}]`
    if (!isObj(s)) return void errs.push(`${at} 要是对象`)
    const name = typeof s.id === 'string' && s.id ? `${at}（${s.id}）` : at
    if (typeof s.id !== 'string' || !s.id) errs.push(`${at} 缺 id`)
    else if (seen.has(s.id)) errs.push(`${name} 的 id 重复`)
    else seen.add(s.id)
    if (typeof s.type !== 'string' || !(s.type in PROVIDERS))
      errs.push(`${name}.type 只能是 ${Object.keys(PROVIDERS).join(' / ')}`)
    if (s.enabled !== undefined && typeof s.enabled !== 'boolean') errs.push(`${name}.enabled 要是 true / false`)
    if (s.warnPercent !== undefined && (!isNum(s.warnPercent) || s.warnPercent < 0 || s.warnPercent > 100))
      errs.push(`${name}.warnPercent 要在 0–100 之间`)
    if (s.warnBalance !== undefined && (!isNum(s.warnBalance) || s.warnBalance < 0)) errs.push(`${name}.warnBalance 要是 ≥0 的数字`)
    for (const f of ['label', 'icon', 'color', 'baseUrl', 'bin', 'url', 'method', 'body', 'root', 'path', 'unit'])
      if (s[f] !== undefined && typeof s[f] !== 'string') errs.push(`${name}.${f} 要是字符串`)
    const envs: [string, unknown][] = [
      ['keyEnv', s.keyEnv],
      ['emailEnv', s.emailEnv],
      ['passwordEnv', s.passwordEnv],
      ['auth.env', isObj(s.auth) ? s.auth.env : undefined],
    ]
    for (const [f, v] of envs) {
      if (v === undefined) continue
      if (typeof v !== 'string' || !ENV_NAME.test(v) || LOOKS_LIKE_KEY.test(v))
        errs.push(`${name}.${f} 写环境变量的名字（如 MY_API_KEY），不是 key 本身`)
    }
    if (s.auth !== undefined && (!isObj(s.auth) || typeof s.auth.env !== 'string')) errs.push(`${name}.auth 要是 { env, header?, prefix? }`)
    if (s.headers !== undefined && (!isObj(s.headers) || Object.values(s.headers).some(v => typeof v !== 'string')))
      errs.push(`${name}.headers 的值都要是字符串`)
    if (s.type === 'openai-billing' && typeof s.baseUrl !== 'string') errs.push(`${name} 是 openai-billing，要写 baseUrl`)
    if (s.type === 'http-json') {
      if (typeof s.url !== 'string') errs.push(`${name} 是 http-json，要写 url`)
      if (s.windows !== undefined && (!Array.isArray(s.windows) || s.windows.some(w => !isObj(w) || typeof w.name !== 'string')))
        errs.push(`${name}.windows 每一项都要有 name`)
      if (s.values !== undefined && (!Array.isArray(s.values) || s.values.some(v => !isObj(v) || typeof v.name !== 'string' || typeof v.path !== 'string')))
        errs.push(`${name}.values 每一项都要有 name 和 path`)
    }
  })
  return errs
}

/**
 * Sets the value at a dotted path of `raw`, in place, or removes it when
 * `value` is undefined. In an array a key that is not a number names the entry
 * by its `id` (`sources.codex.enabled`), and `-` as the last key appends.
 */
export function setPath(raw: RawConfig, path: string, value: unknown): void {
  const keys = path.split('.').filter(Boolean)
  if (keys.length === 0) throw new Error('path 不能为空')
  const indexOf = (arr: unknown[], key: string) => {
    if (/^\d+$/.test(key)) return Number(key)
    const i = arr.findIndex(x => isObj(x) && x.id === key)
    if (i < 0) throw new Error(`没有 id 为 ${key} 的项`)
    return i
  }
  let node: unknown = raw
  for (const key of keys.slice(0, -1)) {
    const child = Array.isArray(node) ? node[indexOf(node, key)] : (node as Record<string, unknown>)[key]
    if (child === null || typeof child !== 'object') throw new Error(`路径 ${path} 里的 ${key} 不存在`)
    node = child
  }
  const last = keys[keys.length - 1]!
  if (Array.isArray(node)) {
    if (last === '-') {
      if (value === undefined) throw new Error('- 只能用来追加')
      node.push(value)
    } else if (value === undefined) node.splice(indexOf(node, last), 1)
    else node[indexOf(node, last)] = value
  } else if (value === undefined) delete (node as Record<string, unknown>)[last]
  else (node as Record<string, unknown>)[last] = value
}

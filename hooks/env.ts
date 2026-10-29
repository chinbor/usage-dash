import type { EngineInterface } from 'claude-code'

type $ = EngineInterface

export const isEnvName = (name: string) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)

/** `reg query HKCU\Environment /v NAME` output → the value. */
export function parseRegQuery(stdout: string): string | undefined {
  const m = /REG_(?:EXPAND_)?SZ\s+(.*?)\s*$/m.exec(stdout)
  return m?.[1] || undefined
}

/** `set NAME` output (every variable starting with NAME) → NAME's own value. */
export function parseCmdSet(stdout: string, name: string): string | undefined {
  const upper = name.toUpperCase()
  for (const line of stdout.split(/\r?\n/)) {
    const eq = line.indexOf('=')
    if (eq > 0 && line.slice(0, eq).toUpperCase() === upper) return line.slice(eq + 1) || undefined
  }
  return undefined
}

export async function isWindows($: $) {
  return (await $.env.get('OS')) === 'Windows_NT'
}

export async function homeDir($: $) {
  return ((await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? '.').replace(/\\/g, '/')
}

/**
 * Any environment variable by name. `$.env.get` takes literal names only, so
 * a name from the config is read through the host: `printenv` on macOS and
 * Linux; on Windows the process's own `set`, then the user variables in the
 * registry (where one set after the app started lives).
 */
export async function readEnv($: $, name: string | undefined): Promise<string | undefined> {
  if (!name || !isEnvName(name)) return undefined
  const run = async (argv: string[]) => {
    try {
      return await $.process.run(argv, { timeoutMs: 5000 })
    } catch {
      return undefined
    }
  }
  if (!(await isWindows($))) {
    const r = await run(['printenv', name])
    return r?.exitCode === 0 ? r.stdout.replace(/\r?\n$/, '') || undefined : undefined
  }
  const own = await run(['cmd', '/d', '/c', 'set', name])
  const fromProcess = own?.exitCode === 0 ? parseCmdSet(own.stdout, name) : undefined
  if (fromProcess) return fromProcess
  const reg = await run(['reg', 'query', 'HKCU\\Environment', '/v', name])
  return reg?.exitCode === 0 ? parseRegQuery(reg.stdout) : undefined
}

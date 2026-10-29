#!/usr/bin/env node
// Prints the Codex (ChatGPT plan) rate-limit windows as one JSON line.
// First asks a short-lived `codex app-server` (account/rateLimits/read, live);
// if that fails, falls back to the last `rate_limits` recorded in ~/.codex/sessions.
// Usage: node codex-limits.mjs [codexBin]
import { spawn } from 'node:child_process'
import { existsSync, openSync, readSync, closeSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const bin = process.argv[2] || 'codex'
const TIMEOUT_MS = 15000

function live() {
  return new Promise(resolve => {
    let child
    try {
      child = spawn(bin, ['app-server'], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true })
    } catch (err) {
      return resolve({ error: String(err.message || err) })
    }
    let buf = ''
    const done = value => {
      clearTimeout(timer)
      try { child.kill() } catch {}
      resolve(value)
    }
    const timer = setTimeout(() => done({ error: 'app-server timeout' }), TIMEOUT_MS)
    child.on('error', err => done({ error: String(err.message || err) }))
    child.on('exit', () => done({ error: 'app-server exited' }))
    child.stdout.on('data', chunk => {
      buf += chunk
      let nl
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl)
        buf = buf.slice(nl + 1)
        let msg
        try { msg = JSON.parse(line) } catch { continue }
        if (msg.id === 2) {
          if (msg.error) return done({ error: msg.error.message || 'rpc error' })
          return done({ live: msg.result })
        }
      }
    })
    const send = obj => child.stdin.write(JSON.stringify(obj) + '\n')
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'usage-dash', version: '0.1.0' } } })
    send({ jsonrpc: '2.0', method: 'initialized' })
    send({ jsonrpc: '2.0', id: 2, method: 'account/rateLimits/read' })
  })
}

function newestSessionFile() {
  const root = join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'sessions')
  if (!existsSync(root)) return null
  const pick = dir => {
    const names = readdirSync(dir).sort().reverse()
    for (const name of names) {
      const full = join(dir, name)
      const st = statSync(full)
      if (st.isDirectory()) {
        const found = pick(full)
        if (found) return found
      } else if (name.endsWith('.jsonl')) {
        // Within one day folder, newest by mtime.
        return names
          .filter(n => n.endsWith('.jsonl'))
          .map(n => join(dir, n))
          .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0]
      }
    }
    return null
  }
  return pick(root)
}

function fromSessions() {
  const file = newestSessionFile()
  if (!file) return { error: 'no session files' }
  const size = statSync(file).size
  const len = Math.min(size, 2 * 1024 * 1024)
  const fd = openSync(file, 'r')
  const b = Buffer.alloc(len)
  readSync(fd, b, 0, len, size - len)
  closeSync(fd)
  const lines = b.toString('utf8').split('\n').reverse()
  for (const line of lines) {
    if (!line.includes('"rate_limits"')) continue
    try {
      const row = JSON.parse(line)
      const rl = row.payload && row.payload.rate_limits
      if (!rl) continue
      const conv = w => w && { usedPercent: w.used_percent, windowDurationMins: w.window_minutes, resetsAt: w.resets_at }
      return {
        recorded: { primary: conv(rl.primary), secondary: conv(rl.secondary), planType: rl.plan_type },
        recordedAt: row.timestamp,
      }
    } catch {}
  }
  return { error: 'no rate_limits in latest session' }
}

const result = await live()
if (result.live) {
  const rl = result.live.rateLimits || {}
  console.log(JSON.stringify({ source: 'live', primary: rl.primary, secondary: rl.secondary, planType: rl.planType }))
} else {
  const fb = fromSessions()
  if (fb.recorded) {
    console.log(JSON.stringify({ source: 'recorded', ...fb.recorded, recordedAt: fb.recordedAt, liveError: result.error }))
  } else {
    console.log(JSON.stringify({ source: 'none', error: `${result.error}; ${fb.error}` }))
  }
}
process.exit(0)

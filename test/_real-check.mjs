// Optional offline sanity check against a COPY of a real ledger (never writes
// to the real .dsh home). Skips cleanly when no local ledger is present, so a
// fresh clone can run the whole test suite without any user data.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const realHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const REAL = process.env.DSH_TOKEN_LEDGER_REAL ||
  path.join(realHome, 'token-ledger', 'ledger.json')

if (!fs.existsSync(REAL)) {
  console.log('REAL DATA CHECK SKIPPED (no local ledger at ' + REAL + ')')
  process.exit(0)
}

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-real-check-'))
fs.mkdirSync(path.join(home, 'token-ledger'), { recursive: true })
fs.copyFileSync(REAL, path.join(home, 'token-ledger', 'ledger.json'))
process.env.DSH_HOME = home

const mod = await import(pathToFileURL(path.join(pluginRoot, 'lib/index.js')).href)
const routes = new Map()
const ctx = {
  webServer: { register(r) { routes.set(r.path, r); return () => {} } },
  on() { return () => {} },
  effect() { return () => {} },
  get() { return null },
}
mod.apply(ctx)

function res() {
  const o = { status: 200, body: '' }
  return {
    o,
    writeHead(s, h) { o.status = s },
    end(s) { o.body += String(s == null ? '' : s) },
  }
}
async function call(p, method = 'GET', body = '') {
  const r = routes.get(p.split('?')[0])
  if (!r) throw new Error('missing route ' + p)
  const out = res()
  await r.handler({
    method, url: p, headers: { host: '127.0.0.1:59078' },
    on(ev, fn) { if (ev === 'data' && body) fn(body); if (ev === 'end') fn() },
  }, out)
  return JSON.parse(out.o.body)
}

const d = await call('/dsh-token-ledger/data.json')
const f = (x) => Number(x || 0).toLocaleString('en-US')
console.log('REAL DATA CHECK (copy only)')
console.log('  events            ', f(d.totals.events))
console.log('  total tokens      ', f(d.totals.total))
console.log('  input/cacheR/cacheW/output', [d.totals.input, d.totals.cacheRead, d.totals.cacheWrite, d.totals.output].map(f).join(' / '))
console.log('  sessions / models ', d.sessions.length, '/', d.models.length)
console.log('  weeks / months / days', d.weeks.length, '/', d.months.length, '/', d.days.length)
console.log('  facets weeks/months', d.facets.weeks.length, '/', d.facets.months.length)
console.log('  baselineAt        ', new Date(d.baselineAt).toISOString())
console.log('  BEFORE book       ', f(d.groups.before.events), 'events,', f(d.groups.before.total), 'tokens')
console.log('  AFTER  book       ', f(d.groups.after.events), 'events,', f(d.groups.after.total), 'tokens')
console.log('  split sums        ', f(d.groups.before.total + d.groups.after.total))
console.log('  weekly rollup:')
for (const w of d.weeks) console.log('   ', w.key, w.label, f(w.total), 'tokens /', f(w.events), 'events')
console.log('  monthly rollup:')
for (const m of d.months) console.log('   ', m.key, m.label, f(m.total), 'tokens /', f(m.events), 'events')

if (d.facets.weeks.length) {
  const w = d.facets.weeks[0]
  const iso = (ts) => { const x = new Date(ts), p = (n) => String(n).padStart(2, '0'); return `${x.getFullYear()}-${p(x.getMonth() + 1)}-${p(x.getDate())}` }
  const q = await call(`/dsh-token-ledger/query.json?from=${iso(w.startTs)}&to=${iso(w.endTs)}&label=week-check`)
  console.log('  week filter', w.key, '=>', f(q.filter.events), 'events /', f(q.totals.total), 'tokens (rollup:', f(w.total), ')')
}
const qb = await call('/dsh-token-ledger/query.json?group=before')
const qa = await call('/dsh-token-ledger/query.json?group=after')
console.log('  group=before', f(qb.totals.events), 'events; group=after', f(qa.totals.events), 'events')
const h = await call('/dsh-token-ledger/health.json')
console.log('  health.baselineAt', h.baselineAt, 'events', h.events, 'revision', h.revision)
fs.rmSync(home, { recursive: true, force: true })
console.log('REAL DATA CHECK PASSED')

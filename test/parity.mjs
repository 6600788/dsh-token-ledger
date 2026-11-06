// Parity test: the page-local fallback must produce the same numbers as the
// restarted host's /query.json for identical ledgers and filters.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
// Capture the user's home BEFORE the synthetic temp home overwrites DSH_HOME.
const userHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-parity-'))
fs.mkdirSync(path.join(home, 'token-ledger'), { recursive: true })
process.env.DSH_HOME = home

const DAY = 86400000
const NOW = Date.now()
const OLD = NOW - 10 * DAY
const ev = (ts, sid, turn, model, b, cost) => ({
  ts, day: new Date(ts).toISOString().slice(0, 10), sessionId: sid,
  sessionTitle: sid, turn, model, input: b[0] || 0, cacheRead: b[1] || 0,
  cacheWrite: b[2] || 0, output: b[3] || 0, reasoning: b[4] || 0,
  total: (b[0] || 0) + (b[1] || 0) + (b[2] || 0) + (b[3] || 0),
  cost: cost == null ? null : cost, source: turn == null ? 'history' : 'live',
})
const ledger = {
  version: 1, plugin: 'dsh-token-ledger', pluginVersion: '1.1.0',
  createdAt: new Date(NOW - DAY).toISOString(), firstStartAt: NOW - DAY,
  baselineAt: NOW - DAY, history: null, importedKeys: [],
  sessions: { 's1': { title: '会话一' }, 's2': { title: '会话二' } },
  events: [
    ev(OLD - 3 * DAY, '__history_whale__', null, 'old-model', [0, 0, 0, 0], 1.5),
    ev(OLD - 2 * DAY, '__history_whale__', null, 'old-model2', [0, 0, 0, 0], 2.5),
    ev(NOW - 12 * 3600000, 's1', 1, 'deepseek-v4', [100, 50, 10, 200, 80]),
    ev(NOW - 11 * 3600000, 's1', 1, 'glm', [20, 30, 0, 30]),
    ev(NOW - 10 * 3600000, 's2', 1, 'deepseek-v4', [5, 0, 0, 7]),
    ev(NOW - 2 * 3600000, 's1', 2, 'glm', [11, 3, 1, 9]),
  ],
  seq: 6,
}
// Give the two history rows a non-zero total (whale imports carry total only).
ledger.events[0].total = 12345
ledger.events[1].total = 6789
fs.writeFileSync(path.join(home, 'token-ledger', 'ledger.json'), JSON.stringify(ledger))

const mod = await import('file:///' + path.join(ROOT, 'lib', 'index.js').replace(/\\/g, '/'))
const routes = new Map()
mod.apply({
  webServer: { register(r) { routes.set(r.path, r); return () => {} } },
  on() { return () => {} }, effect() { return () => {} }, get() { return null },
})
async function hostQuery(q) {
  const r = routes.get('/dsh-token-ledger/query.json')
  const out = response()
  await r.handler({
    method: 'GET', url: '/dsh-token-ledger/query.json?' + q,
    headers: { host: '127.0.0.1:59078' },
    on(ev2, fn) { if (ev2 === 'end') fn() },
  }, out)
  return JSON.parse(out.body)
}
function response() {
  return { status: 200, body: '', writeHead(s) { this.status = s }, end(s) { this.body += String(s || '') } }
}
// The browser's fallback reads /export.json, i.e. the NORMALIZED ledger the
// host actually aggregates. Feed parity the exact same bytes.
function hostExport() {
  return (async () => {
    const r = routes.get('/dsh-token-ledger/export.json')
    const out = response()
    await r.handler({ method: 'GET', url: '/dsh-token-ledger/export.json',
      headers: { host: '127.0.0.1:59078' },
      on(ev2, fn) { if (ev2 === 'end') fn() } }, out)
    return JSON.parse(out.body)
  })()
}
const normalizedLedger = await hostExport()

// Load the classic-script client in a sandbox and grab its exports.
let captured = null
const sandbox = {
  window: { __ModuleLoader__: { load(o) { captured = o } } },
  document: { getElementById: () => null, createElement: () => ({ style: {} }), head: { appendChild() {} } },
  URL, Date, Math, Number, String, Object, Array, JSON, isFinite, console,
}
vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'lib', 'client.js'), 'utf8'), sandbox)
assert.ok(captured && captured.id === 'dsh-token-ledger', 'module loader id')
const clientExports = captured.factory((name) => {
  if (name === 'react') return { createElement() {}, Fragment: {}, useState() {}, useEffect() {}, useMemo() {}, useCallback() {} }
  throw new Error('unexpected require ' + name)
})
const fallback = clientExports.fallbackPayload
assert.equal(typeof fallback, 'function', 'fallbackPayload exported')

const cases = [
  '', 'group=all', 'group=before', 'group=after',
  'group=before&label=history', 'label=all',
  `from=${iso(OLD - 4 * DAY)}&to=${iso(OLD - DAY)}`,
  `from=${iso(NOW - 13 * 3600000)}&to=${iso(NOW - 9 * 3600000)}`,
  `group=after&from=${iso(NOW - 3 * 3600000)}&to=${iso(NOW)}`,
  'from=1970-01-01&to=1970-01-02',
]
function iso(ts) {
  const d = new Date(ts), p = (x) => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

const NUM = ['events', 'input', 'cacheRead', 'cacheWrite', 'output', 'reasoning',
  'total', 'cost', 'costEvents', 'liveEvents', 'historyEvents', 'turns', 'sessions']
for (const q of cases) {
  const h = await hostQuery(q)
  const c = fallback(normalizedLedger, '/dsh-token-ledger/query.json?' + q)
  const tag = '[' + (q || 'no-filter') + ']'
  for (const k of NUM) assert.equal(c.totals[k], h.totals[k], tag + ' totals.' + k)
  assert.equal(c.filter.events, h.filter.events, tag + ' filter.events')
  assert.equal(c.filter.totalEvents, h.filter.totalEvents, tag + ' filter.totalEvents')
  assert.equal(c.filter.group, h.filter.group, tag + ' filter.group')
  for (const g of ['before', 'after']) {
    for (const k of NUM) assert.equal(c.groups[g][k], h.groups[g][k], tag + ' groups.' + g + '.' + k)
  }
  assert.equal(c.sessions.length, h.sessions.length, tag + ' sessions.length')
  assert.equal(c.models.length, h.models.length, tag + ' models.length')
  assert.deepEqual(c.models.map((m) => [m.model, m.total]),
    h.models.map((m) => [m.model, m.total]), tag + ' models')
  assert.deepEqual(c.weeks.map((w) => [w.key, w.total, w.events]),
    h.weeks.map((w) => [w.key, w.total, w.events]), tag + ' weeks')
  assert.deepEqual(c.months.map((m) => [m.key, m.total, m.events]),
    h.months.map((m) => [m.key, m.total, m.events]), tag + ' months')
  assert.deepEqual(c.days.map((d) => [d.day, d.total]),
    h.days.map((d) => [d.day, d.total]), tag + ' days')
  assert.deepEqual(c.facets.weeks.map((w) => [w.key, w.total]),
    h.facets.weeks.map((w) => [w.key, w.total]), tag + ' facets.weeks')
  assert.deepEqual(c.facets.months.map((m) => [m.key, m.total]),
    h.facets.months.map((m) => [m.key, m.total]), tag + ' facets.months')
  assert.equal(c.recentEvents.length, h.recentEvents.length, tag + ' recentEvents.length')
  assert.equal(c.baselineAt, h.baselineAt, tag + ' baselineAt')
}

// Optional: also exercise a real (large) ledger when one exists on this machine.
// Both sides must read the SAME ledger, so swap the host's backing store for a
// fresh module instance pointed at a temp home containing that exact file.
// A fresh clone has no such file — skip that half, keep the synthetic parity.
const defaultReal = path.join(userHome, 'token-ledger', 'ledger.json')
const REAL = process.env.DSH_TOKEN_LEDGER_REAL || defaultReal
let realCases = 0
let realHome = null
if (fs.existsSync(REAL)) {
  const real = JSON.parse(fs.readFileSync(REAL, 'utf8'))
  realHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-parity-real-'))
  fs.mkdirSync(path.join(realHome, 'token-ledger'), { recursive: true })
  fs.writeFileSync(path.join(realHome, 'token-ledger', 'ledger.json'), JSON.stringify(real))
  process.env.DSH_HOME = realHome
  const realMod = await import('file:///' + path.join(ROOT, 'lib', 'index.js').replace(/\\/g, '/') + '?real')
  const realRoutes = new Map()
  realMod.apply({
    webServer: { register(r) { realRoutes.set(r.path, r); return () => {} } },
    on() { return () => {} }, effect() { return () => {} }, get() { return null },
  })
  async function realQuery(q) {
    const r = realRoutes.get('/dsh-token-ledger/query.json')
    const out = response()
    await r.handler({ method: 'GET', url: '/dsh-token-ledger/query.json?' + q,
      headers: { host: '127.0.0.1:59078' },
      on(ev2, fn) { if (ev2 === 'end') fn() } }, out)
    return JSON.parse(out.body)
  }
  const realExport = realRoutes.get('/dsh-token-ledger/export.json')
  const realOut = response()
  await realExport.handler({ method: 'GET', url: '/dsh-token-ledger/export.json',
    headers: { host: '127.0.0.1:59078' },
    on(ev2, fn) { if (ev2 === 'end') fn() } }, realOut)
  const normalizedReal = JSON.parse(realOut.body)

  // Derive the date window from the ledger itself instead of hard-coding a
  // calendar range that only fits one developer's machine.
  const stamps = normalizedReal.events.map((e) => Number(e.ts)).filter(Number.isFinite)
  const span = stamps.length ? [Math.min(...stamps), Math.max(...stamps)] : []
  const iso = (ts) => new Date(ts).toISOString().slice(0, 10)
  const realQueries = ['', 'group=before', 'group=after']
  if (span.length) realQueries.push('from=' + iso(span[0]) + '&to=' + iso(span[1]))
  for (const q of realQueries) {
    const h = await realQuery(q)
    const c = fallback(normalizedReal, '/dsh-token-ledger/query.json?' + q)
    for (const k of NUM) assert.equal(c.totals[k], h.totals[k], 'real ' + q + ' totals.' + k)
    assert.deepEqual(c.weeks.map((w) => [w.key, w.total]), h.weeks.map((w) => [w.key, w.total]), 'real ' + q + ' weeks')
    assert.deepEqual(c.months.map((m) => [m.key, m.total]), h.months.map((m) => [m.key, m.total]), 'real ' + q + ' months')
    assert.equal(c.groups.before.total, h.groups.before.total, 'real ' + q + ' before')
    assert.equal(c.groups.after.total, h.groups.after.total, 'real ' + q + ' after')
    realCases += 1
  }
}

fs.rmSync(home, { recursive: true, force: true })
if (realHome) fs.rmSync(realHome, { recursive: true, force: true })
console.log('CLIENT FALLBACK PARITY PASSED')
console.log('  ' + cases.length + ' synthetic filters + ' + realCases + ' real-ledger filters,')
console.log('  totals / two books / sessions / models / weeks / months / days / facets / recentEvents all identical')
if (!realCases) console.log('  (no local ledger found — real-data half skipped)')


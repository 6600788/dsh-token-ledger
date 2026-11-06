/**
 * dsh-token-ledger — offline host harness
 * ---------------------------------------------------------------------------
 * Runs the real host half against a mock Cordis context and a temporary
 * DSH_HOME, so it never touches the user's real ledger. Verifies the accounting
 * itself, not just that the file parses.
 *
 *   node test/mock-host.mjs
 *
 * What it asserts:
 *   - turn aggregation by (sessionId, turn) and per-model bucketing
 *   - reasoningTokens is NOT added on top of outputTokens (no double count)
 *   - session/title updates the stored session name
 *   - parallel sessions do not bleed into each other
 *   - one-time whale history import (pre-install only) + idempotent re-import
 *   - durable ledger survives a simulated host restart
 *   - reset clears live rows but keeps imported history
 *   - the loopback trust fence rejects a forged Host
 *   - two books split at baselineAt, movable via POST /baseline
 *   - /query.json filtering by group / from / to, weeks + months + facets
 *   - every aggregate carries all four token buckets
 */
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

// Resolve the plugin from this file's own location so the suite runs from any
// clone/checkout path (no machine-specific absolute path baked in).
const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const home = mkdtempSync(join(tmpdir(), 'dsh-token-ledger-test-'))
const OLD = Date.now() - 10 * 86400000
const HISTORY_A = 12345
const HISTORY_B = 6789
const HISTORY_TOTAL = HISTORY_A + HISTORY_B
// Real whale builds wrap the log in an object with an `events` array plus
// balance/day metadata. Older builds wrote a bare array; the host accepts both.
writeFileSync(join(home, '.dshw-usage.json'), JSON.stringify({
  date: '2026-10-20', lastBalance: 10, todayUsage: 0, history: {},
  accounting: {}, dayStart: OLD,
  events: [
    { ts: OLD, day: '2026-10-20', model: 'old-model-a', cost: 1.25, tokens: HISTORY_A },
    { ts: OLD + 1000, day: '2026-10-20', model: 'old-model-b', cost: 0.5, tokens: HISTORY_B },
  ],
}), 'utf8')
process.env.DSH_HOME = home

const mod = await import(pathToFileURL(join(pluginRoot, 'lib/index.js')).href)
assert.equal(mod.name, 'dsh-token-ledger')
assert.deepEqual(mod.inject, ['webServer'])

function makeCtx() {
  const routes = new Map()
  const handlers = new Map()
  const ctx = {
    get() { return undefined }, // no sessionTitle / connection service in the mock
    webServer: {
      register(route) { routes.set(route.path, route); return () => {} },
    },
    on(name, fn) { handlers.set(name, fn); return () => {} },
    effect(fn) { return () => {} },
  }
  return { ctx, routes, handlers }
}

function makeRes() {
  const o = {
    status: 200, body: '', headers: {},
    writeHead(s, h) { o.status = s; if (h) o.headers = h },
    end(s) { if (s !== undefined) o.body = String(s) },
  }
  return o
}
function makeReq(method = 'GET', body = '', host = '127.0.0.1:61473', url = '/', extra = {}) {
  return {
    method, url,
    headers: Object.assign({ host }, extra),
    on(ev, fn) {
      if (ev === 'data' && body) fn(body)
      if (ev === 'end') fn()
      // 'error' is registered but never fired in the mock
    },
  }
}
async function call(routes, path, method = 'GET', body = '', extra = {}) {
  const route = routes.get(path.split('?')[0])
  assert.ok(route, 'route registered: ' + path)
  const r = makeRes()
  await route.handler(makeReq(method, body, '127.0.0.1:61473', path, extra), r)
  return { status: r.status, headers: r.headers, raw: r.body, json: r.body ? JSON.parse(r.body) : null }
}
const localDay = (ts) => {
  const d = new Date(ts)
  const p = (x) => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function fire(handlers, session, event) {
  const fn = handlers.get('session/event')
  assert.ok(fn, 'session/event subscribed')
  fn(session, event)
}
function message(session, turn, model, usage) {
  return {
    type: 'assistant/message',
    data: { turn, usage, message: { source: { model } } },
  }
}
const end = { type: 'turn/end', data: {} }

// ---------------------------------------------------------------- first boot
const first = makeCtx()
mod.apply(first.ctx)
const sA = { id: 'sess-A', name: '测试会话 A' }
const sB = { id: 'sess-B', name: '测试会话 B' }

// Turn 1 of session A: two model steps, one of them reports reasoning.
fire(first.handlers, sA, message(sA, 1, 'deepseek-v4', {
  inputTokens: 100, cacheReadTokens: 50, cacheWriteTokens: 10,
  outputTokens: 200, reasoningTokens: 80,
}))
fire(first.handlers, sA, message(sA, 1, 'glm-flash', {
  inputTokens: 20, outputTokens: 30,
}))
fire(first.handlers, sA, end)

fire(first.handlers, sA, { type: 'session/title', data: { title: '重命名后的会话' } })

// A different session must not bleed into A's bucket.
fire(first.handlers, sB, message(sB, 1, 'deepseek-v4', { inputTokens: 5, outputTokens: 7 }))
fire(first.handlers, sB, end)

// An unfinished turn stays in memory (pendingTurns) and is not on disk yet.
fire(first.handlers, sA, message(sA, 2, 'deepseek-v4', { inputTokens: 9, outputTokens: 11 }))

const data = await call(first.routes, '/dsh-token-ledger/data.json')
const d = data.json
assert.equal(d.ok, true, 'data.json ok')
assert.equal(d.plugin, 'dsh-token-ledger')

// 360 = 100+50+10+200 (reasoning 80 is INSIDE output 200, not added again)
// 50  = 20+30  -> session A turn 1 = 410
// 12  = 5+7    -> session B turn 1
assert.equal(d.totals.liveEvents, 3, 'three live rows')
assert.equal(d.totals.historyEvents, 2, 'two imported whale rows')
assert.equal(d.totals.turns, 2, 'two committed turns')
assert.equal(d.totals.sessions, 3, 'A + B + one synthetic history session')
assert.equal(d.totals.input, 125, 'input 100+20+5')
assert.equal(d.totals.cacheRead, 50)
assert.equal(d.totals.cacheWrite, 10)
assert.equal(d.totals.output, 237, 'output 200+30+7')
assert.equal(d.totals.reasoning, 80, 'reasoning recorded but not billed twice')
assert.equal(d.totals.total, 410 + 12 + HISTORY_TOTAL, 'total = live + history')
assert.equal(d.pendingTurns, 1, 'unfinished turn still aggregating')

const sessA = d.sessions.find((s) => s.id === 'sess-A')
assert.ok(sessA, 'session A present')
assert.equal(sessA.total, 410, 'session A total')
assert.equal(sessA.title, '重命名后的会话', 'title event applied')
assert.equal(sessA.turns, 1)
assert.equal(sessA.events, 2, 'two model rows in the turn')
assert.equal(sessA.reasoning, 80)
const sessB = d.sessions.find((s) => s.id === 'sess-B')
assert.equal(sessB.total, 12, 'session B isolated')
const hist = d.sessions.find((s) => s.id === '__history_whale__')
assert.ok(hist, 'history session present')
assert.equal(hist.total, HISTORY_TOTAL)
assert.equal(d.history.events, 2)
assert.equal(d.history.tokens, HISTORY_TOTAL)
assert.equal(d.models.find((m) => m.model === 'deepseek-v4').total, 372, '360 + 12')

// ------------------------------------------- cached payload / ETag / 304
const full1 = await call(first.routes, '/dsh-token-ledger/data.json')
assert.equal(full1.status, 200, 'unconditional GET is 200')
assert.equal(full1.headers['cache-control'], 'no-store', 'responses are never browser-cached')
const tag = full1.headers.etag
assert.ok(/^"[0-9a-f]{16}"$/.test(tag || ''), 'strong content-derived ETag: ' + tag)
assert.equal(typeof full1.json.revision, 'number', 'payload exposes a revision')

const full2 = await call(first.routes, '/dsh-token-ledger/data.json')
assert.equal(full2.headers.etag, tag, 'unchanged revision keeps the same ETag')
assert.equal(full2.raw, full1.raw, 'cached serialization is byte-identical')

const notModified = await call(first.routes, '/dsh-token-ledger/data.json', 'GET', '',
  { 'if-none-match': tag })
assert.equal(notModified.status, 304, 'matching If-None-Match gets a bare 304')
assert.equal(notModified.raw, '', '304 carries no body')
assert.equal(notModified.headers.etag, tag, '304 echoes the ETag')

const stale = await call(first.routes, '/dsh-token-ledger/data.json', 'GET', '',
  { 'if-none-match': '"0000000000000000"' })
assert.equal(stale.status, 200, 'stale ETag falls back to a full 200')
assert.ok(stale.raw.length > 100, 'stale ETag still returns the whole payload')

// Different query URLs are cached independently.
const qb = await call(first.routes, '/dsh-token-ledger/query.json?group=before')
const qa = await call(first.routes, '/dsh-token-ledger/query.json?group=after')
assert.ok(qb.headers.etag && qa.headers.etag, 'every query carries an ETag')
assert.notEqual(qb.headers.etag, qa.headers.etag, 'different filters get different cache entries')

const h1 = (await call(first.routes, '/dsh-token-ledger/health.json')).json
assert.equal(h1.revision, full1.json.revision, 'health.json exposes the same revision')

const ledgerFile = join(home, 'token-ledger', 'ledger.json')
assert.ok(existsSync(ledgerFile), 'ledger written to DSH_HOME/token-ledger/ledger.json')
const onDisk = JSON.parse(readFileSync(ledgerFile, 'utf8'))
assert.equal(onDisk.events.length, 5, '2 history + 3 live rows on disk')
assert.equal(onDisk.events.filter((e) => e.source === 'live').length, 3)

// ------------------------------------------------------- simulated restart
const second = makeCtx()
mod.apply(second.ctx)
const d2 = (await call(second.routes, '/dsh-token-ledger/data.json')).json
assert.equal(d2.totals.total, 410 + 12 + HISTORY_TOTAL, 'ledger survives restart')
assert.equal(d2.totals.liveEvents, 3)
assert.equal(d2.pendingTurns, 0, 'in-flight turn discarded on restart')
const health = (await call(second.routes, '/dsh-token-ledger/health.json')).json
assert.equal(health.ok, true)
assert.equal(health.events, 5)
assert.ok(health.baselineAt > 0, 'health exposes the book split point')

// ------------------------------------------------- two books + filter engine
const BEFORE = d2.groups.before
const AFTER = d2.groups.after
assert.ok(BEFORE && AFTER, 'two books present')
assert.equal(BEFORE.events + AFTER.events, d2.totals.events, 'books partition all events')
assert.equal(BEFORE.total + AFTER.total, d2.totals.total, 'books partition all tokens')
assert.equal(BEFORE.input + AFTER.input, d2.totals.input, 'books partition input')
assert.equal(BEFORE.cacheRead + AFTER.cacheRead, d2.totals.cacheRead, 'books partition cacheRead')
assert.equal(BEFORE.cacheWrite + AFTER.cacheWrite, d2.totals.cacheWrite, 'books partition cacheWrite')
assert.equal(BEFORE.output + AFTER.output, d2.totals.output, 'books partition output')
assert.equal(BEFORE.historyEvents, 2, 'pre-install history sits in the before book')
assert.ok(BEFORE.topModels.length >= 1, 'before book lists its top models')

assert.ok(Array.isArray(d2.weeks) && d2.weeks.length >= 1, 'weekly rollup present')
assert.ok(Array.isArray(d2.months) && d2.months.length >= 1, 'monthly rollup present')
for (const row of d2.weeks.concat(d2.months, d2.days)) {
  for (const k of ['events', 'input', 'cacheRead', 'cacheWrite', 'output', 'total', 'turns', 'sessionCount']) {
    assert.equal(typeof row[k], 'number', 'rollup row has numeric ' + k)
  }
}
assert.ok(d2.facets.weeks.length >= 1 && d2.facets.months.length >= 1, 'facet choices for week/month filter')
assert.equal(d2.filter.group, 'all', 'unfiltered query reports group=all')

const qBefore = (await call(second.routes, '/dsh-token-ledger/query.json?group=before')).json
assert.equal(qBefore.ok, true)
assert.equal(qBefore.filter.group, 'before')
assert.equal(qBefore.totals.total, BEFORE.total, 'group=before scopes the whole page')
assert.equal(qBefore.totals.events, BEFORE.events)
const qAfter = (await call(second.routes, '/dsh-token-ledger/query.json?group=after')).json
assert.equal(qAfter.filter.group, 'after')
assert.equal(qAfter.totals.total, AFTER.total, 'group=after scopes the whole page')

const fromOld = localDay(OLD - 86400000)
const toOld = localDay(OLD + 86400000)
const qRange = (await call(second.routes,
  `/dsh-token-ledger/query.json?from=${fromOld}&to=${toOld}&label=history-days`)).json
assert.equal(qRange.filter.events, 2, 'date range selects only the two history rows')
assert.equal(qRange.totals.total, HISTORY_TOTAL, 'date range total')
assert.equal(qRange.filter.label, 'history-days', 'label echoed back')
assert.equal(qRange.sessions.length, 1, 'sessions rebuilt from the selected events only')
assert.equal(qRange.models.length, 2, 'models rebuilt from the selected events only')

const empty = (await call(second.routes,
  '/dsh-token-ledger/query.json?from=1970-01-01&to=1970-01-02')).json
assert.equal(empty.totals.events, 0, 'empty range returns an empty aggregate')
assert.equal(empty.totals.total, 0)
assert.equal(empty.sessions.length, 0)

const w0 = d2.facets.weeks[0]
const qWeek = (await call(second.routes,
  `/dsh-token-ledger/query.json?from=${localDay(w0.startTs)}&to=${localDay(w0.endTs)}`)).json
assert.ok(qWeek.totals.events > 0, 'week picker range is inclusive')
assert.equal(qWeek.totals.total, w0.total, 'week picker matches the weekly rollup')

const base0 = health.baselineAt
const tagBeforeWrite = (await call(second.routes, '/dsh-token-ledger/data.json')).headers.etag
const moved = await call(second.routes, '/dsh-token-ledger/baseline', 'POST',
  JSON.stringify({ at: Date.now() + 86400000 }))
assert.equal(moved.json.ok, true)
assert.equal(moved.json.previousBaselineAt, base0)
assert.ok(moved.json.baselineAt > base0, 'baseline moved forward')
const tagAfterWrite = (await call(second.routes, '/dsh-token-ledger/data.json')).headers.etag
assert.notEqual(tagAfterWrite, tagBeforeWrite, 'a write invalidates the cached payload')
const staleAfterWrite = await call(second.routes, '/dsh-token-ledger/data.json', 'GET', '',
  { 'if-none-match': tagBeforeWrite })
assert.equal(staleAfterWrite.status, 200, 'old ETag no longer matches after a write')
const dMoved = (await call(second.routes, '/dsh-token-ledger/data.json')).json
assert.equal(dMoved.baselineAt, moved.json.baselineAt)
assert.equal(dMoved.groups.before.total + dMoved.groups.after.total, d2.totals.total,
  'moving the split never changes the combined total')
assert.equal(dMoved.groups.after.total, 0, 'future split puts everything in the before book')
const restored = await call(second.routes, '/dsh-token-ledger/baseline', 'POST',
  JSON.stringify({ reset: true }))
assert.equal(restored.json.baselineAt, d2.firstStartAt, 'baseline reset returns to first start')
const dRestored = (await call(second.routes, '/dsh-token-ledger/data.json')).json
assert.deepEqual(
  [dRestored.groups.before.total, dRestored.groups.after.total],
  [BEFORE.total, AFTER.total], 'reset restores the original two books')

// Re-import must add nothing (idempotent by ts|model|tokens).
const imp = await call(second.routes, '/dsh-token-ledger/import-history', 'POST', '{}')
assert.equal(imp.json.ok, true)
assert.equal(imp.json.imported, 0, 'history import is idempotent')

// Reset keeps history, clears live.
const badReset = await call(second.routes, '/dsh-token-ledger/reset', 'POST', '{}')
assert.equal(badReset.status, 400, 'reset refuses without confirm')
const rst = await call(second.routes, '/dsh-token-ledger/reset', 'POST', JSON.stringify({ confirm: true }))
assert.equal(rst.json.ok, true)
const d3 = (await call(second.routes, '/dsh-token-ledger/data.json')).json
assert.equal(d3.totals.liveEvents, 0, 'live cleared')
assert.equal(d3.totals.historyEvents, 2, 'history preserved')
assert.equal(d3.totals.total, HISTORY_TOTAL, 'only history remains')

// Trust fence: a forged non-loopback Host gets 403, no body.
const forged = makeRes()
await second.routes.get('/dsh-token-ledger/data.json').handler(
  makeReq('GET', '', 'evil.example.com'), forged,
)
assert.equal(forged.statusCode, 403, 'non-loopback Host rejected')

// Export returns the raw ledger.
const exp = (await call(second.routes, '/dsh-token-ledger/export.json')).json
assert.equal(exp.plugin, 'dsh-token-ledger')
assert.equal(exp.events.length, 2)

// Routes present.
for (const p of ['/dsh-token-ledger/data.json', '/dsh-token-ledger/query.json',
  '/dsh-token-ledger/health.json', '/dsh-token-ledger/export.json',
  '/dsh-token-ledger/baseline', '/dsh-token-ledger/import-history',
  '/dsh-token-ledger/reset']) {
  assert.ok(second.routes.has(p), 'route ' + p)
}

rmSync(home, { recursive: true, force: true })
console.log('ALL MOCK-HOST ASSERTIONS PASSED')
console.log('  live total=422  history=' + HISTORY_TOTAL + '  combined=' + (422 + HISTORY_TOTAL))
console.log('  verified: turn bucketing, no reasoning double-count, per-session isolation,')
console.log('            title events, whale import + idempotency, restart durability,')
console.log('            reset semantics, loopback trust fence, all 7 routes,')
console.log('            two books at a movable baseline, group/date/week filtering,')
console.log('            weekly + monthly rollups with all four token buckets')

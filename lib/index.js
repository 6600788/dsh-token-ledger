/**
 * dsh-token-ledger — host half
 * ============================================================================
 * Two jobs, and nothing else:
 *
 *   1. Listen to the host's `session/event` stream and book every model call's
 *      token usage into a durable, per-session ledger on disk.
 *   2. Serve that ledger (aggregated, never the raw file) over read-only HTTP
 *      routes so the client half can render the sidebar page.
 *
 * Design notes that matter for correctness:
 *
 *  - DSH emits one `assistant/message` event per model step. A single user turn
 *    can contain many such events (tool calls, reasoning, retries, subagents).
 *    They are bucketed by (sessionId, turn) and only committed on `turn/end`
 *    (or when the next turn of the same session starts). That is the same
 *    bucketing the shipped whale-balance-widget uses, and it is what stops
 *    parallel sessions from writing into each other's totals.
 *
 *  - `usage.outputTokens` already CONTAINS `usage.reasoningTokens`. Adding
 *    reasoning on top would double-count the output side. We record reasoning
 *    separately as an informational number and never add it to ``total``.
 *
 *  - `usage.inputTokens` is the uncached input; `cacheReadTokens` is the cached
 *    input; `cacheWriteTokens` is usually folded into input by the provider but
 *    is kept as its own column so the four add up to the provider's own total.
 *    When the provider supplies `totalTokens` we still prefer the sum of the
 *    four parts, because that is the only shape that stays comparable across
 *    every model this host can talk to.
 *
 *  - Every filesystem operation is wrapped. A ledger that cannot be written
 *    must never take the host down; the in-memory copy keeps answering anyway.
 *
 *  - Historical coverage: on first run we import the existing
 *    `.dshw-usage.json` (whale-balance-widget's per-model event log) as a
 *    single synthetic session, strictly for events older than this plugin's
 *    first start. From then on this plugin is the only writer of live data, so
 *    no event is ever counted twice. Re-import is idempotent by event key.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const name = 'dsh-token-ledger'
/** The web server is the only service this half needs. */
export const inject = ['webServer']

const BASE = '/dsh-token-ledger'
const VERSION = '1.2.0'
const MAX_EVENTS = 20000
const MAX_SESSIONS = 4000
/** Archive rather than silently drop when the live event log is full. */
const ARCHIVE_SUFFIX = '.archive.json'

function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}
function dataDir() {
  return join(dshHome(), 'token-ledger')
}
function ledgerPath() {
  return join(dataDir(), 'ledger.json')
}
/** whale-balance-widget's per-model event log; read-only, historical only. */
function whaleUsageCandidates() {
  const home = dshHome()
  return [
    join(home, '.dshw-usage.json'),
    join(home, 'profiles', 'web', '.dshw-usage.json'),
    join(home, 'profiles', 'desktop', '.dshw-usage.json'),
    join(home, '.dshw-usage-archive.json'),
  ]
}

const num = (v) => {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : 0
}
const str = (v, fallback = '') => {
  const s = String(v == null ? '' : v).trim()
  return s ? s.slice(0, 160) : fallback
}
const dayKey = (ts) => {
  try {
    const d = new Date(ts)
    const p = (x) => String(x).padStart(2, '0')
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
  } catch {
    return '1970-01-01'
  }
}

/** ISO week (Monday-based), with local-time day boundaries. */
function weekInfo(ts) {
  try {
    const d = new Date(ts)
    const p = (x) => String(x).padStart(2, '0')
    const dow = (d.getDay() + 6) % 7 // Mon = 0
    const start = new Date(d.getFullYear(), d.getMonth(), d.getDate() - dow)
    start.setHours(0, 0, 0, 0)
    const endExclusive = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 7)
    endExclusive.setHours(0, 0, 0, 0)
    const sun = new Date(endExclusive.getTime() - 86400000)
    // The Thursday of a week decides its ISO year.
    const thu = new Date(Date.UTC(start.getFullYear(), start.getMonth(), start.getDate() + 3))
    const firstThu = new Date(Date.UTC(thu.getUTCFullYear(), 0, 4))
    firstThu.setUTCDate(firstThu.getUTCDate() - ((firstThu.getUTCDay() + 6) % 7) + 3)
    const week = 1 + Math.round((thu - firstThu) / (7 * 86400000))
    return {
      key: `${thu.getUTCFullYear()}-W${p(week)}`,
      label: `${p(start.getMonth() + 1)}/${p(start.getDate())}–${p(sun.getMonth() + 1)}/${p(sun.getDate())}`,
      startTs: start.getTime(),
      endTs: endExclusive.getTime() - 1,
    }
  } catch {
    return { key: '1970-W01', label: '—', startTs: 0, endTs: 0 }
  }
}
function monthInfo(ts) {
  try {
    const d = new Date(ts)
    const p = (x) => String(x).padStart(2, '0')
    const y = d.getFullYear(), m = d.getMonth()
    const start = new Date(y, m, 1); start.setHours(0, 0, 0, 0)
    const end = new Date(y, m + 1, 1); end.setHours(0, 0, 0, 0)
    return {
      key: `${y}-${p(m + 1)}`, label: `${y} 年 ${m + 1} 月`,
      startTs: start.getTime(), endTs: end.getTime() - 1,
    }
  } catch {
    return { key: '1970-01', label: '—', startTs: 0, endTs: 0 }
  }
}

function emptyLedger(now) {
  return {
    version: 1,
    plugin: name,
    pluginVersion: VERSION,
    createdAt: new Date(now).toISOString(),
    firstStartAt: now,
    /** The line between "before" and "now". Movable via POST /baseline. */
    baselineAt: now,
    history: null,
    /** Imported whale event keys, so a re-import never double counts. */
    importedKeys: [],
    sessions: {},
    events: [],
    seq: 0,
  }
}

function normalizeLedger(raw, now) {
  const base = emptyLedger(now)
  if (!raw || typeof raw !== 'object') return base
  base.createdAt = str(raw.createdAt, base.createdAt)
  base.firstStartAt = num(raw.firstStartAt) || now
  // Ledgers written by v1.0.0 have no baseline: the install moment is the line.
  base.baselineAt = num(raw.baselineAt) || base.firstStartAt
  base.seq = num(raw.seq)
  base.history = raw.history && typeof raw.history === 'object' ? raw.history : null
  base.importedKeys = Array.isArray(raw.importedKeys)
    ? raw.importedKeys.filter((k) => typeof k === 'string').slice(-MAX_EVENTS)
    : []
  if (raw.sessions && typeof raw.sessions === 'object') {
    for (const [id, s] of Object.entries(raw.sessions)) {
      if (!s || typeof s !== 'object') continue
      base.sessions[String(id).slice(0, 200)] = {
        id: str(s.id, String(id).slice(0, 200)),
        title: str(s.title, ''),
        firstTs: num(s.firstTs) || now,
        lastTs: num(s.lastTs) || now,
        turns: num(s.turns),
        events: num(s.events),
        input: num(s.input),
        cacheRead: num(s.cacheRead),
        cacheWrite: num(s.cacheWrite),
        output: num(s.output),
        total: num(s.total),
        reasoning: num(s.reasoning),
        cost: num(s.cost),
        models: s.models && typeof s.models === 'object' ? s.models : {},
      }
    }
  }
  if (Array.isArray(raw.events)) {
    base.events = raw.events
      .filter((e) => e && typeof e === 'object' && Number.isFinite(Number(e.ts)))
      .slice(-MAX_EVENTS)
      .map((e) => ({
        ts: Number(e.ts),
        day: dayKey(Number(e.ts)),
        sessionId: str(e.sessionId, 'default'),
        sessionTitle: str(e.sessionTitle, ''),
        turn: e.turn == null ? null : (Number.isFinite(Number(e.turn)) ? Number(e.turn) : null),
        model: str(e.model, '未知模型'),
        input: num(e.input),
        cacheRead: num(e.cacheRead),
        cacheWrite: num(e.cacheWrite),
        output: num(e.output),
        reasoning: num(e.reasoning),
        total: num(e.total),
        cost: e.cost == null ? null : num(e.cost),
        source: e.source === 'history' ? 'history' : 'live',
      }))
  }
  return base
}

function writeLedger(ledger) {
  try {
    const dir = dataDir()
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const target = ledgerPath()
    const tmp = target + '.tmp'
    writeFileSync(tmp, JSON.stringify(ledger), 'utf8')
    try {
      renameSync(tmp, target)
    } catch {
      // Windows can refuse an atomic replace while another reader holds the file.
      try { writeFileSync(target, JSON.stringify(ledger), 'utf8') } catch { /* keep memory copy */ }
    }
    return true
  } catch {
    return false
  }
}

function archiveIfNeeded(ledger) {
  if (ledger.events.length < MAX_EVENTS) return
  try {
    const cut = Math.floor(MAX_EVENTS / 2)
    const dropped = ledger.events.slice(0, ledger.events.length - cut)
    ledger.events = ledger.events.slice(-cut)
    const dir = dataDir()
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const path = join(dir, 'events' + ARCHIVE_SUFFIX)
    let old = []
    try { old = JSON.parse(readFileSync(path, 'utf8')) } catch { /* new archive */ }
    if (!Array.isArray(old)) old = []
    writeFileSync(path, JSON.stringify(old.concat(dropped).slice(-MAX_EVENTS * 5)), 'utf8')
  } catch { /* archiving is best-effort */ }
}

/**
 * Import whale-balance-widget's historical, per-model event log.
 *
 * Only events strictly older than this plugin's first start are eligible, and
 * every imported event is keyed by (ts|model|tokens) so a second import adds
 * nothing. They land in one synthetic session: the whale log has no session
 * ids, and inventing a fake per-session split would be a lie.
 */
function importWhaleHistory(ledger, force) {
  const HISTORY_SESSION = '__history_whale__'
  const known = new Set(ledger.importedKeys)
  const cutoff = force ? Date.now() : ledger.firstStartAt
  let imported = 0
  let tokens = 0
  let cost = 0
  let from = Infinity
  let to = 0
  for (const candidate of whaleUsageCandidates()) {
    let rows
    try { rows = JSON.parse(readFileSync(candidate, 'utf8')) } catch { continue }
    if (!Array.isArray(rows)) {
      // Current whale builds wrap the log in an object: `events` holds the
      // per-model rows, the rest is balance/day metadata. Older builds wrote
      // a bare array. Accept both, never reinterpret the metadata as usage.
      rows = rows && typeof rows === 'object' && Array.isArray(rows.events)
        ? rows.events : null
    }
    if (!Array.isArray(rows)) continue
    for (const row of rows) {
      try {
        if (!row || typeof row !== 'object') continue
        const ts = Number(row.ts)
        if (!Number.isFinite(ts) || ts <= 0) continue
        // Never import anything that happened after this plugin started: those
        // turns are already in our own live ledger.
        if (ts >= ledger.firstStartAt) continue
        if (force && ts >= cutoff) continue
        const model = str(row.model, '未知模型')
        const tk = num(row.tokens)
        if (tk <= 0) continue
        const key = `${ts}|${model}|${tk}`
        if (known.has(key)) continue
        known.add(key)
        const c = row.cost == null ? null : num(row.cost)
        ledger.events.push({
          ts,
          day: dayKey(ts),
          sessionId: HISTORY_SESSION,
          sessionTitle: '历史用量（安装前 · whale 账本）',
          turn: null,
          model,
          input: 0,
          cacheRead: 0,
          cacheWrite: 0,
          output: 0,
          reasoning: 0,
          total: tk,
          cost: c,
          source: 'history',
        })
        imported++
        tokens += tk
        if (c != null) cost += c
        if (ts < from) from = ts
        if (ts > to) to = ts
      } catch { /* one bad row must not stop the import */ }
    }
  }
  ledger.importedKeys = Array.from(known).slice(-MAX_EVENTS * 2)
  if (imported > 0) {
    const s = ledger.sessions[HISTORY_SESSION] || {
      id: HISTORY_SESSION,
      title: '历史用量（安装前 · whale 账本）',
      firstTs: from,
      lastTs: to,
      turns: 0,
      events: 0,
      input: 0,
      cacheRead: 0,
      cacheWrite: 0,
      output: 0,
      total: 0,
      reasoning: 0,
      cost: 0,
      models: {},
    }
    s.firstTs = Math.min(s.firstTs || from, from)
    s.lastTs = Math.max(s.lastTs || to, to)
    s.events += imported
    s.total += tokens
    s.cost += cost
    s.title = '历史用量（安装前 · whale 账本）'
    const m = s.models['（历史按模型）'] || { total: 0, events: 0 }
    m.total += tokens
    m.events += imported
    s.models['（历史按模型）'] = m
    ledger.sessions[HISTORY_SESSION] = s
    ledger.history = {
      source: '.dshw-usage.json (whale-balance-widget)',
      importedAt: new Date().toISOString(),
      events: (ledger.history && num(ledger.history.events)) + imported,
      tokens: (ledger.history && num(ledger.history.tokens)) + tokens,
      cost: (ledger.history && num(ledger.history.cost)) + cost,
      from: new Date(Math.min(from, (ledger.history && num(ledger.history.fromTs)) || from)).toISOString(),
      to: new Date(to).toISOString(),
      fromTs: Math.min(from, (ledger.history && num(ledger.history.fromTs)) || from),
      toTs: to,
      note: '安装前的历史按模型汇总，无会话归属；安装后的每一轮都有精确会话 id。',
    }
  }
  return imported
}

function sendJson(res, payload, status = 200) {
  try {
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    })
    res.end(JSON.stringify(payload))
  } catch { /* client went away */ }
}

/**
 * Local-only trust fence. The DSH web UI is served from a loopback address;
 * a forged Host, a cross-site fetch, or a mismatched Origin gets a 403. Every
 * route (including the two POSTs) goes through here.
 */
function rejected(req, res) {
  const deny = () => {
    try { res.statusCode = 403; res.end() } catch { /* ignore */ }
    return true
  }
  try {
    const headers = (req && req.headers) || {}
    let hostUrl
    try { hostUrl = new URL('http://' + String(headers.host || '')) } catch { return deny() }
    const h = hostUrl.hostname.toLowerCase().replace(/^\[/, '').replace(/\]$/, '')
    const local = h === 'localhost' || h.endsWith('.localhost') || h === '::1' ||
      /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(h) &&
      [h.split('.')[1], h.split('.')[2], h.split('.')[3]].every((x) => Number(x) <= 255)
    if (!local) {
      const trusted = String(process.env.DSH_TOKEN_LEDGER_HOSTS || '')
        .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
      if (!trusted.some((e) => e === hostUrl.host.toLowerCase() || e === h)) return deny()
    }
    if (String(headers['sec-fetch-site'] || '').toLowerCase() === 'cross-site') return deny()
    const origin = headers.origin
    if (typeof origin === 'string' && origin && origin !== 'null') {
      let o
      try { o = new URL(origin) } catch { return deny() }
      // Custom local schemes (dsh-app:, app:, file:) belong to the desktop
      // shell itself; they have no network host to compare against. Only
      // http/https origins can be meaningfully matched to the request Host.
      if ((o.protocol === 'http:' || o.protocol === 'https:') &&
          o.host.toLowerCase() !== hostUrl.host.toLowerCase()) return deny()
    }
    // The host's own connection fence is optional. Some builds expose it, some
    // don't, and `ctx.get` throws for undeclared services — none of that is a
    // reason to reject our own loopback page, since the checks above stand on
    // their own.
    return false
  } catch { return deny() }
}

/** Set inside apply() so rejected() can reach the host's connection service. */
let ctxGet = null

function readBody(req) {
  return new Promise((resolve) => {
    let body = ''
    try {
      req.on('data', (c) => { body += String(c); if (body.length > 65536) body = body.slice(0, 65536) })
      req.on('end', () => resolve(body))
      req.on('error', () => resolve(body))
    } catch { resolve(body) }
  })
}

export function apply(ctx) {
  ctxGet = typeof ctx.get === 'function' ? (k) => ctx.get(k) : null
  const now = Date.now()
  let ledger
  try {
    ledger = normalizeLedger(JSON.parse(readFileSync(ledgerPath(), 'utf8')), now)
  } catch {
    ledger = emptyLedger(now)
  }
  let dirty = false
  // One-time backfill of pre-install history. Idempotent across restarts.
  try {
    if (importWhaleHistory(ledger, false) > 0) dirty = true
  } catch { /* history import is optional */ }
  if (dirty || !existsSync(ledgerPath())) writeLedger(ledger)

  let revision = 0
  let snapshotAt = new Date(now).toISOString()
  const payloadCache = new Map()
  /**
   * Reads happen every 5s; writes happen a few times per turn. Invalidate the
   * serialized snapshot only when the underlying data actually changes, so an
   * unchanged page costs a bare 304 instead of re-aggregating up to 20k events
   * and shipping the whole JSON body. `snapshotAt` is frozen per revision,
   * which keeps the payload (and therefore its ETag) byte-stable between
   * writes — a fresh Date.now() on every read would defeat the whole cache.
   */
  const bump = () => {
    revision += 1
    snapshotAt = new Date().toISOString()
    if (payloadCache.size) payloadCache.clear()
  }

  const persist = () => {
    archiveIfNeeded(ledger)
    writeLedger(ledger)
    bump()
  }

  /**
   * Cached, ETag-aware JSON. A conditional GET whose tag still matches gets a
   * bare 304 (no body), so an unchanged page costs ~200 bytes instead of the
   * full payload and does not trigger a React re-render.
   */
  function sendPayload(req, res, opts, key) {
    let hit = payloadCache.get(key)
    if (!hit) {
      const body = JSON.stringify(buildPayload(opts))
      const tag = '"' + createHash('sha256').update(body).digest('hex').slice(0, 16) + '"'
      hit = { body, tag }
      if (payloadCache.size >= 32) payloadCache.clear()
      payloadCache.set(key, hit)
    }
    const inm = String((req && req.headers && req.headers['if-none-match']) || '')
    if (inm.split(',').map((s) => s.trim()).indexOf(hit.tag) >= 0) {
      try { res.writeHead(304, { etag: hit.tag, 'cache-control': 'no-store' }); res.end() } catch { /* client went away */ }
      return
    }
    try {
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        etag: hit.tag,
      })
      res.end(hit.body)
    } catch { /* client went away */ }
  }

  /** sessionId -> { turn, ts, models: { model -> usage } } */
  const turnAggs = new Map()
  const titles = new Map()

  function titleFromService(session) {
    try {
      const svc = ctxGet && ctxGet('sessionTitle')
      if (!svc || typeof svc.get !== 'function' || !session) return ''
      const snap = svc.get(session)
      const t = typeof snap === 'string' ? snap : (snap && (snap.title || snap.text))
      return str(t, '')
    } catch { return '' }
  }
  function pickSessionTitle(session) {
    try {
      if (!session || typeof session !== 'object') return ''
      const cands = [session.name, session.title, session.label,
        session.summary && session.summary.title, session.summary && session.summary.name,
        session.meta && session.meta.title, session.meta && session.meta.name]
      for (const c of cands) { const s = str(c, ''); if (s) return s }
    } catch { /* ignore */ }
    return ''
  }
  function sessionTitle(sid, session) {
    const fromEvent = titles.get(sid)
    if (fromEvent) return fromEvent
    return titleFromService(session) || pickSessionTitle(session) || ''
  }
  function touchSession(sid, title, ts) {
    let s = ledger.sessions[sid]
    if (!s) {
      // Keep the map bounded; evict the oldest session if we must.
      const keys = Object.keys(ledger.sessions)
      if (keys.length >= MAX_SESSIONS) {
        keys.sort((a, b) => (ledger.sessions[a].lastTs || 0) - (ledger.sessions[b].lastTs || 0))
        for (const k of keys.slice(0, Math.max(1, Math.floor(MAX_SESSIONS / 10)))) delete ledger.sessions[k]
      }
      s = {
        id: sid, title: title || '', firstTs: ts, lastTs: ts,
        turns: 0, events: 0, input: 0, cacheRead: 0, cacheWrite: 0,
        output: 0, total: 0, reasoning: 0, cost: 0, models: {},
      }
      ledger.sessions[sid] = s
    }
    if (title && (!s.title || s.title === sid)) s.title = title
    s.firstTs = Math.min(s.firstTs || ts, ts)
    s.lastTs = Math.max(s.lastTs || ts, ts)
    return s
  }
  function addToModel(map, model, u) {
    let m = map[model]
    if (!m) m = map[model] = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, total: 0, events: 0 }
    m.input += u.input; m.cacheRead += u.cacheRead; m.cacheWrite += u.cacheWrite
    m.output += u.output; m.total += u.total; m.events += 1
  }
  /** Commit one aggregated (session, turn) bucket into the durable event log. */
  function finalizeTurn(sid) {
    const agg = turnAggs.get(sid)
    if (!agg) return
    turnAggs.delete(sid)
    const ts = agg.ts || Date.now()
    const title = sessionTitle(sid, agg.session) || titles.get(sid) || ''
    const session = touchSession(sid, title, ts)
    session.turns += 1
    for (const [model, u] of Object.entries(agg.models)) {
      if (u.total <= 0 && u.input <= 0 && u.output <= 0) continue
      ledger.seq += 1
      const ev = {
        ts, day: dayKey(ts), sessionId: sid, sessionTitle: title,
        turn: agg.turn, model,
        input: u.input, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite,
        output: u.output, reasoning: u.reasoning, total: u.total,
        cost: null, source: 'live',
      }
      ledger.events.push(ev)
      session.events += 1
      session.input += u.input; session.cacheRead += u.cacheRead
      session.cacheWrite += u.cacheWrite; session.output += u.output
      session.total += u.total; session.reasoning += u.reasoning
      addToModel(session.models, model, u)
    }
    persist()
  }

  function onSessionEvent(session, event) {
    try {
      const sid = session && session.id ? str(session.id, 'default') : 'default'
      const type = event && event.type
      const d = (event && event.data) || {}
      if (type === 'session/title') {
        const t = str(d.title, '')
        if (t) {
          const changed = titles.get(sid) !== t
          titles.set(sid, t)
          const s = ledger.sessions[sid]
          if (s) { s.title = t; writeLedger(ledger) }
          if (changed) bump()
        }
        return
      }
      const title = sessionTitle(sid, session)
      if (title && titles.get(sid) !== title) { titles.set(sid, title); bump() }
      if (type === 'turn/end') { finalizeTurn(sid); return }
      if (type !== 'assistant/message') return
      const turn = Number(d.turn)
      const usage = d.usage
      if (!usage || typeof usage !== 'object' || !Number.isFinite(turn)) return
      // DSH's tokenUsage projection maps usage.inputTokens -> uncachedInputTokens
      // (see dsh-token-meter bucketsFrom). Some providers report the uncached
      // name directly. Use ONE of them, never the sum: they are aliases.
      const input = num(usage.inputTokens) || num(usage.uncachedInputTokens)
      const cacheRead = num(usage.cacheReadTokens)
      const cacheWrite = num(usage.cacheWriteTokens)
      const output = num(usage.outputTokens)
      // reasoningTokens is a SUBSET of outputTokens in DSH. Never add it again.
      const reasoning = num(usage.reasoningTokens)
      const total = input + cacheRead + cacheWrite + output
      if (total <= 0) return
      const model = str(
        (d.message && d.message.source && d.message.source.model) ||
        d.model || (d.message && d.message.model),
        '未知模型',
      )
      let agg = turnAggs.get(sid)
      if (!agg || agg.turn !== turn) {
        if (agg) finalizeTurn(sid)
        agg = { turn, ts: Date.now(), session, models: {} }
        turnAggs.set(sid, agg)
        // pendingTurns is part of the read payload: invalidate the snapshot.
        bump()
      }
      let u = agg.models[model]
      if (!u) u = agg.models[model] = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0, total: 0 }
      u.input += input; u.cacheRead += cacheRead; u.cacheWrite += cacheWrite
      u.output += output; u.reasoning += reasoning; u.total += total
      agg.ts = Date.now()
    } catch { /* one malformed event must not kill the ledger */ }
  }

  // ------------------------------------------------------------------ routes
  function registerRoute(route) {
    const inner = route.handler
    return ctx.webServer.register(Object.assign({}, route, {
      handler: async (req, res) => {
        if (rejected(req, res)) return
        try { return await inner(req, res) } catch (err) {
          sendJson(res, { ok: false, error: String((err && err.message) || err) }, 500)
        }
      },
    }))
  }

  // --------------------------------------------------------------- aggregation
  /**
   * One accumulator. `turns` is a Set so a (session, turn) touched by many
   * model steps counts once. Sessions/models are rebuilt from the SELECTED
   * events, so every number on the page agrees with the active filter.
   */
  function makeAgg() {
    return {
      events: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0,
      reasoning: 0, total: 0, cost: 0, costEvents: 0,
      liveEvents: 0, historyEvents: 0,
      turns: new Set(), sessions: {}, models: {},
    }
  }
  function acc(a, e) {
    a.events += 1
    a.input += e.input; a.cacheRead += e.cacheRead
    a.cacheWrite += e.cacheWrite; a.output += e.output
    a.reasoning += e.reasoning; a.total += e.total
    if (e.cost != null) { a.cost += e.cost; a.costEvents += 1 }
    if (e.source === 'history') a.historyEvents += 1; else a.liveEvents += 1
    if (e.turn != null) a.turns.add(`${e.sessionId}|${e.turn}`)
    let s = a.sessions[e.sessionId]
    if (!s) s = a.sessions[e.sessionId] = {
      id: e.sessionId, title: e.sessionTitle || '',
      firstTs: e.ts, lastTs: e.ts, turns: new Set(), events: 0,
      input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0,
      total: 0, cost: 0, models: {},
    }
    if (e.ts < s.firstTs) s.firstTs = e.ts
    if (e.ts > s.lastTs) s.lastTs = e.ts
    if (!s.title && e.sessionTitle) s.title = e.sessionTitle
    if (e.turn != null) s.turns.add(e.turn)
    s.events += 1; s.input += e.input; s.cacheRead += e.cacheRead
    s.cacheWrite += e.cacheWrite; s.output += e.output
    s.reasoning += e.reasoning; s.total += e.total
    if (e.cost != null) s.cost += e.cost
    let sm = s.models[e.model]
    if (!sm) sm = s.models[e.model] = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, total: 0, events: 0 }
    sm.input += e.input; sm.cacheRead += e.cacheRead; sm.cacheWrite += e.cacheWrite
    sm.output += e.output; sm.total += e.total; sm.events += 1
    let m = a.models[e.model]
    if (!m) m = a.models[e.model] = {
      model: e.model, events: 0, input: 0, cacheRead: 0, cacheWrite: 0,
      output: 0, reasoning: 0, total: 0, sessions: {},
    }
    m.events += 1; m.input += e.input; m.cacheRead += e.cacheRead
    m.cacheWrite += e.cacheWrite; m.output += e.output
    m.reasoning += e.reasoning; m.total += e.total
    m.sessions[e.sessionId] = 1
  }
  function plain(a, extra) {
    return Object.assign({
      events: a.events, input: a.input, cacheRead: a.cacheRead,
      cacheWrite: a.cacheWrite, output: a.output, reasoning: a.reasoning,
      total: a.total, cost: a.cost, costEvents: a.costEvents,
      liveEvents: a.liveEvents, historyEvents: a.historyEvents,
      turns: a.turns.size,
    }, extra || {})
  }
  function rowsFrom(a) {
    const sessionName = (s) => {
      // A `session/title` event lands AFTER the turn that produced the rows, so
      // the title stored on the event row is stale. Prefer the latest title we
      // observed in this process, then the persisted session record (survives a
      // restart), and only then the snapshot embedded in the event itself.
      const live = titles.get(s.id)
      if (live) return live
      const stored = ledger.sessions && ledger.sessions[s.id]
      if (stored && stored.title) return stored.title
      if (s.title) return s.title
      return s.id === '__history_whale__' ? '历史用量（安装前 · whale 账本）' : '（未命名会话）'
    }
    return {
      sessions: Object.values(a.sessions).map((s) => ({
        id: s.id,
        title: sessionName(s),
        firstTs: s.firstTs, lastTs: s.lastTs,
        turns: s.turns.size, events: s.events,
        input: s.input, cacheRead: s.cacheRead, cacheWrite: s.cacheWrite,
        output: s.output, reasoning: s.reasoning, total: s.total, cost: s.cost,
        models: s.models, modelCount: Object.keys(s.models).length,
      })).sort((x, y) => y.lastTs - x.lastTs),
      models: Object.values(a.models).map((m) => ({
        model: m.model, events: m.events, input: m.input, cacheRead: m.cacheRead,
        cacheWrite: m.cacheWrite, output: m.output, reasoning: m.reasoning,
        total: m.total, sessionCount: Object.keys(m.sessions).length,
      })).sort((x, y) => y.total - x.total),
    }
  }
  /** Week/month/day choices for the filter dropdowns, across the WHOLE ledger. */
  function facets(all) {
    const w = {}, m = {}, d = {}
    for (const e of all) {
      const wi = weekInfo(e.ts)
      if (!w[wi.key]) w[wi.key] = { key: wi.key, label: wi.label, startTs: wi.startTs, endTs: wi.endTs, total: 0, events: 0 }
      w[wi.key].total += e.total; w[wi.key].events += 1
      const mi = monthInfo(e.ts)
      if (!m[mi.key]) m[mi.key] = { key: mi.key, label: mi.label, startTs: mi.startTs, endTs: mi.endTs, total: 0, events: 0 }
      m[mi.key].total += e.total; m[mi.key].events += 1
      d[e.day || dayKey(e.ts)] = 1
    }
    const dayKeys = Object.keys(d).sort()
    return {
      weeks: Object.values(w).sort((a, b) => b.key.localeCompare(a.key)),
      months: Object.values(m).sort((a, b) => b.key.localeCompare(a.key)),
      firstDay: dayKeys[0] || null,
      lastDay: dayKeys[dayKeys.length - 1] || null,
    }
  }
  /** Parse `/query.json?group=&from=&to=`. Dates are local calendar days. */
  function parseFilter(req) {
    let u
    try { u = new URL(String(req.url || '/'), 'http://localhost') } catch { u = new URL('http://localhost/') }
    const q = u.searchParams
    const timeParam = (name, endOfDay) => {
      const s = q.get(name)
      if (!s) return undefined
      if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
        const parts = s.split('-').map(Number)
        const t = new Date(parts[0], parts[1] - 1, parts[2], 0, 0, 0, 0).getTime()
        return endOfDay ? t + 86400000 - 1 : t
      }
      const v = Number(s)
      return Number.isFinite(v) && v > 0 ? v : undefined
    }
    return {
      group: q.get('group') || 'all',
      fromTs: timeParam('from', false),
      toTs: timeParam('to', true),
      label: q.get('label') || '',
    }
  }

  /** Aggregate the durable log into everything the page needs. */
  function buildPayload(opts) {
    opts = opts || {}
    const baselineAt = num(ledger.baselineAt) || ledger.firstStartAt
    const group = opts.group === 'before' || opts.group === 'after' ? opts.group : 'all'
    const fromTs = Number.isFinite(opts.fromTs) ? opts.fromTs : -Infinity
    const toTs = Number.isFinite(opts.toTs) ? opts.toTs : Infinity
    const all = ledger.events
    const selected = []
    let firstAll = Infinity, lastAll = 0
    let bfFrom = Infinity, bfTo = 0, afFrom = Infinity, afTo = 0
    for (const e of all) {
      if (e.ts < firstAll) firstAll = e.ts
      if (e.ts > lastAll) lastAll = e.ts
      if (e.ts < fromTs || e.ts > toTs) continue
      if (group === 'before' && e.ts >= baselineAt) continue
      if (group === 'after' && e.ts < baselineAt) continue
      selected.push(e)
      if (e.ts < baselineAt) { if (e.ts < bfFrom) bfFrom = e.ts; if (e.ts > bfTo) bfTo = e.ts }
      else { if (e.ts < afFrom) afFrom = e.ts; if (e.ts > afTo) afTo = e.ts }
    }

    const root = makeAgg()
    const books = { before: makeAgg(), after: makeAgg() }
    const byDay = {}, byWeek = {}, byMonth = {}
    for (const e of selected) {
      acc(root, e)
      acc(e.ts < baselineAt ? books.before : books.after, e)
      const dk = e.day || dayKey(e.ts)
      if (!byDay[dk]) byDay[dk] = Object.assign({ day: dk }, makeAgg())
      acc(byDay[dk], e)
      const wi = weekInfo(e.ts)
      if (!byWeek[wi.key]) byWeek[wi.key] = Object.assign({}, wi, makeAgg())
      acc(byWeek[wi.key], e)
      const mi = monthInfo(e.ts)
      if (!byMonth[mi.key]) byMonth[mi.key] = Object.assign({}, mi, makeAgg())
      acc(byMonth[mi.key], e)
    }
    const period = (map, keyName) => Object.values(map).map((b) => plain(b, {
      [keyName]: b[keyName], label: b.label, startTs: b.startTs, endTs: b.endTs,
      sessionCount: Object.keys(b.sessions).length,
      modelCount: Object.keys(b.models).length,
    })).sort((x, y) => String(x[keyName]).localeCompare(String(y[keyName])))
    const days = Object.values(byDay).map((b) => plain(b, {
      day: b.day, sessionCount: Object.keys(b.sessions).length,
      models: Object.fromEntries(Object.entries(b.models).map(([k, v]) => [k, v.total])),
    })).sort((x, y) => x.day.localeCompare(y.day))
    const weeks = period(byWeek, 'key')
    const months = period(byMonth, 'key')
    const rows = rowsFrom(root)
    const book = (a, label, from, to) => plain(a, {
      label, fromTs: from, toTs: to,
      sessions: Object.keys(a.sessions).length,
      modelCount: Object.keys(a.models).length,
      topModels: Object.values(a.models)
        .map((m) => ({ model: m.model, total: m.total }))
        .sort((x, y) => y.total - x.total).slice(0, 5),
    })
    return {
      ok: true,
      plugin: name,
      version: VERSION,
      revision,
      generatedAt: snapshotAt,
      ledgerPath: ledgerPath(),
      firstStartAt: ledger.firstStartAt,
      baselineAt,
      firstEventTs: Number.isFinite(firstAll) ? firstAll : null,
      lastEventTs: lastAll || null,
      filter: {
        group,
        fromTs: Number.isFinite(fromTs) ? fromTs : null,
        toTs: Number.isFinite(toTs) ? toTs : null,
        label: str(opts.label, ''),
        events: selected.length,
        totalEvents: all.length,
      },
      totals: plain(root, { sessions: rows.sessions.length }),
      /** The two books, split at baselineAt, both still inside the date filter. */
      groups: {
        before: book(books.before, '之前（历史账）', Number.isFinite(bfFrom) ? bfFrom : null, bfTo || null),
        after: book(books.after, '现在（新账）', Number.isFinite(afFrom) ? afFrom : null, afTo || null),
      },
      history: ledger.history,
      today: days.length ? days[days.length - 1] : null,
      days: days.slice(-120),
      weeks,
      months,
      models: rows.models,
      sessions: rows.sessions,
      recentEvents: selected.slice(-300).reverse().map((e) => ({ ...e })),
      recentEventsTotal: selected.length,
      facets: facets(all),
      /** True while a live turn is still being aggregated (not yet on disk). */
      pendingTurns: turnAggs.size,
    }
  }

  const routes = [
    {
      kind: 'exact', path: BASE + '/data.json',
      handler: (req, res) => sendPayload(req, res, undefined, 'data'),
    },
    {
      kind: 'exact', path: BASE + '/query.json',
      handler: (req, res) => sendPayload(req, res, parseFilter(req), 'query|' + String(req.url || '')),
    },
    {
      kind: 'exact', path: BASE + '/health.json',
      handler: (req, res) => sendJson(res, {
        ok: true, plugin: name, version: VERSION, revision,
        events: ledger.events.length,
        sessions: Object.keys(ledger.sessions).length,
        ledgerPath: ledgerPath(),
        firstStartAt: ledger.firstStartAt,
        baselineAt: num(ledger.baselineAt) || ledger.firstStartAt,
        history: ledger.history,
        pendingTurns: turnAggs.size,
      }),
    },
    {
      kind: 'exact', path: BASE + '/export.json',
      handler: (req, res) => sendJson(res, ledger),
    },
    {
      kind: 'exact', path: BASE + '/baseline',
      handler: async (req, res) => {
        if (String(req.method || 'GET').toUpperCase() !== 'POST') {
          sendJson(res, { ok: false, error: 'POST required' }, 405); return
        }
        const body = await readBody(req)
        let input = {}
        try { input = JSON.parse(body || '{}') || {} } catch { /* ignore */ }
        const previousBaselineAt = num(ledger.baselineAt) || ledger.firstStartAt
        if (input.reset === true) {
          ledger.baselineAt = ledger.firstStartAt
        } else {
          const at = num(input.at)
          if (!at || at <= 0) { sendJson(res, { ok: false, error: 'at (epoch ms) or reset:true required' }, 400); return }
          ledger.baselineAt = at
        }
        persist()
        const p = buildPayload()
        sendJson(res, {
          ok: true, previousBaselineAt, baselineAt: ledger.baselineAt,
          firstStartAt: ledger.firstStartAt, groups: p.groups, totals: p.totals,
        })
      },
    },
    {
      kind: 'exact', path: BASE + '/import-history',
      handler: async (req, res) => {
        if (String(req.method || 'GET').toUpperCase() !== 'POST') {
          sendJson(res, { ok: false, error: 'POST required' }, 405); return
        }
        await readBody(req)
        const added = importWhaleHistory(ledger, false)
        if (added > 0) persist()
        sendJson(res, { ok: true, imported: added, totals: buildPayload().totals })
      },
    },
    {
      kind: 'exact', path: BASE + '/reset',
      handler: async (req, res) => {
        if (String(req.method || 'GET').toUpperCase() !== 'POST') {
          sendJson(res, { ok: false, error: 'POST required' }, 405); return
        }
        const body = await readBody(req)
        let confirm = false
        try { confirm = JSON.parse(body || '{}').confirm === true } catch { /* ignore */ }
        if (!confirm) { sendJson(res, { ok: false, error: 'confirm:true required' }, 400); return }
        // Keep the pre-install history: "reset" clears what THIS plugin booked.
        const historyEvents = ledger.events.filter((e) => e.source === 'history')
        const historySession = ledger.sessions.__history_whale__
        const next = emptyLedger(Date.now())
        next.history = ledger.history
        next.importedKeys = ledger.importedKeys
        next.events = historyEvents
        if (historySession) next.sessions.__history_whale__ = historySession
        next.seq = ledger.seq
        ledger = next
        turnAggs.clear()
        persist()
        sendJson(res, { ok: true, clearedLiveEvents: true, keptHistoryEvents: historyEvents.length })
      },
    },
  ]

  const disposers = []
  try {
    disposers.push(ctx.on('session/event', onSessionEvent))
    disposers.push(ctx.on('session/disposed', (session) => {
      try { if (session && session.id) finalizeTurn(str(session.id, 'default')) } catch { /* ignore */ }
    }))
    for (const route of routes) disposers.push(registerRoute(route))
  } catch (err) {
    try { console.warn('[dsh-token-ledger] registration failed: ' + String(err && err.message || err)) } catch { /* ignore */ }
  }
  ctx.effect(() => () => {
    for (const d of disposers) { try { if (typeof d === 'function') d() } catch { /* ignore */ } }
  })
}

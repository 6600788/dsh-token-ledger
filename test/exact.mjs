/**
 * Exactness regression test — locks in "no estimation, no abbreviation".
 *
 * Loads the real classic client.js in a VM, grabs its private formatter via
 * exports.__format, and asserts that token values are rendered verbatim with
 * thousands separators. Also statically scans the source for any compact /
 * K-M-B abbreviation helper, so a future edit cannot silently reintroduce it.
 *
 * Run: node test/exact.mjs   (from the plugin root)
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import vm from 'node:vm'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const clientPath = join(root, 'lib', 'client.js')
const hostPath = join(root, 'lib', 'index.js')
const source = readFileSync(clientPath, 'utf8')
const hostSource = readFileSync(hostPath, 'utf8')

// ---------------------------------------------------------------- load client
let captured = null
const sandbox = {
  window: { __ModuleLoader__: { load(o) { captured = o } } },
  document: { getElementById() { return null }, createElement() { return { style: {}, setAttribute() {}, appendChild() {} } }, head: { appendChild() {} }, body: { appendChild() {}, removeChild() {} } },
  URL, Date, Math, Number, String, Object, Array, JSON, console,
  setTimeout, clearTimeout, isFinite, parseInt, parseFloat
}
vm.runInNewContext(source, sandbox, { filename: clientPath })
assert.ok(captured && captured.id === 'dsh-token-ledger', 'client registered under its package id')
const requireStub = (name) => {
  if (name === 'react') return { createElement() { return {} }, useState() {}, useEffect() {}, useMemo() {}, useCallback() {} }
  throw new Error('unexpected require: ' + name)
}
const mod = captured.factory(requireStub)
const { fmt, exactSize } = mod.__format

// ------------------------------------------------------- exact value rendering
assert.equal(fmt(3998281939), '3,998,281,939', 'billions rendered in full')
assert.equal(fmt(3271991014), '3,271,991,014', 'no 3.27B abbreviation')
assert.equal(fmt(675075685), '675,075,685', 'no 675.08M abbreviation')
assert.equal(fmt(12345), '12,345', 'no 12.3K abbreviation')
assert.equal(fmt(1000), '1,000', 'thousands separator')
assert.equal(fmt(1), '1', 'small value')
assert.equal(fmt(0), '0', 'zero')
assert.equal(fmt(null), '0', 'null -> 0')
assert.equal(fmt(''), '0', 'empty -> 0')
assert.equal(fmt(undefined), '0', 'undefined -> 0')
assert.equal(fmt(NaN), '0', 'NaN -> 0')
assert.equal(fmt(-5), '0', 'negative -> 0')
assert.equal(fmt(Infinity), '0', 'Infinity -> 0')
assert.equal(fmt(1234.56789), '1,234.5679', 'fractional tokens kept to 4 decimals, not rounded away')
assert.equal(fmt(0.5), '0.5', 'sub-one token preserved')

// Big values must never be abbreviated anywhere in the UI helpers.
for (const v of [1e4, 1e6, 1e9, 1e12]) {
  const s = fmt(v)
  assert.ok(!/[KMB]$/.test(s), 'no compact suffix at ' + v + ': ' + s)
  assert.ok(s.includes(','), 'still grouped: ' + s)
  assert.ok(Number(s.replace(/,/g, '')) === v, 'round-trips to the exact original: ' + s)
}

// exactSize shrinks long numbers instead of clipping them.
assert.ok(exactSize('3,998,281,939', 23, 14) < 23, 'long number gets a smaller font')
assert.equal(exactSize('1', 23, 14), 23, 'short number keeps base font')
assert.ok(exactSize('3,998,281,939', 23, 14) >= 14, 'never below min')

// ------------------------------------------------------------ static source scan
assert.ok(!/\bcompact\s*\(/.test(source), 'no compact() helper or call left in client.js')
assert.ok(!/\/\s*1e(9|6|4)\b/.test(source), 'no division-based abbreviation left in client.js')
assert.ok(!/\.toFixed\(\d\)\s*\+\s*["']B["']/.test(source), 'no "B" suffix')
assert.ok(/\.toFixed\(2\)\s*\+\s*["']%/.test(source), 'percentages keep 2 decimals')
assert.ok(/tl-exact/.test(source), 'exact-number CSS class present')
assert.ok(/零估算/.test(source), 'UI states the zero-estimation guarantee')

// Host must not round or estimate token values either (only the ISO-week math
// legitimately uses Math.round).
const hostRounds = [...hostSource.matchAll(/Math\.round\([^\n]*\)/g)].map(m => m[0])
assert.ok(hostRounds.length <= 1, 'host does not round token values: ' + JSON.stringify(hostRounds))
if (hostRounds.length === 1) {
  assert.ok(hostRounds[0].includes('86400000'), 'the single host round is ISO-week arithmetic')
}

console.log('EXACT VALUE RENDERING PASSED — full digits, no K/M/B, no estimation')

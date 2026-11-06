/**
 * dsh-token-ledger — client half (classic script, NOT an ES module)
 * ============================================================================
 * Registered through window.__ModuleLoader__.load, the same channel the shipped
 * dsh-boot-animation / dsh-infinite-gen-5 plugins use. A top-level `return` or
 * an `import` here would be a syntax error in the desktop shell.
 *
 * Registers one left-sidebar panel row (`sidebar.panellist`) plus a full page
 * (`main`) under the SAME key — that pairing is what makes clicking the row
 * open the page. Verified against dsh-purge-community and dshmarket.
 */

window.__ModuleLoader__.load({
  id: "dsh-token-ledger",
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    var react = require("react")
    var h = react.createElement
    var useState = react.useState
    var useEffect = react.useEffect
    var useMemo = react.useMemo
    var useCallback = react.useCallback

    var BASE = "/dsh-token-ledger"
    var PANEL_ID = "dsh-token-ledger"
    var REFRESH_MS = 5000
    /**
     * url -> ETag. The host freezes each payload until the next write and
     * answers an unchanged conditional GET with a bare 304, so an idle page
     * neither re-downloads nor re-renders the (potentially 20k-row) payload.
     */
    var etagStore = {}

    // -------------------------------------------------------------- utilities
    function n(v) { var x = Number(v); return Number.isFinite(x) && x > 0 ? x : 0 }
    // Exact values only. No K/M/B abbreviation, no rounding, no estimation.
    // Token counts are reported verbatim with thousands separators; if a
    // provider ever reports a fractional token we keep up to 4 decimals.
    function fmt(v) {
      return n(v).toLocaleString("zh-CN", { maximumFractionDigits: 4 })
    }
    /** Font size that keeps a full-length exact number on one line. */
    function exactSize(text, base, min) {
      var len = String(text == null ? "" : text).length
      if (len > 17) return min
      if (len > 13) return min + 2
      if (len > 9) return base - 5
      if (len > 6) return base - 2
      return base
    }
    function money(v) {
      var x = n(v)
      return "¥" + x.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 4 })
    }
    function pad(x) { return String(x).padStart(2, "0") }
    function dayOf(ts) {
      try { var d = new Date(ts); return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) }
      catch (e) { return "—" }
    }
    function clockOf(ts) {
      try { var d = new Date(ts); return pad(d.getMonth() + 1) + "/" + pad(d.getDate()) + " " + pad(d.getHours()) + ":" + pad(d.getMinutes()) }
      catch (e) { return "—" }
    }
    function fullOf(ts) {
      try {
        var v = Number(ts)
        if (!ts || !isFinite(v) || v <= 0) return "—"
        return new Date(v).toLocaleString("zh-CN")
      } catch (e) { return "—" }
    }
    function ago(ts) {
      if (!ts) return "—"
      var diff = Date.now() - Number(ts)
      if (diff < 0) return fullOf(ts)
      if (diff < 60000) return "刚刚"
      if (diff < 3600000) return Math.floor(diff / 60000) + " 分钟前"
      if (diff < 86400000) return Math.floor(diff / 3600000) + " 小时前"
      if (diff < 604800000) return Math.floor(diff / 86400000) + " 天前"
      return clockOf(ts)
    }
    function pct(part, whole) {
      var w = n(whole)
      return w <= 0 ? 0 : Math.max(0, Math.min(100, (n(part) / w) * 100))
    }
    function shortId(id) {
      var s = String(id || "")
      if (s === "__history_whale__") return "历史汇总"
      return s.length > 10 ? s.slice(0, 8) + "…" : (s || "—")
    }
    function titleOf(s) {
      if (!s) return "（未命名会话）"
      return s.title || (s.id === "__history_whale__" ? "历史用量（安装前）" : "（未命名会话）")
    }
    function matches(query, parts) {
      var q = String(query || "").trim().toLowerCase()
      if (!q) return true
      return parts.some(function (p) { return String(p == null ? "" : p).toLowerCase().indexOf(q) >= 0 })
    }
    function startOfDay(d) { var x = new Date(d); x.setHours(0, 0, 0, 0); return x }
    function mondayOf(d) {
      var x = startOfDay(new Date(d))
      x.setDate(x.getDate() - ((x.getDay() + 6) % 7))
      return x
    }
    function isoDay(d) { return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) }
    function addDays(d, k) { var x = new Date(d); x.setDate(x.getDate() + k); return x }
    function presetRange(p) {
      var now = new Date()
      var mon = mondayOf(now)
      switch (p) {
        case "today": return [isoDay(now), isoDay(now), "今天"]
        case "week": return [isoDay(mon), isoDay(addDays(mon, 6)), "本周"]
        case "lastweek": return [isoDay(addDays(mon, -7)), isoDay(addDays(mon, -1)), "上周"]
        case "month": return [isoDay(new Date(now.getFullYear(), now.getMonth(), 1)),
          isoDay(new Date(now.getFullYear(), now.getMonth() + 1, 0)), "本月"]
        case "lastmonth": return [isoDay(new Date(now.getFullYear(), now.getMonth() - 1, 1)),
          isoDay(new Date(now.getFullYear(), now.getMonth(), 0)), "上月"]
        case "7d": return [isoDay(addDays(now, -6)), isoDay(now), "近 7 天"]
        case "30d": return [isoDay(addDays(now, -29)), isoDay(now), "近 30 天"]
        default: return ["", "", ""]
      }
    }

    // ------------------------------------------------------------------ styles
    var CSS = `
.tl-root{box-sizing:border-box;width:100%;height:100%;overflow:auto;padding:28px 30px 48px;
  color:var(--dsw-alias-label-primary,#1f2328);
  font-family:var(--ds-font-family-sans,system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif);
  font-size:13px;line-height:1.6;-webkit-font-smoothing:antialiased}
.tl-root *{box-sizing:border-box}
.tl-root .tl-mono{font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Consolas,monospace);font-variant-numeric:tabular-nums}
.tl-head{display:flex;align-items:flex-start;justify-content:space-between;gap:18px;flex-wrap:wrap;margin-bottom:22px}
.tl-title{display:flex;align-items:center;gap:12px}
.tl-badge{width:38px;height:38px;border-radius:11px;display:flex;align-items:center;justify-content:center;
  background:linear-gradient(140deg,#6366f1,#8b5cf6 55%,#06b6d4);color:#fff;flex:none;
  box-shadow:0 6px 18px rgba(99,102,241,.28)}
.tl-h1{margin:0;font-size:20px;font-weight:650;letter-spacing:.2px}
.tl-sub{margin:2px 0 0;font-size:12px;color:var(--dsw-alias-label-secondary,#6b7280)}
.tl-status{display:inline-flex;align-items:center;gap:6px;margin-top:6px;font-size:11.5px;
  color:var(--dsw-alias-label-tertiary,#8b93a1)}
.tl-dot{width:7px;height:7px;border-radius:50%;background:#22c55e;flex:none;
  box-shadow:0 0 0 3px rgba(34,197,94,.15)}
.tl-dot.bad{background:#ef4444;box-shadow:0 0 0 3px rgba(239,68,68,.15)}
.tl-dot.wait{background:#f59e0b;box-shadow:0 0 0 3px rgba(245,158,11,.15)}
.tl-actions{display:flex;align-items:center;gap:7px;flex-wrap:wrap}
.tl-btn{appearance:none;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.24));
  background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.06));
  color:var(--dsw-alias-label-primary,#1f2328);border-radius:8px;padding:6px 11px;
  font-size:12px;cursor:pointer;transition:.15s;white-space:nowrap;font-family:inherit}
.tl-btn:hover{border-color:#8b5cf6;color:#8b5cf6;background:rgba(139,92,246,.08)}
.tl-btn:active{transform:translateY(1px)}
.tl-btn:disabled{opacity:.5;cursor:default;transform:none}
.tl-btn.primary{background:linear-gradient(135deg,#6366f1,#8b5cf6);border-color:transparent;color:#fff}
.tl-btn.primary:hover{color:#fff;filter:brightness(1.08)}
.tl-btn.danger:hover{border-color:#ef4444;color:#ef4444;background:rgba(239,68,68,.08)}
.tl-kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(158px,1fr));gap:11px;margin-bottom:16px}
.tl-kpi{position:relative;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.2));
  background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.05));border-radius:12px;padding:14px 15px 13px;overflow:hidden}
.tl-kpi::before{content:"";position:absolute;left:0;top:0;bottom:0;width:3px;background:var(--accent,#6366f1);opacity:.85}
.tl-kpi-label{font-size:11.5px;color:var(--dsw-alias-label-secondary,#6b7280);margin-bottom:7px;
  display:flex;align-items:center;justify-content:space-between;gap:6px}
.tl-kpi-label em{font-style:normal;font-size:10px;opacity:.7}
.tl-kpi-value{font-size:23px;font-weight:660;letter-spacing:-.4px;line-height:1.15;
  font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Consolas,monospace);font-variant-numeric:tabular-nums}
/* Exact numbers: never clipped, never abbreviated. Long digit runs may wrap. */
.tl-exact{white-space:normal;overflow-wrap:anywhere;line-height:1.24;letter-spacing:-.6px}
.tl-exact .tl-kpi-unit{letter-spacing:0;font-size:10.5px}
.tl-kpi-unit{font-size:11px;font-weight:400;opacity:.6;margin-left:4px}
.tl-kpi-foot{font-size:10.5px;color:var(--dsw-alias-label-tertiary,#8b93a1);margin-top:6px}
.tl-panel{border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.2));
  background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.05));border-radius:12px;padding:16px 18px;margin-bottom:16px}
.tl-panel-title{font-size:13px;font-weight:620;margin:0 0 3px}
.tl-panel-desc{font-size:11.5px;color:var(--dsw-alias-label-secondary,#6b7280);margin:0 0 14px}
.tl-stack{display:flex;height:11px;border-radius:6px;overflow:hidden;background:rgba(127,127,127,.14);margin-bottom:12px}
.tl-stack i{display:block;height:100%;min-width:0;transition:width .4s}
.tl-legend{display:flex;gap:16px;flex-wrap:wrap;font-size:11.5px;color:var(--dsw-alias-label-secondary,#6b7280)}
.tl-legend span{display:inline-flex;align-items:center;gap:6px}
.tl-legend b{display:inline-block;width:9px;height:9px;border-radius:3px}
.tl-legend strong{color:var(--dsw-alias-label-primary,#1f2328);font-weight:600}
.tl-chart{display:flex;align-items:flex-end;gap:3px;height:118px;padding-top:6px;
  border-bottom:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.2))}
.tl-col{flex:1;min-width:3px;display:flex;flex-direction:column;justify-content:flex-end;align-items:center;height:100%;position:relative;cursor:default}
.tl-col-bar{width:100%;max-width:26px;border-radius:4px 4px 0 0;min-height:2px;
  background:linear-gradient(180deg,#8b5cf6,#6366f1);opacity:.85;transition:height .4s,opacity .2s}
.tl-col:hover .tl-col-bar{opacity:1;background:linear-gradient(180deg,#06b6d4,#8b5cf6)}
.tl-col.today .tl-col-bar{background:linear-gradient(180deg,#06b6d4,#22c55e);opacity:1}
.tl-chart-labels{display:flex;justify-content:space-between;font-size:10.5px;
  color:var(--dsw-alias-label-tertiary,#8b93a1);margin-top:8px}
.tl-toolbar{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:14px}
.tl-tabs{display:flex;gap:4px;padding:3px;border-radius:9px;
  background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.09));border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.16))}
.tl-tab{appearance:none;border:0;background:transparent;color:var(--dsw-alias-label-secondary,#6b7280);
  border-radius:7px;padding:6px 14px;font-size:12px;cursor:pointer;font-family:inherit;transition:.15s;white-space:nowrap}
.tl-tab:hover{color:var(--dsw-alias-label-primary,#1f2328)}
.tl-tab.on{background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#1f2328);
  font-weight:600;box-shadow:0 1px 4px rgba(0,0,0,.1)}
.tl-search{appearance:none;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.24));
  background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.06));
  color:var(--dsw-alias-label-primary,#1f2328);border-radius:8px;padding:6px 11px;font-size:12px;
  min-width:190px;outline:none;font-family:inherit}
.tl-search:focus{border-color:#8b5cf6}
.tl-table{width:100%;border-collapse:collapse;font-size:12px}
.tl-table th{text-align:right;font-weight:500;font-size:11px;color:var(--dsw-alias-label-secondary,#6b7280);
  padding:9px 10px;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.2));white-space:nowrap}
.tl-table th:first-child,.tl-table td:first-child{text-align:left}
.tl-table th.left,.tl-table td.left{text-align:left}
.tl-table td{padding:10px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.11));
  text-align:right;white-space:nowrap;vertical-align:middle}
.tl-table tbody tr.clickable{cursor:pointer;transition:background .12s}
.tl-table tbody tr.clickable:hover{background:rgba(139,92,246,.07)}
.tl-table tbody tr.expanded{background:rgba(139,92,246,.06)}
.tl-table tbody tr:last-child td{border-bottom:0}
.tl-name{display:flex;align-items:center;gap:8px;max-width:340px}
.tl-name span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tl-tag{font-size:10px;padding:1px 6px;border-radius:5px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.25));
  color:var(--dsw-alias-label-secondary,#6b7280);white-space:nowrap;flex:none}
.tl-tag.hist{color:#d97706;border-color:rgba(217,119,6,.4);background:rgba(217,119,6,.08)}
.tl-tag.live{color:#16a34a;border-color:rgba(22,163,74,.35);background:rgba(22,163,74,.07)}
.tl-strong{font-weight:640;font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Consolas,monospace);font-variant-numeric:tabular-nums}
.tl-dim{color:var(--dsw-alias-label-secondary,#6b7280);font-size:11px}
.tl-bar{height:5px;border-radius:3px;background:rgba(127,127,127,.16);overflow:hidden;min-width:56px;margin-top:5px}
.tl-bar i{display:block;height:100%;border-radius:3px;background:linear-gradient(90deg,#6366f1,#8b5cf6)}
.tl-detail{padding:14px 18px 18px 30px;background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.07));
  border-bottom:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.2))}
.tl-detail h4{margin:0 0 9px;font-size:11.5px;font-weight:600;color:var(--dsw-alias-label-secondary,#6b7280)}
.tl-detail .tl-table{margin-bottom:14px}
.tl-detail .tl-table td,.tl-detail .tl-table th{padding:6px 8px;font-size:11.5px}
.tl-empty{text-align:center;padding:48px 20px;color:var(--dsw-alias-label-secondary,#6b7280)}
.tl-empty .big{font-size:34px;margin-bottom:10px;opacity:.5}
.tl-empty p{margin:4px 0;font-size:12.5px}
.tl-error{border:1px solid rgba(239,68,68,.35);background:rgba(239,68,68,.07);color:#dc2626;
  border-radius:10px;padding:12px 15px;font-size:12px;margin-bottom:16px;word-break:break-all}
.tl-foot{margin-top:22px;padding-top:14px;border-top:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.14));
  font-size:11px;color:var(--dsw-alias-label-tertiary,#8b93a1);display:flex;gap:18px;flex-wrap:wrap}
.tl-foot code{font-family:var(--ds-font-family-code,ui-monospace,Consolas,monospace);word-break:break-all}
.tl-note{font-size:12px;color:var(--dsw-alias-label-secondary,#6b7280);line-height:1.85}
.tl-note b{color:var(--dsw-alias-label-primary,#1f2328);font-weight:600}
.tl-note ul{margin:6px 0 14px;padding-left:20px}
.tl-note li{margin:4px 0}
.tl-code{display:inline-block;padding:1px 6px;border-radius:5px;
  background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.1));
  font-family:var(--ds-font-family-code,ui-monospace,Consolas,monospace);font-size:11px}
.tl-divider{height:1px;background:var(--dsw-alias-border-l1,rgba(127,127,127,.14));margin:16px 0}
@media (max-width:720px){.tl-root{padding:18px 14px 36px}.tl-kpi-value{font-size:19px}
  .tl-table{font-size:11px}.tl-table td,.tl-table th{padding:7px 6px}.tl-books{grid-template-columns:1fr}}
.tl-books{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;margin-bottom:16px}
.tl-book{position:relative;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.2));
  background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.05));border-radius:12px;padding:15px 17px;
  cursor:pointer;transition:.16s;overflow:hidden}
.tl-book::before{content:"";position:absolute;left:0;top:0;bottom:0;width:3px;background:var(--book,#d97706);opacity:.9}
.tl-book:hover{border-color:var(--book,#d97706)}
.tl-book.on{border-color:var(--book,#d97706);background:rgba(139,92,246,.07);box-shadow:0 0 0 1px var(--book,#d97706) inset}
.tl-book-label{font-size:12.5px;font-weight:620;display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px}
.tl-book-value{font-size:27px;font-weight:670;letter-spacing:-.5px;line-height:1.15;
  font-family:var(--ds-font-family-code,ui-monospace,Consolas,monospace);font-variant-numeric:tabular-nums}
.tl-book-meta{font-size:11px;color:var(--dsw-alias-label-secondary,#6b7280);margin-top:5px}
.tl-book-range{font-size:10.5px;color:var(--dsw-alias-label-tertiary,#8b93a1);margin-top:3px}
.tl-book-buckets{display:flex;gap:10px;flex-wrap:wrap;margin-top:11px;font-size:10.5px;
  color:var(--dsw-alias-label-secondary,#6b7280)}
.tl-book-buckets span{display:inline-flex;align-items:center;gap:5px}
.tl-book-buckets b{width:8px;height:8px;border-radius:2px;display:inline-block}
.tl-book-models{font-size:10.5px;color:var(--dsw-alias-label-tertiary,#8b93a1);margin-top:9px;
  white-space:normal;overflow:visible;overflow-wrap:anywhere;line-height:1.65}
.tl-filter{padding:15px 17px !important;margin-bottom:14px !important}
.tl-filter-head{display:flex;align-items:baseline;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:11px}
.tl-filter-summary{font-size:11.5px;color:var(--dsw-alias-label-secondary,#6b7280)}
.tl-filter-summary strong{color:var(--dsw-alias-label-primary,#1f2328);font-weight:620}
.tl-filter-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:9px}
.tl-filter-row:last-child{margin-bottom:0}
.tl-chips{display:flex;gap:5px;flex-wrap:wrap;flex:1}
.tl-chip{appearance:none;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.24));
  background:transparent;color:var(--dsw-alias-label-secondary,#6b7280);border-radius:20px;
  padding:4px 11px;font-size:11.5px;cursor:pointer;font-family:inherit;transition:.15s;white-space:nowrap}
.tl-chip:hover{color:#8b5cf6;border-color:#8b5cf6}
.tl-chip.on{background:linear-gradient(135deg,#6366f1,#8b5cf6);border-color:transparent;color:#fff;font-weight:600}
.tl-field{display:inline-flex;align-items:center;gap:6px;font-size:11.5px;
  color:var(--dsw-alias-label-secondary,#6b7280);white-space:nowrap}
.tl-date,.tl-select{appearance:none;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.24));
  background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.06));
  color:var(--dsw-alias-label-primary,#1f2328);border-radius:7px;padding:5px 8px;
  font-size:11.5px;outline:none;font-family:inherit;min-width:118px}
.tl-date:focus,.tl-select:focus{border-color:#8b5cf6}
.tl-filter-note{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:11px;
  color:var(--dsw-alias-label-tertiary,#8b93a1);padding-top:9px;
  border-top:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.14))}
.tl-seg{display:inline-flex;gap:2px;padding:2px;border-radius:7px;
  background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.09));border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.16))}
.tl-seg button{appearance:none;border:0;background:transparent;color:var(--dsw-alias-label-secondary,#6b7280);
  border-radius:5px;padding:3px 10px;font-size:11px;cursor:pointer;font-family:inherit}
.tl-seg button.on{background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#1f2328);font-weight:600}
.tl-total-row td{border-top:2px solid var(--dsw-alias-border-l2,rgba(127,127,127,.3)) !important;
  border-bottom:0 !important;font-weight:620;background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.05))}
.tl-subtle{font-size:10.5px;color:var(--dsw-alias-label-tertiary,#8b93a1);font-weight:400}
`
    var styled = false
    function injectStyles() {
      if (styled) return
      try {
        if (document.getElementById("dsh-token-ledger-css")) { styled = true; return }
        var s = document.createElement("style")
        s.id = "dsh-token-ledger-css"
        s.textContent = CSS
        document.head.appendChild(s)
        styled = true
      } catch (e) { /* styles are best-effort */ }
    }

    // ------------------------------------------------------------- primitives
    var ACCENTS = ["#6366f1", "#06b6d4", "#22c55e", "#f59e0b", "#8b5cf6", "#ef4444", "#14b8a6", "#ec4899"]

    function Kpi(props) {
      var shown = props.text != null ? props.text : fmt(props.value)
      return h("div", { className: "tl-kpi", style: { "--accent": props.color || "#6366f1" } },
        h("div", { className: "tl-kpi-label" }, props.label, props.hint ? h("em", null, props.hint) : null),
        h("div", { className: "tl-kpi-value tl-exact", title: shown,
          style: { fontSize: exactSize(shown, 23, 14) + "px" } },
          shown,
          props.unit ? h("span", { className: "tl-kpi-unit" }, props.unit) : null),
        props.foot ? h("div", { className: "tl-kpi-foot" }, props.foot) : null)
    }

    function Bar(props) {
      return h("div", { className: "tl-bar", title: fmt(props.value) },
        h("i", { style: { width: pct(props.value, props.max) + "%" } }))
    }

    function Glyph(props) {
      var size = props.size || 16
      return h("svg", {
        width: size, height: size, viewBox: "0 0 24 24", fill: "currentColor",
        "aria-hidden": "true", style: { display: "block", flex: "none" }
      },
        h("rect", { x: "3", y: "12", width: "4.2", height: "8", rx: "1.1", opacity: ".55" }),
        h("rect", { x: "9.9", y: "7.5", width: "4.2", height: "12.5", rx: "1.1", opacity: ".78" }),
        h("rect", { x: "16.8", y: "3", width: "4.2", height: "17", rx: "1.1" }),
        h("path", { d: "M2 21.4h20v1.4H2z", opacity: ".85" }))
    }

    function TableHead(cols) {
      return h("thead", null, h("tr", null, cols.map(function (c, i) {
        return h("th", { key: i, className: c.left ? "left" : "" }, c.label)
      })))
    }

    // --------------------------------------------------- client-side fallback
    // The 1.0 host has no /query.json. Pull its raw /export.json and run the
    // SAME aggregation here so a page refresh gets every new feature without
    // waiting for a full DSH restart. Once the host is restarted, /query.json
    // answers and this block is never used again.
    // Byte-for-byte the same calendar math as host weekInfo/monthInfo, so the
    // fallback and the restarted host produce identical week/month keys.
    function cWeek(ts) {
      try {
        var d = new Date(ts)
        var pp = function (x) { return String(x).padStart(2, "0") }
        var dow = (d.getDay() + 6) % 7
        var start = new Date(d.getFullYear(), d.getMonth(), d.getDate() - dow)
        start.setHours(0, 0, 0, 0)
        var endExclusive = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 7)
        endExclusive.setHours(0, 0, 0, 0)
        var sun = new Date(endExclusive.getTime() - 86400000)
        var thu = new Date(Date.UTC(start.getFullYear(), start.getMonth(), start.getDate() + 3))
        var firstThu = new Date(Date.UTC(thu.getUTCFullYear(), 0, 4))
        firstThu.setUTCDate(firstThu.getUTCDate() - ((firstThu.getUTCDay() + 6) % 7) + 3)
        var week = 1 + Math.round((thu - firstThu) / (7 * 86400000))
        return { key: thu.getUTCFullYear() + "-W" + pp(week),
          label: pp(start.getMonth() + 1) + "/" + pp(start.getDate()) + "–" +
            pp(sun.getMonth() + 1) + "/" + pp(sun.getDate()),
          startTs: start.getTime(), endTs: endExclusive.getTime() - 1 }
      } catch (e) { return { key: "1970-W01", label: "—", startTs: 0, endTs: 0 } }
    }
    function cMonth(ts) {
      try {
        var d = new Date(ts), y = d.getFullYear(), m = d.getMonth()
        var start = new Date(y, m, 1); start.setHours(0, 0, 0, 0)
        var end = new Date(y, m + 1, 1); end.setHours(0, 0, 0, 0)
        return { key: y + "-" + pad(m + 1), label: y + " 年 " + (m + 1) + " 月",
          startTs: start.getTime(), endTs: end.getTime() - 1 }
      } catch (e) { return { key: "1970-01", label: "—", startTs: 0, endTs: 0 } }
    }
    function cAgg() {
      return { events: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0,
        total: 0, cost: 0, costEvents: 0, liveEvents: 0, historyEvents: 0,
        turns: {}, sessions: {}, models: {} }
    }
    function cAcc(a, e) {
      a.events += 1
      a.input += n(e.input); a.cacheRead += n(e.cacheRead)
      a.cacheWrite += n(e.cacheWrite); a.output += n(e.output)
      a.reasoning += n(e.reasoning); a.total += n(e.total)
      if (e.cost != null) { a.cost += n(e.cost); a.costEvents += 1 }
      if (e.source === "history") a.historyEvents += 1; else a.liveEvents += 1
      if (e.turn != null) a.turns[e.sessionId + "|" + e.turn] = 1
      var s = a.sessions[e.sessionId]
      if (!s) s = a.sessions[e.sessionId] = {
        id: e.sessionId, title: e.sessionTitle || "", firstTs: e.ts, lastTs: e.ts,
        turns: {}, events: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0,
        reasoning: 0, total: 0, cost: 0, models: {}
      }
      if (e.ts < s.firstTs) s.firstTs = e.ts
      if (e.ts > s.lastTs) s.lastTs = e.ts
      if (!s.title && e.sessionTitle) s.title = e.sessionTitle
      if (e.turn != null) s.turns[e.turn] = 1
      s.events += 1; s.input += n(e.input); s.cacheRead += n(e.cacheRead)
      s.cacheWrite += n(e.cacheWrite); s.output += n(e.output)
      s.reasoning += n(e.reasoning); s.total += n(e.total)
      if (e.cost != null) s.cost += n(e.cost)
      var sm = s.models[e.model]
      if (!sm) sm = s.models[e.model] = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, total: 0, events: 0 }
      sm.input += n(e.input); sm.cacheRead += n(e.cacheRead); sm.cacheWrite += n(e.cacheWrite)
      sm.output += n(e.output); sm.total += n(e.total); sm.events += 1
      var m = a.models[e.model]
      if (!m) m = a.models[e.model] = { model: e.model, events: 0, input: 0, cacheRead: 0,
        cacheWrite: 0, output: 0, reasoning: 0, total: 0, sessions: {} }
      m.events += 1; m.input += n(e.input); m.cacheRead += n(e.cacheRead)
      m.cacheWrite += n(e.cacheWrite); m.output += n(e.output)
      m.reasoning += n(e.reasoning); m.total += n(e.total)
      m.sessions[e.sessionId] = 1
    }
    function cPlain(a, extra) {
      var o = { events: a.events, input: a.input, cacheRead: a.cacheRead, cacheWrite: a.cacheWrite,
        output: a.output, reasoning: a.reasoning, total: a.total, cost: a.cost,
        costEvents: a.costEvents, liveEvents: a.liveEvents, historyEvents: a.historyEvents,
        turns: Object.keys(a.turns).length }
      if (extra) for (var k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) o[k] = extra[k]
      return o
    }
    function cRows(a, ledger) {
      var sessions = Object.keys(a.sessions).map(function (id) {
        var s = a.sessions[id]
        var stored = ledger && ledger.sessions && ledger.sessions[id]
        return { id: id, title: (stored && stored.title) || s.title ||
            (id === "__history_whale__" ? "历史用量（安装前 · whale 账本）" : "（未命名会话）"),
          firstTs: s.firstTs, lastTs: s.lastTs, turns: Object.keys(s.turns).length,
          events: s.events, input: s.input, cacheRead: s.cacheRead, cacheWrite: s.cacheWrite,
          output: s.output, reasoning: s.reasoning, total: s.total, cost: s.cost,
          models: s.models, modelCount: Object.keys(s.models).length }
      }).sort(function (x, y) { return y.lastTs - x.lastTs })
      var models = Object.keys(a.models).map(function (k) {
        var m = a.models[k]
        return { model: m.model, events: m.events, input: m.input, cacheRead: m.cacheRead,
          cacheWrite: m.cacheWrite, output: m.output, reasoning: m.reasoning,
          total: m.total, sessionCount: Object.keys(m.sessions).length }
      }).sort(function (x, y) { return y.total - x.total })
      return { sessions: sessions, models: models }
    }
    function cDate(s, endOfDay) {
      if (!s) return null
      if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
        var p = s.split("-").map(Number)
        var t = new Date(p[0], p[1] - 1, p[2], 0, 0, 0, 0).getTime()
        return endOfDay ? t + 86400000 - 1 : t
      }
      var v = Number(s)
      return isFinite(v) && v > 0 ? v : null
    }
    function fallbackPayload(ledger, u) {
      var q = new URL(u, "http://localhost").searchParams
      var group = q.get("group") || "all"
      if (group !== "before" && group !== "after") group = "all"
      var from = cDate(q.get("from"), false), to = cDate(q.get("to"), true)
      var baselineAt = n(ledger.baselineAt) || n(ledger.firstStartAt)
      var all = Array.isArray(ledger.events) ? ledger.events : []
      var selected = [], firstAll = Infinity, lastAll = 0
      var bfFrom = Infinity, bfTo = 0, afFrom = Infinity, afTo = 0
      for (var i = 0; i < all.length; i++) {
        var e = all[i]
        if (e.ts < firstAll) firstAll = e.ts
        if (e.ts > lastAll) lastAll = e.ts
        if (from != null && e.ts < from) continue
        if (to != null && e.ts > to) continue
        if (group === "before" && e.ts >= baselineAt) continue
        if (group === "after" && e.ts < baselineAt) continue
        selected.push(e)
        if (e.ts < baselineAt) { if (e.ts < bfFrom) bfFrom = e.ts; if (e.ts > bfTo) bfTo = e.ts }
        else { if (e.ts < afFrom) afFrom = e.ts; if (e.ts > afTo) afTo = e.ts }
      }
      var root = cAgg(), before = cAgg(), after = cAgg()
      var byDay = {}, byWeek = {}, byMonth = {}, fw = {}, fm = {}, fd = {}
      for (var j = 0; j < all.length; j++) {
        var a = all[j], wi = cWeek(a.ts), mi = cMonth(a.ts)
        if (!fw[wi.key]) fw[wi.key] = { key: wi.key, label: wi.label, startTs: wi.startTs, endTs: wi.endTs, total: 0, events: 0 }
        fw[wi.key].total += n(a.total); fw[wi.key].events += 1
        if (!fm[mi.key]) fm[mi.key] = { key: mi.key, label: mi.label, startTs: mi.startTs, endTs: mi.endTs, total: 0, events: 0 }
        fm[mi.key].total += n(a.total); fm[mi.key].events += 1
        fd[a.day || dayOf(a.ts)] = 1
      }
      for (var k = 0; k < selected.length; k++) {
        var e2 = selected[k]
        cAcc(root, e2)
        cAcc(e2.ts < baselineAt ? before : after, e2)
        var dk = e2.day || dayOf(e2.ts)
        if (!byDay[dk]) byDay[dk] = Object.assign({ day: dk }, cAgg())
        cAcc(byDay[dk], e2)
        var w = cWeek(e2.ts), mo = cMonth(e2.ts)
        if (!byWeek[w.key]) byWeek[w.key] = Object.assign({}, w, cAgg())
        cAcc(byWeek[w.key], e2)
        if (!byMonth[mo.key]) byMonth[mo.key] = Object.assign({}, mo, cAgg())
        cAcc(byMonth[mo.key], e2)
      }
      function period(map) {
        return Object.keys(map).map(function (key) {
          var b = map[key]
          return cPlain(b, { key: key, label: b.label, startTs: b.startTs, endTs: b.endTs,
            sessionCount: Object.keys(b.sessions).length, modelCount: Object.keys(b.models).length })
        }).sort(function (x, y) { return String(x.key).localeCompare(String(y.key)) })
      }
      var days = Object.keys(byDay).map(function (key) {
        var b = byDay[key], ms = {}
        for (var mk in b.models) if (Object.prototype.hasOwnProperty.call(b.models, mk)) ms[mk] = b.models[mk].total
        return cPlain(b, { day: key, sessionCount: Object.keys(b.sessions).length, models: ms })
      }).sort(function (x, y) { return x.day.localeCompare(y.day) })
      var weeks = period(byWeek), months = period(byMonth)
      var rows = cRows(root, ledger)
      function book(agg, label, f, t) {
        return cPlain(agg, { label: label, fromTs: isFinite(f) ? f : null, toTs: t || null,
          sessions: Object.keys(agg.sessions).length, modelCount: Object.keys(agg.models).length,
          topModels: Object.keys(agg.models).map(function (key) { return { model: agg.models[key].model, total: agg.models[key].total } })
            .sort(function (x, y) { return y.total - x.total }).slice(0, 5) })
      }
      var facets = {
        weeks: Object.keys(fw).map(function (key) { return fw[key] })
          .sort(function (x, y) { return y.key.localeCompare(x.key) }),
        months: Object.keys(fm).map(function (key) { return fm[key] })
          .sort(function (x, y) { return y.key.localeCompare(x.key) }),
        firstDay: Object.keys(fd).sort()[0] || null,
        lastDay: Object.keys(fd).sort().pop() || null
      }
      return {
        ok: true, plugin: "dsh-token-ledger", version: ledger.pluginVersion || "1.2.0",
        generatedAt: new Date().toISOString(), ledgerPath: "~/.dsh/token-ledger/ledger.json",
        firstStartAt: ledger.firstStartAt, baselineAt: baselineAt,
        firstEventTs: isFinite(firstAll) ? firstAll : null, lastEventTs: lastAll || null,
        filter: { group: group, fromTs: from, toTs: to, label: q.get("label") || "",
          events: selected.length, totalEvents: all.length },
        totals: cPlain(root, { sessions: rows.sessions.length }),
        groups: { before: book(before, "之前（历史账）", bfFrom, bfTo),
          after: book(after, "现在（新账）", afFrom, afTo) },
        history: ledger.history || null, today: days.length ? days[days.length - 1] : null,
        days: days.slice(-120), weeks: weeks, months: months,
        models: rows.models, sessions: rows.sessions,
        recentEvents: selected.slice(-300).reverse().map(function (x) { return Object.assign({}, x) }),
        recentEventsTotal: selected.length, facets: facets, pendingTurns: 0,
        fallback: true
      }
    }

    // ------------------------------------------------------------------ views
    function SessionsView(props) {
      var data = props.data
      var rows = (data.sessions || []).filter(function (s) {
        return matches(props.query, [titleOf(s), s.id, Object.keys(s.models || {}).join(" ")])
      })
      if (!rows.length) return h("div", { className: "tl-empty" },
        h("div", { className: "big" }, "◔"),
        h("p", null, props.query ? "没有匹配的会话" : "这个范围内还没有记录到任何会话"),
        h("p", { className: "tl-dim" }, "换个筛选条件，或开启一轮新对话后再看"))
      var max = Math.max.apply(null, rows.map(function (s) { return n(s.total) }).concat([1]))
      return h("table", { className: "tl-table" },
        TableHead([
          { label: "会话", left: true }, { label: "轮次" }, { label: "事件" },
          { label: "总 Token" }, { label: "输入" }, { label: "缓存读" },
          { label: "缓存写" }, { label: "输出" }, { label: "最后活动" }, { label: "占比" }
        ]),
        h("tbody", null, rows.map(function (s) {
          var open = props.expanded === s.id
          var hist = s.id === "__history_whale__"
          return h(react.Fragment, { key: s.id },
            h("tr", {
              className: "clickable" + (open ? " expanded" : ""),
              onClick: function () { props.onExpand(open ? null : s.id) }
            },
              h("td", { className: "left" },
                h("div", { className: "tl-name" },
                  h("span", { style: { fontWeight: 560 }, title: titleOf(s) }, titleOf(s)),
                  h("span", { className: "tl-tag " + (hist ? "hist" : "live") }, hist ? "历史" : "实时")),
                h("div", { className: "tl-dim tl-mono", style: { marginTop: 2 } }, shortId(s.id))),
              h("td", { className: "tl-mono" }, fmt(s.turns)),
              h("td", { className: "tl-mono" }, fmt(s.events)),
              h("td", null,
                h("div", { className: "tl-strong" }, fmt(s.total)),
                h(Bar, { value: s.total, max: max })),
              h("td", { className: "tl-mono tl-dim" }, fmt(s.input)),
              h("td", { className: "tl-mono tl-dim" }, fmt(s.cacheRead)),
              h("td", { className: "tl-mono tl-dim" }, fmt(s.cacheWrite)),
              h("td", { className: "tl-mono tl-dim" }, fmt(s.output)),
              h("td", { className: "tl-dim" }, ago(s.lastTs)),
              h("td", { className: "tl-dim tl-mono" }, pct(s.total, data.totals.total).toFixed(2) + "%")),
            open ? h("tr", { key: s.id + "-d" },
              h("td", { colSpan: 10, style: { padding: 0, textAlign: "left" } },
                h(SessionDetail, { session: s, events: data.recentEvents || [] }))) : null)
        })))
    }

    function SessionDetail(props) {
      var s = props.session
      var models = Object.entries(s.models || {}).map(function (e) {
        return { model: e[0], data: e[1] }
      }).sort(function (a, b) { return n(b.data.total) - n(a.data.total) })
      var evts = props.events.filter(function (e) { return e.sessionId === s.id }).slice(0, 20)
      return h("div", { className: "tl-detail" },
        h("h4", null, "模型拆分 · ", models.length, " 个模型"),
        models.length ? h("table", { className: "tl-table" },
          TableHead([{ label: "模型", left: true }, { label: "事件" }, { label: "输入" },
            { label: "缓存读" }, { label: "缓存写" }, { label: "输出" }, { label: "合计" }]),
          h("tbody", null, models.map(function (m, i) {
            var d = m.data || {}
            return h("tr", { key: i },
              h("td", { className: "left" }, m.model),
              h("td", { className: "tl-mono tl-dim" }, fmt(d.events)),
              h("td", { className: "tl-mono tl-dim" }, fmt(d.input)),
              h("td", { className: "tl-mono tl-dim" }, fmt(d.cacheRead)),
              h("td", { className: "tl-mono tl-dim" }, fmt(d.cacheWrite)),
              h("td", { className: "tl-mono tl-dim" }, fmt(d.output)),
              h("td", { className: "tl-strong" }, fmt(d.total)))
          }))) : h("div", { className: "tl-dim" }, "无模型明细"),
        h("h4", { style: { marginTop: 16 } }, "最近记录（最多 20 条）"),
        evts.length ? h("table", { className: "tl-table" },
          TableHead([{ label: "时间", left: true }, { label: "轮次" }, { label: "模型", left: true },
            { label: "输入" }, { label: "缓存读" }, { label: "缓存写" }, { label: "输出" }, { label: "合计" }]),
          h("tbody", null, evts.map(function (e, i) {
            return h("tr", { key: i },
              h("td", { className: "left tl-dim" }, fullOf(e.ts)),
              h("td", { className: "tl-mono tl-dim" }, e.turn == null ? "—" : "#" + e.turn),
              h("td", { className: "left tl-dim" }, e.model),
              h("td", { className: "tl-mono tl-dim" }, fmt(e.input)),
              h("td", { className: "tl-mono tl-dim" }, fmt(e.cacheRead)),
              h("td", { className: "tl-mono tl-dim" }, fmt(e.cacheWrite)),
              h("td", { className: "tl-mono tl-dim" }, fmt(e.output)),
              h("td", { className: "tl-strong" }, fmt(e.total)))
          }))) : h("div", { className: "tl-dim" }, "明细里没有这个会话的记录"))
    }

    function ModelsView(props) {
      var data = props.data
      var rows = (data.models || []).filter(function (m) {
        return matches(props.query, [m.model])
      })
      if (!rows.length) return h("div", { className: "tl-empty" },
        h("div", { className: "big" }, "◔"), h("p", null, props.query ? "没有匹配的模型" : "这个范围内没有模型用量"))
      var max = Math.max.apply(null, rows.map(function (m) { return n(m.total) }).concat([1]))
      return h("table", { className: "tl-table" },
        TableHead([{ label: "模型", left: true }, { label: "事件" }, { label: "会话数" },
          { label: "输入" }, { label: "缓存读" }, { label: "缓存写" }, { label: "输出" },
          { label: "推理" }, { label: "总 Token" }, { label: "占比" }]),
        h("tbody", null, rows.map(function (m, i) {
          return h("tr", { key: m.model + i },
            h("td", { className: "left" },
              h("div", { className: "tl-name" },
                h("span", { style: { fontWeight: 560 } }, m.model)),
              h("div", { className: "tl-dim" }, "色标 ", h("span", {
                style: { display: "inline-block", width: 8, height: 8, borderRadius: 2,
                  background: ACCENTS[i % ACCENTS.length], marginRight: 4 }
              }), " · ", fmt(m.events), " 次调用")),
            h("td", { className: "tl-mono" }, fmt(m.events)),
            h("td", { className: "tl-mono tl-dim" }, fmt(m.sessionCount)),
            h("td", { className: "tl-mono tl-dim" }, fmt(m.input)),
            h("td", { className: "tl-mono tl-dim" }, fmt(m.cacheRead)),
            h("td", { className: "tl-mono tl-dim" }, fmt(m.cacheWrite)),
            h("td", { className: "tl-mono tl-dim" }, fmt(m.output)),
            h("td", { className: "tl-mono tl-dim" }, fmt(m.reasoning)),
            h("td", null,
              h("div", { className: "tl-strong" }, fmt(m.total)),
              h(Bar, { value: m.total, max: max })),
            h("td", { className: "tl-dim tl-mono" }, pct(m.total, data.totals.total).toFixed(2) + "%"))
        })))
    }

    /** Weekly / monthly / daily rollups — each row carries all four buckets. */
    function PeriodsView(props) {
      var data = props.data
      var mode = props.mode || "week"
      var src = mode === "week" ? (data.weeks || []) : mode === "month" ? (data.months || []) : (data.days || [])
      var rows = src.slice().reverse().filter(function (r) {
        return matches(props.query, [r.key, r.label, r.day])
      })
      if (!rows.length) return h("div", { className: "tl-empty" },
        h("div", { className: "big" }, "◔"),
        h("p", null, props.query ? "没有匹配的时间段" : "这个范围内没有记录"),
        h("p", { className: "tl-dim" }, "换个筛选条件试试"))
      var max = Math.max.apply(null, rows.map(function (r) { return n(r.total) }).concat([1]))
      var t = data.totals || {}
      var nameOf = function (r) {
        if (mode === "week") return h(react.Fragment, null,
          h("span", { style: { fontWeight: 560 } }, r.label || r.key),
          h("span", { className: "tl-dim tl-mono", style: { marginLeft: 8 } }, r.key))
        if (mode === "month") return h("span", { style: { fontWeight: 560 } }, r.label || r.key)
        return h("span", { className: "tl-mono" }, r.day)
      }
      return h("table", { className: "tl-table" },
        TableHead([{ label: mode === "week" ? "周（周一 ~ 周日）" : mode === "month" ? "月份" : "日期", left: true },
          { label: "事件" }, { label: "会话" }, { label: "轮次" },
          { label: "输入" }, { label: "缓存读" }, { label: "缓存写" }, { label: "输出" },
          { label: "合计" }, { label: "占比" }]),
        h("tbody", null, rows.map(function (r, i) {
          return h("tr", { key: (r.key || r.day || "") + i },
            h("td", { className: "left" }, nameOf(r)),
            h("td", { className: "tl-mono tl-dim" }, fmt(r.events)),
            h("td", { className: "tl-mono tl-dim" }, fmt(r.sessionCount)),
            h("td", { className: "tl-mono tl-dim" }, fmt(r.turns)),
            h("td", { className: "tl-mono tl-dim" }, fmt(r.input)),
            h("td", { className: "tl-mono tl-dim" }, fmt(r.cacheRead)),
            h("td", { className: "tl-mono tl-dim" }, fmt(r.cacheWrite)),
            h("td", { className: "tl-mono tl-dim" }, fmt(r.output)),
            h("td", null,
              h("div", { className: "tl-strong" }, fmt(r.total)),
              h(Bar, { value: r.total, max: max })),
            h("td", { className: "tl-dim tl-mono" }, pct(r.total, t.total).toFixed(2) + "%"))
        })),
        h("tfoot", null, h("tr", { className: "tl-total-row" },
          h("td", { className: "left" }, "总计 · ", rows.length, " 个",
            mode === "week" ? "周" : mode === "month" ? "月" : "天"),
          h("td", { className: "tl-mono" }, fmt(t.events)),
          h("td", { className: "tl-mono" }, fmt(t.sessions)),
          h("td", { className: "tl-mono" }, fmt(t.turns)),
          h("td", { className: "tl-mono" }, fmt(t.input)),
          h("td", { className: "tl-mono" }, fmt(t.cacheRead)),
          h("td", { className: "tl-mono" }, fmt(t.cacheWrite)),
          h("td", { className: "tl-mono" }, fmt(t.output)),
          h("td", { className: "tl-strong" }, fmt(t.total)),
          h("td", null, "100%"))))
    }

    function EventsView(props) {
      var data = props.data
      var rows = (data.recentEvents || []).filter(function (e) {
        return matches(props.query, [e.model, e.sessionTitle, e.sessionId, e.day])
      })
      if (!rows.length) return h("div", { className: "tl-empty" },
        h("div", { className: "big" }, "◔"), h("p", null, props.query ? "没有匹配的记录" : "这个范围内没有明细记录"))
      return h("div", null,
        h("table", { className: "tl-table" },
          TableHead([{ label: "时间", left: true }, { label: "会话", left: true }, { label: "轮次" },
            { label: "模型", left: true }, { label: "输入" }, { label: "缓存读" }, { label: "缓存写" },
            { label: "输出" }, { label: "推理" }, { label: "合计" }, { label: "来源" }]),
          h("tbody", null, rows.map(function (e, i) {
            return h("tr", { key: (e.ts || 0) + "-" + i },
              h("td", { className: "left tl-dim" }, fullOf(e.ts)),
              h("td", { className: "left" },
                h("div", { className: "tl-name" },
                  h("span", { title: e.sessionTitle || e.sessionId },
                    e.sessionTitle || shortId(e.sessionId)))),
              h("td", { className: "tl-mono tl-dim" }, e.turn == null ? "—" : "#" + e.turn),
              h("td", { className: "left tl-dim" }, e.model),
              h("td", { className: "tl-mono tl-dim" }, fmt(e.input)),
              h("td", { className: "tl-mono tl-dim" }, fmt(e.cacheRead)),
              h("td", { className: "tl-mono tl-dim" }, fmt(e.cacheWrite)),
              h("td", { className: "tl-mono tl-dim" }, fmt(e.output)),
              h("td", { className: "tl-mono tl-dim" }, fmt(e.reasoning)),
              h("td", { className: "tl-strong" }, fmt(e.total)),
              h("td", null, h("span", { className: "tl-tag " + (e.source === "history" ? "hist" : "live") },
                e.source === "history" ? "历史" : "实时")))
          }))),
        (data.recentEventsTotal || 0) > rows.length ? h("div", { className: "tl-dim", style: { padding: "9px 10px", textAlign: "right" } },
          "显示最近 ", fmt(rows.length), " 条 · 该范围共 ", fmt(data.recentEventsTotal), " 条（可用上方搜索框继续过滤）") : null)
    }

    /** One of the two books. Clicking it scopes the whole page to that book. */
    function BookCard(props) {
      var which = props.which
      var g = props.book || {}
      var on = props.group === which
      var color = which === "before" ? "#d97706" : "#16a34a"
      var buckets = [
        { label: "输入", v: g.input, c: "#6366f1" },
        { label: "缓存读", v: g.cacheRead, c: "#06b6d4" },
        { label: "缓存写", v: g.cacheWrite, c: "#f59e0b" },
        { label: "输出", v: g.output, c: "#22c55e" }
      ]
      return h("div", {
        className: "tl-book" + (on ? " on" : ""), style: { "--book": color },
        onClick: function () { props.onToggle(on ? "all" : which) },
        title: on ? "点击回到两本账合计" : "点击只看这一本账"
      },
        h("div", { className: "tl-book-label" },
          g.label || (which === "before" ? "之前（历史账）" : "现在（新账）"),
          h("span", { className: "tl-tag " + (which === "before" ? "hist" : "live") }, on ? "当前查看" : "单独查看")),
        h("div", { className: "tl-book-value tl-exact", title: fmt(g.total),
          style: { fontSize: exactSize(fmt(g.total), 27, 17) + "px" } },
          fmt(g.total), h("span", { className: "tl-kpi-unit" }, "tokens")),
        h("div", { className: "tl-book-meta" },
          which === "before" ? "分界点之前 · 之前的账" : "分界点之后 · 从现在起往后记",
          " · ", fmt(g.events), " 条 · ", fmt(g.sessions), " 个会话"),
        h("div", { className: "tl-book-range" },
          g.fromTs ? fullOf(g.fromTs) : "—", " → ", g.toTs ? fullOf(g.toTs) : "—"),
        h("div", { className: "tl-book-buckets" }, buckets.map(function (b, i) {
          return h("span", { key: i }, h("b", { style: { background: b.c } }), b.label, " ", fmt(b.v))
        })),
        g.topModels && g.topModels.length ? h("div", { className: "tl-book-models" },
          "主要模型：", g.topModels.slice(0, 3).map(function (m) { return m.model + " " + fmt(m.total) }).join(" · ")) : null)
    }

    function AboutView(props) {
      var data = props.data
      return h("div", { className: "tl-note" },
        h("p", null, h("b", null, "两本账怎么分")),
        h("ul", null,
          h("li", null, "顶部两张卡片是 ", h("b", null, "两个独立的账本"), "：", h("b", null, "「之前」"),
            " 是分界点以前的全部消耗（含从 whale 账本导入的安装前历史），", h("b", null, "「现在」"),
            " 是分界点以后新记的每一轮。点卡片即可只查看其中一本，两本各有自己的总消耗。"),
          h("li", null, "分界点默认是插件首次启动时刻；点筛选栏里的「从现在重新起账」可把分界线移到当下，",
            "此后产生的消耗全部进「现在」这本，之前的归到「之前」这本。", h("b", null, "不改写、不删除任何历史数据"), "，可随时恢复默认。"),
          h("li", null, "两本相加就是最上面的「合计消耗」，四个 tab 的每一行也都有总计行。")),
        h("div", { className: "tl-divider" }),
        h("p", null, h("b", null, "按周 / 按月 / 按天筛选")),
        h("ul", null,
          h("li", null, "快捷筛选：今天、本周、上周、本月、上月、近 7 天、近 30 天；",
            "也能用两个日期框选「某天到某天」，或从下拉里直接挑某一周、某一月。"),
          h("li", null, "「按周 / 月」页逐行列出每个周期的事件数、会话数、轮次、四桶用量和合计，",
            "表尾是总计。一周按 ", h("b", null, "周一 ~ 周日"), " 划分（ISO 周）。"),
          h("li", null, "筛选是全局的：KPI、消耗构成、柱状图、按会话、按模型、明细，", h("b", null, "全部跟着筛选结果重算"), "。")),
        h("div", { className: "tl-divider" }),
        h("p", null, h("b", null, "四桶与模型")),
        h("ul", null,
          h("li", null, h("b", null, "总 Token = 输入 + 缓存读取 + 缓存写入 + 输出"),
            "。四桶在 KPI、构成图、按会话、按模型、按周月、逐条明细里都单独列出。"),
          h("li", null, "DSH 的 ", h("span", { className: "tl-code" }, "outputTokens"),
            " 已包含 ", h("span", { className: "tl-code" }, "reasoningTokens"),
            "，「推理」只单独展示、绝不重复累加，避免把总量算虚高。",
            h("span", { className: "tl-code" }, "inputTokens"), " 与 ",
            h("span", { className: "tl-code" }, "uncachedInputTokens"), " 是别名，只取其一。"),
          h("li", null, "每个模型的输入 / 缓存读 / 缓存写 / 输出 / 推理 / 合计都在「按模型」页，",
            "点开某个会话还能看到它内部按模型的拆分。"),
          h("li", null, "安装前的 whale 历史日志只保存了总量，没有四桶拆分，所以「之前」那本的四个分项显示为 0，",
            "总量准确；安装后的每一轮都有完整四桶。")),
        h("div", { className: "tl-divider" }),
        h("p", null, h("b", null, "数值精度 · 零估算")),
        h("ul", null,
          h("li", null, "所有 Token 数值都是 ", h("b", null, "账本里存的原始逐位精确值"),
            "，只加千分位分隔符，", h("b", null, "不用 K / M / B 缩写、不四舍五入、不估算、不取近似"),
            "。KPI、两本账卡片、构成图、柱状图提示、按会话 / 按模型 / 按周月 / 逐条明细，全部是同一个精确值。"),
          h("li", null, "百分比保留 2 位小数；费用保留最多 4 位小数；如果上游上报了小数 token，也原样保留，不抹零。"),
          h("li", null, "记录侧同样不做任何折算：直接取 ", h("span", { className: "tl-code" }, "usage"),
            " 里的整数字段累加，导出 JSON 与页面显示完全一致，鼠标悬停数字还能看到完整值。")),
        h("div", { className: "tl-divider" }),
        h("p", null, h("b", null, "数据与接口")),
        h("p", null, "插件监听宿主的 ", h("span", { className: "tl-code" }, "session/event"),
          "，把一轮里所有 ", h("span", { className: "tl-code" }, "assistant/message"),
          " 按「会话 + 轮次 + 模型」聚合后落盘 ", h("span", { className: "tl-code" }, "~/.dsh/token-ledger/ledger.json"),
          "；原子写入，超过 2 万条自动归档。"),
        h("p", null,
          "GET ", h("span", { className: "tl-code" }, BASE + "/data.json"), "（全量） · ",
          h("span", { className: "tl-code" }, BASE + "/query.json?group=before&from=2026-11-01&to=2026-11-05"), "（筛选） · ",
          h("span", { className: "tl-code" }, BASE + "/health.json"), " · ",
          h("span", { className: "tl-code" }, BASE + "/export.json"), "；",
          "POST ", h("span", { className: "tl-code" }, BASE + "/baseline"), " 移动分界点 · ",
          h("span", { className: "tl-code" }, BASE + "/import-history"), " 补导历史（幂等）。"),
        h("p", null, "「导出账本」下载完整 JSON；「清空实时记录」只清本插件记下的实时轮次，",
          h("b", null, "保留已导入的历史"), "，需要二次确认。"),
        h("div", { style: { marginTop: 14 } },
          h("button", {
            className: "tl-btn danger", disabled: props.busy,
            onClick: function () {
              if (!window.confirm("确定清空本插件记录的实时用量吗？\n已导入的历史用量会保留，此操作不可撤销。")) return
              props.onAction("reset")
            }
          }, "清空实时记录")),
        h("div", { className: "tl-divider" }),
        h("p", { className: "tl-dim" }, "dsh-token-ledger v", data.version || "1.2.0",
          " · 精确数值模式（零估算 / 零缩写） · 首次启动 ", fullOf(data.firstStartAt), " · 当前分界点 ", fullOf(data.baselineAt)))
    }

    // -------------------------------------------------------------- main page
    // -------------------------------------------------------------- main page
    function LedgerPage() {
      injectStyles()
      var s0 = useState(null); var data = s0[0], setData = s0[1]
      var s1 = useState(""); var err = s1[0], setErr = s1[1]
      var s2 = useState(true); var loading = s2[0], setLoading = s2[1]
      var s3 = useState(false); var busy = s3[0], setBusy = s3[1]
      var s4 = useState("sessions"); var tab = s4[0], setTab = s4[1]
      var s5 = useState(""); var query = s5[0], setQuery = s5[1]
      var s6 = useState(null); var expanded = s6[0], setExpanded = s6[1]
      var s7 = useState(true); var live = s7[0], setLive = s7[1]
      var s8 = useState(0); var last = s8[0], setLast = s8[1]
      var s9 = useState("all"); var group = s9[0], setGroup = s9[1]
      var s10 = useState("all"); var preset = s10[0], setPreset = s10[1]
      var s11 = useState(""); var fromDate = s11[0], setFromDate = s11[1]
      var s12 = useState(""); var toDate = s12[0], setToDate = s12[1]
      var s13 = useState(""); var weekPick = s13[0], setWeekPick = s13[1]
      var s14 = useState(""); var monthPick = s14[0], setMonthPick = s14[1]
      var s15 = useState("week"); var periodMode = s15[0], setPeriodMode = s15[1]

      var facets = (data && data.facets) || { weeks: [], months: [] }
      // A content signature, NOT `data`: the payload object is re-created on
      // every 5s poll. Depending on `data` here would rebuild range -> url ->
      // load -> useEffect, which immediately fetches again -> infinite loop.
      var facetKey = (facets.weeks || []).map(function (w) {
        return w.key + ":" + w.startTs + ":" + w.endTs
      }).join("|") + "#" + (facets.months || []).map(function (m) {
        return m.key + ":" + m.startTs + ":" + m.endTs
      }).join("|")
      var range = useMemo(function () {
        if (preset === "weekpick" && weekPick) {
          var w = (facets.weeks || []).find(function (x) { return x.key === weekPick })
          if (w) return [isoDay(new Date(w.startTs)), isoDay(new Date(w.endTs)), w.key + " 周"]
        }
        if (preset === "monthpick" && monthPick) {
          var m = (facets.months || []).find(function (x) { return x.key === monthPick })
          if (m) return [isoDay(new Date(m.startTs)), isoDay(new Date(m.endTs)), m.label]
        }
        if (preset === "custom") return [fromDate, toDate, "自定义"]
        return presetRange(preset)
      }, [preset, fromDate, toDate, weekPick, monthPick, facetKey])

      var url = useMemo(function () {
        var q = []
        if (group !== "all") q.push("group=" + encodeURIComponent(group))
        if (range[0]) q.push("from=" + encodeURIComponent(range[0]))
        if (range[1]) q.push("to=" + encodeURIComponent(range[1]))
        q.push("label=" + encodeURIComponent(range[2] || ""))
        return BASE + "/query.json?" + q.join("&")
      }, [group, range])

      var load = useCallback(function () {
        var headers = {}
        var tag = etagStore[url]
        if (tag) headers["If-None-Match"] = tag
        return fetch(url, { cache: "no-store", credentials: "same-origin", headers: headers })
          .then(function (r) {
            var fresh = r.headers && r.headers.get && r.headers.get("etag")
            // Nothing changed on the host: keep the existing data object, so
            // React skips the expensive table rebuild entirely.
            if (r.status === 304) {
              if (fresh) etagStore[url] = fresh
              return { __notModified: true }
            }
            // A freshly refreshed shell can load the new client before the host
            // process has been restarted. Fall back to the unfiltered endpoint
            // so the page still renders instead of showing an error.
            if (r.status === 404 && url.indexOf("/query.json") >= 0) {
              delete etagStore[url]
              return fetch(BASE + "/export.json", { cache: "no-store", credentials: "same-origin" })
                .then(function (r2) { if (!r2.ok) throw new Error("HTTP " + r2.status); return r2.json() })
                .then(function (raw) { return fallbackPayload(raw, url) })
            }
            if (!r.ok) throw new Error("HTTP " + r.status)
            if (fresh) etagStore[url] = fresh
            else delete etagStore[url]
            return r.json()
          })
          .then(function (j) {
            if (j && j.__notModified) { setErr(""); setLoading(false); setLast(Date.now()); return }
            if (!j || j.ok !== true) throw new Error("接口返回异常")
            setData(j); setErr(""); setLoading(false); setLast(Date.now())
          })
          .catch(function (e) { setErr(String((e && e.message) || e)); setLoading(false) })
      }, [url])

      useEffect(function () {
        load()
        if (!live) return
        var t = setInterval(function () {
          // A hidden tab has nobody looking at it; don't burn a request every
          // 5s. The visibility listener below reloads as soon as it comes back.
          if (typeof document !== "undefined" && document.hidden) return
          load()
        }, REFRESH_MS)
        var onVisible = function () {
          if (typeof document !== "undefined" && document.hidden) return
          load()
        }
        if (typeof document !== "undefined" && document.addEventListener) {
          document.addEventListener("visibilitychange", onVisible)
        }
        return function () {
          clearInterval(t)
          if (typeof document !== "undefined" && document.removeEventListener) {
            document.removeEventListener("visibilitychange", onVisible)
          }
        }
      }, [load, live])

      function clearFilter() {
        setPreset("all"); setFromDate(""); setToDate(""); setWeekPick(""); setMonthPick(""); setGroup("all")
      }
      function action(kind) {
        setBusy(true)
        var path, body = "{}"
        if (kind === "reset") { path = BASE + "/reset"; body = JSON.stringify({ confirm: true }) }
        else if (kind === "import") path = BASE + "/import-history"
        else if (kind === "baseline") { path = BASE + "/baseline"; body = JSON.stringify({ at: Date.now() }) }
        else if (kind === "baseline-reset") { path = BASE + "/baseline"; body = JSON.stringify({ reset: true }) }
        else { setBusy(false); return }
        return fetch(path, { method: "POST", headers: { "content-type": "application/json" },
          credentials: "same-origin", body: body })
          .then(function (r) { return r.json().catch(function () { return {} }).then(function (j) { return { r: r, j: j } }) })
          .then(function (o) {
            if (!o.r.ok || o.j.ok === false) throw new Error(o.j.error || ("HTTP " + o.r.status))
            return load()
          })
          .catch(function (e) { setErr(String((e && e.message) || e)) })
          .then(function () { setBusy(false) })
      }
      function rebase() {
        if (!window.confirm("把分界点移到此刻？\n此后新产生的消耗记进「现在」这本，此前的全部归到「之前」。历史数据不会改写或删除。")) return
        action("baseline")
      }
      function exportLedger() {
        return fetch(BASE + "/export.json", { cache: "no-store", credentials: "same-origin" })
          .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.blob() })
          .then(function (blob) {
            var u = URL.createObjectURL(blob)
            var a = document.createElement("a")
            a.href = u
            a.download = "dsh-token-ledger-" + dayOf(Date.now()) + ".json"
            document.body.appendChild(a); a.click()
            setTimeout(function () { try { document.body.removeChild(a) } catch (e) {} URL.revokeObjectURL(u) }, 1500)
          })
          .catch(function (e) { setErr(String((e && e.message) || e)) })
      }

      var view = data || {
        totals: {}, groups: {}, filter: {}, facets: { weeks: [], months: [] },
        days: [], weeks: [], months: [], models: [], sessions: [], recentEvents: []
      }
      var totals = view.totals || {}
      var total = n(totals.total)
      var books = (view.groups && Object.keys(view.groups).length) ? view.groups : {
        before: { label: "之前（旧版宿主 · 全部数据）", total: total, events: totals.events,
          sessions: totals.sessions, input: totals.input, cacheRead: totals.cacheRead,
          cacheWrite: totals.cacheWrite, output: totals.output, topModels: [] },
        after: { label: "现在（重启宿主后启用）", total: 0, events: 0, sessions: 0,
          input: 0, cacheRead: 0, cacheWrite: 0, output: 0, topModels: [] }
      }
      var todayKey = dayOf(Date.now())
      var todayRow = (view.days || []).find(function (d) { return d.day === todayKey }) || null
      var periods = periodMode === "week" ? (view.weeks || [])
        : periodMode === "month" ? (view.months || []) : (view.days || [])
      var chart = periods.slice(-30)
      var chartMax = Math.max.apply(null, chart.map(function (d) { return n(d.total) }).concat([1]))
      var parts = [
        { label: "输入", value: n(totals.input), color: "#6366f1" },
        { label: "缓存读取", value: n(totals.cacheRead), color: "#06b6d4" },
        { label: "缓存写入", value: n(totals.cacheWrite), color: "#f59e0b" },
        { label: "输出（含推理）", value: n(totals.output), color: "#22c55e" }
      ]
      var presets = [
        { id: "all", label: "全部时间" }, { id: "today", label: "今天" },
        { id: "week", label: "本周" }, { id: "lastweek", label: "上周" },
        { id: "month", label: "本月" }, { id: "lastmonth", label: "上月" },
        { id: "7d", label: "近 7 天" }, { id: "30d", label: "近 30 天" }
      ]
      var tabs = [
        { id: "sessions", label: "按会话" }, { id: "models", label: "按模型" },
        { id: "periods", label: "按周 / 月" }, { id: "events", label: "消耗明细" },
        { id: "about", label: "统计口径" }
      ]

      return h("div", { className: "tl-root" },
        // header
        h("div", { className: "tl-head" },
          h("div", null,
            h("div", { className: "tl-title" },
              h("div", { className: "tl-badge" }, h(Glyph, { size: 21 })),
              h("div", null,
                h("h1", { className: "tl-h1" }, "Token 用量账本"),
                h("p", { className: "tl-sub" }, "两个账本 · 按周 / 按月 / 按天 · 四桶拆分与每个模型，随时筛选"))),
            h("div", { className: "tl-status" },
              h("span", { className: "tl-dot " + (err ? "bad" : (loading ? "wait" : "")) }),
              err ? "接口不可用 · " + err : (loading ? "正在读取账本…" :
                "已连接 · " + (live ? "每 5 秒自动刷新" : "自动刷新已暂停") +
                (last ? " · " + ago(last).replace("刚刚", "刚更新") : "") +
                (totals.events ? " · 当前范围 " + fmt(totals.events) + " 条" : "")))),
          h("div", { className: "tl-actions" },
            h("button", { className: "tl-btn", onClick: load, disabled: busy }, "刷新"),
            h("button", { className: "tl-btn", onClick: function () { setLive(!live) } },
              live ? "暂停刷新" : "恢复刷新"),
            h("button", { className: "tl-btn", onClick: function () { action("import") }, disabled: busy,
              title: "从 whale 账本补导入安装前的历史用量（幂等）" }, "补导历史"),
            h("button", { className: "tl-btn primary", onClick: exportLedger, disabled: busy }, "导出账本"))),
        err ? h("div", { className: "tl-error" },
          "读取失败：", err, " · 请确认插件宿主已加载后点「刷新」。") : null,

        // filter
        h("div", { className: "tl-panel tl-filter" },
          h("div", { className: "tl-filter-head" },
            h("h3", { className: "tl-panel-title", style: { margin: 0 } }, "筛选范围"),
            h("span", { className: "tl-filter-summary" },
              range[2] || "全部时间", " · 命中 ",
              h("strong", null, fmt((view.filter && view.filter.events) || 0)), " / ",
              fmt((view.filter && view.filter.totalEvents) || 0), " 条 · 合计 ",
              h("strong", null, fmt(total)), " tokens · ",
              group === "before" ? "只看「之前」" : group === "after" ? "只看「现在」" : "两本合计", view.fallback ? " · 页面本地统计（重启宿主后由宿主直接算）" : "")),
          h("div", { className: "tl-filter-row" },
            h("div", { className: "tl-chips" }, presets.map(function (p) {
              return h("button", {
                key: p.id, className: "tl-chip" + (preset === p.id ? " on" : ""),
                onClick: function () {
                  setPreset(p.id)
                  if (p.id !== "custom") { setFromDate(""); setToDate("") }
                }
              }, p.label)
            })),
            h("button", { className: "tl-btn", onClick: clearFilter }, "清除筛选")),
          h("div", { className: "tl-filter-row" },
            h("label", { className: "tl-field" }, "从 ",
              h("input", { type: "date", className: "tl-date", value: fromDate,
                onChange: function (e) { setFromDate(e.target.value); setPreset("custom") } })),
            h("label", { className: "tl-field" }, "到 ",
              h("input", { type: "date", className: "tl-date", value: toDate,
                onChange: function (e) { setToDate(e.target.value); setPreset("custom") } })),
            h("label", { className: "tl-field" }, "某周 ",
              h("select", { className: "tl-select", value: weekPick,
                onChange: function (e) { setWeekPick(e.target.value); setPreset("weekpick") } },
                h("option", { value: "" }, "选择周…"),
                (facets.weeks || []).map(function (w) {
                  return h("option", { key: w.key, value: w.key }, w.key + "（" + w.label + "）")
                }))),
            h("label", { className: "tl-field" }, "某月 ",
              h("select", { className: "tl-select", value: monthPick,
                onChange: function (e) { setMonthPick(e.target.value); setPreset("monthpick") } },
                h("option", { value: "" }, "选择月…"),
                (facets.months || []).map(function (m) {
                  return h("option", { key: m.key, value: m.key }, m.label)
                })))),
          h("div", { className: "tl-filter-note" },
            "两本账的分界点：", h("b", null, fullOf(view.baselineAt || (data && data.firstStartAt))),
            " · 点上方卡片可单独查看某一本",
            h("button", { className: "tl-btn", onClick: rebase, disabled: busy,
              title: "把分界线移到此刻，之后的新消耗记进「现在」这本" }, "从现在重新起账"),
            h("button", { className: "tl-btn", onClick: function () { action("baseline-reset") }, disabled: busy,
              title: "恢复为插件首次启动时刻" }, "恢复默认分界"))),

        // the two books
        h("div", { className: "tl-books" },
          h(BookCard, { which: "before", book: books.before, group: group, onToggle: setGroup }),
          h(BookCard, { which: "after", book: books.after, group: group, onToggle: setGroup })),

        // KPI cards
        h("div", { className: "tl-kpis" },
          h(Kpi, { label: "合计消耗", value: total, unit: "tokens", color: "#6366f1",
            foot: group === "all" ? "两本账相加 · 当前筛选范围" : "当前账本 · 当前筛选范围" }),
          h(Kpi, { label: "输入", value: totals.input, unit: "tokens", color: "#6366f1",
            foot: "未命中缓存的输入" }),
          h(Kpi, { label: "缓存读取", value: totals.cacheRead, unit: "tokens", color: "#06b6d4",
            foot: "命中缓存的输入" }),
          h(Kpi, { label: "缓存写入", value: totals.cacheWrite, unit: "tokens", color: "#f59e0b",
            foot: "写入缓存的输入" }),
          h(Kpi, { label: "输出", value: totals.output, unit: "tokens", color: "#22c55e",
            foot: "含推理 " + fmt(totals.reasoning) }),
          h(Kpi, { label: "今日消耗", value: todayRow && todayRow.total, unit: "tokens", color: "#8b5cf6",
            foot: todayKey + (todayRow ? " · " + fmt(todayRow.events) + " 条" : " · 该范围无今日记录") }),
          h(Kpi, { label: "会话 / 轮次", value: 0,
            text: fmt(totals.sessions) + " / " + fmt(totals.turns), color: "#14b8a6",
            foot: "按会话 + turn 去重" }),
          n(totals.costEvents) > 0 ? h(Kpi, { label: "历史费用", value: totals.cost,
            text: money(totals.cost), color: "#f59e0b",
            foot: "来自历史账本 · " + fmt(totals.costEvents) + " 条有价记录" }) : null),

        // composition
        h("div", { className: "tl-panel" },
          h("h3", { className: "tl-panel-title" }, "消耗构成"),
          h("p", { className: "tl-panel-desc" },
            "四部分相加即为合计；推理 token 已含在输出内，不重复计入。历史总量没有四桶拆分，因此四桶之和可能小于合计。"),
          h("div", { className: "tl-stack" }, parts.map(function (p, i) {
            return h("i", { key: i, style: { width: pct(p.value, total) + "%", background: p.color } })
          })),
          h("div", { className: "tl-legend" }, parts.map(function (p, i) {
            return h("span", { key: i },
              h("b", { style: { background: p.color } }),
              p.label, " ", h("strong", null, fmt(p.value)),
              h("span", { className: "tl-dim" }, " (" + pct(p.value, total).toFixed(2) + "%)"))
          }))),

        // chart
        h("div", { className: "tl-panel" },
          h("div", { className: "tl-toolbar", style: { marginBottom: 6 } },
            h("h3", { className: "tl-panel-title", style: { margin: 0 } }, "消耗趋势"),
            h("div", { className: "tl-seg" }, [
              { id: "day", label: "按天" }, { id: "week", label: "按周" }, { id: "month", label: "按月" }
            ].map(function (m) {
              return h("button", { key: m.id, className: periodMode === m.id ? "on" : "",
                onClick: function () { setPeriodMode(m.id) } }, m.label)
            }))),
          h("p", { className: "tl-panel-desc" }, "最近 ", Math.max(chart.length, 1),
            " 个", periodMode === "week" ? "周" : periodMode === "month" ? "月" : "天",
            " · 峰值 ", fmt(chartMax), " tokens · 悬停查看数值"),
          h("div", { className: "tl-chart" }, chart.map(function (d, i) {
            var hp = Math.max(2, (n(d.total) / chartMax) * 100)
            var label = d.label || d.day || d.key || "—"
            return h("div", { key: label + i, className: "tl-col" +
                ((d.day === todayKey) ? " today" : ""),
              title: label + " · " + fmt(d.total) + " tokens · " + fmt(d.events) + " 条" },
              h("div", { className: "tl-col-bar", style: { height: hp + "%" } }))
          })),
          h("div", { className: "tl-chart-labels" },
            h("span", null, chart.length ? (chart[0].label || chart[0].day || chart[0].key) : "—"),
            h("span", null, periodMode === "week" ? "每周 token 消耗" : periodMode === "month" ? "每月 token 消耗" : "每日 token 消耗"),
            h("span", null, chart.length ? (chart[chart.length - 1].label || chart[chart.length - 1].day || chart[chart.length - 1].key) : "—"))),

        // toolbar + content
        h("div", { className: "tl-toolbar" },
          h("div", { className: "tl-tabs" }, tabs.map(function (t) {
            return h("button", { key: t.id, className: "tl-tab" + (tab === t.id ? " on" : ""),
              onClick: function () { setTab(t.id); setExpanded(null) } }, t.label)
          })),
          h("div", { style: { display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" } },
            tab === "periods" ? h("div", { className: "tl-seg" }, [
              { id: "week", label: "按周" }, { id: "month", label: "按月" }, { id: "day", label: "按天" }
            ].map(function (m) {
              return h("button", { key: m.id, className: periodMode === m.id ? "on" : "",
                onClick: function () { setPeriodMode(m.id) } }, m.label)
            })) : null,
            tab !== "about" ? h("input", {
              className: "tl-search", placeholder: "搜索会话 / 模型 / 时间段…",
              value: query, onChange: function (e) { setQuery(e.target.value) }
            }) : null)),
        h("div", { className: "tl-panel", style: { padding: tab === "about" ? "18px" : "6px 8px" } },
          !data && loading ? h("div", { className: "tl-empty" }, h("p", null, "正在读取账本…"))
            : tab === "sessions" ? h(SessionsView, { data: view, query: query, expanded: expanded, onExpand: setExpanded })
            : tab === "models" ? h(ModelsView, { data: view, query: query })
            : tab === "periods" ? h(PeriodsView, { data: view, query: query, mode: periodMode })
            : tab === "events" ? h(EventsView, { data: view, query: query })
            : h(AboutView, { data: view, busy: busy, onAction: action })),
        h("div", { className: "tl-foot" },
          h("span", null, "数据文件 ", h("code", null, view.ledgerPath || "~/.dsh/token-ledger/ledger.json")),
          h("span", null, "首次记录 ", fullOf(view.firstStartAt || Date.now())),
          h("span", null, "分界点 ", fullOf(view.baselineAt || (data && data.firstStartAt))),
          h("span", null, "最早事件 ", view.firstEventTs ? fullOf(view.firstEventTs) : "—"),
          h("span", null, "最后事件 ", view.lastEventTs ? fullOf(view.lastEventTs) : "—"),
          h("span", null, "dsh-token-ledger v" + (view.version || "1.2.0") + " · 精确数值"))
      )
    }

    // ------------------------------------------------------------- registration
    var wired = false
    function wire(ready) {
      if (wired || !ready || !ready.slots) return
      wired = true
      var slots = ready.slots
      try {
        slots.inject("sidebar.panellist", function () {
          return slots.register({
            name: "sidebar.panellist",
            id: PANEL_ID,
            order: 26,
            label: "Token 账本"
          }, function (owner) { return h(Glyph, { size: (owner && owner.size) || 16 }) })
        })
      } catch (e) { /* one slot must not block the other */ }
      try {
        slots.inject("main", function () {
          return slots.register({ name: "main", key: PANEL_ID }, LedgerPage)
        })
      } catch (e) { /* ignore */ }
    }

    function apply(ctx) {
      injectStyles()
      // Newer shells expose an async inject() that waits for the service; older
      // ones hang `slots` straight on ctx. Cover both; `wired` makes it safe.
      try {
        if (typeof ctx.inject === "function") ctx.inject(["slots"], wire)
      } catch (e) { /* fall through to the direct path */ }
      try {
        if (ctx.slots !== void 0) wire(ctx)
      } catch (e) { /* ignore */ }
    }

    exports.inject = ['slots']
    exports.apply = apply
    // Exposed so the offline parity test can compare page-local aggregation
    // against the host's /query.json for the same ledger.
    exports.fallbackPayload = fallbackPayload
    // Exposed so the offline exactness test can lock in "no abbreviation".
    exports.__format = { fmt: fmt, exactSize: exactSize }
    return module.exports
  }
});

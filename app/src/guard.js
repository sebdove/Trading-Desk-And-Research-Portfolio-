// Burst guard: the crash-calling rules from the 150-market study, shared by the bots, the backtest and the desk.
//   'vol' (any market): out when the daily close is one monthly-volatility unit below the 200-day average,
//                       back in one unit above it.
//   'sp'  (S&P 500):    out when the close is 3% below the 200-day average while warned (Bubble Watch score 65+
//                       in the last 12 months, or the 10-year minus 3-month yield curve inverted in the last 18 months,
//                       monthly readings used from the next month); back in 3% above it.
//   Both: fast re-entry. After a fall of one yearly volatility from the exit price, back in on a close above the 50-day average.
// Volatility = standard deviation of daily log returns over up to 3 years (at least 1), x sqrt(252), the same as the study.
// The state for day i is decided at that day's close and applies from the next bar.
// Plain JS: works in Node and in a browser.
(function (root) {
  const DAY = 86400;

  // one close per UTC day from a series {t:[sec], c:[price]} (the last close of each day)
  function daily(S, tf = DAY) {
    const d = [], c = [];
    for (let i = 0; i < S.t.length; i++) {
      const day = Math.floor((S.t[i] + tf) / DAY) - 1;          // the UTC day in which the bar closes
      if (d.length && d[d.length - 1] === day) c[c.length - 1] = S.c[i]; else { d.push(day); c.push(S.c[i]) }
    }
    return { d, c };
  }

  // warned(month) from Bubble Watch monthly data {start:'YYYY-MM', froth:[], gs10:[], tb3:[]}
  function spWarning(mon) {
    if (!mon || !mon.froth || !mon.start) return null;
    const [y0, m0] = mon.start.split('-').map(Number), n = mon.froth.length, w = new Uint8Array(n + 1);
    for (let i = 1; i <= n; i++) {                                // warning in force during month i: readings of months i-12..i-1 / i-18..i-1
      let on = false;
      for (let k = Math.max(0, i - 12); k < i && !on; k++) if (mon.froth[k] != null && mon.froth[k] >= 65) on = true;
      if (!on && mon.gs10 && mon.tb3) for (let k = Math.max(0, i - 18); k < i && !on; k++) if (mon.gs10[k] != null && mon.tb3[k] != null && mon.gs10[k] - mon.tb3[k] < 0) on = true;
      w[i] = on ? 1 : 0;
    }
    const at = day => { const dt = new Date(day * DAY * 1000), i = (dt.getUTCFullYear() - y0) * 12 + dt.getUTCMonth() - (m0 - 1); return i < 1 ? false : !!w[Math.min(i, n)] };
    return at;
  }

  // kind 'vol' or 'sp'; warned(day) -> bool (needed for 'sp'); fast: fast re-entry on (default true)
  function compute(D, { kind = 'vol', warned = null, fast = true } = {}) {
    const n = D.c.length, px = D.c, s200 = new Float64Array(n).fill(NaN), s50 = new Float64Array(n).fill(NaN), vol = new Float64Array(n).fill(NaN);
    let a = 0, b = 0;
    for (let i = 0; i < n; i++) { a += px[i]; b += px[i]; if (i >= 200) a -= px[i - 200]; if (i >= 50) b -= px[i - 50]; if (i >= 199) s200[i] = a / 200; if (i >= 49) s50[i] = b / 50 }
    // rolling volatility of log returns, window up to 756, at least 252
    const r = new Float64Array(n); for (let i = 1; i < n; i++) r[i] = Math.log(px[i] / px[i - 1]);
    let s1 = 0, s2 = 0, m = 0;
    for (let i = 1; i < n; i++) {
      s1 += r[i]; s2 += r[i] * r[i]; m++;
      if (m > 756) { const o = r[i - 756]; s1 -= o; s2 -= o * o; m-- }
      if (m >= 252) vol[i] = Math.sqrt(Math.max(0, (s2 - s1 * s1 / m) / (m - 1))) * Math.sqrt(252);
    }
    for (let i = n - 2; i >= 0; i--) if (isNaN(vol[i])) vol[i] = vol[i + 1];          // early days use the first available value (as the study did)
    const out = new Uint8Array(n), events = []; let on = false, exitPx = 0, low = 0, warn = null;
    const W = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const sm = vol[i] / Math.sqrt(12), ok = isFinite(s200[i]) && isFinite(sm);
      const lo = kind === 'sp' ? 0.97 * s200[i] : s200[i] * Math.exp(-sm), hi = kind === 'sp' ? 1.03 * s200[i] : s200[i] * Math.exp(sm);
      warn = kind === 'sp' ? !!(warned && warned(D.d[i])) : true; W[i] = warn ? 1 : 0;
      if (!on) {
        if (ok && px[i] < lo && warn) { on = true; exitPx = px[i]; low = px[i]; events.push({ day: D.d[i], type: 'out', px: px[i], why: kind === 'sp' ? '3% below the 200-day average while warned' : 'one volatility unit below the 200-day average' }) }
      } else {
        low = Math.min(low, px[i]);
        if (ok && px[i] > hi) { on = false; events.push({ day: D.d[i], type: 'in', px: px[i], why: kind === 'sp' ? '3% above the 200-day average' : 'one volatility unit above the 200-day average' }) }
        else if (fast && isFinite(vol[i]) && low <= exitPx * Math.exp(-vol[i]) && isFinite(s50[i]) && px[i] > s50[i]) { on = false; events.push({ day: D.d[i], type: 'in', px: px[i], why: 'fast re-entry: back above the 50-day average after a deep fall' }) }
      }
      out[i] = on ? 1 : 0;
    }
    return { kind, d: D.d, c: px, s200, s50, vol, out, warned: W, events };
  }

  // index of the latest day whose close is at or before time t (seconds)
  function idx(G, t) { const day = Math.floor(t / DAY) - 1; let lo = 0, hi = G.d.length - 1, j = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (G.d[m] <= day) { j = m; lo = m + 1 } else hi = m - 1 } return j }
  // state to act on at decision time t (seconds): out of the market?
  function outAt(G, t) { const j = idx(G, t); return j >= 0 && G.out[j] === 1 }

  // compact status for the desk
  function status(G, t = null) {
    const j = t == null ? G.d.length - 1 : idx(G, t); if (j < 0) return null;
    const sm = G.vol[j] / Math.sqrt(12), sp = G.kind === 'sp';
    const ev = G.events.filter(e => e.day <= G.d[j]), last = ev[ev.length - 1] || null;
    const exitPx = last && last.type === 'out' ? last.px : null;
    return { kind: G.kind, day: G.d[j], date: new Date(G.d[j] * DAY * 1000).toISOString().slice(0, 10), close: G.c[j], out: G.out[j] === 1, warned: G.warned[j] === 1,
      s200: G.s200[j], s50: G.s50[j], volYear: G.vol[j], volUnit: sm,
      exitLevel: isFinite(G.s200[j]) ? (sp ? 0.97 * G.s200[j] : G.s200[j] * Math.exp(-sm)) : null,
      backLevel: isFinite(G.s200[j]) ? (sp ? 1.03 * G.s200[j] : G.s200[j] * Math.exp(sm)) : null,
      fastLevel: exitPx ? exitPx * Math.exp(-G.vol[j]) : null,
      since: last ? new Date(last.day * DAY * 1000).toISOString().slice(0, 10) : null,
      events: ev.slice(-12).map(e => ({ date: new Date(e.day * DAY * 1000).toISOString().slice(0, 10), type: e.type, px: +e.px.toPrecision(6), why: e.why })) };
  }

  const GUARD = { daily, spWarning, compute, outAt, status, idx };
  if (typeof module !== 'undefined') module.exports = GUARD; else root.GUARD = GUARD;
})(typeof window !== 'undefined' ? window : globalThis);

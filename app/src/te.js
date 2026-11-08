// Trend Engine: a daily, long-only exposure model for one asset (0 = cash, 1 = fully in). Same code as the research backtest
// (designed on Bitcoin 2013-19, tested on 2020 - May 2026). Exposure decided at the close of day t from data up to t.
(function (root) {
  const DAY = 86400;

  // ---------- indicators (all causal: value at t uses data <= t) ----------
  function sma(p, n) { const o = new Float64Array(p.length).fill(NaN); let s = 0; for (let i = 0; i < p.length; i++) { s += p[i]; if (i >= n) s -= p[i - n]; if (i >= n - 1) o[i] = s / n } return o }
  function ema(p, n) { const o = new Float64Array(p.length), k = 2 / (n + 1); let e = p[0]; for (let i = 0; i < p.length; i++) { e = i ? p[i] * k + e * (1 - k) : p[0]; o[i] = i >= n - 1 ? e : NaN } return o }
  function vol(p, n) {            // annualised stdev of daily log returns over n days
    const o = new Float64Array(p.length).fill(NaN), r = [0]; for (let i = 1; i < p.length; i++) r.push(Math.log(p[i] / p[i - 1]));
    let s = 0, s2 = 0; for (let i = 1; i < p.length; i++) { s += r[i]; s2 += r[i] * r[i]; if (i > n) { s -= r[i - n]; s2 -= r[i - n] * r[i - n] } if (i >= n) { const m = s / n; o[i] = Math.sqrt(Math.max(0, s2 / n - m * m) * 365) } }
    return o;
  }
  // time-series momentum: share of look-backs with a positive return (0..1)
  function tsmom(p, Ls) { const o = new Float64Array(p.length).fill(NaN); const mx = Math.max(...Ls); for (let i = mx; i < p.length; i++) { let k = 0; for (const L of Ls) if (p[i] > p[i - L]) k++; o[i] = k / Ls.length } return o }
  // share of moving averages the price is above (0..1)
  function abovemas(p, Ls) { const M = Ls.map(L => sma(p, L)); const o = new Float64Array(p.length).fill(NaN); for (let i = 0; i < p.length; i++) { let k = 0, ok = true; for (const m of M) { if (isNaN(m[i])) { ok = false; break } if (p[i] > m[i]) k++ } if (ok) o[i] = k / Ls.length } return o }

  function rollMedian(x, n) { const o = new Float64Array(x.length).fill(NaN); for (let i = n; i < x.length; i += 1) { if (i % 7 && i > n) { o[i] = o[i - 1]; continue } const w = []; for (let j = i - n + 1; j <= i; j++) if (!isNaN(x[j])) w.push(x[j]); if (w.length > n / 2) { w.sort((a, b) => a - b); o[i] = w[w.length >> 1] } } return o }
  // ---------- exposure models ----------
  // spec: { trend: {kind:'tsmom'|'sma'|'cross'|'mas', L:[...], fast, slow}, volTarget, volWin, cap, floor, mvrv:{hi, lo, cut}, band }
  function exposure(p, spec, extra = {}) {
    const n = p.length, E = new Float64Array(n).fill(NaN);
    const t = spec.trend || { kind: 'hold' };
    let T;
    if (t.kind === 'hold') T = new Float64Array(n).fill(1);
    else if (t.kind === 'tsmom') T = tsmom(p, t.L);
    else if (t.kind === 'sma') { const m = sma(p, t.L[0]); T = p.map((x, i) => isNaN(m[i]) ? NaN : x > m[i] ? 1 : 0) }
    else if (t.kind === 'mas') T = abovemas(p, t.L);
    else if (t.kind === 'cross') { const f = sma(p, t.fast), s = sma(p, t.slow); T = p.map((x, i) => isNaN(s[i]) ? NaN : f[i] > s[i] ? 1 : 0) }
    else if (t.kind === 'blend') { const a = tsmom(p, t.L), b = abovemas(p, t.L); T = a.map((x, i) => (x + b[i]) / 2) }
    const V = spec.volTarget ? vol(p, spec.volWin || 30) : null;
    const RV = spec.relVol ? rollMedian(vol(p, spec.volWin || 30), 365) : null;
    for (let i = 0; i < n; i++) {
      if (isNaN(T[i])) continue;
      let e = T[i];
      if (spec.step) e = e >= spec.step[0] ? 1 : e >= spec.step[1] ? 0.5 : 0;   // majority up -> fully in
      if (V) { if (isNaN(V[i])) continue; let tv = spec.volTarget; if (spec.relVol) { if (isNaN(RV[i])) continue; tv = RV[i] * spec.relVol } e *= Math.min(spec.cap || 1, tv / Math.max(V[i], 1e-6)) }
      else e *= spec.cap && spec.cap > 1 && T[i] > 0 ? spec.cap : 1;
      if (extra.gate && !(extra.gate[i] >= 0.5)) e = 0;                 // market gate (e.g. Bitcoin's own trend)
      if (spec.mvrv && extra.mvrv) {                       // on-chain valuation overlay (Bitcoin only)
        const m = extra.mvrv[i];
        if (m != null && m > spec.mvrv.hi) e *= spec.mvrv.cut;          // expensive: take some off the table
        if (m != null && m < spec.mvrv.lo) e = Math.max(e, spec.mvrv.floor ?? 0);   // cheap: hold at least this much
      }
      E[i] = Math.min(spec.cap || 1, Math.max(0, e));
    }
    return E;
  }

  // ---------- simulator ----------
  // dates: 'YYYY-MM-DD'[]; opts: { from, to, cost, band, carry: fn(date)->annual, lev: fn(date)->annual, start }
  function simulate(p, dates, E, opts = {}) {
    const cost = opts.cost ?? 0.0015, band = opts.band ?? 0.1, start = opts.start ?? 10000;
    const i0 = dates.findIndex(d => d >= opts.from), i1 = opts.to ? dates.findIndex(d => d >= opts.to) : p.length - 1;
    const end = i1 < 0 ? p.length - 1 : i1;
    let eq = start, w = 0, peak = start, dd = 0, trades = 0, turnover = 0, daysIn = 0, carryEarned = 0, levPaid = 0;
    const curve = [[dates[i0], eq]];
    for (let i = i0; i < end; i++) {
      // decide at close i
      const tgt = isNaN(E[i]) ? 0 : E[i];
      if (Math.abs(tgt - w) >= band || (tgt === 0 && w > 0) || (tgt > 0 && w === 0)) { const dw = Math.abs(tgt - w); eq -= dw * cost * eq; turnover += dw; trades++; w = tgt }
      // hold to close i+1
      const r = p[i + 1] / p[i] - 1, yr = dates[i].slice(0, 7);
      let g = w * r;
      if (opts.carry && w < 1) { const c = Math.max(0, opts.carry(yr) || 0) * (1 - w) / 365; g += c; carryEarned += c * eq }
      if (w > 1) { const lv = (opts.lev ? opts.lev(yr) : 0.1); const c = Math.max(0, lv) * (w - 1) / 365; g -= c; levPaid += c * eq }
      eq *= 1 + g; if (w > 0) daysIn++;
      w = w > 0 ? w * (1 + r) / (1 + g) : 0;                       // exposure drifts with price
      peak = Math.max(peak, eq); dd = Math.max(dd, 1 - eq / peak);
      if (eq <= 0) { eq = 0; break }
      curve.push([dates[i + 1], eq]);
    }
    const yrs = (end - i0) / 365.25;
    return { final: eq, mult: eq / start, cagr: Math.pow(eq / start, 1 / yrs) - 1, dd, trades, turnover, inMarket: daysIn / (end - i0), curve, carryEarned, levPaid };
  }

  const TE = { sma, ema, vol, tsmom, abovemas, exposure, simulate };
  if (typeof module !== 'undefined') module.exports = TE; else root.TE = TE;
})(typeof window !== 'undefined' ? window : globalThis);

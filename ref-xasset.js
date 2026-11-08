// Cross-asset test: daily closes from 4h candles, the locked model on every coin, and a 10-coin basket.
(function (root) {
  const TE = root.TE || require('../src/te');
  // C: { sym: { t:[4h open times sec], c:[], q:[] } } -> calendar days from d0 (sec, UTC midnight)
  function toDaily(C, d0, d1) {
    const n = Math.round((d1 - d0) / 86400) + 1, out = {};
    for (const [s, S] of Object.entries(C)) {
      const p = new Float64Array(n).fill(NaN), v = new Float64Array(n).fill(0);
      for (let i = 0; i < S.t.length; i++) { const k = Math.floor((S.t[i] - d0) / 86400); if (k < 0 || k >= n) continue; p[k] = S.c[i]; v[k] += S.q[i] }
      out[s] = { p, v };
    }
    const dates = Array.from({ length: n }, (_, i) => new Date((d0 + i * 86400) * 1000).toISOString().slice(0, 10));
    return { dates, D: out };
  }
  function filled(p) { const f = p.findIndex(x => !isNaN(x)); if (f < 0) return null; let l = p.length - 1; while (l > f && isNaN(p[l])) l--; const q = Float64Array.from(p); for (let i = f + 1; i <= l; i++) if (isNaN(q[i])) q[i] = q[i - 1]; return { q, f, l } }
  const blend = p => { const x = TE.tsmom(p, [20, 50, 100, 200]), y = TE.abovemas(p, [20, 50, 100, 200]); return x.map((v, i) => (v + y[i]) / 2) };
  // model exposure for one coin, computed from its first trading day and placed back on the calendar
  function expo(F, spec, gate) { const seg = F.q.slice(F.f, F.l + 1), g = gate ? { gate: gate.slice(F.f, F.l + 1) } : {}; const e = TE.exposure(seg, spec, g), out = new Float64Array(F.q.length).fill(NaN); e.forEach((v, i) => out[i + F.f] = v); return out }

  // per-coin: model vs holding the coin vs holding BTC over the same window
  function perCoin(dates, D, spec, { from, to, warm = 250, gate = true }) {
    const B = filled(D.BTCUSDT.p), bT = (() => { const o = new Float64Array(B.q.length).fill(NaN); blend(B.q.slice(B.f, B.l + 1)).forEach((v, i) => o[i + B.f] = v); return o })();
    const iF = dates.indexOf(from), iT = dates.indexOf(to), rows = [];
    for (const [s, d] of Object.entries(D)) {
      const F = filled(d.p); if (!F) continue;
      const a = Math.max(F.f + warm, iF), b = Math.min(F.l, iT); if (b - a < 120) continue;
      const E = expo(F, spec, gate && s !== 'BTCUSDT' ? bT : null);
      const r = TE.simulate(F.q, dates, E, { from: dates[a], to: dates[b], band: spec.band ?? 0.1, cost: spec.cost ?? 0.0015 });
      rows.push({ s, days: b - a, te: r.mult, hold: F.q[b] / F.q[a], btc: B.q[b] / B.q[a], dd: r.dd, holdDD: maxDD(F.q, a, b), delisted: F.l < iT - 2 });
    }
    return rows;
  }
  function maxDD(p, a, b) { let pk = p[a], dd = 0; for (let i = a; i <= b; i++) { pk = Math.max(pk, p[i]); dd = Math.max(dd, 1 - p[i] / pk) } return dd }

  // basket: every 30 days pick the 10 most-traded coins (30-day average volume); equal sleeves, each run by the model
  function basket(dates, D, spec, { from, to, N = 10, every = 30, warm = 250, gate = true, model = true, cost = 0.0015 }) {
    const Bf = filled(D.BTCUSDT.p), bT = (() => { const o = new Float64Array(Bf.q.length).fill(NaN); blend(Bf.q.slice(Bf.f, Bf.l + 1)).forEach((v, i) => o[i + Bf.f] = v); return o })(), EX = {}, PX = {};
    for (const [s, d] of Object.entries(D)) { const F = filled(d.p); if (!F) continue; PX[s] = F; if (model) EX[s] = expo(F, spec, gate && s !== 'BTCUSDT' ? bT : null) }
    const iF = dates.indexOf(from), iT = dates.indexOf(to); let eq = 10000, peak = eq, dd = 0, sleeves = [], W = {}; const curve = [];
    for (let i = iF; i < iT; i++) {
      if ((i - iF) % every === 0) {
        const c = []; for (const [s, F] of Object.entries(PX)) { if (i - F.f < warm || i > F.l) continue; let v = 0; for (let k = i - 29; k <= i; k++) v += D[s].v[k] || 0; c.push([s, v / 30]) }
        c.sort((a, b) => b[1] - a[1]); sleeves = c.slice(0, N).map(x => x[0]);
      }
      // target weights: 1/N of equity per sleeve, times that coin's model exposure
      const tgt = {}; for (const s of sleeves) { const F = PX[s]; if (i > F.l) continue; tgt[s] = (1 / N) * (model ? (isNaN(EX[s][i]) ? 0 : EX[s][i]) : 1) }
      for (const s of new Set([...Object.keys(W), ...Object.keys(tgt)])) { const a = W[s] || 0, b = tgt[s] || 0; if (Math.abs(b - a) >= 0.1 / N || (b === 0 && a > 0) || (a === 0 && b > 0)) { eq -= Math.abs(b - a) * cost * eq; if (b > 0) W[s] = b; else delete W[s] } }
      let g = 0; const R = {}; for (const [s, w] of Object.entries(W)) { const F = PX[s]; const r = i + 1 > F.l ? 0 : F.q[i + 1] / F.q[i] - 1; R[s] = r; g += w * r }
      for (const [s, w] of Object.entries(W)) { W[s] = w * (1 + R[s]) / (1 + g); if (i + 1 > PX[s].l) delete W[s] }
      eq *= 1 + g; peak = Math.max(peak, eq); dd = Math.max(dd, 1 - eq / peak); if ((i - iF) % 7 === 0) curve.push([dates[i + 1], Math.round(eq)]);
    }
    return { final: eq, mult: eq / 10000, dd, curve };
  }
  const XA = { toDaily, perCoin, basket, filled, blend, maxDD };
  if (typeof module !== 'undefined') module.exports = XA; else root.XA = XA;
})(typeof window !== 'undefined' ? window : globalThis);

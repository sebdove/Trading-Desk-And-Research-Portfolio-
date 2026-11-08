// Portfolio backtest built on the same core rules the live bot uses.
(function (root) {
  const ENG = typeof require !== 'undefined' ? require('./engine') : root.ENG;
  const CORE = typeof require !== 'undefined' ? require('./core') : root.CORE;
  const GUARD = typeof require !== 'undefined' ? require('./guard') : root.GUARD;

  const toBars = S => S.t.map((t, i) => ({ time: t, open: S.o[i], high: S.h[i], low: S.l[i], close: S.c[i], volume: S.q[i] }));

  // Model state for one symbol: consensus series s, ATR A, bars (at timeframe tf).
  function prepare(sym, S, tf) {
    const V = ENG.build(toBars(S), tf);
    const b = V.bars, T = { t: b.map(x => x.time), o: b.map(x => x.open), h: b.map(x => x.high), l: b.map(x => x.low), c: b.map(x => x.close), q: b.map(x => x.volume) };
    const at = new Map(T.t.map((t, i) => [t, i]));
    return { sym, S: T, s: V.s, A: V.A, d50: V.d50, bars: b, at, k: -1, last: b.length - 1, stockLike: tf <= 14400 && CORE.stockLike(S) };
  }

  // P.guard: a burst-guard series from GUARD.compute (switch on). P.guardShort: share of the account to short the benchmark while out.
  // P.profitStop 'on': v3a profit stop (CORE.profitStop) with breadth measured on the coins scanned. P.trendRule 'on': 50-day rule.
  // P.universeSize N (crypto): pick only from the N most-traded coins of each day, as the live bot does (CORE.dailyUniverse).
  function backtest(P0, data, bench, tf) {
    const P = { ...CORE.DEFAULTS, start: 10000, from: 0, to: Infinity, ...P0 };
    const M = ENG.MODELS[P.model];
    const U = Object.entries(data).map(([sym, S]) => prepare(sym, S, tf)).filter(u => u.bars.length > 60);
    const uni = P.market === 'crypto' && P.universeSize ? CORE.dailyUniverse(data, P.universeSize, P.minLiq, tf) : null;
    const inUni = uni ? (u, k) => { const s = uni.get(Math.floor(u.bars[k].time / CORE.DAY)); return !!(s && s.has(u.sym)) } : null;
    if (inUni) P.inUniverse = inUni;
    const protect = P.profitStop === 'on';
    const times = [...new Set(U.flatMap(u => u.S.t))].filter(t => t >= P.from && t < P.to).sort((a, b) => a - b);
    let cash = P.start, peak = P.start, dd = 0, hedge = null; const pos = [], trades = [], eqs = [];
    for (const t of times) {
      // P.onBar (optional): money moved in (+) or out (-) at the start of this bar, before any exit or entry; it is told the cash
      // and the last close's value (the half-and-half stock bot moves money between its halves this way, as the live bot does)
      if (P.onBar) { const d = +P.onBar(t, cash, eqs.length ? eqs[eqs.length - 1][1] : P.start) || 0; cash += d; peak += d }
      for (const u of U) u.k = u.at.has(t) ? u.at.get(t) : -1;
      const br = protect ? CORE.breadth(U, inUni ? u => inUni(u, u.k) : null) : null;
      const gOut = P.guard ? GUARD.outAt(P.guard, t + tf) : false;
      // the guard short on the benchmark: stop first, then cover when the guard says back in
      if (hedge && bench) { const j = CORE.idxAtOrBefore(bench.t, t);
        if (j >= 0 && bench.t[j] === t) { let px = null, why = null;
          if (bench.h[j] >= hedge.stop) { px = Math.max(hedge.stop, bench.o[j]); why = 'guard short stop' } else if (!gOut) { px = bench.c[j]; why = 'burst guard: back in' }
          hedge.last = bench.c[j];
          if (px != null) { const hrs = (t - hedge.t0) / 3600, pnl = hedge.qty * (hedge.entry - px) - P.fee * hedge.notional - P.fundPer8h * hedge.notional * hrs / 8;
            cash += hedge.notional + pnl; trades.push({ sym: 'guard short', side: -1, t0: hedge.t0, t1: t, entry: hedge.entry, exit: px, pnl, ret: pnl / hedge.notional, why, guard: true }); hedge = null } } }
      // exits
      for (let p = pos.length - 1; p >= 0; p--) {
        const q = pos[p], u = q.u, k = u.k; if (k < 0) continue;
        const bar = u.bars[k]; let ex = CORE.checkExit(q, bar, u.s[k], M);
        if (!ex && k === u.last && t < times[times.length - 1]) ex = { px: bar.close, why: 'delisted' };
        if (!ex && gOut && q.side > 0) ex = { px: bar.close, why: 'burst guard' };
        if (!ex && protect) CORE.profitStop(q, bar, u.A[k], br);
        if (ex) {
          const hrs = (t - q.t0) / 3600;
          const pnl = q.qty * (ex.px - q.entry) * q.side - P.fee * q.notional - P.fundPer8h * q.notional * hrs / 8 - 2 * q.imp * q.notional;
          cash += q.notional + pnl; trades.push({ sym: u.sym, side: q.side, t0: q.t0, t1: t, entry: q.entry, exit: ex.px, pnl, ret: pnl / q.notional, why: ex.why });
          pos.splice(p, 1);
        }
      }
      // mark to market
      let eq = cash; for (const q of pos) { const k = q.u.k; if (k >= 0) q.last = q.u.bars[k].close; eq += q.notional + q.qty * (q.last - q.entry) * q.side }
      if (hedge) eq += hedge.notional + hedge.qty * (hedge.entry - hedge.last);
      peak = Math.max(peak, eq); dd = Math.max(dd, 1 - eq / peak); eqs.push([t, eq]);
      if (gOut) {                                         // out of the market: no new buys; open the guard short if switched on
        if (P.guardShort && !hedge && bench) { const j = CORE.idxAtOrBefore(bench.t, t);
          if (j >= 0 && bench.t[j] === t) { const st = GUARD.status(P.guard, t + tf), notional = Math.min(cash, eq * P.guardShort);
            if (notional > 1) { cash -= notional; hedge = { entry: bench.c[j], qty: notional / bench.c[j], notional, stop: bench.c[j] * Math.exp(2 * st.volUnit), t0: t, last: bench.c[j] } } } }
        continue;
      }
      if (pos.length >= P.slots) continue;
      // entries
      const live = U.filter(u => u.k >= 0);
      const held = new Set(pos.map(q => q.u.sym));
      for (const c of CORE.candidates(P, M, live, bench, held)) {
        if (pos.length >= P.slots) break;
        const u = live.find(x => x.sym === c.sym), k = c.k, bar = u.bars[k];
        const stopPct = M.stopK * u.A[k] / bar.close;
        const notional = CORE.sizePosition({ equity: eq, cash, slots: P.slots, risk: P.risk, stopPct, liq: c.f.liq, maxPart: P.maxPart });
        if (notional < (P.minOrder || 1)) continue;
        cash -= notional;
        pos.push({ u, side: c.side, entry: bar.close, qty: notional / bar.close, notional, stop: bar.close - c.side * M.stopK * u.A[k], risk: M.stopK * u.A[k], best: bar.close, t0: t, last: bar.close, imp: CORE.impact(notional, c.f.liq, P.impK) });
      }
    }
    return { final: eqs.length ? eqs[eqs.length - 1][1] : P.start, dd, trades, eqs, cash, open: pos.map(q => ({ sym: q.u.sym, side: q.side, entry: q.entry, stop: q.stop })),
      held: pos.map(q => ({ sym: q.u.sym, side: q.side, entry: q.entry, stop: q.stop, stopWhy: q.stopWhy, qty: q.qty, notional: q.notional, imp: q.imp, t0: q.t0, last: q.last, risk: q.risk, best: q.best })) };
  }

  const BT = { backtest, prepare, toBars };
  if (typeof module !== 'undefined') module.exports = BT; else root.BT = BT;
})(typeof window !== 'undefined' ? window : globalThis);

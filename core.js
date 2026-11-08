// Shared trading rules. The backtest and the live bot both call these functions,
// so what runs live is exactly what was tested. Plain JS: works in Node and in a browser.
(function (root) {
  const DAY = 86400;

  // Last index with times[i] <= t (or -1).
  function idxAtOrBefore(times, t) {
    let lo = 0, hi = times.length - 1, ans = -1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (times[m] <= t) { ans = m; lo = m + 1 } else hi = m - 1 }
    return ans;
  }

  // Series = { t:[sec], o,h,l,c:[price], q:[quote volume, i.e. value traded] }
  function prefix(series) {
    if (series._pq) return series._pq;
    const n = series.t.length, p = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) p[i + 1] = p[i] + (series.q[i] || 0);
    return (series._pq = p);
  }
  const sumQ = (series, a, b) => { const p = prefix(series); return p[b + 1] - p[a + 1] }; // sum over (a, b]

  // Features known at the close of bar k (calendar-day windows so the same code works for 4H crypto and daily stocks).
  function features(S, k, B) {
    const t = S.t[k];
    const k30 = idxAtOrBefore(S.t, t - 30 * DAY), k7 = idxAtOrBefore(S.t, t - 7 * DAY), k97 = idxAtOrBefore(S.t, t - 97 * DAY);
    if (k30 < 0 || k7 < 0) return null;
    const mom30 = S.c[k] / S.c[k30] - 1, mom7 = S.c[k] / S.c[k7] - 1;
    let bm30 = 0, bAbove = null;
    if (B) {
      const bk = idxAtOrBefore(B.t, t), bk30 = idxAtOrBefore(B.t, t - 30 * DAY);
      if (bk >= 0 && bk30 >= 0) bm30 = B.c[bk] / B.c[bk30] - 1;
      bAbove = benchAbove(B, t);
    }
    const days = (a, b) => Math.max(1, (S.t[b] - (a >= 0 ? S.t[a] : S.t[0] - DAY)) / DAY);
    const recent = sumQ(S, k7, k) / days(k7, k);
    const prior = k97 >= 0 ? sumQ(S, k97, k7) / days(k97, k7) : NaN;
    return {
      mom30, mom7, rs30: mom30 - bm30,
      surge: prior > 0 ? recent / prior : 1,
      liq: sumQ(S, k30, k) / days(k30, k),          // average value traded per day, last 30 days
      age: (t - S.t[0]) / DAY, benchAbove: bAbove,
    };
  }

  // Benchmark (BTC or SPY) above its 200-day average at the close of the bar that opened at t?
  // Uses the latest benchmark close known then (the bar opening at t closes with the coin's bar) and the 199 complete days before it.
  // Before 1.9.0 the backtest used that day's final close, up to 20 hours early; the live bot never could. Live results are unchanged.
  function benchDaily(B) {
    if (!B._daily) {                                  // one close per UTC day, plus running sums for the averages
      const dt = [], dc = [];
      for (let i = 0; i < B.t.length; i++) { const d = Math.floor(B.t[i] / DAY); if (dt.length && dt[dt.length - 1] === d) dc[dc.length - 1] = B.c[i]; else { dt.push(d); dc.push(B.c[i]) } }
      const pre = new Float64Array(dc.length + 1); for (let i = 0; i < dc.length; i++) pre[i + 1] = pre[i] + dc[i];
      B._daily = { dt, dc, pre, pos: new Map(dt.map((d, i) => [d, i])) };
    }
    return B._daily;
  }
  // Bitcoin 50-day rule (desk portfolio): yesterday's Bitcoin close above its 50-day average (complete days only).
  function benchAbove50(B, t) {
    const D = benchDaily(B), jd = D.pos.get(Math.floor(t / DAY)); if (jd == null) return true;
    const j = jd - 1; if (j < 0) return true; if (j < 49) return false;
    return D.dc[j] > (D.pre[j + 1] - D.pre[j - 49]) / 50;
  }
  function benchAbove(B, t) {
    const D = benchDaily(B), bi = idxAtOrBefore(B.t, t); if (bi < 0) return null;
    const px = B.c[bi], day = Math.floor(B.t[bi] / DAY);
    let lo = 0, hi = D.dt.length - 1, j = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (D.dt[m] <= day) { j = m; lo = m + 1 } else hi = m - 1 }
    if (j < 199) return null;
    return px > (D.pre[j] - D.pre[j - 199] + px) / 200;
  }

  // Coins the crypto bot never trades: stablecoins, wrapped coins, gold tokens and leveraged tokens.
  const STABLE = /^(USDC|FDUSD|TUSD|BUSD|DAI|USDP|EUR|AEUR|PAXG|WBTC|USD1|EURI|XUSD|RLUSD|BFUSD|USDE|USDS|PYUSD|EURC|USTC|UST|SUSD|GUSD|LUSD|FRAX)USDT$/;
  const LEVERAGED = /(UP|DOWN|BULL|BEAR)USDT$/;

  // The coins the live bot scans each day: the N most traded over the 24 hours before 00:00 UTC, $minVol+ a day,
  // no stablecoins or leveraged tokens. Used by the backtest so it picks from the same list the bot sees. Returns day -> Set.
  function dailyUniverse(data, N = 120, minVol = 2e6, tf = 14400) {
    const days = new Map();
    for (const [sym, S] of Object.entries(data)) {
      if (STABLE.test(sym) || LEVERAGED.test(sym)) continue;
      let v = 0, j0 = 0;
      for (let k = 0; k < S.t.length; k++) {
        v += S.q[k] || 0; while (S.t[j0] <= S.t[k] - DAY) { v -= S.q[j0] || 0; j0++ }
        const end = S.t[k] + tf; if (end % DAY !== 0) continue;           // a bar closing at 00:00 UTC
        const d = end / DAY; let a = days.get(d); if (!a) days.set(d, a = []); if (v >= minVol) a.push([sym, v]);
      }
    }
    const sets = new Map(); for (const [d, a] of days) { a.sort((x, y) => y[1] - x[1]); sets.set(d, new Set(a.slice(0, N).map(x => x[0]))) }
    return sets;
  }

  // Tokenized stocks and ETFs on Binance spot follow the stock market: over weekends they barely move and hardly trade.
  // True when, over the last 90 days of 4-hour candles, weekend volume is under 35% of weekday volume and weekend moves
  // under half of weekday moves (crypto coins: about 60-90% on both). Needs at least 8 weekends of candles.
  function stockLike(S) {
    const n = S.t.length, a = Math.max(1, n - 540); let we = 0, wd = 0, mwe = 0, mwd = 0, nwe = 0, nwd = 0;
    for (let i = a; i < n; i++) { const dow = new Date(S.t[i] * 1000).getUTCDay(), r = Math.abs(S.c[i] / S.c[i - 1] - 1);
      if (dow === 0 || dow === 6) { we += S.q[i]; mwe += r; nwe++ } else { wd += S.q[i]; mwd += r; nwd++ } }
    if (nwe < 8 * 12 || !nwd || !wd || !mwd) return false;
    return (we / nwe) / (wd / nwd) < 0.35 && (mwe / nwe) / (mwd / nwd) < 0.5;
  }

  // Market breadth: the share of coins above their 50-day average (coins with 200+ bars of history), or null with fewer than 20.
  function breadth(U, use = null) {
    let up = 0, n = 0;
    for (const u of U) if (u.k >= 200 && (!use || use(u))) { n++; if (u.bars[u.k].close > u.d50[u.k]) up++ }
    return n >= 20 ? up / n : null;
  }

  // v3a profit stop. After a bar with no exit: remember the best close since buying; then, while breadth is below
  // `below` and the best close is `after` times the trade's risk above the entry, raise the stop to k ATR under that best close.
  // Returns the new stop when it moved up, else null. pos needs { side, entry, risk, stop, best }.
  const PROFIT_STOP = { k: 3, after: 2, below: 0.35 };
  function profitStop(pos, bar, atr, br, R = PROFIT_STOP) {
    const sd = pos.side;
    if (pos.best == null || (bar.close - pos.best) * sd > 0) pos.best = bar.close;
    if (br == null || !(br < R.below) || !(pos.risk > 0) || !atr) return null;
    if ((pos.best - pos.entry) * sd / pos.risk < R.after) return null;
    const t = pos.best - sd * R.k * atr;
    if ((t - pos.stop) * sd > 0) { pos.stop = t; pos.stopWhy = 'profit stop'; return t }
    return null;
  }

  // Ranking used when more coins/stocks signal than there are free slots: laggard vs benchmark + quiet volume.
  // Crypto (tested 2020-25): 'laggard-quiet' = lagging the benchmark over 30 days + no volume spike.
  // Stocks (tested 2020-25): 'liquid' = the most-traded companies first.
  function rankScore(f, side, mode = 'laggard-quiet') {
    if (mode === 'liquid') return f.liq;
    if (mode === 'leaders') return f.rs30 * side;
    return -f.rs30 * side / 0.15 - Math.log(Math.max(f.surge, 1e-3)) / 0.5;
  }

  function entrySide(sNow, sPrev, M) {
    let sd = sNow >= M.entry && (M.reentry || sPrev < M.entry) ? 1 : sNow <= -M.entry && (M.reentry || sPrev > -M.entry) ? -1 : 0;
    if (sd < 0 && M.longOnly) sd = 0;
    return sd;
  }

  // Exit check on a closed bar: stop first (filled at stop, or the open if it gapped through), then consensus exit.
  function checkExit(pos, bar, sNow, M) {
    const sd = pos.side;
    if (((sd > 0 ? bar.low : bar.high) - pos.stop) * sd <= 0) return { px: sd > 0 ? Math.min(pos.stop, bar.open) : Math.max(pos.stop, bar.open), why: pos.stopWhy || 'stop' };
    if (sNow * sd < M.exit) return { px: bar.close, why: 'exit' };
    return null;
  }

  // Position size in money: risk-based, capped by slot share, available cash and a share of daily volume.
  function sizePosition({ equity, cash, slots, risk, stopPct, liq, maxPart }) {
    let n = Math.min(cash, equity / slots, risk ? equity * risk / stopPct : Infinity);
    if (maxPart && isFinite(liq)) n = Math.min(n, maxPart * liq);
    return Math.max(0, n);
  }

  // Price impact estimate (square-root rule) as a fraction of the order, charged on entry and on exit.
  const impact = (notional, liq, k) => k ? k * Math.sqrt(notional / Math.max(liq, 1)) : 0;

  // Candidates at bar index map: returns sorted [{sym, side, k, f, score}]
  function candidates(P, M, universe, B, held) {
    const out = [];
    for (const u of universe) {
      if (held.has(u.sym)) continue;
      const k = u.k; if (k < 1 || !u.A[k]) continue;
      const sd = entrySide(u.s[k], u.s[k - 1], M); if (!sd) continue;
      const f = features(u.S, k, B); if (!f) continue;
      if (P.regime && f.benchAbove != null) { if (P.regime === 1 && M.longOnly && !f.benchAbove) continue; if (P.regime === 2 && (sd > 0) !== f.benchAbove) continue }
      if (P.regime === 1 && M.longOnly && f.benchAbove == null) continue;
      if (f.age < (P.minAgeDays || 0) || f.liq < (P.minLiq || 0)) continue;
      if (P.trendRule === 'on' && sd > 0 && !(u.bars[k].close > u.d50[k])) continue;      // 50-day rule: only buy coins above their 50-day average
      if (P.inUniverse && !P.inUniverse(u, k)) continue;
      if (u.stockLike) continue;
      if (P.btcTrend50 === 'on' && sd > 0 && B && !benchAbove50(B, u.bars[k].time)) continue;     // Bitcoin 50-day rule                                                              // tokenized stocks: not crypto                                      // backtest only: the coins the bot would scan that day
      out.push({ sym: u.sym, side: sd, k, f, score: rankScore(f, sd, P.rank) });
    }
    return out.sort((a, b) => b.score - a.score);
  }

  const DEFAULTS = { model: 'v3', rank: 'laggard-quiet', slots: 3, risk: 0.01, regime: 1, minLiq: 2e6, maxPart: 0.01, fee: 0.001, fundPer8h: 0, impK: 0.05, minAgeDays: 0 };
  // Tested presets. risk 0 = each slot gets an equal share of the account.
  // Crypto since 1.9.0: v3 entries + the 50-day rule, v3 exits + the profit stop (v3a). See the Crypto Bot 2026 Review.
  const PRESETS = {
    crypto: { market: 'crypto', tf: 14400, model: 'v3', rank: 'laggard-quiet', slots: 3, risk: 0.01, regime: 1, minLiq: 2e6, maxPart: 0.01, fee: 0.001, impK: 0.05, profitStop: 'on', trendRule: 'on', universeSize: 120 },
    trend: { market: 'trend', tf: 86400, coins: 'btc', slots: 1 },
    momentum: { market: 'momentum', tf: 86400, slots: 20 },          // long/short momentum on futures, paper only (see src/momentum.js)   // Trend Engine: daily, spot only (see src/trend.js)
    stocks: { market: 'stocks', tf: 86400, model: 'v3', rank: 'liquid', stockSlots: 5, slots: 5, risk: 0, regime: 0, minLiq: 2e6, maxPart: 0.01, fee: 0.0005, impK: 0.05 },
  };

  // Stock model only: hold 4, 5 or 6 stocks at once (the range that tested best, 2020-25).
  const STOCK_SLOT_CHOICES = [4, 5, 6];
  function applyStockSlots(cfg, override) {
    const v = override != null ? Number(override) : cfg.stockSlots;
    if (cfg.market !== 'stocks') {
      if (v != null) throw new Error('stockSlots only applies to the stock model (market "stocks"); the crypto model keeps its own slots setting');
      return cfg;
    }
    if (v == null) return { ...cfg, stockSlots: 5, slots: 5 };
    if (!STOCK_SLOT_CHOICES.includes(v)) throw new Error(`stockSlots must be 4, 5 or 6 (got ${v})`);
    return { ...cfg, stockSlots: v, slots: v };
  }

  const CORE = { DAY, idxAtOrBefore, features, benchAbove, benchAbove50, stockLike, STABLE, LEVERAGED, dailyUniverse, breadth, PROFIT_STOP, profitStop, rankScore, entrySide, checkExit, sizePosition, impact, candidates, DEFAULTS, PRESETS, STOCK_SLOT_CHOICES, applyStockSlots };
  if (typeof module !== 'undefined') module.exports = CORE; else root.CORE = CORE;
})(typeof window !== 'undefined' ? window : globalThis);

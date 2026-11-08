// Momentum bot (paper only): long/short momentum on Binance USDT perpetual futures, one decision a day after 00:00 UTC.
// Every 7 days (on the same weekly schedule as the test, counted from 1 Jan 2020): among the 100 most traded coins
// (30-day average, $2M+ a day, 60+ days of history, no stablecoins), buy the 10 that rose most over 30 days and short the 10
// that fell most, half the account each side, equal amounts. Between re-balances positions ride; funding is paid on longs
// and received on shorts; 0.1% cost on every dollar traded.
// Tested 2020 to Nov 2026 from $10,000 (settings chosen on 2020-23): $175,895, worst drop 39%; 2024 +8%, 2025 +185%, 2026 +67%;
// 2022 -22%. See "New Models Tested". It has never traded real money: this bot only runs on paper.
'use strict';
const DAY = 86400;
const RULE = { lookback: 30, perSide: 10, every: 7, top: 100, minAge: 60, minAvg: 2e6, cost: 0.001, anchor: Date.UTC(2020, 0, 1) / 1000 / DAY };
const TESTED = { from: '2020-01-01', final: 175895, dd: 39.1, years: { 2020: 62, 2021: 125.1, 2022: -22.4, 2023: 20.8, 2024: 8.4, 2025: 184.6, 2026: 66.8 } };
const STABLE = /^(USDC|FDUSD|TUSD|BUSD|DAI|USDP|EUR|AEUR|PAXG|WBTC|USD1|EURI|XUSD|RLUSD|BFUSD|USDE|USDS|PYUSD|EURC|USTC|UST|SUSD|GUSD|LUSD|FRAX|XAUT)USDT$/;

// Panel: per coin { day -> close } (gaps inside a coin's life carry the previous close), day -> value traded, day -> funding sum.
class Panel {
  constructor() { this.c = new Map(); this.q = new Map(); this.f = new Map(); this.first = new Map(); this.last = new Map() }
  // S: { d: [day numbers], c: [closes], q: [value traded] } ascending; fills gaps inside the coin's life
  addCoin(sym, S) {
    const c = new Map(), q = new Map(); let prev = null;
    for (let i = 0; i < S.d.length; i++) { if (prev != null) for (let g = prev + 1; g < S.d[i]; g++) { c.set(g, c.get(prev)); q.set(g, 0) } c.set(S.d[i], S.c[i]); q.set(S.d[i], S.q[i]); prev = S.d[i] }
    this.c.set(sym, c); this.q.set(sym, q); if (S.d.length) { this.first.set(sym, S.d[0]); this.last.set(sym, S.d[S.d.length - 1]) }
  }
  setFunding(sym, byDay) { this.f.set(sym, byDay) }
  close(sym, d) { const c = this.c.get(sym); return c ? c.get(d) : undefined }
  funding(sym, d) { const f = this.f.get(sym); return (f && f.get(d)) || 0 }
  age(sym, d) { const a = this.first.get(sym); return a == null || d < a ? 0 : Math.min(d, this.last.get(sym)) - a + 1 }
  avg(sym, d) { const q = this.q.get(sym); let s = 0; for (let i = d - 29; i <= d; i++) s += (q && q.get(i)) || 0; return s / 30 }
  syms() { return [...this.c.keys()] }
}
// the coin list and target weights for day d (decided at that day's close)
function universe(P, d, R = RULE) {
  return P.syms().filter(s => !STABLE.test(s) && P.close(s, d) != null && P.age(s, d) >= R.minAge && P.avg(s, d) > R.minAvg).sort((a, b) => P.avg(b, d) - P.avg(a, d)).slice(0, R.top);
}
function target(P, d, R = RULE) {
  const sc = universe(P, d, R).map(s => { const a = P.close(s, d - R.lookback), b = P.close(s, d); return [s, a > 0 && b != null ? b / a - 1 : NaN] }).filter(x => Number.isFinite(x[1])).sort((a, b) => b[1] - a[1]);
  const longs = sc.filter(x => x[1] > 0).slice(0, R.perSide), shorts = sc.filter(x => x[1] < 0).slice(-R.perSide), W = {};
  for (const [s] of longs) W[s] = 0.5 / longs.length; for (const [s] of shorts) W[s] = -0.5 / shorts.length;
  return { weights: W, scores: Object.fromEntries(sc.map(([s, r]) => [s, r])) };
}
const isRebalanceDay = (d, R = RULE) => (((d - R.anchor) % R.every) + R.every) % R.every === 0;
// decide: at day d's close, on a re-balance day, move every position to its target (costs on money traded)
function decide(st, P, d, R = RULE) {
  const ev = { day: d, trades: [], costs: 0, rebalance: false }; if (!isRebalanceDay(d, R)) return ev;
  const T = target(P, d, R), W = T.weights; ev.rebalance = true; ev.scores = T.scores;
  for (const s of new Set([...Object.keys(st.pos), ...Object.keys(W)])) {
    const want = (W[s] || 0) * st.equity, have = st.pos[s] || 0, c = Math.abs(want - have) * R.cost;
    st.equity -= c; ev.costs += c; if (Math.abs(want - have) > 1e-9) ev.trades.push({ sym: s, from: have, to: want, price: P.close(s, d), cost: c });
    if (want) st.pos[s] = want; else delete st.pos[s];
  }
  return ev;
}
// carry: from day d's close to day d+1's close (price moves and funding); a coin with no d+1 price is closed out
function carry(st, P, d, R = RULE) {
  const ev = { day: d + 1, pnl: {}, closed: [] };
  for (const [s, n] of Object.entries(st.pos)) {
    const a = P.close(s, d), b = P.close(s, d + 1), r = a > 0 && b != null ? b / a - 1 : NaN;
    if (!Number.isFinite(r)) { const c = Math.abs(n) * R.cost; st.equity -= c; ev.closed.push({ sym: s, from: n, price: a, cost: c }); delete st.pos[s]; continue }
    const g = n * r - n * P.funding(s, d + 1); st.equity += g; ev.pnl[s] = g; st.pos[s] = n * (1 + r);
  }
  return ev;
}
// research / backtest: from day a to day z on a panel (funding attached); the account value at each day's close
function backtest(P, a, z, start = 1, R = RULE) {
  const st = { equity: start, pos: {} }, eqs = []; let pk = start, dd = 0;
  for (let d = a; d < z; d++) { decide(st, P, d, R); carry(st, P, d, R); pk = Math.max(pk, st.equity); dd = Math.max(dd, 1 - st.equity / pk); eqs.push([(d + 1) * DAY, st.equity]) }
  return { final: st.equity, dd, eqs, pos: st.pos };
}

// ---------- live data: Binance USDT perpetual futures (public market data, no key needed) ----------
const FAPI = 'https://fapi.binance.com';
class MomentumFeed {
  // cacheDir: downloaded candles and funding are kept there (gzip) and only topped up, so a reset replays the same data
  constructor(client, { candidates = 160, exclude = [], cacheDir = null } = {}) { Object.assign(this, { client, candidates, exclude }); this.cache = cacheDir ? require('./history').cacheIO(cacheDir) : null }
  async daily(sym, from) {
    const c = this.cache, old = c && c.read('d_' + sym), y = Math.floor(Date.now() / 1000 / DAY) - 1;
    if (old && old.d.length && old.d[0] <= from) {
      if (old.d[old.d.length - 1] < y) { const add = await this.dailyRaw(sym, old.d[old.d.length - 1] + 1); if (add.d.length) { for (const k of ['d', 'c', 'q']) old[k] = old[k].concat(add[k]); c.write('d_' + sym, old) } }
      const i = old.d.findIndex(d => d >= from); return i < 0 ? { d: [], c: [], q: [] } : { d: old.d.slice(i), c: old.c.slice(i), q: old.q.slice(i) };
    }
    const S = await this.dailyRaw(sym, from); if (c && S.d.length) c.write('d_' + sym, S); return S;
  }
  async funding(sym, fromDay, toDay) {
    const c = this.cache, z = (toDay + 1) * DAY * 1000; let F = c && c.read('f_' + sym);
    if (F && F.from <= fromDay) { if (F.last < z) { const add = await this.fundingRaw(sym, F.last + 1, z); if (add.length) { F.x = F.x.concat(add); F.last = add[add.length - 1][0]; c.write('f_' + sym, F) } } }
    else { const x = await this.fundingRaw(sym, fromDay * DAY * 1000 + 1, z); F = { from: fromDay, last: x.length ? x[x.length - 1][0] : fromDay * DAY * 1000, x }; if (c) c.write('f_' + sym, F) }
    const m = new Map(), a = fromDay * DAY * 1000;
    for (const [t, r] of F.x) if (t > a && t <= z) { const d = Math.floor((t / 1000 - 1) / DAY); m.set(d, (m.get(d) || 0) + r) }
    return m;
  }
  // most traded perpetuals now (a wide net: the bot then ranks them by their own 30-day average, as tested)
  async coins() {
    const [info, tick] = [await this.client.req(FAPI, '/fapi/v1/exchangeInfo'), await this.client.req(FAPI, '/fapi/v1/ticker/24hr')];
    const ok = new Set(info.symbols.filter(s => s.status === 'TRADING' && s.contractType === 'PERPETUAL' && s.quoteAsset === 'USDT').map(s => s.symbol));
    return tick.filter(t => ok.has(t.symbol) && !STABLE.test(t.symbol) && !this.exclude.includes(t.symbol)).sort((a, b) => +b.quoteVolume - +a.quoteVolume).slice(0, this.candidates).map(t => t.symbol);
  }
  // closed daily candles from day `from` on
  async dailyRaw(sym, from) {
    const S = { d: [], c: [], q: [] }, now = Date.now(); let start = from * DAY * 1000;
    for (;;) { const lim = Math.min(1000, Math.max(10, Math.ceil((now - start) / 864e5) + 2));          // under 100 candles costs 1 weight, 1000 costs 5
      const k = await this.client.req(FAPI, '/fapi/v1/klines', { params: { symbol: sym, interval: '1d', startTime: start, limit: lim } });
      for (const x of k) { if (x[6] >= now) continue; S.d.push(Math.floor(x[0] / 1000 / DAY)); S.c.push(+x[4]); S.q.push(+x[7]) }
      if (k.length < lim) break; start = k[k.length - 1][0] + 1 }
    return S;
  }
  // funding settled in each day (a rate settled at 00:00 counts for the day that just ended, as tested)
  async fundingRaw(sym, startMs, endMs) {                                 // [[fundingTime ms, rate], ...]
    const out = []; let start = startMs;
    for (;;) { const r = await this.client.req(FAPI, '/fapi/v1/fundingRate', { params: { symbol: sym, startTime: start, endTime: endMs, limit: 1000 } });
      for (const x of r) out.push([x.fundingTime, +x.fundingRate]);
      if (r.length < 1000) break; start = r[r.length - 1].fundingTime + 1 }
    return out;
  }
}

// The paper account. state.day = the day whose close the account value refers to; state.decided = that day's re-balance done.
class MomentumBot {
  constructor(cfg, { feed, store, log = console.log, notify = async () => {} }) {
    Object.assign(this, { cfg, feed, store, log, notify });
    const s = store.load() || {};
    this.state = { equity: s.equity ?? (cfg.startCash || 10000), pos: s.pos || {}, open: s.open || {}, day: s.day ?? null, decided: !!s.decided, peak: s.peak ?? null,
      trades: s.trades || [], rebalances: s.rebalances || [], lastTransferId: s.lastTransferId, transfers: s.transfers || [], meta: s.meta || {} };
    this.broker = { name: 'paper' };
  }
  save() { const st = this.state; this.store.save({ ...st, lastEquity: st.equity, lastBar: st.day != null ? st.day * DAY : null, positions: this.positionsView() }) }
  positionsView() { const st = this.state, o = {}; for (const [s, n] of Object.entries(st.pos)) { const e = st.open[s] || {}; o[s] = { side: n > 0 ? 1 : -1, notional: Math.abs(n), entry: e.price, t0: e.t0, lastPrice: e.last, score: e.score, pnl: e.pnl } } return o }
  // desk portfolio (paper): money in or out, keeping each position's share of the account
  applyTransfer() {
    const f = this.cfg.transferFile; if (!f) return; let n; try { n = JSON.parse(require('fs').readFileSync(f, 'utf8')) } catch { return }
    const st = this.state; if (!n || !n.id || n.id === st.lastTransferId || !isFinite(n.amount)) return;
    const k = st.equity > 0 ? (st.equity + n.amount) / st.equity : 1; st.equity += n.amount; for (const s of Object.keys(st.pos)) st.pos[s] *= k;
    if (st.peak != null) st.peak += n.amount; st.lastTransferId = n.id; st.transfers = [...st.transfers, { id: n.id, t: Math.floor(Date.now() / 1000), amount: n.amount }].slice(-60);
    this.log(`DESK PORTFOLIO: quarterly re-split ${n.amount >= 0 ? 'in' : 'out'} $${Math.abs(n.amount).toFixed(2)}`);
  }
  // bring the account up to the last closed day. startDay: for a new account, the first day to decide on (head start)
  async cycle({ startDay = null } = {}) {
    const st = this.state, lastClosed = Math.floor(Date.now() / 1000 / DAY) - 1;
    if (!this.replay) this.applyTransfer();
    if (st.day == null) { st.day = startDay ?? lastClosed; st.decided = false }
    if (st.day >= lastClosed && st.decided) { this.log('nothing new: the last daily candle is already processed'); return false }
    const P = new Panel(), coins = new Set([...(await this.feed.coins()), ...Object.keys(st.pos)]), from = st.day - RULE.minAge - RULE.lookback - 5;
    this.log(`loading daily candles for ${coins.size} perpetual futures…`);
    for (const s of coins) { try { const S = await this.feed.daily(s, from); if (S.d.length) P.addCoin(s, S) } catch (e) { if (/rate limit/.test(e.message)) throw e; this.log(`skip ${s}: ${e.message}`) } }
    const have = new Set(), fund = async syms => { for (const s of syms) if (!have.has(s)) { have.add(s); try { P.setFunding(s, await this.feed.funding(s, st.day, lastClosed + 1)) } catch (e) { if (/rate limit/.test(e.message)) throw e } } };
    while (true) {
      if (!st.decided) { const ev = decide(st, P, st.day); st.decided = true; if (ev.rebalance) this.onRebalance(ev) }
      if (st.day >= lastClosed) break;
      await fund(Object.keys(st.pos)); const ev = carry(st, P, st.day); st.day++; st.decided = false;
      for (const [s, g] of Object.entries(ev.pnl)) { const o = st.open[s]; if (o) { o.pnl = (o.pnl || 0) + g; o.last = P.close(s, st.day) } }
      for (const c of ev.closed) { this.closeTrade(c.sym, st.day * DAY, c.price, 'no longer listed', c.cost); this.log(`${c.sym}: no longer listed, position closed`) }
      st.peak = Math.max(st.peak ?? st.equity, st.equity);
      if (this.store.appendEquity) this.store.appendEquity(st.day * DAY, st.equity);
    }
    const nd = st.day + 1 + (((RULE.anchor - st.day - 1) % RULE.every) + RULE.every) % RULE.every;
    st.meta = { ...st.meta, nextRebalance: nd * DAY, longs: Object.values(st.pos).filter(n => n > 0).length, shorts: Object.values(st.pos).filter(n => n < 0).length };
    this.save(); return true;
  }
  closeTrade(sym, t1, price, why, cost = 0) {
    const st = this.state, o = st.open[sym] || {};
    st.trades.push({ sym, side: o.side, t0: o.t0, t1, entry: o.price, exit: price, pnl: (o.pnl || 0) - (o.cost || 0) - cost, why, ...(this.replay ? { hist: true } : {}) });
    st.trades = st.trades.slice(-3000); delete st.open[sym];
  }
  onRebalance(ev) {
    const st = this.state, t = (ev.day + 1) * DAY;
    for (const x of ev.trades) {
      const was = Math.sign(x.from), now = Math.sign(x.to);
      if (was && now !== was) this.closeTrade(x.sym, ev.day * DAY + DAY, x.price, 'weekly re-balance', x.cost);
      else if (was && now === was && st.open[x.sym]) st.open[x.sym].cost = (st.open[x.sym].cost || 0) + x.cost;     // resized
      if (now && now !== was) st.open[x.sym] = { side: now, price: x.price, t0: t, score: ev.scores[x.sym], pnl: 0, cost: x.cost, last: x.price };
    }
    const L = Object.keys(st.pos).filter(s => st.pos[s] > 0), S = Object.keys(st.pos).filter(s => st.pos[s] < 0), nm = s => s.replace(/USDT$/, '');
    st.rebalances = [...st.rebalances, { day: ev.day, t, equity: +st.equity.toFixed(2), longs: L, shorts: S, costs: +ev.costs.toFixed(2), ...(this.replay ? { hist: true } : {}) }].slice(-500);
    this.log(`RE-BALANCE ${new Date(t * 1000).toISOString().slice(0, 10)} · long ${L.map(nm).join(', ') || 'none'} · short ${S.map(nm).join(', ') || 'none'} · account $${st.equity.toFixed(2)}`);
  }
}
module.exports = { RULE, TESTED, STABLE, Panel, universe, target, isRebalanceDay, decide, carry, backtest, MomentumFeed, MomentumBot, DAY };

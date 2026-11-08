// Trend bot: the Trend Engine run live, once a day after the daily close (00:00 UTC).
// Spot only, never leveraged. Bitcoin only, or a basket of the 10 most-traded coins (each a tenth of the money,
// altcoins only while Bitcoin itself is trending up). Same decision rule as the tested backtest:
//   target share = trend votes (8) x volatility scale (aim for 80% a year), rebalance when it moves by a tenth of a slot.
const TE = require('./te');
const GUARD = require('./guard');
const crypto = require('crypto');

const DAY = 86400;
const SPEC = { trend: { kind: 'blend', L: [20, 50, 100, 200] }, volTarget: 0.8, volWin: 30, cap: 1 };
const LOOKS = [20, 50, 100, 200];
const STABLE = /^(USDC|FDUSD|TUSD|BUSD|DAI|USDP|EUR|AEUR|PAXG|WBTC|USD1|EURI|XUSD|RLUSD|BFUSD)USDT$/;
const LEVERAGED = /(UP|DOWN|BULL|BEAR)USDT$/;
const COINS = { btc: { N: 1, label: 'Bitcoin only' }, basket10: { N: 10, label: '10 most-traded coins' } };
const DEFAULTS = { coins: 'btc', band: 0.1, cost: 0.0015, every: 30, warm: 250, minBars: 201, staleDays: 3 };

// Eight yes/no trend questions for the latest day, the trend score (0..1), volatility and the model's target share.
function analyse(closes) {
  const p = Float64Array.from(closes), n = p.length, i = n - 1;
  if (n < 201) return null;
  const votes = [];
  for (const L of LOOKS) { const m = TE.sma(p, L)[i]; votes.push({ q: `above ${L}-day average`, yes: p[i] > m, v: m }) }
  for (const L of LOOKS) votes.push({ q: `higher than ${L} days ago`, yes: p[i] > p[i - L], v: p[i - L] });
  const E = TE.exposure(p, SPEC), V = TE.vol(p, SPEC.volWin);
  const score = votes.filter(x => x.yes).length / votes.length;
  return { votes, score, vol: V[i], scale: Math.min(1, SPEC.volTarget / Math.max(V[i], 1e-6)), exposure: isNaN(E[i]) ? 0 : E[i] };
}
// Full daily series of the model's share (for the dashboard chart), optionally with the Bitcoin gate applied by date.
function exposureSeries(S, gateByTime) {
  const E = TE.exposure(Float64Array.from(S.c), SPEC);
  return S.t.map((t, i) => { let e = isNaN(E[i]) ? 0 : E[i]; if (gateByTime && !(gateByTime.get(t) >= 0.5)) e = 0; return e });
}
function trendScores(S) { const p = Float64Array.from(S.c), a = TE.tsmom(p, LOOKS), b = TE.abovemas(p, LOOKS); return S.t.map((_, i) => (a[i] + b[i]) / 2) }

// ---------------- market data: Binance spot daily candles (closed days only) ----------------
class TrendFeed {
  constructor(client, { coins = 'btc', bars = 400, candidates = 40, exclude = [] } = {}) { Object.assign(this, { client, coins, bars, candidates, exclude }); this.cand = null; this.candAt = 0 }
  async daily(sym) {
    const k = await this.client.req(this.client.dataBase, '/api/v3/klines', { params: { symbol: sym, interval: '1d', limit: sym === 'BTCUSDT' ? 1000 : this.bars } });   // Bitcoin: 1,000 days for the burst guard's volatility
    const now = Date.now(), S = { t: [], o: [], h: [], l: [], c: [], q: [] };
    for (const x of k) { if (x[6] >= now) continue; S.t.push(x[0] / 1000); S.o.push(+x[1]); S.h.push(+x[2]); S.l.push(+x[3]); S.c.push(+x[4]); S.q.push(+x[7]) }
    return S;
  }
  // closed daily candles from time `from` (seconds) on, paged (for the since-2020 head start)
  async klinesSince(sym, from) {
    const S = { t: [], o: [], h: [], l: [], c: [], q: [] }, now = Date.now(); let start = from * 1000;
    for (;;) { const k = await this.client.req(this.client.dataBase, '/api/v3/klines', { params: { symbol: sym, interval: '1d', startTime: start, limit: 1000 } });
      for (const x of k) { if (x[6] >= now) continue; S.t.push(x[0] / 1000); S.o.push(+x[1]); S.h.push(+x[2]); S.l.push(+x[3]); S.c.push(+x[4]); S.q.push(+x[7]) }
      if (k.length < 1000) break; start = k[k.length - 1][0] + 1 }
    return S;
  }
  async candidatesList() {
    if (this.coins === 'btc') return ['BTCUSDT'];
    if (this.cand && Date.now() - this.candAt < 12 * 3600e3) return this.cand;
    const info = await this.client.req(this.client.dataBase, '/api/v3/exchangeInfo', { params: { permissions: 'SPOT' } });
    const tick = await this.client.req(this.client.dataBase, '/api/v3/ticker/24hr', { params: { type: 'MINI' } });
    const ok = new Set(info.symbols.filter(s => s.status === 'TRADING' && s.quoteAsset === 'USDT' && s.isSpotTradingAllowed !== false).map(s => s.symbol));
    const vol = new Map(tick.map(t => [t.symbol, +t.quoteVolume]));
    this.cand = [...ok].filter(s => !STABLE.test(s) && !LEVERAGED.test(s) && !require('./brokers/binance').isTokenizedStock(s) && !this.exclude.includes(s)).sort((a, b) => (vol.get(b) || 0) - (vol.get(a) || 0)).slice(0, this.candidates);
    this.candAt = Date.now(); return this.cand;
  }
  async load(held = []) {
    const syms = [...new Set(['BTCUSDT', ...(await this.candidatesList()), ...held])], series = {};
    for (const s of syms) { try { series[s] = await this.daily(s) } catch (e) { if (/rate limit/.test(e.message)) throw e; console.warn(`skip ${s}: ${e.message}`) } }
    const bench = series.BTCUSDT; if (!bench || !bench.t.length) throw new Error('no Bitcoin daily candles');
    return { series, bench, barTime: bench.t[bench.t.length - 1] };
  }
}

// ---------------- brokers: both keep their own ledger (cash + coins), so they never touch other bots' money ----------------
class TrendPaperBroker {
  constructor({ startCash = 10000, cost = DEFAULTS.cost, state } = {}) { this.name = 'paper'; this.cost = cost; this.cash = state?.cash ?? startCash; this.qty = state?.qty ?? {} }
  snapshot() { return { cash: this.cash, qty: this.qty } }
  async init() {}
  holdings() { return { ...this.qty } }
  equity(prices) { let e = this.cash; for (const [s, q] of Object.entries(this.qty)) e += q * (prices[s] ?? 0); return e }
  // orders: [{sym, from, to}] shares of equity. Same accounting as the backtest: fees come off equity, traded coins land on target.
  async rebalance(orders, prices, eq) {
    let fee = 0; for (const o of orders) fee += Math.abs(o.to - o.from) * this.cost * eq;
    const eq2 = eq - fee, fills = [];
    for (const o of orders) {
      const p = prices[o.sym], before = this.qty[o.sym] || 0, after = o.to * eq2 / p;
      if (after > 0) this.qty[o.sym] = after; else delete this.qty[o.sym];
      fills.push({ sym: o.sym, side: after > before ? 'BUY' : 'SELL', qty: Math.abs(after - before), price: p, value: Math.abs(after - before) * p, fee: Math.abs(o.to - o.from) * this.cost * eq });
    }
    let held = 0; for (const [s, q] of Object.entries(this.qty)) held += q * (prices[s] ?? 0);
    this.cash = eq2 - held;
    return fills;
  }
}

class TrendBinanceBroker {
  constructor(client, { startCash = 10000, state } = {}) { this.client = client; this.name = 'binance'; this.startCash = startCash; this.cash = state?.cash ?? null; this.qty = state?.qty ?? {}; this.filters = null }
  snapshot() { return { cash: this.cash, qty: this.qty } }
  async init() {
    if (this.cash != null) return;
    const a = await this.client.req(this.client.base, '/api/v3/account', { signed: true });
    const u = a.balances.find(b => b.asset === 'USDT'), free = u ? +u.free : 0;
    this.cash = Math.min(this.startCash, free);
    if (this.cash < this.startCash) console.warn(`only $${free.toFixed(2)} USDT free on the account: the trend bot will manage $${this.cash.toFixed(2)}`);
  }
  holdings() { return { ...this.qty } }
  equity(prices) { let e = this.cash || 0; for (const [s, q] of Object.entries(this.qty)) e += q * (prices[s] ?? 0); return e }
  async loadFilters() { if (this.filters) return this.filters; const info = await this.client.req(this.client.base, '/api/v3/exchangeInfo'); this.filters = new Map(info.symbols.map(s => [s.symbol, Object.fromEntries(s.filters.map(f => [f.filterType, f]))])); return this.filters }
  floorStep(v, step) { const d = (String(step).split('.')[1] || '').replace(/0+$/, '').length; return +(Math.floor(v / +step + 1e-9) * +step).toFixed(d) }
  fmt(v, step) { const d = (String(step).split('.')[1] || '').replace(/0+$/, '').length; return v.toFixed(d) }
  async rebalance(orders, prices, eq) {
    const F = await this.loadFilters(), fills = [];
    // sells first, so buys can use the cash they free up
    const sorted = [...orders].sort((a, b) => (a.to - a.from) - (b.to - b.from));
    for (const o of sorted) {
      const f = F.get(o.sym); if (!f) { console.warn(`${o.sym}: not on the spot exchange, skipped`); continue }
      const step = f.LOT_SIZE.stepSize, minN = +(f.NOTIONAL?.minNotional || f.MIN_NOTIONAL?.minNotional || 5), base = o.sym.replace(/USDT$/, '');
      if (o.to < o.from) {
        const have = this.qty[o.sym] || 0, want = o.to === 0 ? have : Math.min(have, (o.from - o.to) * eq / prices[o.sym]);
        const q = this.floorStep(want, step); if (q <= 0 || q * prices[o.sym] < minN) continue;
        const r = await this.client.req(this.client.base, '/api/v3/order', { method: 'POST', signed: true, params: { symbol: o.sym, side: 'SELL', type: 'MARKET', quantity: this.fmt(q, step), newOrderRespType: 'FULL' } });
        const exec = +r.executedQty, got = +r.cummulativeQuoteQty, fee = (r.fills || []).reduce((a, x) => a + (x.commissionAsset === 'USDT' ? +x.commission : 0), 0);
        this.qty[o.sym] = have - exec; if (this.qty[o.sym] * prices[o.sym] < minN / 5 || o.to === 0) delete this.qty[o.sym];
        this.cash += got - fee; fills.push({ sym: o.sym, side: 'SELL', qty: exec, price: got / exec, value: got, fee });
      } else {
        const quote = Math.min((o.to - o.from) * eq, this.cash * 0.998); if (quote < minN) continue;
        const r = await this.client.req(this.client.base, '/api/v3/order', { method: 'POST', signed: true, params: { symbol: o.sym, side: 'BUY', type: 'MARKET', quoteOrderQty: quote.toFixed(2), newOrderRespType: 'FULL' } });
        const exec = +r.executedQty, spent = +r.cummulativeQuoteQty, feeBase = (r.fills || []).reduce((a, x) => a + (x.commissionAsset === base ? +x.commission : 0), 0);
        this.qty[o.sym] = (this.qty[o.sym] || 0) + exec - feeBase; this.cash -= spent;
        fills.push({ sym: o.sym, side: 'BUY', qty: exec - feeBase, price: spent / exec, value: spent, fee: feeBase * spent / exec });
      }
    }
    return fills;
  }
}

// ---------------- the bot ----------------
class TrendBot {
  constructor(cfg, { broker, feed, store, log = console.log, notify = async () => {} }) {
    this.cfg = { ...DEFAULTS, ...cfg }; this.N = (COINS[this.cfg.coins] || COINS.btc).N;
    Object.assign(this, { broker, feed, store, log, notify });
    this.state = store.load() || { positions: {}, trades: [], orders: [], lastBar: null, peak: null };
    this.state.orders = this.state.orders || []; this.state.trades = this.state.trades || []; this.state.positions = this.state.positions || {};
  }
  save() { this.store.save({ ...this.state, broker: this.broker.snapshot() }) }

  async cycle({ noEntries = false } = {}) {
    const cfg = this.cfg, st = this.state, N = this.N;
    await this.broker.init();
    const { series, bench, barTime } = await this.feed.load(Object.keys(this.broker.holdings()));
    if (!barTime) { this.log('no closed daily candle yet'); return [] }
    if (st.lastBar === barTime) { this.log(`day ${iso(barTime)} already processed`); return [] }
    if (!this.replay) require('./combo').applyTransfer(this);        // combined crypto account: this month's rebalance, if any
    // latest closed price per coin (a coin without today's candle keeps its last price but cannot be traded)
    const prices = {}, fresh = {};
    for (const [s, S] of Object.entries(series)) { const n = S.t.length; if (!n) continue; prices[s] = S.c[n - 1]; fresh[s] = S.t[n - 1] === barTime }
    for (const [s, p] of Object.entries(st.positions)) if (prices[s] == null && p.lastPrice) prices[s] = p.lastPrice;
    // which coins this bot holds a slot for
    let sleeves;
    if (cfg.coins === 'btc') sleeves = ['BTCUSDT'];
    else {
      if (!st.basket || barTime - (st.basketAt || 0) >= cfg.every * DAY) {
        const ranked = [];
        for (const [s, S] of Object.entries(series)) {
          const n = S.t.length; if (!n || !fresh[s] || (barTime - S.t[0]) / DAY < cfg.warm) continue;
          let v = 0; for (let k = Math.max(0, n - 30); k < n; k++) v += S.q[k]; ranked.push([s, v / 30]);
        }
        ranked.sort((a, b) => b[1] - a[1]); st.basket = ranked.slice(0, N).map(x => x[0]); st.basketAt = barTime;
        this.log(`basket for the next 30 days: ${st.basket.map(s => s.replace(/USDT$/, '')).join(', ')}`);
      }
      sleeves = st.basket;
    }
    // targets: 1/N per coin x the model's share, altcoins only while Bitcoin is trending up
    const btc = analyse(bench.c), info = {}, tgt = {};
    for (const s of sleeves) {
      const S = series[s]; if (!S || !fresh[s] || S.t.length < cfg.minBars) { info[s] = { missing: true }; continue }
      const a = analyse(S.c); if (!a) continue;
      const gated = s !== 'BTCUSDT' && !(btc && btc.score >= 0.5);
      tgt[s] = (1 / N) * (gated ? 0 : a.exposure); info[s] = { ...a, gated, votes: a.votes.map(v => v.yes) };
    }
    // burst guard on Bitcoin's daily closes (switchable): while out, every target is zero
    let gInfo = null, gOut = false;
    try { const G = GUARD.compute(GUARD.daily(bench, DAY)); gOut = GUARD.outAt(G, barTime + DAY); gInfo = GUARD.status(G, barTime + DAY) } catch (e) { this.log('burst guard not available: ' + e.message) }
    const guardOn = cfg.burstGuard === 'on' && !!gInfo;
    if (guardOn && st.guardOut !== undefined && st.guardOut !== gOut) { const msg = gOut ? `BURST GUARD OUT: Bitcoin closed at ${round(gInfo.close)}, below ${round(gInfo.exitLevel)} · moving to cash` : `BURST GUARD IN: Bitcoin closed at ${round(gInfo.close)} · ${(gInfo.events.slice(-1)[0] || {}).why || 'back in'} · the trend model decides again`; this.log(msg); await this.notify(msg) }
    if (gInfo) st.guardOut = gOut;
    if (guardOn && gOut) { for (const s of Object.keys(tgt)) tgt[s] = 0; this.log(`burst guard: out of the market since ${gInfo.since} · holding cash`) }
    // stale holdings: no candle for several days (delisted?) -> sell at the last price
    const hold = this.broker.holdings();
    for (const s of Object.keys(hold)) if (!(s in tgt) && !sleeves.includes(s)) tgt[s] = 0;
    // current shares
    const eq = this.broker.equity(prices), cur = {};
    for (const [s, q] of Object.entries(hold)) cur[s] = q * prices[s] / eq;
    const orders = [];
    for (const s of new Set([...Object.keys(cur), ...Object.keys(tgt)])) {
      const a = cur[s] || 0, b = tgt[s] ?? a; if (!fresh[s] && b > 0) continue;
      if (Math.abs(b - a) >= cfg.band / N || (b === 0 && a > 0) || (a === 0 && b > 0)) {
        if (noEntries && b > a) continue;
        if (!fresh[s] && b === 0) { const S = series[s]; const last = S ? S.t[S.t.length - 1] : (st.positions[s]?.lastT || 0); if ((barTime - last) / DAY < cfg.staleDays) continue }
        orders.push({ sym: s, from: a, to: b });
      }
    }
    if (noEntries) this.log('catch-up check: sells only, no new live buys until the next daily close');
    const fills = orders.length ? await this.broker.rebalance(orders, prices, eq) : [];
    // book-keeping: positions (average cost), round trips, order log
    for (const f of fills) {
      const o = orders.find(x => x.sym === f.sym), p = st.positions[f.sym];
      if (f.side === 'BUY') {
        // cost basis includes the buy fee, so a round trip's P&L is net of every fee
        if (!p) st.positions[f.sym] = { side: 1, qty: f.qty, entry: (f.value + f.fee) / f.qty, cost: f.value + f.fee, t0: barTime, realized: 0, ...(this.replay ? { hist: true } : {}) };
        else { p.cost += f.value + f.fee; p.qty += f.qty; p.entry = p.cost / p.qty }
      } else if (p) {
        const part = Math.min(1, f.qty / p.qty), basis = p.cost * part;
        p.realized += f.value - f.fee - basis; p.cost -= basis; p.qty -= f.qty;
        if (o.to === 0 || p.qty <= 1e-12) {
          st.trades.push({ sym: f.sym, side: 1, t0: p.t0, t1: barTime, entry: p.entry, exit: f.price, pnl: p.realized, why: guardOn && gOut ? 'burst guard' : 'trend exit', ...(this.replay || p.hist ? { hist: true } : {}) });
          delete st.positions[f.sym];
        }
      }
      st.orders.push({ sym: f.sym, t: barTime, side: f.side, price: f.price, value: f.value, from: o.from, to: o.to, ...(this.replay ? { hist: true } : {}) });
      const I = info[f.sym], why = I && I.votes ? ` · trend ${I.votes.filter(Boolean).length}/8 · volatility ${Math.round(I.vol * 100)}% a year${I.gated ? ' · Bitcoin in a downtrend' : ''}` : '';
      const msg = `${f.side} ${f.sym} ${money(f.value)} @ ${round(f.price)} · holding ${Math.round(o.from * 100)}% → ${Math.round(o.to * 100)}% of the account${why}`;
      this.log(msg); await this.notify(msg);
    }
    if (st.orders.length > 2000) st.orders = st.orders.slice(-2000);
    // positions view for the dashboard
    const eqAfter = this.broker.equity(prices), hold2 = this.broker.holdings();
    for (const [s, p] of Object.entries(st.positions)) { if (!hold2[s]) { delete st.positions[s]; continue } p.qty = hold2[s]; p.lastPrice = prices[s]; p.lastT = fresh[s] ? barTime : p.lastT; p.weight = hold2[s] * prices[s] / eqAfter; p.notional = hold2[s] * prices[s]; p.target = tgt[s] ?? p.weight }
    st.preTradeEquity = eq; st.lastEquity = eqAfter; st.peak = Math.max(st.peak ?? eqAfter, eqAfter); st.lastBar = barTime;
    st.targets = Object.fromEntries(Object.entries(info).map(([s, I]) => [s, I.missing ? { missing: true } : { target: tgt[s], score: I.score, votes: I.votes, vol: I.vol, scale: I.scale, gated: I.gated }]));
    st.btcScore = btc ? btc.score : null;
    st.meta = { ...(st.meta && st.meta.headStart ? { headStart: st.meta.headStart } : {}), market: 'trend', mode: cfg.mode, coins: cfg.coins, slots: N, tf: DAY, startCash: cfg.startCash, updated: Math.floor(Date.now() / 1000), guard: gInfo ? { on: guardOn, short: false, ...gInfo } : null };
    this.save();
    this.saveForDashboard(series, bench, barTime, eqAfter, sleeves);
    const invested = Object.values(st.positions).reduce((a, p) => a + p.weight, 0);
    this.log(`day ${iso(barTime)} · equity ${money(eqAfter)} · invested ${Math.round(invested * 100)}%${Object.keys(st.positions).length ? ' in ' + Object.keys(st.positions).map(s => s.replace(/USDT$/, '')).join(', ') : ''}`);
    return fills;
  }

  saveForDashboard(series, bench, barTime, eq, sleeves) {
    const s = this.store; if (!s.appendEquity && !s.saveBars) return;
    try {
      if (s.appendEquity) s.appendEquity(barTime, eq);
      if (s.saveBars) {
        const keep = S => { const o = {}; for (const k of ['t', 'o', 'h', 'l', 'c', 'q']) o[k] = S[k].slice(-400); return o };
        const recent = new Set([...Object.keys(this.state.positions), ...sleeves, ...this.state.orders.filter(o => barTime - o.t < 60 * DAY).map(o => o.sym)]);
        for (const sym of recent) if (series[sym]) s.saveBars(sym, keep(series[sym]));
        s.saveBars('_bench', keep(bench));
      }
    } catch (e) { this.log('dashboard files not saved: ' + e.message) }
  }
}
const iso = t => new Date(t * 1000).toISOString().slice(0, 10);
const money = v => (v < 0 ? '-$' : '$') + Math.abs(v).toFixed(2);
const round = v => +Number(v).toPrecision(6);
module.exports = { TrendBot, TrendFeed, TrendPaperBroker, TrendBinanceBroker, analyse, exposureSeries, trendScores, SPEC, COINS, DEFAULTS, LOOKS };

// The stock bot's three models (setting stockModel): 'v3' = the bot's own model (src/bot.js), 'momentum' = stock momentum,
// 'half' = half in each, put back to 50/50 each month. Momentum and half run on paper only for now.
// Also: the since-2020 head start for all three, from Alpaca's daily history (kept in <bot folder>/history).
'use strict';
const fs = require('fs'), path = require('path');
const SM = require('./stockmom'), BT = require('./backtest'), Bot = require('./bot'), PaperBroker = require('./brokers/paper');
const { writeAtomic } = require('./atomic');
const DAY = 86400, FROM = Date.UTC(2020, 0, 1) / 1000, HIST_FROM = '2018-06-01';
const iso = t => new Date(t * 1000).toISOString().slice(0, 10), money = v => (v < 0 ? '-$' : '$') + Math.abs(v).toFixed(2);
const readNote = f => { try { return f ? JSON.parse(fs.readFileSync(f, 'utf8')) : null } catch { return null } };
const keep = (S, n = 600) => { const o = {}; for (const k of ['t', 'o', 'h', 'l', 'c', 'q']) o[k] = S[k].slice(-n); return o };
const nextMonthStart = t => { const d = new Date(t * 1000); let x = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) / 1000; while ([0, 6].includes(new Date(x * 1000).getUTCDay())) x += DAY; return x };

// a desk transfer note, applied once
function takeNote(bot) {
  const n = readNote(bot.cfg.transferFile), st = bot.state;
  if (!n || !n.id || n.id === st.lastTransferId || !isFinite(n.amount)) return null;
  st.lastTransferId = n.id; st.transfers = [...(st.transfers || []), { id: n.id, t: Math.floor(Date.now() / 1000), amount: n.amount, applied: n.amount }].slice(-60);
  if (st.peak != null) st.peak += n.amount;
  bot.log(`DESK PORTFOLIO: quarterly re-split ${n.amount >= 0 ? 'in' : 'out'} $${Math.abs(n.amount).toFixed(2)}`);
  return n.amount;
}
function dashboardBars(store, series, bench, syms) { if (!store.saveBars) return; try { for (const s of syms) if (series[s]) store.saveBars(s, keep(series[s])); if (bench) store.saveBars('_bench', keep(bench)) } catch {} }

// ---------- momentum only ----------
class StockMomBot {
  constructor(cfg, { feed, store, log = console.log, notify = async () => {} }) {
    Object.assign(this, { cfg, feed, store, log, notify });
    const s = store.load(); this.state = s && s.book ? s : { book: SM.newBook(cfg.startCash || 10000), lastBar: null, lastEquity: null, peak: null, positions: {}, trades: [], meta: {} };
  }
  save() { const st = this.state; st.positions = SM.positionsView(st.book); st.trades = st.book.trades.slice(-1000); this.store.save(st) }
  async cycle() {
    const st = this.state, { series, bench, barTime } = await this.feed.load(Object.keys(st.book.sh));
    if (!barTime) { this.log('no closed bar yet'); return [] }
    if (st.lastBar === barTime) { this.log(`bar ${iso(barTime)} already processed`); return [] }
    if (!this.replay) { const a = takeNote(this); if (a) SM.moveMoney(st.book, a) }
    const P = new SM.Panel(series, bench), i0 = st.lastBar ? P.idx(st.lastBar) + 1 : P.N - 1;
    for (let i = Math.max(1, i0); i < P.N; i++) {
      const ev = SM.step(st.book, P, i, { replay: !!this.replay }); if (ev.picked) await this.report(ev);
      const e = SM.bookValue(st.book, P, i); if (this.store.appendEquity) this.store.appendEquity(P.t[i], e); st.lastEquity = e; st.peak = Math.max(st.peak ?? e, e);
    }
    st.lastBar = barTime; this.meta(); this.save();
    dashboardBars(this.store, series, bench, new Set([...Object.keys(st.book.sh), ...st.book.trades.filter(x => barTime - x.t1 < 60 * DAY).map(x => x.sym)]));
    this.log(`bar ${iso(barTime)} · equity ${money(st.lastEquity)} · holding ${Object.keys(st.book.sh).join(', ') || 'nothing (cash)'}`);
    return [];
  }
  meta() { const st = this.state, B = st.book; st.meta = { ...(st.meta && st.meta.headStart ? { headStart: st.meta.headStart } : {}), market: 'stocks', mode: this.cfg.mode, stockModel: 'momentum', picks: B.picks, marketUp: B.market, pickedAt: B.pickedAt, nextPick: st.lastBar ? nextMonthStart(st.lastBar) : null, startCash: this.cfg.startCash, updated: Math.floor(Date.now() / 1000) } }
  async report(ev) { const B = this.state.book;
    const msg = ev.market ? `MONTHLY PICK · ${B.picks.map(p => `${p.sym} +${(100 * p.score).toFixed(0)}%`).join(', ') || 'no stock qualifies: cash'}${ev.sold.length ? ` · sold ${ev.sold.join(', ')}` : ''}${ev.bought.length ? ` · bought ${ev.bought.join(', ')}` : ''}` : `MONTHLY PICK · S&P 500 below its 200-day average: all cash${ev.sold.length ? ` · sold ${ev.sold.join(', ')}` : ''}`;
    if (this.replay) return; this.log(msg); await this.notify(msg) }
}

// ---------- half and half ----------
// The v3 half is an ordinary Bot with its own paper broker and state (in <bot folder>/half-v3); the momentum half is a book in
// this bot's state. The 50/50 split is worked out at the close of the first trading day of each month (after the momentum
// re-pick) and the money moves at the start of the next bar, before any trade - the same order as the since-2020 replay.
function sleeveStore(dir, main) {
  const f = path.join(dir, 'state.json'); fs.mkdirSync(dir, { recursive: true });
  return { dir, file: f, load() { try { return JSON.parse(fs.readFileSync(f, 'utf8')) } catch { return null } }, save(s) { writeAtomic(f, JSON.stringify(s)) }, appendEquity() {}, saveBars: main.saveBars ? (s, S) => main.saveBars(s, S) : undefined };
}
function splitDelta(pvEq, momEq) { return (pvEq + momEq) / 2 - momEq }             // money into the momentum half (+) or out (-)
class StockHalfBot {
  constructor(cfg, { feed, store, log = console.log, notify = async () => {} }) {
    Object.assign(this, { cfg, feed, store, log, notify });
    const s = store.load(), half = (cfg.startCash || 10000) / 2;
    this.state = s && s.mom ? s : { mom: SM.newBook(half), pending: false, lastBar: null, lastEquity: null, peak: null, positions: {}, trades: [], meta: {} };
    this.sub = sleeveStore(path.join(store.dir || '.', 'half-v3'), store); const ss = this.sub.load();
    const broker = new PaperBroker({ startCash: half, fee: cfg.fee, impK: cfg.impK, state: ss && ss.broker });
    this.stub = { load: async () => this.data };
    this.pv = new Bot({ ...cfg, stockModel: 'v3', transferFile: null }, { broker, feed: this.stub, store: this.sub, log: m => this.log('[own model] ' + m), notify });
  }
  get replay() { return this._replay } set replay(v) { this._replay = v; if (this.pv) this.pv.replay = v }
  save() {
    const st = this.state, pv = this.pv.state, mv = SM.positionsView(st.mom), pos = {};
    for (const [s, p] of Object.entries(pv.positions || {})) pos[s] = { ...p, model: 'v3' };
    for (const [s, p] of Object.entries(mv)) pos[s] = pos[s] ? { ...pos[s], also: p } : p;
    st.positions = pos;
    st.trades = [...(pv.trades || []).map(x => ({ ...x, model: 'v3' })), ...st.mom.trades.map(x => ({ ...x, model: 'momentum' }))].sort((a, b) => a.t1 - b.t1).slice(-1000);
    this.pv.save(); this.store.save(st);
  }
  // the 50/50 split worked out at the previous close, moved now (before the v3 half trades)
  applySplit() {
    const st = this.state; if (!st.pending) return; st.pending = false;
    const pvEq = this.pv.state.lastEquity, momEq = st.momEq; if (pvEq == null || momEq == null) return;
    let d = splitDelta(pvEq, momEq); if (d > 0) d = Math.min(d, Math.max(0, this.pv.broker.cash));
    SM.moveMoney(st.mom, d); this.pv.broker.cash -= d; if (this.pv.state.peak != null) this.pv.state.peak -= d; if (this.pv.state.dayEq != null) this.pv.state.dayEq -= d;
    if (!this.replay) this.log(`HALF AND HALF: ${d >= 0 ? 'moved' : 'moved back'} ${money(Math.abs(d))} ${d >= 0 ? 'to the momentum half' : 'to the own-model half'}`);
  }
  async cycle({ noEntries = false } = {}) {
    const st = this.state;
    this.data = await this.feed.load([...new Set([...Object.keys(this.pv.state.positions || {}), ...Object.keys(st.mom.sh)])]);
    const { series, bench, barTime } = this.data;
    if (!barTime) { this.log('no closed bar yet'); return [] }
    if (st.lastBar === barTime) { this.log(`bar ${iso(barTime)} already processed`); return [] }
    if (!this.replay) { const a = takeNote(this); if (a) { this.pv.broker.cash += a / 2; SM.moveMoney(st.mom, a / 2); if (this.pv.state.peak != null) this.pv.state.peak += a / 2 } }
    const P = new SM.Panel(series, bench), i0 = st.lastBar ? P.idx(st.lastBar) + 1 : P.N - 1;
    for (let i = Math.max(1, i0); i < P.N; i++) {
      this.applySplit();
      if (i === P.N - 1) await this.pv.cycle({ noEntries });                  // the v3 half acts on the latest closed bar
      const ev = SM.step(st.mom, P, i, { replay: !!this.replay }); if (ev.picked) { st.pending = true; if (!this.replay) { const msg = `MONTHLY PICK (momentum half) · ${ev.market ? st.mom.picks.map(p => p.sym).join(', ') || 'cash' : 'S&P 500 below its 200-day average: cash'}`; this.log(msg); await this.notify(msg) } }
      st.momEq = SM.bookValue(st.mom, P, i);
    }
    const e = (this.pv.state.lastEquity ?? 0) + st.momEq;
    if (this.store.appendEquity) this.store.appendEquity(barTime, e);
    st.lastBar = barTime; st.lastEquity = e; st.peak = Math.max(st.peak ?? e, e); this.meta(); this.save();
    dashboardBars(this.store, series, bench, new Set(Object.keys(st.mom.sh)));
    this.log(`bar ${iso(barTime)} · equity ${money(e)} (own model ${money(this.pv.state.lastEquity ?? 0)} · momentum ${money(st.momEq)})`);
    return [];
  }
  meta() { const st = this.state, B = st.mom; st.meta = { ...(st.meta && st.meta.headStart ? { headStart: st.meta.headStart } : {}), market: 'stocks', mode: this.cfg.mode, stockModel: 'half', halves: { v3: +(this.pv.state.lastEquity ?? 0).toFixed(2), momentum: +(st.momEq ?? 0).toFixed(2) }, picks: B.picks, marketUp: B.market, pickedAt: B.pickedAt, nextPick: st.lastBar ? nextMonthStart(st.lastBar) : null, slots: this.cfg.slots, startCash: this.cfg.startCash, updated: Math.floor(Date.now() / 1000) } }
}

// ---------- since-2020 head start for the stock bot (all three models) ----------
async function seedStocks(bot, log = console.log) {
  const cfg = bot.cfg, model = cfg.stockModel || 'v3', start = cfg.startCash || 10000, dir = bot.store.dir;
  if (!bot.feed.history) throw new Error('this stock feed has no history download');
  log('head start since 2020: downloading daily history for the S&P 500 stocks from Alpaca (first time a few minutes; kept for later resets)…');
  const { series, bench, feed } = await bot.feed.history(HIST_FROM, dir && path.join(dir, '..', 'history'), log);
  if (!bench || !bench.t.length) throw new Error('no SPY history');
  log(`head start: ${Object.keys(series).length} stocks (${feed === 'sip' ? 'consolidated' : 'IEX'} prices) · replaying from 1 January 2020 through the ${model === 'v3' ? "bot's own model" : model === 'momentum' ? 'momentum model' : 'half-and-half model'}…`);
  const last = bench.t[bench.t.length - 1], P = model === 'v3' ? null : new SM.Panel(series, bench);
  let eqs, final, dd, nTrades;
  const v3Result = (r, pv) => {                                            // write a v3 backtest result into a Bot's state and paper broker
    const s = pv.state; s.trades = r.trades.map(x => ({ sym: x.sym, side: x.side, t0: x.t0, t1: x.t1, entry: x.entry, exit: x.exit, pnl: x.pnl, why: x.why, hist: true }));
    s.positions = {}; const bp = {};
    for (const q of r.held) { s.positions[q.sym] = { side: q.side, entry: q.entry, qty: q.qty, notional: q.notional, stop: q.stop, t0: q.t0, lastPrice: q.last, risk: q.risk, ref: q.entry, best: q.best, hist: true }; bp[q.sym] = { qty: q.qty, side: q.side, entry: q.entry, notional: q.notional, imp: q.imp, t0: q.t0, stop: q.stop } }
    pv.broker.cash = r.cash; pv.broker.positions = bp; s.lastBar = last; s.lastEquity = r.final; s.peak = r.final;
  };
  if (model === 'v3') {
    const r = BT.backtest({ ...cfg, start, from: FROM }, series, bench, 86400); v3Result(r, bot);
    eqs = r.eqs; final = r.final; dd = r.dd; nTrades = r.trades.length;
  } else if (model === 'momentum') {
    const r = SM.backtest(P, FROM, start); bot.state.book = r.B; bot.state.lastBar = last; bot.state.lastEquity = r.final; bot.state.peak = r.final; bot.meta();
    eqs = r.eqs; final = r.final; dd = r.dd; nTrades = r.B.trades.length;
  } else {
    const st = bot.state; st.mom = SM.newBook(start / 2); st.pending = false; const mv = new Map();
    const hook = (t, cash, pvEq) => {                                      // same order as StockHalfBot.cycle
      let d = 0; if (st.pending) { st.pending = false; d = splitDelta(pvEq, st.momEq); if (d > 0) d = Math.min(d, Math.max(0, cash)); SM.moveMoney(st.mom, d) }
      const i = P.idx(t); if (i > 0) { const ev = SM.step(st.mom, P, i, { replay: true }); if (ev.picked) st.pending = true; st.momEq = SM.bookValue(st.mom, P, i); mv.set(t, st.momEq) }
      return -d;
    };
    const r = BT.backtest({ ...cfg, start: start / 2, from: FROM, onBar: hook }, series, bench, 86400); v3Result(r, bot.pv);
    let pk = 0; dd = 0; eqs = r.eqs.map(([t, e]) => { const v = e + (mv.get(t) ?? st.momEq); pk = Math.max(pk, v); dd = Math.max(dd, 1 - v / pk); return [t, v] });
    final = eqs[eqs.length - 1][1]; st.lastBar = last; st.lastEquity = final; st.peak = final; nTrades = r.trades.length + st.mom.trades.length; bot.meta();
  }
  bot.state.peak = bot.state.lastEquity;                                   // the drawdown halt counts from today
  try { const n = readNote(cfg.transferFile); if (n && n.id) bot.state.lastTransferId = n.id } catch {}
  bot.state.meta = { ...(bot.state.meta || {}), headStart: { days: Math.round((last - FROM) / DAY), from: FROM, to: last, since: '2020-01-01', stocks: Object.keys(series).length, feed } };
  bot.save();
  if (dir) writeAtomic(path.join(dir, 'equity.json'), JSON.stringify(eqs.map(([t, e]) => [t, +e.toFixed(2)])));
  const held = model === 'v3' ? Object.keys(bot.state.positions) : model === 'momentum' ? Object.keys(bot.state.book.sh) : [...Object.keys(bot.pv.state.positions), ...Object.keys(bot.state.mom.sh)];
  const traded = (model === 'half' ? bot.state.trades : bot.state.trades || []).filter(x => last - x.t1 < 120 * DAY).map(x => x.sym);
  dashboardBars(bot.store, series, bench, new Set([...held, ...traded]));
  const yrs = {}; let prev = start, y = null, v = null;
  for (const [t, e] of eqs) { const yy = new Date(t * 1000).getUTCFullYear(); if (y != null && yy !== y) { yrs[y] = (100 * (v / prev - 1)).toFixed(1) + '%'; prev = v } y = yy; v = e } yrs[y] = (100 * (v / prev - 1)).toFixed(1) + '%';
  log(`head start since 2020 done: ${nTrades} trades · $${start.toFixed(0)} → $${final.toFixed(2)} · worst drop ${(dd * 100).toFixed(1)}% · by year ${Object.entries(yrs).map(([k, x]) => k + ' ' + x).join(', ')} · now trading live on paper`);
  return true;
}

module.exports = { StockMomBot, StockHalfBot, seedStocks, splitDelta, FROM };

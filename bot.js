// One decision cycle, run at each bar close. Same order of operations as the backtest:
// exits -> mark to market -> safety checks -> entries.
const ENG = require('./engine');
const CORE = require('./core');
const BT = require('./backtest');
const GUARD = require('./guard');
const COMBO = require('./combo');
const fs = require('fs');
const readMon = f => { try { return f ? JSON.parse(fs.readFileSync(f, 'utf8')).mon : null } catch { return null } };

class Bot {
  constructor(cfg, { broker, feed, store, log = console.log, notify = async () => {} }) {
    this.cfg = { ...CORE.DEFAULTS, ...cfg };
    this.M = ENG.MODELS[this.cfg.model];
    this.broker = broker; this.feed = feed; this.store = store; this.log = log; this.notify = notify;
    this.state = store.load() || { peak: null, halted: false, haltReason: null, positions: {}, trades: [], dayStart: null, dayEq: null, lastBar: null };
  }

  save() { this.store.save({ ...this.state, broker: this.broker.snapshot ? this.broker.snapshot() : undefined }) }

  async cycle({ noEntries = false } = {}) {
    const cfg = this.cfg, M = this.M, st = this.state;
    const { series, bench, barTime } = await this.feed.load(Object.keys(st.positions));      // closed bars only, all ending at or before barTime
    if (!barTime) { this.log('no closed bar yet'); return [] }
    if (st.lastBar === barTime) { this.log(`bar ${iso(barTime)} already processed`); return [] }
    if (!this.replay) COMBO.applyTransfer(this);                 // combined crypto account: this month's rebalance, if any
    const U = Object.entries(series).map(([sym, S]) => BT.prepare(sym, S, cfg.tf)).filter(u => u.bars.length > 60);
    for (const u of U) u.k = u.at.has(barTime) ? u.at.get(barTime) : -1;
    const bySym = new Map(U.map(u => [u.sym, u])), actions = [];
    // Market breadth: the share of the scanned coins above their 50-day average. Below 35% the profit stop is armed (v3a).
    const scanned = this.feed.universe ? new Set(this.feed.universe) : null, inScan = scanned ? u => scanned.has(u.sym) : null;
    let bAct = 0; for (const u of U) if (u.k >= 200 && (!inScan || inScan(u))) bAct++;
    const breadth = CORE.breadth(U, inScan), protect = cfg.profitStop === 'on';
    // Burst guard (see src/guard.js). Worked out on every bar so the desk can show it; it only changes trades when switched on.
    const T = barTime + cfg.tf; let G = null, gOut = false, gInfo = null;
    try { G = await this.guardSeries(bench, T); if (G) { gOut = GUARD.outAt(G, T); gInfo = GUARD.status(G, T) } } catch (e) { this.log('burst guard not available: ' + e.message) }
    const guardOn = cfg.burstGuard === 'on' && G != null;
    if (guardOn && st.guardOut !== undefined && st.guardOut !== gOut) {
      const msg = gOut ? `BURST GUARD OUT: ${gInfo.kind === 'sp' ? 'S&P 500' : 'Bitcoin'} closed at ${round(gInfo.close)}, below ${round(gInfo.exitLevel)} · selling longs and pausing new buys${cfg.burstShort ? ' · opening the guard short' : ''}`
                       : `BURST GUARD IN: ${gInfo.kind === 'sp' ? 'S&P 500' : 'Bitcoin'} closed at ${round(gInfo.close)} · ${(gInfo.events.slice(-1)[0] || {}).why || 'back in'} · buying allowed again`;
      actions.push({ type: 'guard', msg }); this.log(msg); await this.notify(msg);
    }
    if (G) st.guardOut = gOut;

    // 1. exits: stops already filled at the broker, then rule exits on this bar
    if (this.broker.syncStops) for (const ev of await this.broker.syncStops(st.positions)) { await this.recordExit(ev.sym, ev.price, `${(st.positions[ev.sym] || {}).stopWhy || 'stop'} (filled at broker)`, barTime, actions) }
    for (const sym of Object.keys(st.positions)) {
      const p = st.positions[sym], u = bySym.get(sym);
      if (p.guard && (!u || u.k < 0) && bench && bench.t.length) {   // guard short priced off the benchmark when the coin list doesn't carry it
        const j = bench.t.length - 1, bar = { open: bench.o[j], high: bench.h[j], low: bench.l[j], close: bench.c[j] }; p.lastPrice = bar.close;
        if (bar.high >= p.stop) await this.exit(sym, Math.max(p.stop, bar.open), 'guard short stop', barTime, actions);
        else if (!guardOn || !gOut) await this.exit(sym, bar.close, 'burst guard: back in', barTime, actions);
        continue;
      }
      if (!u || u.k < 0) { p.missing = (p.missing || 0) + 1; if (p.missing >= (cfg.maxMissingBars || 6)) { this.log(`${sym}: no data for ${p.missing} bars — closing`); await this.exit(sym, p.lastPrice ?? p.entry, 'no data', barTime, actions) } continue }
      p.missing = 0; const bar = u.bars[u.k]; p.lastPrice = bar.close;
      if (p.guard) {                                        // the burst-guard short: its own stop, closed when the guard says back in
        if (bar.high >= p.stop) { await this.exit(sym, Math.max(p.stop, bar.open), 'guard short stop', barTime, actions); continue }
        if (!guardOn || !gOut) await this.exit(sym, bar.close, 'burst guard: back in', barTime, actions);
        continue;
      }
      if (guardOn && gOut && p.side > 0) { await this.exit(sym, bar.close, 'burst guard: out of the market', barTime, actions); continue }
      const ex = CORE.checkExit(p, bar, u.s[u.k], M);
      if (ex) { await this.exit(sym, ex.px, ex.why, barTime, actions); continue }
      if (protect && p.side > 0) await this.profitStop(sym, p, u, breadth, actions);
    }

    // 2. mark to market
    const prices = {}; for (const u of U) if (u.k >= 0) prices[u.sym] = u.bars[u.k].close;
    for (const [sym, p] of Object.entries(st.positions)) if (prices[sym] == null && p.lastPrice != null) prices[sym] = p.lastPrice;
    let eq = await this.broker.equity(prices);
    // combined crypto account on a shared Binance account: count only what the trend bot does not own
    const peer = cfg.comboPeerState && this.broker.name !== 'paper' ? COMBO.peerValue(cfg.comboPeerState) : null;
    if (peer) eq = Math.max(0, eq - peer.value);
    st.peak = Math.max(st.peak ?? eq, eq);
    const day = Math.floor(barTime / 86400);
    if (st.dayStart !== day) { st.dayStart = day; st.dayEq = eq }

    // 3. safety checks (block new entries; existing positions keep their stops)
    if (!st.halted && cfg.maxDrawdown && eq < st.peak * (1 - cfg.maxDrawdown)) { st.halted = true; st.haltReason = `equity ${eq.toFixed(2)} is ${(100 * (1 - eq / st.peak)).toFixed(1)}% below peak` ; await this.notify(`HALTED: ${st.haltReason}. New entries stopped until you reset the halt.`) }
    const dayLoss = st.dayEq ? 1 - eq / st.dayEq : 0;
    const dayBlocked = cfg.maxDailyLoss && dayLoss > cfg.maxDailyLoss;

    // 4. entries
    const held = new Set(Object.keys(st.positions));
    if (noEntries) this.log('catch-up check: exits and stops only, no new live entries until the next bar close');
    else if (guardOn && gOut) {
      this.log(`burst guard: out of the market since ${gInfo.since} · no new buys`);
      if (cfg.burstShort && cfg.market === 'crypto' && !st.halted && !dayBlocked) await this.guardShort(bench, bySym, gInfo, eq, barTime, actions);
    }
    else if (!st.halted && !dayBlocked && held.size < cfg.slots) {
      const live = U.filter(u => u.k >= 0);
      let cash = this.broker.cash ?? (await this.broker.availableCash());
      if (peer) cash = Math.max(0, cash - peer.cash);
      for (const c of CORE.candidates(cfg, M, live, bench, held)) {
        if (Object.keys(st.positions).length >= cfg.slots) break;
        const u = bySym.get(c.sym), bar = u.bars[c.k];
        const stopPct = M.stopK * u.A[c.k] / bar.close;
        const notional = CORE.sizePosition({ equity: eq, cash, slots: cfg.slots, risk: cfg.risk, stopPct, liq: c.f.liq, maxPart: cfg.maxPart });
        if (notional < (cfg.minOrder || 1)) continue;
        const stop = bar.close - c.side * M.stopK * u.A[c.k];
        const fill = await this.broker.open({ sym: c.sym, side: c.side, notional, price: bar.close, liq: c.f.liq, t: barTime, stop });
        if (!fill) continue;
        cash -= fill.notional ?? notional;
        // risk and best close are what the profit stop measures from (the research used the bar's close as the entry)
        st.positions[c.sym] = { side: c.side, entry: fill.price, qty: fill.qty, notional: fill.notional ?? notional, stop, t0: barTime, lastPrice: bar.close, stopOrderId: fill.stopOrderId, risk: M.stopK * u.A[c.k], ref: bar.close, best: bar.close, ...(this.replay ? { hist: true } : {}) };
        const msg = `BUY ${c.sym} ${money(fill.notional ?? notional)} @ ${round(fill.price)} · stop ${round(stop)} · consensus +${u.s[c.k]} · 30-day vs benchmark ${c.f.rs30 >= 0 ? '+' : ''}${(100 * c.f.rs30).toFixed(1)}% · volume x${c.f.surge.toFixed(2)} of normal${cfg.trendRule === 'on' ? ` · ${(100 * (bar.close / u.d50[c.k] - 1)).toFixed(1)}% above its 50-day average` : ''}`;
        actions.push({ type: 'entry', sym: c.sym, msg }); this.log(msg); await this.notify(msg);
      }
    } else if (st.halted || dayBlocked) this.log(st.halted ? `halted: ${st.haltReason}` : `daily loss ${(dayLoss * 100).toFixed(1)}% — no new entries today`);

    st.lastBar = barTime; st.lastEquity = eq;
    st.meta = { ...(st.meta && st.meta.headStart ? { headStart: st.meta.headStart } : {}), market: cfg.market, mode: cfg.mode, model: cfg.model, rank: cfg.rank, slots: cfg.slots, tf: cfg.tf, risk: cfg.risk, regime: cfg.regime, startCash: cfg.startCash, updated: Math.floor(Date.now() / 1000), guard: gInfo ? { on: guardOn, short: !!cfg.burstShort && cfg.market === 'crypto', shortShare: cfg.burstShortShare || 0.33, ...gInfo } : null, breadth: breadth == null ? null : +breadth.toFixed(4), breadthN: bAct,
      profitStop: protect, profitStopRule: protect ? CORE.PROFIT_STOP : null, profitStopArmed: protect && breadth != null && breadth < CORE.PROFIT_STOP.below, trendRule: cfg.trendRule === 'on' };
    st.breadthHist = [...(st.breadthHist || []), [barTime, breadth == null ? null : +breadth.toFixed(4)]].slice(-500);
    this.save();
    this.saveForDashboard(series, bench, barTime, eq);
    this.log(`bar ${iso(barTime)} · equity ${money(eq)} · holding ${Object.keys(st.positions).join(', ') || 'nothing'}`);
    return actions;
  }

  // v3a profit stop: after a bar with no exit, raise the stop to 3 ATR under the best close once the trade is 2x its risk up,
  // while fewer than 35% of the scanned coins are above their 50-day average (CORE.profitStop). On Binance the resting stop order moves too.
  async profitStop(sym, p, u, breadth, actions) {
    const k = u.k;
    if (p.risk == null || p.best == null) {                      // positions bought before 1.9.0: work out risk and best close from the candles
      if (p.risk == null) p.risk = Math.abs((p.ref ?? p.entry) - p.stop);
      if (p.best == null) { let b = p.ref ?? p.entry; for (let j = 0; j < k; j++) if (u.bars[j].time > p.t0 && u.bars[j].close > b) b = u.bars[j].close; p.best = b }
    }
    const pv = { side: p.side, entry: p.ref ?? p.entry, risk: p.risk, stop: p.stop, best: p.best };
    const was = p.stop, moved = CORE.profitStop(pv, u.bars[k], u.A[k], breadth);
    p.best = pv.best; if (moved == null) return;
    p.stop = moved; p.stopWhy = 'profit stop';
    if (this.broker.moveStop) {
      let r; try { r = await this.broker.moveStop({ sym, qty: p.qty, stopOrderId: p.stopOrderId, stop: moved, oldStop: was }) } catch (e) { r = { id: p.stopOrderId, ok: false, note: e.message } }
      p.stopOrderId = r.id;
      if (!r.ok) { const m = `${sym}: exchange stop not moved (${r.note}); the bot still sells at its next check if the price has touched ${round(moved)}`; this.log(m); await this.notify(m) }
    }
    const msg = `PROFIT STOP ${sym} raised to ${round(moved)} (was ${round(was)}) · best close ${round(p.best)} · ${((p.best - pv.entry) / p.risk).toFixed(1)}x risk up · breadth ${(100 * breadth).toFixed(0)}%`;
    actions.push({ type: 'stop', sym, msg }); this.log(msg);
  }

  // daily closes of the benchmark for the burst guard: Bitcoin (1,100 daily candles) or SPY; S&P rule when Bubble Watch data is there
  async guardSeries(bench, T) {
    const cfg = this.cfg; let D = null;
    if (this.feed.dailyBench) { const day = Math.floor(T / 86400); if (!this._gd || this._gd.day !== day) this._gd = { day, D: await this.feed.dailyBench() }; D = this._gd.D }
    else if (bench) D = GUARD.daily(bench, cfg.tf);
    if (!D || D.c.length < 210) return null;
    let kind = 'vol', warned = null;
    if (cfg.market === 'stocks') { const w = GUARD.spWarning(readMon(cfg.bubblePage)); if (w) { kind = 'sp'; warned = w } }
    return GUARD.compute(D, { kind, warned });
  }
  // open the guard short on the benchmark coin (paper accounts only: the Binance spot account cannot short)
  async guardShort(bench, bySym, gInfo, eq, barTime, actions) {
    const cfg = this.cfg, st = this.state, sym = this.feed.bench || 'BTCUSDT';
    if (st.positions[sym]) return;
    if (this.broker.name !== 'paper') { if (!st.guardShortSkipped) { this.log('burst guard: short skipped — the Binance spot account cannot short, so the bot only steps aside'); st.guardShortSkipped = true } return }
    const u = bySym.get(sym), price = u && u.k >= 0 ? u.bars[u.k].close : bench.c[bench.c.length - 1];
    const cash = this.broker.cash ?? (await this.broker.availableCash()), notional = Math.min(cash, eq * (cfg.burstShortShare || 0.33));
    if (notional < (cfg.minOrder || 1)) return;
    const stop = price * Math.exp(2 * gInfo.volUnit);
    const fill = await this.broker.open({ sym, side: -1, notional, price, liq: 1e12, t: barTime, stop }); if (!fill) return;
    st.positions[sym] = { side: -1, entry: fill.price, qty: fill.qty, notional: fill.notional ?? notional, stop, t0: barTime, lastPrice: price, guard: true, ...(this.replay ? { hist: true } : {}) };
    const msg = `SHORT ${sym} ${money(fill.notional ?? notional)} @ ${round(fill.price)} · burst guard short · stop ${round(stop)}`;
    actions.push({ type: 'entry', sym, msg }); this.log(msg); await this.notify(msg);
  }

  // Files for the dashboard: account value history and recent candles of every asset held or traded in the last 60 days.
  saveForDashboard(series, bench, barTime, eq) {
    const s = this.store; if (!s.appendEquity && !s.saveBars) return;
    try {
      if (s.appendEquity) s.appendEquity(barTime, eq);
      if (s.saveBars) {
        const keep = n => S => { const o = {}; for (const k of ['t', 'o', 'h', 'l', 'c', 'q']) o[k] = S[k].slice(-n); return o };
        const recent = new Set([...Object.keys(this.state.positions), ...this.state.trades.filter(x => barTime - x.t1 < 60 * 86400).map(x => x.sym)]);
        for (const sym of recent) if (series[sym]) s.saveBars(sym, keep(600)(series[sym]));
        if (bench) s.saveBars('_bench', keep(600)(bench));
      }
    } catch (e) { this.log('dashboard files not saved: ' + e.message) }
  }

  async exit(sym, price, why, t, actions) {
    const p = this.state.positions[sym];
    const fill = await this.broker.close({ sym, price, t, qty: p.qty, stopOrderId: p.stopOrderId, fundPer8h: this.cfg.fundPer8h });
    await this.recordExit(sym, fill?.price ?? price, why, t, actions, fill);
  }
  async recordExit(sym, price, why, t, actions, fill) {
    const p = this.state.positions[sym]; if (!p) return;
    const pnl = fill?.pnl ?? p.qty * (price - p.entry) * p.side;
    this.state.trades.push({ sym, side: p.side, t0: p.t0, t1: t, entry: p.entry, exit: price, pnl, why, ...(p.guard ? { guard: true } : {}), ...(this.replay || p.hist ? { hist: true } : {}) });
    delete this.state.positions[sym];
    const msg = `${p.side < 0 ? 'COVER' : 'SELL'} ${sym} @ ${round(price)} (${why}) · P&L ${money(pnl)}`;
    actions.push({ type: 'exit', sym, msg }); this.log(msg); await this.notify(msg);
  }
}
const iso = t => new Date(t * 1000).toISOString().replace('.000Z', 'Z');
const money = v => (v < 0 ? '-$' : '$') + Math.abs(v).toFixed(2);
const round = v => +Number(v).toPrecision(6);
module.exports = Bot;

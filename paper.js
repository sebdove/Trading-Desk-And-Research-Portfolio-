// Paper broker: simulated fills with the same costs as the backtest. State is kept in memory and saved by the bot.
const CORE = require('../core');

class PaperBroker {
  constructor({ startCash = 10000, fee = 0.001, impK = 0.05, state } = {}) {
    this.name = 'paper';
    this.fee = fee; this.impK = impK;
    this.cash = state?.cash ?? startCash;
    this.positions = state?.positions ?? {};      // sym -> { qty, side, entry, notional, imp, t0 }
  }
  snapshot() { return { cash: this.cash, positions: this.positions } }
  async equity(prices) {
    let eq = this.cash;
    for (const [sym, p] of Object.entries(this.positions)) eq += p.notional + p.qty * ((prices[sym] ?? p.entry) - p.entry) * p.side;
    return eq;
  }
  async positionsList() { return Object.entries(this.positions).map(([sym, p]) => ({ sym, ...p })) }
  // Open a position worth `notional` at `price`. Long only unless side = -1 (paper allows shorts for v2 tests).
  async open({ sym, side, notional, price, liq, t, stop }) {
    if (this.positions[sym]) throw new Error(`already holding ${sym}`);
    notional = Math.min(notional, this.cash);
    if (notional <= 0) return null;
    const imp = CORE.impact(notional, liq, this.impK);
    this.cash -= notional;
    this.positions[sym] = { qty: notional / price, side, entry: price, notional, imp, t0: t, stop };
    return { sym, side, price, notional, qty: notional / price };
  }
  async close({ sym, price, t, fundPer8h = 0 }) {
    const p = this.positions[sym]; if (!p) return null;
    const hrs = (t - p.t0) / 3600;
    const pnl = p.qty * (price - p.entry) * p.side - this.fee * p.notional - fundPer8h * p.notional * hrs / 8 - 2 * p.imp * p.notional;
    this.cash += p.notional + pnl; delete this.positions[sym];
    return { sym, price, pnl, ret: pnl / p.notional };
  }
}
module.exports = PaperBroker;

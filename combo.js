// Combined crypto account: one pot of money run by two bots, a third by the crypto bot (v3) and two thirds by the
// Trend Engine, rebalanced on the first day of each month. Tested 2020 to Nov 2026 from $10,000 with the 1.9.0 crypto rules
// (profit stop + 50-day rule, Bitcoin filter without look-ahead, 120 most-traded coins): $120,933, worst drop 33%
// (crypto bot alone $149,671 / 47%, Trend Engine alone $93,750 / 46%). A third in crypto is still the best return per unit of drop.
// The desktop app decides each month how much to move and writes a transfer note into each bot's folder; each bot applies
// its note once, at its next cycle (paper: moves paper cash; on Binance, the trend bot's ledger changes and the crypto bot
// counts only what the trend bot does not own).
'use strict';
const fs = require('fs');
const SHARE = 1 / 3;
const TESTED = { from: '2020-01-01', crypto: { final: 149671, dd: 47 }, trend: { final: 93750, dd: 46 }, combo: { final: 120933, dd: 32.8 }, noRebalance: { final: 112204, dd: 33.7 } };

const monthKey = (t = Date.now()) => new Date(t).toISOString().slice(0, 7);
// how much to move to the crypto bot (negative: from the crypto bot to the trend bot)
function plan(cryptoEq, trendEq, share = SHARE) {
  const total = cryptoEq + trendEq, crypto = total * share, trend = total - crypto;
  return { total, crypto, trend, toCrypto: +(crypto - cryptoEq).toFixed(2) };
}
const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')) } catch { return null } };
const { writeAtomic } = require('./atomic');   // retries while Windows has the file open

// Called by a bot at the start of each cycle. Applies a new transfer note once and keeps the drawdown
// and daily-loss checks honest (a transfer is not a profit or a loss). Returns the amount applied, or 0.
function applyTransfer(bot) {
  const f = bot.cfg.transferFile; if (!f) return 0;
  const n = readJson(f); const st = bot.state;
  if (!n || !n.id || n.id === st.lastTransferId || !isFinite(n.amount)) return 0;
  const b = bot.broker; let applied = 0;
  if (typeof b.cash === 'number') { b.cash += n.amount; applied = n.amount }           // paper cash, or the trend bot's Binance ledger
  st.lastTransferId = n.id;
  st.transfers = [...(st.transfers || []), { id: n.id, t: Math.floor(Date.now() / 1000), amount: n.amount, applied }].slice(-60);
  if (applied) { if (st.peak != null) st.peak += applied; if (st.dayEq != null) st.dayEq += applied }
  bot.log(`COMBINED ACCOUNT: monthly rebalance ${n.amount >= 0 ? 'in' : 'out'} $${Math.abs(n.amount).toFixed(2)}${applied ? '' : ' (budget only: this account is shared on Binance)'}`);
  return applied;
}
// Value the trend bot owns, from its saved state (used by the crypto bot on a shared Binance account).
function peerValue(file) {
  const s = readJson(file); if (!s || !s.broker) return { value: 0, cash: 0 };
  let v = s.broker.cash || 0; for (const [sym, q] of Object.entries(s.broker.qty || {})) v += q * ((s.positions && s.positions[sym] && s.positions[sym].lastPrice) || 0);
  return { value: v, cash: s.broker.cash || 0 };
}

// account value history of the two bots added together, day by day (each carried forward to the last known value)
function mergeEquity(a, b) {
  const day = t => Math.floor(t / 86400) * 86400, A = new Map(), B = new Map();
  for (const [t, e] of a || []) A.set(day(t), e); for (const [t, e] of b || []) B.set(day(t), e);
  const days = [...new Set([...A.keys(), ...B.keys()])].sort((x, y) => x - y), out = []; let la = null, lb = null;
  for (const d of days) { if (A.has(d)) la = A.get(d); if (B.has(d)) lb = B.get(d); if (la != null && lb != null) out.push([d, +(la + lb).toFixed(2), +la.toFixed(2), +lb.toFixed(2)]) }
  return out;
}

module.exports = { SHARE, TESTED, monthKey, plan, applyTransfer, peerValue, mergeEquity, readJson, writeAtomic };

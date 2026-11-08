// Stock momentum model (paper only for now) and the half-and-half stock bot.
// Momentum: on the first trading day of each month, using the previous close, hold the 5 S&P 500 stocks that rose most from
// 252 to 21 trading days ago (a year, skipping the last month), only stocks above their own 200-day average and only while
// SPY is above its 200-day average; otherwise that share sits in cash. Equal shares, bought at that day's open, 0.1% cost a side.
// Chosen on 2019-23 only; 2024-26 unseen: x1.95 (S&P x1.55) without the 5 stocks that joined the S&P in 2024.
// Half-and-half: half the account in the stock bot's own model (v3, 4 stocks), half in momentum, put back to 50/50 at the close of
// the first trading day of each month. Tested 2020 to 2 Nov 2026 from $10,000: $63,853, worst drop 29.6% (current model
// alone about $58,900 / 31.5%, momentum alone $57,800 / 35%); 2024-26 x1.53 vs x1.19.
'use strict';
const DAY = 86400;
const RULE = { L: 252, skip: 21, K: 5, sma: 200, avgDays: 63, cost: 0.001 };
const TESTED = {
  momentum: { final: 57812, dd: 35.2, unseen: 1.95, years: { 2020: 162.4, 2021: 31.3, 2022: -9.6, 2023: 1.2, 2024: 25.7, 2025: 2.7, 2026: 44.8 } },
  half: { final: 63853, dd: 29.6, unseen: 1.53, years: { 2021: 39.4, 2022: -10.8, 2023: 34.5, 2024: 39.5, 2025: -2.2, 2026: 12.3 } },
  current: { final: 58886, dd: 31.5, unseen: 1.19 }, spy: { unseen: 1.55 },
};
const monthOf = t => { const d = new Date(t * 1000); return d.getUTCFullYear() * 12 + d.getUTCMonth() };

// Daily closes of every stock on the benchmark's (SPY's) trading days. Gaps inside a stock's life carry the last close.
class Panel {
  constructor(series, bench) {
    this.t = Array.from(bench.t); this.N = this.t.length; this.at = new Map(this.t.map((t, i) => [Math.floor(t / DAY), i]));
    this.spy = Float64Array.from(bench.c); this.spySma = sma(this.spy, RULE.sma);
    this.X = {};
    for (const [s, S] of Object.entries(series)) {
      const o = new Float64Array(this.N).fill(NaN), c = new Float64Array(this.N).fill(NaN), q = new Float64Array(this.N).fill(NaN);
      for (let j = 0; j < S.t.length; j++) { const i = this.at.get(Math.floor(S.t[j] / DAY)); if (i != null) { o[i] = S.o[j]; c[i] = S.c[j]; q[i] = S.q[j] } }
      for (let i = 1; i < this.N; i++) if (!Number.isFinite(c[i]) && Number.isFinite(c[i - 1])) { c[i] = c[i - 1]; o[i] = c[i - 1]; q[i] = 0 }
      const q0 = Float64Array.from(q, x => (Number.isFinite(x) ? x : 0));
      this.X[s] = { o, c, sma: sma(c, RULE.sma), avq: sma(q0, RULE.avgDays) };
    }
    this.syms = Object.keys(this.X);
  }
  idx(t) { const i = this.at.get(Math.floor(t / DAY)); return i == null ? -1 : i }
}
function sma(c, n) { const N = c.length, o = new Float64Array(N).fill(NaN); let s = 0, m = 0;
  for (let i = 0; i < N; i++) { if (Number.isFinite(c[i])) { s += c[i]; m++ } if (i >= n && Number.isFinite(c[i - n])) { s -= c[i - n]; m-- } if (i >= n - 1 && m === n) o[i] = s / n }
  return o }

// The picks at day i's close: [{sym, score}] (empty = all cash); market = false when SPY is under its 200-day average
function picks(P, i, R = RULE) {
  if (i < R.L || !(P.spy[i] > P.spySma[i])) return { market: false, list: [] };
  const list = [];
  for (const s of P.syms) { const x = P.X[s];
    if (!Number.isFinite(x.c[i]) || !Number.isFinite(x.c[i - 260]) || !(x.avq[i] > 0)) continue;
    const r = x.c[i - R.skip] / x.c[i - R.L] - 1; if (!Number.isFinite(r) || r <= 0 || !(x.c[i] > x.sma[i])) continue; list.push({ sym: s, score: r }) }
  list.sort((a, b) => b.score - a.score); return { market: true, list: list.slice(0, R.K) };
}

// The momentum book: cash + shares. step(P, i) processes trading day i: on the first day of a month it re-picks with day i-1's
// close and trades at day i's open; then it values the book at day i's close. Same code for the replay and the live paper bot.
function newBook(cash) { return { cash, sh: {}, open: {}, trades: [], lastI: null, lastT: null, picks: [], market: null, pickedAt: null } }
function bookValue(B, P, i, f = 'c') { let v = B.cash; for (const [s, n] of Object.entries(B.sh)) { const x = P.X[s]; const px = x ? x[f][i] : NaN; v += n * (Number.isFinite(px) ? px : (B.open[s] && B.open[s].last) || 0) } return v }
function step(B, P, i, { replay = false, onPick = null } = {}) {
  const t = P.t[i], R = RULE, ev = { picked: false, sold: [], bought: [] };
  if (i > 0 && monthOf(P.t[i]) !== monthOf(P.t[i - 1])) {
    const pk = picks(P, i - 1), E = bookValue(B, P, i, 'o'), want = {};
    for (const p of pk.list) { const px = P.X[p.sym].o[i]; if (Number.isFinite(px) && px > 0) want[p.sym] = E / R.K / px }
    for (const s of new Set([...Object.keys(B.sh), ...Object.keys(want)])) {
      const x = P.X[s], px = x ? x.o[i] : NaN; if (!Number.isFinite(px)) continue;
      const have = B.sh[s] || 0, d = (want[s] || 0) - have; if (Math.abs(d) < 1e-12) continue;
      const fee = Math.abs(d * px) * R.cost; B.cash -= d * px + fee;
      if (!have) { B.open[s] = { t0: t, avg: px, cost: 0, real: 0 }; ev.bought.push(s) }
      const o = B.open[s]; o.cost += fee; if (d > 0) o.avg = (o.avg * have + px * d) / (have + d); else if (want[s]) o.real += -d * (px - o.avg);   // trimmed: gain on the shares sold
      if (want[s]) { B.sh[s] = want[s]; o.score = (pk.list.find(p => p.sym === s) || {}).score; continue }
      B.trades.push({ sym: s, side: 1, t0: o.t0, t1: t, entry: o.avg, exit: px, pnl: have * (px - o.avg) + o.real - o.cost, why: pk.market ? 'monthly re-pick' : 'S&P 500 below its 200-day average', ...(replay ? { hist: true } : {}) });
      ev.sold.push(s); delete B.sh[s]; delete B.open[s];
    }
    B.picks = pk.list.map(p => ({ sym: p.sym, score: +p.score.toFixed(4) })); B.market = pk.market; B.pickedAt = t; ev.picked = true; ev.market = pk.market;
    if (onPick) onPick(ev, B);
  }
  for (const s of Object.keys(B.sh)) { const px = P.X[s] && P.X[s].c[i]; if (Number.isFinite(px)) B.open[s].last = px }
  B.lastI = i; B.lastT = t; return ev;
}
// money in (+) or out (-): cash first; taking out more than the cash sells part of every holding at the last close
function moveMoney(B, amount, P = null, i = null) {
  B.cash += amount; if (B.cash >= 0) return;
  const held = Object.keys(B.sh); if (!held.length) return;
  let v = 0; for (const s of held) v += B.sh[s] * B.open[s].last;
  const f = Math.min(1, -B.cash / v); for (const s of held) { const n = B.sh[s] * f; const o = B.open[s]; B.sh[s] -= n; B.cash += n * o.last; o.real += n * (o.last - o.avg) }
}
// positions in the bot's usual shape, for the dashboard and the desk
function positionsView(B) { const o = {}; for (const [s, n] of Object.entries(B.sh)) { const p = B.open[s];
  o[s] = { side: 1, qty: n, entry: p.avg, notional: n * p.last, lastPrice: p.last, t0: p.t0, score: p.score, model: 'momentum', pnl: n * (p.last - p.avg) + (p.real || 0) - p.cost } } return o }

// Replay / test: run the book over [fromT, end]; returns the value series and the book
function backtest(P, fromT, start = 10000) {
  const B = newBook(start), eqs = []; let pk = start, dd = 0;
  for (let i = 0; i < P.N; i++) { if (P.t[i] < fromT) continue; step(B, P, i, { replay: true }); const e = bookValue(B, P, i); pk = Math.max(pk, e); dd = Math.max(dd, 1 - e / pk); eqs.push([P.t[i], e]) }
  return { B, eqs, final: eqs.length ? eqs[eqs.length - 1][1] : start, dd };
}

module.exports = { RULE, TESTED, DAY, Panel, picks, newBook, bookValue, step, moveMoney, positionsView, backtest, monthOf };

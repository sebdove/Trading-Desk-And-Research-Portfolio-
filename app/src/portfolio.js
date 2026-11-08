// Desk portfolio: one pot of money shared by the bots. On the first day of each quarter the desk works out new shares:
//   1. a starting tilt:
//      - 3 bots (crypto, trend, stocks): fixed 40 / 40 / 20;
//      - 4 bots (with the paper momentum bot): half equal shares, half by each bot's record over the last year
//        (its return per unit of swing; a losing record counts as zero). Tested better than any fixed split chosen in advance;
//   2. then by how much each bot's account value has been swinging day to day over the last 120 days: calmer bots get more,
//      wilder ones less; no bot above 60%; a bot sitting in cash counts as swinging at least 1% a day.
// Paper bots then move the money at their next cycle; for real money the desk shows how much to move where.
// Tested 2020 to Nov 2026 from $10,000, typical of 20 runs (crypto bot with the Bitcoin 50-day rule, stock bot with 4 stocks):
//   3 bots: $125,457, worst drop 22% (worst run 25%);  4 bots: $140,726, worst drop 22% (worst run 22%), 2022 the only losing year.
'use strict';
const fs = require('fs');
const BOTS3 = ['crypto', 'trend', 'stocks'], BOTS4 = ['crypto', 'trend', 'stocks', 'momentum'];
const RULE = { tilt: { crypto: 0.4, trend: 0.4, stocks: 0.2 }, lookback: 120, floor: 0.01, cap: 0.6, everyMonths: 3, minDays: 20, record: { look: 365, mix: 0.5, minDays: 60 } };
const TESTED = { from: '2020-01-01', desk: { typical: 125457, dd: 22, worstRun: 25, full: 157648, fullDD: 22 }, desk4: { typical: 140726, dd: 22, worstRun: 22, years: { 2020: 139.5, 2021: 107.2, 2022: -11.2, 2023: 49, 2024: 39.6, 2025: 13.5, 2026: 31.3 } },
  fixed: { typical: 103070, dd: 23 }, cryptoAlone: { typical: 95138, dd: 47 }, combined: { typical: 104004, dd: 34 }, hindsight: { typical: 129841, dd: 22 } };
const DAY = 86400;
const quarterKey = (t = Date.now()) => { const d = new Date(t); return `${d.getUTCFullYear()}-Q${Math.floor(d.getUTCMonth() / 3) + 1}` };
const botsOf = series => (series && series.momentum !== undefined ? BOTS4 : BOTS3);

// one value per UTC day (the last one), carried forward over days a bot did not report (stocks at weekends)
function dailyTable(series, bots = botsOf(series)) {
  const maps = {}, all = new Set();
  for (const b of bots) { const m = new Map(); for (const [t, v] of series[b] || []) { const d = Math.floor(t / DAY); m.set(d, v); all.add(d) } maps[b] = m }
  const days = [...all].sort((a, b) => a - b), last = {}, rows = [];
  for (const d of days) { for (const b of bots) if (maps[b].has(d)) last[b] = maps[b].get(d); if (bots.every(b => last[b] != null)) rows.push([d, bots.map(b => last[b])]) }
  return rows;
}
const rets = (use, j) => { const r = []; for (let i = 1; i < use.length; i++) r.push(use[i][1][j] / use[i - 1][1][j] - 1); return r };
const meanSd = r => { let s = 0, s2 = 0; for (const x of r) { s += x; s2 += x * x } const mu = s / r.length; return [mu, Math.sqrt(Math.max(0, s2 / r.length - mu * mu))] };
// daily ups and downs over the last `lookback` days (the last lookback+1 daily changes, as tested), never below `floor`
function swings(rows, bots, R = RULE) {
  const use = rows.slice(-(R.lookback + 2)); if (use.length < R.minDays + 1) return null;
  return bots.map((b, j) => Math.max(R.floor, meanSd(rets(use, j))[1]));
}
// the starting tilt: fixed for 3 bots; for 4, half equal and half by last year's record
function tilt(rows, bots, R = RULE) {
  if (bots.length === 3) return bots.map(b => R.tilt[b]);
  const k = bots.length, eq = bots.map(() => 1 / k), use = rows.slice(-(R.record.look + 2)); if (use.length < R.record.minDays + 1) return eq;
  const sc = bots.map((b, j) => { const [mu, sd] = meanSd(rets(use, j)); return Math.max(0, mu / Math.max(sd, 1e-6)) }), tot = sc.reduce((a, b) => a + b, 0);
  return bots.map((b, j) => (1 - R.record.mix) / k + R.record.mix * (tot > 0 ? sc[j] / tot : 1 / k));
}
// the shares for the coming quarter: tilt / swings, scaled to 100%, no bot above the cap (the excess goes to the others)
function shares(series, R = RULE, bots = botsOf(series)) {
  const rows = dailyTable(series, bots), v = swings(rows, bots, R), tl = tilt(rows, bots, R); let t = tl.slice();
  if (v) { const raw = t.map((x, j) => x / v[j]), tot = raw.reduce((a, b) => a + b, 0); t = raw.map(x => x / tot) }
  for (let it = 0; it < 5; it++) { const ex = t.reduce((a, x) => a + Math.max(0, x - R.cap), 0); if (ex < 1e-9) break; const under = t.reduce((a, x) => a + (x < R.cap ? x : 0), 0); t = t.map(x => x >= R.cap ? R.cap : under > 0 ? x + ex * x / under : x) }
  const o = a => Object.fromEntries(bots.map((b, j) => [b, +a[j].toFixed(4)]));
  return { shares: o(t), tilt: o(tl), swings: v ? Object.fromEntries(bots.map((b, j) => [b, +v[j].toFixed(5)])) : null };
}
// how much to move: positive = money into that bot
function plan(values, sh) {
  const bots = Object.keys(sh), total = bots.reduce((a, b) => a + (values[b] || 0), 0);
  return { total, target: Object.fromEntries(bots.map(b => [b, +(total * sh[b]).toFixed(2)])), move: Object.fromEntries(bots.map(b => [b, +(total * sh[b] - (values[b] || 0)).toFixed(2)])) };
}
// the desk's value over time: the bots added together, day by day
function mergeEquity(series, bots = botsOf(series)) { return dailyTable(series, bots).map(([d, v]) => [d * DAY, +v.reduce((a, b) => a + b, 0).toFixed(2), ...v.map(x => +x.toFixed(2))]) }

// Research check: run the rule on daily value series (arrays of the same length) and return the end value and worst drop.
// track: also return the desk's value each day (curve, starting at 1) and each quarter's split (splits).
function simulate(days, curves, R = RULE, bots = Object.keys(curves), { track = false } = {}) {
  const n = days.length, month = days.map(d => { const t = new Date(d * DAY * 1000); return t.getUTCFullYear() * 12 + t.getUTCMonth() });
  let v = bots.length === 3 ? bots.map(b => R.tilt[b]) : bots.map(() => 1 / bots.length), pk = 1, dd = 0, k = 0;
  const curve = track ? [[days[0], 1]] : null, splits = track ? [{ d: days[0], shares: Object.fromEntries(bots.map((b, j) => [b, +v[j].toFixed(4)])) }] : null;
  for (let i = 1; i < n; i++) {
    v = v.map((x, j) => x * curves[bots[j]][i] / curves[bots[j]][i - 1]);
    const e = v.reduce((a, b) => a + b, 0); pk = Math.max(pk, e); dd = Math.max(dd, 1 - e / pk);
    if (month[i] !== month[i - 1] && ++k % R.everyMonths === 0) {
      const lo = Math.max(0, i - Math.max(R.lookback, R.record.look) - 1), ser = {}; for (const b of bots) ser[b] = []; for (let q = lo; q <= i; q++) for (const b of bots) ser[b].push([days[q] * DAY, curves[b][q]]);
      const sh = shares(ser, { ...R, minDays: 1 }, bots).shares; v = bots.map(b => e * sh[b]);
      if (track) splits.push({ d: days[i], value: e, shares: sh });
    }
    if (track) curve.push([days[i], e]);
  }
  return { final: v.reduce((a, b) => a + b, 0), dd, ...(track ? { curve, splits, parts: Object.fromEntries(bots.map((b, j) => [b, v[j]])) } : {}) };
}
// The desk's history since 2020 from the bots' own since-2020 replays (the method of the tests): each bot's daily value,
// re-split each quarter by the rule. Returns null unless every bot's history starts by mid-January 2020.
function deskSince(series, bots, total, from = Date.UTC(2020, 0, 1) / 1000) {
  const rows = dailyTable(series, bots).filter(([d]) => d >= Math.floor(from / DAY)); if (rows.length < 30) return null;
  for (const b of bots) { const S = series[b] || []; if (!S.length || S[0][0] > from + 15 * DAY) return null }
  const days = rows.map(r => r[0]), curves = Object.fromEntries(bots.map((b, j) => [b, rows.map(r => r[1][j])]));
  const r = simulate(days, curves, RULE, bots, { track: true });
  return { from: days[0] * DAY, to: days[days.length - 1] * DAY, total: total * r.final, dd: r.dd, curve: r.curve.map(([d, e]) => [d * DAY, +(e * total).toFixed(2)]),
    splits: r.splits.map(x => ({ t: x.d * DAY, value: x.value != null ? +(x.value * total).toFixed(2) : total, shares: x.shares })), parts: Object.fromEntries(Object.entries(r.parts).map(([b, x]) => [b, x * total])) };
}
const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')) } catch { return null } };
module.exports = { BOTS: BOTS3, BOTS3, BOTS4, RULE, TESTED, quarterKey, dailyTable, swings, tilt, shares, plan, mergeEquity, simulate, deskSince, readJson, botsOf };

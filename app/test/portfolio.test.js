// Desk portfolio: quarterly shares by recent swings (2.0.0).
const test = require('node:test'), assert = require('node:assert'), PF = require('../src/portfolio'), CORE = require('../src/core');
const DAY = 86400, t0 = Date.UTC(2026, 0, 1) / 1000;
const walk = (n, vol, seed) => { let v = 1000, x = seed; const o = []; for (let i = 0; i < n; i++) { x = (x * 9301 + 49297) % 233280; v *= 1 + vol * (x / 233280 - 0.5) * 3.46; o.push([t0 + i * DAY, v]) } return o };
test('calmer bots get more, nobody above 60%, a bot in cash counts as swinging 1% a day', () => {
  const ser = { crypto: walk(200, 0.04, 1), trend: walk(200, 0.02, 2), stocks: walk(200, 0.01, 3) }, { shares: s, swings: v } = PF.shares(ser);
  assert.ok(Math.abs(s.crypto + s.trend + s.stocks - 1) < 1e-3);
  assert.ok(s.crypto < s.trend, JSON.stringify(s)); assert.ok(Object.values(s).every(x => x <= 0.6 + 1e-9));
  const flat = PF.shares({ crypto: walk(200, 0.0, 1), trend: walk(200, 0.02, 2), stocks: walk(200, 0.01, 3) });
  assert.equal(flat.swings.crypto, 0.01);
});
test('too little history: the starting tilt; plan moves add up to nothing', () => {
  const s = PF.shares({ crypto: walk(10, 0.03, 1), trend: walk(10, 0.02, 2), stocks: walk(10, 0.01, 3) }).shares;
  assert.deepEqual(s, { crypto: 0.4, trend: 0.4, stocks: 0.2 });
  const p = PF.plan({ crypto: 5000, trend: 3000, stocks: 2000 }, { crypto: 0.3, trend: 0.5, stocks: 0.2 });
  assert.deepEqual(p.move, { crypto: -2000, trend: 2000, stocks: 0 }); assert.equal(p.total, 10000);
  assert.equal(PF.quarterKey(Date.UTC(2026, 10, 7)), '2026-Q4');
});
test('stocks reporting only on weekdays are carried over weekends', () => {
  const st = walk(200, 0.01, 3).filter(([t]) => ![0, 6].includes(new Date(t * 1000).getUTCDay()));
  const rows = PF.dailyTable({ crypto: walk(200, 0.03, 1), trend: walk(200, 0.02, 2), stocks: st });
  assert.ok(rows.length >= 197); const eq = PF.mergeEquity({ crypto: walk(200, 0.03, 1), trend: walk(200, 0.02, 2), stocks: st }); assert.ok(eq[eq.length - 1][1] > 0);
});
test('Bitcoin 50-day rule: yesterday\'s close against the 50-day average of complete days', () => {
  const B = { t: [], c: [] }; for (let d = 0; d < 80; d++) for (let b = 0; b < 6; b++) { B.t.push(d * DAY + b * 14400); B.c.push(d < 70 ? 100 : d < 75 ? 120 : 50) }
  assert.equal(CORE.benchAbove50(B, 74 * DAY), true);       // day 73 closed at 120, above the average
  assert.equal(CORE.benchAbove50(B, 76 * DAY + 3 * 14400), false);   // day 75 closed at 50
  assert.equal(CORE.benchAbove50(B, 30 * DAY), false);      // not enough days yet
});
test('desk since 2020: the replayed desk history follows the tested rule and ends with today\'s split', () => {
  const PF = require('../src/portfolio'), D = 86400, t0 = Date.UTC(2020, 0, 1) / 1000, ser = {}, { rng } = require('./synth'), r = rng(3);
  for (const [b, v] of [['crypto', 0.04], ['trend', 0.03], ['stocks', 0.012], ['momentum', 0.035]]) { let e = 2500; ser[b] = []; for (let i = 0; i < 900; i++) { e *= 1 + 0.001 + v * (r() - 0.5); ser[b].push([t0 + i * D, e]) } }
  const S = PF.deskSince(ser, PF.BOTS4, 10000), rows = PF.dailyTable(ser, PF.BOTS4), days = rows.map(x => x[0]), curves = Object.fromEntries(PF.BOTS4.map((b, j) => [b, rows.map(x => x[1][j])]));
  const sim = PF.simulate(days, curves, PF.RULE, PF.BOTS4);
  assert.ok(Math.abs(S.total - 10000 * sim.final) < 1e-6 && Math.abs(S.dd - sim.dd) < 1e-12);
  assert.ok(Math.abs(Object.values(S.parts).reduce((a, b) => a + b, 0) - S.total) < 1e-6);
  assert.equal(S.curve[0][1], 10000); assert.ok(Math.abs(S.curve[S.curve.length - 1][1] - S.total) < 0.01);
  assert.ok(S.splits.length >= 9);                                       // the start plus one every quarter
  const late = { ...ser, trend: ser.trend.slice(60) }; assert.equal(PF.deskSince(late, PF.BOTS4, 10000), null);   // a bot without a since-2020 history: no replayed desk
});

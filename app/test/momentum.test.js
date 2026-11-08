// Momentum bot (paper): the live day-by-day loop gives exactly the backtest; weekly schedule; desk transfers keep shares.
const test = require('node:test'), assert = require('node:assert'), MO = require('../src/momentum'), { memStore } = require('./helpers'), { rng } = require('./synth');
const DAY = 86400;
function market(n0, n, coins = 30) { const r = rng(5), data = {};
  for (let i = 0; i < coins; i++) { const S = { d: [], c: [], q: [] }, f = new Map(); let p = 10 + i, drift = (r() - 0.5) * 0.01; const start = n0 + (i % 7) * 15;
    for (let d = start; d < n0 + n; d++) { if (d % 50 === 0) drift = (r() - 0.5) * 0.01; p *= 1 + drift + (r() - 0.5) * 0.06; S.d.push(d); S.c.push(p); S.q.push(3e6 * (1 + i % 5) * (0.5 + r())); f.set(d, (r() - 0.3) * 0.0006) }
    data[`C${i}USDT`] = { S, f } }
  return data }
test('live loop, one day at a time, = backtest (incl. funding and re-balance costs)', async () => {
  const n0 = Date.UTC(2025, 0, 1) / 1000 / DAY, n = 260, data = market(n0, n), P = new MO.Panel();
  for (const [s, { S, f }] of Object.entries(data)) { P.addCoin(s, S); P.setFunding(s, f) }
  const a = n0 + 120; let z = n0 + n - 2; while (MO.isRebalanceDay(z)) z--;
  const bt = MO.backtest(P, a, z, 10000);
  assert.ok(bt.eqs.length > 100 && Math.abs(bt.final - 10000) > 1);
  const cut = (S, today) => { const o = { d: [], c: [], q: [] }; for (let i = 0; i < S.d.length; i++) if (S.d[i] < today) { o.d.push(S.d[i]); o.c.push(S.c[i]); o.q.push(S.q[i]) } return o };
  let today = 0; const feed = { coins: async () => Object.keys(data), daily: async (s, from) => cut(data[s].S, today), funding: async (s, a0, b0) => new Map([...data[s].f].filter(([d]) => d < today)) };
  const bot = new MO.MomentumBot({ startCash: 10000 }, { feed, store: memStore(), log: () => {} }), now = Date.now;
  try {
    for (today = a + 1; today <= z + 1; today++) { Date.now = () => today * DAY * 1000 + 3600e3; await bot.cycle({ startDay: a }) }
  } finally { Date.now = now }
  assert.ok(Math.abs(bot.state.equity - bt.final) < 1e-6, `${bot.state.equity} vs ${bt.final}`);
  assert.equal(bot.state.day, z);
  assert.ok(bot.state.rebalances.length >= 10 && bot.state.trades.length > 10);
  const longs = Object.values(bot.state.pos).filter(x => x > 0).length, shorts = Object.values(bot.state.pos).filter(x => x < 0).length;
  assert.ok(longs <= 10 && shorts <= 10 && longs + shorts > 0);
});
test('re-balance days follow the tested weekly schedule (from 1 Jan 2020)', () => {
  const d0 = Date.UTC(2020, 0, 1) / 1000 / DAY; assert.ok(MO.isRebalanceDay(d0) && MO.isRebalanceDay(d0 + 7 * 300) && !MO.isRebalanceDay(d0 + 3) && MO.isRebalanceDay(d0 - 7));
});
test("a desk transfer moves money in or out and keeps each position's share of the account", () => {
  const fs = require('fs'), os = require('os'), path = require('path'), f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mo-')), 't.json');
  fs.writeFileSync(f, JSON.stringify({ id: 'q1', amount: -2500 }));
  const bot = new MO.MomentumBot({ startCash: 10000, transferFile: f }, { feed: {}, store: memStore(), log: () => {} });
  bot.state.pos = { AUSDT: 5000, BUSDT: -5000 }; bot.applyTransfer(); bot.applyTransfer();
  assert.equal(bot.state.equity, 7500); assert.deepEqual(bot.state.pos, { AUSDT: 3750, BUSDT: -3750 });
});
test('download cache: a second run reads the kept candles and funding and only asks for what is new', async () => {
  const fs = require('fs'), os = require('os'), path = require('path'), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moc-'));
  const today = Math.floor(Date.now() / 1000 / DAY), calls = [];
  const client = { req: async (base, p, { params }) => { calls.push(p);
    if (p === '/fapi/v1/klines') { const out = []; for (let d = Math.floor(params.startTime / 1000 / DAY); d <= today && out.length < params.limit; d++) out.push([d * DAY * 1000, '1', '1', '1', String(100 + d % 7), '0', (d + 1) * DAY * 1000 - 1, '5e6']); return out }
    if (p === '/fapi/v1/fundingRate') { const out = []; for (let t = Math.ceil(params.startTime / 288e5) * 288e5; t <= params.endTime && out.length < params.limit; t += 288e5) out.push({ fundingTime: t, fundingRate: '0.0001' }); return out } } };
  const f1 = new MO.MomentumFeed(client, { cacheDir: dir }), a = await f1.daily('XUSDT', today - 400), fa = await f1.funding('XUSDT', today - 400, today - 1);
  const n1 = calls.length, f2 = new MO.MomentumFeed(client, { cacheDir: dir }), b = await f2.daily('XUSDT', today - 300), fb = await f2.funding('XUSDT', today - 300, today - 1);
  assert.equal(calls.length, n1, 'nothing new to ask for');
  assert.deepEqual(b.d, a.d.filter(d => d >= today - 300)); assert.equal(a.d[a.d.length - 1], today - 1);
  assert.ok(Math.abs(fb.get(today - 2) - 0.0003) < 1e-12 && fa.size >= 399 && fb.size >= 299);
});

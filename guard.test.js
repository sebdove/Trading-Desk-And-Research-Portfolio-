const test = require('node:test'), assert = require('node:assert');
const GUARD = require('../src/guard'), CORE = require('../src/core'), Bot = require('../src/bot'), BT = require('../src/backtest'), PaperBroker = require('../src/brokers/paper');
const { MockFeed, memStore, market } = require('./helpers');
const DAY = 86400;
// 600 days of a steady rise, a 50% fall over 120 days, then a recovery
const path = () => { const c = []; let p = 100; for (let i = 0; i < 600; i++) { p *= 1.0015 * (1 + 0.012 * Math.sin(i * 1.7)); c.push(p) } for (let i = 0; i < 120; i++) { p *= 0.9943; c.push(p) } for (let i = 0; i < 300; i++) { p *= 1.004; c.push(p) } return c };
test('burst guard: out in the fall, back in on the recovery, fast re-entry first', () => {
  const c = path(), D = { d: c.map((_, i) => 18000 + i), c }, G = GUARD.compute(D, { kind: 'vol' });
  const outs = G.events.filter(e => e.type === 'out'), ins = G.events.filter(e => e.type === 'in');
  assert.ok(outs.length >= 1 && outs[0].day > 18600 && outs[0].day < 18720, 'exits during the fall');
  assert.ok(ins.length >= 1 && ins[ins.length - 1].day > 18720, 'back in during the recovery');
  const slow = GUARD.compute(D, { kind: 'vol', fast: false }), lastIn = g => g.events.filter(e => e.type === 'in').slice(-1)[0].day;
  assert.ok(lastIn(G) <= lastIn(slow), 'fast re-entry is never later');
  assert.equal(GUARD.outAt(G, (outs[0].day + 1) * DAY), true, 'out applies from the close of the exit day');
  assert.equal(GUARD.outAt(G, outs[0].day * DAY), false, 'not before that close');
});
test('burst guard: S&P warning window (score 65+ in the last 12 months or curve inverted in the last 18)', () => {
  const mon = { start: '2020-01', froth: Array(36).fill(50), gs10: Array(36).fill(3), tb3: Array(36).fill(1) };
  mon.froth[5] = 70;                                                   // June 2020
  const w = GUARD.spWarning(mon), day = s => Date.parse(s) / 1000 / DAY;
  assert.equal(w(day('2020-06-15')), false); assert.equal(w(day('2020-07-15')), true); assert.equal(w(day('2021-06-15')), true); assert.equal(w(day('2021-07-15')), false);
  mon.froth[5] = 50; mon.tb3[10] = 4;                                  // curve inverted November 2020
  const w2 = GUARD.spWarning(mon); assert.equal(w2(day('2020-12-10')), true); assert.equal(w2(day('2022-05-10')), true); assert.equal(w2(day('2022-06-10')), false);
});
test('burst guard in the bot: off changes nothing, on sells longs, blocks buys and runs the paper guard short', async () => {
  const P = { ...CORE.PRESETS.crypto, tf: DAY, minLiq: 1e5, regime: 0 }, { data } = market(1020, DAY, 6), c = path();
  const bench = { t: c.map((_, i) => (17400 + i) * DAY), o: c, h: c.map(x => x * 1.002), l: c.map(x => x * 0.998), c, q: c.map(() => 5e8) };
  for (const S of Object.values(data)) S.t = bench.t.slice(0, S.t.length);
  const run = async cfg => { const feed = new MockFeed(data, bench), bot = new Bot({ ...P, ...cfg }, { broker: new PaperBroker({ startCash: 10000 }), feed, store: memStore(), log: () => {} });
    const seen = []; for (let i = 300; i < 1020; i++) { feed.at(bench.t[i]); await bot.cycle(); const g = bot.state.meta.guard; seen.push({ out: g && g.out, longs: Object.values(bot.state.positions).filter(p => p.side > 0).length, short: Object.values(bot.state.positions).some(p => p.guard) }) } return { bot, seen } };
  const off = await run({}), on = await run({ burstGuard: 'on', burstShort: true, burstShortShare: 0.33 });
  assert.ok(off.seen.some(s => s.out), 'the guard is worked out even when off');
  assert.ok(!off.bot.state.trades.some(t => /burst guard/.test(t.why)), 'off: no guard trades');
  const outBars = on.seen.filter(s => s.out);
  assert.ok(outBars.length > 0 && outBars.every(s => s.longs === 0), 'on: no long positions while out');
  assert.ok(outBars.some(s => s.short), 'on: the guard short is opened while out');
  assert.ok(on.bot.state.trades.some(t => t.guard && /back in|stop/.test(t.why)), 'on: the guard short is closed');
});
test('burst guard in the backtest: no positions opened while out', () => {
  const P = { ...CORE.PRESETS.crypto, tf: DAY, minLiq: 1e5, regime: 0 }, { data } = market(1020, DAY, 6), c = path();
  const bench = { t: c.map((_, i) => (17400 + i) * DAY), o: c, h: c.map(x => x * 1.002), l: c.map(x => x * 0.998), c, q: c.map(() => 5e8) };
  for (const S of Object.values(data)) S.t = bench.t.slice(0, S.t.length);
  const G = GUARD.compute(GUARD.daily(bench, DAY)), r = BT.backtest({ ...P, guard: G, guardShort: 0.33 }, data, bench, DAY);
  for (const t of r.trades.filter(x => !x.guard)) assert.equal(GUARD.outAt(G, t.t0 + DAY), false, 'entry while out');
  assert.ok(r.trades.some(t => t.guard), 'the guard short traded');
});
test('burst guard matches the research version on the S&P 500, 2007-09 (bundled Bubble Watch data)', () => {
  const zlib = require('zlib'), fs = require('fs'), MODEL = require('../src/bubble/model');
  const raw = JSON.parse(zlib.gunzipSync(fs.readFileSync(require('path').join(__dirname, '..', 'data', 'bubble-seed.json.gz'))));
  const page = MODEL.toPage(MODEL.compute(raw), raw), y = raw.yahoo['^GSPC'], G = GUARD.compute({ d: y.d, c: y.c }, { kind: 'sp', warned: GUARD.spWarning(page.mon) });
  const ev = G.events.filter(e => e.day >= 13514 && e.day < 14610).map(e => new Date(e.day * DAY * 1000).toISOString().slice(0, 10) + ' ' + e.type);
  assert.deepEqual(ev, ['2007-08-15 out', '2007-09-18 in', '2007-11-19 out', '2008-08-11 in', '2008-08-12 out', '2008-12-16 in', '2008-12-17 out', '2009-03-23 in']);
});

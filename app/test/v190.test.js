// 1.9.0 crypto changes: profit stop (v3a), 50-day rule, Bitcoin filter without look-ahead, the bot's coin list in the backtest.
const test = require('node:test'), assert = require('node:assert');
const CORE = require('../src/core'), BT = require('../src/backtest'), Bot = require('../src/bot'), PaperBroker = require('../src/brokers/paper');
const { BinanceClient, BinanceBroker } = require('../src/brokers/binance');
const { MockFeed, memStore } = require('./helpers');
const { series, rng } = require('./synth');
const DAY = 86400, H4 = 14400;

test('profit stop: remembers the best close, arms only below 35% breadth and 2x risk up, and only ever raises the stop', () => {
  const pos = { side: 1, entry: 100, risk: 10, stop: 90, best: 100 };
  assert.equal(CORE.profitStop(pos, { close: 125 }, 2, 0.5), null);         // breadth too high: best remembered, stop unchanged
  assert.equal(pos.best, 125); assert.equal(pos.stop, 90);
  assert.equal(CORE.profitStop(pos, { close: 115 }, 2, 0.2), 119);           // 2.5x up at the best close: 125 - 3 x 2
  assert.equal(pos.stop, 119); assert.equal(pos.stopWhy, 'profit stop');
  assert.equal(CORE.profitStop(pos, { close: 118 }, 4, 0.2), null);          // wider ATR would lower it: never moves down
  assert.equal(pos.stop, 119);
  const p2 = { side: 1, entry: 100, risk: 10, stop: 90, best: 100 };
  assert.equal(CORE.profitStop(p2, { close: 115 }, 1, 0.1), null);           // only 1.5x up: not armed
  assert.equal(CORE.profitStop(p2, { close: 120 }, 1, null), null);          // no breadth reading: off
  assert.deepEqual(CORE.checkExit({ side: 1, stop: 119, stopWhy: 'profit stop' }, { open: 120, high: 121, low: 118, close: 118.5 }, 50, { exit: 10 }), { px: 119, why: 'profit stop' });
});

test('Bitcoin filter: uses only the close known at the bar, not the rest of the day', () => {
  const B = { t: [], o: [], h: [], l: [], c: [] };
  for (let d = 0; d < 260; d++) for (let b = 0; b < 6; b++) { const t = d * DAY + b * H4; let px = d < 259 ? 100 : (b < 5 ? 99 : 130); B.t.push(t); B.o.push(px); B.h.push(px); B.l.push(px); B.c.push(px) }
  assert.equal(CORE.benchAbove(B, 259 * DAY), false);                         // morning of the last day: 99 < average (the old code saw the 130 close)
  assert.equal(CORE.benchAbove(B, 259 * DAY + 5 * H4), true);                 // the last bar of that day closes at 130
  assert.equal(CORE.benchAbove(B, 150 * DAY), null);                          // not enough history
});

test('coin list: the N most traded of the last 24 hours, stablecoins and leveraged tokens left out', () => {
  const mk = (q) => { const S = { t: [], o: [], h: [], l: [], c: [], q: [] }; for (let i = 0; i < 18; i++) { S.t.push(DAY + i * H4); for (const k of ['o', 'h', 'l', 'c']) S[k].push(1); S.q.push(q) } return S };
  const sets = CORE.dailyUniverse({ AUSDT: mk(5e6), BUSDT: mk(4e6), CUSDT: mk(1e5), USDCUSDT: mk(9e9), RLUSDUSDT: mk(9e9), BTCUPUSDT: mk(9e9), DUSDT: mk(3e6) }, 2, 2e6);
  assert.deepEqual([...sets.get(2)], ['AUSDT', 'BUSDT']);
  assert.ok(CORE.STABLE.test('XUSDUSDT') && CORE.STABLE.test('BFUSDUSDT') && !CORE.STABLE.test('SOLUSDT'));
});

test('50-day rule: no buys of a coin below its 50-day average', () => {
  const S = series(5, 400, H4, { q: 5e6 }), u = BT.prepare('X', S, H4); u.k = 399;
  const M = { entry: 30, exit: 10, stopK: 2.5, reentry: 1, longOnly: 1 };
  u.s = Float32Array.from(u.s); u.s[398] = 50; u.s[399] = 50;
  const P = { ...CORE.DEFAULTS, regime: 0, minLiq: 0 };
  const above = u.bars[399].close > u.d50[399];
  assert.equal(CORE.candidates({ ...P, trendRule: 'off' }, M, [u], null, new Set()).length, 1);
  assert.equal(CORE.candidates({ ...P, trendRule: 'on' }, M, [u], null, new Set()).length, above ? 1 : 0);
  u.d50 = u.d50.map(() => 1e9); assert.equal(CORE.candidates({ ...P, trendRule: 'on' }, M, [u], null, new Set()).length, 0);
});

// coins that swing up and down in long waves, so trades reach 2x their risk and the profit stop gets used
function wave(seed, n, { period = 300, amp = 0.5, vol = 0.01, price = 20, q = 5e6, phase = 0 } = {}) { const r = rng(seed), S = { t: [], o: [], h: [], l: [], c: [], q: [] }; let prev = price;
  for (let i = 0; i < n; i++) { const p = price * Math.exp(amp * Math.sin(2 * Math.PI * (i + phase) / period) + vol * (r() - 0.5) * 3); const o = prev, hi = Math.max(o, p) * (1 + vol * r()), lo = Math.min(o, p) * (1 - vol * r());
    S.t.push(1577836800 + i * H4); S.o.push(o); S.h.push(hi); S.l.push(lo); S.c.push(p); S.q.push(q * (0.5 + r())); prev = p } return S }
test('live bot = backtest with the profit stop and the 50-day rule working (crypto preset, 24 coins)', async () => {
  const n = 1800, start = 1350, data = {};
  for (let i = 0; i < 24; i++) data[`C${i}USDT`] = wave(i + 11, n, { period: 240 + 13 * i, phase: 37 * i, price: 10 + i, q: 3e6 * (1 + i % 6) });
  const bench = series(77, n, H4, { drift: 0.0005, q: 5e9 });
  const P = { ...CORE.PRESETS.crypto, minLiq: 1e5 }, from = bench.t[start];
  const bt = BT.backtest({ ...P, start: 10000, from }, data, bench, H4);
  const feed = new MockFeed(data, bench), broker = new PaperBroker({ startCash: 10000, fee: P.fee, impK: P.impK });
  const bot = new Bot({ ...P }, { broker, feed, store: memStore(), log: () => {} });
  for (let i = start; i < n; i++) { feed.at(bench.t[i]); await bot.cycle() }
  const a = bt.trades.map(x => `${x.sym}|${x.t0}|${x.t1}|${x.why}|${x.pnl.toFixed(4)}`), b = bot.state.trades.map(x => `${x.sym}|${x.t0}|${x.t1}|${x.why}|${x.pnl.toFixed(4)}`);
  assert.ok(a.filter(x => x.includes('|profit stop|')).length >= 3, `expected profit-stop exits, got ${a.filter(x => x.includes('profit stop')).length} of ${a.length}`);
  assert.deepEqual(b, a);
  assert.ok(Math.abs(bot.state.lastEquity - bt.final) < 1e-6);
  const off = BT.backtest({ ...P, start: 10000, from, profitStop: 'off', trendRule: 'off' }, data, bench, H4);
  assert.ok(!off.trades.some(x => x.why === 'profit stop'));
  assert.notDeepEqual(off.trades.map(x => x.sym + x.t0 + x.why), bt.trades.map(x => x.sym + x.t0 + x.why));
});

test('a position bought before 1.9.0 gets its risk and best close worked out from the candles', async () => {
  const keep = CORE.PROFIT_STOP.below; CORE.PROFIT_STOP.below = 1.01;
  try {
    const n = 1500, data = {}; for (let i = 0; i < 22; i++) data[`C${i}USDT`] = series(300 + i, n, H4, { price: 10 + i, q: 3e6 });
    const bench = series(9, n, H4, { q: 5e9 }), S = data.C0USDT, k0 = 1400, k1 = 1470;         // consensus still +10 or more at k1, so it is held
    let hi = S.c[k0]; for (let j = k0 + 1; j < k1; j++) hi = Math.max(hi, S.c[j]);
    const entry = S.c[k0], stop = entry * 0.6;                                // risk 40% so 2x up is unlikely: only best/risk are checked
    const store = memStore(); store.s = { peak: 10000, positions: { C0USDT: { side: 1, entry, qty: 10, notional: 10 * entry, stop, t0: S.t[k0], lastPrice: entry } }, trades: [], lastBar: null };
    const broker = new PaperBroker({ startCash: 10000 - 10 * entry }); broker.positions.C0USDT = { qty: 10, side: 1, entry, notional: 10 * entry, imp: 0, t0: S.t[k0] };
    const feed = new MockFeed(data, bench), bot = new Bot({ ...CORE.PRESETS.crypto, minLiq: 1e5, slots: 1 }, { broker, feed, store, log: () => {} });
    feed.at(S.t[k1]); await bot.cycle();
    const p = bot.state.positions.C0USDT;
    assert.ok(p, 'position still held'); assert.ok(Math.abs(p.risk - (entry - stop)) < 1e-9); assert.equal(p.best, Math.max(hi, S.c[k1]))
  } finally { CORE.PROFIT_STOP.below = keep }
});

function fakeFetch(routes) {
  const calls = [];
  const f = async (url, opt = {}) => { calls.push({ url, method: opt.method || 'GET' });
    for (const [re, fn] of routes) if (re.test((opt.method || 'GET') + ' ' + url)) { const { status = 200, body } = fn(url, opt); return { ok: status < 300, status, headers: { get: () => null }, json: async () => body, text: async () => JSON.stringify(body) } }
    throw new Error('unexpected request ' + url) };
  f.calls = calls; return f;
}
const EX = { symbols: [{ symbol: 'SOLUSDT', filters: [{ filterType: 'LOT_SIZE', stepSize: '0.00100000' }, { filterType: 'PRICE_FILTER', tickSize: '0.01000000' }, { filterType: 'NOTIONAL', minNotional: '5' }] }] };
test('Binance: the profit stop cancels the old stop order and rests a new, higher one', async () => {
  global.fetch = fakeFetch([[/GET .*exchangeInfo/, () => ({ body: EX })], [/DELETE .*\/api\/v3\/order\?.*orderId=42/, () => ({ body: { status: 'CANCELED' } })], [/POST .*STOP_LOSS_LIMIT/, () => ({ body: { orderId: 43 } })]]);
  const r = await new BinanceBroker(new BinanceClient({ key: 'k', secret: 's', spacingMs: 0 })).moveStop({ sym: 'SOLUSDT', qty: 9.99, stopOrderId: 42, stop: 171.236, oldStop: 135.12 });
  assert.deepEqual(r, { id: 43, ok: true });
  const post = fetch.calls.find(c => c.method === 'POST'); assert.match(post.url, /stopPrice=171\.23/); assert.match(post.url, /quantity=9\.990/);
});
test('Binance: if the new stop is refused, the old one goes back on', async () => {
  let n = 0;
  global.fetch = fakeFetch([[/GET .*exchangeInfo/, () => ({ body: EX })], [/DELETE .*\/api\/v3\/order/, () => ({ body: { status: 'CANCELED' } })],
    [/POST .*STOP_LOSS_LIMIT/, url => (n++ === 0 ? { status: 400, body: { code: -2010, msg: 'Stop price would trigger immediately.' } } : { body: { orderId: 44 } })]]);
  const r = await new BinanceBroker(new BinanceClient({ key: 'k', secret: 's', spacingMs: 0 })).moveStop({ sym: 'SOLUSDT', qty: 9.99, stopOrderId: 42, stop: 171.2, oldStop: 135.12 });
  assert.equal(r.id, 44); assert.equal(r.ok, false); assert.match(r.note, /old stop put back/);
  assert.match(fetch.calls.filter(c => c.method === 'POST')[1].url, /stopPrice=135\.12/);
});
test('Binance: an old stop that already sold is left alone', async () => {
  global.fetch = fakeFetch([[/GET .*exchangeInfo/, () => ({ body: EX })], [/DELETE .*\/api\/v3\/order/, () => ({ status: 400, body: { code: -2011, msg: 'Unknown order sent.' } })], [/GET .*\/api\/v3\/order\?/, () => ({ body: { status: 'FILLED' } })]]);
  const r = await new BinanceBroker(new BinanceClient({ key: 'k', secret: 's', spacingMs: 0 })).moveStop({ sym: 'SOLUSDT', qty: 9.99, stopOrderId: 42, stop: 171.2, oldStop: 135.12 });
  assert.equal(r.id, 42); assert.equal(r.ok, false); assert.match(r.note, /already sold/);
  assert.equal(fetch.calls.filter(c => c.method === 'POST').length, 0);
});

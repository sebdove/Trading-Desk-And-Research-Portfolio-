// Starting without the wait: head-start replay (paper), the catch-up cycle, and enough Bitcoin history for the 200-day filter.
const test = require('node:test'), assert = require('node:assert');
const CORE = require('../src/core'), Bot = require('../src/bot'), PaperBroker = require('../src/brokers/paper'), headStart = require('../src/headstart');
const { BinanceClient, BinanceFeed } = require('../src/brokers/binance');
const { MockFeed, memStore, market } = require('./helpers');

const P = { ...CORE.applyStockSlots({ ...CORE.DEFAULTS, ...CORE.PRESETS.stocks }), minLiq: 1e5 };
const mk = feed => { const notes = []; const bot = new Bot(P, { broker: new PaperBroker({ startCash: 10000 }), feed, store: memStore(), log: () => {}, notify: async m => notes.push(m) }); bot.notes = notes; return bot };

test('head start replays recent history exactly like running live bar by bar, without notifications', async () => {
  const { data, bench } = market(700, P.tf, 8), last = bench.t[699], days = 200;
  const a = mk(new MockFeed(data, bench).at(last)), lines = [];
  assert.equal(await headStart(a, days, l => lines.push(l)), true);
  const b = mk(new MockFeed(data, bench));
  for (const t of bench.t.filter(t => t > last - days * 86400)) { b.feed.at(t); await b.cycle() }
  assert.ok(a.state.trades.length > 0, 'replay should produce trades');
  assert.deepEqual(a.state.trades.map(t => [t.sym, t.t0, t.t1, +t.pnl.toFixed(6)]), b.state.trades.map(t => [t.sym, t.t0, t.t1, +t.pnl.toFixed(6)]));
  assert.ok(a.state.trades.every(t => t.hist) && Object.values(a.state.positions).every(p => p.hist));
  assert.equal(a.notes.length, 0, 'no notifications for replayed trades'); assert.ok(b.notes.length > 0);
  assert.equal(a.state.lastBar, last); assert.equal(a.state.meta.headStart.days, days);
  assert.equal(a.replay, false); assert.ok(lines.some(l => /^head start done/.test(l)));
  assert.ok(!lines.some(l => /^(BUY|SELL) /.test(l)), 'replayed trades must not look like live BUY/SELL lines (the app notifies on those)');
  assert.deepEqual(await a.cycle(), []);                                  // latest bar already done: nothing doubles up
  a.feed.at(last + 86400); data.S0 && 0;                                  // later live trades are not marked as history
  const { data: d2, bench: b2 } = market(702, P.tf, 8); a.feed = new MockFeed(d2, b2).at(b2.t[700]);
  await a.cycle(); assert.equal(a.state.meta.headStart.days, days, 'head start note survives later cycles');
  for (const t of a.state.trades.filter(t => t.t1 > last)) assert.equal(!!t.hist, !!(t.t0 <= last));
});

test('catch-up cycle in live mode handles exits but opens nothing new', async () => {
  const { data, bench } = market(500, P.tf, 8), bot = mk(new MockFeed(data, bench));
  for (let i = 300; i < 499; i++) { bot.feed.at(bench.t[i]); await bot.cycle({ noEntries: true }) }
  assert.equal(Object.keys(bot.state.positions).length, 0); assert.equal(bot.state.trades.length, 0);
  bot.feed.at(bench.t[499]); await bot.cycle(); assert.ok(Object.keys(bot.state.positions).length > 0);
});

test('Binance feed pages back far enough for the 200-day Bitcoin filter', async () => {
  const H = 14400e3, end = Math.floor(Date.now() / H) * H, first = end - 2000 * H, calls = [];
  const kl = o => [o, '1', '2', '0.5', String(1 + (o - first) / H / 1000), '10', o + H - 1, '15', 1, '0', '0', '0'];
  global.fetch = async url => { const u = new URL(url), q = u.searchParams; calls.push(u.pathname + ' ' + q.get('symbol'));
    let body;
    if (/exchangeInfo/.test(url)) body = { symbols: ['BTCUSDT', 'ETHUSDT'].map(symbol => ({ symbol, status: 'TRADING', quoteAsset: 'USDT', isSpotTradingAllowed: true })) };
    else if (/ticker/.test(url)) body = [{ symbol: 'BTCUSDT', quoteVolume: '9e9' }, { symbol: 'ETHUSDT', quoteVolume: '5e9' }];
    else { const lim = +q.get('limit'), e = q.get('endTime') ? +q.get('endTime') : end + H; const o = []; for (let t = first; t + H - 1 <= e && t <= end; t += H) o.push(t); body = o.slice(-lim).map(kl) }
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => body, text: async () => '' } };
  const { series, bench } = await new BinanceFeed(new BinanceClient({ spacingMs: 0 }), { tf: 14400 }).load();
  assert.equal(bench.t.length, 1599); assert.ok(series.ETHUSDT.t.length >= 999 && series.BTCUSDT.t.length <= 1000 && series.BTCUSDT.t.length >= 999);   // the candle still forming is dropped
  assert.ok(bench.t.every((t, i) => !i || t - bench.t[i - 1] === 14400), 'pages join without gaps or repeats');
  assert.equal(calls.filter(c => /klines BTCUSDT/.test(c)).length, 2, 'Bitcoin downloaded once, in two pages');
  assert.notEqual(CORE.benchAbove(bench, bench.t[1598]), null, '200-day filter has enough history');
});

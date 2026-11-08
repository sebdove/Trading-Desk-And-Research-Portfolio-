// Trend bot: the live bot replayed day by day must make the same decisions as the research backtest.
const test = require('node:test'), assert = require('node:assert'), realFetch = globalThis.fetch;
const TE = require('../src/te'); global.TE = TE;
const XA = require('./ref-xasset');
const { TrendBot, TrendPaperBroker, TrendBinanceBroker, TrendFeed, BinanceClientStub } = require('../src/trend');
const { BinanceClient } = require('../src/brokers/binance');
const { series } = require('./synth'), { memStore } = require('./helpers');
const DAY = 86400, d0 = Date.parse('2019-01-01T00:00:00Z') / 1000;
const mkSeries = (seed, n, opt) => series(seed, n, DAY, { start: d0, vol: 0.035, drift: 0.0012, ...opt });
class CutFeed { constructor(data) { this.data = data; this.t = null } at(t) { this.t = t; return this }
  cut(S) { let n = 0; while (n < S.t.length && S.t[n] <= this.t) n++; const o = {}; for (const k of ['t', 'o', 'h', 'l', 'c', 'q']) o[k] = S[k].slice(0, n); return o }
  async load() { const s = {}; for (const [k, S] of Object.entries(this.data)) { const c = this.cut(S); if (c.t.length) s[k] = c } return { series: s, bench: s.BTCUSDT, barTime: this.t } } }
const dates = n => Array.from({ length: n }, (_, i) => new Date((d0 + i * DAY) * 1000).toISOString().slice(0, 10));

test('Bitcoin only: bot replay equals the research backtest day for day', async () => {
  const n = 1400, S = mkSeries(7, n), feed = new CutFeed({ BTCUSDT: S });
  const bot = new TrendBot({ coins: 'btc', mode: 'paper', startCash: 10000 }, { broker: new TrendPaperBroker({ startCash: 10000 }), feed, store: memStore(), log: () => {} });
  const i0 = 300, eqBot = [];
  for (let i = i0; i < n; i++) { feed.at(S.t[i]); await bot.cycle(); eqBot.push(bot.state.preTradeEquity) }
  const E = TE.exposure(Float64Array.from(S.c), { trend: { kind: 'blend', L: [20, 50, 100, 200] }, volTarget: 0.8, volWin: 30, cap: 1 });
  const D = dates(n), r = TE.simulate(Float64Array.from(S.c), D, E, { from: D[i0], to: D[n - 1], band: 0.1, cost: 0.0015 });
  // the backtest curve is equity at each close before trading; the bot records the same number
  for (let k = 0; k < r.curve.length; k++) assert.ok(Math.abs(eqBot[k] / r.curve[k][1] - 1) < 1e-9, `day ${k}: bot ${eqBot[k]} vs backtest ${r.curve[k][1]}`);
  assert.ok(bot.state.orders.length > 20 && r.trades === bot.state.orders.length, `orders ${bot.state.orders.length} vs backtest trades ${r.trades}`);
});

test('10-coin basket: bot replay tracks the research basket backtest', async () => {
  const n = 1300, data = { BTCUSDT: mkSeries(3, n, { q: 9e9 }) };
  for (let k = 0; k < 14; k++) { const late = k % 5 === 4 ? 200 + k * 20 : 0; const S = mkSeries(20 + k, n - late, { q: (14 - k) * 4e8, vol: 0.05 }); S.t = S.t.map(t => t + late * DAY); data['C' + k + 'USDT'] = S }
  const feed = new CutFeed(data), bot = new TrendBot({ coins: 'basket10', mode: 'paper', startCash: 10000 }, { broker: new TrendPaperBroker({ startCash: 10000 }), feed, store: memStore(), log: () => {} });
  const i0 = 400; for (let i = i0; i < n; i++) { feed.at(data.BTCUSDT.t[i]); await bot.cycle() }
  const C = {}; for (const [s, S] of Object.entries(data)) C[s] = { t: S.t, c: S.c, q: S.q };
  const X = XA.toDaily(C, d0, d0 + (n - 1) * DAY);
  const ref = XA.basket(X.dates, X.D, { trend: { kind: 'blend', L: [20, 50, 100, 200] }, volTarget: 0.8, volWin: 30, cap: 1 }, { from: X.dates[i0], to: X.dates[n - 1] });
  const botFinal = bot.state.preTradeEquity, rel = botFinal / ref.final - 1;
  assert.ok(Math.abs(rel) < 0.01, `bot ${botFinal.toFixed(2)} vs backtest ${ref.final.toFixed(2)} (${(rel * 100).toFixed(3)}%)`);
  assert.equal(bot.state.basket.length, 10);
  assert.ok(Object.keys(bot.state.positions).every(s => bot.state.basket.includes(s)));
});

test('paper ledger: round-trip P&L is net of fees and cash never goes negative', async () => {
  const n = 1500, S = mkSeries(11, n, { drift: 0.0002, vol: 0.045 }), feed = new CutFeed({ BTCUSDT: S });
  const bot = new TrendBot({ coins: 'btc', mode: 'paper', startCash: 5000 }, { broker: new TrendPaperBroker({ startCash: 5000 }), feed, store: memStore(), log: () => {} });
  let minCash = Infinity; for (let i = 250; i < n; i++) { feed.at(S.t[i]); await bot.cycle(); minCash = Math.min(minCash, bot.broker.cash) }
  assert.ok(minCash > -1e-6, 'cash went negative: ' + minCash);
  const closed = bot.state.trades; assert.ok(closed.length > 2);
  // equity = start + realized P&L of closed trades + open P&L (cost basis includes fees)
  const open = Object.values(bot.state.positions).reduce((a, p) => a + p.qty * p.lastPrice - p.cost + p.realized, 0);
  const real = closed.reduce((a, t) => a + t.pnl, 0);
  assert.ok(Math.abs(5000 + real + open - bot.state.lastEquity) < 0.01, `${5000 + real + open} vs ${bot.state.lastEquity}`);
  assert.deepEqual(await bot.cycle(), [], 'same day twice does nothing');
});

test('live catch-up sells but never buys', async () => {
  const n = 700, S = mkSeries(5, n), feed = new CutFeed({ BTCUSDT: S });
  const bot = new TrendBot({ coins: 'btc', mode: 'live', startCash: 1000 }, { broker: new TrendPaperBroker({ startCash: 1000 }), feed, store: memStore(), log: () => {} });
  for (let i = 300; i < 400; i++) { feed.at(S.t[i]); await bot.cycle({ noEntries: true }) }
  assert.equal(bot.state.orders.filter(o => o.side === 'BUY').length, 0);
});

function fakeFetch(routes) {
  const calls = []; const f = async (url, opt = {}) => { calls.push({ url, method: opt.method || 'GET' });
    for (const [re, fn] of routes) if (re.test((opt.method || 'GET') + ' ' + url)) { const { status = 200, body } = fn(url); return { ok: status < 300, status, headers: { get: () => null }, json: async () => body, text: async () => JSON.stringify(body) } }
    throw new Error('unexpected request ' + url) }; f.calls = calls; return f;
}
test('Binance trend broker: own ledger, buys by USDT amount, sells whole lots, skips dust', async () => {
  const ex = { symbols: [{ symbol: 'BTCUSDT', filters: [{ filterType: 'LOT_SIZE', stepSize: '0.00001000' }, { filterType: 'NOTIONAL', minNotional: '5' }] }] };
  global.fetch = fakeFetch([
    [/GET .*\/api\/v3\/account/, () => ({ body: { balances: [{ asset: 'USDT', free: '25000', locked: '0' }, { asset: 'BTC', free: '3', locked: '0' }] } })],
    [/GET .*exchangeInfo/, () => ({ body: ex })],
    [/POST .*side=BUY.*quoteOrderQty=6000\.00/, () => ({ body: { executedQty: '0.10000', cummulativeQuoteQty: '6000', fills: [{ commission: '0.0001', commissionAsset: 'BTC' }] } })],
    [/POST .*side=SELL.*quantity=0\.04935&/, () => ({ body: { executedQty: '0.04935', cummulativeQuoteQty: '3059.70', fills: [{ commission: '3.06', commissionAsset: 'USDT' }] } })],
  ]);
  const b = new TrendBinanceBroker(new BinanceClient({ key: 'k', secret: 's', testnet: true, spacingMs: 0 }), { startCash: 10000 });
  await b.init(); assert.equal(b.cash, 10000, 'manages only its own money, not the whole account');
  const f1 = await b.rebalance([{ sym: 'BTCUSDT', from: 0, to: 0.6 }], { BTCUSDT: 60000 }, 10000);
  assert.equal(f1[0].side, 'BUY'); assert.ok(Math.abs(b.qty.BTCUSDT - 0.0999) < 1e-12, 'fee paid in BTC comes off the coins'); assert.equal(b.cash, 4000);
  const f2 = await b.rebalance([{ sym: 'BTCUSDT', from: 0.6, to: 0.3 }], { BTCUSDT: 62000 }, 10200);
  assert.equal(f2[0].side, 'SELL'); assert.ok(Math.abs(b.cash - (4000 + 3059.70 - 3.06)) < 1e-9); assert.ok(Math.abs(b.qty.BTCUSDT - (0.0999 - 0.04935)) < 1e-12);
  assert.deepEqual(b.holdings().BTCUSDT < 0.051, true, 'it keeps its own BTC count; the 3 BTC already on the account are not its business');
  const f3 = await b.rebalance([{ sym: 'BTCUSDT', from: 0.3, to: 0.2999 }], { BTCUSDT: 62000 }, 10200); assert.equal(f3.length, 0, 'dust below the minimum order is skipped');
  const posts = fetch.calls.filter(c => c.method === 'POST'); assert.ok(posts.every(c => /signature=/.test(c.url)) && posts.every(c => /testnet\.binance\.vision/.test(c.url)));
});

test('feed: drops the daily candle still forming; basket candidates skip stablecoins', async () => {
  const now = Date.now(), k = (o, c) => [o, '1', '2', '0.5', '1.5', '10', c, '15', 1, '0', '0', '0'];
  global.fetch = fakeFetch([
    [/klines/, () => ({ body: [k(now - 2 * 864e5, now - 864e5 - 1), k(now - 864e5, now + 3600e3)] })],
    [/exchangeInfo/, () => ({ body: { symbols: ['BTCUSDT', 'ETHUSDT', 'USDCUSDT', 'ETHUPUSDT'].map(symbol => ({ symbol, status: 'TRADING', quoteAsset: 'USDT', isSpotTradingAllowed: true })) } })],
    [/ticker/, () => ({ body: [{ symbol: 'USDCUSDT', quoteVolume: '9e12' }, { symbol: 'BTCUSDT', quoteVolume: '9e9' }, { symbol: 'ETHUSDT', quoteVolume: '5e9' }, { symbol: 'ETHUPUSDT', quoteVolume: '7e9' }] })]]);
  const f = new TrendFeed(new BinanceClient({ spacingMs: 0 }), { coins: 'basket10' });
  const { series, barTime } = await f.load(); assert.deepEqual(Object.keys(series).sort(), ['BTCUSDT', 'ETHUSDT']); assert.equal(series.BTCUSDT.t.length, 1); assert.equal(barTime, series.BTCUSDT.t[0]);
});

test('dashboard: trend summary and coin view (votes, model share, orders)', async () => {
  const fs = require('fs'), os = require('os'), path = require('path'), { fileStore } = require('../src/store'), { createDashboard } = require('../src/dashboard');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trd')), n = 900, S = mkSeries(9, n), feed = new CutFeed({ BTCUSDT: S });
  const bot = new TrendBot({ coins: 'btc', mode: 'paper', startCash: 10000 }, { broker: new TrendPaperBroker({ startCash: 10000 }), feed, store: fileStore(dir), log: () => {} });
  for (let i = 400; i < n; i++) { feed.at(S.t[i]); await bot.cycle() }
  const cfg = { market: 'trend', preset: 'trend', mode: 'paper', coins: 'btc', startCash: 10000, tf: 86400 };
  let port; const srv = createDashboard({ getBots: () => ({ trend: { cfg, dir } }), port: 0, onListen: p => port = p });
  await new Promise(r => setTimeout(r, 200));
  try {
    const sum = await realFetch(`http://127.0.0.1:${port}/api/summary`).then(r => r.json());
    assert.equal(sum.trend.configured, true); assert.equal(sum.trend.cfg.model, 'Trend Engine'); assert.equal(sum.trend.cfg.slots, 1);
    assert.ok(sum.trend.state.orders.length > 0 && sum.trend.state.targets.BTCUSDT && sum.trend.equity.length > 400);
    const c = await realFetch(`http://127.0.0.1:${port}/api/chart?market=trend&sym=BTCUSDT`).then(r => r.json());
    assert.equal(c.kind, 'trend'); assert.equal(c.now.votes.length, 8); assert.equal(c.s.length, c.bars.length);
    assert.ok(c.s.every(v => v >= 0 && v <= 100)); assert.ok(c.orders.length === bot.state.orders.length);
    assert.equal(c.s[c.s.length - 1], Math.round(bot.state.targets.BTCUSDT.target * 100), 'chart share = what the bot targeted today');
    assert.equal((await realFetch(`http://127.0.0.1:${port}/api/summary`, { method: 'POST' })).status, 405);
  } finally { srv.close() }
});

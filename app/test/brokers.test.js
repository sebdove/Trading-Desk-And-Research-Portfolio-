// Broker adapters against a fake HTTP layer (no network): checks the exact requests sent.
const test = require('node:test'), assert = require('node:assert'), crypto = require('crypto');
const { BinanceClient, BinanceFeed, BinanceBroker } = require('../src/brokers/binance');
const { AlpacaClient, AlpacaFeed, AlpacaBroker } = require('../src/brokers/alpaca');

function fakeFetch(routes) {
  const calls = [];
  const f = async (url, opt = {}) => {
    calls.push({ url, method: opt.method || 'GET', headers: opt.headers || {}, body: opt.body ? JSON.parse(opt.body) : null });
    for (const [re, fn] of routes) if (re.test((opt.method || 'GET') + ' ' + url)) { const { status = 200, body, headers = {} } = fn(url, opt); return { ok: status < 300, status, headers: { get: k => headers[k] ?? null }, json: async () => body, text: async () => JSON.stringify(body) } }
    throw new Error('unexpected request ' + url);
  };
  f.calls = calls; return f;
}

test('Binance: buys at market, then rests a stop-loss on the exchange; requests are signed', async () => {
  const ex = { symbols: [{ symbol: 'SOLUSDT', filters: [{ filterType: 'LOT_SIZE', stepSize: '0.00100000' }, { filterType: 'PRICE_FILTER', tickSize: '0.01000000' }, { filterType: 'NOTIONAL', minNotional: '5' }] }] };
  global.fetch = fakeFetch([
    [/GET .*exchangeInfo/, () => ({ body: ex })],
    [/POST .*\/api\/v3\/order\?.*type=MARKET/, () => ({ body: { executedQty: '10.000', cummulativeQuoteQty: '1500.00' } })],
    [/POST .*\/api\/v3\/order\?.*STOP_LOSS_LIMIT/, () => ({ body: { orderId: 42 } })],
  ]);
  const client = new BinanceClient({ key: 'k', secret: 's', testnet: true, spacingMs: 0 });
  const r = await new BinanceBroker(client).open({ sym: 'SOLUSDT', side: 1, notional: 1500, stop: 135.123 });
  assert.equal(r.price, 150); assert.equal(r.stopOrderId, 42); assert.equal(r.qty, 9.99);
  const [, buy, stop] = fetch.calls;
  assert.match(buy.url, /^https:\/\/testnet\.binance\.vision\/api\/v3\/order\?/); assert.match(buy.url, /quoteOrderQty=1500\.00/);
  assert.match(stop.url, /stopPrice=135\.12/); assert.match(stop.url, /quantity=9\.990/);
  const q = new URL(buy.url).searchParams, sig = q.get('signature'); q.delete('signature');
  assert.equal(sig, crypto.createHmac('sha256', 's').update(q.toString()).digest('hex')); assert.equal(buy.headers['X-MBX-APIKEY'], 'k');
});
test('Binance: refuses shorts on spot', async () => {
  await assert.rejects(new BinanceBroker(new BinanceClient({ key: 'k', secret: 's', spacingMs: 0 })).open({ sym: 'X', side: -1, notional: 10, stop: 1 }), /long-only/);
});
test('Binance feed: drops the candle that is still forming and stops on a rate-limit ban', async () => {
  const now = Date.now(), k = (o, c) => [o, '1', '2', '0.5', '1.5', '10', c, '15', 1, '0', '0', '0'];
  global.fetch = fakeFetch([[/klines/, () => ({ body: [k(now - 8 * 3600e3, now - 4 * 3600e3 - 1), k(now - 4 * 3600e3, now + 3600e3)] })]]);
  const feed = new BinanceFeed(new BinanceClient({ spacingMs: 0 }), { tf: 14400 });
  const S = await feed.klines('BTCUSDT'); assert.equal(S.t.length, 1);
  global.fetch = fakeFetch([[/klines/, () => ({ status: 418, body: { code: -1003, msg: 'banned' } })]]);
  await assert.rejects(feed.klines('BTCUSDT'), /rate limit/);
});
test('Alpaca: whole-share market buy with an attached stop-loss, on the paper endpoint', async () => {
  global.fetch = fakeFetch([[/POST .*\/v2\/orders/, () => ({ body: { id: 'o1', legs: [{ id: 's1' }] } })]]);
  const r = await new AlpacaBroker(new AlpacaClient({ key: 'k', secret: 's' })).open({ sym: 'NVDA', side: 1, notional: 3333, price: 120, stop: 108.456 });
  const c = fetch.calls[0];
  assert.match(c.url, /^https:\/\/paper-api\.alpaca\.markets\/v2\/orders$/);
  assert.deepEqual(c.body, { symbol: 'NVDA', qty: '27', side: 'buy', type: 'market', time_in_force: 'day', order_class: 'oto', stop_loss: { stop_price: '108.46' } });
  assert.equal(r.qty, 27); assert.equal(r.stopOrderId, 's1');
});
test('Alpaca feed: pages through bars and drops today while the market is open', async () => {
  const day = Math.floor(Date.now() / 86400e3) * 86400e3, iso = d => new Date(d).toISOString();
  let page = 0;
  global.fetch = fakeFetch([
    [/stocks\/bars/, () => (page++ === 0 ? { body: { bars: { SPY: [{ t: iso(day - 2 * 86400e3), o: 1, h: 2, l: 0.5, c: 1.5, v: 100, vw: 1.4 }] }, next_page_token: 'p2' } } : { body: { bars: { SPY: [{ t: iso(day), o: 1, h: 2, l: 0.5, c: 1.6, v: 100 }], AAPL: [{ t: iso(day - 2 * 86400e3), o: 1, h: 2, l: 0.5, c: 1.5, v: 10 }] }, next_page_token: null } })],
    [/v2\/clock/, () => ({ body: { timestamp: iso(day + 15 * 3600e3), is_open: true } })],
  ]);
  const r = await new AlpacaFeed(new AlpacaClient({ key: 'k', secret: 's' }), { symbols: ['AAPL'] }).load();
  assert.equal(r.bench.t.length, 1); assert.equal(r.barTime, (day - 2 * 86400e3) / 1000); assert.equal(r.series.AAPL.q[0], 15);
});

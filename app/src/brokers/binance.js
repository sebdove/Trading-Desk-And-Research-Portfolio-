// Binance spot: market data feed + order broker. v3 is long-only, so spot is enough (no leverage, no shorting).
// Requests are spaced out on purpose: Binance bans IPs that send too many requests.
const crypto = require('crypto');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const { STABLE, LEVERAGED } = require('../core');          // one list for the bot and its backtest
// Binance spot also lists tokenized US stocks and ETFs as <ticker>B (GOOGLBUSDT, QQQBUSDT, TSLABUSDT...). They follow the
// stock market, gap when it is shut, and were never in the crypto tests, so the bot skips them. DGB and PHB are real coins.
const STOCK_STEMS = new Set([...require('fs').readFileSync(require('path').join(__dirname, '..', '..', 'data', 'sp500.txt'), 'utf8').split(/\s+/).filter(Boolean),
  'QQQ', 'SPY', 'IWM', 'DIA', 'VOO', 'VTI', 'TQQQ', 'SQQQ', 'SOXL', 'ARKK', 'GLD', 'SLV', 'KORU', 'SPCX', 'MSTR', 'COIN', 'HOOD', 'CRCL', 'PLTR', 'GME', 'AMC', 'BABA', 'TSM', 'ARM', 'RDDT', 'SMCI', 'CRWV', 'CIRCLE']);
const CRYPTO_B = new Set(['DGB', 'PHB']);
const isTokenizedStock = sym => { const base = sym.replace(/USDT$/, ''); return /B$/.test(base) && !CRYPTO_B.has(base) && STOCK_STEMS.has(base.slice(0, -1)) };

class BinanceClient {
  constructor({ key, secret, testnet = true, spacingMs = 250 }) {
    this.key = key; this.secret = secret; this.spacingMs = spacingMs;
    this.base = testnet ? 'https://testnet.binance.vision' : 'https://api.binance.com';
    this.dataBase = 'https://api.binance.com';            // real market data even when trading on testnet
    this.last = 0; this.weightWarn = 0;
  }
  async req(base, path, { method = 'GET', params = {}, signed = false } = {}) {
    const wait = this.last + this.spacingMs - Date.now(); if (wait > 0) await sleep(wait); this.last = Date.now();
    const q = new URLSearchParams(params);
    if (signed) { q.set('timestamp', Date.now()); q.set('recvWindow', 10000); q.set('signature', crypto.createHmac('sha256', this.secret).update(q.toString()).digest('hex')) }
    const url = `${base}${path}${q.toString() ? '?' + q : ''}`;
    const r = await fetch(url, { method, headers: signed ? { 'X-MBX-APIKEY': this.key } : {} });
    const used = +r.headers.get('x-mbx-used-weight-1m') || 0;
    if (used > 1800) { this.weightWarn++; await sleep(30000) }            // back off well before the 2400/min limit
    if (r.status === 418 || r.status === 429) throw new Error(`Binance rate limit (${r.status}). Stop and wait before retrying: ${await r.text()}`);
    const j = await r.json(); if (!r.ok) throw new Error(`Binance ${r.status} ${path}: ${JSON.stringify(j)}`);
    return j;
  }
}

class BinanceFeed {
  constructor(client, { tf = 14400, universeSize = 120, minQuoteVol = 2e6, bars = 1000, benchBars = 1600, bench = 'BTCUSDT', include = [], exclude = [] }) {
    Object.assign(this, { client, tf, universeSize, minQuoteVol, bars, benchBars, bench, include, exclude });   // benchBars: 1600 x 4h = 266 days, enough for the 200-day market filter
    this.interval = { 3600: '1h', 14400: '4h', 86400: '1d' }[tf];
    this.universe = null; this.universeAt = 0;
  }
  async refreshUniverse() {
    if (this.universe && Date.now() - this.universeAt < 24 * 3600e3) return this.universe;
    const [info, tick] = [await this.client.req(this.client.dataBase, '/api/v3/exchangeInfo', { params: { permissions: 'SPOT' } }), await this.client.req(this.client.dataBase, '/api/v3/ticker/24hr', { params: { type: 'MINI' } })];
    const ok = new Set(info.symbols.filter(s => s.status === 'TRADING' && s.quoteAsset === 'USDT' && s.isSpotTradingAllowed).map(s => s.symbol));
    const vol = new Map(tick.map(t => [t.symbol, +t.quoteVolume]));
    let syms = [...ok].filter(s => !STABLE.test(s) && !LEVERAGED.test(s) && !isTokenizedStock(s) && !this.exclude.includes(s) && (vol.get(s) || 0) >= this.minQuoteVol)
      .sort((a, b) => vol.get(b) - vol.get(a)).slice(0, this.universeSize);
    for (const s of this.include) if (ok.has(s) && !syms.includes(s)) syms.push(s);
    this.universe = syms; this.universeAt = Date.now(); return syms;
  }
  async klines(sym, n = this.bars) {
    let k = [], end = null;                                                // Binance gives at most 1000 candles a request: page backwards
    while (k.length < n) {
      const params = { symbol: sym, interval: this.interval, limit: Math.min(1000, n - k.length) }; if (end != null) params.endTime = end;
      const part = await this.client.req(this.client.dataBase, '/api/v3/klines', { params });
      k = part.concat(k); if (part.length < params.limit) break; end = part[0][0] - 1;
    }
    const now = Date.now(), S = { t: [], o: [], h: [], l: [], c: [], q: [] };
    for (const x of k) { if (x[6] >= now) continue;                       // drop the candle that is still forming
      S.t.push(x[0] / 1000); S.o.push(+x[1]); S.h.push(+x[2]); S.l.push(+x[3]); S.c.push(+x[4]); S.q.push(+x[7]) }
    return S;
  }
  async load(held = []) {
    const syms = [...new Set([...(await this.refreshUniverse()), ...held])];
    const series = {};
    for (const s of syms) { if (s === this.bench) continue; try { series[s] = await this.klines(s) } catch (e) { if (/rate limit/.test(e.message)) throw e; console.warn(`skip ${s}: ${e.message}`) } }
    const bench = await this.klines(this.bench, this.benchBars);
    if (syms.includes(this.bench)) { const o = {}; for (const k of Object.keys(bench)) o[k] = bench[k].slice(-this.bars); series[this.bench] = o }
    const barTime = bench.t[bench.t.length - 1];
    return { series, bench, barTime };
  }
  // Full 4-hour history since `from` (seconds) for the 'since 2020' head start: paged forwards, 1,000 candles a request,
  // spaced like every other request. About 15 requests a coin for 2019-2026.
  async klinesSince(sym, from) {
    const S = { t: [], o: [], h: [], l: [], c: [], q: [] }, now = Date.now(); let start = from * 1000;
    for (;;) {
      const part = await this.client.req(this.client.dataBase, '/api/v3/klines', { params: { symbol: sym, interval: this.interval, startTime: start, limit: 1000 } });
      for (const x of part) { if (x[6] >= now) continue; S.t.push(x[0] / 1000); S.o.push(+x[1]); S.h.push(+x[2]); S.l.push(+x[3]); S.c.push(+x[4]); S.q.push(+x[7]) }
      if (part.length < 1000) break; start = part[part.length - 1][0] + 1;
    }
    return S;
  }
  // The coins to download for the history: today's most-traded spot coins, more than the bot scans, so that each past day
  // can still pick its own 120 most traded. Coins delisted since then cannot be downloaded (see the note in src/history.js).
  // Every spot USDT coin trading today (stablecoins, leveraged tokens and named stock tokens left out), whatever its volume
  // today: which coins the history uses must not depend on the hour it is run. Each past day still picks its own 120 most traded.
  async allSpotCoins() {
    const info = await this.client.req(this.client.dataBase, '/api/v3/exchangeInfo', { params: { permissions: 'SPOT' } });
    return info.symbols.filter(s => s.status === 'TRADING' && s.quoteAsset === 'USDT' && s.isSpotTradingAllowed).map(s => s.symbol)
      .filter(s => !STABLE.test(s) && !LEVERAGED.test(s) && !isTokenizedStock(s) && !this.exclude.includes(s)).sort();
  }
  async historyCoins(n) { const keep = this.universeSize; this.universeSize = n; this.universe = null; try { return await this.refreshUniverse() } finally { this.universeSize = keep; this.universe = null } }
  // daily Bitcoin closes for the burst guard (one request a day; the bot caches it)
  async dailyBench(n = 1100) { const keep = this.interval; this.interval = '1d'; try { return require('../guard').daily(await this.klines(this.bench, n), 86400) } finally { this.interval = keep } }
}

// Orders: market buy by quote amount, then a resting stop-loss sell on the exchange so the stop works even if the bot is offline.
class BinanceBroker {
  constructor(client) { this.client = client; this.name = 'binance'; this.filters = null }
  async loadFilters() {
    if (this.filters) return this.filters;
    const info = await this.client.req(this.client.base, '/api/v3/exchangeInfo');
    this.filters = new Map(info.symbols.map(s => [s.symbol, Object.fromEntries(s.filters.map(f => [f.filterType, f]))]));
    return this.filters;
  }
  roundStep(v, step) { const d = (step.split('.')[1] || '').replace(/0+$/, '').length; return Math.floor(v / +step) * +step }
  fmt(v, step) { const d = (String(step).split('.')[1] || '').replace(/0+$/, '').length; return v.toFixed(d) }
  async account() { return this.client.req(this.client.base, '/api/v3/account', { signed: true }) }
  async availableCash() { const a = await this.account(); const u = a.balances.find(b => b.asset === 'USDT'); return u ? +u.free : 0 }
  async equity(prices) {
    const a = await this.account(); let eq = 0;
    for (const b of a.balances) { const qty = +b.free + +b.locked; if (!qty) continue; if (b.asset === 'USDT') eq += qty; else if (prices[b.asset + 'USDT']) eq += qty * prices[b.asset + 'USDT'] }
    return eq;
  }
  async open({ sym, side, notional, stop }) {
    if (side !== 1) throw new Error('Binance spot broker is long-only (use model v3)');
    const F = (await this.loadFilters()).get(sym); if (!F) throw new Error(`unknown symbol ${sym}`);
    const minN = +(F.NOTIONAL?.minNotional || F.MIN_NOTIONAL?.minNotional || 5);
    if (notional < minN) return null;
    const o = await this.client.req(this.client.base, '/api/v3/order', { method: 'POST', signed: true, params: { symbol: sym, side: 'BUY', type: 'MARKET', quoteOrderQty: notional.toFixed(2), newOrderRespType: 'FULL' } });
    const qty = +o.executedQty, spent = +o.cummulativeQuoteQty, price = spent / qty;
    const step = F.LOT_SIZE.stepSize, tick = F.PRICE_FILTER.tickSize;
    const sellQty = this.roundStep(qty * 0.999, step);                    // leave room for fees paid in the base asset
    const stopPx = this.roundStep(stop, tick), limitPx = this.roundStep(stop * 0.985, tick);
    let stopOrderId = null;
    try {
      const so = await this.client.req(this.client.base, '/api/v3/order', { method: 'POST', signed: true, params: { symbol: sym, side: 'SELL', type: 'STOP_LOSS_LIMIT', timeInForce: 'GTC', quantity: this.fmt(sellQty, step), stopPrice: this.fmt(stopPx, tick), price: this.fmt(limitPx, tick) } });
      stopOrderId = so.orderId;
    } catch (e) { console.warn(`${sym}: could not place exchange stop (${e.message}); the bot will still exit on its own checks`) }
    return { sym, side, price, qty: sellQty, notional: spent, stopOrderId };
  }
  // Move the resting stop-loss (profit stop). Binance cannot change an order in place, so: cancel the old stop, place the
  // new one; if the new one is refused (for example the price is already below it), put the old stop back so the coins
  // are never left without a stop. Returns { id, ok, note }: id is the stop order now resting on the exchange (or null).
  async moveStop({ sym, qty, stopOrderId, stop, oldStop }) {
    const F = (await this.loadFilters()).get(sym); if (!F) return { id: stopOrderId, ok: false, note: `unknown symbol ${sym}` };
    const step = F.LOT_SIZE.stepSize, tick = F.PRICE_FILTER.tickSize;
    if (stopOrderId) {
      try { await this.client.req(this.client.base, '/api/v3/order', { method: 'DELETE', signed: true, params: { symbol: sym, orderId: stopOrderId } }) }
      catch (e) { let o = null; try { o = await this.client.req(this.client.base, '/api/v3/order', { signed: true, params: { symbol: sym, orderId: stopOrderId } }) } catch {}
        if (!o || !['CANCELED', 'EXPIRED'].includes(o.status)) return { id: stopOrderId, ok: false, note: o && /FILLED/.test(o.status) ? 'the old stop has already sold' : `could not cancel the old stop (${e.message})` } }
    }
    const place = async px => { const sp = this.roundStep(px, tick), lp = this.roundStep(px * 0.985, tick);
      const so = await this.client.req(this.client.base, '/api/v3/order', { method: 'POST', signed: true, params: { symbol: sym, side: 'SELL', type: 'STOP_LOSS_LIMIT', timeInForce: 'GTC', quantity: this.fmt(this.roundStep(qty, step), step), stopPrice: this.fmt(sp, tick), price: this.fmt(lp, tick) } });
      return so.orderId };
    try { return { id: await place(stop), ok: true } }
    catch (e) {
      if (oldStop != null) { try { return { id: await place(oldStop), ok: false, note: `new stop refused (${e.message}); old stop put back` } } catch (e2) { return { id: null, ok: false, note: `new stop refused (${e.message}) and the old stop could not be put back (${e2.message})` } } }
      return { id: null, ok: false, note: `new stop refused (${e.message})` };
    }
  }
  async close({ sym, qty, stopOrderId }) {
    if (stopOrderId) { try { await this.client.req(this.client.base, '/api/v3/order', { method: 'DELETE', signed: true, params: { symbol: sym, orderId: stopOrderId } }) } catch (e) { /* already filled or cancelled */ } }
    const F = (await this.loadFilters()).get(sym), step = F.LOT_SIZE.stepSize;
    const a = await this.account(); const base = sym.replace(/USDT$/, ''); const bal = a.balances.find(b => b.asset === base);
    const q = this.roundStep(Math.min(qty, bal ? +bal.free : 0), step); if (q <= 0) return null;
    const o = await this.client.req(this.client.base, '/api/v3/order', { method: 'POST', signed: true, params: { symbol: sym, side: 'SELL', type: 'MARKET', quantity: this.fmt(q, step), newOrderRespType: 'FULL' } });
    return { sym, price: +o.cummulativeQuoteQty / +o.executedQty };
  }
  // Positions whose exchange stop has filled since the last cycle.
  async syncStops(positions) {
    const out = [];
    for (const [sym, p] of Object.entries(positions)) { if (!p.stopOrderId) continue;
      const o = await this.client.req(this.client.base, '/api/v3/order', { signed: true, params: { symbol: sym, orderId: p.stopOrderId } });
      if (o.status === 'FILLED') out.push({ sym, price: +o.cummulativeQuoteQty / +o.executedQty }) }
    return out;
  }
}
module.exports = { BinanceClient, BinanceFeed, BinanceBroker, isTokenizedStock };

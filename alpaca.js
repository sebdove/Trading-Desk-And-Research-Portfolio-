// Alpaca (US stocks): daily bars + orders. Paper trading is the default (paper-api.alpaca.markets).
// The bot runs once a day after the close; orders are queued and fill at the next session's open.
const sleep = ms => new Promise(r => setTimeout(r, ms));

class AlpacaClient {
  constructor({ key, secret, paper = true, dataFeed = 'iex' }) {
    this.h = { 'APCA-API-KEY-ID': key, 'APCA-API-SECRET-KEY': secret, 'Content-Type': 'application/json' };
    this.base = paper ? 'https://paper-api.alpaca.markets' : 'https://api.alpaca.markets';
    this.data = 'https://data.alpaca.markets'; this.dataFeed = dataFeed;
  }
  async req(url, { method = 'GET', body } = {}) {
    for (let a = 0; a < 4; a++) {
      const r = await fetch(url, { method, headers: this.h, body: body ? JSON.stringify(body) : undefined });
      if (r.status === 429) { await sleep(3000 * (a + 1)); continue }
      if (r.status === 204) return null;
      const j = await r.json().catch(() => null);
      if (!r.ok) throw new Error(`Alpaca ${r.status} ${url}: ${JSON.stringify(j)}`);
      return j;
    }
    throw new Error('Alpaca rate limit: too many retries');
  }
}

class AlpacaFeed {
  constructor(client, { symbols, bench = 'SPY', days = 900 }) { Object.assign(this, { client, symbols, bench, days }) }
  async load(held = []) {
    const syms = [...new Set([this.bench, ...this.symbols, ...held])];
    const start = new Date(Date.now() - this.days * 86400e3).toISOString().slice(0, 10);
    const series = {};
    for (let i = 0; i < syms.length; i += 100) {                         // multi-symbol endpoint, 100 at a time
      let token = null;
      do {
        const q = new URLSearchParams({ symbols: syms.slice(i, i + 100).join(','), timeframe: '1Day', start, adjustment: 'split', feed: this.client.dataFeed, limit: '10000' });
        if (token) q.set('page_token', token);
        const j = await this.client.req(`${this.client.data}/v2/stocks/bars?${q}`);
        for (const [s, arr] of Object.entries(j.bars || {})) { const S = series[s] || (series[s] = { t: [], o: [], h: [], l: [], c: [], q: [] });
          for (const b of arr) { S.t.push(Math.floor(Date.parse(b.t) / 1000 / 86400) * 86400); S.o.push(b.o); S.h.push(b.h); S.l.push(b.l); S.c.push(b.c); S.q.push(b.v * (b.vw || b.c)) } }
        token = j.next_page_token;
      } while (token);
    }
    // drop today's bar if the market has not closed yet
    const clock = await this.client.req(`${this.client.base}/v2/clock`);
    const today = Math.floor(Date.parse(clock.timestamp) / 1000 / 86400) * 86400;
    if (clock.is_open) for (const S of Object.values(series)) if (S.t[S.t.length - 1] === today) for (const k of Object.keys(S)) S[k].pop();
    const bench = series[this.bench]; delete series[this.bench];
    return { series, bench, barTime: bench ? bench.t[bench.t.length - 1] : null };
  }
}

// Daily history for the since-2020 head start: every symbol from `from` (YYYY-MM-DD), kept in cacheDir and only topped up later,
// so a reset replays the same data. Consolidated (SIP) bars where the plan allows them for older data, otherwise IEX.
AlpacaFeed.prototype.history = async function (from, cacheDir, log = () => {}) {
  const fs = require('fs'), path = require('path'), zlib = require('zlib'), f = cacheDir && path.join(cacheDir, 'stocks-daily.json.gz');
  let C = null; try { C = f && JSON.parse(zlib.gunzipSync(fs.readFileSync(f))) } catch {}
  const syms = [...new Set([this.bench, ...this.symbols])];
  if (!C || C.from > from || syms.some(s => !C.series[s] && !(C.missing || []).includes(s))) C = { from, feed: null, series: {}, missing: [] };
  const end = new Date(Date.now() - 20 * 60e3).toISOString();
  const lastDay = Math.max(0, ...Object.values(C.series).map(S => S.t[S.t.length - 1] || 0));
  const start = lastDay ? new Date((lastDay + 86400) * 1000).toISOString().slice(0, 10) : from;
  const get = async (feed, list) => { const out = {};
    for (let i = 0; i < list.length; i += 100) { let token = null;
      do { const q = new URLSearchParams({ symbols: list.slice(i, i + 100).join(','), timeframe: '1Day', start, end, adjustment: 'split', feed, limit: '10000' }); if (token) q.set('page_token', token);
        const j = await this.client.req(`${this.client.data}/v2/stocks/bars?${q}`);
        for (const [s, arr] of Object.entries(j.bars || {})) { const S = out[s] || (out[s] = { t: [], o: [], h: [], l: [], c: [], q: [] });
          for (const b of arr) { S.t.push(Math.floor(Date.parse(b.t) / 1000 / 86400) * 86400); S.o.push(b.o); S.h.push(b.h); S.l.push(b.l); S.c.push(b.c); S.q.push(b.v * (b.vw || b.c)) } }
        token = j.next_page_token } while (token);
      log(`head start: stock history ${Math.min(i + 100, list.length)} of ${list.length} symbols`) }
    return out };
  let add, feed = C.feed || 'sip';
  try { add = await get(feed, syms) } catch (e) { if (feed !== 'sip' || !/40[13]/.test(e.message)) throw e; feed = 'iex'; log('head start: consolidated (SIP) history not allowed on this Alpaca plan; using IEX'); add = await get(feed, syms) }
  C.feed = feed;
  const clock = await this.client.req(`${this.client.base}/v2/clock`), today = Math.floor(Date.parse(clock.timestamp) / 1000 / 86400) * 86400;
  if (clock.is_open) for (const A of Object.values(add)) while (A.t.length && A.t[A.t.length - 1] >= today) for (const x of Object.keys(A)) A[x].pop();   // today's bar is not closed yet
  for (const [s, A] of Object.entries(add)) { const S = C.series[s] || (C.series[s] = { t: [], o: [], h: [], l: [], c: [], q: [] }); const last = S.t[S.t.length - 1] || 0;
    for (let k = 0; k < A.t.length; k++) if (A.t[k] > last) for (const x of ['t', 'o', 'h', 'l', 'c', 'q']) S[x].push(A[x][k]) }
  C.missing = syms.filter(s => !C.series[s]);
  if (f) { fs.mkdirSync(cacheDir, { recursive: true }); fs.writeFileSync(f + '.tmp', zlib.gzipSync(JSON.stringify(C))); fs.renameSync(f + '.tmp', f) }
  const series = { ...C.series }, bench = series[this.bench]; delete series[this.bench];
  return { series, bench, feed };
};

class AlpacaBroker {
  constructor(client) { this.client = client; this.name = 'alpaca' }
  async account() { return this.client.req(`${this.client.base}/v2/account`) }
  async availableCash() { const a = await this.account(); return +a.cash }
  async equity() { const a = await this.account(); return +a.equity }
  // Market buy at the next open (whole shares), with a stop-loss attached (one-triggers-other order).
  async open({ sym, side, notional, price, stop }) {
    if (side !== 1) throw new Error('Alpaca broker here is long-only (use model v3)');
    const qty = Math.floor(notional / price); if (qty < 1) return null;
    const o = await this.client.req(`${this.client.base}/v2/orders`, { method: 'POST', body: { symbol: sym, qty: String(qty), side: 'buy', type: 'market', time_in_force: 'day', order_class: 'oto', stop_loss: { stop_price: (+stop).toFixed(2) } } });
    return { sym, side, price, qty, notional: qty * price, orderId: o.id, stopOrderId: o.legs?.[0]?.id };
  }
  async close({ sym }) {
    const open = await this.client.req(`${this.client.base}/v2/orders?status=open&symbols=${sym}`);
    for (const o of open || []) await this.client.req(`${this.client.base}/v2/orders/${o.id}`, { method: 'DELETE' }).catch(() => {});
    const o = await this.client.req(`${this.client.base}/v2/positions/${sym}`, { method: 'DELETE' }).catch(e => { if (/404/.test(e.message)) return null; throw e });
    return o ? { sym, price: null, orderId: o.id } : null;               // fills at market; the next cycle reconciles the price
  }
  async syncStops(positions) {
    const held = new Set(((await this.client.req(`${this.client.base}/v2/positions`)) || []).map(p => p.symbol)), out = [];
    for (const [sym, p] of Object.entries(positions)) {
      if (held.has(sym) || !p.stopOrderId) continue;
      const o = await this.client.req(`${this.client.base}/v2/orders/${p.stopOrderId}`).catch(() => null);
      if (o && o.status === 'filled') out.push({ sym, price: +o.filled_avg_price });
    }
    return out;
  }
}
module.exports = { AlpacaClient, AlpacaFeed, AlpacaBroker };

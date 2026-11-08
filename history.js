// 'Since January 2020' head start for a new crypto paper account. Replaying six years one 4-hour candle at a time through
// the live loop would take hours, so instead: download the history once, run it through the backtest (the same CORE rules
// the bot uses, tested to give the same trades), and write the result into the paper account: every trade (marked
// history), the coins still held, the cash, and the account value since 2020. The live bot then carries on from there.
// Coins: every spot USDT coin listed today; each day the 120 most traded of them that day are scanned, as the live bot does.
// Limits: coins delisted since 2020 are missing, and these are spot coins, not the futures coins of the research tests.
const fs = require('fs'), path = require('path'), CORE = require('./core'), BT = require('./backtest');
const FROM = Date.UTC(2020, 0, 1) / 1000, WARM = Date.UTC(2019, 5, 1) / 1000;     // ~200 days before 2020 for the averages

// Downloaded candles are kept in <bot folder>/history (gzip, one file a coin) and only topped up on later runs, so a reset
// replays exactly the same data and gives the same result. Resetting the paper account does not delete this folder.
const zlib = require('zlib');
function cacheIO(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const f = sym => path.join(dir, sym.replace(/[^A-Za-z0-9]/g, '_') + '.json.gz');
  return { read: sym => { try { return JSON.parse(zlib.gunzipSync(fs.readFileSync(f(sym)))) } catch { return null } },
           write: (sym, S) => { const t = f(sym) + '.tmp'; fs.writeFileSync(t, zlib.gzipSync(JSON.stringify(S))); fs.renameSync(t, f(sym)) } };
}
async function cachedSince(feed, cache, sym, from) {
  const old = cache && cache.read(sym);
  if (old && old.t.length && old.t[0] <= from + 30 * 86400) {             // top up: only candles after the last one kept
    const add = await feed.klinesSince(sym, old.t[old.t.length - 1] + 1);
    for (const k of ['t', 'o', 'h', 'l', 'c', 'q']) old[k] = old[k].concat(add[k]);
    if (add.t.length && cache) cache.write(sym, old); return old;
  }
  const S = await feed.klinesSince(sym, from); if (cache && S.t.length) cache.write(sym, S); return S;
}

async function seedFromHistory(bot, log = console.log) {
  const cfg = bot.cfg, feed = bot.feed, N = cfg.universeSize || 120;
  if (cfg.market !== 'crypto' || !feed.klinesSince) throw new Error('the since-2020 head start is for the crypto bot');
  const cache = bot.store.dir ? cacheIO(path.join(bot.store.dir, '..', 'history')) : null;
  const coins = (feed.allSpotCoins ? await feed.allSpotCoins() : await feed.historyCoins(N + 80)).filter(s => s !== feed.bench);
  const fresh = cache ? coins.filter(s => !cache.read(s)).length : coins.length;
  log(`head start since 2020: ${coins.length} spot coins · ${fresh ? `downloading 4-hour history for ${fresh} of them (about ${Math.max(1, Math.round(fresh * 12 * 0.3 / 60))} minutes, once; kept for later resets)` : 'history already downloaded, topping it up'}…`);
  const data = {}; let done = 0;
  for (const s of coins) {
    try { const S = await cachedSince(feed, cache, s, WARM); if (S.t.length > 300) data[s] = S } catch (e) { if (/rate limit/.test(e.message)) throw e; log(`skip ${s}: ${e.message}`) }
    if (++done % 25 === 0) log(`head start: ${done} of ${coins.length} coins ready`);
  }
  const bench = await cachedSince(feed, cache, feed.bench, WARM);
  log(`head start: replaying ${Object.keys(data).length} coins from 1 January 2020 through the bot's rules…`);
  const r = BT.backtest({ ...cfg, start: cfg.startCash || 10000, from: FROM }, data, bench, cfg.tf);
  const st = bot.state, last = bench.t[bench.t.length - 1];
  st.trades = r.trades.map(x => ({ sym: x.sym, side: x.side, t0: x.t0, t1: x.t1, entry: x.entry, exit: x.exit, pnl: x.pnl, why: x.why === 'exit' ? 'exit' : x.why, hist: true }));
  st.positions = {}; const bp = {};
  for (const q of r.held) {
    st.positions[q.sym] = { side: q.side, entry: q.entry, qty: q.qty, notional: q.notional, stop: q.stop, t0: q.t0, lastPrice: q.last, risk: q.risk, ref: q.entry, best: q.best, ...(q.stopWhy ? { stopWhy: q.stopWhy } : {}), hist: true };
    bp[q.sym] = { qty: q.qty, side: q.side, entry: q.entry, notional: q.notional, imp: q.imp, t0: q.t0, stop: q.stop };
  }
  if (bot.broker.name === 'paper') { bot.broker.cash = r.cash; bot.broker.positions = bp }
  st.lastBar = last; st.lastEquity = r.final;
  st.peak = r.final;
  try { const n = cfg.transferFile && JSON.parse(fs.readFileSync(cfg.transferFile, 'utf8')); if (n && n.id) st.lastTransferId = n.id } catch {}   // a combined-account rebalance worked out before the reset no longer applies                                  // the 30% drawdown halt counts from today, not from a 2021 high
  st.meta = { ...(st.meta || {}), headStart: { days: Math.round((last - FROM) / 86400), from: FROM, to: last, since: '2020-01-01', buys: r.trades.length + r.held.length, sells: r.trades.length, coins: Object.keys(data).length } };
  bot.save();
  // candles for the dashboard: every coin traded or held (last 600 candles), so each can be opened straight away
  if (bot.store.saveBars) { const keep = S => { const o = {}; for (const k of ['t', 'o', 'h', 'l', 'c', 'q']) o[k] = S[k].slice(-600); return o };
    for (const sym of new Set([...st.trades.map(x => x.sym), ...Object.keys(st.positions)])) if (data[sym]) bot.store.saveBars(sym, keep(data[sym]));
    bot.store.saveBars('_bench', keep(bench)) }
  // account value: one point a day until the last 120 days, then every 4-hour candle (the dashboard's chart file)
  const cut = last - 120 * 86400, eq = []; let lastDay = null;
  for (const [t, e] of r.eqs) { const d = Math.floor(t / 86400); if (t >= cut || d !== lastDay) { eq.push([t, +e.toFixed(2)]); lastDay = d } }
  if (bot.store.dir) fs.writeFileSync(path.join(bot.store.dir, 'equity.json'), JSON.stringify(eq));
  const yrs = {}; let prev = cfg.startCash || 10000, y = null, v = null;
  for (const [t, e] of r.eqs) { const yy = new Date(t * 1000).getUTCFullYear(); if (y != null && yy !== y) { yrs[y] = (100 * (v / prev - 1)).toFixed(1) + '%'; prev = v } y = yy; v = e } yrs[y] = (100 * (v / prev - 1)).toFixed(1) + '%';
  log(`head start since 2020 done: ${r.trades.length} trades · $${(cfg.startCash || 10000).toFixed(0)} → $${r.final.toFixed(2)} · worst drop ${(r.dd * 100).toFixed(1)}% · by year ${Object.entries(yrs).map(([k, x]) => k + ' ' + x).join(', ')} · now trading live on paper`);
  return true;
}
// 'Since January 2020' head start for the trend bot: download Bitcoin's (and the basket candidates') daily candles once, then
// run the bot's own daily cycle for every day since 1 Jan 2020 with each day's view of the data (the same candle counts the live
// bot loads: 1,000 for Bitcoin, 400 for the others). Files are written once at the end. Coins listed today only.
async function seedTrend(bot, log = console.log) {
  const feed = bot.feed, cache = bot.store.dir ? cacheIO(path.join(bot.store.dir, '..', 'history')) : null;
  const coins = [...new Set(['BTCUSDT', ...(await feed.candidatesList())])];
  log(`head start since 2020: daily candles for ${coins.length} coin${coins.length > 1 ? 's' : ''} (kept for later resets)…`);
  const data = {}; for (const s of coins) { try { const S = await cachedSince(feed, cache, s, Date.UTC(2017, 0, 1) / 1000); if (S.t.length) data[s] = S } catch (e) { if (/rate limit/.test(e.message)) throw e; log(`skip ${s}: ${e.message}`) } }
  const btc = data.BTCUSDT; if (!btc) throw new Error('no Bitcoin daily candles');
  const cut = (S, t, n) => { let z = S.t.length; while (z > 0 && S.t[z - 1] > t) z--; const a = Math.max(0, z - n), o = {}; for (const k of ['t', 'o', 'h', 'l', 'c', 'q']) o[k] = S[k].slice(a, z); return o };
  const days = btc.t.filter(t => t >= FROM), real = { feed: bot.feed, store: bot.store, log: bot.log, notify: bot.notify };
  let t = null, last = null, eqs = [], bars = {}, buys = 0, sells = 0;
  bot.feed = { load: async () => { const s = {}; for (const [k, S] of Object.entries(data)) { const c = cut(S, t, k === 'BTCUSDT' ? 1000 : feed.bars || 400); if (c.t.length) s[k] = c } return { series: s, bench: s.BTCUSDT, barTime: t } } };
  bot.store = { dir: real.store.dir, load: () => last, save: x => { last = x }, appendEquity: (tt, e) => { if (eqs.length && eqs[eqs.length - 1][0] === tt) eqs[eqs.length - 1][1] = e; else eqs.push([tt, +e.toFixed(2)]) }, saveBars: (sym, S) => { bars[sym] = S } };
  bot.log = m => { if (/^BUY /.test(m)) buys++; if (/^SELL /.test(m)) sells++ }; bot.notify = async () => {}; bot.replay = true;
  try { for (t of days) await bot.cycle() } finally { Object.assign(bot, real); bot.replay = false }
  bot.state.peak = bot.state.lastEquity;
  try { const n = bot.cfg.transferFile && JSON.parse(fs.readFileSync(bot.cfg.transferFile, 'utf8')); if (n && n.id) bot.state.lastTransferId = n.id } catch {}
  bot.state.meta = { ...(bot.state.meta || {}), headStart: { days: days.length, from: days[0], to: days[days.length - 1], since: '2020-01-01', buys, sells } };
  bot.save();
  if (bot.store.dir) require('./atomic').writeAtomic(path.join(bot.store.dir, 'equity.json'), JSON.stringify(eqs));
  if (bot.store.saveBars) for (const [sym, S] of Object.entries(bars)) bot.store.saveBars(sym, S);
  let pk = 0, dd = 0; for (const [, e] of eqs) { pk = Math.max(pk, e); dd = Math.max(dd, 1 - e / pk) }
  log(`head start since 2020 done: ${days.length} days · ${buys} buys, ${sells} sells · $${(bot.cfg.startCash || 10000).toFixed(0)} → $${(bot.state.lastEquity || 0).toFixed(2)} · worst drop ${(dd * 100).toFixed(1)}% · now trading live on paper`);
  return true;
}
module.exports = { seedFromHistory, seedTrend, FROM, cacheIO, cachedSince };

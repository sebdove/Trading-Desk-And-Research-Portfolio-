// 'Since 2020' head start: the paper account is filled from a backtest, and the live bot then carries on exactly as if
// it had traded every candle since 2020 (same trades as one continuous backtest).
const test = require('node:test'), assert = require('node:assert'), fs = require('fs'), os = require('os'), path = require('path');
const CORE = require('../src/core'), BT = require('../src/backtest'), Bot = require('../src/bot'), PaperBroker = require('../src/brokers/paper');
const { seedFromHistory } = require('../src/history'), { fileStore } = require('../src/store'), { MockFeed } = require('./helpers'), { series, rng } = require('./synth');
const H4 = 14400, START = Date.UTC(2019, 5, 1) / 1000;
function wave(seed, n, { period, amp = 0.5, vol = 0.01, price, q, phase }) { const r = rng(seed), S = { t: [], o: [], h: [], l: [], c: [], q: [] }; let prev = price;
  for (let i = 0; i < n; i++) { const p = price * Math.exp(amp * Math.sin(2 * Math.PI * (i + phase) / period) + vol * (r() - 0.5) * 3); const o = prev;
    S.t.push(START + i * H4); S.o.push(o); S.h.push(Math.max(o, p) * (1 + vol * r())); S.l.push(Math.min(o, p) * (1 - vol * r())); S.c.push(p); S.q.push(q * (0.5 + r())); prev = p } return S }
test('since-2020 head start = one continuous backtest, then live trading carries on seamlessly', async () => {
  const n = 1500 + 2200, data = {};                                  // mid-2019 to about mid-2021 is enough for the check
  for (let i = 0; i < 24; i++) data[`C${i}USDT`] = wave(i + 11, n, { period: 240 + 13 * i, phase: 37 * i, price: 10 + i, q: 3e6 * (1 + i % 6) });
  const bench = series(77, n, H4, { start: START, drift: 0.0005, q: 5e9 });
  const P = { ...CORE.PRESETS.crypto, minLiq: 1e5, startCash: 10000 }, live = 40, cutT = bench.t[n - 1 - live];
  const full = BT.backtest({ ...P, start: 10000, from: Date.UTC(2020, 0, 1) / 1000 }, data, bench, H4);
  const mf = new MockFeed(data, bench).at(cutT);
  const feed = { bench: 'BTCUSDT', at: t => mf.at(t), load: () => mf.load(), historyCoins: async () => Object.keys(data), klinesSince: async sym => (sym === 'BTCUSDT' ? mf.cut(bench) : mf.cut(data[sym])) };
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pv-h-')), 'state'), store = fileStore(dir), logs = [];   // history is kept next to it
  const bot = new Bot(P, { broker: new PaperBroker({ startCash: 10000, fee: P.fee, impK: P.impK }), feed, store, log: m => logs.push(m) });
  assert.equal(await seedFromHistory(bot, m => logs.push(m)), true);
  assert.ok(bot.state.trades.length > 5 && bot.state.trades.every(x => x.hist));
  assert.ok(JSON.parse(fs.readFileSync(path.join(dir, 'equity.json'))).length > 100);
  for (const sym of new Set(bot.state.trades.map(x => x.sym))) assert.ok(fs.existsSync(path.join(dir, 'bars', sym + '.json')), 'candles saved for ' + sym);   // so the dashboard can open each coin
  for (let i = n - live; i < n; i++) { feed.at(bench.t[i]); await bot.cycle() }
  const a = full.trades.map(x => `${x.sym}|${x.t0}|${x.t1}|${x.why}|${x.pnl.toFixed(4)}`), b = bot.state.trades.map(x => `${x.sym}|${x.t0}|${x.t1}|${x.why}|${x.pnl.toFixed(4)}`);
  assert.deepEqual(b, a);
  assert.ok(Math.abs(bot.state.lastEquity - full.final) < 1e-6, `${bot.state.lastEquity} vs ${full.final}`);
  assert.ok(logs.some(l => /head start since 2020 done/.test(l)));
});
test('a reset replays the same kept history and gets the same result; an old rebalance note is not applied', async () => {
  const n = 1500 + 900, data = {};
  for (let i = 0; i < 22; i++) data[`C${i}USDT`] = wave(i + 31, n, { period: 250 + 11 * i, phase: 29 * i, price: 10 + i, q: 3e6 * (1 + i % 5) });
  const bench = series(78, n, H4, { start: START, drift: 0.0005, q: 5e9 }), P = { ...CORE.PRESETS.crypto, minLiq: 1e5, startCash: 10000 };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pv-r-')), tf = path.join(root, 'transfer.json'); fs.writeFileSync(tf, JSON.stringify({ id: 'old-1', amount: -2000 }));
  const mf = new MockFeed(data, bench).at(bench.t[n - 1]); let calls = 0;
  const feed = { bench: 'BTCUSDT', load: () => mf.load(), allSpotCoins: async () => Object.keys(data), klinesSince: async (sym, from) => { calls++; const S = mf.cut(sym === 'BTCUSDT' ? bench : data[sym]), o = {}; const i = S.t.findIndex(t => t >= from); for (const k of ['t', 'o', 'h', 'l', 'c', 'q']) o[k] = i < 0 ? [] : S[k].slice(i); return o } };
  const run = async sub => { const dir = path.join(root, sub, 'state'); fs.mkdirSync(dir, { recursive: true }); const bot = new Bot({ ...P, transferFile: tf }, { broker: new PaperBroker({ startCash: 10000 }), feed, store: fileStore(dir), log: () => {} }); await seedFromHistory(bot, () => {}); return bot };
  const a = await run('x'), c1 = calls, b = await run('x');                 // same bot folder: the second run reads the kept history
  assert.equal(c1, 23); assert.equal(calls - c1, 23);                         // second run: one top-up request a coin, nothing re-downloaded
  assert.equal(b.state.lastEquity, a.state.lastEquity); assert.deepEqual(b.state.trades, a.state.trades);
  assert.equal(a.state.lastTransferId, 'old-1');
});

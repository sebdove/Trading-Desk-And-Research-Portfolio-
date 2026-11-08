// Fills two demo bot folders with made-up markets (paper trading), then starts the dashboard.
//   npm run dashboard:demo   ->  http://localhost:8787
const fs = require('fs'), path = require('path');
const CORE = require('../src/core'), Bot = require('../src/bot'), PaperBroker = require('../src/brokers/paper');
const { fileStore } = require('../src/store'), { series } = require('./synth'), { MockFeed } = require('./helpers');
const root = path.join(__dirname, '..', 'demo');
async function build(market, names, n, warm) {
  const P = CORE.applyStockSlots({ ...CORE.DEFAULTS, ...CORE.PRESETS[market] }), tf = P.tf;
  const start = Math.floor(Date.now() / 1000 / tf) * tf - n * tf, data = {};
  names.forEach((s, i) => data[s] = series(i * 7 + (market === 'stocks' ? 3 : 101), n, tf, { start, price: market === 'stocks' ? 40 + 25 * i : [64000, 3200, 140, 0.6, 2.8, 0.14][i] || 5 + i, q: (market === 'stocks' ? 3e8 : 5e7) * (1 + i / 3), vol: tf < 86400 ? 0.012 : 0.02 }));
  const bench = series(market === 'stocks' ? 900 : 901, n, tf, { start, drift: 0.0005, q: 5e9, price: market === 'stocks' ? 580 : 64000 });
  const dir = path.join(root, market, 'state'); fs.rmSync(path.join(root, market), { recursive: true, force: true });
  const cfg = { preset: market, mode: 'paper', demo: true, dataDir: 'state', startCash: 10000, ...(market === 'stocks' ? { stockSlots: 5 } : {}), minLiq: 1e5 };
  fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(root, market, 'config.json'), JSON.stringify(cfg, null, 2));
  const feed = new MockFeed(data, bench), store = fileStore(dir);
  const bot = new Bot({ ...P, ...cfg }, { broker: new PaperBroker({ startCash: 10000, fee: P.fee, impK: P.impK }), feed, store, log: () => {} });
  for (let i = warm; i < n; i++) { feed.at(bench.t[i]); await bot.cycle() }
  console.log(`${market}: ${bot.state.trades.length} trades, ${Object.keys(bot.state.positions).length} open, equity $${bot.state.lastEquity.toFixed(2)}`);
}
(async () => {
  await build('stocks', ['ALPHA', 'BRAVO', 'CHARLIE', 'DELTA', 'ECHO', 'FOXTROT', 'GOLF', 'HOTEL', 'INDIA', 'JULIET'], 700, 300);
  await build('crypto', ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT', 'NEARUSDT', 'DOGEUSDT', 'LINKUSDT', 'AVAXUSDT'], 2600, 1500);
  if (process.argv.includes('--no-serve')) return;
  process.argv.push('--stocks', path.join(root, 'stocks', 'config.json'), '--crypto', path.join(root, 'crypto', 'config.json'));
  require('../src/dashboard');
})();

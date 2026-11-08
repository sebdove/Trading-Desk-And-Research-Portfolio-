// Offline demo: runs the real bot loop in paper mode over a made-up market, one bar at a time.
const CORE = require('../src/core'), Bot = require('../src/bot'), PaperBroker = require('../src/brokers/paper');
const { MockFeed, memStore, market } = require('./helpers');
(async () => {
  const P = CORE.PRESETS.stocks, { data, bench } = market(700, P.tf, 8), feed = new MockFeed(data, bench);
  const bot = new Bot({ ...P, minLiq: 1e5, maxDrawdown: 0.3 }, { broker: new PaperBroker({ startCash: 10000, fee: P.fee, impK: P.impK }), feed, store: memStore(),
    log: m => { if (/^(BUY|SELL)/.test(m)) console.log(m) } });
  for (let i = 300; i < 700; i++) { feed.at(bench.t[i]); await bot.cycle() }
  console.log(`\nDemo finished: ${bot.state.trades.length} trades, equity $${bot.state.lastEquity.toFixed(2)} (made-up prices, for checking the plumbing only).`);
})();

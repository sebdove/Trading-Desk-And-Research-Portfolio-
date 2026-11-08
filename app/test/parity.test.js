// The live bot, fed one bar at a time, must make exactly the same trades as the backtest.
const test = require('node:test'), assert = require('node:assert');
const CORE = require('../src/core'), BT = require('../src/backtest'), Bot = require('../src/bot'), PaperBroker = require('../src/brokers/paper');
const { MockFeed, memStore, market } = require('./helpers');

for (const preset of ['stocks', 'crypto']) {
  test(`live bot = backtest (${preset} preset)`, async () => {
    const P = CORE.PRESETS[preset], tf = P.tf, n = preset === 'stocks' ? 700 : 2600, startBar = preset === 'stocks' ? 300 : 1400;
    const { data, bench } = market(n, tf, 6);
    const from = bench.t[startBar];
    const bt = BT.backtest({ ...P, start: 10000, from, minLiq: 1e5 }, data, bench, tf);
    const feed = new MockFeed(data, bench), broker = new PaperBroker({ startCash: 10000, fee: P.fee, impK: P.impK });
    const bot = new Bot({ ...P, minLiq: 1e5 }, { broker, feed, store: memStore(), log: () => {} });
    for (let i = startBar; i < n; i++) { feed.at(bench.t[i]); await bot.cycle() }
    const a = bt.trades.map(x => `${x.sym}|${x.t0}|${x.t1}|${x.why}|${x.pnl.toFixed(4)}`);
    const b = bot.state.trades.map(x => `${x.sym}|${x.t0}|${x.t1}|${x.why.replace(' (filled at broker)', '')}|${x.pnl.toFixed(4)}`);
    assert.ok(a.length > 3, `expected some trades, got ${a.length}`);
    assert.deepEqual(b, a);
    assert.ok(Math.abs(bot.state.lastEquity - bt.final) < 1e-6, `equity ${bot.state.lastEquity} vs ${bt.final}`);
  });
}

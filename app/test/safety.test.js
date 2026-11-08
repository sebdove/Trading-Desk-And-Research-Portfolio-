const test = require('node:test'), assert = require('node:assert');
const { spawnSync } = require('child_process'), fs = require('fs'), os = require('os'), path = require('path');
const CORE = require('../src/core'), Bot = require('../src/bot'), PaperBroker = require('../src/brokers/paper');
const { MockFeed, memStore, market } = require('./helpers');

test('refuses live mode without the explicit environment switch', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pv')); const f = path.join(d, 'config.json');
  fs.writeFileSync(f, JSON.stringify({ preset: 'crypto', mode: 'live' }));
  const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'src', 'run.js'), '--config', f, '--once'], { env: { ...process.env, PVSRA_LIVE: '' }, encoding: 'utf8' });
  assert.notEqual(r.status, 0); assert.match(r.stderr, /Refusing to trade real money/);
});
test('drawdown halt stops new entries', async () => {
  const P = CORE.PRESETS.stocks, { data, bench } = market(700, P.tf, 6), feed = new MockFeed(data, bench);
  const store = memStore(); store.save({ peak: 1e9, halted: false, positions: {}, trades: [] });   // pretend we were far richer
  const bot = new Bot({ ...P, minLiq: 1e5, maxDrawdown: 0.3 }, { broker: new PaperBroker({ startCash: 10000 }), feed, store, log: () => {} });
  for (let i = 300; i < 700; i++) { feed.at(bench.t[i]); await bot.cycle() }
  assert.equal(bot.state.halted, true); assert.equal(bot.state.trades.length, 0); assert.equal(Object.keys(bot.state.positions).length, 0);
});
test('a bar is never processed twice', async () => {
  const P = CORE.PRESETS.stocks, { data, bench } = market(400, P.tf, 4), feed = new MockFeed(data, bench).at(bench.t[399]);
  const bot = new Bot({ ...P, minLiq: 1e5 }, { broker: new PaperBroker(), feed, store: memStore(), log: () => {} });
  await bot.cycle(); const again = await bot.cycle(); assert.deepEqual(again, []);
});

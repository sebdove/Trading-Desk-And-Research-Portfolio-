const test = require('node:test'), assert = require('node:assert');
const { spawnSync } = require('child_process'), fs = require('fs'), os = require('os'), path = require('path');
const CORE = require('../src/core'), Bot = require('../src/bot'), PaperBroker = require('../src/brokers/paper');
const { MockFeed, memStore, market } = require('./helpers');
const stocks = { ...CORE.DEFAULTS, ...CORE.PRESETS.stocks }, crypto = { ...CORE.DEFAULTS, ...CORE.PRESETS.crypto };

test('stock model: 4, 5 or 6 stocks; default 5; command line overrides config', () => {
  assert.equal(CORE.applyStockSlots(stocks).slots, 5);
  for (const n of [4, 5, 6]) assert.equal(CORE.applyStockSlots({ ...stocks, stockSlots: n }).slots, n);
  assert.equal(CORE.applyStockSlots({ ...stocks, stockSlots: 4 }, '6').slots, 6);
  for (const bad of [3, 7, 0, 'x']) assert.throws(() => CORE.applyStockSlots({ ...stocks, stockSlots: bad }), /must be 4, 5 or 6/);
});
test('crypto model is untouched and refuses the stock option', () => {
  assert.equal(CORE.applyStockSlots(crypto).slots, 3);
  assert.throws(() => CORE.applyStockSlots({ ...crypto, stockSlots: 5 }), /only applies to the stock model/);
  assert.throws(() => CORE.applyStockSlots(crypto, '5'), /only applies to the stock model/);
});
test('the bot never holds more stocks than the chosen number', async () => {
  for (const n of [4, 5, 6]) {
    const cfg = CORE.applyStockSlots({ ...stocks, minLiq: 1e5 }, n), { data, bench } = market(700, cfg.tf, 10), feed = new MockFeed(data, bench);
    const bot = new Bot(cfg, { broker: new PaperBroker({ startCash: 10000, fee: cfg.fee, impK: cfg.impK }), feed, store: memStore(), log: () => {} });
    let most = 0; for (let i = 300; i < 700; i++) { feed.at(bench.t[i]); await bot.cycle(); most = Math.max(most, Object.keys(bot.state.positions).length) }
    assert.ok(most <= n && most >= Math.min(n, 3), `slots ${n}: held at most ${most}`);
  }
});
test('command line: rejects --stock-slots 7 and rejects it for crypto', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pv')), run = (cfg, extra) => { const f = path.join(d, 'c.json'); fs.writeFileSync(f, JSON.stringify(cfg)); return spawnSync(process.execPath, [path.join(__dirname, '..', 'src', 'run.js'), '--config', f, '--status', ...extra], { encoding: 'utf8' }) };
  let r = run({ preset: 'stocks', mode: 'paper' }, ['--stock-slots', '7']); assert.notEqual(r.status, 0); assert.match(r.stderr, /must be 4, 5 or 6/);
  r = run({ preset: 'crypto', mode: 'paper' }, ['--stock-slots', '5']); assert.notEqual(r.status, 0); assert.match(r.stderr, /only applies to the stock model/);
  r = run({ preset: 'stocks', mode: 'paper', stockSlots: 6 }, []); assert.equal(r.status, 0);
});

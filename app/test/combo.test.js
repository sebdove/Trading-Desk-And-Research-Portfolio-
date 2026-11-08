const test = require('node:test'), assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path');
const COMBO = require('../src/combo'), CORE = require('../src/core'), Bot = require('../src/bot'), PaperBroker = require('../src/brokers/paper');
const { TrendPaperBroker } = require('../src/trend');
const { MockFeed, memStore, market } = require('./helpers');
test('combined account: monthly plan puts the split back to a third and two thirds', () => {
  const p = COMBO.plan(5000, 7000); assert.equal(p.total, 12000); assert.equal(p.toCrypto, -1000);
  const q = COMBO.plan(2000, 10000); assert.equal(q.toCrypto, 2000);
});
test('combined account: a transfer note is applied once, and it is not counted as a profit or a loss', async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cb')), f = path.join(d, 'transfer.json');
  const P = CORE.PRESETS.crypto, { data, bench } = market(400, P.tf, 4), feed = new MockFeed(data, bench);
  const bot = new Bot({ ...P, minLiq: 1e5, transferFile: f, maxDrawdown: 0.1 }, { broker: new PaperBroker({ startCash: 3333 }), feed, store: memStore(), log: () => {} });
  feed.at(bench.t[300]); await bot.cycle(); const eq0 = bot.state.lastEquity;
  fs.writeFileSync(f, JSON.stringify({ id: 'm1', amount: -1000 }));
  feed.at(bench.t[301]); await bot.cycle(); feed.at(bench.t[302]); await bot.cycle();
  assert.equal(bot.state.lastTransferId, 'm1'); assert.equal(bot.state.transfers.length, 1);
  assert.ok(Math.abs(bot.state.lastEquity - (eq0 - 1000)) < 400, 'equity fell by about the transfer');
  assert.equal(bot.state.halted, false, 'moving money out does not trip the drawdown halt');
  const tb = { cfg: { transferFile: f }, state: { peak: 6000 }, broker: new TrendPaperBroker({ startCash: 6667 }), log: () => {} };
  fs.writeFileSync(f, JSON.stringify({ id: 'm2', amount: 1000 })); COMBO.applyTransfer(tb); COMBO.applyTransfer(tb);
  assert.equal(tb.broker.cash, 7667); assert.equal(tb.state.peak, 7000);
});
test('combined account: the two bots add up day by day', () => {
  const D = 86400, m = COMBO.mergeEquity([[D * 10 + 3600, 100], [D * 10 + 7200, 110], [D * 12, 120]], [[D * 11, 200], [D * 12, 210]]);
  assert.deepEqual(m.map(x => x.slice(0, 2)), [[D * 11, 310], [D * 12, 330]]);
});
test('combined account on a shared Binance account: the crypto bot counts only what the trend bot does not own', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cb')), f = path.join(d, 'state.json');
  fs.writeFileSync(f, JSON.stringify({ broker: { cash: 500, qty: { BTCUSDT: 0.1 } }, positions: { BTCUSDT: { lastPrice: 60000 } } }));
  assert.deepEqual(COMBO.peerValue(f), { value: 6500, cash: 500 });
});

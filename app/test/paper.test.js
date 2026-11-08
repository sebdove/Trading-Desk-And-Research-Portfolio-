const test = require('node:test'), assert = require('node:assert');
const PaperBroker = require('../src/brokers/paper');
test('paper broker: costs and P&L match the backtest formula', async () => {
  const b = new PaperBroker({ startCash: 10000, fee: 0.001, impK: 0 });
  await b.open({ sym: 'X', side: 1, notional: 2000, price: 100, liq: 1e9, t: 0, stop: 90 });
  assert.equal(b.cash, 8000);
  assert.equal(await b.equity({ X: 110 }), 10200);
  const c = await b.close({ sym: 'X', price: 110, t: 3600 });
  assert.ok(Math.abs(c.pnl - (200 - 2)) < 1e-9);
  assert.ok(Math.abs(b.cash - 10198) < 1e-9);
});

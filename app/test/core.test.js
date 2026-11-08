const test = require('node:test'), assert = require('node:assert');
const CORE = require('../src/core'), ENG = require('../src/engine');
const M = ENG.MODELS.v3, M2 = ENG.MODELS.v2;

test('entry: v3 buys at +30 or more, never sells short', () => {
  assert.equal(CORE.entrySide(30, 10, M), 1);
  assert.equal(CORE.entrySide(45, 45, M), 1);          // re-entry while still in the zone
  assert.equal(CORE.entrySide(-50, -10, M), 0);        // long only
  assert.equal(CORE.entrySide(-50, -10, M2), -1);      // v2 shorts
  assert.equal(CORE.entrySide(29, 10, M), 0);
});
test('exit: stop first, filled at the stop or at the open if it gapped through', () => {
  const pos = { side: 1, stop: 95 };
  assert.deepEqual(CORE.checkExit(pos, { open: 97, high: 98, low: 94, close: 96 }, 50, M), { px: 95, why: 'stop' });
  assert.deepEqual(CORE.checkExit(pos, { open: 90, high: 92, low: 89, close: 91 }, 50, M), { px: 90, why: 'stop' });
  assert.deepEqual(CORE.checkExit(pos, { open: 100, high: 102, low: 99, close: 101 }, 5, M), { px: 101, why: 'exit' });
  assert.equal(CORE.checkExit(pos, { open: 100, high: 102, low: 99, close: 101 }, 40, M), null);
});
test('sizing: 1% risk, capped by slot share, cash and 1% of daily volume', () => {
  assert.equal(CORE.sizePosition({ equity: 10000, cash: 10000, slots: 3, risk: 0.01, stopPct: 0.1, liq: 1e9, maxPart: 0.01 }), 1000);
  assert.ok(Math.abs(CORE.sizePosition({ equity: 10000, cash: 10000, slots: 3, risk: 0.01, stopPct: 0.02, liq: 1e9, maxPart: 0.01 }) - 10000 / 3) < 1e-9);
  assert.equal(CORE.sizePosition({ equity: 10000, cash: 500, slots: 3, risk: 0.01, stopPct: 0.1, liq: 1e9, maxPart: 0.01 }), 500);
  assert.equal(CORE.sizePosition({ equity: 10000, cash: 10000, slots: 3, risk: 0.01, stopPct: 0.1, liq: 20000, maxPart: 0.01 }), 200);
  assert.ok(Math.abs(CORE.sizePosition({ equity: 9000, cash: 9000, slots: 3, risk: 0, stopPct: 0.05, liq: 1e9, maxPart: 0 }) - 3000) < 1e-9); // stocks: equal share
});
test('ranking: crypto prefers laggards with quiet volume, stocks prefer the most traded', () => {
  const lag = { rs30: -0.2, surge: 0.6, liq: 1e6 }, lead = { rs30: 0.3, surge: 3, liq: 9e9 };
  assert.ok(CORE.rankScore(lag, 1) > CORE.rankScore(lead, 1));
  assert.ok(CORE.rankScore(lead, 1, 'liquid') > CORE.rankScore(lag, 1, 'liquid'));
});
test('benchmark 200-day filter uses only past days', () => {
  const B = { t: [], c: [] }; for (let i = 0; i < 400; i++) { B.t.push(i * 86400); B.c.push(i < 300 ? 100 + i : 400 - 3 * (i - 300)) }
  assert.equal(CORE.benchAbove(B, 150 * 86400), null);   // not enough history
  assert.equal(CORE.benchAbove(B, 250 * 86400), true);
  assert.equal(CORE.benchAbove(B, 399 * 86400), false);
});

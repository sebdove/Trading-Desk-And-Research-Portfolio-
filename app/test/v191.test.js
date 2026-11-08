// 1.9.1: safe writes while Windows has a file open; tokenized stocks are not traded as crypto.
const test = require('node:test'), assert = require('node:assert'), fs = require('fs'), os = require('os'), path = require('path');
const { writeAtomic } = require('../src/atomic'), { isTokenizedStock } = require('../src/brokers/binance');
test('a save survives Windows refusing the rename for a while, and falls back to copying', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pv-')), 'state.json'), real = fs.renameSync;
  let n = 0; fs.renameSync = (a, b) => { if (n++ < 3) throw Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' }); return real(a, b) };
  try { writeAtomic(f, '{"a":1}'); assert.equal(fs.readFileSync(f, 'utf8'), '{"a":1}'); assert.equal(n, 4) } finally { fs.renameSync = real }
  fs.renameSync = () => { throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' }) };
  try { writeAtomic(f, '{"a":2}'); assert.equal(fs.readFileSync(f, 'utf8'), '{"a":2}'); assert.ok(!fs.existsSync(f + '.tmp')) } finally { fs.renameSync = real }
});
test('tokenized US stocks and ETFs are skipped; coins whose names end in B are not', () => {
  for (const s of ['GOOGLBUSDT', 'QQQBUSDT', 'TSLABUSDT', 'SPCXBUSDT', 'MUBUSDT', 'KORUBUSDT']) assert.equal(isTokenizedStock(s), true, s);
  for (const s of ['BNBUSDT', 'ARBUSDT', 'DGBUSDT', 'PHBUSDT', 'CKBUSDT', 'BBUSDT', 'PEPEUSDT']) assert.equal(isTokenizedStock(s), false, s);
});

test('stock-like coins (quiet weekends) are spotted from their candles', () => {
  const CORE = require('../src/core'), mk = (wkVol, wkMove) => { const S = { t: [], c: [], q: [] }; let p = 100; const t0 = Date.UTC(2026, 5, 1) / 1000;
    for (let i = 0; i < 600; i++) { const t = t0 + i * 14400, we = [0, 6].includes(new Date(t * 1000).getUTCDay()); p *= 1 + (i % 2 ? 1 : -1) * 0.01 * (we ? wkMove : 1); S.t.push(t); S.c.push(p); S.q.push(we ? wkVol : 1) } return S };
  assert.equal(CORE.stockLike(mk(0.1, 0.2)), true);
  assert.equal(CORE.stockLike(mk(0.7, 0.8)), false);
});

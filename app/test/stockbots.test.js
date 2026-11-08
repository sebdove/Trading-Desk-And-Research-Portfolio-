// Stock models (2.2.0): for each of the three, the since-2020 replay up to a day and then the live paper bot day by day give
// the same account as the replay straight to the end; desk transfers are applied once.
const test = require('node:test'), assert = require('node:assert'), fs = require('fs'), os = require('os'), path = require('path');
const CORE = require('../src/core'), SB = require('../src/stockbots'), SM = require('../src/stockmom'), Bot = require('../src/bot'), PaperBroker = require('../src/brokers/paper');
const { fileStore } = require('../src/store'), { rng } = require('./synth');
const DAY = 86400;
function market() {                                                  // 40 stocks + SPY on weekdays, June 2018 to the end of 2021
  const r = rng(11), days = []; for (let t = Date.UTC(2018, 5, 1) / 1000; t < Date.UTC(2022, 0, 1) / 1000; t += DAY) if (![0, 6].includes(new Date(t * 1000).getUTCDay())) days.push(t);
  const mk = (p, drift0, vol, q) => { const S = { t: [], o: [], h: [], l: [], c: [], q: [] }; let drift = drift0;
    for (let i = 0; i < days.length; i++) { if (i % 60 === 0) drift = drift0 + (r() - 0.5) * 0.006; const o = p * (1 + (r() - 0.5) * 0.004); p = Math.max(1, o * (1 + drift + vol * (r() - 0.5)));
      S.t.push(days[i]); S.o.push(o); S.h.push(Math.max(o, p) * (1 + 0.01 * r())); S.l.push(Math.min(o, p) * (1 - 0.01 * r())); S.c.push(p); S.q.push(q * (0.5 + r() * (r() < 0.05 ? 5 : 1))) } return S };
  const series = {}; for (let i = 0; i < 40; i++) series['S' + i] = mk(20 + i, 0.0006, 0.03, 3e7 * (1 + i % 4));
  return { days, series, bench: mk(300, 0.0005, 0.012, 1e10) };
}
const M = market();
const cut = (S, t, n = Infinity) => { let z = S.t.length; while (z > 0 && S.t[z - 1] > t) z--; const a = Math.max(0, z - n), o = {}; for (const k of Object.keys(S)) o[k] = S[k].slice(a, z); return o };
function feedAt(clock) { return {
  load: async () => { const s = {}; for (const [k, S] of Object.entries(M.series)) { const c = cut(S, clock.t, 620); if (c.t.length) s[k] = c } const bench = cut(M.bench, clock.t, 620); return { series: s, bench, barTime: bench.t[bench.t.length - 1] } },
  history: async () => { const s = {}; for (const [k, S] of Object.entries(M.series)) s[k] = cut(S, clock.t); return { series: s, bench: cut(M.bench, clock.t), feed: 'sip' } } } }
function make(model, clock, extra = {}) {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-')), 'state'), store = fileStore(dir), cfg = { ...CORE.DEFAULTS, ...CORE.applyStockSlots({ ...CORE.PRESETS.stocks }, 4), mode: 'paper', stockModel: model, startCash: 10000, ...extra }, feed = feedAt(clock);
  if (model === 'momentum') return new SB.StockMomBot(cfg, { feed, store, log: () => {} });
  if (model === 'half') return new SB.StockHalfBot(cfg, { feed, store, log: () => {} });
  return new Bot(cfg, { broker: new PaperBroker({ startCash: 10000, fee: cfg.fee, impK: cfg.impK }), feed, store, log: () => {} });
}
for (const model of ['momentum', 'half', 'v3']) test(`${model}: replay to mid-2021 then live day by day = replay to the end`, async () => {
  const end = M.days[M.days.length - 1], mid = M.days.findIndex(t => t >= Date.UTC(2021, 5, 1) / 1000);
  const a = make(model, { t: end }); await SB.seedStocks(a, () => {});
  const clock = { t: M.days[mid] }, b = make(model, clock); await SB.seedStocks(b, () => {});
  for (let i = mid + 1; i < M.days.length; i++) { clock.t = M.days[i]; await b.cycle() }
  const ea = a.state.lastEquity, eb = b.state.lastEquity; if (process.env.SHOW) fs.appendFileSync(process.env.SHOW, JSON.stringify([model, ea, eb, (a.state.trades || []).length, (b.state.trades || []).length, a.state.meta.halves]) + "\n");
  assert.ok(Math.abs(ea - 10000) > 100, 'the replay should trade: ' + ea);
  assert.ok(Math.abs(ea - eb) / ea < (model === 'momentum' ? 1e-9 : 2e-3), `${model}: replay ${ea} vs live ${eb}`);
  if (model !== 'v3') { const tr = a.state.trades.length; assert.ok(tr > 5, 'trades ' + tr) }
});
test('half and half: the two halves are put back to 50/50 at the start of each month', async () => {
  const a = make('half', { t: M.days[M.days.length - 1] }); await SB.seedStocks(a, () => {});
  const h = a.state.meta.halves; assert.ok(h.v3 > 0 && h.momentum > 0);
  assert.equal(SB.splitDelta(6000, 4000), 1000); assert.equal(SB.splitDelta(4000, 6000), -1000);
});
test('a desk transfer note is applied once (momentum and half and half)', async () => {
  for (const model of ['momentum', 'half']) {
    const clock = { t: M.days[M.days.length - 3] }, f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sbt-')), 't.json'), b = make(model, clock, { transferFile: f });
    await SB.seedStocks(b, () => {}); const before = b.state.lastEquity;
    fs.writeFileSync(f, JSON.stringify({ id: 'q9', amount: -1000 })); clock.t = M.days[M.days.length - 2]; await b.cycle(); clock.t = M.days[M.days.length - 1]; await b.cycle();
    const moved = b.state.transfers.filter(x => x.id === 'q9'); assert.equal(moved.length, 1, model);
    assert.ok(Math.abs(b.state.lastEquity - (before - 1000)) < before * 0.1, `${model}: ${before} -> ${b.state.lastEquity}`);
  }
});

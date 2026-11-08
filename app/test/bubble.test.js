// Bubble Watch: the JavaScript model must match the research version, the parsers must read the real file formats,
// and the daily update must keep the last good data when a source fails.
const test = require('node:test'), assert = require('node:assert');
const fs = require('fs'), path = require('path'), os = require('os'), zlib = require('zlib');
const MODEL = require('../src/bubble/model'), SRC = require('../src/bubble/sources'), NEWS = require('../src/bubble/news'), { BubbleService } = require('../src/bubble/service');
const SEED = path.join(__dirname, '..', 'data', 'bubble-seed.json.gz'), NSEED = path.join(__dirname, '..', 'data', 'bubble-news-seed.json');
const raw = () => JSON.parse(zlib.gunzipSync(fs.readFileSync(SEED)));
const at = (ym) => MODEL.idxOfYm(ym);

test('model reproduces the research readings (Python, Nov 2026)', () => {
  const R = MODEL.compute(raw(), { live: false }), S = R.S;
  // reference values from the Python run on the same data
  const ref = { '1929-09': [88.0, 2], '2000-03': [86.9, 2], '2007-10': [74.8, 1], '2021-12': [85.0, 2], '2026-10': [83.9, 2] };
  for (const [ym, [f, t]] of Object.entries(ref)) { const i = at(ym); assert.ok(Math.abs(S.froth[i] - f) < 0.6, `${ym} froth ${S.froth[i]} vs ${f}`); assert.equal(S.tier[i], t, ym) }
  assert.equal(R.hist.bears.length, 23); assert.equal(R.hist.episodes.length, 14);
  const L = R.last; assert.equal(S.kill_n[L], 1); assert.equal(S.kill_avail[L], 10); assert.equal(S.expl_p[L], 1);
  assert.ok(Math.abs(S.B.bp[L] - 1.17) < 0.01, 'BSADF real price ' + S.B.bp[L]);
  assert.deepEqual(R.V.val.map(v => v.p25), [12, 14, 20, 22, 30]);
});
test('crash-buy score and plan on 2008-09 and 1974', () => {
  const R = MODEL.compute(raw(), { live: false }), C = R.C;
  assert.ok(C.score[at('2008-10')] >= 65 && C.score[at('2008-06')] < 50);
  assert.equal(C.stage[at('2008-10')], 2); assert.equal(C.stage[at('2009-06')], 4);
  assert.ok(C.score[at('1974-09')] >= 65); assert.equal(C.score[at('2026-10')] < 20, true);
  const p08 = R.plan.find(p => p.peak === '2007-10'); assert.equal(p08.buys.length, 3); assert.ok(p08.plan_cost < p08.at20_cost);
});
test('live month uses daily closes after the Shiller file ends', () => {
  const R = MODEL.compute(raw()), L = R.last;
  assert.equal(MODEL.ymOf(L), '2026-11'); assert.ok(Math.abs(R.M.P[L] - (7550.28 + 7568.92) / 2) < 5, 'Nov average ' + R.M.P[L]);
  assert.ok(R.S.froth[L] > 75 && R.S.froth[L] < 90);
});
test('parsers read FRED, Yahoo, FINRA and Shiller formats', () => {
  const f = SRC.parseFred('observation_date,GS10\n2026-08-01,4.68\n2026-09-01,4.99\n2026-10-01,.\n');
  assert.deepEqual(f, { start: '2026-08', last: [4.68, 4.99], mean: [4.68, 4.99] });
  const w = SRC.parseFred('observation_date,NFCI\n2026-10-02,-0.5\n2026-10-09,-0.4\n2026-10-16,-0.6\n');
  assert.equal(w.last[0], -0.6); assert.ok(Math.abs(w.mean[0] + 0.5) < 1e-9);
  const y = SRC.parseYahoo({ chart: { result: [{ meta: { gmtoffset: -18000 }, timestamp: [Date.UTC(2026, 10, 2, 14, 30) / 1000, Date.UTC(2026, 10, 3, 14, 30) / 1000], indicators: { quote: [{ close: [7550.28, 7568.92] }] } }] } });
  assert.equal(y.d.length, 2); assert.equal(new Date(y.d[1] * 864e5).toISOString().slice(0, 10), '2026-11-03');
  const m = SRC.mergeDaily({ d: [1, 2, 3], c: [1, 2, 3] }, { d: [3, 4], c: [30, 4] }); assert.deepEqual(m, { d: [1, 2, 3, 4], c: [1, 2, 30, 4] });
  const fin = SRC.parseFinra(fs.readFileSync(path.join(__dirname, 'fixtures', 'finra-margin.xlsx'))); assert.deepEqual(fin[0], ['2026-09', 1480054]);
  const sh = SRC.parseShiller(fs.readFileSync(path.join(__dirname, 'fixtures', 'shiller-sample.xlsx')), 10);
  assert.equal(sh[0][0], '1871.01'); assert.equal(sh[sh.length - 1][0], '2026.10'); assert.equal(sh[sh.length - 1][1], 7722.72);
  assert.deepEqual(sh.slice(0, 5), raw().shiller.rows.slice(0, 5)); assert.deepEqual(sh[sh.length - 1], raw().shiller.rows[raw().shiller.rows.length - 1]);
});
test('daily update keeps the last good data when sources fail, and merges new closes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bub-')), svc = new BubbleService({ dir, seedFile: SEED, newsSeedFile: NSEED });
  const real = global.fetch;
  try {
    global.fetch = async () => { throw new Error('offline') };
    await svc.update({}); let j = svc.pageJson();
    assert.ok(j.mon.n >= 1871); assert.equal(j.status.sources['fred GS10'].ok, false); assert.ok(!j.status.lastSuccess);
    const n0 = svc.raw().yahoo['^GSPC'].d.length;
    // a working Yahoo for ^GSPC with one new day; everything else still offline
    global.fetch = async (url) => { if (/query1\.finance\.yahoo\.com.*GSPC/.test(url)) return { ok: true, status: 200, headers: new Map(), json: async () => ({ chart: { result: [{ meta: { gmtoffset: -18000 }, timestamp: [Date.UTC(2026, 10, 4, 14, 30) / 1000], indicators: { quote: [{ close: [7600] }] } }] } }) }; throw new Error('offline') };
    await svc.update({}); j = svc.pageJson();
    assert.equal(svc.raw().yahoo['^GSPC'].d.length, n0 + 1); assert.equal(j.snap.close, 7600); assert.ok(j.status.lastSuccess);
    assert.ok(j.scoreLog.length >= 1); assert.equal(j.news.seed, true);
  } finally { global.fetch = real; fs.rmSync(dir, { recursive: true, force: true }) }
});
test('news check: parses Claude\'s JSON, caps the tilt and keeps only real links', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bub-')), svc = new BubbleService({ dir, seedFile: SEED, newsSeedFile: NSEED });
  const real = global.fetch; let body = null;
  try {
    global.fetch = async (url, opt) => {
      if (/api\.anthropic\.com/.test(url)) { body = JSON.parse(opt.body); return { ok: true, status: 200, json: async () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: '```json\n' + JSON.stringify({ asOf: '2026-11-05', headline: 'Fed signals a December hike.', pillars: { valuation: { verdict: 'match', tilt: 9, summary: 'x', items: [{ text: 'a', source: 'b', date: '2026-11-05', url: 'https://example.com/a' }, { text: 'no link', source: 'c', url: 'javascript:x' }] }, killers: { verdict: 'ahead', tilt: 2 } }, coming: ['fed_hikes'] }) + '\n```' }] }) } }
      throw new Error('offline');
    };
    await svc.update({ apiKey: 'sk-test', model: 'claude-sonnet-5-5' });
    const n = svc.news();
    assert.equal(body.model, 'claude-sonnet-5-5'); assert.equal(body.tools[0].type, 'web_search_20250305');
    assert.equal(n.pillars.valuation.tilt, 2); assert.equal(n.pillars.valuation.items.length, 1); assert.equal(n.pillars.expansion.verdict, 'untest');
    assert.ok(Math.abs(n.tilt - 2 / 7 * 5) < 0.11); assert.deepEqual(n.coming, ['fed_hikes']);
  } finally { global.fetch = real; fs.rmSync(dir, { recursive: true, force: true }) }
});
test('dashboard serves the Bubble Watch page and data', async () => {
  const { createDashboard } = require('../src/dashboard');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bub-')), svc = new BubbleService({ dir, seedFile: SEED, newsSeedFile: NSEED });
  const port = await new Promise(r => { const s = createDashboard({ getBots: () => ({}), getBubble: () => svc.pageJson(), port: 0, onListen: p => r(p) }); test.after(() => s.close()) });
  const html = await fetch(`http://127.0.0.1:${port}/bubble.html`).then(r => r.text()); assert.ok(/S&amp;P 500 Bubble Watch/.test(html));
  const sum = await fetch(`http://127.0.0.1:${port}/api/bubble/summary`).then(r => r.json()); assert.equal(sum.tier, 2); assert.ok(sum.froth > 75);
  const all = await fetch(`http://127.0.0.1:${port}/api/bubble`).then(r => r.json()); assert.ok(all.mon && all.fall && all.plan && all.news);
  fs.rmSync(dir, { recursive: true, force: true });
});

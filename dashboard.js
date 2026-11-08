#!/usr/bin/env node
// Read-only dashboard for the bots, in the style of the PVSRA desk's Simple view.
//   node src/dashboard.js --stocks config.stocks.json --crypto config.crypto.json [--port 8787]
// Opens on http://localhost:8787 (this computer only). It never places or changes trades.
// The desktop app uses createDashboard() directly.
const http = require('http'), fs = require('fs'), path = require('path');
const CORE = require('./core'), ENG = require('./engine');
const { readDir } = require('./store');
const COMBO = require('./combo');
const TR = require('./trend');

function loadBot(cfgPath, market) {
  const user = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  const cfg = CORE.applyStockSlots({ ...CORE.DEFAULTS, ...(CORE.PRESETS[user.preset] || {}), ...user });
  if (market && cfg.market !== market) throw new Error(`${cfgPath} is a ${cfg.market} config, not ${market}`);
  return { cfg, dir: path.resolve(path.dirname(cfgPath), cfg.dataDir || `state-${cfg.market}`) };
}

function pvsraClass(S) {      // PVSRA candle classes for the volume colours (climax / rising / normal)
  return S.t.map((_, i) => {
    const bull = S.c[i] >= S.o[i]; if (i < 10) return bull ? 'n+' : 'n-';
    let s = 0, mx = 0; for (let j = i - 10; j < i; j++) { s += S.q[j]; const sv = (S.h[j] - S.l[j]) * S.q[j]; if (sv > mx) mx = sv }
    const r = s ? S.q[i] / (s / 10) : 0, sv = (S.h[i] - S.l[i]) * S.q[i];
    return (r >= 2 || (mx > 0 && sv >= mx) ? 'c' : r >= 1.5 ? 'r' : 'n') + (bull ? '+' : '-');
  });
}

// ---------- chart timeframes ----------
// The bots save candles at their own timeframe (crypto 4H, stocks 1D). Other timeframes come from Binance's public
// market data for coins (no key; one request per chart, cached a minute, spaced out), or are built from the saved
// candles when the timeframe is longer (stocks: 1W and 1M).
const TFS = { '15m': 900, '1h': 3600, '4h': 14400, '8h': 28800, '1d': 86400, '1w': 604800, '1M': 2592000 };
const tfKey = sec => Object.keys(TFS).find(k => TFS[k] === sec) || null;
const monthStart = t => { const d = new Date(t * 1000); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 1000 };
function aggSeries(S, key) {          // S at a shorter timeframe -> candles at timeframe key
  const sec = TFS[key], off = key === '1w' ? 345600 : 0, out = { t: [], o: [], h: [], l: [], c: [], q: [] };
  for (let i = 0; i < S.t.length; i++) {
    const k = key === '1M' ? monthStart(S.t[i]) : Math.floor((S.t[i] - off) / sec) * sec + off, n = out.t.length - 1;
    if (n < 0 || out.t[n] !== k) { out.t.push(k); out.o.push(S.o[i]); out.h.push(S.h[i]); out.l.push(S.l[i]); out.c.push(S.c[i]); out.q.push(S.q[i]) }
    else { if (S.h[i] > out.h[n]) out.h[n] = S.h[i]; if (S.l[i] < out.l[n]) out.l[n] = S.l[i]; out.c[n] = S.c[i]; out.q[n] += S.q[i] }
  }
  return out;
}
const kcache = new Map(); let klast = 0;
async function binanceKlines(sym, key) {
  const ck = sym + '|' + key, hit = kcache.get(ck); if (hit && Date.now() - hit.at < 60e3) return hit.S;
  const wait = klast + 600 - Date.now(); if (wait > 0) await new Promise(r => setTimeout(r, wait)); klast = Date.now();
  const r = await fetch(`https://api.binance.com/api/v3/klines?symbol=${encodeURIComponent(sym)}&interval=${key}&limit=1000`);
  if (r.status === 418 || r.status === 429) throw new Error('Binance asked us to slow down; try again in a few minutes');
  if (!r.ok) throw new Error(`Binance ${r.status}`);
  const k = await r.json(), now = Date.now(), S = { t: [], o: [], h: [], l: [], c: [], q: [] };
  for (const x of k) { if (x[6] >= now) continue; S.t.push(x[0] / 1000); S.o.push(+x[1]); S.h.push(+x[2]); S.l.push(+x[3]); S.c.push(+x[4]); S.q.push(+x[7]) }
  kcache.set(ck, { at: Date.now(), S }); if (kcache.size > 60) kcache.delete(kcache.keys().next().value);
  return S;
}
// Candles for (sym, key) plus the timeframes this asset can show.
async function candlesFor(saved, sym, botSec, key, market) {
  const botKey = tfKey(botSec), coin = market !== 'stocks' && /USDT$/.test(sym);
  const avail = Object.keys(TFS).filter(k => coin || TFS[k] >= botSec);
  if (!key || key === botKey || !TFS[key]) return { S: saved, key: botKey, avail };
  if (!avail.includes(key)) return { S: saved, key: botKey, avail, note: `${key} candles are not available for stocks: the stock bot saves daily candles.` };
  if (coin) { try { return { S: await binanceKlines(sym, key), key, avail } } catch (e) {
    if (TFS[key] > botSec) return { S: aggSeries(saved, key), key, avail, note: `Binance could not be reached (${e.message}), so these candles are built from the bot's saved ${botKey} candles.` };
    return { S: saved, key: botKey, avail, note: `Could not load ${key} candles from Binance: ${e.message}. Showing the bot's ${botKey} candles.` } } }
  return { S: aggSeries(saved, key), key, avail };
}
const snapTo = (T, t) => { let lo = 0, hi = T.length - 1; if (t < T[0]) return null; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (T[m] <= t) lo = m; else hi = m - 1 } return T[lo] };

// What each part of v3a is saying on the latest bar: the three consensus votes (PVSRA, Trend Breakout,
// research momentum), how long the consensus has sat on its side, and the v3a breadth-adaptive profit stop.
const V3A = { runIfBreadth: 0.35, trailK: 3, afterR: 2 };   // from the locked v3a model (v3r/model_locked.json)
function methods(V, base, cfg, st, pos) {
  const n = V.bars.length, i = n - 1, s = V.s, bk = x => x >= 30 ? 1 : x <= -30 ? -1 : 0;
  let k = i; while (k > 0 && bk(s[k - 1]) === bk(s[i])) k--;
  const pvT = V.sig.filter(t => t.outcome === 'open' && t.i <= i).pop() || null;
  const boT = V.boT.filter(t => t.outcome === 'open' && t.i <= i).pop() || null;
  let trail = null; if (boT) { trail = boT.entry - boT.side * 2.5 * V.A[boT.i]; for (let j = boT.i + 1; j <= i; j++) { const ns = V.bars[j].close - boT.side * 4 * V.A[j]; trail = boT.side > 0 ? Math.max(trail, ns) : Math.min(trail, ns) } }
  const days = ENG.agg(base, 86400), dk = days.length - 2;   // last completed day
  const mo = dk >= 28 ? [7, 14, 28].map(L => Math.sign(days[dk].close / days[dk - L].close - 1)) : null;
  const N = V.boT.length ? V.boT[0].N : (cfg.tf <= 3600 ? Math.round(86400 / cfg.tf) : 20);
  const meta = (st && st.meta) || {}, br = meta.breadth == null ? null : meta.breadth;
  // since 1.9.0 the crypto bot runs the profit stop (meta.profitStop) and the 50-day rule (meta.trendRule) unless switched off
  const live = cfg.market === 'crypto' && (meta.profitStop ?? cfg.profitStop === 'on');
  let v3a = { ...V3A, breadth: br, breadthN: meta.breadthN || 0, on: br != null && br < V3A.runIfBreadth, hist: (st && st.breadthHist || []).slice(-180), live };
  if (pos) {
    const ref = pos.ref ?? pos.entry, risk = pos.risk || Math.abs(ref - (pos.stopWhy ? NaN : pos.stop)) || Math.abs(pos.entry - pos.stop) || 1; let best = pos.best ?? ref;
    if (pos.best == null) for (let j = 0; j <= i; j++) if (V.bars[j].time > pos.t0) best = Math.max(best, V.bars[j].close);
    const bestR = (best - ref) / risk, trail = best - V3A.trailK * V.A[i];
    v3a.pos = { best, bestR, nowR: (V.bars[i].close - ref) / risk, stop: live ? pos.stop : trail, moved: pos.stopWhy === 'profit stop', armed: bestR >= V3A.afterR, wouldExit: !live && v3a.on && bestR >= V3A.afterR && V.bars[i].close <= trail };
  }
  const d50 = V.d50 ? V.d50[i] : NaN, trendRule = cfg.market === 'crypto' ? { on: meta.trendRule ?? cfg.trendRule === 'on', d50, above: V.bars[i].close > d50 } : null;
  return {
    since: { bars: i - k, side: bk(s[i]), secs: (i - k) * cfg.tf },
    pv: { vote: V.pv[i], trade: pvT && { setup: pvT.setup, side: pvT.side, entry: pvT.entry, stop: pvT.stop, target: pvT.target, t0: V.bars[pvT.i].time } },
    bo: { vote: V.bo[i], N, trade: boT && { side: boT.side, entry: boT.entry, trail, t0: V.bars[boT.i].time } },
    mo: { vote: V.mo[i] == null ? null : V.mo[i], legs: mo },
    v3a, trendRule, model: cfg.model,
  };
}

// getBots() returns { stocks?: {cfg, dir}, crypto?: {cfg, dir} } — called on every request so settings changes show at once.
// Bubble Watch data: the desktop app passes getBubble (its daily-updated service); on its own the dashboard scores the bundled snapshot.
let _bubble = null;
function defaultBubble() {
  if (!_bubble) { const { BubbleService } = require('./bubble/service'); const os = require('os');
    _bubble = new BubbleService({ dir: path.join(os.tmpdir(), 'pvsra-bubble-watch'), seedFile: path.join(__dirname, '..', 'data', 'bubble-seed.json.gz'), newsSeedFile: path.join(__dirname, '..', 'data', 'bubble-news-seed.json') }) }
  return _bubble.pageJson();
}
function createDashboard({ getBots, getCombo = null, getDesk = null, getBubble = defaultBubble, port = 8787, host = '127.0.0.1', onListen }) {
  const summary = market => {
    const b = getBots()[market]; if (!b) return { market, configured: false };
    const d = readDir(b.dir), st = d.state;
    const trend = b.cfg.market === 'trend';
    return { market, configured: true, running: !!st, cfg: { market: b.cfg.market, demo: !!b.cfg.demo, mode: b.cfg.mode, model: trend ? 'Trend Engine' : b.cfg.model, coins: b.cfg.coins, rank: b.cfg.rank, slots: trend ? (TR.COINS[b.cfg.coins] || TR.COINS.btc).N : b.cfg.slots, tf: b.cfg.tf, risk: b.cfg.risk, regime: b.cfg.regime, startCash: b.cfg.startCash || 10000, maxDrawdown: b.cfg.maxDrawdown },
      state: st && { positions: st.positions, trades: (st.trades || []).slice(-200), lastBar: st.lastBar, lastEquity: st.lastEquity, peak: st.peak, halted: st.halted, haltReason: st.haltReason, dayEq: st.dayEq, meta: st.meta,
        ...(trend ? { orders: (st.orders || []).slice(-200), targets: st.targets, btcScore: st.btcScore, basket: st.basket } : {}),
        ...(b.cfg.market === 'momentum' ? { rebalances: (st.rebalances || []).slice(-30), tested: require('./momentum').TESTED } : {}) },
      equity: d.equity };
  };
  // combined crypto account: the crypto bot and the trend bot added together (src/combo.js)
  const comboSummary = () => {
    const C = getCombo && getCombo(); if (!C || !C.on) return null;
    const bots = getBots(), dc = bots.crypto && readDir(bots.crypto.dir), dt = bots.trend && readDir(bots.trend.dir);
    const sc = dc && dc.state, stt = dt && dt.state, eq = COMBO.mergeEquity(dc ? dc.equity : [], dt ? dt.equity : []);
    const last = eq[eq.length - 1] || null, peak = eq.reduce((m, x) => Math.max(m, x[1]), 0);
    return { market: 'combo', configured: true, running: !!(sc && stt && last), share: C.share, tested: C.tested, history: C.history || [], pending: C.pending, month: C.month, modes: C.modes,
      cfg: { market: 'combo', mode: C.modes.crypto, startCash: C.total, tf: 86400, model: 'Combined' },
      state: last ? { lastEquity: last[1], peak, lastBar: Math.max(sc.lastBar || 0, stt.lastBar || 0), positions: {}, parts: { crypto: sc.lastEquity, trend: stt.lastEquity } } : null,
      equity: eq.map(x => [x[0], x[1]]), parts: eq.map(x => [x[0], x[2], x[3]]) };
  };
  const deskSummary = () => {
    const P = getDesk && getDesk(); if (!P || !P.on) return null;
    const PF = require('./portfolio'), bots = getBots(), BOTS = P.bots || PF.BOTS3, d = {}; for (const m of BOTS) d[m] = bots[m] && readDir(bots[m].dir);
    const ser = Object.fromEntries(BOTS.map(m => [m, d[m] ? d[m].equity : []])); let eq = PF.mergeEquity(ser, BOTS);
    if (P.seed && P.seed.curve) eq = [...P.seed.curve, ...eq.filter(x => x[0] > P.seed.to + 86400)];   // since 2020: the desk's own replayed history, then the bots added up
    const last = eq[eq.length - 1] || null;
    let peak = 0, worst = 0; for (const x of eq) { peak = Math.max(peak, x[1]); worst = Math.max(worst, 1 - x[1] / peak) }
    const parts = Object.fromEntries(BOTS.map(m => [m, d[m] && d[m].state ? d[m].state.lastEquity : null])), next = PF.shares(ser, PF.RULE, BOTS);
    return { market: 'desk', configured: true, bots: BOTS, momentumWanted: P.momentumWanted, running: !!last && BOTS.every(m => parts[m] != null), tested: P.tested, rule: P.rule, history: P.history || [], seed: P.seed ? { from: P.seed.from, to: P.seed.to, total: P.seed.total, dd: P.seed.dd } : null, pending: P.pending, quarter: P.quarter, modes: P.modes, nextShares: next.shares, swings: next.swings,
      cfg: { market: 'desk', mode: P.modes.crypto, startCash: P.total, tf: 86400, model: 'Desk portfolio' },
      state: last ? { lastEquity: last[1], peak, worst, lastBar: Math.max(...BOTS.map(m => (d[m] && d[m].state && d[m].state.lastBar) || 0)), positions: {}, parts } : null,
      equity: eq.map(x => [x[0], x[1]]) };
  };
  const chart = async (market, sym, tfReq) => {
    const b = getBots()[market]; if (!b) return null;
    const d = readDir(b.dir), saved = d.bars(sym); if (!saved || saved.t.length < 30) return { sym, missing: true };
    const C = await candlesFor(saved, sym, b.cfg.tf, tfReq, b.cfg.market), S = C.S, sec = TFS[C.key], native = sec === b.cfg.tf;
    if (!S || S.t.length < 2) return { sym, missing: true, reason: `No ${C.key} candles for ${sym}.` };
    const tfx = { tfKey: C.key, botTf: tfKey(b.cfg.tf), avail: C.avail, note: C.note || null };
    const bars = S.t.map((t, i) => ({ time: t, open: S.o[i], high: S.h[i], low: S.l[i], close: S.c[i], volume: S.q[i] }));
    const snap = t => snapTo(S.t, t), snapT = x => ({ ...x, t0: snap(x.t0) ?? x.t0, ...(x.t1 != null ? { t1: snap(x.t1) ?? x.t1 } : {}), ...(x.t != null ? { t: snap(x.t) ?? x.t } : {}) });
    if (b.cfg.market === 'trend') {                                      // Trend Engine view: votes, volatility, share held
      const st = d.state || {}, B = sym === 'BTCUSDT' ? S : d.bars('_bench');
      const bs = sym !== 'BTCUSDT' && B ? TR.trendScores(B) : null, gate = bs ? new Map(B.t.map((t, i) => [t, bs[i]])) : null;
      const E = TR.exposureSeries(saved, gate), A = TR.analyse(saved.c), N = (TR.COINS[b.cfg.coins] || TR.COINS.btc).N;
      const sE = native ? E : S.t.map(t => { const k = snapTo(saved.t, Math.min(t + Math.max(0, sec - 86400), saved.t[saved.t.length - 1])); return k == null ? 0 : E[saved.t.indexOf(k)] });
      return { kind: 'trend', sym, market, tf: sec, ...tfx, bars, cls: pvsraClass(S), s: sE.map(e => Math.round(e * 100)), N,
        now: A && { votes: A.votes, score: A.score, vol: A.vol, scale: A.scale, exposure: A.exposure }, btcScore: st.btcScore, gated: sym !== 'BTCUSDT' && !(st.btcScore >= 0.5),
        position: (st.positions || {})[sym] || null, trades: (st.trades || []).filter(x => x.sym === sym).map(snapT), orders: (st.orders || []).filter(x => x.sym === sym).map(snapT), target: (st.targets || {})[sym] || null };
    }
    const V = ENG.build(bars, sec, !native), st = d.state || {}, M = ENG.MODELS[b.cfg.model];
    const pos0 = (st.positions || {})[sym] || null, position = pos0 && { ...pos0, t0: snap(pos0.t0) ?? pos0.t0 };
    return { sym, market, tf: sec, ...tfx, bars: V.bars, s: Array.from(V.s), cls: pvsraClass(S), atr: V.A,
      votes: { pv: V.pv[V.pv.length - 1], bo: V.bo[V.bo.length - 1], mo: V.mo[V.mo.length - 1] || 0 },
      signals: ENG.trades(V, M).map(t => ({ t0: t.t0, t1: t.t1, side: t.side, entry: t.entry, exit: t.px, why: t.why, pct: (t.px / t.entry - 1) * t.side * 100 })),
      position, trades: (st.trades || []).filter(x => x.sym === sym).map(snapT),
      rules: { entry: M.entry, exit: M.exit, stopK: M.stopK, longOnly: !!M.longOnly },
      methods: methods(V, bars, { ...b.cfg, tf: sec }, st, pos0) };
  };
  const files = { '/': ['index.html', 'text/html; charset=utf-8'], '/bubble.html': ['bubble.html', 'text/html; charset=utf-8'], '/lw.js': ['lw.js', 'application/javascript'], '/app.js': ['app.js', 'application/javascript'], '/draw.js': ['draw.js', 'application/javascript'] };
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const json = o => { res.writeHead(o ? 200 : 404, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(o)) };
    try {
      if (req.method !== 'GET') { res.writeHead(405); return res.end('read-only') }
      if (files[u.pathname]) { const [f, type] = files[u.pathname]; res.writeHead(200, { 'Content-Type': type }); return res.end(fs.readFileSync(path.join(__dirname, 'dashboard', f))) }
      if (u.pathname === '/api/summary') return json({ stocks: summary('stocks'), crypto: summary('crypto'), trend: summary('trend'), momentum: summary('momentum'), combo: comboSummary(), desk: deskSummary(), now: Math.floor(Date.now() / 1000) });
      if (u.pathname === '/api/bubble') return json(getBubble());
      if (u.pathname === '/api/bubble/summary') { const b = getBubble(), m = b.mon, L = m.n - 1; return json({ month: b.snap.month, froth: m.froth[L], tier: m.tier[L], kill_n: m.kill_n[L], kill_avail: m.kill_avail[L], crash: m.crash[L], stage: m.cstage[L], sigma: m.sigma[L], tilt: b.news ? b.news.tilt : null, refreshed: b.status && b.status.lastSuccess || null }) }
      if (u.pathname === '/api/chart') return chart(u.searchParams.get('market'), u.searchParams.get('sym'), u.searchParams.get('tf')).then(json, e => { res.writeHead(500, { 'Content-Type': 'text/plain' }); res.end(e.message) });
      res.writeHead(404); res.end('not found');
    } catch (e) { res.writeHead(500, { 'Content-Type': 'text/plain' }); res.end(e.message) }
  });
  server.listen(port, host, () => onListen && onListen(server.address().port));
  return server;
}

module.exports = { createDashboard, loadBot, aggSeries, TFS };

if (require.main === module) {
  const a = process.argv.slice(2), opt = f => { const i = a.indexOf(f); return i >= 0 ? a[i + 1] : null };
  const bots = {};
  for (const market of ['stocks', 'crypto', 'trend']) {
    const p = opt('--' + market); if (!p) continue;
    if (!fs.existsSync(p)) { console.error(`config not found: ${path.resolve(p)}`); process.exit(1) }
    try { bots[market] = loadBot(path.resolve(p), market) } catch (e) { console.error(e.message); process.exit(1) }
  }
  if (!Object.keys(bots).length) { console.error('Give at least one of --stocks <config>, --crypto <config> or --trend <config>'); process.exit(1) }
  createDashboard({ getBots: () => bots, port: +(opt('--port') || 8787), onListen: p => console.log(`PVSRA bot dashboard: http://localhost:${p}  (read-only, this computer only)`) });
}

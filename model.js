// S&P 500 Bubble Watch model: the same rules as the research version (Python, Nov 2026), in plain JavaScript.
// compute(raw) turns the raw source data (Shiller, FRED, FINRA, Yahoo) into monthly scores since 1871:
//   eight pillars -> bubble score, explosive-root test (Phillips-Shi-Yu BSADF), ten momentum killers,
//   bubble episodes, bear markets, validation tables, the crash-buy score and tranche plan, and fall estimates.
// Every monthly value uses only data that had been published by then (publication lags are applied below).
'use strict';

const CV = { w0: 96, q90: [-0.5866970768124851, 0.14313188897478862, -0.001982175716295273], q95: [-0.2723505214145247, 0.15460444137907875, -0.0037301128179730134], q99: [0.23849608602870745, 0.22428493123272414, -0.011715751807549964] };
const PILLARS = ['valuation', 'expansion', 'leverage', 'fomo', 'fragility', 'benchmark', 'trend'];
const PIND = { valuation: ['v_cape', 'v_buff'], expansion: ['x_cape36', 'x_ip36', 'x_e24', 'x_bsadf'], leverage: ['l_level', 'l_growth'], fomo: ['f_alloc', 'f_chase'],
  fragility: ['r_spread', 'r_corp', 'r_nfci', 'r_bank'], benchmark: ['k_ecy', 'k_conc', 'k_ndx', 'k_rut'], trend: ['g_sigma'] };
const KILLERS = ['fed_hikes', 'curve_inv', 'bond_shock', 'credit_widen', 'trend_break', 'jobs_turn', 'fin_tight', 'earn_fall', 'inflation', 'lend_tight'];
const T0 = 1871;
const NaN_ = NaN, isF = Number.isFinite;

// ---------- small series helpers (arrays of numbers, NaN = missing) ----------
const arr = (n, v = NaN_) => new Array(n).fill(v);
const map2 = (a, b, f) => a.map((x, i) => (isF(x) && isF(b[i]) ? f(x, b[i]) : NaN_));
const lg = a => a.map(x => (x > 0 ? Math.log(x) : NaN_));
const diff = (a, n) => a.map((x, i) => (i >= n && isF(x) && isF(a[i - n]) ? x - a[i - n] : NaN_));
const shift = (a, n) => a.map((_, i) => (i - n >= 0 && i - n < a.length ? a[i - n] : NaN_));
const ffill = (a, limit = Infinity) => { const o = a.slice(); let last = NaN_, gap = 0; for (let i = 0; i < o.length; i++) { if (isF(o[i])) { last = o[i]; gap = 0 } else if (isF(last) && ++gap <= limit) o[i] = last } return o };
const fillna = (a, b) => a.map((x, i) => (isF(x) ? x : b[i]));
function rolling(a, n, f, minp = n) { const o = arr(a.length); for (let i = 0; i < a.length; i++) { const w = []; for (let j = Math.max(0, i - n + 1); j <= i; j++) if (isF(a[j])) w.push(a[j]); if (w.length >= minp && i >= Math.min(n, minp) - 1) o[i] = f(w) } return o }
const rmean = (a, n, mp) => rolling(a, n, w => w.reduce((s, x) => s + x, 0) / w.length, mp);
const rmin = (a, n, mp) => rolling(a, n, w => Math.min(...w), mp);
const rmax = (a, n, mp) => rolling(a, n, w => Math.max(...w), mp);
const rstd = (a, n, mp) => rolling(a, n, w => { const m = w.reduce((s, x) => s + x, 0) / w.length; return Math.sqrt(w.reduce((s, x) => s + (x - m) ** 2, 0) / (w.length - 1)) }, mp);
// expanding percentile, mid-rank, once minn values exist
function xpct(a, minn = 120) {
  const o = arr(a.length), h = [];
  const lb = x => { let lo = 0, hi = h.length; while (lo < hi) { const m = (lo + hi) >> 1; if (h[m] < x) lo = m + 1; else hi = m } return lo };
  const ub = x => { let lo = 0, hi = h.length; while (lo < hi) { const m = (lo + hi) >> 1; if (h[m] <= x) lo = m + 1; else hi = m } return lo };
  for (let t = 0; t < a.length; t++) { const x = a[t]; if (!isF(x)) continue; h.splice(lb(x), 0, x); if (h.length >= minn) o[t] = (lb(x) + ub(x)) / 2 / h.length * 100 }
  return o;
}
const meanAvail = cols => cols[0].map((_, i) => { let s = 0, n = 0; for (const c of cols) if (isF(c[i])) { s += c[i]; n++ } return n ? s / n : NaN_ });
const inv = a => a.map(x => (isF(x) ? 100 - x : NaN_));
function erf(x) { const s = Math.sign(x); x = Math.abs(x); const t = 1 / (1 + 0.3275911 * x); const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x); return s * y }

// ---------- dates ----------
const ymOf = i => { const y = T0 + Math.floor(i / 12), m = i % 12; return `${y}-${String(m + 1).padStart(2, '0')}` };
const idxOfYm = s => { const [y, m] = s.split('-').map(Number); return (y - T0) * 12 + (m - 1) };
const ymOfDay = d => { const t = new Date(d * 864e5); return (t.getUTCFullYear() - T0) * 12 + t.getUTCMonth() };
const dayStr = d => new Date(d * 864e5).toISOString().slice(0, 10);

// ---------- monthly panel (port of prep.py with publication lags) ----------
function panel(raw, { live = true } = {}) {
  const sh = raw.shiller.rows.map(r => { const [y, m] = r[0].split('.'); return [(+y - T0) * 12 + ((+m || 10) - 1), ...r.slice(1)] }).filter(r => r[0] >= 0);
  let n = sh[sh.length - 1][0] + 1;
  const Y = raw.yahoo || {}, spx = Y['^GSPC'];
  const lastDailyM = spx && spx.d.length ? ymOfDay(spx.d[spx.d.length - 1]) : -1;
  const shLast = n - 1;
  if (live && lastDailyM > shLast) n = lastDailyM + 1;               // months the Shiller file has not reached yet
  const col = k => { const a = arr(n); sh.forEach(r => { a[r[0]] = r[k] == null ? NaN_ : r[k] }); return a };
  const M = { n, shLast, P: col(1), D: col(2), E: col(3), CPI: col(4), GS10: col(5), realP: col(6), realE: col(7), CAPE: col(8), ECY: col(9) };
  // FRED: monthly last/mean, shifted by the publication lag, forward-filled
  const fred = (id, lag, how = 'last', limit = 6) => {
    const f = raw.fred && raw.fred[id]; const a = arr(n); if (!f) return a;
    const s0 = idxOfYm(f.start), v = f[how];
    for (let j = 0; j < v.length; j++) { const i = s0 + j + lag; if (i >= 0 && i < n && v[j] != null) a[i] = v[j] }
    // reindex + ffill(limit): only fill after the first value
    return ffill(a, limit);
  };
  for (const [id, lag] of [['GDP', 4], ['NCBEILQ027S', 6], ['BOGZ1FL153064486Q', 6], ['BOGZ1FL663067003Q', 6]]) M[id] = fred(id, lag, 'last', 9);
  for (const id of ['INDPRO', 'FEDFUNDS', 'TB3MS', 'BAA', 'UNRATE']) M[id] = fred(id, 1);
  M.NFCI = fred('NFCI', 0, 'mean'); M.VIX = fred('VIXCLS', 0, 'mean'); M.HY = fred('BAMLH0A0HYM2', 0, 'mean');
  M.CORPDEBT = fred('NCBCEBQ027S', 6, 'last', 9); M.TOTBKCR = fred('TOTBKCR', 1, 'mean', 9); M.DRTSCILM = fred('DRTSCILM', 1, 'last', 9);
  const gs10f = fred('GS10', 1);
  // FINRA margin debt, available one month later
  M.MARGIN = arr(n); for (const [ym, v] of (raw.finra && raw.finra.rows) || []) { const i = idxOfYm(ym) + 1; if (i >= 0 && i < n) M.MARGIN[i] = v }
  // Yahoo month-end closes
  const mlast = sym => { const y = Y[sym], a = arr(n); if (!y) return a; for (let k = 0; k < y.d.length; k++) { const i = ymOfDay(y.d[k]); if (i >= 0 && i < n && isF(y.c[k])) a[i] = y.c[k] } return a };
  M.SPX = mlast('^GSPC'); M.NDX = mlast('^IXIC'); M.RUT = mlast('^RUT'); M.RSP = mlast('RSP');
  // live months: monthly average of daily closes (Shiller's convention), other Shiller columns carried forward
  M.liveFrom = null;
  if (live && spx) {
    const avg = arr(n), cnt = arr(n, 0); for (let k = 0; k < spx.d.length; k++) { const i = ymOfDay(spx.d[k]); if (i >= 0 && i < n) { avg[i] = (isF(avg[i]) ? avg[i] : 0) + spx.c[k]; cnt[i]++ } }
    const first = shLast;                                          // Shiller's latest month is itself a partial-month estimate
    for (let i = first; i < n; i++) if (cnt[i] > 0) M.P[i] = avg[i] / cnt[i];
    M.liveFrom = first;
    const cpiL = M.CPI[shLast];
    for (let i = shLast + 1; i < n; i++) { M.CPI[i] = cpiL; M.GS10[i] = isF(gs10f[i]) ? gs10f[i] : M.GS10[i - 1] }
    for (const k of ['D', 'E']) M[k] = ffill(M[k], 9);
    for (let i = shLast; i < n; i++) M.realP[i] = M.P[i] * cpiL / M.CPI[i];
    // CAPE for live months: real price / 10-year average real earnings (Shiller's formula), scaled to match his last value
    const rEall = M.E.map((e, i) => (isF(e) && isF(M.CPI[i]) ? e * cpiL / M.CPI[i] : NaN_));
    const cape10 = i => { let s = 0, c = 0; for (let j = i - 119; j <= i; j++) if (j >= 0 && isF(rEall[j])) { s += rEall[j]; c++ } return c >= 100 ? M.realP[i] / (s / c) : NaN_ };
    const k0 = isF(M.CAPE[shLast]) && isF(cape10(shLast)) ? M.CAPE[shLast] / cape10(shLast) : 1;
    const rr = isF(M.ECY[shLast]) && isF(M.CAPE[shLast]) ? 1 / M.CAPE[shLast] - M.ECY[shLast] : NaN_;
    for (let i = shLast; i < n; i++) { const c = cape10(i) * k0; if (isF(c)) M.CAPE[i] = c;
      if (isF(rr) && isF(M.CAPE[i])) M.ECY[i] = 1 / M.CAPE[i] - (rr + (M.GS10[i] - M.GS10[shLast]) / 100) }
  }
  return M;
}

// ---------- explosive-root test (backward sup ADF, lag 0) ----------
function bsadf(series, w0 = CV.w0) {
  const n = series.length, out = arr(n); let first = series.findIndex(isF); if (first < 0) return { stat: out, first: -1 };
  const Yv = []; for (let i = first; i < n; i++) Yv.push(series[i]);
  for (let i = 1; i < Yv.length; i++) if (!isF(Yv[i])) Yv[i] = Yv[i - 1];  // defensive fill
  const T = Yv.length, cx = new Float64Array(T), cy = new Float64Array(T), cxx = new Float64Array(T), cxy = new Float64Array(T), cyy = new Float64Array(T);
  for (let k = 0; k < T - 1; k++) { const x = Yv[k], dy = Yv[k + 1] - Yv[k]; cx[k + 1] = cx[k] + x; cy[k + 1] = cy[k] + dy; cxx[k + 1] = cxx[k] + x * x; cxy[k + 1] = cxy[k] + x * dy; cyy[k + 1] = cyy[k] + dy * dy }
  for (let t = w0; t < T; t++) {
    let best = -Infinity;
    for (let a = 0; a <= t - w0; a++) {
      const nn = t - a, Sx = cx[t] - cx[a], Sy = cy[t] - cy[a], Sxx = cxx[t] - cxx[a], Sxy = cxy[t] - cxy[a], Syy = cyy[t] - cyy[a];
      const den = nn * Sxx - Sx * Sx; if (!(den > 0)) continue;
      const b = (nn * Sxy - Sx * Sy) / den, al = (Sy - b * Sx) / nn, rss = Syy - al * Sy - b * Sxy, s2 = Math.max(rss, 1e-300) / (nn - 2);
      const tt = b / Math.sqrt(s2 * nn / den); if (tt > best) best = tt;
    }
    out[first + t] = best;
  }
  return { stat: out, first };
}
const cvAt = (q, kIdx) => { const k = kIdx - CV.w0 + 1; if (k < 1) return NaN_; const L = Math.log(k); return q[0] + q[1] * L + q[2] * L * L };

// ---------- the detector (port of detect.py) ----------
function detect(M) {
  const n = M.n, P = M.P, rP = M.realP, CAPE = ffill(M.CAPE), rE = ffill(shift(M.realE, 3), 9);
  const mcap = map2(M.NCBEILQ027S, M.GDP, (a, b) => a / 1000 / b), marg = map2(M.BOGZ1FL663067003Q, M.GDP, (a, b) => a / 1000 / b), corp = map2(M.CORPDEBT, M.GDP, (a, b) => a / 1000 / b);
  const B = {};
  for (const [k, s] of [['bp', lg(rP)], ['bpd', lg(map2(P, ffill(M.D, 9), (a, b) => a / b))], ['bcape', lg(CAPE)]]) {
    const r = bsadf(s); B[k] = r.stat; B[k + '_cv'] = s.map((_, i) => (r.first >= 0 && i >= r.first ? cvAt(CV.q95, i - r.first) : NaN_));
  }
  const up = rP.map((x, i) => i >= 12 && isF(x) && isF(rP[i - 12]) && x > rP[i - 12]);
  const ex = k => B[k].map((s, i) => isF(s) && isF(B[k + '_cv'][i]) && s > B[k + '_cv'][i] && up[i]);
  const exp = { bp: ex('bp'), bpd: ex('bpd'), bcape: ex('bcape') };
  const I = {};
  I.v_cape = xpct(CAPE); I.v_buff = xpct(mcap);
  I.x_cape36 = xpct(diff(lg(CAPE), 36)); I.x_ip36 = xpct(map2(diff(lg(rP), 36), diff(lg(M.INDPRO), 36), (a, b) => a - b)); I.x_e24 = xpct(map2(diff(lg(rP), 24), diff(lg(rE), 24), (a, b) => a - b));
  const fmax = (a, b) => (isF(a) && isF(b) ? Math.max(a, b) : isF(a) ? a : isF(b) ? b : NaN_);
  I.x_bsadf = xpct(B.bpd.map((_, i) => fmax(B.bpd[i] - B.bpd_cv[i], B.bcape[i] - B.bcape_cv[i])));
  const mgrowth = fillna(diff(lg(M.MARGIN), 12), diff(lg(M.BOGZ1FL663067003Q), 12));
  for (let i = M.shLast + 1; i < n; i++) if (!isF(M.MARGIN[i])) mgrowth[i] = mgrowth[i - 1];   // live months before FINRA publishes: keep last month's growth reading
  I.l_level = meanAvail([xpct(marg), xpct(diff(marg, 36))]); I.l_growth = xpct(mgrowth);
  I.f_alloc = xpct(M.BOGZ1FL153064486Q); I.f_chase = xpct(diff(lg(rP), 24));
  const spread = map2(M.BAA, M.GS10, (a, b) => a - b);
  I.r_spread = inv(xpct(spread)); I.r_corp = meanAvail([xpct(corp), xpct(diff(corp, 36))]); I.r_nfci = inv(xpct(M.NFCI)); I.r_bank = xpct(diff(lg(M.TOTBKCR), 12));
  I.k_ecy = inv(xpct(M.ECY)); I.k_conc = xpct(diff(lg(map2(M.SPX, M.RSP, (a, b) => a / b)), 36), 60);
  const ndx = lg(map2(M.NDX, M.SPX, (a, b) => a / b)), ndxm = rmean(ndx, 60); I.k_ndx = xpct(map2(ndx, ndxm, (a, b) => a - b));
  I.k_rut = inv(xpct(diff(lg(map2(M.RUT, M.SPX, (a, b) => a / b)), 36), 60));
  // trend: expanding log-linear fit of real price, refitted each month (O(1) updates)
  const lp = lg(rP), sig = arr(n), trend = arr(n), sd = arr(n);
  let Sx = 0, Sy = 0, Sxx = 0, Sxy = 0, Syy = 0, c = 0;
  for (let t = 0; t < n; t++) {
    if (isF(lp[t])) { Sx += t; Sy += lp[t]; Sxx += t * t; Sxy += t * lp[t]; Syy += lp[t] * lp[t]; c++ }
    if (t >= 240 && c > 2) { const b = (c * Sxy - Sx * Sy) / (c * Sxx - Sx * Sx), a = (Sy - b * Sx) / c;
      const rss = Syy - 2 * a * Sy - 2 * b * Sxy + c * a * a + 2 * a * b * Sx + b * b * Sxx; sd[t] = Math.sqrt(Math.max(rss, 0) / c); trend[t] = a + b * t; sig[t] = (lp[t] - trend[t]) / sd[t] }
  }
  I.g_sigma = sig.map(s => (isF(s) ? 50 * (1 + erf(s / Math.SQRT2)) : NaN_));
  const Pl = {}; for (const p of PILLARS) Pl[p] = meanAvail(PIND[p].map(k => I[k]));
  const froth = meanAvail(PILLARS.map(p => Pl[p]));
  // momentum killers (1 on, 0 off, NaN no data)
  const short = fillna(M.FEDFUNDS, M.TB3MS), g10 = M.GS10, tb = M.TB3MS;
  const flag = (cond, avail) => cond.map((x, i) => (avail[i] ? (x ? 1 : 0) : NaN_));
  const sd12 = diff(short, 12), g12 = diff(g10, 12), smin = rmin(spread, 12), sma10 = rmean(P, 10);
  const u3 = rmean(M.UNRATE, 3), u3min = rmin(shift(u3, 1), 12), nf6 = diff(M.NFCI, 6), re12 = diff(rE, 12);
  const cpi12 = M.CPI.map((x, i) => (i >= 12 && isF(x) && isF(M.CPI[i - 12]) ? x / M.CPI[i - 12] - 1 : NaN_)), cpi12s = shift(cpi12, 6);
  const K = {
    fed_hikes: flag(sd12.map(x => x >= 1), sd12.map(isF)),
    curve_inv: flag(g10.map((x, i) => x - tb[i] < 0), tb.map(isF)),
    bond_shock: flag(g12.map(x => x >= 1), g12.map(isF)),
    credit_widen: flag(spread.map((x, i) => x - smin[i] >= 0.5), spread.map(isF)),
    trend_break: flag(P.map((x, i) => x < sma10[i]), sma10.map(isF)),
    jobs_turn: flag(u3.map((x, i) => x - u3min[i] >= 0.5), M.UNRATE.map(isF)),
    fin_tight: flag(nf6.map(x => x >= 0.25), nf6.map(isF)),
    earn_fall: flag(re12.map(x => x < 0), re12.map(isF)),
    inflation: flag(cpi12.map((x, i) => x >= 0.04 && x > cpi12s[i]), cpi12.map(isF)),
    lend_tight: flag(M.DRTSCILM.map(x => x >= 20), M.DRTSCILM.map(isF)),
  };
  const kill_n = arr(n, 0), kill_avail = arr(n, 0), km = arr(n, 0), ka = arr(n, 0);
  KILLERS.forEach((k, j) => K[k].forEach((v, i) => { if (isF(v)) { kill_avail[i]++; ka[i] |= 1 << j; if (v) { kill_n[i]++; km[i] |= 1 << j } } }));
  const expl_up = exp.bpd.map((x, i) => (x || exp.bcape[i] ? 1 : 0)), expl_p = exp.bp.map(x => (x ? 1 : 0));
  const tier = froth.map((f, i) => (f >= 75 || (expl_up[i] && f >= 65) ? 2 : f >= 65 ? 1 : 0));
  return { I, Pl, froth, tier, K, kill_n, kill_avail, km, ka, expl_up, expl_p, B, sig, trend, sd, spread, short, sma10, CAPEf: CAPE, mcap, marg };
}

// ---------- outcomes, episodes, bear markets, validation ----------
function dailySpx(raw) { const y = raw.yahoo['^GSPC']; return { d: y.d, c: y.c } }
function forward(M) {
  const n = M.n, P = M.P, rP = M.realP, fr = arr(n), fdd = arr(n), fr12 = arr(n);
  for (let t = 0; t < n; t++) { if (t + 12 < n) fr12[t] = rP[t + 12] / rP[t] - 1; if (t + 36 < n) { fr[t] = rP[t + 36] / rP[t] - 1; let m = Infinity; for (let j = t + 1; j <= t + 36; j++) m = Math.min(m, P[j]); fdd[t] = m / P[t] - 1 } }
  return { fr, fdd, fr12 };
}
function bearsOf(s, thr = 0.2) {   // s: [[time, value]] -> peak/trough declines of 20%+, lower highs and lower lows merged
  const out = []; if (!s.length) return out; let hi = s[0][1], hid = s[0][0], lo = hi, lod = hid, inb = false;
  for (const [d, v] of s) {
    if (!inb) { if (v > hi) { hi = v; hid = d } else if (v <= hi * (1 - thr)) { inb = true; lo = v; lod = d } }
    else { if (v < lo) { lo = v; lod = d } if (v >= lo * (1 + thr) && v > lo) { out.push([hid, hi, lod, lo]); inb = false; hi = v; hid = d } }
  }
  if (inb) out.push([hid, hi, lod, lo]);
  const mg = []; for (const b of out) { if (mg.length && b[1] < mg[mg.length - 1][1] && b[3] < mg[mg.length - 1][3]) mg[mg.length - 1] = [mg[mg.length - 1][0], mg[mg.length - 1][1], b[2], b[3]]; else mg.push(b) }
  return mg.map((b, k) => { const nxt = k + 1 < mg.length ? mg[k + 1][0] : s[s.length - 1][0]; let mn = Infinity, md = null; for (const [d, v] of s) if (d >= b[0] && d <= nxt && v < mn) { mn = v; md = d } return [b[0], b[1], md, mn] });
}
function history(M, Dt, raw) {
  const n = M.n, S = Dt, spx = dailySpx(raw);
  const mSeries = []; for (let i = 0; i < Math.min(n, (1928 - T0) * 12); i++) if (isF(M.P[i])) mSeries.push([i, M.P[i]]);   // month index
  const dSeries = spx.d.map((d, k) => [d, spx.c[k]]);
  const mAll = []; for (let i = 0; i < n; i++) if (isF(M.P[i])) mAll.push([i, M.P[i]]);
  const ymFromKey = (key, daily) => (daily ? ymOfDay(key) : key), strKey = (key, daily) => (daily ? dayStr(key) : ymOf(key) + '-01');
  const bears = [];
  for (const [b, daily] of [[bearsOf(mSeries), false], [bearsOf(dSeries), true]]) for (const [pk, pv, tr, tv] of b) {
    const pm = ymFromKey(pk, daily); let mx = -Infinity, flagged = false, elev = false, any = false;
    for (let i = Math.max(0, pm - 24); i <= pm && i < n; i++) { if (isF(S.froth[i])) { any = true; mx = Math.max(mx, S.froth[i]) } if (S.tier[i] === 2) flagged = true; if (S.tier[i] >= 1) elev = true }
    bears.push({ peak: strKey(pk, daily), trough: strKey(tr, daily), dd: +((tv / pv - 1) * 100).toFixed(1), max_froth_24m: any ? +mx.toFixed(1) : null, flagged, elevated: elev, kill_at_peak: pm < n ? S.kill_n[pm] : null });
  }
  // bubble-zone episodes
  const f = S.tier.map(t => t === 2), runs = []; for (let i = 0; i < n;) { if (f[i]) { let j = i; while (j + 1 < n && f[j + 1]) j++; runs.push([i, j]); i = j + 1 } else i++ }
  const mr = []; for (const r of runs) { if (mr.length && r[0] - mr[mr.length - 1][1] <= 7) mr[mr.length - 1][1] = r[1]; else mr.push(r.slice()) }
  const firstDailyM = ymOfDay(spx.d[0]) + 1;
  const eps = [];
  for (const [a, b] of mr) {
    if (b - a + 1 < 3) continue;
    const ongoing = b === n - 1, wEnd = b + 6 + 1;   // window to six months after the episode
    let pk, pv = -Infinity, s, daily = a >= firstDailyM;
    if (daily) { s = dSeries; for (const [d, v] of s) { const m = ymOfDay(d); if (m >= a && m < wEnd && v > pv) { pv = v; pk = d } } }
    else { s = mAll; for (const [m, v] of mAll) if (m >= a && m < wEnd && v > pv) { pv = v; pk = m } }
    let tr = null, tv = null, rec = null;
    if (!ongoing && pk != null) {
      const cap = daily ? pk + 3652 : pk + 120; let mn = Infinity, md = null;
      for (const [d, v] of s) { if (d <= pk) continue; if (v > pv) { rec = d; break } if (d <= cap && v < mn) { mn = v; md = d } }
      tr = md; tv = mn;
    }
    let top = a; for (let i = a; i <= b; i++) if (S.froth[i] > S.froth[top]) top = i;
    let mk = 0, ex = false; for (let i = a; i <= b; i++) { mk = Math.max(mk, S.kill_n[i]); if (S.expl_up[i] || S.expl_p[i]) ex = true }
    const pa = {}; for (const p of PILLARS) pa[p] = isF(S.Pl[p][top]) ? Math.round(S.Pl[p][top]) : null;
    const e = { start: ymOf(a), end: ymOf(b), months: b - a + 1, ongoing, max_froth: +Math.max(...S.froth.slice(a, b + 1).filter(isF)).toFixed(1), peak: pk == null ? null : strKey(pk, daily), peak_px: +pv.toFixed(2),
      trough: tr == null ? null : strKey(tr, daily), trough_px: tv == null || !isF(tv) ? null : +tv.toFixed(2), dd: tr == null ? null : +((tv / pv - 1) * 100).toFixed(1), recovered: rec == null ? null : strKey(rec, daily), explosive: ex, max_kill: mk, pillars_at_max: pa };
    if (!ongoing) { const lo = a, hi = b + 24; e.followed_by_bear = bears.some(r => { const m = idxOfYm(r.peak.slice(0, 7)); return m >= lo && m <= hi }) }
    eps.push(e);
  }
  return { bears, episodes: eps };
}
function validation(M, S, F) {
  const rows = []; for (let i = (1891 - T0) * 12; i < M.n; i++) if (isF(S.froth[i]) && isF(F.fdd[i])) rows.push(i);
  const bins = [[0, 40], [40, 55], [55, 65], [65, 75], [75, 101]];
  const val = bins.map(([a, b]) => { const w = rows.filter(i => S.froth[i] >= a && S.froth[i] < b); const fr = w.map(i => F.fr[i]), dd = w.map(i => F.fdd[i]).sort((x, y) => x - y);
    return { lo: a, hi: Math.min(b, 100), n: w.length, fwd_real: +(fr.reduce((s, x) => s + x, 0) / w.length * 100).toFixed(1), dd_med: +(median(dd) * 100).toFixed(1), p25: Math.round(w.filter(i => F.fdd[i] <= -0.25).length / w.length * 100) } });
  const w65 = rows.filter(i => S.froth[i] >= 65), kf = i => S.kill_n[i] / S.kill_avail[i] * 100;
  const valk = [[-1, 15, 'under 15%'], [15, 30, '15-30%'], [30, 101, '30% or more']].map(([a, b, lab]) => { const w = w65.filter(i => (a < 0 ? kf(i) <= b : kf(i) > a && kf(i) <= b));
    return { lab, n: w.length, fwd_real: +(w.reduce((s, i) => s + F.fr[i], 0) / w.length * 100).toFixed(1), p25: Math.round(w.filter(i => F.fdd[i] <= -0.25).length / w.length * 100) } });
  return { val, valk, rows };
}
const median = a => { if (!a.length) return NaN_; const s = a.slice().sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2 };
const quant = (a, q) => { if (!a.length) return NaN_; const s = a.slice().sort((x, y) => x - y), p = (s.length - 1) * q, lo = Math.floor(p), hi = Math.ceil(p); return s[lo] + (s[hi] - s[lo]) * (p - lo) };

// ---------- crash-buy score and tranche plan (port of crash.py / the plan backtest) ----------
function crash(M, S, raw) {
  const n = M.n, P = M.P, spx = dailySpx(raw);
  // realised volatility: 21-day daily (annualised) at each month end from 1928, 6-month monthly before
  const rvd = arr(n); { const c = spx.c, d = spx.d, r = []; for (let k = 1; k < c.length; k++) { r.push(Math.log(c[k] / c[k - 1]));
      if (r.length >= 21) { const w = r.slice(-21), m = w.reduce((s, x) => s + x, 0) / 21, v = Math.sqrt(w.reduce((s, x) => s + (x - m) ** 2, 0) / 20) * Math.sqrt(252); const i = ymOfDay(d[k]); if (i >= 0 && i < n) rvd[i] = v } } }
  const rm = diff(lg(P), 1), rvm = rstd(rm, 6).map(x => x * Math.sqrt(12)), vol = fillna(rvd, rvm);
  const dd24 = P.map((x, i) => { let m = -Infinity; for (let j = Math.max(0, i - 23); j <= i; j++) if (isF(P[j])) m = Math.max(m, P[j]); return x / m - 1 });
  const fmax36 = rmax(S.froth, 36, 1), fdrop = S.froth.map((x, i) => (isF(x) ? Math.max(0, fmax36[i] - x) : NaN_));
  const sp = S.spread, spmin = rmin(sp, 12, 1), widen = sp.map((x, i) => x - spmin[i]), sp3 = rmax(sp, 3, 1);
  const smax = rmax(S.short, 12, 1), dd12min = rmin(dd24, 12, 1);
  const cl = x => (isF(x) ? Math.min(1, Math.max(0, x)) : 0);
  const comp = { depth: [], reset: [], fear: [], credit: [], ease: [], turn: [] }, score = arr(n), stage = arr(n, 0), w = arr(n, 0);
  for (let i = 0; i < n; i++) {
    comp.depth[i] = 30 * cl((-dd24[i] - 0.10) / 0.30);
    comp.reset[i] = 20 * cl(fdrop[i] / 30);
    comp.fear[i] = 15 * cl((vol[i] - 0.20) / 0.25);
    const wd = isF(sp[i]) && widen[i] >= 0.5; comp.credit[i] = wd ? (sp[i] < sp3[i] - 0.1 ? 10 : 5) : 0;
    comp.ease[i] = isF(S.short[i]) ? 10 * cl(-(S.short[i] - smax[i]) / 1.5) : 0;
    comp.turn[i] = isF(S.sma10[i]) && P[i] > S.sma10[i] && dd12min[i] <= -0.15 ? 15 : 0;
    score[i] = comp.depth[i] + comp.reset[i] + comp.fear[i] + comp.credit[i] + comp.ease[i] + comp.turn[i];
  }
  // tranche plan: 1/3 when the score reaches 65, 1/3 more after a further 20% fall (or score 80), the rest when the trend turns back up
  let st = { active: false, w: 0, p1: null, g1: false, g2: false };
  const events = [];
  for (let i = 0; i < n; i++) {
    if (!st.active && dd24[i] <= -0.10) st = { active: true, w: 0, p1: null, g1: false, g2: false, start: i };
    if (st.active) {
      if (!st.g1 && score[i] >= 65) { st.g1 = true; st.w += 1 / 3; st.p1 = P[i]; events.push({ i, kind: 'tranche1' }) }
      if (st.g1 && !st.g2 && (P[i] <= st.p1 * 0.8 || score[i] >= 80) && st.w < 0.99) { st.g2 = true; st.w += 1 / 3; events.push({ i, kind: 'tranche2' }) }
      if (comp.turn[i] > 0 && st.w < 0.999) { st.w = 1; events.push({ i, kind: 'trend' }) }
      if (dd24[i] > -0.05) { if (st.w > 0 || st.active) events.push({ i, kind: 'over' }); st = { active: false, w: 0, p1: null, g1: false, g2: false } }
    }
    w[i] = st.w; stage[i] = !st.active ? 0 : st.w >= 0.999 ? 4 : st.g2 ? 3 : st.g1 ? 2 : 1;
  }
  return { score, comp, vol, dd24, stage, w, events, state: st };
}
// how each past bear market went for the tranche plan (cost vs the low, value after four years)
function planHistory(M, bears, C) {
  const P = M.P, out = [];
  for (const b of bears) {
    const pk = idxOfYm(b.peak.slice(0, 7)), tr = idxOfYm(b.trough.slice(0, 7)); if (pk < (1891 - T0) * 12 || tr >= M.n) continue;
    let low = Infinity; for (let i = pk; i <= Math.min(M.n - 1, tr + 2); i++) low = Math.min(low, P[i]);
    const buys = []; let p1 = null, g1 = false, g2 = false;
    for (let i = pk + 1; i <= Math.min(M.n - 1, tr + 24); i++) {
      if (!g1 && C.score[i] >= 65) { buys.push([i, 1 / 3]); g1 = true; p1 = P[i] }
      if (g1 && !g2 && i > buys[0][0] && (P[i] <= p1 * 0.8 || C.score[i] >= 80)) { buys.push([i, 1 / 3]); g2 = true }
      if (C.comp.turn[i] > 0) { buys.push([i, 1 - buys.reduce((s, x) => s + x[1], 0)]); break }
    }
    let at20 = null; for (let i = pk + 1; i <= Math.min(M.n - 1, tr + 24); i++) if (C.dd24[i] <= -0.2) { at20 = i; break }
    const cost = bl => bl.reduce((s, x) => s + x[1], 0) / bl.reduce((s, x) => s + x[1] / P[x[0]], 0) / low - 1;
    out.push({ peak: b.peak.slice(0, 7), dd: b.dd, buys: buys.map(([i, wt]) => ({ month: ymOf(i), share: +wt.toFixed(3) })), plan_cost: buys.length ? +(cost(buys) * 100).toFixed(0) : null, at20_cost: at20 != null ? +((P[at20] / low - 1) * 100).toFixed(0) : null });
  }
  return out;
}
// crash-buy score against what came next, split into the design years and the later test years
function crashValidation(M, C, F) {
  const bins = [[-1, 20], [20, 35], [35, 50], [50, 65], [65, 101]], out = [];
  for (const [lab, a0, a1] of [['1891-1969 (design)', 1891, 1970], ['1970-2023 (test)', 1970, 2100]]) {
    const rows = []; for (let i = (a0 - T0) * 12; i < Math.min(M.n, (a1 - T0) * 12); i++) if (isF(F.fr[i])) rows.push(i);
    out.push({ era: lab, rows: bins.map(([a, b]) => { const w = rows.filter(i => C.score[i] > a && C.score[i] <= b); if (!w.length) return { lo: a + 1, hi: Math.min(b, 100), n: 0 };
      return { lo: a + 1, hi: Math.min(b, 100), n: w.length, fwd12: +(w.reduce((s, i) => s + F.fr12[i], 0) / w.length * 100).toFixed(1), fwd36: +(w.reduce((s, i) => s + F.fr[i], 0) / w.length * 100).toFixed(1), further: +(median(w.map(i => F.fdd[i])) * 100).toFixed(1), p15: Math.round(w.filter(i => F.fdd[i] <= -0.15).length / w.length * 100) } }) });
  }
  return out;
}
// how far it could fall: base rates from similar months, past bear markets, and valuation anchors
function fallEstimate(M, S, F, V, hist, C, last) {
  const f0 = S.froth[last], near = V.rows.filter(i => Math.abs(S.froth[i] - f0) <= 5);
  const probs = [10, 20, 30, 40, 50].map(x => ({ fall: x, pct: near.length ? Math.round(near.filter(i => F.fdd[i] <= -x / 100).length / near.length * 100) : null }));
  const dds = hist.bears.filter(b => b.max_froth_24m != null).map(b => b.dd / 100);
  const depthNow = C.dd24[last];
  const deeper = dds.filter(d => d <= Math.min(-0.2, depthNow));
  const cond = deeper.length ? { n: deeper.length, median: median(deeper), q25: quant(deeper, 0.25), q75: quant(deeper, 0.75) } : null;
  const cape = S.CAPEf[last], Pn = M.P[last];
  const anchors = [];
  const capeMed = (from, to = last) => median(S.CAPEf.slice(from, to + 1).filter(isF));
  for (const [lab, v] of [['CAPE at its 1990–now median', capeMed((1990 - T0) * 12)], ['CAPE at its 1950–now median', capeMed((1950 - T0) * 12)], ['CAPE at its 1881–now median', capeMed(0)]]) anchors.push({ label: lab, cape: +v.toFixed(1), fall: +((v / cape - 1) * 100).toFixed(0) });
  const tr = Math.exp(S.trend[last]), rp = M.realP[last];
  anchors.push({ label: 'Back to +1σ above the long-run trend', fall: +((tr * Math.exp(S.sd[last]) / rp - 1) * 100).toFixed(0) });
  anchors.push({ label: 'Back to the long-run trend (Grantham)', fall: +((tr / rp - 1) * 100).toFixed(0) });
  return { froth: f0, nearN: near.length, probs, bears: { n: dds.length, median: median(dds), q25: quant(dds, 0.25), q75: quant(dds, 0.75), q10: quant(dds, 0.10) }, depthNow, cond, anchors, price: Pn };
}

// ---------- everything ----------
function compute(raw, opt = {}) {
  const M = panel(raw, opt), S = detect(M), F = forward(M), hist = history(M, S, raw), V = validation(M, S, F), C = crash(M, S, raw), last = M.n - 1;
  const fall = fallEstimate(M, S, F, V, hist, C, last), plan = planHistory(M, hist.bears, C), cval = crashValidation(M, C, F);
  return { M, S, F, hist, V, C, fall, plan, cval, last };
}
// compact JSON for the Bubble Watch page (same shape as the research page, plus the crash section)
function toPage(R, raw) {
  const { M, S, F, hist, V, C, fall, plan, cval, last } = R;
  const r = (a, k = 1) => a.map(v => (isF(v) ? +v.toFixed(k) : null)), ri = a => a.map(v => (isF(v) ? Math.round(v) : null));
  const trendNom = S.trend.map((t, i) => (isF(t) ? Math.exp(t) * M.P[i] / M.realP[i] : NaN_));
  const mon = { start: '1871-01', n: M.n, P: r(M.P, 2), realP: r(M.realP, 2), trendpx: r(trendNom, 2), sd: r(S.sd, 4), sigma: r(S.sig, 2), froth: r(S.froth), tier: S.tier, kill_n: S.kill_n, kill_avail: S.kill_avail, km: S.km, ka: S.ka,
    expl_up: S.expl_up, expl_p: S.expl_p, cape: r(S.CAPEf, 1), buff: r(S.mcap.map(x => x * 100), 0), margin: r(S.marg.map(x => x * 100), 2), hh: r(M.BOGZ1FL153064486Q, 1), spread: r(S.spread, 2), ecy: r(M.ECY.map(x => x * 100), 2), gs10: r(M.GS10, 2), ff: r(S.short, 2), tb3: r(M.TB3MS, 2),
    bsadf: r(S.B.bp, 2), bsadf_cv: r(S.B.bp_cv, 2), bpd: r(S.B.bpd, 2), bpd_cv: r(S.B.bpd_cv, 2), fwd_real: r(F.fr.map(x => x * 100), 1), fwd_dd: r(F.fdd.map(x => x * 100), 1),
    crash: r(C.score, 0), cstage: C.stage, cw: r(C.w, 3), vol: r(C.vol.map(x => x * 100), 0), dd24: r(C.dd24.map(x => x * 100), 1), vix: r(M.VIX, 1), hy: r(M.HY, 2) };
  for (const p of PILLARS) mon[p] = ri(S.Pl[p]);
  mon.ind = {}; for (const [k, v] of Object.entries(S.I)) mon.ind[k] = ri(v);
  mon.ccomp = {}; for (const [k, v] of Object.entries(C.comp)) mon.ccomp[k] = r(v, 1);
  const spx = raw.yahoo['^GSPC'], d0 = spx.d[0], dd = spx.d.map((d, k) => (k ? d - spx.d[k - 1] : 0));
  const daily = { start: dayStr(d0), dd, c: spx.c.map(x => +x.toFixed(2)) };
  let hiV = -Infinity, hiD = null; for (let k = 0; k < spx.c.length; k++) if (spx.c[k] > hiV) { hiV = spx.c[k]; hiD = spx.d[k] }
  const fr0 = ((raw.finra && raw.finra.rows) || []).slice().sort((x, y) => (x[0] < y[0] ? 1 : -1))[0];
  const snap = { finra: fr0 ? { month: fr0[0], debit: fr0[1] } : null, month: ymOf(last), daily_last: dayStr(spx.d[spx.d.length - 1]), close: spx.c[spx.c.length - 1], high: hiV, high_date: dayStr(hiD), liveFrom: M.liveFrom != null ? ymOf(M.liveFrom) : null, shillerLast: ymOf(M.shLast) };
  return { mon, daily, episodes: hist.episodes, bears: hist.bears, val: V.val, valk: V.valk, killers: KILLERS, pillars: PILLARS, snap, fall, plan, cval, events: C.events.slice(-40).map(e => ({ month: ymOf(e.i), kind: e.kind })) };
}

module.exports = { compute, toPage, panel, detect, bsadf, xpct, CV, PILLARS, KILLERS, ymOf, idxOfYm };

// Keeps the Bubble Watch up to date on this PC: raw source data (starts from the bundled Nov 2026 snapshot),
// a daily refresh from the public sources, the computed page data, a daily score log, and the optional news check.
'use strict';
const fs = require('fs'), path = require('path'), zlib = require('zlib');
const MODEL = require('./model'), SRC = require('./sources'), NEWS = require('./news');

const DAY = 864e5;
const today = () => new Date().toISOString().slice(0, 10);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const readJson = (f, d = null) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')) } catch { return d } };
const { writeAtomic } = require('../atomic');   // retries while Windows has the file open

const IND_LABEL = { v_cape: 'CAPE (Shiller P/E)', v_buff: 'Stock market value / GDP', x_cape36: 'CAPE change over 3 years', x_ip36: 'Real price growth minus industrial output growth, 3 years', x_e24: 'Real price growth minus real earnings growth, 2 years', x_bsadf: 'Explosive-root test, price vs dividends and CAPE', l_level: 'Margin loans / GDP', l_growth: 'Margin debt growth, 12 months', f_alloc: "Households' equity share of financial assets", f_chase: 'Real price gain over 2 years', r_spread: 'Baa minus 10-year spread (tighter scores higher)', r_corp: 'Corporate bond debt / GDP', r_nfci: 'Chicago Fed financial conditions (looser scores higher)', r_bank: 'Bank credit growth', k_ecy: 'Excess CAPE yield (lower scores higher)', k_conc: 'Cap-weighted vs equal-weighted S&P 500', k_ndx: 'Nasdaq vs S&P 500', k_rut: 'Small caps lagging', g_sigma: 'Distance above the long-run trend' };
const KILL_LABEL = { fed_hikes: 'Fed rate up 1 point or more in 12 months', curve_inv: 'Yield curve inverted', bond_shock: '10-year yield up 1 point or more in 12 months', credit_widen: 'Credit spread 0.5 point above its 12-month low', trend_break: 'S&P below its 10-month average', jobs_turn: 'Unemployment up 0.5 point from its low', fin_tight: 'Financial conditions tightening', earn_fall: 'Real earnings falling', inflation: 'Inflation 4% or more and rising', lend_tight: 'Banks tightening loan standards' };
const STAGES = ['No crash under way', 'Falling: wait', 'First third bought', 'Two thirds bought', 'Trend turned: fully bought'];

class BubbleService {
  constructor({ dir, seedFile, newsSeedFile, log = () => {} }) {
    this.dir = dir; this.seedFile = seedFile; this.newsSeedFile = newsSeedFile; this.log = log; this.running = null;
    fs.mkdirSync(dir, { recursive: true });
    this.f = { raw: path.join(dir, 'raw.json.gz'), page: path.join(dir, 'page.json'), state: path.join(dir, 'state.json'), news: path.join(dir, 'news.json'), log: path.join(dir, 'log.json') };
  }
  raw() {
    for (const f of [this.f.raw, this.seedFile]) { try { return JSON.parse(zlib.gunzipSync(fs.readFileSync(f))) } catch {} }
    throw new Error('no Bubble Watch data found');
  }
  saveRaw(raw) { writeAtomic(this.f.raw, zlib.gzipSync(JSON.stringify(raw))) }
  state() { return readJson(this.f.state, { sources: {} }) }
  saveState(s) { writeAtomic(this.f.state, JSON.stringify(s, null, 1)) }
  news() { return readJson(this.f.news) || readJson(this.newsSeedFile) }
  scoreLog() { return readJson(this.f.log, []) }

  // compute scores from the raw data and write the page file; returns the page data
  recompute(raw = this.raw()) {
    const R = MODEL.compute(raw), page = MODEL.toPage(R, raw);
    page.computedAt = new Date().toISOString(); page.rawAsOf = raw.asOf || null;
    writeAtomic(this.f.page, JSON.stringify(page));
    const L = R.last, entry = { date: today(), month: page.snap.month, close: page.snap.close, froth: +R.S.froth[L].toFixed(1), tier: R.S.tier[L], kill_n: R.S.kill_n[L], kill_avail: R.S.kill_avail[L], crash: Math.round(R.C.score[L]), stage: R.C.stage[L] };
    const log = this.scoreLog().filter(x => x.date !== entry.date); log.push(entry); writeAtomic(this.f.log, JSON.stringify(log.slice(-400)));
    this._page = page; return page;
  }
  page() { if (!this._page) this._page = readJson(this.f.page); if (!this._page) this._page = this.recompute(); return this._page }
  // everything the Bubble Watch tab needs
  pageJson() {
    const n = this.news(), log = this.scoreLog(), last = log[log.length - 1] || null;
    const withTilt = n && last ? { tilt: n.tilt || 0, score: Math.max(0, Math.min(100, last.froth + (n.tilt || 0))) } : null;
    return { ...this.page(), news: n, scoreLog: log.slice(-60), status: this.state(), withNews: withTilt };
  }
  due(now = Date.now()) { const s = this.state(); return !s.lastSuccess || (now - Date.parse(s.lastSuccess) > 20 * 3600e3 && (!s.lastAttempt || now - Date.parse(s.lastAttempt) > 3 * 3600e3)) }

  update(opts = {}) { if (!this.running) this.running = this._update(opts).finally(() => { this.running = null }); return this.running }
  async _update({ force = false, apiKey = null, model = 'claude-sonnet-5-5', news = true, onProgress = () => {} } = {}) {
    const st = this.state(); st.lastAttempt = new Date().toISOString(); st.sources = st.sources || {}; this.saveState(st);
    const raw = this.raw(), before = JSON.stringify({ s: raw.shiller.rows.length });
    const ok = (k, detail) => { st.sources[k] = { ok: true, at: new Date().toISOString(), detail } }, bad = (k, e) => { st.sources[k] = { ...(st.sources[k] || {}), ok: false, at: new Date().toISOString(), error: String(e.message || e).slice(0, 200) }; this.log(`bubble: ${k} failed: ${e.message || e}`) };
    onProgress('Daily prices');
    for (const sym of SRC.YAHOO_SYMS) { try { raw.yahoo[sym] = SRC.mergeDaily(raw.yahoo[sym], await SRC.yahoo(sym)); ok('yahoo ' + sym, `to ${new Date(raw.yahoo[sym].d.slice(-1)[0] * DAY).toISOString().slice(0, 10)}`) } catch (e) { bad('yahoo ' + sym, e) } await sleep(400) }
    onProgress('Federal Reserve data');
    for (const id of SRC.FRED_IDS) { try { raw.fred[id] = await SRC.fred(id); ok('fred ' + id, `${raw.fred[id].start} + ${raw.fred[id].last.length} months`) } catch (e) { bad('fred ' + id, e) } await sleep(400) }
    const weekly = k => force || !st.sources[k] || !st.sources[k].ok || Date.now() - Date.parse(st.sources[k].at) > 6 * DAY;
    if (weekly('shiller')) { onProgress('Shiller data'); try { const s = await SRC.shiller(); if (s.rows.length >= raw.shiller.rows.length - 2) { raw.shiller = { rows: s.rows, lastModified: s.lastModified }; ok('shiller', `to ${s.rows[s.rows.length - 1][0]}`) } else throw new Error('new file is shorter than the saved one') } catch (e) { bad('shiller', e) } }
    if (weekly('finra')) { onProgress('FINRA margin debt'); try { const f = await SRC.finra(); raw.finra = { rows: f.rows }; ok('finra', `to ${f.rows[0][0]}`) } catch (e) { bad('finra', e) } }
    if (Object.values(st.sources).some(x => x.ok && Date.now() - Date.parse(x.at) < 3600e3)) raw.asOf = today();
    onProgress('Scoring');
    let page;
    try { page = this.recompute(raw); this.saveRaw(raw); } catch (e) { bad('scoring', e); this.saveState(st); throw new Error('The new data could not be scored, so the previous readings were kept: ' + e.message) }
    const anyOk = Object.values(st.sources).some(s => s.ok && Date.now() - Date.parse(s.at) < 3600e3);
    if (anyOk) st.lastSuccess = new Date().toISOString();
    if (apiKey && news) {
      const prev = this.news();
      if (force || !prev || !prev.checkedAt || prev.checkedAt.slice(0, 10) !== today()) {
        onProgress('News check');
        try { const n = await NEWS.updateNews({ apiKey, model, readings: this.readings(page), previous: prev && { asOf: prev.asOf, headline: prev.headline, pillars: prev.pillars }, today: today() }); n.checkedAt = new Date().toISOString(); n.model = model; writeAtomic(this.f.news, JSON.stringify(n)); st.news = { ok: true, at: n.checkedAt } }
        catch (e) { st.news = { ok: false, at: new Date().toISOString(), error: String(e.message).slice(0, 200) }; this.log('bubble: news check failed: ' + e.message) }
      }
    }
    this.saveState(st); onProgress(null);
    return this.pageJson();
  }
  // compact snapshot of one month's readings, for the news check and the article checker
  readings(page = this.page(), i = null) {
    const m = page.mon, L = i == null ? m.n - 1 : i, ind = {};
    for (const [k, lab] of Object.entries(IND_LABEL)) if (m.ind[k] && m.ind[k][L] != null) ind[lab] = m.ind[k][L];
    const on = [], off = [], na = []; page.killers.forEach((k, j) => { if (!(m.ka[L] >> j & 1)) na.push(KILL_LABEL[k]); else ((m.km[L] >> j & 1) ? on : off).push(KILL_LABEL[k]) });
    const ps = {}; for (const p of page.pillars) ps[p] = m[p][L];
    return { month: MODEL.ymOf(L), sp500: m.P[L], bubble_score: m.froth[L], zone: ['Normal', 'Elevated', 'Bubble zone'][m.tier[L]], pillar_scores: ps, indicator_percentiles: ind,
      explosive_root_test: { real_price_stat: m.bsadf[L], needed_95pct: m.bsadf_cv[L], real_price_explosive: !!m.expl_p[L], vs_dividends_or_cape_explosive: !!m.expl_up[L] }, sigma_above_trend: m.sigma[L],
      values: { cape: m.cape[L], stock_value_to_gdp_pct: m.buff[L], margin_loans_to_gdp_pct: m.margin[L], household_equity_share_pct: m.hh[L], baa_minus_10y: m.spread[L], excess_cape_yield_pct: m.ecy[L], ten_year_yield: m.gs10[L], short_rate: m.ff[L], vix: m.vix[L] },
      momentum_killers: { on, off, no_data: na }, crash_buy: { score: m.crash[L], stage: STAGES[m.cstage[L]], drawdown_from_24m_high_pct: m.dd24[L] },
      base_rates: { by_bubble_score: page.val, by_killers: page.valk } };
  }
  async check({ apiKey, model, text, month }) {
    if (!apiKey) throw new Error('Add an Anthropic API key in Settings to check articles.');
    const page = this.page(), i = month ? Math.max(240, Math.min(page.mon.n - 1, MODEL.idxOfYm(month))) : null;
    return NEWS.checkArticle({ apiKey, model, readings: this.readings(page, i), text });
  }
}
module.exports = { BubbleService, STAGES, KILL_LABEL, IND_LABEL };

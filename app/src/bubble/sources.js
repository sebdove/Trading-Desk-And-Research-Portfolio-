// Downloads for the Bubble Watch. All public data, no keys:
//   Robert Shiller's ie_data.xls (shillerdata.com), FRED CSV downloads, FINRA margin statistics, Yahoo Finance daily closes.
// Each parser is separate from its download so the tests can feed it saved files.
'use strict';
let _xlsx = null; const XLSXlib = () => (_xlsx || (_xlsx = require('xlsx')));   // loaded only when a spreadsheet is parsed

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36';
async function get(url, { as = 'text', timeout = 45000 } = {}) {
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), timeout);
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: '*/*' }, signal: ctl.signal, redirect: 'follow' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return { body: as === 'buffer' ? Buffer.from(await r.arrayBuffer()) : as === 'json' ? await r.json() : await r.text(), headers: r.headers };
  } catch (e) { throw new Error(e.name === 'AbortError' ? 'timed out' : e.message) } finally { clearTimeout(t) }
}
const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() && !isNaN(+v.replace(/,/g, '')) ? +v.replace(/,/g, '') : null);

// ---------- Shiller ----------
function parseShiller(buf, minRows = 1800) {
  const XLSX = XLSXlib(), wb = XLSX.read(buf), sh = wb.Sheets.Data; if (!sh) throw new Error('no "Data" sheet in the Shiller file');
  const rows = XLSX.utils.sheet_to_json(sh, { header: 1, raw: true, defval: null }).filter(r => typeof r[0] === 'number' && r[0] > 1800);
  if (rows.length < minRows) throw new Error(`Shiller file has only ${rows.length} months`);
  return rows.map(r => [r[0].toFixed(2), ...[1, 2, 3, 4, 6, 7, 10, 12, 16].map(k => num(r[k]))]);
}
async function shiller() {
  const page = (await get('https://shillerdata.com/')).body;
  const m = page.match(/https?:[^"'\s<>]*ie_data\.xls[^"'\s<>]*/i) || page.match(/["']([^"']*ie_data\.xls[^"']*)["']/i);
  if (!m) throw new Error('could not find the ie_data.xls link on shillerdata.com');
  let url = (m[1] || m[0]).replace(/&amp;/g, '&'); if (url.startsWith('//')) url = 'https:' + url; else if (url.startsWith('/')) url = 'https://shillerdata.com' + url;
  const r = await get(url, { as: 'buffer' });
  return { rows: parseShiller(r.body), lastModified: r.headers.get('last-modified') || null, url };
}

// ---------- FRED ----------
function parseFred(csv) {
  const lines = csv.trim().split(/\r?\n/); if (lines.length < 3 || !/date/i.test(lines[0])) throw new Error('not a FRED CSV');
  const by = new Map();
  for (const ln of lines.slice(1)) { const [d, v] = ln.split(','); const x = num(v); if (x == null || !/^\d{4}-\d{2}/.test(d)) continue; const ym = d.slice(0, 7); if (!by.has(ym)) by.set(ym, []); by.get(ym).push(x) }
  const keys = [...by.keys()].sort(); if (!keys.length) throw new Error('FRED CSV has no values');
  const [y0, m0] = keys[0].split('-').map(Number), [y1, m1] = keys[keys.length - 1].split('-').map(Number);
  const last = [], mean = [];
  for (let y = y0, m = m0; y < y1 || (y === y1 && m <= m1); m === 12 ? (y++, m = 1) : m++) {
    const v = by.get(`${y}-${String(m).padStart(2, '0')}`);
    last.push(v ? v[v.length - 1] : null); mean.push(v ? +(v.reduce((s, x) => s + x, 0) / v.length).toFixed(6) : null);
  }
  return { start: keys[0], last, mean };
}
const FRED_IDS = ['GDP', 'NCBEILQ027S', 'BOGZ1FL663067003Q', 'NCBCEBQ027S', 'BOGZ1FL153064486Q', 'INDPRO', 'BAA', 'NFCI', 'TOTBKCR', 'FEDFUNDS', 'TB3MS', 'UNRATE', 'DRTSCILM', 'GS10', 'VIXCLS', 'BAMLH0A0HYM2'];
async function fred(id) { return parseFred((await get(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=${encodeURIComponent(id)}`)).body) }

// ---------- FINRA ----------
function parseFinra(buf) {
  const XLSX = XLSXlib(), wb = XLSX.read(buf), rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: false, defval: null });
  const out = []; for (const r of rows) { const ym = String(r[0] || '').trim(), v = num(r[1]); if (/^\d{4}-\d{2}$/.test(ym) && v != null) out.push([ym, v]) }
  if (out.length < 200) throw new Error(`FINRA file has only ${out.length} months`);
  return out;
}
async function finra() {
  const page = (await get('https://www.finra.org/rules-guidance/key-topics/margin-accounts/margin-statistics')).body;
  const m = page.match(/href="([^"]*margin-statistics[^"]*\.xlsx)"/i); if (!m) throw new Error('could not find the margin statistics spreadsheet on finra.org');
  const url = m[1].startsWith('http') ? m[1] : 'https://www.finra.org' + m[1];
  return { rows: parseFinra((await get(url, { as: 'buffer' })).body), url };
}

// ---------- Yahoo ----------
function parseYahoo(j) {
  const r = j && j.chart && j.chart.result && j.chart.result[0]; if (!r || !r.timestamp) throw new Error((j && j.chart && j.chart.error && j.chart.error.description) || 'no candles');
  const q = r.indicators.quote[0], d = [], c = [];
  r.timestamp.forEach((t, k) => { const v = q.close[k]; if (v == null) return; const day = Math.floor((t + (r.meta.gmtoffset || 0)) / 86400); if (d.length && d[d.length - 1] === day) { c[c.length - 1] = v; return } d.push(day); c.push(+v.toFixed(4)) });
  return { d, c };
}
async function yahoo(sym, range = '2y') { return parseYahoo((await get(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=${range}&interval=1d&includePrePost=false`, { as: 'json' })).body) }
function mergeDaily(old, add) {
  if (!old || !old.d.length) return add; const m = new Map(old.d.map((d, k) => [d, old.c[k]])); add.d.forEach((d, k) => m.set(d, add.c[k]));
  const d = [...m.keys()].sort((a, b) => a - b); return { d, c: d.map(x => m.get(x)) };
}
const YAHOO_SYMS = ['^GSPC', '^IXIC', '^RUT', 'RSP', '^VIX'];

module.exports = { get, shiller, parseShiller, fred, parseFred, FRED_IDS, finra, parseFinra, yahoo, parseYahoo, mergeDaily, YAHOO_SYMS };

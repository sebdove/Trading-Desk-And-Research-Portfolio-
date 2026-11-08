#!/usr/bin/env node
// Backtest the bot's exact rules on your own CSV files (one file per symbol: time,open,high,low,close,volume).
//   node src/backtest-cli.js --dir ./csv --bench SPY --preset stocks [--start 10000] [--from 2020-01-01]
const fs = require('fs'), path = require('path'), CORE = require('./core'), BT = require('./backtest');
const a = process.argv.slice(2), opt = (f, d) => { const i = a.indexOf(f); return i >= 0 ? a[i + 1] : d };
const dir = opt('--dir'), preset = CORE.PRESETS[opt('--preset', 'stocks')], benchName = opt('--bench', preset.market === 'crypto' ? 'BTCUSDT' : 'SPY');
if (!dir) { console.error('usage: --dir <folder of CSVs> [--preset stocks|crypto] [--bench SPY]'); process.exit(1) }
const parse = f => { const rows = fs.readFileSync(f, 'utf8').trim().split(/\r?\n/), S = { t: [], o: [], h: [], l: [], c: [], q: [] };
  for (const r of rows.slice(1)) { const [t, o, h, l, c, v] = r.split(','); const ts = /^\d+$/.test(t) ? (+t > 1e12 ? +t / 1000 : +t) : Date.parse(t) / 1000; if (!isFinite(ts) || !isFinite(+c)) continue;
    S.t.push(ts); S.o.push(+o); S.h.push(+h); S.l.push(+l); S.c.push(+c); S.q.push(+v * +c) } return S };
const data = {}; for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.csv'))) data[path.basename(f, '.csv')] = parse(path.join(dir, f));
const bench = data[benchName]; if (!bench) { console.error(`benchmark ${benchName}.csv not found`); process.exit(1) } delete data[benchName];
const r = BT.backtest({ ...preset, start: +opt('--start', 10000), from: Date.parse(opt('--from', '1970-01-01')) / 1000 }, data, bench, preset.tf);
console.log(`final $${r.final.toFixed(2)} · worst drop ${(r.dd * 100).toFixed(1)}% · ${r.trades.length} trades · ${(100 * r.trades.filter(t => t.pnl > 0).length / Math.max(1, r.trades.length)).toFixed(0)}% winners`);
fs.writeFileSync('backtest-trades.csv', 'symbol,side,entry_time,exit_time,entry,exit,pnl,reason\n' + r.trades.map(t => [t.sym, t.side, new Date(t.t0 * 1000).toISOString(), new Date(t.t1 * 1000).toISOString(), t.entry, t.exit, t.pnl.toFixed(2), t.why].join(',')).join('\n'));
console.log('trades written to backtest-trades.csv');

// Paper only, on an empty account: replay the last N days of real market data through the bot, so the
// dashboard has trades, positions and an account history straight away. One data download, no orders.
async function headStart(bot, days, log = console.log) {
  log(`head start: downloading market data to replay the last ${days} days on paper…`);
  const { series, bench, barTime } = await bot.feed.load([]);
  if (!barTime) return false;
  const times = bench.t.filter(t => t > barTime - days * 86400 && t <= barTime);
  const cut = (S, t) => { let n = S.t.length; while (n > 0 && S.t[n - 1] > t) n--; const o = {}; for (const k of ['t', 'o', 'h', 'l', 'c', 'q']) o[k] = S[k].slice(0, n); return o };
  const real = { feed: bot.feed, log: bot.log, notify: bot.notify };
  let t = null, buys = 0, sells = 0;
  bot.feed = { load: async () => { const s = {}; for (const [k, S] of Object.entries(series)) s[k] = cut(S, t); return { series: s, bench: cut(bench, t), barTime: t } } };
  bot.log = m => { if (/^BUY /.test(m)) buys++; if (/^SELL /.test(m)) sells++; if (/^(BUY|SELL) /.test(m)) log('history · ' + m.split(' · ')[0]) };
  bot.notify = async () => {}; bot.replay = true;
  try { for (t of times) await bot.cycle() } finally { Object.assign(bot, real); bot.replay = false }
  bot.state.meta = { ...bot.state.meta, headStart: { days, from: times[0], to: times[times.length - 1], buys, sells } }; bot.save();
  log(`head start done: ${times.length} bars from ${new Date(times[0] * 1000).toISOString().slice(0, 10)} replayed · ${buys} buys, ${sells} sells · equity $${(bot.state.lastEquity || 0).toFixed(2)} · now trading live on paper`);
  return true;
}
module.exports = headStart;

#!/usr/bin/env node
// Runs the bot. Usage:
//   node src/run.js --config config.json            run forever, one cycle after each bar closes
//   node src/run.js --config config.json --once     one cycle then exit (for cron / Task Scheduler)
//   node src/run.js --config config.json --head-start 60   paper only, empty account: replay the last 60 days first
//   node src/run.js --config config.json --head-start 2020 paper only, empty account: fill it with the bot's trades since 1 Jan 2020 (every bot)
//   node src/run.js --config config.json --status   print state and exit
//   node src/run.js --config config.json --reset-halt
//   node src/run.js --config config.json --stock-slots 6   stock model only: hold 4, 5 or 6 stocks
//   preset "trend" in config.json runs the Trend Engine bot (daily, spot only; "coins": "btc" or "basket10")
const fs = require('fs'), path = require('path');
const CORE = require('./core');
const Bot = require('./bot');
const headStart = require('./headstart');
const { seedFromHistory, seedTrend } = require('./history');
const SB = require('./stockbots');
const PaperBroker = require('./brokers/paper');
const { BinanceClient, BinanceFeed, BinanceBroker } = require('./brokers/binance');
const { AlpacaClient, AlpacaFeed, AlpacaBroker } = require('./brokers/alpaca');
const { TrendBot, TrendFeed, TrendPaperBroker, TrendBinanceBroker, COINS } = require('./trend');
const MO = require('./momentum');

const args = process.argv.slice(2), flag = f => args.includes(f), opt = f => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null };
const cfgPath = path.resolve(opt('--config') || 'config.json');
if (!fs.existsSync(cfgPath)) { console.error(`No config at ${cfgPath}. Copy config.crypto.example.json or config.stocks.example.json to config.json first.`); process.exit(1) }
const user = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
let cfg = { ...CORE.DEFAULTS, ...(CORE.PRESETS[user.preset] || {}), ...user };
// Stock model only: --stock-slots 4|5|6 (or "stockSlots" in config.json) sets how many stocks are held at once.
try { cfg = CORE.applyStockSlots(cfg, opt('--stock-slots')) } catch (e) { console.error(e.message); process.exit(1) }
const dir = path.resolve(path.dirname(cfgPath), cfg.dataDir || `state-${cfg.market}`); fs.mkdirSync(dir, { recursive: true });

// --- safety: live trading needs two deliberate switches
if (cfg.mode === 'live' && process.env.PVSRA_LIVE !== 'I_UNDERSTAND_REAL_MONEY') {
  console.error('mode is "live" but the environment variable PVSRA_LIVE is not set to I_UNDERSTAND_REAL_MONEY. Refusing to trade real money.'); process.exit(1);
}
if (!['signals', 'paper', 'testnet', 'live'].includes(cfg.mode)) { console.error('mode must be signals, paper, testnet or live'); process.exit(1) }

const logFile = path.join(dir, 'bot.log');
const log = (...a) => { const line = `[${new Date().toISOString()}] ${a.join(' ')}`; console.log(line); fs.appendFileSync(logFile, line + '\n') };
const store = require('./store').fileStore(dir);
const notify = async msg => {
  if (!cfg.webhookUrl) return;
  try { await fetch(cfg.webhookUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: `[PVSRA ${cfg.market}/${cfg.mode}] ${msg}`, text: `[PVSRA ${cfg.market}/${cfg.mode}] ${msg}` }) }) } catch (e) { log('webhook failed:', e.message) }
};

function build() {
  const saved = store.load();
  let feed, broker;
  if (cfg.market === 'momentum') {                                    // momentum bot: Binance futures data, paper only
    if (cfg.mode !== 'paper') throw new Error('The momentum bot runs on paper only.');
    const client = new BinanceClient({ testnet: false, spacingMs: cfg.requestSpacingMs || 250 });
    return new MO.MomentumBot(cfg, { feed: new MO.MomentumFeed(client, { exclude: cfg.exclude || [], cacheDir: path.join(dir, '..', 'history') }), store, log, notify });
  }
  if (cfg.market === 'trend') {                                       // Trend Engine: daily, spot only, its own ledger
    if (!COINS[cfg.coins]) throw new Error('coins must be "btc" or "basket10"');
    const client = new BinanceClient({ key: process.env.BINANCE_KEY, secret: process.env.BINANCE_SECRET, testnet: cfg.mode !== 'live', spacingMs: cfg.requestSpacingMs || 250 });
    const live = cfg.mode === 'testnet' || cfg.mode === 'live';
    broker = live ? new TrendBinanceBroker(client, { startCash: cfg.startCash || 10000, state: saved?.broker }) : new TrendPaperBroker({ startCash: cfg.startCash || 10000, state: saved?.broker });
    return new TrendBot(cfg, { broker, feed: new TrendFeed(client, { coins: cfg.coins, exclude: cfg.exclude || [] }), store, log, notify });
  }
  if (cfg.market === 'crypto') {
    const client = new BinanceClient({ key: process.env.BINANCE_KEY, secret: process.env.BINANCE_SECRET, testnet: cfg.mode !== 'live', spacingMs: cfg.requestSpacingMs || 250 });
    feed = new BinanceFeed(client, { tf: cfg.tf, universeSize: cfg.universeSize || 120, minQuoteVol: cfg.minLiq, include: cfg.include || [], exclude: cfg.exclude || [] });
    broker = (cfg.mode === 'testnet' || cfg.mode === 'live') ? new BinanceBroker(client) : null;
  } else if (cfg.market === 'stocks') {
    const client = new AlpacaClient({ key: process.env.ALPACA_KEY, secret: process.env.ALPACA_SECRET, paper: cfg.mode !== 'live', dataFeed: cfg.alpacaDataFeed || 'iex' });
    const symbols = cfg.symbols || fs.readFileSync(path.join(__dirname, '..', 'data', 'sp500.txt'), 'utf8').split(/\s+/).filter(Boolean);
    feed = new AlpacaFeed(client, { symbols });
    const sm = cfg.stockModel || 'v3';                                // stock models: own (v3), momentum, half and half
    if (sm !== 'v3') {
      if (cfg.mode !== 'paper') throw new Error('The momentum and half-and-half stock models run on paper only for now.');
      if (sm === 'momentum') return new SB.StockMomBot(cfg, { feed, store, log, notify });
      if (sm === 'half') return new SB.StockHalfBot(cfg, { feed, store, log, notify });
      throw new Error('stockModel must be v3, momentum or half');
    }
    broker = (cfg.mode === 'testnet' || cfg.mode === 'live') ? new AlpacaBroker(client) : null;   // "testnet" = Alpaca paper account
  } else throw new Error('market must be crypto, stocks or trend');
  if (!broker) broker = new PaperBroker({ startCash: cfg.startCash || 10000, fee: cfg.fee, impK: cfg.impK, state: saved?.broker });
  return new Bot(cfg, { broker, feed, store, log, notify });
}

async function main() {
  let bot = build();
  if (flag('--status')) { console.log(JSON.stringify(bot.state, null, 2)); return }
  if (flag('--reset-halt')) { bot.state.halted = false; bot.state.haltReason = null; bot.state.peak = null; bot.save(); log('halt reset'); return }
  if (cfg.market === 'momentum') log(`start · Momentum bot (paper) · long the 10 strongest, short the 10 weakest futures over 30 days · re-balanced weekly · $${cfg.startCash || 10000} · daily after 00:00 UTC`);
  else if (cfg.market === 'trend') log(`start · Trend Engine · mode ${cfg.mode} · ${COINS[cfg.coins].label} · $${cfg.startCash || 10000} to manage · daily after 00:00 UTC`);
  else if (cfg.market === 'stocks' && (cfg.stockModel || 'v3') !== 'v3') log(`start · stock bot · paper · ${cfg.stockModel === 'momentum' ? 'momentum model: the 5 strongest S&P 500 stocks over the past year, re-picked monthly' : 'half own model (v3, ' + cfg.slots + ' stocks), half momentum, back to 50/50 monthly'} · $${cfg.startCash || 10000}`);
  else log(`start · market ${cfg.market} · mode ${cfg.mode} · model ${cfg.model}${cfg.market === 'crypto' ? `${cfg.profitStop === 'on' ? ' + profit stop' : ''}${cfg.trendRule === 'on' ? ' + 50-day rule' : ''}` : ''} · rank ${cfg.rank} · slots ${cfg.slots} · risk ${cfg.risk || 'equal share'}`);
  const once = async () => { try { await bot.cycle() } catch (e) { log('cycle error:', e.stack || e.message); await notify(`error: ${e.message}`); if (/rate limit/.test(e.message)) await new Promise(r => setTimeout(r, 15 * 60e3)) } };
  if (flag('--once')) return once();
  // Don't wait for the next bar close: act on the most recent closed bar now.
  const hsDays = +(opt('--head-start') ?? cfg.headStartDays ?? 0);
  if (cfg.market === 'momentum') {                                   // its own loop: one decision a day after 00:00 UTC
    if (hsDays > 0 && bot.state.day == null) { log(hsDays === 2020 ? 'head start since 2020: daily candles and funding for the most traded futures (first time several minutes; kept for later resets)…' : `head start: replaying the last ${hsDays} days`); bot.replay = true; try { await bot.cycle({ startDay: hsDays === 2020 ? Date.UTC(2020, 0, 1) / 1000 / 86400 : Math.floor(Date.now() / 1000 / 86400) - 1 - hsDays }); if (hsDays === 2020) log(`head start since 2020 done: $${(cfg.startCash || 10000).toFixed(0)} → $${bot.state.equity.toFixed(2)} · ${bot.state.trades.length} trades · now trading on paper`) } catch (e) { log('head start failed:', e.message, '— starting empty'); bot.state.day = null; bot.state.pos = {}; bot.state.open = {}; bot.state.trades = []; bot.state.rebalances = []; bot.state.equity = cfg.startCash || 10000 } bot.replay = false; bot.save() }
    await once();
    for (;;) { const now = Date.now() / 1000, next = (Math.floor(now / 86400) + 1) * 86400 + (cfg.closeDelaySec || 300); log(`next check at ${new Date(next * 1000).toISOString()}`); await new Promise(r => setTimeout(r, Math.max(1000, (next - now) * 1000))); await once() }
  }
  let ranHeadStart = false;
  if (hsDays > 0 && (cfg.mode === 'paper' || cfg.mode === 'signals') && !bot.state.lastBar) {
    try { ranHeadStart = hsDays === 2020 ? await (cfg.market === 'stocks' ? SB.seedStocks(bot, log) : cfg.market === 'trend' ? seedTrend(bot, log) : seedFromHistory(bot, log)) : await headStart(bot, hsDays, log) } catch (e) {
      // 1.8.0 kept the positions bought in the replay and then sold them at today's prices: a month of moves booked at once.
      log('head start failed:', e.message, '— starting the paper account empty instead');
      for (const f of ['state.json', 'equity.json']) try { fs.rmSync(path.join(dir, f), { force: true }) } catch {}
      try { fs.rmSync(path.join(dir, 'half-v3'), { recursive: true, force: true }) } catch {}
      bot = build(); bot.save();
    }
  }
  if (!ranHeadStart) { log('catch-up: checking the latest closed bar now'); try { await bot.cycle({ noEntries: cfg.mode === 'live' }) } catch (e) { log('cycle error:', e.stack || e.message); await notify(`error: ${e.message}`) } }
  for (;;) {                                                         // wake shortly after each bar closes
    const tf = cfg.tf, now = Date.now() / 1000;
    const next = cfg.market === 'stocks' ? nextUtc(21, 30) : (Math.floor(now / tf) + 1) * tf + (cfg.closeDelaySec || (cfg.market === 'trend' ? 180 : 60));
    log(`next cycle at ${new Date(next * 1000).toISOString()}`);
    await new Promise(r => setTimeout(r, Math.max(1000, (next - now) * 1000)));
    await once();
  }
}
function nextUtc(h, m) { const d = new Date(); d.setUTCHours(h, m, 0, 0); if (d <= new Date()) d.setUTCDate(d.getUTCDate() + 1); while ([0, 6].includes(d.getUTCDay())) d.setUTCDate(d.getUTCDate() + 1); return d.getTime() / 1000 }
main();

// Dashboard server: serves the page and read-only JSON from a bot's files, only on this computer.
const test = require('node:test'), assert = require('node:assert');
const { spawn } = require('child_process'), fs = require('fs'), os = require('os'), path = require('path');
const CORE = require('../src/core'), Bot = require('../src/bot'), PaperBroker = require('../src/brokers/paper');
const { fileStore } = require('../src/store'), { MockFeed, market } = require('./helpers');

test('dashboard shows the bot state, assets traded and charts; read-only', async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pvd')), P = CORE.applyStockSlots({ ...CORE.DEFAULTS, ...CORE.PRESETS.stocks });
  fs.writeFileSync(path.join(d, 'config.json'), JSON.stringify({ preset: 'stocks', mode: 'paper', stockSlots: 5, minLiq: 1e5, dataDir: 'state' }));
  const { data, bench } = market(600, P.tf, 8), feed = new MockFeed(data, bench), store = fileStore(path.join(d, 'state'));
  const bot = new Bot({ ...P, minLiq: 1e5 }, { broker: new PaperBroker({ startCash: 10000 }), feed, store, log: () => {} });
  for (let i = 300; i < 600; i++) { feed.at(bench.t[i]); await bot.cycle() }
  const port = 18000 + Math.floor(Math.random() * 1000);
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'dashboard.js'), '--stocks', path.join(d, 'config.json'), '--port', String(port)], { stdio: 'pipe' });
  await new Promise(r => srv.stdout.once('data', r));
  try {
    const page = await fetch(`http://127.0.0.1:${port}/`).then(r => r.text());
    assert.match(page, /PVSRA/); assert.match(page, /Stock model/);
    const s = await fetch(`http://127.0.0.1:${port}/api/summary`).then(r => r.json());
    assert.equal(s.stocks.running, true); assert.equal(s.crypto.configured, false); assert.equal(s.stocks.cfg.slots, 5);
    assert.ok(s.stocks.equity.length >= 290); assert.ok(s.stocks.state.trades.length > 0);
    const sym = Object.keys(s.stocks.state.positions)[0] || s.stocks.state.trades.at(-1).sym;
    const c = await fetch(`http://127.0.0.1:${port}/api/chart?market=stocks&sym=${sym}`).then(r => r.json());
    assert.ok(c.bars.length > 100 && c.s.length === c.bars.length && c.cls.length === c.bars.length);
    const before = fs.readFileSync(path.join(d, 'state', 'state.json'), 'utf8');
    await fetch(`http://127.0.0.1:${port}/api/summary`, { method: 'POST', body: '{}' });
    assert.equal(fs.readFileSync(path.join(d, 'state', 'state.json'), 'utf8'), before);   // nothing the page sends can change the bot
  } finally { srv.kill() }
});

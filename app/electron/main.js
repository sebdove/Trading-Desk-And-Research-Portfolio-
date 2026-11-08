// PVSRA Bot Desk — desktop app. Runs the stock, crypto and trend bots as background processes,
// shows the Simple-view dashboard in its own window, and keeps settings and keys on this PC.
const { app, BrowserWindow, ipcMain, Tray, Menu, Notification, dialog, shell, safeStorage, nativeImage } = require('electron');
const path = require('path'), fs = require('fs'), { spawn } = require('child_process');

if (process.env.PVSRA_USERDATA) app.setPath('userData', process.env.PVSRA_USERDATA);   // tests only
if (process.platform === 'linux') app.commandLine.appendSwitch('password-store', 'basic');
if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0) }
const SRC = path.join(__dirname, '..', 'src').replace('app.asar' + path.sep, 'app.asar.unpacked' + path.sep);
const { createDashboard, loadBot } = require(path.join(SRC, 'dashboard.js'));
const { BubbleService, STAGES: BSTAGES } = require(path.join(SRC, 'bubble', 'service.js'));
const COMBO = require(path.join(SRC, 'combo.js'));
const PF = require(path.join(SRC, 'portfolio.js'));
const DATA_DIR = path.join(__dirname, '..', 'data').replace('app.asar' + path.sep, 'app.asar.unpacked' + path.sep);
const ICON = path.join(__dirname, '..', 'build', 'icon.png').replace('app.asar' + path.sep, 'app.asar.unpacked' + path.sep);
const MARKETS = ['stocks', 'crypto', 'trend', 'momentum'], NAME = { stocks: 'Stock bot', crypto: 'Crypto bot', trend: 'Trend bot', momentum: 'Momentum bot' };

// ---------- settings (plain) and keys (encrypted with Windows DPAPI via safeStorage) ----------
const UD = () => app.getPath('userData');
const DEFAULTS = {
  stocks: { mode: 'paper', stockModel: 'v3', stockSlots: 5, headStartDays: 60, startCash: 10000, maxDrawdown: 0.30, maxDailyLoss: 0.05, minOrder: 50, webhookUrl: '', burstGuard: 'off' },
  crypto: { mode: 'paper', headStartDays: 30, startCash: 10000, maxDrawdown: 0.30, maxDailyLoss: 0.06, minOrder: 10, universeSize: 120, webhookUrl: '', burstGuard: 'off', burstShort: false, burstShortShare: 0.33, profitStop: 'on', trendRule: 'on', btcTrend50: 'off' },
  trend: { mode: 'paper', coins: 'btc', headStartDays: 90, startCash: 10000, webhookUrl: '', burstGuard: 'off' },
  momentum: { mode: 'paper', headStartDays: 90, startCash: 10000, webhookUrl: '' },
  combo: { on: false, total: 10000 },
  desk: { on: false, total: 10000, momentum: true },
  bubble: { autoUpdate: true, newsDaily: true, newsModel: 'claude-sonnet-5-5', notify: true },
  app: { startBotsOnOpen: false, openAtLogin: false, notifications: true, closeToTray: true, trayHintShown: false },
};
const settingsFile = () => path.join(UD(), 'settings.json'), secretsFile = () => path.join(UD(), 'keys.bin');
function readSettings() {
  let s = {}; try { s = JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) } catch {}
  return { stocks: { ...DEFAULTS.stocks, ...s.stocks }, crypto: { ...DEFAULTS.crypto, ...s.crypto }, trend: { ...DEFAULTS.trend, ...s.trend }, momentum: { ...DEFAULTS.momentum, ...s.momentum, mode: 'paper' }, combo: { ...DEFAULTS.combo, ...s.combo }, desk: { ...DEFAULTS.desk, ...s.desk }, bubble: { ...DEFAULTS.bubble, ...s.bubble }, app: { ...DEFAULTS.app, ...s.app } };
}
function writeSettings(s) { fs.mkdirSync(UD(), { recursive: true }); fs.writeFileSync(settingsFile(), JSON.stringify(s, null, 2)) }
function readKeys() {
  try { const b = fs.readFileSync(secretsFile()); if (b.slice(0, 5).toString() === 'TEST:') return process.env.PVSRA_TEST_INSECURE_KEYS === '1' ? JSON.parse(Buffer.from(b.slice(5).toString(), 'base64').toString()) : {}; return JSON.parse(safeStorage.decryptString(b)) } catch { return {} }
}
function writeKeys(k) {
  if (!safeStorage.isEncryptionAvailable()) {
    if (process.env.PVSRA_TEST_INSECURE_KEYS === '1' && process.env.PVSRA_USERDATA) { fs.writeFileSync(secretsFile(), Buffer.from('TEST:' + Buffer.from(JSON.stringify(k)).toString('base64'))); return }   // automated tests on Linux only
    throw new Error('Windows could not encrypt the keys on this account, so they were not saved.');
  }
  fs.writeFileSync(secretsFile(), safeStorage.encryptString(JSON.stringify(k)));
}
// Bot config files the background processes read (no keys in them).
function botDir(m) { return path.join(UD(), m) }
function writeConfig(m, s = readSettings()) {
  // the trend bot keeps a separate folder per mode, so paper coins can never be mistaken for real ones
  const cfg = { preset: m, ...s[m], dataDir: m === 'trend' && s[m].mode !== 'paper' ? 'state-' + s[m].mode : 'state' };
  if (m !== 'stocks') { delete cfg.stockSlots; delete cfg.stockModel }
  if (m === 'stocks') cfg.bubblePage = path.join(UD(), 'bubble', 'page.json');      // Bubble Watch readings for the S&P 500 burst guard
  if (m !== 'crypto') { delete cfg.burstShort; delete cfg.burstShortShare; delete cfg.profitStop; delete cfg.trendRule; delete cfg.btcTrend50 }
  if (s.desk.on && s[m].mode === 'paper') cfg.transferFile = path.join(botDir(m), 'transfer.json');   // desk portfolio: quarterly moves between paper bots
  if (s.combo.on && (m === 'crypto' || m === 'trend')) {                              // combined crypto account (src/combo.js)
    cfg.transferFile = path.join(botDir(m), 'transfer.json');
    if (m === 'crypto') cfg.comboPeerState = trendStateFile(s);
  }
  fs.mkdirSync(botDir(m), { recursive: true }); fs.writeFileSync(path.join(botDir(m), 'config.json'), JSON.stringify(cfg, null, 2));
  return path.join(botDir(m), 'config.json');
}
const getBots = () => { const o = {}; for (const m of MARKETS) { const f = path.join(botDir(m), 'config.json'); try { if (fs.existsSync(f)) o[m] = loadBot(f, m) } catch {} } return o };

const stateFile = (m, s = readSettings()) => path.join(botDir(m), m === 'trend' && s.trend.mode !== 'paper' ? 'state-' + s.trend.mode : 'state', 'state.json');
const trendStateFile = s => stateFile('trend', s);
// ---------- combined crypto account: a third crypto bot, two thirds trend bot, rebalanced each month ----------
const comboFile = () => path.join(UD(), 'combo.json');
function readCombo() { return COMBO.readJson(comboFile()) || { month: null, pending: null, history: [] } }
function comboTick() {
  const s = readSettings(); if (!s.combo.on) return null;
  const C = readCombo(), month = COMBO.monthKey();
  if (C.month === month) return null;
  const sc = COMBO.readJson(stateFile('crypto', s)), stt = COMBO.readJson(stateFile('trend', s));
  if (!sc || !stt || sc.lastEquity == null || stt.lastEquity == null) return null;          // both bots must have run at least once
  if (C.pending && (sc.lastTransferId !== C.pending || stt.lastTransferId !== C.pending)) return null;   // last month's note not applied yet
  const P = COMBO.plan(sc.lastEquity, stt.lastEquity), id = `${month}-${Date.now()}`;
  COMBO.writeAtomic(path.join(botDir('crypto'), 'transfer.json'), JSON.stringify({ id, amount: P.toCrypto }));
  COMBO.writeAtomic(path.join(botDir('trend'), 'transfer.json'), JSON.stringify({ id, amount: -P.toCrypto }));
  C.month = month; C.pending = id; C.history = [...(C.history || []), { id, month, at: new Date().toISOString(), total: +P.total.toFixed(2), crypto: +sc.lastEquity.toFixed(2), trend: +stt.lastEquity.toFixed(2), toCrypto: P.toCrypto }].slice(-60);
  COMBO.writeAtomic(comboFile(), JSON.stringify(C, null, 1));
  addLog('crypto', `[combined] rebalance for ${month}: total $${P.total.toFixed(2)} · ${P.toCrypto >= 0 ? 'to the crypto bot' : 'to the trend bot'} $${Math.abs(P.toCrypto).toFixed(2)} (applied at each bot's next cycle)`);
  return C;
}
// ---------- desk portfolio: the three bots share one pot, re-split each quarter by how much each has been swinging ----------
const deskFile = () => path.join(UD(), 'desk.json');
function readDesk() { return PF.readJson(deskFile()) || { quarter: null, pending: null, history: [] } }
const equityFile = (m, s) => path.join(path.dirname(stateFile(m, s)), 'equity.json');
// which bots share the desk: the paper momentum bot joins only while the other three are on paper too (it has no real money)
const deskBots = s => s.desk.momentum !== false && PF.BOTS3.every(m => s[m].mode === 'paper') ? PF.BOTS4 : PF.BOTS3;
function deskTick() {
  const s = readSettings(); if (!s.desk.on) return null; const BOTS = deskBots(s);
  const D = readDesk(), q = PF.quarterKey(); if (D.quarter === q) return null;
  const st = {}, eq = {}; for (const m of BOTS) { st[m] = PF.readJson(stateFile(m, s)); eq[m] = PF.readJson(equityFile(m, s)) || [] }
  if (BOTS.some(m => !st[m] || st[m].lastEquity == null)) return null;                   // every bot must have run at least once
  const paper = BOTS.every(m => s[m].mode === 'paper');
  if (paper && D.pending && BOTS.some(m => st[m].lastTransferId !== D.pending)) return null;   // last quarter's moves not applied yet
  // first run with every bot replayed since 2020: the desk's own history since 2020 (as tested), then each bot gets today's share
  if (paper && !D.seed && !(D.history || []).length) {
    const S = PF.deskSince(eq, BOTS, s.desk.total);
    if (S) {
      const id = `${q}-since2020-${Date.now()}`, values = Object.fromEntries(BOTS.map(m => [m, st[m].lastEquity])), move = Object.fromEntries(BOTS.map(m => [m, +(S.parts[m] - values[m]).toFixed(2)]));
      for (const m of BOTS) COMBO.writeAtomic(path.join(botDir(m), 'transfer.json'), JSON.stringify({ id, amount: move[m] }));
      D.quarter = q; D.pending = id; D.seed = { from: S.from, to: S.to, total: +S.total.toFixed(2), dd: +S.dd.toFixed(4), curve: S.curve };
      D.history = [...S.splits.map(x => ({ id: 'since2020', quarter: PF.quarterKey(x.t * 1000), at: new Date(x.t * 1000).toISOString(), total: x.value, shares: x.shares, auto: true, replay: true })),
        { id, quarter: q, at: new Date().toISOString(), total: +S.total.toFixed(2), values, shares: Object.fromEntries(BOTS.map(m => [m, +(S.parts[m] / S.total).toFixed(4)])), move, auto: true, since2020: true }].slice(-40);
      COMBO.writeAtomic(deskFile(), JSON.stringify(D, null, 1));
      const fmt = v => '$' + Math.abs(v).toLocaleString('en-US', { maximumFractionDigits: 0 });
      for (const m of BOTS) addLog(m, `[desk] since 2020: the desk's history worked out from the four replays (quarterly re-splits, as tested): $${s.desk.total} → ${fmt(S.total)}, worst drop ${(100 * S.dd).toFixed(1)}% · this bot now ${fmt(S.parts[m])} (${move[m] >= 0 ? 'add' : 'take out'} ${fmt(move[m])}, applied at its next cycle)`);
      return D;
    }
  }
  const values = Object.fromEntries(BOTS.map(m => [m, st[m].lastEquity])), sh = PF.shares(eq, PF.RULE, BOTS), P = PF.plan(values, sh.shares), id = `${q}-${Date.now()}`;
  const fmt = v => '$' + Math.abs(v).toLocaleString('en-US', { maximumFractionDigits: 0 });
  const text = BOTS.map(m => `${NAME[m]} ${Math.round(100 * sh.shares[m])}% (${P.move[m] >= 0 ? 'add' : 'take out'} ${fmt(P.move[m])})`).join(' · ');
  if (paper) for (const m of BOTS) COMBO.writeAtomic(path.join(botDir(m), 'transfer.json'), JSON.stringify({ id, amount: P.move[m] }));
  D.quarter = q; D.pending = paper ? id : null;
  D.history = [...(D.history || []), { id, quarter: q, at: new Date().toISOString(), total: +P.total.toFixed(2), values, shares: sh.shares, tilt: sh.tilt, swings: sh.swings, move: P.move, auto: paper }].slice(-40);
  COMBO.writeAtomic(deskFile(), JSON.stringify(D, null, 1));
  for (const m of BOTS) addLog(m, `[desk] ${q} split: ${text}${paper ? ' (applied at each bot\'s next cycle)' : ' — real money: move it by hand'}`);
  if (!paper) notify('Desk portfolio: quarterly rebalance', text);
  return D;
}
const getDesk = () => { const s = readSettings(), BOTS = deskBots(s); return { on: !!s.desk.on, total: s.desk.total, bots: BOTS, momentumWanted: s.desk.momentum !== false, rule: PF.RULE, tested: PF.TESTED, ...readDesk(), modes: Object.fromEntries(BOTS.map(m => [m, s[m].mode])) } };
const getCombo = () => { const s = readSettings(); return { on: !!s.combo.on, share: COMBO.SHARE, total: s.combo.total, tested: COMBO.TESTED, ...readCombo(), modes: { crypto: s.crypto.mode, trend: s.trend.mode } } };

// ---------- bot processes ----------
const procs = {}, logs = Object.fromEntries(MARKETS.map(m => [m, []]));
function status() {
  const s = readSettings(), k = readKeys(), o = {};
  for (const m of MARKETS) { const p = procs[m]; o[m] = { running: !!p, pid: p?.child.pid ?? null, startedAt: p?.startedAt ?? null, mode: s[m].mode, lastLine: logs[m][logs[m].length - 1] || null,
    keysReady: m !== 'stocks' ? (s[m].mode === 'paper' || s[m].mode === 'signals' || !!(k.binanceKey && k.binanceSecret)) : !!(k.alpacaKey && k.alpacaSecret) } }
  return o;
}
const push = (ch, data) => { if (win && !win.isDestroyed()) win.webContents.send(ch, data) };
function addLog(m, line) {
  line = line.replace(/\r/g, '').trimEnd(); if (!line) return;
  logs[m].push(line); if (logs[m].length > 500) logs[m].shift();
  push('bots:log', { market: m, line });
  const s = readSettings().app, msg = line.replace(/^\[[^\]]+\]\s*/, '');
  if (s.notifications && /^(BUY|SELL|SHORT|COVER|BURST GUARD) /.test(msg)) notify(`${NAME[m]}: ${msg.split(' · ')[0]}`, msg.split(' · ').slice(1).join(' · '));
  if (/^HALTED|cycle error|rate limit|exchange stop not moved/i.test(msg) || /HALTED:/.test(msg)) notify(`${NAME[m]} needs attention`, msg.slice(0, 180));
}
function notify(title, body) { if (Notification.isSupported()) new Notification({ title, body, icon: ICON }).show() }

async function startBot(m, { interactive = true } = {}) {
  if (procs[m]) return status();
  const s = readSettings(), k = readKeys(), mode = s[m].mode;
  if (m === 'stocks' && !(k.alpacaKey && k.alpacaSecret)) throw new Error('The stock bot needs Alpaca keys (free paper account) for market data. Add them in Settings → Broker keys.');
  if (m !== 'stocks' && (mode === 'testnet' || mode === 'live') && !(k.binanceKey && k.binanceSecret)) throw new Error(`${m === 'trend' ? 'Trend' : 'Crypto'} ${mode} mode needs Binance ${mode === 'testnet' ? 'testnet ' : ''}keys. Add them in Settings → Broker keys.`);
  if (mode === 'live') {
    if (!interactive) throw new Error('Live trading never starts automatically. Start it yourself.');
    const r = await dialog.showMessageBox(win, { type: 'warning', buttons: ['Cancel', 'Start with real money'], defaultId: 0, cancelId: 0, noLink: true,
      title: 'Real money', message: `Start the ${NAME[m].toLowerCase()} in LIVE mode?`, detail: 'It will place real orders with real money on your broker account. Past backtest results do not predict future returns.' });
    if (r.response !== 1) return status();
  }
  if (m === 'stocks') { try { bubbleSvc().page() } catch (e) { console.log('bubble page: ' + e.message) } }   // the S&P burst guard reads it
  const cfg = writeConfig(m, s);
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', BINANCE_KEY: k.binanceKey || '', BINANCE_SECRET: k.binanceSecret || '', ALPACA_KEY: k.alpacaKey || '', ALPACA_SECRET: k.alpacaSecret || '',
    PVSRA_LIVE: mode === 'live' ? 'I_UNDERSTAND_REAL_MONEY' : '' };
  const child = spawn(process.execPath, [path.join(SRC, 'run.js'), '--config', cfg], { env, cwd: botDir(m), windowsHide: true });
  procs[m] = { child, startedAt: Date.now() };
  let buf = { out: '', err: '' };
  const pipe = which => d => { buf[which] += d.toString(); const parts = buf[which].split('\n'); buf[which] = parts.pop(); parts.forEach(l => addLog(m, which === 'err' ? '[error] ' + l : l)) };
  child.stdout.on('data', pipe('out')); child.stderr.on('data', pipe('err'));
  child.on('exit', (code, sig) => {
    delete procs[m]; addLog(m, `[${new Date().toISOString()}] ${NAME[m]} stopped${code ? ' (exit code ' + code + ')' : ''}`);
    if (code && !quitting) notify(`${NAME[m]} stopped unexpectedly`, logs[m].filter(l => /error/i.test(l)).slice(-1)[0] || `exit code ${code}`);
    push('bots:status', status()); updateTray();
  });
  addLog(m, `[${new Date().toISOString()}] ${NAME[m]} starting in ${mode.toUpperCase()} mode`);
  push('bots:status', status()); updateTray(); return status();
}
function stopBot(m) { const p = procs[m]; if (p) p.child.kill(); return status() }

// ---------- window, tray ----------
let win = null, tray = null, quitting = false, port = 0;
function createWindow() {
  win = new BrowserWindow({ width: 1440, height: 900, minWidth: 980, minHeight: 640, title: 'PVSRA Bot Desk', icon: ICON, backgroundColor: '#0c1016', autoHideMenuBar: true, show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  win.loadURL(`http://127.0.0.1:${port}/`);
  win.once('ready-to-show', () => win.show());
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: 'deny' } });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith(`http://127.0.0.1:${port}/`)) e.preventDefault() });
  win.on('close', e => {
    const s = readSettings();
    if (!quitting && s.app.closeToTray && MARKETS.some(m => procs[m])) {
      e.preventDefault(); win.hide();
      if (!s.app.trayHintShown) { notify('PVSRA Bot Desk is still running', 'The bots keep trading in the background. Right-click the tray icon to open or quit.'); s.app.trayHintShown = true; writeSettings(s) }
    }
  });
}
function updateTray() {
  if (!tray) return;
  const st = status(), item = m => ({ label: `${st[m].running ? 'Stop' : 'Start'} ${NAME[m].toLowerCase()} (${st[m].mode})`, click: () => (st[m].running ? stopBot(m) : startBot(m).catch(e => dialog.showErrorBox(NAME[m], e.message))) });
  tray.setToolTip(`PVSRA Bot Desk — ${MARKETS.map(m => `${m} ${st[m].running ? 'running' : 'stopped'}`).join(', ')}`);
  tray.setContextMenu(Menu.buildFromTemplate([{ label: 'Open PVSRA Bot Desk', click: () => { win.show(); win.focus() } }, { type: 'separator' }, ...MARKETS.map(item), { type: 'separator' }, { label: 'Quit (stops all bots)', click: () => { quitting = true; app.quit() } }]));
}

// ---------- IPC for the page (the page never gets Node access) ----------
ipcMain.handle('bots:status', () => status());
ipcMain.handle('bots:start', async (_e, m) => { if (!MARKETS.includes(m)) throw new Error('unknown bot'); return startBot(m) });
ipcMain.handle('bots:stop', (_e, m) => { if (!MARKETS.includes(m)) throw new Error('unknown bot'); return stopBot(m) });
ipcMain.handle('bots:log', (_e, m) => (logs[m] || []).slice(-200));
ipcMain.handle('settings:get', () => { const s = readSettings(), k = readKeys(); return { ...s, keys: { binance: !!(k.binanceKey && k.binanceSecret), alpaca: !!(k.alpacaKey && k.alpacaSecret), anthropic: !!k.anthropicKey }, version: app.getVersion() } });
ipcMain.handle('settings:save', (_e, patch) => {
  const s = readSettings();
  for (const m of MARKETS) if (patch[m]) {
    const p = { ...patch[m] };
    if (m === 'momentum' && p.mode && p.mode !== 'paper') throw new Error('The momentum bot runs on paper only.');
    if (p.mode && !['paper', 'testnet', 'live'].includes(p.mode)) throw new Error('mode must be paper, testnet or live');
    if (m === 'stocks' && p.stockSlots != null && ![4, 5, 6].includes(+p.stockSlots)) throw new Error('stocks held must be 4, 5 or 6');
    if (p.headStartDays != null && ![0, 30, 60, 90, 2020].includes(+p.headStartDays)) throw new Error('head start must be off, 30, 60 or 90 days, or since 2020');
    if (m === 'stocks' && p.stockModel != null && !['v3', 'momentum', 'half'].includes(p.stockModel)) throw new Error('the stock model must be the own model, momentum or half and half');
    if (m === 'stocks' && (p.stockModel ?? s.stocks.stockModel) !== 'v3' && (p.mode ?? s.stocks.mode) !== 'paper') throw new Error('The momentum and half-and-half stock models run on paper only for now. Switch the stock bot to Paper, or choose its own model.');
    if (m === 'trend' && p.coins != null && !['btc', 'basket10'].includes(p.coins)) throw new Error('coins must be Bitcoin only or the 10-coin basket');
    if (p.startCash != null && !(+p.startCash >= 10)) throw new Error('the starting money must be at least $10');
    for (const f of ['startCash', 'maxDrawdown', 'maxDailyLoss', 'stockSlots', 'headStartDays']) if (p[f] != null) p[f] = +p[f];
    if (p.burstGuard != null && !['off', 'on'].includes(p.burstGuard)) throw new Error('the burst guard must be off or on');
    if (p.burstShort != null) p.burstShort = p.burstShort === true || p.burstShort === 'on';
    if (p.burstShortShare != null) { p.burstShortShare = +p.burstShortShare; if (![0.33, 0.5, 1].includes(p.burstShortShare)) throw new Error('the guard short must be a third, half or all of the account') }
    for (const f of ['profitStop', 'trendRule', 'btcTrend50']) if (p[f] != null) { p[f] = p[f] === true || p[f] === 'on' ? 'on' : p[f] === false || p[f] === 'off' ? 'off' : null; if (!p[f]) throw new Error('the crypto rule switches must be off or on') }
    if (m !== 'crypto') { delete p.burstShort; delete p.burstShortShare; delete p.profitStop; delete p.trendRule; delete p.btcTrend50 }
    if (p.mode === 'live' && s[m].mode !== 'live' && patch.confirmLive !== 'LIVE') throw new Error('Type LIVE to confirm switching to real money.');
    s[m] = { ...s[m], ...p };
  }
  if (patch.bubble) { const b = { ...patch.bubble }; if (b.newsModel != null && !/^claude-[a-z0-9.-]{3,60}$/.test(String(b.newsModel).trim())) throw new Error('The news model must be a Claude model id such as claude-sonnet-5-5.');
    if (b.newsModel != null) b.newsModel = String(b.newsModel).trim(); for (const f of ['autoUpdate', 'newsDaily', 'notify']) if (b[f] != null) b[f] = !!b[f]; s.bubble = { ...s.bubble, ...b } }
  if (patch.combo) { const c = { ...patch.combo };
    if (c.on != null) c.on = c.on === true || c.on === 'on';
    if (c.total != null) { c.total = +c.total; if (!(c.total >= 30)) throw new Error('the combined account needs at least $30') }
    const on = c.on ?? s.combo.on;
    if (on && !s.combo.on) {                                       // switching on: split the money, a third and two thirds
      const total = c.total ?? s.combo.total; s.crypto.startCash = Math.round(total * COMBO.SHARE); s.trend.startCash = Math.round(total - total * COMBO.SHARE);
      const C = readCombo(); C.month = null; C.pending = null; COMBO.writeAtomic(comboFile(), JSON.stringify(C, null, 1));
    }
    s.combo = { ...s.combo, ...c } }
  if (patch.desk) { const c = { ...patch.desk };
    if (c.on != null) c.on = c.on === true || c.on === 'on';
    if (c.momentum != null) c.momentum = c.momentum === true || c.momentum === 'on';
    if (c.total != null) { c.total = +c.total; if (!(c.total >= 100)) throw new Error('the desk portfolio needs at least $100') }
    const on = c.on ?? s.desk.on;
    if (on && !s.desk.on) {                                        // switching on: the tested settings and the starting split
      const total = c.total ?? s.desk.total, B = (c.momentum ?? s.desk.momentum) !== false && PF.BOTS3.every(m => s[m].mode === 'paper') ? PF.BOTS4 : PF.BOTS3;
      for (const m of B) s[m].startCash = Math.round(B.length === 4 ? total / 4 : total * PF.RULE.tilt[m]);
      s.crypto.btcTrend50 = 'on'; s.stocks.stockSlots = 4; s.combo.on = false;
      for (const m of B) if (s[m].mode === 'paper') s[m].headStartDays = 2020;       // every paper bot starts from its own since-2020 replay
      COMBO.writeAtomic(deskFile(), JSON.stringify({ quarter: null, pending: null, history: [] }, null, 1));
    }
    s.desk = { ...s.desk, ...c } }
  if (s.desk.on && s.combo.on) throw new Error('Use either the desk portfolio or the combined crypto account, not both.');
  if (s.combo.on && s.crypto.mode !== s.trend.mode) throw new Error('The combined crypto account needs the crypto bot and the trend bot in the same mode (both Paper, both Testnet or both Live).');
  if (patch.app) { s.app = { ...s.app, ...patch.app }; app.setLoginItemSettings({ openAtLogin: !!s.app.openAtLogin, args: ['--hidden'] }) }
  if (patch.keys) { const k = readKeys(); for (const [f, v] of Object.entries(patch.keys)) if (typeof v === 'string' && v.trim()) k[f] = v.trim(); else if (v === null) delete k[f]; writeKeys(k) }
  writeSettings(s); for (const m of MARKETS) writeConfig(m, s);
  try { comboTick() } catch (e) { console.log('combo: ' + e.message) }
  try { deskTick() } catch (e) { console.log('desk: ' + e.message) }
  updateTray(); const restart = MARKETS.filter(m => procs[m]);
  return { ok: true, restartNeeded: restart };
});
ipcMain.handle('app:openFolder', () => shell.openPath(UD()));
// Start the paper account again from scratch. The old files are moved to an archive folder, not deleted.
ipcMain.handle('bots:resetPaper', async (_e, m) => {
  if (!MARKETS.includes(m)) throw new Error('unknown bot');
  const s = readSettings();
  if (s[m].mode !== 'paper') throw new Error('Only a Paper account can be reset here.');
  if (procs[m]) throw new Error(`Stop the ${NAME[m].toLowerCase()} bot first.`);
  const dir = path.join(botDir(m), 'state'); if (!fs.existsSync(dir)) return { ok: true, nothing: true };
  const r = await dialog.showMessageBox(win, { type: 'question', buttons: ['Cancel', 'Reset paper account'], defaultId: 0, cancelId: 0, noLink: true,
    title: 'Reset paper account', message: `Start the ${NAME[m].toLowerCase()} paper account again from $${s[m].startCash}?`,
    detail: `Its trades and history are moved to an archive folder (not deleted).${s[m].headStartDays ? ` On the next start it ${+s[m].headStartDays === 2020 ? 'fills the account with the bot\'s trades since January 2020 (the first time a download of several minutes, kept for later resets)' : `replays the last ${s[m].headStartDays} days`} as a head start.` : ''}` });
  if (r.response !== 1) return { ok: false };
  const arch = path.join(botDir(m), 'archive'); fs.mkdirSync(arch, { recursive: true });
  fs.renameSync(dir, path.join(arch, 'state-' + new Date().toISOString().replace(/[:.]/g, '-')));
  if (s.desk.on && deskBots(s).includes(m)) { const D = readDesk(); if (D.seed || (D.history || []).length) COMBO.writeAtomic(deskFile(), JSON.stringify({ quarter: null, pending: null, history: [] }, null, 1)) }   // the desk starts again with its bots
  logs[m] = []; return { ok: true };
});

// ---------- Bubble Watch: daily data refresh and optional news check ----------
let bubble = null, bubbleWin = null;
function bubbleSvc() { if (!bubble) bubble = new BubbleService({ dir: path.join(UD(), 'bubble'), seedFile: path.join(DATA_DIR, 'bubble-seed.json.gz'), newsSeedFile: path.join(DATA_DIR, 'bubble-news-seed.json'), log: l => console.log(l) }); return bubble }
async function runBubbleUpdate(force) {
  const s = readSettings(), k = readKeys(), svc = bubbleSvc(), before = svc.scoreLog().slice(-1)[0] || null;
  const send = m => { for (const w of [win, bubbleWin]) if (w && !w.isDestroyed()) w.webContents.send('bubble:event', m) };
  const r = await svc.update({ force, apiKey: k.anthropicKey || null, model: s.bubble.newsModel, news: s.bubble.newsDaily, onProgress: p => send(p ? { progress: p } : {}) });
  const after = svc.scoreLog().slice(-1)[0];
  if (s.bubble.notify && before && after) {
    const TIER = ['Normal', 'Elevated', 'Bubble zone'];
    if (after.tier !== before.tier) notify(`Bubble Watch: ${TIER[after.tier]}`, `The S&P 500 bubble score moved from ${before.froth} to ${after.froth}.`);
    if (after.stage !== before.stage) notify(`Bubble Watch crash plan: ${BSTAGES[after.stage]}`, `Crash-buy score ${after.crash}. Open the Bubble Watch tab for the plan.`);
    if (after.kill_n > before.kill_n) notify('Bubble Watch: another momentum killer is on', `${after.kill_n} of ${after.kill_avail} are now on.`);
  }
  send({ updated: true }); return { ok: true, status: r.status };
}
function bubbleTick() { const s = readSettings(); if (!s.bubble.autoUpdate) return; if (bubbleSvc().due()) runBubbleUpdate(false).catch(e => console.log('bubble update: ' + e.message)) }
ipcMain.handle('bubble:update', () => runBubbleUpdate(true));
ipcMain.handle('bubble:check', async (_e, text, month) => { const s = readSettings(), k = readKeys(); return bubbleSvc().check({ apiKey: k.anthropicKey || null, model: s.bubble.newsModel, text: String(text || ''), month: month ? String(month) : null }) });
ipcMain.handle('bubble:window', () => {
  if (bubbleWin && !bubbleWin.isDestroyed()) { bubbleWin.show(); bubbleWin.focus(); return true }
  bubbleWin = new BrowserWindow({ width: 1280, height: 900, minWidth: 720, minHeight: 560, title: 'S&P 500 Bubble Watch', icon: ICON, backgroundColor: '#0c1016', autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  bubbleWin.loadURL(`http://127.0.0.1:${port}/bubble.html`);
  bubbleWin.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: 'deny' } });
  bubbleWin.webContents.on('will-navigate', (e, url) => { if (!url.startsWith(`http://127.0.0.1:${port}/`)) { e.preventDefault(); if (/^https?:/.test(url)) shell.openExternal(url) } });
  return true;
});

app.on('second-instance', () => { if (win) { win.show(); win.focus() } });
app.on('before-quit', () => { quitting = true; for (const m of MARKETS) if (procs[m]) procs[m].child.kill() });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() });
app.whenReady().then(async () => {
  app.setAppUserModelId('com.pvsra.botdesk');
  for (const m of MARKETS) writeConfig(m);
  await new Promise(r => createDashboard({ getBots, getCombo, getDesk, getBubble: () => bubbleSvc().pageJson(), port: 0, onListen: p => { port = p; r() } }));
  setTimeout(bubbleTick, 20000); setInterval(bubbleTick, 3600e3);
  setTimeout(() => { try { comboTick() } catch (e) { console.log('combo: ' + e.message) } }, 30000); setInterval(() => { try { comboTick() } catch (e) { console.log('combo: ' + e.message) } }, 3600e3);
  setTimeout(() => { try { deskTick() } catch (e) { console.log('desk: ' + e.message) } }, 35000); setInterval(() => { try { deskTick() } catch (e) { console.log('desk: ' + e.message) } }, 3600e3);
  createWindow();
  tray = new Tray(nativeImage.createFromPath(ICON).resize({ width: 16, height: 16 })); tray.on('double-click', () => { win.show(); win.focus() }); updateTray();
  if (process.argv.includes('--hidden')) win.once('ready-to-show', () => win.hide());
  const s = readSettings();
  if (s.app.startBotsOnOpen) for (const m of MARKETS) if (s[m].mode !== 'live') startBot(m, { interactive: false }).catch(e => addLog(m, '[error] ' + e.message));
});

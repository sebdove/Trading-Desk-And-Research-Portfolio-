// Desktop-app controls for the dashboard. Only active inside PVSRA Bot Desk (window.botApp comes from the app's preload).
(function () {
  const A = window.botApp; if (!A) return;
  const $ = id => document.getElementById(id), NAME = { stocks: 'Stocks', crypto: 'Crypto', trend: 'Trend', momentum: 'Momentum' };
  // Burst guard settings text: what it does and each bot's own 2020–26 backtest with it off and on (gtest/ in the build notes)
  const GUARD_HINT = {"stocks": "Sells the stocks and pauses buying when the S&amp;P 500 falls 3% below its 200-day average while Bubble Watch warns (score 65+ or an inverted yield curve), and buys again 3% above it, or sooner after a deep fall. Tested 2020 to Nov 2026 from $10,000 on 481 S&amp;P 500 stocks: off <b>$45,959</b> (worst drop 34%), on <b>$32,476</b> (32%). It sold in the quick 2020, 2022 and 2025 dips and bought back higher. It is built for long busts like 2000–02 and 2008, which that period didn't have, so it starts off.", "crypto": "Sells and pauses buying when Bitcoin closes one volatility unit (about 10–17%) below its 200-day average; buys again one unit above it, or sooner after a deep fall. Tested 2020 to Nov 2026 from $10,000 with the 1.9.0 rules: off <b>$149,671</b> (worst drop 47%), on <b>$63,835</b> (43%). This bot already buys only while Bitcoin is above its 200-day average, so the guard mostly kept it out of rebounds.", "trend": "Holds cash when Bitcoin closes one volatility unit below its 200-day average, until it closes one unit above it, or sooner after a deep fall. Tested on Bitcoin 2020 to Nov 2026 from $10,000: off <b>$93,750</b> (worst drop 46%), on <b>$51,267</b> (48%). The Trend Engine already cuts its holding in downtrends, so the guard made it late getting back in.", "short": "Paper accounts only: the Binance spot account can't short, so in Testnet or Live the bot only steps aside. In the 2020–26 test the short lost money: a third of the account → $47,290, all of it → $19,752, against $63,835 with the guard on and no short."};
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const css = document.createElement('style');
  css.textContent = `
  #appCtl{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
  .bot{display:flex;align-items:center;gap:8px;background:var(--panel-2);border:1px solid var(--line);border-radius:6px;padding:3px 4px 3px 10px;font-family:var(--mono);font-size:12px}
  .bot .st{display:flex;align-items:center;gap:6px;white-space:nowrap}.bot .st i{width:8px;height:8px;border-radius:50%;background:var(--muted)}.bot.on .st i{background:var(--c-up);box-shadow:0 0 0 3px color-mix(in srgb,var(--c-up) 25%,transparent)}
  .bot .md{font-size:10px;letter-spacing:.06em;padding:1px 6px;border-radius:999px;border:1px solid var(--line);color:var(--r-up)}.bot .md.live{color:var(--c-dn);border-color:color-mix(in srgb,var(--c-dn) 55%,transparent)}
  .btn{border:1px solid var(--line);background:var(--panel);color:var(--fg);border-radius:5px;padding:4px 12px;cursor:pointer;font-family:var(--mono);font-size:12px}
  .btn:hover{border-color:var(--muted)}.btn.go{background:var(--accent);color:var(--accent-ink);border-color:var(--accent)}.btn.stop{color:var(--c-dn);border-color:color-mix(in srgb,var(--c-dn) 50%,var(--line))}
  .btn:disabled{opacity:.5;cursor:wait}
  .log{font-family:var(--mono);font-size:11px;line-height:1.5;background:var(--panel-2);border:1px solid var(--line);border-radius:6px;padding:8px 10px;max-height:220px;overflow-y:auto;white-space:pre-wrap;word-break:break-word;color:var(--muted)}
  .log b{color:var(--fg);font-weight:500}.log .buy{color:var(--c-up)}.log .sell{color:var(--fg)}.log .err{color:var(--c-dn)}
  .toast{position:fixed;left:50%;bottom:22px;transform:translateX(-50%);background:var(--panel);border:1px solid var(--line);border-left:3px solid var(--accent);border-radius:6px;padding:10px 14px;max-width:560px;z-index:50;box-shadow:0 8px 28px rgba(0,0,0,.35);font-size:13.5px}
  .toast.err{border-left-color:var(--c-dn)}
  .modal{position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:40;display:flex;align-items:center;justify-content:center;padding:20px}
  .dlg{background:var(--panel);border:1px solid var(--line);border-radius:10px;width:min(720px,100%);max-height:calc(100vh - 40px);display:flex;flex-direction:column;box-shadow:0 20px 60px rgba(0,0,0,.45)}
  .dlg header{display:flex;align-items:center;justify-content:space-between;padding:14px 18px;border-bottom:1px solid var(--line)}.dlg header h3{margin:0;font-size:16px}
  .dlg .tabs{display:flex;gap:2px;padding:10px 18px 0}.dlg .tabs button{border:0;background:none;padding:8px 12px;border-bottom:2px solid transparent;cursor:pointer;color:var(--muted);font-weight:600}.dlg .tabs button[aria-selected="true"]{color:var(--fg);border-bottom-color:var(--accent)}
  .dlg .pane{padding:16px 18px;overflow-y:auto;display:flex;flex-direction:column;gap:14px}
  .dlg footer{display:flex;gap:10px;justify-content:flex-end;align-items:center;padding:12px 18px;border-top:1px solid var(--line)}
  .fld{display:grid;grid-template-columns:200px 1fr;gap:6px 14px;align-items:center}.fld>label{color:var(--muted);font-size:13px}
  .fld input[type=text],.fld input[type=password],.fld input[type=number],.fld input[type=url]{background:var(--panel-2);border:1px solid var(--line);border-radius:5px;padding:7px 9px;color:var(--fg);font-family:var(--mono);font-size:13px;width:100%}
  .fld .hint{grid-column:2;font-size:12px;color:var(--muted);margin-top:-2px}
  .opt{display:flex;gap:2px;background:var(--panel-2);border:1px solid var(--line);border-radius:6px;padding:2px;width:max-content}
  .opt button{border:0;background:none;padding:6px 14px;border-radius:4px;cursor:pointer;font-family:var(--mono);font-size:12.5px;color:var(--muted)}.opt button[aria-pressed="true"]{background:var(--accent);color:var(--accent-ink)}
  .opt button.live[aria-pressed="true"]{background:var(--c-dn);color:#fff}
  .warn{border:1px solid color-mix(in srgb,var(--c-dn) 55%,var(--line));background:color-mix(in srgb,var(--c-dn) 8%,transparent);border-radius:6px;padding:10px 12px;font-size:13px}
  .chk{display:flex;gap:10px;align-items:flex-start;font-size:13.5px}.chk input{margin-top:3px;accent-color:var(--accent)}
  .ok{color:var(--c-up);font-family:var(--mono);font-size:12px}.no{color:var(--muted);font-family:var(--mono);font-size:12px}
  .bot{border-left:3px solid var(--bc,var(--line))}.bot .st{color:var(--bc);font-weight:600}
  .bot.m-stocks{--bc:var(--b-stocks)}.bot.m-crypto{--bc:var(--b-crypto)}.bot.m-trend{--bc:var(--b-trend)}.bot.m-momentum{--bc:var(--b-momentum)}
  .bot{font-family:var(--sans);font-size:13px}.bot .md,.btn{font-family:var(--mono)}.dlg header h3{font-family:var(--display);font-weight:800;font-size:22px;text-transform:uppercase;letter-spacing:.02em}
  .bot{background:var(--tint-2);border-color:var(--tint-line)}
  .bot.on .st i{background:var(--bc);box-shadow:0 0 6px color-mix(in srgb,var(--bc) 65%,transparent),0 0 1px var(--bc)}`;
  document.head.appendChild(css);

  let ST = null, busy = {};
  const toast = (msg, err) => { const t = document.createElement('div'); t.className = 'toast' + (err ? ' err' : ''); t.textContent = msg; document.body.appendChild(t); setTimeout(() => t.remove(), err ? 9000 : 4500) };

  // ---------- header: status + start/stop per bot + settings ----------
  function renderCtl() {
    if (!ST) return;
    $('appCtl').innerHTML = ['stocks', 'crypto', 'trend', 'momentum'].map(m => { const s = ST[m]; if (!s) return '';
      return `<div class="bot m-${m} ${s.running ? 'on' : ''}" title="${s.running ? 'Running since ' + new Date(s.startedAt).toLocaleString() : 'Stopped'}"><span class="st"><i></i>${NAME[m]} ${s.running ? 'running' : 'stopped'}</span><span class="md ${s.mode === 'live' ? 'live' : ''}">${s.mode.toUpperCase()}</span>
        <button class="btn ${s.running ? 'stop' : 'go'}" data-m="${m}" ${busy[m] ? 'disabled' : ''}>${s.running ? 'Stop' : 'Start'}</button></div>` }).join('') + `<button class="btn" id="setBtn" title="Settings">⚙ Settings</button>`;
    $('appCtl').querySelectorAll('button[data-m]').forEach(b => b.onclick = async () => {
      const m = b.dataset.m; busy[m] = true; renderCtl();
      try { ST = ST[m].running ? await A.stop(m) : await A.start(m) } catch (e) { toast(clean(e), true) }
      busy[m] = false; renderCtl() });
    $('setBtn').onclick = openSettings;
  }
  const clean = e => String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  A.onStatus(s => { ST = s; renderCtl() });
  A.status().then(s => { ST = s; renderCtl() });

  // ---------- activity log in the model tab's side panel ----------
  const lineHTML = l => { const msg = l.replace(/^\[([^\]]+)\]\s*/, (m0, t) => `<b>${esc(t.slice(5, 16).replace('T', ' '))}</b> `);
    const cls = /\] BUY |^.{0,40}BUY /.test(l) ? 'buy' : /SELL /.test(l) ? 'sell' : /error|HALTED/i.test(l) ? 'err' : '';
    return `<div class="${cls}">${msg.replace(/^(<b>[^<]*<\/b> )?(.*)$/, (m0, a, b) => (a || '') + esc(b))}</div>` };
  async function renderLog(market) {
    const side = $('side'); if (!side) return;
    let box = $('appLog'); if (!box) { side.insertAdjacentHTML('beforeend', `<h2>Activity · ${NAME[market]} bot</h2><div class="log" id="appLog"></div><p class="rule" style="font-size:12px"><a href="#" id="openFolder" style="color:var(--muted)">Open data folder</a></p>`); box = $('appLog'); $('openFolder').onclick = e => { e.preventDefault(); A.openFolder() } }
    box.dataset.market = market;
    const lines = await A.log(market);
    box.innerHTML = lines.length ? lines.slice(-60).map(lineHTML).join('') : '<div>No activity yet. Press Start at the top right.</div>';
    box.scrollTop = box.scrollHeight;
  }
  document.addEventListener('dash:rendered', e => { if (e.detail.kind === 'model' && NAME[e.detail.market]) renderLog(e.detail.market) });
  A.onLog(({ market, line }) => {
    const box = $('appLog'); if (box && box.dataset.market === market) { if (/No activity yet/.test(box.textContent)) box.innerHTML = ''; box.insertAdjacentHTML('beforeend', lineHTML(line)); box.scrollTop = box.scrollHeight }
    if (/ (BUY|SELL) /.test(line) || /cycle|bar .* equity/.test(line)) window.__dash && window.__dash.refresh();
  });

  // ---------- settings dialog ----------
  async function openSettings() {
    const S = await A.getSettings(); let tab = 'stocks'; const draft = JSON.parse(JSON.stringify({ stocks: S.stocks, crypto: S.crypto, trend: S.trend, momentum: S.momentum || { mode: 'paper', headStartDays: 90, startCash: 10000, webhookUrl: '' }, bubble: S.bubble || {}, app: S.app, combo: S.combo || { on: false, total: 10000 }, desk: S.desk || { on: false, total: 10000 } })), keys = {};
    const wrap = document.createElement('div'); wrap.className = 'modal'; document.body.appendChild(wrap);
    const close = () => wrap.remove(); wrap.addEventListener('mousedown', e => { if (e.target === wrap) close() });
    document.addEventListener('keydown', function k(e) { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', k) } });
    const modeOpt = m => `<div class="opt" data-k="${m}.mode">${[['paper', 'Paper'], ['testnet', m === 'stocks' ? 'Alpaca paper' : 'Testnet'], ['live', 'Live']].map(([v, l]) => `<button type="button" class="${v === 'live' ? 'live' : ''}" data-v="${v}" aria-pressed="${draft[m].mode === v}">${l}</button>`).join('')}</div>`;
    const num = (k, v, step, suf) => `<input type="number" data-k="${k}" value="${v}" step="${step}" style="max-width:160px"> ${suf || ''}`;
    const liveWarn = m => draft[m].mode === 'live' && S[m].mode !== 'live' ? `<div class="warn">You are switching the ${NAME[m].toLowerCase()} bot to <b>real money</b>. Type <b>LIVE</b> to confirm: <input type="text" id="confirmLive" style="width:90px;margin-left:6px;background:var(--panel-2);border:1px solid var(--line);border-radius:4px;padding:4px 6px;color:var(--fg);font-family:var(--mono)"></div>` : draft[m].mode === 'live' ? `<div class="warn">This bot trades <b>real money</b>. Live mode never starts on its own; you confirm each start.</div>` : '';
    const onOff = v => v === true || v === 'on' ? 'on' : 'off';
    const guardOpt = m => `<div class="fld"><label>Burst guard</label><div class="opt" data-k="${m}.burstGuard">${[['off', 'Off'], ['on', 'On']].map(([v, l]) => `<button type="button" data-v="${v}" aria-pressed="${(draft[m].burstGuard || 'off') === v}">${l}</button>`).join('')}</div>
        <span class="hint">${GUARD_HINT[m]}</span></div>` + (m === 'crypto' && draft.crypto.burstGuard === 'on' ? `<div class="fld"><label>Short Bitcoin while the guard is out</label><div class="opt" data-k="crypto.burstShort">${[['off', 'No'], ['on', 'Yes']].map(([v, l]) => `<button type="button" data-v="${v}" aria-pressed="${onOff(draft.crypto.burstShort) === v}">${l}</button>`).join('')}</div>
        <span class="hint">${GUARD_HINT.short}</span></div>` + (onOff(draft.crypto.burstShort) === 'on' ? `<div class="fld"><label>Size of the guard short</label><div class="opt" data-k="crypto.burstShortShare">${[[0.33, 'A third of the account'], [0.5, 'Half'], [1, 'All']].map(([v, l]) => `<button type="button" data-v="${v}" aria-pressed="${+(draft.crypto.burstShortShare || 0.33) === v}">${l}</button>`).join('')}</div></div>` : '') : '');
    // 1.9.0 crypto rules (Crypto Bot 2026 Review): typical (median) of 20 backtest runs, $10,000 from Jan 2020 to Nov 2026, each run skipping a random 20% of signals
    const ruleOpt = (f, label, hint, def = 'on') => `<div class="fld"><label>${label}</label><div class="opt" data-k="crypto.${f}">${[['off', 'Off'], ['on', 'On']].map(([v, l]) => `<button type="button" data-v="${v}" aria-pressed="${onOff(draft.crypto[f] ?? def) === v}">${l}</button>`).join('')}</div><span class="hint">${hint}</span></div>`;
    const cryptoRules = () => ruleOpt('profitStop', 'Profit stop', 'Once a trade is up twice what it risked, and fewer than 35% of the scanned coins are above their 50-day average, the stop follows the best close up, 3 ATR below it. On Binance the resting stop order moves with it. Typical of 20 test runs, 2020 to Nov 2026 from $10,000: off <b>$50,323</b>, on <b>$90,702</b>; 2026 in profit in 12 and 18 of 20 runs.')
      + ruleOpt('trendRule', '50-day rule', 'Only buys coins closing above their 50-day average. Buys below it lost money in every period since 2020. With the profit stop, typical of 20 runs: <b>$85,293</b> (against $90,702 without), but 1.0 losing years per run instead of 1.4, a worst drop of 46% instead of 54%, and 2026 in profit in all 20 runs.')
      + ruleOpt('btcTrend50', 'Bitcoin 50-day rule', 'Also needs Bitcoin to have closed above its 50-day average the day before to buy. It is part of the <b>desk portfolio</b>, which switches it on. Tested alone 2020 to Nov 2026 from $10,000, one run: $159,588, worst drop 39%, but 2025 −11%.', 'off');
    const SINCE2020 = {
      crypto: 'downloads 4-hour history for about 200 coins (10–15 minutes the first time), runs it through the bot\'s own rules from 1 January 2020, and starts the account from where that ends: all trades, the coins still held and the account value since 2020. Coins delisted since 2020 can\'t be downloaded, so it flatters the past a little.',
      stocks: 'downloads daily history for the S&P 500 stocks from Alpaca (a few minutes the first time; needs your Alpaca keys), runs the chosen stock model from 1 January 2020 and starts the account from where that ends. It uses today\'s S&P 500 list, so stocks that left the index since 2020 are missing and the past looks a little better than it was.',
      trend: 'downloads daily candles since 2017 and runs the bot\'s own daily cycle for every day since 1 January 2020 (a minute or two), then trades on from there.',
      momentum: 'downloads daily candles and funding for the most traded futures (several minutes the first time) and runs the bot from 1 January 2020. Futures delisted since then are missing.',
    };
    const headOpt = m => `<div class="fld"><label>Head start (Paper)</label><div class="opt" data-k="${m}.headStartDays">${[[0, 'Off'], [30, '30 days'], [60, '60 days'], [90, '90 days'], [2020, 'Since 2020']].map(([v, l]) => `<button type="button" data-v="${v}" aria-pressed="${+draft[m].headStartDays === v}">${l}</button>`).join('')}</div>
        <span class="hint">On a new paper account, the bot first replays this many days of real market data, so you see trades and an account history within a minute or two instead of waiting for the next ${m === 'stocks' ? 'US market close' : m === 'crypto' ? '4-hour candle' : 'daily close (00:00 UTC)'}. Replayed trades are marked <i>history</i>.${+draft[m].headStartDays === 2020 ? ' <b>Since 2020</b>: ' + SINCE2020[m] + ' The download is kept, so a later reset replays exactly the same data. Then press Reset paper account so it runs on the next Start.' : ''}</span>
        </div>${S[m].mode === 'paper' ? `<div class="fld"><label>Paper account</label><div><button type="button" class="btn" data-reset="${m}">Reset paper account…</button><span class="hint" style="display:block;margin-top:4px">Starts again from the starting cash, and runs the head start again on the next Start. Old trades are archived, not deleted.</span></div></div>` : ''}`;
        const panes = {
      stocks: () => `<div class="fld"><label>Mode</label>${modeOpt('stocks')}<span class="hint">Paper simulates trades inside the app. Alpaca paper uses your free Alpaca paper account. Live uses real money.</span></div>${liveWarn('stocks')}
        <div class="fld"><label>Model</label><div class="opt" data-k="stocks.stockModel">${[['v3', 'Own model'], ['momentum', 'Momentum'], ['half', 'Half and half']].map(([v, l]) => `<button type="button" data-v="${v}" aria-pressed="${(draft.stocks.stockModel || 'v3') === v}">${l}</button>`).join('')}</div>
          <span class="hint"><b>Own model</b>: the PVSRA consensus model (v3), buys when the consensus is +30. <b>Momentum</b> (paper only for now): on the first trading day of each month holds the 5 S&amp;P 500 stocks that rose most over the past year (skipping the last month), only stocks above their 200-day average and only while the S&amp;P 500 is above its own; otherwise cash. <b>Half and half</b> (paper only for now): half in each, back to 50/50 every month. Tested 2020 to Nov 2026 from $10,000, leaving out the 5 stocks that joined the S&amp;P in 2024: own model $58,886 (worst drop 31.5%) · momentum $57,812 (35%) · half and half $63,853 (29.6%). In 2024–26, which the settings were not chosen on: own model ×1.19 · momentum ×1.95 · half and half ×1.53 · the S&amp;P 500 ×1.55. In the desk portfolio: own model $142,549 (worst drop 21%) · half and half $133,414 (21%) · momentum $134,007 (25%).</span></div>
        <div class="fld"><label>Stocks held at once</label><div class="opt" data-k="stocks.stockSlots">${[4, 5, 6].map(n => `<button type="button" data-v="${n}" aria-pressed="${+draft.stocks.stockSlots === n}">${n}</button>`).join('')}</div>
          <span class="hint">For the own model (and its half). Tested 2020–25 from $10,000: 4 → $62,950 (worst drop 37%) · 5 → $46,524 (34%) · 6 → $45,510 (30%). Momentum always holds 5.</span></div>
        <div class="fld"><label>Starting cash (paper)</label><div>$ ${num('stocks.startCash', draft.stocks.startCash, 100)}</div></div>${headOpt('stocks')}
        <div class="fld"><label>Stop new trades after a fall of</label><div>${num('stocks.maxDrawdown', Math.round(draft.stocks.maxDrawdown * 100), 1, '% from the peak')}</div></div>
        <div class="fld"><label>Pause for the day after a loss of</label><div>${num('stocks.maxDailyLoss', Math.round(draft.stocks.maxDailyLoss * 100), 1, '%')}</div></div>
        ${guardOpt('stocks')}
        <div class="fld"><label>Alert webhook (optional)</label><input type="url" data-k="stocks.webhookUrl" value="${esc(draft.stocks.webhookUrl || '')}" placeholder="Discord or Slack webhook URL"></div>`,
      crypto: () => `<div class="fld"><label>Mode</label>${modeOpt('crypto')}<span class="hint">Paper needs no keys. Testnet uses Binance's practice exchange. Live uses real money on Binance spot (buy only, no leverage).</span></div>${liveWarn('crypto')}
        <div class="fld"><label>Coins held at once</label><div class="no">3 (the tested best for crypto)</div></div>
        <div class="fld"><label>Starting cash (paper)</label><div>$ ${num('crypto.startCash', draft.crypto.startCash, 100)}</div></div>${headOpt('crypto')}
        <div class="fld"><label>Coins scanned</label><div>${num('crypto.universeSize', draft.crypto.universeSize, 10, 'most-traded USDT pairs')}</div><span class="hint">Tested with 120. 80 and 160 did no better.</span></div>
        ${cryptoRules()}
        <div class="fld"><label>Stop new trades after a fall of</label><div>${num('crypto.maxDrawdown', Math.round(draft.crypto.maxDrawdown * 100), 1, '% from the peak')}</div></div>
        <div class="fld"><label>Pause for the day after a loss of</label><div>${num('crypto.maxDailyLoss', Math.round(draft.crypto.maxDailyLoss * 100), 1, '%')}</div></div>
        ${guardOpt('crypto')}
        <div class="fld"><label>Alert webhook (optional)</label><input type="url" data-k="crypto.webhookUrl" value="${esc(draft.crypto.webhookUrl || '')}" placeholder="Discord or Slack webhook URL"></div>`,
      trend: () => `<p class="rule" style="margin:0">The Trend Engine: once a day after 00:00 UTC it checks eight trend signals and the coin's volatility, and holds between 0% and 100% of its money in the coin. Spot only, never leveraged. Built to cut the big crashes, not to beat holding Bitcoin in a boom.</p>
        <div class="fld"><label>Mode</label>${modeOpt('trend')}<span class="hint">Paper simulates inside the app with live Binance prices. Testnet uses Binance's practice exchange. Live uses real money on Binance spot.</span></div>${liveWarn('trend')}
        <div class="fld"><label>Coins</label><div class="opt" data-k="trend.coins">${[['btc', 'Bitcoin only'], ['basket10', '10 most-traded coins']].map(([v, l]) => `<button type="button" data-v="${v}" aria-pressed="${draft.trend.coins === v}">${l}</button>`).join('')}</div>
          <span class="hint">Tested 2020–25 from $10,000: Bitcoin only → $78,339 (worst drop 51%). 10-coin basket (from June 2020) → $37,800 (51%): it beat holding Bitcoin in 2020–22, then fell far behind. Holding Bitcoin → $123,491 (77%).</span></div>
        <div class="fld"><label>Money for this bot</label><div>$ ${num('trend.startCash', draft.trend.startCash, 100)}</div><span class="hint">Paper: the starting balance. Testnet or Live: the most USDT it will use. It keeps its own record of its coins and cash and never sells coins the crypto bot holds.</span></div>${headOpt('trend')}
        ${guardOpt('trend')}
        <div class="fld"><label>Alert webhook (optional)</label><input type="url" data-k="trend.webhookUrl" value="${esc(draft.trend.webhookUrl || '')}" placeholder="Discord or Slack webhook URL"></div>`,
      momentum: () => `<p class="rule" style="margin:0"><b>Paper only.</b> Long/short momentum on Binance futures: every 7 days, among the 100 most traded perpetual futures, it buys the 10 that rose most over 30 days and shorts the 10 that fell most, half the account each side. Funding is paid on longs and received on shorts. Tested 2020 to Nov 2026 from $10,000 with settings chosen on 2020–23: <b>$175,895</b>, worst drop 39%; 2022 −22%, 2024 +8%, 2025 +185%, 2026 +67%. It needs futures and can be hit by sudden squeezes on small coins, so it never trades real money. It uses Binance's public market data: no keys needed.</p>
        <div class="fld"><label>Starting cash (paper)</label><div>$ ${num('momentum.startCash', draft.momentum.startCash, 100)}</div></div>${headOpt('momentum')}
        <div class="fld"><label>Alert webhook (optional)</label><input type="url" data-k="momentum.webhookUrl" value="${esc(draft.momentum.webhookUrl || '')}" placeholder="Discord or Slack webhook URL"></div>`,
      desk: () => `<p class="rule" style="margin:0">One pot of money shared by all three bots. On the first day of each quarter the desk re-splits it by how much each bot's value has swung day to day over the last 120 days: calmer bots get more (starting from 40% crypto, 40% trend, 20% stocks; no bot above 60%). Tested 2020 to Nov 2026 from $10,000, typical of 20 runs: <b>$125,457</b> with a worst drop of <b>22%</b> (worst run 25%), against $95,138 and 47% for the crypto bot alone. Chosen on those years, so expect less: nearby settings made $103,000–$116,000.</p>
        <div class="fld"><label>Desk portfolio</label><div class="opt" data-k="desk.on">${[['off', 'Off'], ['on', 'On']].map(([v, l]) => `<button type="button" data-v="${v}" aria-pressed="${onOff(draft.desk.on) === v}">${l}</button>`).join('')}</div>
          <span class="hint">Adds a <b>Desk portfolio</b> tab with the joint value, the split and the worst drop. Switching on also turns on the crypto bot's Bitcoin 50-day rule, sets the stock bot to 4 stocks (both as tested), sets every paper bot's head start to <b>Since 2020</b> and turns off the combined crypto account. Then reset the paper accounts and start the bots: each replays its own trades since 1 January 2020, and once all of them are done the desk works out its own history since 2020 the way it was tested (the quarterly re-splits applied to the bots' replayed values) and moves each bot's money to today's share. Resetting a desk bot's paper account starts the desk's history again too.</span></div>
        <div class="fld"><label>Include the momentum bot</label><div class="opt" data-k="desk.momentum">${[['off', 'Off'], ['on', 'On']].map(([v, l]) => `<button type="button" data-v="${v}" aria-pressed="${onOff(draft.desk.momentum ?? true) === v}">${l}</button>`).join('')}</div>
          <span class="hint">A fourth, paper-only bot (long/short momentum on futures). With it the desk starts each bot at a quarter and sets each quarter's tilt half equal, half by each bot's record over the last year. Tested typical of 20 runs: <b>$140,726</b>, worst drop <b>22%</b>, 2022 the only losing year (−11%), against $125,457 for the three-bot desk; five share rules were tried and this was the best, close variants made $122,000–$125,000. It only joins while the other three bots are on paper.</span></div>
        <div class="fld"><label>Money for the desk</label><div>$ ${num('desk.total', draft.desk.total || 10000, 100)}</div><span class="hint">Switching on sets each bot's starting cash to its first share: a quarter each with the momentum bot, or 40% crypto, 40% trend and 20% stocks without it. Paper bots move money automatically each quarter. If any bot trades real money, nothing moves by itself: the desk shows and notifies how much to add to or take from each bot (stocks are on Alpaca, crypto and trend on Binance).</span></div>`,
      combo: () => `<p class="rule" style="margin:0">One pot of money run by two bots: <b>a third</b> in the crypto bot and <b>two thirds</b> in the trend bot, put back to that split on the first day of each month. Tested 2020 to Nov 2026 from $10,000 with the 1.9.0 crypto rules: <b>$120,933</b> (worst drop 33%), against $149,671 (47%) for the crypto bot alone and $93,750 (46%) for the trend bot alone. The crypto figure is one run; across 20 runs that each skip a random fifth of its signals, the crypto bot's typical result was $85,293. Both bots were tuned on those years, so expect less in future.</p>
        <div class="fld"><label>Combined crypto account</label><div class="opt" data-k="combo.on">${[['off', 'Off'], ['on', 'On']].map(([v, l]) => `<button type="button" data-v="${v}" aria-pressed="${onOff(draft.combo.on) === v}">${l}</button>`).join('')}</div>
          <span class="hint">Adds a <b>Combined crypto</b> tab to the desk with the joint account value. Both bots must use the same mode. Stop and start both bots after switching it on.</span></div>
        <div class="fld"><label>Money for the combined account</label><div>$ ${num('combo.total', draft.combo.total || 10000, 100)}</div><span class="hint">Switching on sets the crypto bot's starting cash to a third of this and the trend bot's to two thirds${onOff(draft.combo.on) === 'on' ? ` (now $${Math.round((draft.combo.total || 10000) / 3).toLocaleString('en-US')} and $${Math.round((draft.combo.total || 10000) * 2 / 3).toLocaleString('en-US')})` : ''}. On existing paper accounts the first monthly rebalance sets the split. On Testnet or Live both bots share one Binance account: the trend bot keeps its own record of its coins and cash, and the crypto bot only counts and spends what the trend bot doesn't own; no money leaves the account when they rebalance.</span></div>`,
      keys: () => `<p class="rule" style="margin:0">Keys are encrypted with your Windows account and never leave this PC except to your broker. Leave a box empty to keep the saved key.</p>
        <div class="fld"><label>Alpaca key ID</label><input type="password" data-key="alpacaKey" placeholder="${S.keys.alpaca ? 'saved' : 'not set'}" autocomplete="off"></div>
        <div class="fld"><label>Alpaca secret key</label><input type="password" data-key="alpacaSecret" placeholder="${S.keys.alpaca ? 'saved' : 'not set'}" autocomplete="off"><span class="hint">Needed by the stock bot for market data, even in Paper mode. Free paper keys: alpaca.markets → Paper Trading → API Keys. <span class="${S.keys.alpaca ? 'ok' : 'no'}">${S.keys.alpaca ? '✓ saved' : 'not set'}</span></span></div>
        <div class="fld"><label>Binance API key</label><input type="password" data-key="binanceKey" placeholder="${S.keys.binance ? 'saved' : 'not set'}" autocomplete="off"></div>
        <div class="fld"><label>Binance secret key</label><input type="password" data-key="binanceSecret" placeholder="${S.keys.binance ? 'saved' : 'not set'}" autocomplete="off"><span class="hint">Only for crypto Testnet (keys from testnet.binance.vision) or Live. Turn withdrawals off on the key. <span class="${S.keys.binance ? 'ok' : 'no'}">${S.keys.binance ? '✓ saved' : 'not set'}</span></span></div>`,
      bubble: () => `<p class="rule" style="margin:0">The Bubble Watch tab refreshes its S&amp;P 500 data once a day from public sources (Yahoo Finance, FRED, Shiller, FINRA); no key is needed for that. An Anthropic API key adds a daily news check: Claude searches the news for each pillar and compares it with the data. That costs a few cents a day on your Anthropic account.</p>
        ${[['autoUpdate', 'Refresh the Bubble Watch data once a day', 'Runs in the background while the app is open.'], ['newsDaily', 'Run the daily news check (needs an Anthropic API key)', ''], ['notify', 'Notify me when the bubble zone, the crash plan stage or the momentum killers change', '']].map(([k, l, h]) => `<label class="chk"><input type="checkbox" data-k="bubble.${k}" ${draft.bubble[k] ? 'checked' : ''}><span>${l}${h ? `<br><span class="rule" style="font-size:12px">${h}</span>` : ''}</span></label>`).join('')}
        <div class="fld"><label>Anthropic API key</label><input type="password" data-key="anthropicKey" placeholder="${S.keys.anthropic ? 'saved' : 'not set'}" autocomplete="off"><span class="hint">From console.anthropic.com → API keys. Used only for the news check and the article checker. <span class="${S.keys.anthropic ? 'ok' : 'no'}">${S.keys.anthropic ? '✓ saved' : 'not set'}</span></span></div>
        <div class="fld"><label>News model</label><input type="text" data-k="bubble.newsModel" value="${esc(draft.bubble.newsModel || 'claude-sonnet-5-5')}"><span class="hint">Any Claude model id your key can use.</span></div>`,
      app: () => [['startBotsOnOpen', 'Start both bots when the app opens', 'Never starts a bot that is set to Live.'], ['openAtLogin', 'Open Trading Desk when Windows starts', 'Opens hidden in the tray.'], ['closeToTray', 'Keep the bots running in the tray when I close the window', 'Quit from the tray icon to stop everything.'], ['notifications', 'Desktop notifications for every buy, sell and warning', '']]
        .map(([k, l, h]) => `<label class="chk"><input type="checkbox" data-k="app.${k}" ${draft.app[k] ? 'checked' : ''}><span>${l}${h ? `<br><span class="rule" style="font-size:12px">${h}</span>` : ''}</span></label>`).join('') + `<label class="chk"><input type="checkbox" id="cvdChk" ${document.documentElement.dataset.cvd === '1' ? 'checked' : ''}><span>Colour-blind friendly colours<br><span class="rule" style="font-size:12px">Blue for up and orange for down instead of green and red, on candles, gains and losses, plus bot colours that stay apart with red–green colour blindness. Applies straight away and is remembered on this computer.</span></span></label>`
        + `<p class="rule">The bots only trade while this app is running and the PC is awake. App version ${S.version}.</p>`,
    };
    const draw = () => {
      wrap.innerHTML = `<div class="dlg" role="dialog" aria-modal="true" aria-label="Settings"><header><h3>Settings</h3><button class="btn" id="xClose">Close</button></header>
        <div class="tabs" role="tablist">${[['stocks', 'Stock bot'], ['crypto', 'Crypto bot'], ['trend', 'Trend bot'], ['momentum', 'Momentum bot'], ['desk', 'Desk portfolio'], ['combo', 'Combined'], ['bubble', 'Bubble Watch'], ['keys', 'Broker keys'], ['app', 'App']].map(([k, l]) => `<button role="tab" data-t="${k}" aria-selected="${tab === k}">${l}</button>`).join('')}</div>
        <div class="pane">${panes[tab]()}</div><footer><span class="rule" id="sMsg" style="margin:0;flex:1"></span><button class="btn" id="xCancel">Cancel</button><button class="btn go" id="xSave">Save</button></footer></div>`;
      wrap.querySelectorAll('[data-t]').forEach(b => b.onclick = () => { collect(); tab = b.dataset.t; draw() });
      const cv = $('cvdChk'); if (cv) cv.onchange = () => { try { localStorage.setItem('pvsra.cvd', cv.checked ? '1' : '0') } catch (e) {} location.reload() };
      wrap.querySelectorAll('.opt[data-k]').forEach(o => o.querySelectorAll('button').forEach(b => b.onclick = () => { collect(); const [m, f] = o.dataset.k.split('.'); draft[m][f] = /stockSlots|headStartDays|burstShortShare/.test(f) ? +b.dataset.v : b.dataset.v; draw() }));
      $('xClose').onclick = close; $('xCancel').onclick = close; $('xSave').onclick = save;
      wrap.querySelectorAll('[data-reset]').forEach(b => b.onclick = async () => { const msg = $('sMsg'); try { const r = await A.resetPaper(b.dataset.reset); if (r.ok) { msg.style.color = ''; msg.textContent = r.nothing ? 'Nothing to reset yet.' : 'Paper account reset. Press Start to begin again.'; window.__dash && window.__dash.refresh() } } catch (e) { msg.textContent = clean(e); msg.style.color = 'var(--c-dn)' } });
    };
    const collect = () => {
      wrap.querySelectorAll('input[data-k]').forEach(i => { const [m, f] = i.dataset.k.split('.'); if (i.type === 'checkbox') draft[m][f] = i.checked; else if (i.type === 'number') draft[m][f] = /maxDrawdown|maxDailyLoss/.test(f) ? +i.value / 100 : +i.value; else draft[m][f] = i.value });
      wrap.querySelectorAll('input[data-key]').forEach(i => { if (i.value.trim()) keys[i.dataset.key] = i.value.trim() });
      const c = $('confirmLive'); if (c) draft.confirmLive = c.value.trim();
    };
    const save = async () => {
      collect(); const msg = $('sMsg');
      for (const m of ['stocks', 'crypto', 'trend']) if (draft[m].mode === 'live' && S[m].mode !== 'live' && draft.confirmLive !== 'LIVE') { tab = m; draw(); $('sMsg').textContent = 'Type LIVE to confirm real-money trading.'; $('sMsg').style.color = 'var(--c-dn)'; return }
      try {
        const r = await A.saveSettings({ stocks: draft.stocks, crypto: draft.crypto, trend: draft.trend, momentum: draft.momentum, bubble: draft.bubble, app: draft.app, combo: draft.combo, desk: draft.desk, keys: Object.keys(keys).length ? keys : undefined, confirmLive: draft.confirmLive });
        close(); ST = await A.status(); renderCtl(); window.__dash && window.__dash.refresh();
        toast(r.restartNeeded.length ? `Saved. Stop and start the ${r.restartNeeded.map(m => NAME[m].toLowerCase()).join(' and ')} bot to use the new settings.` : 'Settings saved.');
      } catch (e) { msg.textContent = clean(e); msg.style.color = 'var(--c-dn)' }
    };
    draw();
  }
})();

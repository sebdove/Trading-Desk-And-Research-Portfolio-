/* Drawing tools (TradingView style) shared by the bot charts and the Bubble Watch chart: measure, trend line,
   horizontal line. Points are kept as (x position in the chart's own units, price) so they stay on the right bars
   while the chart is panned or zoomed; each chart keeps its own drawings on this computer.
   Mouse: pick a tool, click a start point and an end point (horizontal line: one click). Shift + click on the chart
   measures straight away. Double-click a line to delete it. Keys: Alt+T trend line, Alt+H horizontal line, Alt+M
   measure, Esc cancel, Ctrl+Z undo.
   DrawLayer(o) with o = {wrap, el, api(), key(), visible(), barPos?()}; api() returns null or
   {pane:{x,y,w,h}, axis:'left'|'right', X(l), Y(p), L(x), P(y), snap(l), span(a,b)}. DrawLayer.lw(...) builds api()
   for a Lightweight Charts chart. */
(function () {
  if (window.DrawLayer) return;
  const st = document.createElement('style');
  st.textContent = `:root{--draw:#ffffff;--draw-ink:#0c1016;--draw-ui:#4f8cff}@media (prefers-color-scheme: light){:root:not([data-theme="dark"]){--draw:#17202b;--draw-ink:#ffffff;--draw-ui:#2962ff}}
.drawcv{position:absolute;z-index:3;pointer-events:none}
.drawbar{position:absolute;z-index:5;left:10px;top:36px;display:flex;gap:2px;padding:3px;background:var(--panel);border:1px solid var(--line);border-radius:8px;box-shadow:0 2px 10px rgba(0,0,0,.28)}
.drawbar button{display:grid;place-items:center;width:30px;height:28px;border:0;border-radius:5px;background:none;color:var(--muted);cursor:pointer;padding:0}
.drawbar button:hover{color:var(--fg);background:var(--panel-2,var(--panel2,rgba(127,127,127,.12)))}
.drawbar button[aria-pressed="true"]{color:var(--draw-ui);background:color-mix(in srgb,var(--draw-ui) 16%,transparent)}
.drawbar button[data-t="undo"]{margin-left:5px;border-left:1px solid var(--line);border-radius:0 5px 5px 0}`;
  document.head.appendChild(st);
  const ICON = {cursor:'<path d="M5 3l11 6-5 1.6L8.6 16z"/>',measure:'<path d="M3 15L15 3M5 9l2 2M8 6l2 2M11 3.5l1.5 1.5M2.5 12.5l1.5 1.5"/>',
    trend:'<path d="M3 15L15 3"/><circle cx="3" cy="15" r="1.6"/><circle cx="15" cy="3" r="1.6"/>',hline:'<path d="M2 9h14"/><circle cx="9" cy="9" r="1.6"/>',
    undo:'<path d="M6 5L3 8l3 3"/><path d="M3 8h8a4 4 0 010 8H8"/>',clear:'<path d="M4 5h10M7 5V3h4v2M5.5 5l.8 10h5.4l.8-10"/>'};
  const TOOLS = [['cursor','Cursor (Esc)'],['measure','Measure (Alt+M, or Shift + click)'],['trend','Trend line (Alt+T)'],['hline','Horizontal line (Alt+H)'],['undo','Undo (Ctrl+Z)'],['clear','Delete all drawings on this chart']];
  const fmt = v => { const a = Math.abs(v); return a >= 1000 ? v.toLocaleString('en-US', {maximumFractionDigits: 2}) : a >= 1 ? v.toFixed(2) : v.toPrecision(4) };
  const dur = s => { s = Math.abs(s); const d = Math.floor(s/86400), h = Math.round(s%86400/3600); return d >= 365 ? (s/31557600).toFixed(1)+'y' : d >= 1 ? d+'d'+(h && d < 30 ? ' '+h+'h' : '') : h+'h' };

  function DrawLayer(o) {
    const cv = document.createElement('canvas'); cv.className = 'drawcv'; o.wrap.appendChild(cv); const g = cv.getContext('2d');
    const bar = document.createElement('div'); bar.className = 'drawbar'; bar.setAttribute('role','toolbar'); bar.setAttribute('aria-label','Drawing tools'); o.wrap.appendChild(bar);
    bar.innerHTML = TOOLS.map(([k, t]) => `<button type="button" data-t="${k}" title="${t}" aria-label="${t}"><svg viewBox="0 0 18 18" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${ICON[k]}</svg></button>`).join('');
    let mode = 'cursor', draft = null, meas = null, hover = null, items = [], curKey = null, A = null;
    const store = k => 'pvsra.draw.' + k;
    const load = k => { try { return JSON.parse(localStorage.getItem(store(k)) || '[]') } catch (e) { return [] } };
    const save = () => { if (!curKey) return; try { localStorage.setItem(store(curKey), JSON.stringify(items)) } catch (e) {} };
    const setMode = m => { mode = m; draft = null; bar.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.t === m))); cv.style.pointerEvents = m === 'cursor' ? 'none' : 'auto'; cv.style.cursor = m === 'cursor' ? '' : 'crosshair' };
    setMode('cursor');
    bar.onclick = e => { const b = e.target.closest('button'); if (!b) return; const t = b.dataset.t;
      if (t === 'undo') { items.pop(); save(); return }
      if (t === 'clear') { items = []; meas = null; save(); setMode('cursor'); return }
      meas = null; setMode(mode === t && t !== 'cursor' ? 'cursor' : t) };
    const local = e => { const r = o.el.getBoundingClientRect(); return {x: e.clientX - r.left, y: e.clientY - r.top} };
    const inPane = (x, y) => A && x >= A.pane.x && x <= A.pane.x + A.pane.w && y >= A.pane.y && y <= A.pane.y + A.pane.h;
    const toPt = (x, y) => { A = o.api(); if (!A || !inPane(x, y)) return null; const l = A.L(x), p = A.P(y); return l == null || p == null || !isFinite(l) || !isFinite(p) ? null : {l: A.snap(l), p} };
    const X = l => { const v = A.X(l); return v == null || !isFinite(v) ? null : v }, Y = p => { const v = A.Y(p); return v == null || !isFinite(v) ? null : v };
    cv.addEventListener('mousedown', e => { if (e.button !== 0) return; e.preventDefault(); const {x, y} = local(e), pt = toPt(x, y); if (!pt) return;
      if (mode === 'hline') { items.push({t: 'h', p: pt.p}); save(); setMode('cursor'); return }
      if (!draft) { draft = {a: pt, b: {...pt}}; if (mode === 'measure') meas = null; return }
      draft.b = pt; finish() });
    cv.addEventListener('mousemove', e => { const {x, y} = local(e), pt = toPt(x, y); hover = pt; if (pt && draft) draft.b = pt });
    cv.addEventListener('mouseleave', () => { hover = null });
    function finish() { if (!draft) return;
      if (mode === 'trend') { if (draft.a.l !== draft.b.l || draft.a.p !== draft.b.p) { items.push({t: 'tl', a: draft.a, b: draft.b}); save() } }
      else if (mode === 'measure') meas = {a: draft.a, b: draft.b};
      draft = null; setMode('cursor') }
    // on the chart itself: Shift + click measures; any other click clears a finished measurement
    const startQuick = e => { const {x, y} = local(e), pt = toPt(x, y); if (!pt) return false; e.stopImmediatePropagation(); e.preventDefault(); meas = null; setMode('measure'); draft = {a: pt, b: {...pt}}; return true };
    o.el.addEventListener('pointerdown', e => { if (e.button !== 0 || mode !== 'cursor') return; if (e.shiftKey) { startQuick(e); return } meas = null }, true);
    o.el.addEventListener('mousedown', e => { if (e.button === 0 && e.shiftKey && mode === 'measure' && draft) { e.stopPropagation(); e.preventDefault() } }, true);
    o.el.addEventListener('dblclick', e => { if (mode !== 'cursor') return; A = o.api(); if (!A) return; const {x, y} = local(e); let best = -1, bd = 7;
      items.forEach((it, i) => { const d = dist(it, x, y); if (d < bd) { bd = d; best = i } }); if (best >= 0) { items.splice(best, 1); save(); e.stopImmediatePropagation(); e.preventDefault() } }, true);
    function dist(it, x, y) { if (it.t === 'h') { const yy = Y(it.p); return yy == null ? 1e9 : Math.abs(yy - y) }
      const x1 = X(it.a.l), y1 = Y(it.a.p), x2 = X(it.b.l), y2 = Y(it.b.p); if ([x1, y1, x2, y2].some(v => v == null)) return 1e9;
      const dx = x2 - x1, dy = y2 - y1, L = dx*dx + dy*dy || 1, t = Math.max(0, Math.min(1, ((x - x1)*dx + (y - y1)*dy)/L)); return Math.hypot(x - (x1 + t*dx), y - (y1 + t*dy)) }
    document.addEventListener('keydown', e => { if (!o.visible() || /INPUT|TEXTAREA|SELECT/.test((document.activeElement || {}).tagName || '')) return;
      if (e.key === 'Escape') { if (draft || mode !== 'cursor' || meas) { draft = null; meas = null; setMode('cursor'); e.preventDefault() } return }
      if (e.altKey && !e.ctrlKey && !e.metaKey) { const k = e.key.toLowerCase(), m = k === 't' ? 'trend' : k === 'h' ? 'hline' : k === 'm' ? 'measure' : null; if (m) { meas = null; setMode(m); e.preventDefault() } return }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && items.length) { items.pop(); save(); e.preventDefault() } });
    const css = k => getComputedStyle(document.documentElement).getPropertyValue(k).trim();
    function label(text, x, y, bg, fg, accent) { g.font = '600 11px "IBM Plex Mono", ui-monospace, monospace'; const lines = text.split('\n'), w = Math.max(...lines.map(l => g.measureText(l).width)) + 14, h = lines.length*15 + 8;
      const P = A.pane, xx = Math.max(P.x + 2, Math.min(P.x + P.w - w - 2, x - w/2)), yy = Math.max(P.y + 2, Math.min(P.y + P.h - h - 2, y)); g.fillStyle = bg; g.beginPath(); g.roundRect ? g.roundRect(xx, yy, w, h, 4) : g.rect(xx, yy, w, h); g.fill();
      lines.forEach((l, i) => { g.fillStyle = i === 0 && accent ? accent : fg; g.fillText(l, xx + 7, yy + 15 + i*15) }) }
    function frame() { requestAnimationFrame(frame);
      A = o.visible() ? o.api() : null; const vis = !!A; bar.hidden = !vis; cv.hidden = !vis; if (!vis) return;
      const k = o.key(); if (k !== curKey) { curKey = k; items = load(k); meas = null; draft = null; setMode('cursor') }
      if (o.barPos) { const p = o.barPos(); bar.style.left = p.left + 'px'; bar.style.top = p.top + 'px' }
      const dpr = window.devicePixelRatio || 1, W = o.el.clientWidth, H = o.el.clientHeight;
      cv.style.left = o.el.offsetLeft + 'px'; cv.style.top = o.el.offsetTop + 'px'; cv.style.width = W + 'px'; cv.style.height = H + 'px';
      if (cv.width !== Math.round(W*dpr) || cv.height !== Math.round(H*dpr)) { cv.width = Math.round(W*dpr); cv.height = Math.round(H*dpr) }
      g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H);
      const P = A.pane; g.save(); g.beginPath(); g.rect(0, P.y, W, P.h); g.clip();
      const LC = css('--draw') || '#ffffff', LI = css('--draw-ink') || '#0c1016', up = css('--up') || css('--ok') || '#26b37a', dn = css('--down') || css('--no') || '#e0474f', ink = css('--bg') || '#0f191d';
      const show = [...items]; if (draft && mode === 'trend') show.push({t: 'tl', a: draft.a, b: draft.b});
      for (const it of show) { g.strokeStyle = LC; g.lineWidth = 1.6; g.setLineDash([]);
        if (it.t === 'h') { const y = Y(it.p); if (y == null) continue; g.beginPath(); g.moveTo(P.x, y); g.lineTo(P.x + P.w, y); g.stroke();
          g.font = '600 11px "IBM Plex Mono", ui-monospace, monospace'; const t = fmt(it.p), tw = g.measureText(t).width + 10; g.fillStyle = LC;
          if (A.axis === 'left') { g.fillRect(P.x - tw - 1, y - 9, tw, 18); g.fillStyle = LI; g.fillText(t, P.x - tw + 4, y + 4) }
          else { g.fillRect(P.x + P.w + 1, y - 9, Math.max(tw, W - P.x - P.w - 2), 18); g.fillStyle = LI; g.fillText(t, P.x + P.w + 6, y + 4) }
          continue }
        const x1 = X(it.a.l), y1 = Y(it.a.p), x2 = X(it.b.l), y2 = Y(it.b.p); if ([x1, y1, x2, y2].some(v => v == null)) continue;
        g.save(); g.beginPath(); g.rect(P.x, P.y, P.w, P.h); g.clip();
        g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2); g.stroke();
        for (const [x, y] of [[x1, y1], [x2, y2]]) { g.beginPath(); g.arc(x, y, 3.2, 0, 7); g.fillStyle = ink; g.fill(); g.stroke() }
        g.restore() }
      const M = draft && mode === 'measure' ? draft : meas;
      if (M) { const x1 = X(M.a.l), y1 = Y(M.a.p), x2 = X(M.b.l), y2 = Y(M.b.p);
        if (![x1, y1, x2, y2].some(v => v == null)) { const rise = M.b.p >= M.a.p, col = rise ? up : dn, d = M.b.p - M.a.p, pc = M.a.p ? d/M.a.p*100 : 0;
          g.save(); g.beginPath(); g.rect(P.x, P.y, P.w, P.h); g.clip();
          g.globalAlpha = .12; g.fillStyle = LC; g.fillRect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1)); g.globalAlpha = 1;
          g.strokeStyle = LC; g.lineWidth = 1.4; const mx = (x1 + x2)/2, my = (y1 + y2)/2;
          g.beginPath(); g.moveTo(mx, y1); g.lineTo(mx, y2); g.moveTo(x1, my); g.lineTo(x2, my); g.stroke();
          const ah = (x, y, dx, dy) => { g.beginPath(); g.moveTo(x, y); g.lineTo(x - dx*6 - dy*4, y - dy*6 + dx*4); g.moveTo(x, y); g.lineTo(x - dx*6 + dy*4, y - dy*6 - dx*4); g.stroke() };
          if (Math.abs(y2 - y1) > 14) ah(mx, y2, 0, Math.sign(y2 - y1)); if (Math.abs(x2 - x1) > 14) ah(x2, my, Math.sign(x2 - x1), 0); g.restore();
          label(`${d >= 0 ? '+' : '−'}${fmt(Math.abs(d))} (${pc >= 0 ? '+' : '−'}${Math.abs(pc).toFixed(2)}%)\n${A.span(M.a.l, M.b.l)}`, mx, Math.max(y1, y2) + 8, LC, LI, LC.toLowerCase() === '#ffffff' ? (document.documentElement.dataset.cvd === '1' ? (rise ? '#1f6fd1' : '#b35f00') : (rise ? '#0a7f52' : '#c0262f')) : col) } }
      if (mode !== 'cursor' && hover && !draft) { const x = X(hover.l), y = Y(hover.p); if (x != null && y != null) { g.fillStyle = LC; g.beginPath(); g.arc(x, y, 3, 0, 7); g.fill() } }
      g.restore() }
    requestAnimationFrame(frame);
    return {cancel: () => { draft = null; setMode('cursor') }};
  }
  // api() for a Lightweight Charts chart + series inside element el; tf() = seconds per bar
  DrawLayer.lw = (el, chart, series, tf) => () => { const c = chart(), s = series(); if (!c || !s) return null; let pw = 0, th = 0; try { pw = c.priceScale('right').width(); th = c.timeScale().height() } catch (e) {}
    const ts = c.timeScale(); return {pane: {x: 0, y: 0, w: el.clientWidth - pw, h: el.clientHeight - th}, axis: 'right',
      X: l => ts.logicalToCoordinate(l), Y: p => s.priceToCoordinate(p), L: x => ts.coordinateToLogical(x), P: y => s.coordinateToPrice(y), snap: Math.round,
      span: (a, b) => { const n = Math.round(b - a); return `${Math.abs(n)} bars, ${dur(n*(tf() || 86400))}` }} };
  window.DrawLayer = DrawLayer;
})();

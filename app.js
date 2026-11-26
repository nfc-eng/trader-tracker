(() => {
const $ = s => document.querySelector(s);
const fmt$ = v => '$' + v.toFixed(2);
const sign$ = v => (v >= 0 ? '+' : '−') + '$' + Math.abs(v).toFixed(2);
const signP = v => (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(2) + '%';
const cls = v => v >= 0 ? 'pos' : 'neg';
const DOW = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const dparts = d => { const [y,m,dd] = d.split('-').map(Number); return {y,m,dd,dow:new Date(Date.UTC(y,m-1,dd)).getUTCDay()}; };
const dLabel = d => { const p = dparts(d); return `${DOW[p.dow]} ${MON[p.m-1]} ${p.dd}`; };
const mins = t => +t.slice(11,13) * 60 + +t.slice(14,16);
const hm = m => { const h = Math.floor(m/60), mm = Math.round(m%60); return `${((h+11)%12)+1}:${String(mm).padStart(2,'0')}${h<12?'a':'p'}`; };
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

let E, T, mode = 'day', sel = null, weeks = [];
let series = [], marks = [], x0 = 0, x1 = 1, yMin = 0, yMax = 1, base = 100;
let p = 1, playing = false, last = 0, speed = 1, pinned = null, shown = null, shownAt = 0;
const cv = $('#chart'), ctx = cv.getContext('2d'), wrap = $('#chartWrap'), call = $('#callout');
let W = 0, H = 0, DPR = 1;
const PAD = {l: 8, r: 54, t: 18, b: 26};

Promise.all([fetch('/data/equity.json').then(r => r.json()), fetch('/data/trades.json').then(r => r.json())])
  .then(([e, t]) => { E = e; T = t.trades; init(); })
  .catch(err => { $('#value').textContent = 'Data unavailable'; console.error(err); });

function init() {
  $('#value').textContent = fmt$(E.current_value);
  $('#pnl').innerHTML = `<span class="${cls(E.total_pnl)}">${sign$(E.total_pnl)} (${signP(E.total_pnl_pct)})</span> <span class="asof">since ${fmt$(E.starting_capital)} start</span>`;
  $('#asof').textContent = E.as_of ? `as of ${dLabel(E.as_of.slice(0,10))}, ${hm(mins(E.as_of))} ET` : '';
  $('#gen').textContent = `Data updated ${E.generated_at.slice(0,10)} · ${E.stats.trades} trades over ${E.stats.trading_days} trading days`;
  // weeks (Mon-start)
  const byW = {};
  E.daily.forEach(d => { const p = dparts(d.date); const mon = new Date(Date.UTC(p.y,p.m-1,p.dd - ((p.dow+6)%7))); const k = mon.toISOString().slice(0,10); (byW[k] = byW[k] || []).push(d.date); });
  weeks = Object.entries(byW).sort().map(([k, ds]) => ({k, ds}));
  stats(); bars(); dayList();
  sel = E.daily[E.daily.length-1].date;
  chips(); build();
  addEventListener('resize', resize); resize();
  document.querySelectorAll('.seg button').forEach(b => b.onclick = () => {
    document.querySelectorAll('.seg button').forEach(x => x.classList.toggle('on', x === b));
    mode = b.dataset.mode; sel = mode === 'day' ? E.daily[E.daily.length-1].date : weeks[weeks.length-1].k;
    chips(); build(); restart();
  });
  $('#play').onclick = () => { if (playing) pause(); else { if (p >= 1) p = 0; play(); } };
  $('#speed').onclick = () => { speed = speed === 1 ? 2 : speed === 2 ? 4 : 1; $('#speed').textContent = speed + '×'; };
  $('#scrub').oninput = e => { pause(); p = e.target.value / 1000; pinned = null; draw(true); };
  cv.addEventListener('pointerdown', tap);
  requestAnimationFrame(loop);
  if (!reduced) setTimeout(restart, 500); else { p = 1; draw(true); }
}

function stats() {
  const s = E.stats, best = E.daily.find(d => d.date === s.best_day), worst = E.daily.find(d => d.date === s.worst_day);
  const items = [
    ['Total P&L', `<span class="${cls(E.total_pnl)}">${sign$(E.total_pnl)}</span>`],
    ['Return', `<span class="${cls(E.total_pnl_pct)}">${signP(E.total_pnl_pct)}</span>`],
    ['Trades', s.trades], ['Trading days', s.trading_days],
    ['Green days', `${s.green_days} / ${s.trading_days}`],
    ['Best day', best ? `<span class="pos">${sign$(best.pnl)}</span>` : '—'],
    ['Worst day', worst ? `<span class="${cls(worst.pnl)}">${sign$(worst.pnl)}</span>` : '—'],
    ['Peak value', fmt$(s.max_value)],
  ];
  $('#stats').innerHTML = items.map(([k,v]) => `<div class="stat"><div class="k">${k}</div><div class="v">${v}</div></div>`).join('');
}

function bars() {
  const mx = Math.max(...E.daily.map(d => Math.abs(d.pnl)), 0.01);
  $('#bars').innerHTML = E.daily.slice().reverse().map(d => {
    const w = Math.abs(d.pnl) / mx * 50, pos = d.pnl >= 0;
    return `<div class="bar"><span>${dLabel(d.date)}</span><div class="track"><div class="mid"></div><div class="fill" style="${pos?'left:50%':'right:50%'};width:0;background:${pos?'var(--up)':'var(--dn)'}" data-w="${w}%"></div></div><span class="amt ${cls(d.pnl)}">${sign$(d.pnl)}</span></div>`;
  }).join('');
  requestAnimationFrame(() => setTimeout(() => document.querySelectorAll('.bar .fill').forEach(f => f.style.width = f.dataset.w), 60));
}

function esc(s) { return String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }

function dayList() {
  $('#days').innerHTML = E.daily.slice().reverse().map((d, i) => {
    const ts = T.filter(t => t.date === d.date).slice().reverse();
    return `<details class="day" ${i === 0 ? 'open' : ''}><summary><span class="d">${dLabel(d.date)}</span><span class="s">${ts.length} trade${ts.length===1?'':'s'} · close ${fmt$(d.close)} · <span class="${cls(d.pnl)}">${sign$(d.pnl)}</span> <span class="chev">›</span></span></summary>
    ${ts.map(t => `<div class="tr"><span class="t">${hm(mins(t.time))}</span><span class="sym" style="color:var(--${t.symbol==='TQQQ'?'tq':'sq'})">${t.symbol}</span><span class="side ${t.side==='buy'?'pos':'neg'}">${t.side}</span>
      <span class="num">${t.shares} sh @ ${fmt$(t.price)} = ${fmt$(t.notional)}<span class="badge">${t.order_type}</span><span class="badge">${t.session}</span></span>
      ${t.reason ? `<span class="why">${esc(t.reason)}</span>` : ''}</div>`).join('')}</details>`;
  }).join('');
}

function chips() {
  const list = mode === 'day'
    ? E.daily.map(d => ({k: d.date, lab: dLabel(d.date).replace(/^\w+ /, ''), pnl: d.pnl}))
    : weeks.map(w => { const ds = E.daily.filter(d => w.ds.includes(d.date)); const pnl = ds.reduce((a, d) => a + d.pnl, 0);
        const a = dparts(w.ds[0]), b = dparts(w.ds[w.ds.length-1]); return {k: w.k, lab: `${MON[a.m-1]} ${a.dd}–${b.dd}`, pnl}; });
  $('#chips').innerHTML = list.map(c => `<button class="chip ${c.k===sel?'on':''}" data-k="${c.k}">${c.lab}<small class="${cls(c.pnl)}">${c.pnl>=0?'+':'−'}${Math.abs(c.pnl).toFixed(2)}</small></button>`).join('');
  $('#chips').querySelectorAll('.chip').forEach(b => b.onclick = () => { sel = b.dataset.k; chips(); build(); restart(); });
  const on = $('#chips .on'); if (on) on.scrollIntoView({inline: 'center', block: 'nearest'});
}

// ---- series ---------------------------------------------------------------
const WK0 = 8 * 60 + 30, WK1 = 16 * 60;
function build() {
  const dates = mode === 'day' ? [sel] : weeks.find(w => w.k === sel).ds;
  series = []; marks = [];
  dates.forEach((d, i) => {
    const day = E.daily.find(x => x.date === d);
    const pts = E.points.filter(q => q.t.startsWith(d));
    const tr = T.filter(t => t.date === d);
    const first = Math.min(570, ...pts.map(q => mins(q.t)), ...tr.map(t => mins(t.time)));
    const X = m => mode === 'day' ? m : i + (Math.max(WK0, Math.min(WK1, m)) - WK0) / (WK1 - WK0);
    series.push({x: X(first), v: day.open, t: d, m: first});
    pts.forEach(q => series.push({x: X(mins(q.t)), v: q.v, t: d, m: mins(q.t)}));
    tr.forEach(t => marks.push({x: X(mins(t.time) + (+t.time.slice(17,19) || 0) / 60), t}));
  });
  series.sort((a, b) => a.x - b.x);
  if (mode === 'day') { x0 = series[0].x; x1 = Math.max(960, series[series.length-1].x); }
  else { x0 = 0; x1 = dates.length; }
  marks.forEach(mk => { mk.v = valAt(mk.x); mk.rev = 0; });
  base = series[0].v;
  const vs = series.map(s => s.v).concat(base);
  const lo = Math.min(...vs), hi = Math.max(...vs), pad = Math.max((hi - lo) * 0.18, 0.15);
  yMin = lo - pad; yMax = hi + pad;
  pinned = null; hideCall();
}
function valAt(x) {
  if (x <= series[0].x) return series[0].v;
  for (let i = 1; i < series.length; i++) if (series[i].x >= x) {
    // equity snapshots are step-like between runs; interpolate gently
    const a = series[i-1], b = series[i], f = (x - a.x) / ((b.x - a.x) || 1); return a.v + (b.v - a.v) * f;
  }
  return series[series.length-1].v;
}
function infoAt(x) {
  x = Math.min(x, x1 - 1e-6);
  let s = series[0]; for (const q of series) { if (q.x <= x) s = q; else break; }
  let minute; if (mode === 'day') minute = x; else { const f = x - Math.floor(x); minute = WK0 + f * (WK1 - WK0); }
  return {date: s.t, minute: Math.min(minute, 960)};
}

// ---- drawing -------------------------------------------------------------
function resize() {
  DPR = Math.min(devicePixelRatio || 1, 2);
  W = wrap.clientWidth; H = wrap.clientHeight;
  cv.width = W * DPR; cv.height = H * DPR; ctx.setTransform(DPR, 0, 0, DPR, 0, 0); draw(true);
}
const sx = x => PAD.l + (x - x0) / (x1 - x0) * (W - PAD.l - PAD.r);
const sy = v => PAD.t + (1 - (v - yMin) / (yMax - yMin)) * (H - PAD.t - PAD.b);
const ease = t => 1 + 2.7 * Math.pow(t - 1, 3) + 1.7 * Math.pow(t - 1, 2);

function draw(stat) {
  if (!series.length || !W) return;
  const now = performance.now();
  ctx.clearRect(0, 0, W, H);
  // grid
  ctx.font = '11px ui-sans-serif,system-ui'; ctx.textBaseline = 'middle';
  const step = niceStep((yMax - yMin) / 4);
  for (let v = Math.ceil(yMin / step) * step; v <= yMax; v += step) {
    const y = sy(v); ctx.strokeStyle = '#ffffff0d'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(PAD.l, y); ctx.lineTo(W - PAD.r, y); ctx.stroke();
    ctx.fillStyle = '#6b7590'; ctx.textAlign = 'left'; ctx.fillText('$' + v.toFixed(step < 0.1 ? 2 : step < 1 ? 1 : 0), W - PAD.r + 8, y);
  }
  // x labels
  ctx.textAlign = 'center'; ctx.fillStyle = '#6b7590'; ctx.textBaseline = 'alphabetic';
  if (mode === 'day') { for (let m = 600; m <= 960; m += 120) ctx.fillText(hm(m).replace(':00',''), sx(m), H - 6); }
  else { const ds = weeks.find(w => w.k === sel).ds; ds.forEach((d, i) => { ctx.fillText(DOW[dparts(d).dow], sx(i + 0.5), H - 6); if (i) { ctx.strokeStyle = '#ffffff10'; ctx.setLineDash([2,4]); ctx.beginPath(); ctx.moveTo(sx(i), PAD.t); ctx.lineTo(sx(i), H - PAD.b); ctx.stroke(); ctx.setLineDash([]); } }); }
  // baseline
  const by = sy(base); ctx.strokeStyle = '#ffffff30'; ctx.setLineDash([4, 5]); ctx.beginPath(); ctx.moveTo(PAD.l, by); ctx.lineTo(W - PAD.r, by); ctx.stroke(); ctx.setLineDash([]);
  ctx.fillStyle = '#8a94a8'; ctx.textAlign = 'left'; ctx.textBaseline = 'bottom'; ctx.fillText(mode === 'day' ? 'open' : 'week open', PAD.l + 2, by - 3);

  const xp = x0 + p * (x1 - x0);
  const vis = series.filter(s => s.x <= xp); const vp = valAt(xp);
  if (vis.length) {
    const up = vp >= base, col = up ? '#34d399' : '#fb7185';
    const path = new Path2D(); vis.forEach((s, i) => i ? path.lineTo(sx(s.x), sy(s.v)) : path.moveTo(sx(s.x), sy(s.v))); path.lineTo(sx(xp), sy(vp));
    // area
    const area = new Path2D(path); area.lineTo(sx(xp), H - PAD.b); area.lineTo(sx(vis[0].x), H - PAD.b); area.closePath();
    const g = ctx.createLinearGradient(0, PAD.t, 0, H - PAD.b); g.addColorStop(0, up ? '#34d39940' : '#fb718540'); g.addColorStop(1, '#00000000');
    ctx.fillStyle = g; ctx.fill(area);
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    ctx.shadowColor = col; ctx.shadowBlur = 14; ctx.strokeStyle = col; ctx.lineWidth = 2.4; ctx.stroke(path); ctx.shadowBlur = 0;
    // head
    const hx = sx(xp), hy = sy(vp);
    if (p < 1 || playing) {
      ctx.strokeStyle = '#ffffff22'; ctx.beginPath(); ctx.moveTo(hx, PAD.t); ctx.lineTo(hx, H - PAD.b); ctx.stroke();
      const r = 5 + 2 * Math.sin(now / 160); ctx.fillStyle = col + '44'; ctx.beginPath(); ctx.arc(hx, hy, r + 5, 0, 7); ctx.fill();
    }
    ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(hx, hy, 3.6, 0, 7); ctx.fill();
  }
  // markers
  let latest = null;
  marks.forEach(mk => {
    if (mk.x > xp) { mk.rev = 0; return; }
    if (!mk.rev) mk.rev = (playing && !stat) ? now : now - 1000;
    const k = Math.min(1, (now - mk.rev) / 450), s = ease(k);
    const X = sx(mk.x), Y = sy(mk.v), buy = mk.t.side === 'buy', col = mk.t.symbol === 'TQQQ' ? '#22d3ee' : '#c084fc';
    mk.sx = X; mk.sy = Y;
    if (k < 1) { ctx.strokeStyle = col; ctx.globalAlpha = 1 - k; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(X, Y, 6 + 22 * k, 0, 7); ctx.stroke(); ctx.globalAlpha = 1; }
    const sz = 7 * s, oy = buy ? 13 : -13;
    ctx.save(); ctx.translate(X, Y + oy); ctx.fillStyle = col; ctx.shadowColor = col; ctx.shadowBlur = pinned === mk ? 18 : 8;
    ctx.beginPath(); if (buy) { ctx.moveTo(0, -sz); ctx.lineTo(sz, sz * .8); ctx.lineTo(-sz, sz * .8); } else { ctx.moveTo(0, sz); ctx.lineTo(sz, -sz * .8); ctx.lineTo(-sz, -sz * .8); } ctx.closePath(); ctx.fill(); ctx.restore();
    ctx.fillStyle = col; ctx.beginPath(); ctx.arc(X, Y, 2.6, 0, 7); ctx.fill();
    mk.hy = Y + oy;
    latest = mk;
  });
  // readout
  const inf = infoAt(xp);
  $('#rtime').textContent = `${dLabel(inf.date)} · ${hm(inf.minute)} ET`;
  $('#rvalue').textContent = fmt$(vp);
  const dv = vp - base; $('#rdelta').innerHTML = `<span class="${cls(dv)}">${sign$(dv)} (${signP(dv / base * 100)})</span> <span class="rv">vs ${mode === 'day' ? 'day' : 'week'} open</span>`;
  $('#scrub').value = Math.round(p * 1000); $('#scrub').style.setProperty('--p', (p * 100) + '%');
  // callout
  if (pinned) showCall(pinned);
  else if (playing && latest && latest !== shown) { shown = latest; shownAt = now; showCall(latest); }
  else if (playing && shown && now - shownAt > 2600) hideCall();
}
function niceStep(r) { const e = Math.pow(10, Math.floor(Math.log10(r))), f = r / e; return (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * e; }

function showCall(mk) {
  const t = mk.t, tq = t.symbol === 'TQQQ';
  call.innerHTML = `<div class="h"><span class="tag ${tq?'tq-bg':'sq-bg'}">${t.symbol}</span><span class="${t.side==='buy'?'pos':'neg'}">${t.side.toUpperCase()}</span><span style="margin-left:auto;color:var(--mut);font-weight:500;font-size:12px">${hm(mins(t.time))} ET</span></div>
    <div class="meta">${t.shares} sh @ ${fmt$(t.price)} · ${fmt$(t.notional)} · ${t.order_type}, ${t.session}</div>
    <div class="why">${esc(t.reason || 'No note recorded.')}</div>`;
  const cw = call.offsetWidth || 260, ch = call.offsetHeight || 120;
  let left = mk.sx - cw / 2; left = Math.max(6, Math.min(W - cw - 6, left));
  let top = mk.sy - ch - 22; if (top < 4) top = Math.min(H - ch - 4, mk.sy + 24);
  call.style.left = left + 'px'; call.style.top = top + 'px'; call.classList.add('show');
}
function hideCall() { call.classList.remove('show'); shown = null; }

function tap(e) {
  const r = cv.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
  let best = null, bd = 30;
  marks.forEach(mk => { if (mk.sx == null || mk.x > x0 + p * (x1 - x0)) return; const d = Math.min(Math.hypot(mk.sx - x, mk.sy - y), Math.hypot(mk.sx - x, mk.hy - y)); if (d < bd) { bd = d; best = mk; } });
  if (best) { pause(); pinned = best; draw(true); } else if (pinned) { pinned = null; hideCall(); draw(true); }
}

function play() { playing = true; pinned = null; last = performance.now(); setIcon(); }
function pause() { playing = false; setIcon(); }
function restart() { p = 0; marks.forEach(m => m.rev = 0); hideCall(); play(); }
function setIcon() { $('#playIcon').innerHTML = playing ? '<path d="M7 5h4v14H7zM13 5h4v14h-4z"/>' : '<path d="M8 5v14l11-7z"/>'; $('#play').setAttribute('aria-label', playing ? 'Pause replay' : 'Play replay'); }
function loop(now) {
  if (playing) {
    const dur = (mode === 'day' ? 10000 : 18000) / speed;
    p = Math.min(1, p + (now - last) / dur); last = now;
    if (p >= 1) { pause(); setTimeout(() => { if (!playing && !pinned) hideCall(); }, 2500); }
    draw(false);
  } else if (marks.some(m => m.rev && now - m.rev < 500)) draw(false);
  requestAnimationFrame(loop);
}
})();

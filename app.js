(() => {
const $ = s => document.querySelector(s);
const fmt$ = v => '$' + v.toFixed(2);
const sign$ = v => (v >= 0 ? '+' : '\u2212') + '$' + Math.abs(v).toFixed(2);
const signP = v => (v >= 0 ? '+' : '\u2212') + Math.abs(v).toFixed(2) + '%';
const signP1 = v => (v >= 0 ? '+' : '\u2212') + Math.abs(v).toFixed(1) + '%';
const cls = v => v >= 0 ? 'pos' : 'neg';
const DOW = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const DOWL = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
const MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const dparts = d => { const [y,m,dd] = d.split('-').map(Number); return {y,m,dd,dow:new Date(Date.UTC(y,m-1,dd)).getUTCDay()}; };
const dLabel = d => { const p = dparts(d); return `${DOW[p.dow]} ${MON[p.m-1]} ${p.dd}`; };
const mins = t => +t.slice(11,13) * 60 + +t.slice(14,16);
const hm = m => { const h = Math.floor(m/60), mm = Math.round(m%60); return `${((h+11)%12)+1}:${String(mm).padStart(2,'0')} ${h<12?'am':'pm'}`; };
const hmShort = m => hm(m).replace(':00','').replace(' am','a').replace(' pm','p');
const esc = s => String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const dur = m => m < 60 ? `${m} min` : `${Math.floor(m/60)} hr${m%60 ? ' ' + (m%60) + ' min' : ''}`;
const symTag = s => `<span class="sym ${s==='TQQQ'?'tq':'sq'}">${s}</span>`;
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

let E, T, R = [], OPEN = [], NEWS = {}, mode = 'day', sel = null, weeks = [];
let series = [], marks = [], x0 = 0, x1 = 1, yMin = 0, yMax = 1, base = 100;
let p = 1, playing = false, last = 0, speedIdx = 0, active = -1, hold = 0, nextMark = 0, tradeDates = [];
const SPEEDS = [1, 2, 4];
const DAY_MS = 22000, WEEK_MS = 34000, HOLD_MS = 4200, HOLD_CLOSE_MS = 2600;
const cv = $('#chart'), ctx = cv.getContext('2d'), wrap = $('#chartWrap');
let W = 0, H = 0, DPR = 1, C = {};
const PAD = {l: 4, r: 52, t: 22, b: 28};

Promise.all([fetch('/data/equity.json').then(r => r.json()), fetch('/data/trades.json').then(r => r.json())])
  .then(([e, t]) => { E = e; T = t.trades; R = t.round_trips || []; OPEN = t.open_positions || []; NEWS = t.news || {}; init(); })
  .catch(err => { $('#verdict').textContent = 'Data unavailable right now.'; console.error(err); });

function init() {
  C = {ink: css('--ink'), mute: css('--mute'), rule: css('--rule'), hair: css('--hair'), paper: css('--paper'), tq: css('--tq'), sq: css('--sq'), up: css('--up'), dn: css('--dn')};
  headline();
  $('#gen').textContent = `Data updated ${dLabel(E.generated_at.slice(0,10))}. ${E.stats.trades} trades over ${E.stats.trading_days} trading days.`;
  const byW = {};
  E.daily.forEach(d => { const q = dparts(d.date); const mon = new Date(Date.UTC(q.y,q.m-1,q.dd - ((q.dow+6)%7))); const k = mon.toISOString().slice(0,10); (byW[k] = byW[k] || []).push(d.date); });
  weeks = Object.entries(byW).sort().map(([k, ds]) => ({k, ds}));
  soFar(); stats(); table(); bars(); dayList();
  sel = E.daily[E.daily.length-1].date;
  chips(); build();
  addEventListener('resize', resize); resize();
  document.querySelectorAll('.replay .seg button').forEach(b => b.onclick = () => {
    document.querySelectorAll('.replay .seg button').forEach(x => { const on = x === b; x.classList.toggle('on', on); x.setAttribute('aria-pressed', on); });
    mode = b.dataset.mode; sel = mode === 'day' ? E.daily[E.daily.length-1].date : weeks[weeks.length-1].k;
    chips(); build(); restart();
  });
  $('#play').onclick = () => { if (playing) pause(); else { if (p >= 1) { rewind(); } play(); } };
  $('#speed').onclick = () => { speedIdx = (speedIdx + 1) % SPEEDS.length; $('#speed').textContent = SPEEDS[speedIdx] + '\u00d7'; };
  $('#scrub').oninput = e => { pause(); p = e.target.value / 1000; hold = 0; syncActive(); draw(); };
  $('#tprev').onclick = () => step(-1);
  $('#tnext').onclick = () => step(1);
  cv.addEventListener('click', tap);
  requestAnimationFrame(loop);
  if (!reduced) setTimeout(restart, 600); else { p = 1; syncActive(true); draw(); }
}

function headline() {
  const up = E.total_pnl >= 0, d = E.daily[E.daily.length-1];
  $('#value').textContent = fmt$(E.current_value);
  $('#verdict').innerHTML = `<span class="${cls(E.total_pnl)}">${up ? 'Up' : 'Down'} ${fmt$(Math.abs(E.total_pnl))}</span> since it started with ${fmt$(E.starting_capital)}`;
  const today = d.pnl > 0.005 ? `<span class="pos">up ${fmt$(d.pnl)}</span>` : d.pnl < -0.005 ? `<span class="neg">down ${fmt$(-d.pnl)}</span>` : 'about flat';
  $('#today').innerHTML = `${DOWL[dparts(d.date).dow]} ${MON[dparts(d.date).m-1]} ${dparts(d.date).dd}: ${today} over ${d.trades} trade${d.trades===1?'':'s'}`;
  $('#asof').textContent = E.as_of ? `Last checked ${hm(mins(E.as_of))} ET` : '';
}

// flat-to-flat positions: a position opens on the first buy and closes when the fund is fully sold
function positions() {
  const held = {}, out = []; let cur = {};
  T.forEach(t => {
    const s = t.symbol; held[s] = held[s] || 0;
    if (t.side === 'buy') { if (held[s] < 1e-5) cur[s] = {symbol: s, date: t.date, pnl: 0}; held[s] += t.shares; }
    else { held[s] -= t.shares; if (cur[s] && t.result) cur[s].pnl += t.result.pnl; if (held[s] < 1e-5 && cur[s]) { cur[s].end = t.date; out.push(cur[s]); cur[s] = null; held[s] = 0; } }
  });
  return out;
}
function soFar() {
  const d = E.daily[E.daily.length-1], pos = positions().filter(x => x.end === d.date);
  const w = pos.filter(x => x.pnl > 0).length, l = pos.length - w, up = E.total_pnl >= 0;
  const open = OPEN.length ? `It ended the day still holding ${OPEN.map(o => o.symbol).join(' and ')}.` : 'It ended the day holding nothing.';
  const day = `${DOWL[dparts(d.date).dow]}, ${MON[dparts(d.date).m-1]} ${dparts(d.date).dd}`;
  $('#sofar').innerHTML = `<b>So far:</b> after ${E.stats.trading_days} trading days the account is <span class="${cls(E.total_pnl)}">${up ? 'up' : 'down'} ${Math.abs(E.total_pnl_pct).toFixed(1)}%</span> from $100. `
    + `On ${day}, it ${d.pnl >= 0 ? 'gained' : 'lost'} ${fmt$(Math.abs(d.pnl))} (${signP1(d.pnl_pct)})`
    + (pos.length ? ` across ${pos.length} complete position${pos.length===1?'':'s'} (${w} winner${w===1?'':'s'}, ${l} loser${l===1?'':'s'}). ` : '. ')
    + `${open} It&rsquo;s early, and leveraged funds can give gains back fast.`;
}

function stats() {
  const s = E.stats, won = R.filter(r => r.pnl > 0).length;
  const best = R.reduce((a, r) => !a || r.pnl > a.pnl ? r : a, null), worst = R.reduce((a, r) => !a || r.pnl < a.pnl ? r : a, null);
  const rows = [
    ['Total profit', `<span class="${cls(E.total_pnl)}">${sign$(E.total_pnl)}</span> <span class="muted">(${signP(E.total_pnl_pct)})</span>`, 'Account value now minus the $100 it started with.'],
    ['Trades that made money', `${won} of ${R.length}`, 'Counted per sale: each sell is matched with the buys it closed out.'],
    ['Days that ended up', `${s.green_days} of ${s.trading_days}`, 'A day counts as up if the account closed higher than it opened.'],
    ['Best trade', best ? `<span class="pos">${sign$(best.pnl)}</span> ${symTag(best.symbol)} ${dLabel(best.date)}` : '\u2014', ''],
    ['Worst trade', worst ? `<span class="${cls(worst.pnl)}">${sign$(worst.pnl)}</span> ${symTag(worst.symbol)} ${dLabel(worst.date)}` : '\u2014', ''],
    ['Highest value so far', fmt$(s.max_value), ''],
  ];
  $('#stats').innerHTML = rows.map(([k,v,tip]) => `<div><dt>${k}${tip ? ` <button class="tip" type="button" aria-label="What this means" data-tip="${esc(tip)}">?</button>` : ''}</dt><dd>${v}</dd></div>`).join('');
  document.querySelectorAll('.tip').forEach(b => b.onclick = e => { e.stopPropagation(); const open = b.classList.toggle('open'); document.querySelectorAll('.tip.open').forEach(x => x !== b && x.classList.remove('open')); b.setAttribute('aria-expanded', open); });
  document.addEventListener('click', () => document.querySelectorAll('.tip.open').forEach(x => x.classList.remove('open')));
}

// ---- best & worst ---------------------------------------------------------
let sortK = 'pnl', sortDir = -1, filt = 'all';
function newsList(items, cap) {
  if (!items || !items.length) return '';
  return `<ul class="news">${items.slice(0, cap || 99).map(n => `<li><span class="nt">${esc(n.time || '')}</span> ${esc(n.text)}${n.impact ? ` <span class="imp ${n.impact}">${n.impact === 'good' ? 'good for Nasdaq' : n.impact === 'bad' ? 'bad for Nasdaq' : 'neutral'}</span>` : ''}</li>`).join('')}</ul>`;
}
// headlines the bot logged with a trade (structured "logged.news"), with links when it saved one
function loggedList(items) {
  if (!items || !items.length) return '';
  return `<ul class="news market">${items.map(n => `<li>${n.url ? `<a href="${esc(n.url)}" target="_blank" rel="noopener">${esc(n.headline)}</a>` : esc(n.headline)} <span class="src">${esc(n.source)}</span></li>`).join('')}</ul>`;
}
function tradeNews(t) {
  if (t.logged && t.logged.news) return loggedList(t.logged.news);
  return newsList(t.news);
}
function signalsList(t) {
  const s = t.logged && t.logged.signals; if (!s) return '';
  return `<p class="muted small">Signals: ${Object.entries(s).map(([k, v]) => `${esc(k)} ${esc(v)}`).join(', ')}</p>`;
}
function table() {
  const byN = Object.fromEntries(T.map(t => [t.n, t]));
  let rows = R.slice();
  if (filt === 'best') rows = rows.filter(r => r.pnl > 0).sort((a, b) => b.pnl - a.pnl).slice(0, 5);
  else if (filt === 'worst') rows = rows.filter(r => r.pnl < 0).sort((a, b) => a.pnl - b.pnl).slice(0, 5);
  else {
    const key = {pnl: r => r.pnl, pct: r => r.pnl_pct, date: r => r.exit_time, hold: r => r.hold_min, sym: r => r.symbol}[sortK];
    rows.sort((a, b) => { const x = key(a), y = key(b); return (x < y ? -1 : x > y ? 1 : 0) * sortDir; });
  }
  document.querySelectorAll('#rtFilter button').forEach(b => { const on = b.dataset.f === filt; b.classList.toggle('on', on); b.setAttribute('aria-pressed', on); });
  document.querySelectorAll('#rtSort button').forEach(b => { const on = filt === 'all' && b.dataset.k === sortK; b.classList.toggle('on', on); b.setAttribute('aria-pressed', on); b.querySelector('i').textContent = on ? (sortDir < 0 ? '\u2193' : '\u2191') : ''; b.disabled = filt !== 'all'; });
  $('#rtList').innerHTML = rows.map(r => {
    const ent = byN[r.entry_n[0]], ex = byN[r.exit_n[0]];
    return `<details class="rt"><summary>
      <span class="rt-main">${symTag(r.symbol)} <span class="rt-when">${dLabel(r.date)}, ${hm(mins(r.entry_time))}\u2013${hm(mins(r.exit_time))}</span></span>
      <span class="rt-hold">${dur(r.hold_min)}</span>
      <span class="rt-pct ${cls(r.pnl)}">${signP1(r.pnl_pct)}</span>
      <span class="rt-pnl ${cls(r.pnl)}">${sign$(r.pnl)}</span></summary>
      <div class="rt-body">
        <p class="rt-facts">Put in ${fmt$(r.cost)}, got back ${fmt$(r.proceeds)}. Held ${dur(r.hold_min)}.</p>
        <div class="rt-why"><div><h4>Why it bought</h4><p>${esc(ent ? ent.why : '')}</p></div><div><h4>Why it sold</h4><p>${esc(ex.why)}</p></div></div>
        ${ent && ((ent.news && ent.news.length) || (ent.logged && ent.logged.news)) ? `<h4>News the bot had read when it bought</h4>${tradeNews(ent)}` : ''}
        ${(ex.news && ex.news.length) || (ex.logged && ex.logged.news) ? `<h4>News the bot had read when it sold</h4>${tradeNews(ex)}` : ''}
        <details class="raw"><summary>Details</summary><p>Buy note: ${esc(ent ? ent.details : '')}</p><p>Sell note: ${esc(ex.details)}</p></details>
      </div></details>`;
  }).join('') || '<p class="muted">No finished trades yet.</p>';
  $('#rtOpen').innerHTML = OPEN.length
    ? `<strong>Still holding:</strong> ` + OPEN.map(o => `${o.shares} ${symTag(o.symbol)} bought for ${fmt$(o.cost)} (avg ${fmt$(o.avg_price)})`).join('; ') + '. Not counted above until sold.'
    : 'No open positions right now: everything has been sold, so every result above is final.';
}
function wireTable() {
  document.querySelectorAll('#rtFilter button').forEach(b => b.onclick = () => { filt = b.dataset.f; table(); });
  document.querySelectorAll('#rtSort button').forEach(b => b.onclick = () => { if (sortK === b.dataset.k) sortDir *= -1; else { sortK = b.dataset.k; sortDir = (sortK === 'sym' || sortK === 'date') ? 1 : -1; } table(); });
}
wireTable();

function bars() {
  const mx = Math.max(...E.daily.map(d => Math.abs(d.pnl)), 0.01);
  $('#bars').innerHTML = E.daily.slice().reverse().map(d => {
    const w = Math.abs(d.pnl) / mx * 50, pos = d.pnl >= 0;
    return `<div class="bar"><span>${dLabel(d.date)}</span><div class="track"><div class="mid"></div><div class="fill" style="${pos?'left:50%':'right:50%'};width:${w}%;background:${pos?'var(--up)':'var(--dn)'}"></div></div><span class="amt ${cls(d.pnl)}">${sign$(d.pnl)}</span></div>`;
  }).join('');
}

function dayList() {
  $('#days').innerHTML = E.daily.slice().reverse().map((d, i) => {
    const ts = T.filter(t => t.date === d.date).slice().reverse(), nw = NEWS[d.date] || {};
    const bot = nw.bot || [];
    return `<details class="day" ${i === 0 ? 'open' : ''}><summary><span class="d">${dLabel(d.date)}</span><span class="s">${ts.length} trade${ts.length===1?'':'s'}, <span class="${cls(d.pnl)}">${sign$(d.pnl)}</span></span></summary>
    ${ts.map(t => `<div class="tr"><span class="t">${hm(mins(t.time))}</span><span class="what">${t.side === 'buy' ? 'Bought' : 'Sold'} ${symTag(t.symbol)}</span>
      <span class="num">${fmt$(t.notional)}${t.result ? ` <b class="${cls(t.result.pnl)}">${sign$(t.result.pnl)}</b>` : ''}<em>${+t.shares.toFixed(4)} sh at ${fmt$(t.price)}${t.session === 'pre-market' ? ', pre-market' : ''}</em></span>
      <span class="note">${esc(t.why || t.details || '')}${t.details ? ` <details class="raw inline"><summary>Details</summary>${esc(t.details)}</details>` : ''}</span></div>`).join('')}
    <div class="daynews">
      ${bot.length ? `<details class="botnews"><summary>News the bot cited in its research (${bot.length})</summary>${newsList(bot)}</details>` : '<p class="muted small">The bot kept no research notes this day.</p>'}
    </div></details>`;
  }).join('');
}

function chips() {
  const list = mode === 'day'
    ? E.daily.map(d => ({k: d.date, lab: dLabel(d.date).replace(/^\w+ /, ''), pnl: d.pnl}))
    : weeks.map(w => { const ds = E.daily.filter(d => w.ds.includes(d.date)); const pnl = ds.reduce((a, d) => a + d.pnl, 0);
        const a = dparts(w.ds[0]), b = dparts(w.ds[w.ds.length-1]); return {k: w.k, lab: `${MON[a.m-1]} ${a.dd}\u2013${b.dd}`, pnl}; });
  $('#chips').innerHTML = list.map(c => `<button class="${c.k===sel?'on':''}" data-k="${c.k}" aria-pressed="${c.k===sel}">${c.lab}<small class="${cls(c.pnl)}">${c.pnl>=0?'+':'\u2212'}${Math.abs(c.pnl).toFixed(2)}</small></button>`).join('');
  $('#chips').querySelectorAll('button').forEach(b => b.onclick = () => { sel = b.dataset.k; chips(); build(); restart(); });
  const on = $('#chips .on'); if (on) { const box = $('#chips'); box.scrollLeft = on.offsetLeft - box.clientWidth / 2 + on.clientWidth / 2; }
}

// ---- series ---------------------------------------------------------------
const WK0 = 8 * 60 + 30, WK1 = 16 * 60;
function build() {
  const dates = mode === 'day' ? [sel] : weeks.find(w => w.k === sel).ds;
  tradeDates = dates;
  series = []; marks = [];
  dates.forEach((d, i) => {
    const day = E.daily.find(x => x.date === d);
    const pts = E.points.filter(q => q.t.startsWith(d));
    const tr = T.filter(t => t.date === d);
    const first = Math.min(570, ...pts.map(q => mins(q.t)), ...tr.map(t => mins(t.time)));
    const X = m => mode === 'day' ? m : i + (Math.max(WK0, Math.min(WK1, m)) - WK0) / (WK1 - WK0);
    series.push({x: X(first), v: day.open, t: d, m: first});
    pts.forEach(q => series.push({x: X(mins(q.t)), v: q.v, t: d, m: mins(q.t)}));
    tr.forEach(t => marks.push({x: X(mins(t.time) + (+t.time.slice(17,19) || 0) / 60), t, dx: 0}));
  });
  series.sort((a, b) => a.x - b.x);
  marks.sort((a, b) => a.x - b.x);
  if (mode === 'day') { x0 = series[0].x; x1 = Math.max(960, series[series.length-1].x); }
  else { x0 = 0; x1 = dates.length; }
  marks.forEach((mk, i) => { mk.v = valAt(mk.x); mk.i = i; mk.p = (mk.x - x0) / (x1 - x0); });
  base = series[0].v;
  const vs = series.map(s => s.v).concat(base);
  const lo = Math.min(...vs), hi = Math.max(...vs), pad = Math.max((hi - lo) * 0.22, 0.2);
  yMin = lo - pad; yMax = hi + pad;
  active = -1; hold = 0; nextMark = 0; renderTrade();
}
function valAt(x) {
  if (x <= series[0].x) return series[0].v;
  for (let i = 1; i < series.length; i++) if (series[i].x >= x) {
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

// ---- trade panel (the only place trade details appear) --------------------
function renderTrade() {
  const n = marks.length;
  $('#tcount').textContent = n ? (active >= 0 ? `Trade ${active + 1} of ${n}` : `${n} trade${n === 1 ? '' : 's'} in this ${mode}`) : 'No trades';
  $('#tprev').disabled = active <= 0;
  $('#tnext').disabled = !n || active >= n - 1;
  const box = $('#tbody');
  if (active < 0) { box.innerHTML = `<p class="empty">${n ? 'Press play. The replay pauses at each trade and explains here what the bot did and why. You can also tap a marker on the chart, or use Next.' : 'The bot made no trades in this period.'}</p>`; return; }
  const t = marks[active].t, buy = t.side === 'buy';
  const res = t.result ? `<div><span>Result</span><b class="${cls(t.result.pnl)}">${sign$(t.result.pnl)} (${signP1(t.result.pnl_pct)})</b></div>` : '';
  box.innerHTML = `<div class="trade-head"><span class="trade-title">${buy ? 'Bought' : 'Sold'} ${symTag(t.symbol)}</span><span class="trade-when">${dLabel(t.date)}, ${hm(mins(t.time))} ET${t.session === 'pre-market' ? ', before the open' : ''}</span></div>
    <p class="why">${esc(t.why || 'No note was recorded for this trade.')}</p>
    <div class="facts"><div><span>Amount</span><b>${fmt$(t.notional)}</b></div><div><span>Price</span><b>${fmt$(t.price)}</b></div><div><span>Shares</span><b>${+t.shares.toFixed(4)}</b></div>${res}</div>
    ${(t.news && t.news.length) || (t.logged && t.logged.news) ? `<details class="raw"><summary>News the bot had read</summary>${tradeNews(t)}</details>` : ''}
    ${t.details ? `<details class="raw"><summary>Details</summary><p>${esc(t.details)}</p>${signalsList(t)}<p class="muted small">The bot's own note, lightly cleaned up. ${t.order_type} order, ${t.session} session.</p></details>` : ''}`;
}
function setActive(i) { if (i === active) return; active = i; renderTrade(); }
function syncActive(force) {
  const xp = x0 + p * (x1 - x0); let a = -1;
  marks.forEach((m, i) => { if (m.x <= xp + 1e-9) a = i; });
  nextMark = a + 1; if (a !== active || force) { active = -2; setActive(a); }
}
function step(d) {
  pause(); const n = marks.length; if (!n) return;
  const i = Math.max(0, Math.min(n - 1, (active < 0 ? (d > 0 ? 0 : 0) : active + d)));
  p = marks[i].p; hold = 0; nextMark = i + 1; setActive(i); draw();
}

// ---- drawing -------------------------------------------------------------
function resize() {
  DPR = Math.min(devicePixelRatio || 1, 2);
  W = wrap.clientWidth; H = wrap.clientHeight;
  cv.width = W * DPR; cv.height = H * DPR; ctx.setTransform(DPR, 0, 0, DPR, 0, 0); draw();
}
const sx = x => PAD.l + (x - x0) / (x1 - x0) * (W - PAD.l - PAD.r);
const sy = v => PAD.t + (1 - (v - yMin) / (yMax - yMin)) * (H - PAD.t - PAD.b);
const FONT = '12px "Hanken Grotesk",system-ui,sans-serif';

function tri(X, Y, size, buy, col) {
  ctx.fillStyle = col; ctx.beginPath();
  if (buy) { ctx.moveTo(X, Y - size); ctx.lineTo(X + size, Y + size * .75); ctx.lineTo(X - size, Y + size * .75); }
  else { ctx.moveTo(X, Y + size); ctx.lineTo(X + size, Y - size * .75); ctx.lineTo(X - size, Y - size * .75); }
  ctx.closePath(); ctx.fill();
}

function draw() {
  if (!series.length || !W) return;
  ctx.clearRect(0, 0, W, H);
  ctx.font = FONT;
  const step = niceStep((yMax - yMin) / 4);
  ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
  for (let v = Math.ceil(yMin / step) * step; v <= yMax; v += step) {
    const y = sy(v); ctx.strokeStyle = C.hair; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(PAD.l, y); ctx.lineTo(W - PAD.r, y); ctx.stroke();
    ctx.fillStyle = C.mute; ctx.fillText('$' + v.toFixed(step < 0.1 ? 2 : step < 1 ? 1 : 0), W - PAD.r + 8, y);
  }
  ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic'; ctx.fillStyle = C.mute;
  if (mode === 'day') { for (let m = 600; m <= 960; m += 120) ctx.fillText(hmShort(m), sx(m), H - 8); }
  else { tradeDates.forEach((d, i) => { ctx.fillText(DOW[dparts(d).dow], sx(i + 0.5), H - 8); if (i) { ctx.strokeStyle = C.rule; ctx.setLineDash([2, 4]); ctx.beginPath(); ctx.moveTo(sx(i), PAD.t); ctx.lineTo(sx(i), H - PAD.b); ctx.stroke(); ctx.setLineDash([]); } }); }
  const by = sy(base); ctx.strokeStyle = C.mute; ctx.lineWidth = 1; ctx.setLineDash([3, 4]); ctx.beginPath(); ctx.moveTo(PAD.l, by); ctx.lineTo(W - PAD.r, by); ctx.stroke(); ctx.setLineDash([]);
  ctx.fillStyle = C.mute; ctx.textAlign = 'left'; ctx.textBaseline = 'bottom'; ctx.fillText(mode === 'day' ? 'Day open' : 'Week open', PAD.l + 2, by - 4);

  const xp = x0 + p * (x1 - x0), vis = series.filter(s => s.x <= xp), vp = valAt(xp);
  if (vis.length) {
    const path = new Path2D(); vis.forEach((s, i) => i ? path.lineTo(sx(s.x), sy(s.v)) : path.moveTo(sx(s.x), sy(s.v))); path.lineTo(sx(xp), sy(vp));
    ctx.lineJoin = 'round'; ctx.lineCap = 'round'; ctx.strokeStyle = C.ink; ctx.lineWidth = 2; ctx.stroke(path);
  }
  // markers: small, never covered by any overlay
  let prev = null;
  marks.forEach(mk => {
    mk.sx = sx(mk.x); mk.sy = sy(mk.v);
    mk.dx = (prev && Math.abs(prev.sx - mk.sx) < 9 && prev.t.side === mk.t.side) ? prev.dx + 9 : 0; prev = mk;
    mk.dxx = mk.sx + mk.dx;
    if (mk.x > xp + 1e-9) { mk.shown = false; return; }
    const age = mk.born ? Math.min(1, (performance.now() - mk.born) / 220) : 1;
    mk.shown = true;
    const buy = mk.t.side === 'buy', col = mk.t.symbol === 'TQQQ' ? C.tq : C.sq, oy = buy ? 12 : -12, on = mk.i === active;
    mk.my = mk.sy + oy;
    ctx.strokeStyle = col; ctx.globalAlpha = .45; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(mk.sx, mk.sy); ctx.lineTo(mk.dxx, mk.my); ctx.stroke(); ctx.globalAlpha = 1;
    tri(mk.dxx, mk.my, (on ? 8 : 5.5) * (0.4 + 0.6 * age), buy, col);
    if (on) { ctx.strokeStyle = C.ink; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(mk.sx, mk.sy, 6, 0, 7); ctx.stroke(); }
  });
  if (vis.length) { ctx.fillStyle = C.ink; ctx.strokeStyle = C.paper; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(sx(xp), sy(vp), 4.5, 0, 7); ctx.fill(); ctx.stroke(); }

  const inf = infoAt(xp);
  $('#rtime').textContent = `${dLabel(inf.date)}, ${hm(inf.minute)} ET`;
  $('#rvalue').textContent = fmt$(vp);
  const dv = vp - base; $('#rdelta').innerHTML = `<span class="${cls(dv)}">${sign$(dv)} (${signP(dv / base * 100)})</span> <span class="muted" style="font-weight:400">since ${mode === 'day' ? 'the open' : 'the week began'}</span>`;
  $('#scrub').value = Math.round(p * 1000); $('#scrub').style.setProperty('--p', (p * 100) + '%');
}
function niceStep(r) { const e = Math.pow(10, Math.floor(Math.log10(r))), f = r / e; return (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * e; }

function tap(e) {
  const r = cv.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
  const xp = x0 + p * (x1 - x0); let best = -1, bd = 26;
  marks.forEach(mk => { if (!mk.shown) return; const d = Math.min(Math.hypot(mk.dxx - x, mk.my - y), Math.hypot(mk.sx - x, mk.sy - y)); if (d < bd) { bd = d; best = mk.i; } });
  if (best >= 0) { pause(); hold = 0; nextMark = best + 1; setActive(best); draw(); }
}

function play() { playing = true; last = performance.now(); setIcon(); }
function pause() { playing = false; setIcon(); }
function rewind() { p = 0; hold = 0; nextMark = 0; marks.forEach(m => m.born = 0); setActive(-1); }
function restart() { rewind(); play(); }
function setIcon() { $('#playIcon').setAttribute('d', playing ? 'M7 5h4v14H7zM13 5h4v14h-4z' : 'M8 5v14l11-7z'); $('#play').setAttribute('aria-label', playing ? 'Pause replay' : 'Play replay'); }

function loop(now) {
  if (playing) {
    const dt = Math.min(now - last, 100); last = now;
    const sp = SPEEDS[speedIdx];
    if (hold > 0) { hold -= dt * sp; if (hold <= 0) hold = 0; }
    else {
      const dur = mode === 'day' ? DAY_MS : WEEK_MS;
      let np = Math.min(1, p + dt * sp / dur);
      const mk = marks[nextMark];
      if (mk && np >= mk.p) {
        np = mk.p; mk.born = now; setActive(mk.i); nextMark++;
        const nxt = marks[nextMark]; const close = nxt && (nxt.p - mk.p) < (mode === 'day' ? 0.012 : 0.004);
        hold = close ? HOLD_CLOSE_MS : HOLD_MS;
      }
      p = np;
      if (p >= 1 && !hold) pause();
    }
    draw();
  } else if (marks.some(m => m.born && now - m.born < 240)) draw();
  requestAnimationFrame(loop);
}
})();

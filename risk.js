/* 침수 모드 덧붙임 — 사는 사람·병원 가는 길 끊김·해수면 상승 시나리오·지점 보고서·위성 사진 */
(function () {
  'use strict';
  let F, map;
  const R = { data: {}, slr: null, scn: null, satOn: false, satDate: null, isoOn: true };
  const SAT_DATES = ['20240904', '20240914', '20240924'];
  const SAT_BBOX = [[105.74, 20.95], [105.92, 21.10]];

  /* ---------------- 자료 ---------------- */
  async function load(key) {
    if (R.data[key]) return R.data[key];
    const get = (u, bin) => fetch(u).then(r => { if (!r.ok) throw 0; return bin ? r.arrayBuffer() : r.json(); });
    const [meta, pop, cut] = await Promise.all([get(`data/risk_${key}.json`), get(`data/risk_${key}_pop.bin`, 1), get(`data/risk_${key}_cut.bin`, 1)]);
    const D = { meta, pop: new Uint16Array(pop), cut: new Uint8Array(cut) };
    R.data[key] = D;
    return D;
  }
  const loadSlr = () => R.slr ? Promise.resolve(R.slr) : fetch('data/slr.json').then(r => r.json()).then(j => (R.slr = j)).catch(() => null);

  // 해발 1m 단위로 lv 이하 땅에 사는 사람(땅 점 비율로 나눈 값)
  function peopleBelow(key, lv) {
    const D = R.data[key]; if (!D) return null;
    let a = 0; for (let h = 1; h <= Math.floor(lv); h++) a += D.meta.popHist[h + 20] || 0;
    return a;
  }
  function cutPeople(key, lv) {
    const D = R.data[key]; if (!D) return null;
    const c = D.meta.cutPop; return c[Math.min(c.length - 1, Math.max(0, Math.floor(lv)))];
  }
  const compact = n => Number(n).toLocaleString(F.loc(), { notation: 'compact', maximumFractionDigits: n >= 1e4 && n < 1e5 ? 1 : n < 1e4 ? 0 : 1 });

  /* ---------------- 고립 지도 ---------------- */
  let isoCanvas;
  function setupIso() {
    if (map.getSource('iso')) return;
    isoCanvas = document.createElement('canvas'); isoCanvas.width = isoCanvas.height = 1;
    map.addSource('iso', { type: 'image', url: isoCanvas.toDataURL(), coordinates: [[0, 1], [1, 1], [1, 0], [0, 0]] });
    map.addLayer({ id: 'iso', type: 'raster', source: 'iso', paint: { 'raster-opacity': 0.85, 'raster-fade-duration': 0, 'raster-resampling': 'nearest' } }, 'bbox');
  }
  let isoKey = '';
  function drawIso(key, lv) {
    const D = R.data[key]; if (!D || !map.getSource('iso')) return;
    const fl = Math.floor(lv), k = key + ':' + fl;
    if (k === isoKey) return; isoKey = k;
    const g = D.meta.grid;
    isoCanvas.width = g.cols; isoCanvas.height = g.rows;
    const cx = isoCanvas.getContext('2d'), img = cx.createImageData(g.cols, g.rows), d = img.data;
    if (fl > 0) for (let i = 0; i < g.cols * g.rows; i++) {
      const p = D.pop[i]; if (!p) continue;
      const cl = D.cut[i * 2], med = D.cut[i * 2 + 1];
      if (cl <= fl && med > fl) { d[i * 4] = 240; d[i * 4 + 1] = 120; d[i * 4 + 2] = 20; d[i * 4 + 3] = 55 + 115 * Math.min(1, p / 300); }
    }
    cx.putImageData(img, 0, 0);
    const e = g.w + g.cols * g.dx, s = g.n - g.rows * g.dy;
    map.getSource('iso').updateImage({ url: isoCanvas.toDataURL(), coordinates: [[g.w, g.n], [e, g.n], [e, s], [g.w, s]] });
  }

  /* ---------------- 패널 숫자 ---------------- */
  function update() {
    const key = F.S.city, D = R.data[key];
    const box = F.$('#ppl'); if (!box) return;
    if (!D) { box.hidden = true; return; }
    box.hidden = false;
    const lv = F.S.lv, pw = peopleBelow(key, lv), pc = cutPeople(key, lv);
    F.tween(F.$('#kPop'), pw, 0);
    F.tween(F.$('#kIso'), pc, 0);
    F.$('#kPopOf').textContent = F.t('ofPop', { n: compact(D.meta.popTotal) });
    F.$('#ppIso').classList.toggle('off', !R.isoOn);
    drawIso(key, lv);
    if (map.getLayer('iso')) map.setLayoutProperty('iso', 'visibility', R.isoOn && F.S.mode === 'flood' ? 'visible' : 'none');
  }

  /* ---------------- 해수면 시나리오 ---------------- */
  const SCN = [['now'], ['ssp245', '2050'], ['ssp245', '2100'], ['ssp585', '2100']];
  function renderSlr() {
    const box = F.$('#slr'), key = F.S.city, L = F.S.live[key];
    const c = R.slr && R.slr.cities[key];
    if (!c || !L || !L.tide) { box.hidden = true; return; }
    box.hidden = false;
    F.$('#slrBtns').innerHTML = SCN.map((s, i) => `<button data-s="${i}" class="${R.scn === i ? 'on' : ''}">${F.esc(F.t(i === 0 ? 'slrNow' : 'slr' + s[1] + (s[0] === 'ssp585' ? 'h' : '')))}${i ? `<small>+${F.fmt(c[s[0]][s[1]][1], 2)}m</small>` : `<small>${F.fmt(L.tide.peak, 2)}m</small>`}</button>`).join('');
    F.$$('#slrBtns [data-s]').forEach(b => b.addEventListener('click', () => pickScn(+b.dataset.s)));
    note();
  }
  function note() {
    const el = F.$('#slrNote'), key = F.S.city, L = F.S.live[key], c = R.slr && R.slr.cities[key];
    if (R.scn == null || !c || !L || !L.tide) { el.textContent = F.t('slrLead'); return; }
    if (R.scn === 0) { el.textContent = F.t('slrNoteNow', { v: F.fmt(L.tide.peak, 2) }); return; }
    const [ssp, y] = SCN[R.scn], q = c[ssp][y];
    el.textContent = F.t('slrNote', { s: F.t(ssp === 'ssp585' ? 'sspH' : 'sspM'), y, m: F.fmt(q[1], 2), a: F.fmt(q[0], 2), b: F.fmt(q[2], 2), v: F.fmt(L.tide.peak, 2), lv: F.fmt(L.tide.peak + q[1], 2) });
  }
  function pickScn(i) {
    const key = F.S.city, L = F.S.live[key], c = R.slr.cities[key];
    R.scn = i;
    const to = i === 0 ? L.tide.peak : L.tide.peak + c[SCN[i][0]][SCN[i][1]][1];
    F.animateTo(Math.floor(to * 100) / 100, 1400);
    F.$$('#slrBtns [data-s]').forEach(b => b.classList.toggle('on', +b.dataset.s === i));
    note();
  }

  /* ---------------- 지점 보고서 ---------------- */
  function cellAt(key, lon, lat) {
    const D = R.data[key]; if (!D) return -1;
    const g = D.meta.grid, q = Math.floor((lon - g.w) / g.dx), r = Math.floor((g.n - lat) / g.dy);
    return q < 0 || r < 0 || q >= g.cols || r >= g.rows ? -1 : r * g.cols + q;
  }
  function popWithin(key, lon, lat, m) {
    const D = R.data[key]; if (!D) return null;
    const g = D.meta.grid, ky = 111320, kx = ky * Math.cos(lat * Math.PI / 180);
    const dq = Math.ceil(m / (g.dx * kx)), dr = Math.ceil(m / (g.dy * ky));
    const q0 = Math.floor((lon - g.w) / g.dx), r0 = Math.floor((g.n - lat) / g.dy);
    let s = 0, full = true;
    for (let r = r0 - dr; r <= r0 + dr; r++) for (let q = q0 - dq; q <= q0 + dq; q++) {
      const x = (g.w + (q + .5) * g.dx - lon) * kx, y = (g.n - (r + .5) * g.dy - lat) * ky;
      if (x * x + y * y > m * m) continue;
      if (q < 0 || r < 0 || q >= g.cols || r >= g.rows) { full = false; continue; }
      s += D.pop[r * g.cols + q];
    }
    return { n: s, full };
  }
  function nearest(key, pt, ty) {
    const D = F.S.data[key]; if (!D) return null;
    let best = null, bd = Infinity;
    D.pois.forEach(p => { if (p.t !== ty) return; const d = F.metersBetween(pt, p.c); if (d < bd) { bd = d; best = p; } });
    return best ? { p: best, d: bd } : null;
  }
  const dist = d => d < 1000 ? F.fmt(Math.round(d / 10) * 10, 0) + ' m' : F.fmt(d / 1000, 1) + ' km';

  async function report(pt) {
    const key = F.S.city, L = F.S.live[key] || {}, D = R.data[key], c = R.slr && R.slr.cities[key];
    const e = await F.elevAtAsync(pt[0], pt[1]);
    const ci = cellAt(key, pt[0], pt[1]);
    const cut = ci >= 0 && D ? D.cut[ci * 2] : 255, hasPop = ci >= 0 && D && D.pop[ci] > 0;
    const pw = popWithin(key, pt[0], pt[1], 1000);
    const rows = [];
    const row = (k, v, cls = '') => rows.push(`<div class="rp-row ${cls}"><dt>${F.esc(k)}</dt><dd>${v}</dd></div>`);
    // 높이 막대
    const lines = [];
    if (L.tide) lines.push([F.t('rpLnTide'), L.tide.peak, '#2f6fe4']);
    if (L.tide && c) lines.push([F.t('rpLn2100'), L.tide.peak + c.ssp585['2100'][1], '#7c3aed']);
    const bar = e != null && e > 0 ? elevBar(e, lines) : '';
    if (e == null) row(F.t('rpElev'), '–');
    else if (e <= 0) row(F.t('rpElev'), F.esc(F.t('rpWater')));
    else {
      row(F.t('rpElev'), `<b>${F.t('rpElevV', { e })}</b>`);
      if (L.tide) { const d = e - L.tide.peak; row(F.t('rpTide'), F.esc(F.t(d < 0 ? 'pBelow' : 'pAbove', { d: F.fmt(Math.abs(d), 1) })), d < 0 ? 'bad' : ''); }
      if (L.tide && c) { const d = e - (L.tide.peak + c.ssp585['2100'][1]); row(F.t('rpSlr'), F.esc(F.t(d < 0 ? 'rpDown' : 'rpUp', { d: F.fmt(Math.abs(d), 1) })), d < 0 ? 'bad' : ''); }
      row(F.t('rpWet'), F.esc(F.t('rpWetV', { e })));
      const mx = D ? D.meta.cutPop.length - 1 : 0;
      row(F.t('rpCut'), F.esc(!D || !hasPop ? F.t('rpCutNa') : cut === 255 ? F.t('rpCutNo', { m: mx }) : F.t('rpCutV', { l: cut })), cut !== 255 && hasPop && L.tide && cut <= L.tide.peak + 1 ? 'bad' : '');
    }
    if (pw) row(F.t('rpPop'), `<b>${F.fmt(Math.round(pw.n / 10) * 10, 0)}</b>${F.esc(F.t('people'))}${pw.full ? '' : ' <small>' + F.esc(F.t('rpPopEdge')) + '</small>'}`);
    const near = ['hospital', 'school', 'police'].map(ty => {
      const n = nearest(key, pt, ty); if (!n) return '';
      const tn = F.t(ty === 'hospital' ? 'tHospital' : ty === 'school' ? 'tSchool' : 'tPolice');
      return `<li><i class="dot ${ty}"></i><span class="rn">${F.esc(n.p.n || tn)}</span><span class="rd">${dist(n.d)} · ${F.esc(F.t('rpAsl', { e: n.p.e === 99 ? '?' : n.p.e }))}</span></li>`;
    }).join('');
    const now = new Date(Date.now() + 7 * 3600e3).toISOString().slice(0, 16).replace('T', ' ');
    const html = `
      <header class="rp-h"><div><small>CityLens · ${F.esc(F.t('city_' + key))}</small><h2>${F.esc(F.t('rpTitle'))}</h2><p>${pt[1].toFixed(5)}, ${pt[0].toFixed(5)}</p></div>
        <div class="rp-act"><button class="btn-dark sm" id="rpPrint">${F.esc(F.t('rpPrint'))}</button><button class="btn-line sm" id="rpClose" aria-label="close">${F.esc(F.t('rpClose'))}</button></div></header>
      <div class="rp-body"><dl class="rp-dl">${rows.join('')}</dl>${bar}</div>
      <h3>${F.esc(F.t('rpNear'))}</h3><ul class="rp-near">${near}</ul>
      <h3>${F.esc(F.t('rpClim'))}</h3><dl class="rp-dl rp-clim" id="rpClim"><div class="rp-row"><dt>…</dt><dd></dd></div></dl>
      <footer class="rp-f"><p>${F.esc(F.t('rpMade', { t: now }))}</p><p>${F.esc(F.t('rpSrcs'))}</p><p>${F.esc(F.t('rpNote'))}</p></footer>`;
    const wrap = F.$('#rp');
    wrap.querySelector('.rp').innerHTML = html;
    wrap.hidden = false; requestAnimationFrame(() => wrap.classList.add('in'));
    F.$('#rpClose').onclick = closeReport;
    F.$('#rpPrint').onclick = () => window.print();
    climAt(pt);
  }
  function closeReport() { const w = F.$('#rp'); w.classList.remove('in'); setTimeout(() => { w.hidden = true; }, F.MOTION ? 250 : 0); }
  function elevBar(e, lines) {
    const all = [e, ...lines.map(l => l[1])], top = Math.ceil(Math.max(...all) + 1), H = 150, y = v => H - 8 - v / top * (H - 22);
    let s = `<svg class="rp-bar" viewBox="0 0 200 ${H}" aria-hidden="true"><rect x="40" y="${y(e)}" width="46" height="${H - 8 - y(e)}" rx="3" fill="#c9b79c"/><text x="63" y="${y(e) - 6}" text-anchor="middle">${F.esc(F.t('rpLnGround', { e }))}</text>`;
    lines.forEach(([lab, v, col]) => { s += `<line x1="30" x2="196" y1="${y(v)}" y2="${y(v)}" stroke="${col}" stroke-width="2" stroke-dasharray="5 3"/><text x="196" y="${y(v) - 5}" text-anchor="end" fill="${col}">${F.esc(lab)} ${F.fmt(v, 2)}m</text>`; });
    return s + `<line x1="30" x2="196" y1="${H - 8}" y2="${H - 8}" stroke="#9aa3b2"/><text x="30" y="${H}" class="z">0m</text></svg>`;
  }
  async function climAt(pt) {
    const box = F.$('#rpClim'), tz = '&timezone=Asia%2FBangkok', today = F.vnNow().slice(0, 10);
    try {
      const [a, w] = await Promise.all([
        F.getJson(`https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${pt[1]}&longitude=${pt[0]}&hourly=pm2_5&forecast_days=1${tz}`),
        F.getJson(`https://api.open-meteo.com/v1/forecast?latitude=${pt[1]}&longitude=${pt[0]}&hourly=temperature_2m,relative_humidity_2m&forecast_days=1${tz}`)
      ]);
      const pm = a.hourly.pm2_5.filter((v, i) => v != null && a.hourly.time[i].startsWith(today));
      const avg = pm.reduce((s, v) => s + v, 0) / (pm.length || 1);
      const hi = Math.max(...w.hourly.temperature_2m.map((t, i) => w.hourly.time[i].startsWith(today) ? window.CL._heatIndex(t, w.hourly.relative_humidity_2m[i]) : -99));
      box.innerHTML = `<div class="rp-row ${avg > 15 ? 'bad' : ''}"><dt>${F.esc(F.t('rpAir'))}</dt><dd><b>${F.fmt(avg, 1)}</b> µg/m³ · ${F.esc(avg > 15 ? F.t('xWho', { x: F.fmt(avg / 15, 1) }) : F.t('rpWhoOk'))}</dd></div><div class="rp-row ${hi >= 32.2 ? 'bad' : ''}"><dt>${F.esc(F.t('rpHeat'))}</dt><dd><b>${F.fmt(hi, 0)}</b>°C</dd></div>`;
    } catch (err) { box.innerHTML = `<div class="rp-row"><dt>${F.esc(F.t('loadFail'))}</dt><dd></dd></div>`; }
  }

  /* ---------------- 위성 사진(하노이 2024 야기) ---------------- */
  let satMeta = null, satTop = 'satA';
  async function setupSat() {
    if (satMeta) return satMeta;
    satMeta = {};
    await Promise.all(SAT_DATES.map(d => fetch(`data/s2/hanoi_${d}.json`).then(r => r.json()).then(j => { satMeta[d] = j.coordinates; })));
    ['satA', 'satB'].forEach(id => {
      map.addSource(id, { type: 'image', url: `data/s2/hanoi_${SAT_DATES[0]}.jpg`, coordinates: satMeta[SAT_DATES[0]] });
      map.addLayer({ id, type: 'raster', source: id, layout: { visibility: 'none' }, paint: { 'raster-opacity': 0, 'raster-opacity-transition': { duration: F.MOTION ? 700 : 0 }, 'raster-fade-duration': 0 } }, 'bbox');
    });
    return satMeta;
  }
  function satOpacity() { return +F.$('#satOp').value / 100; }
  async function showSat(d) {
    await setupSat();
    const first = !R.satOn;
    R.satOn = true; R.satDate = d;
    const nxt = satTop === 'satA' ? 'satB' : 'satA';
    map.getSource(nxt).updateImage({ url: `data/s2/hanoi_${d}.jpg`, coordinates: satMeta[d] });
    map.setLayoutProperty(nxt, 'visibility', 'visible');
    map.moveLayer(nxt, 'bbox');
    map.setPaintProperty(nxt, 'raster-opacity', satOpacity());
    const old = satTop; satTop = nxt;
    setTimeout(() => { if (satTop !== old) { map.setPaintProperty(old, 'raster-opacity', 0); } }, F.MOTION ? 700 : 0);
    if (first) map.fitBounds(SAT_BBOX, { padding: F.padding(), duration: F.MOTION ? 1400 : 0, pitch: 0, bearing: 0 });
    renderSat();
  }
  function hideSat() {
    R.satOn = false; R.satDate = null;
    ['satA', 'satB'].forEach(id => { if (map.getLayer(id)) { map.setPaintProperty(id, 'raster-opacity', 0); map.setLayoutProperty(id, 'visibility', 'none'); } });
    renderSat();
  }
  function renderSat() {
    const sec = F.$('#satSec');
    sec.hidden = F.S.city !== 'hanoi';
    if (sec.hidden) return;
    F.$('#satBtns').innerHTML = SAT_DATES.map((d, i) => `<button data-d="${d}" class="${R.satDate === d ? 'on' : ''} ${i === 1 ? 'hot' : ''}"><b>${F.esc(F.t('satD' + i))}</b><small>${F.esc(F.t('satS' + i))}</small></button>`).join('');
    F.$$('#satBtns [data-d]').forEach(b => b.addEventListener('click', () => showSat(b.dataset.d)));
    F.$('#satCtl').hidden = !R.satOn;
  }

  /* ---------------- 바깥에서 부르는 것 ---------------- */
  window.RK = {
    init(f) {
      F = f; map = f.map;
      setupIso(); loadSlr();
      F.$('#ppIso').addEventListener('click', () => { R.isoOn = !R.isoOn; update(); });
      F.$('#ppWet').addEventListener('click', () => F.$('#impactLv').scrollIntoView({ behavior: F.MOTION ? 'smooth' : 'auto', block: 'nearest' }));
      F.$('#satOp').addEventListener('input', () => { if (R.satOn) map.setPaintProperty(satTop, 'raster-opacity', satOpacity()); });
      F.$('#satOff').addEventListener('click', hideSat);
      F.$('#rp').addEventListener('click', e => { if (e.target.id === 'rp') closeReport(); });
      addEventListener('keydown', e => { if (e.key === 'Escape' && !F.$('#rp').hidden) closeReport(); });
    },
    load: key => load(key).catch(() => null),
    loadSlr,
    update,
    peopleBelow, compact,
    onCity() { R.scn = null; isoKey = ''; if (R.satOn) hideSat(); renderSat(); },
    onReady() { renderSlr(); renderSat(); update(); },
    onUserLevel() { if (R.scn != null) { R.scn = null; F.$$('#slrBtns [data-s]').forEach(b => b.classList.remove('on')); note(); } },
    onLang() { if (!F) return; renderSlr(); renderSat(); update(); },
    leave() { if (map.getLayer('iso')) map.setLayoutProperty('iso', 'visibility', 'none'); if (R.satOn) hideSat(); closeReport(); },
    report,
    _R: R
  };
})();

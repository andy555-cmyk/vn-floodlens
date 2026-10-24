/* 공기·더위 모드 — 전국 격자 예보를 지도에 칠하고, 도시별 값과 순위를 보여 준다 */
(function () {
  'use strict';
  const TZ = '&timezone=Asia%2FBangkok';
  const ORDER = ['hcm', 'cantho', 'hanoi', 'hue', 'danang'];
  const SEOUL = [126.978, 37.5665];      // 같은 날 비교용(지도에는 칠하지 않음)
  const WHO_PM25 = 15; // WHO 대기질 지침(2021) PM2.5 24시간 기준
  // 미국 환경보호청 PM2.5 단계(2024 개정, 24시간 평균 기준)
  const AIR_CAT = [[0, 'aq0', '#2fbf71'], [9.05, 'aq1', '#e9c13a'], [35.45, 'aq2', '#f08c2e'], [55.45, 'aq3', '#e5484d'], [125.45, 'aq4', '#8e44ad'], [225.45, 'aq5', '#6b1d3a']];
  // 미국 기상청 열지수 단계(°F 80·90·103·125 → °C)
  const HEAT_CAT = [[-99, 'hi0', '#5aa9e6'], [26.7, 'hi1', '#e9c13a'], [32.2, 'hi2', '#f08c2e'], [39.4, 'hi3', '#e5484d'], [51.7, 'hi4', '#8e1b4a']];
  const AIR_RAMP = [[0, [111, 211, 168]], [9, [185, 227, 122]], [15, [242, 211, 76]], [35, [242, 153, 74]], [55, [229, 72, 77]], [125, [142, 68, 173]], [225, [92, 26, 51]]];
  const HEAT_RAMP = [[22, [142, 197, 255]], [26.7, [255, 224, 138]], [32.2, [255, 176, 77]], [39.4, [240, 90, 60]], [51.7, [142, 27, 74]]];

  let F, map, grid, canvas, ctx2d, markers = [], timer = 0;
  const C = { mode: null, idx: 0, data: {}, playing: false };

  const cat = (mode, v) => { const T = mode === 'air' ? AIR_CAT : HEAT_CAT; let c = T[0]; for (const x of T) if (v >= x[0]) c = x; return c; };
  function ramp(mode, v) {
    const R = mode === 'air' ? AIR_RAMP : HEAT_RAMP;
    if (v <= R[0][0]) return R[0][1];
    for (let i = 1; i < R.length; i++) if (v <= R[i][0]) {
      const [a, ca] = R[i - 1], [b, cb] = R[i], k = (v - a) / (b - a);
      return ca.map((x, j) => Math.round(x + (cb[j] - x) * k));
    }
    return R[R.length - 1][1];
  }

  // 미국 기상청 열지수(Rothfusz 회귀식과 보정)
  function heatIndex(tC, rh) {
    if (tC == null || rh == null) return null;
    const T = tC * 9 / 5 + 32;
    let HI = 0.5 * (T + 61 + (T - 68) * 1.2 + rh * 0.094);
    if ((HI + T) / 2 >= 80) {
      HI = -42.379 + 2.04901523 * T + 10.14333127 * rh - 0.22475541 * T * rh - 0.00683783 * T * T - 0.05481717 * rh * rh + 0.00122874 * T * T * rh + 0.00085282 * T * rh * rh - 0.00000199 * T * T * rh * rh;
      if (rh < 13 && T >= 80 && T <= 112) HI -= ((13 - rh) / 4) * Math.sqrt((17 - Math.abs(T - 95)) / 17);
      else if (rh > 85 && T >= 80 && T <= 87) HI += ((rh - 85) / 10) * ((87 - T) / 5);
    }
    return (HI - 32) * 5 / 9;
  }

  /* ---------------- 자료 ---------------- */
  const list = (a, k) => a.map(p => p[k]).join(',');
  async function load(mode) {
    if (C.data[mode]) return C.data[mode];
    if (!grid) grid = await fetch('data/grid.json').then(r => r.json());
    const pts = ORDER.map(k => F.S.cities[k].center).concat([SEOUL]);
    const cLat = pts.map(c => c[1]).join(','), cLon = pts.map(c => c[0]).join(',');
    const gLat = grid.lat.join(','), gLon = grid.lon.join(',');
    let G, Cy;
    if (mode === 'air') {
      [G, Cy] = await Promise.all([
        F.getJson(`https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${gLat}&longitude=${gLon}&hourly=pm2_5&forecast_days=3${TZ}`),
        F.getJson(`https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${cLat}&longitude=${cLon}&hourly=pm2_5,us_aqi&current=pm2_5,us_aqi&past_days=1&forecast_days=3${TZ}`)
      ]);
    } else {
      [G, Cy] = await Promise.all([
        F.getJson(`https://api.open-meteo.com/v1/forecast?latitude=${gLat}&longitude=${gLon}&hourly=temperature_2m,relative_humidity_2m&forecast_days=3${TZ}`),
        F.getJson(`https://api.open-meteo.com/v1/forecast?latitude=${cLat}&longitude=${cLon}&hourly=temperature_2m,relative_humidity_2m&daily=uv_index_max&past_days=1&forecast_days=3${TZ}`)
      ]);
    }
    if (!Array.isArray(G)) G = [G];
    if (!Array.isArray(Cy)) Cy = [Cy];
    const val = h => mode === 'air' ? h.pm2_5 : h.temperature_2m.map((t, i) => heatIndex(t, h.relative_humidity_2m[i]));
    const times = G[0].hourly.time;
    const D = {
      times,
      grid: G.map(g => val(g.hourly)),
      city: {}
    };
    ORDER.forEach((k, i) => {
      const h = Cy[i].hourly, v = val(h);
      const o = { times: h.time, v };
      if (mode === 'air') { o.aqi = h.us_aqi; }
      else { o.temp = h.temperature_2m; o.rh = h.relative_humidity_2m; o.uv = Cy[i].daily; }
      D.city[k] = o;
    });
    { const h = Cy[ORDER.length].hourly; D.city.seoul = { times: h.time, v: val(h), aqi: h.us_aqi, temp: h.temperature_2m, rh: h.relative_humidity_2m, uv: Cy[ORDER.length].daily }; }
    // 오늘(현지 0~23시) 값으로 지점별 하루 지표를 만든다
    const today = F.vnNow().slice(0, 10);
    const ti = times.map((tm, i) => tm.startsWith(today) ? i : -1).filter(i => i >= 0);
    const daily = vs => { const a = ti.map(i => vs[i]).filter(v => v != null); return a.length ? (mode === 'air' ? a.reduce((s, v) => s + v, 0) / a.length : Math.max(...a)) : null; };
    const gd = D.grid.map(daily).filter(v => v != null);
    D.share = gd.length ? gd.filter(v => mode === 'air' ? v > WHO_PM25 : v >= 32.2).length / gd.length * 100 : 0;
    D.at = new Date(Date.now() + 7 * 3600e3).toISOString().slice(11, 16);
    C.data[mode] = D;
    return D;
  }

  // 도시의 오늘 지표·지금 값·앞으로 최고값
  function cityStats(mode, k) {
    const D = C.data[mode], o = D.city[k], now = F.vnNow(), today = now.slice(0, 10);
    const ni = Math.max(0, o.times.findIndex(tm => tm.slice(0, 13) === now));
    const tv = o.times.map((tm, i) => tm.startsWith(today) ? o.v[i] : null).filter(v => v != null);
    const day = mode === 'air' ? tv.reduce((s, v) => s + v, 0) / (tv.length || 1) : Math.max(...tv);
    let pk = ni; for (let i = ni; i < o.v.length; i++) if (o.v[i] != null && o.v[i] > o.v[pk]) pk = i;
    const hot = mode === 'heat' ? o.v.slice(ni).filter(v => v != null && v >= 32.2).length : 0;
    const dayMaxT = mode === 'heat' ? Math.max(...o.times.map((tm, i) => tm.startsWith(today) ? o.temp[i] : -99)) : null;
    const uv = mode === 'heat' && o.uv ? o.uv.uv_index_max[Math.max(0, o.uv.time.indexOf(today))] : null;
    return { ni, now: o.v[ni], day, pk, peak: o.v[pk], peakAt: o.times[pk], hot, dayMaxT, uv, aqi: o.aqi ? o.aqi[ni] : null, temp: o.temp ? o.temp[ni] : null, rh: o.rh ? o.rh[ni] : null };
  }

  // 'YYYY-MM-DDTHH:MM' → 오늘/내일/요일 + 시각
  function dayName(d) {
    const diff = Math.round((Date.parse(d) - Date.parse(F.vnNow().slice(0, 10))) / 864e5);
    const n = diff === 0 ? F.t('dToday') : diff === 1 ? F.t('tomorrow') : diff === -1 ? F.t('dYesterday') : new Date(d + 'T12:00:00Z').toLocaleDateString(F.loc(), { weekday: F.S.lang === 'en' ? 'short' : 'long', timeZone: 'UTC' });
    return n.charAt(0).toUpperCase() + n.slice(1);
  }
  const stamp = tm => dayName(tm.slice(0, 10)) + ' ' + tm.slice(11, 16);

  /* ---------------- 지도 그림 ---------------- */
  function setupMap() {
    if (canvas) return;
    canvas = document.createElement('canvas');
    const [W, S, E, N] = grid.bbox;
    const xs = (E - W) / 360, ys = F.lat2y(S, 0) - F.lat2y(N, 0);
    canvas.width = 340; canvas.height = Math.round(340 * ys / xs);
    ctx2d = canvas.getContext('2d');
    // 격자 위치표
    const cols = Math.round((E - W) / grid.step) + 1, rows = Math.round((N - S) / grid.step) + 1;
    grid.cols = cols; grid.rows = rows; grid.at = new Int32Array(cols * rows).fill(-1);
    grid.lat.forEach((la, i) => { grid.at[Math.round((la - S) / grid.step) * cols + Math.round((grid.lon[i] - W) / grid.step)] = i; });
    // 화면 줄마다 위도(메르카토르), 칸마다 경도
    grid.rowLat = Array.from({ length: canvas.height }, (_, j) => F.y2lat(F.lat2y(N, 0) + (j + 0.5) / canvas.height * ys, 0));
    grid.colLon = Array.from({ length: canvas.width }, (_, i) => W + (i + 0.5) / canvas.width * (E - W));
    map.addSource('clim', { type: 'canvas', canvas, coordinates: [[W, N], [E, N], [E, S], [W, S]], animate: true });
    map.addLayer({ id: 'clim', type: 'raster', source: 'clim', paint: { 'raster-opacity': 0.72, 'raster-fade-duration': 0, 'raster-resampling': 'linear' }, layout: { visibility: 'none' } }, F.firstSymbol());
  }
  // 격자 값 보간(경계는 가중치로 부드럽게 흐려짐)
  function sample(vals, lon, lat) {
    const [W, S] = grid.bbox, gx = (lon - W) / grid.step, gy = (lat - S) / grid.step;
    const x0 = Math.floor(gx), y0 = Math.floor(gy), fx = gx - x0, fy = gy - y0;
    let ws = 0, vs = 0;
    for (const [dx, dy, w] of [[0, 0, (1 - fx) * (1 - fy)], [1, 0, fx * (1 - fy)], [0, 1, (1 - fx) * fy], [1, 1, fx * fy]]) {
      const x = x0 + dx, y = y0 + dy;
      if (x < 0 || y < 0 || x >= grid.cols || y >= grid.rows) continue;
      const i = grid.at[y * grid.cols + x]; if (i < 0) continue;
      const v = vals[i]; if (v == null) continue;
      ws += w; vs += w * v;
    }
    return ws > 0.02 ? { v: vs / ws, w: ws } : null;
  }
  function draw() {
    const D = C.data[C.mode]; if (!D || !ctx2d) return;
    const vals = D.grid.map(s => s[C.idx]);
    const img = ctx2d.createImageData(canvas.width, canvas.height), d = img.data;
    for (let j = 0; j < canvas.height; j++) {
      const lat = grid.rowLat[j];
      for (let i = 0; i < canvas.width; i++) {
        const s = sample(vals, grid.colLon[i], lat); if (!s) continue;
        const c = ramp(C.mode, s.v), a = Math.min(1, s.w * 1.6), p = (j * canvas.width + i) * 4;
        d[p] = c[0]; d[p + 1] = c[1]; d[p + 2] = c[2]; d[p + 3] = Math.round(255 * a * a * (3 - 2 * a));
      }
    }
    ctx2d.putImageData(img, 0, 0);
    updateMarkers();
    const tm = D.times[C.idx];
    F.$('#clTime').textContent = stamp(tm);
    const r = F.$('#clRange'); r.value = C.idx; r.style.setProperty('--p', (C.idx / (D.times.length - 1) * 100) + '%');
  }

  function makeMarkers() {
    markers.forEach(m => m.remove()); markers = [];
    ORDER.forEach(k => {
      const el = document.createElement('button');
      el.className = 'cmk'; el.dataset.city = k;
      el.addEventListener('click', ev => { ev.stopPropagation(); F.pickCity(k); });
      markers.push(new maplibregl.Marker({ element: el, anchor: 'center', offset: TAG_OFF[k].map(v => innerWidth < 900 ? Math.round(v * 0.62) : v) }).setLngLat(F.S.cities[k].center).addTo(map));
    });
    if (!map.getSource('cdots')) {
      map.addSource('cdots', { type: 'geojson', data: { type: 'FeatureCollection', features: ORDER.map(k => ({ type: 'Feature', properties: { k }, geometry: { type: 'Point', coordinates: F.S.cities[k].center } })) } });
      map.addLayer({ id: 'cdots', type: 'circle', source: 'cdots', paint: { 'circle-radius': 5, 'circle-color': '#0f172a', 'circle-stroke-color': '#fff', 'circle-stroke-width': 2 } });
    }
  }
  // 가까운 도시끼리 표지가 겹치지 않게 방향을 나눈다(후에↔다낭, 호찌민↔껀터)
  const TAG_OFF = { hanoi: [0, -34], hue: [-62, -26], danang: [-50, 34], hcm: [58, -24], cantho: [-58, 26] };
  function updateMarkers() {
    const D = C.data[C.mode]; if (!D) return;
    const tm = D.times[C.idx];
    markers.forEach(m => {
      const el = m.getElement(), k = el.dataset.city, o = D.city[k];
      const i = o.times.indexOf(tm), v = i >= 0 ? o.v[i] : null;
      const c = v == null ? null : cat(C.mode, v);
      el.classList.toggle('on', k === F.S.city);
      el.style.setProperty('--c', c ? c[2] : '#94a3b8');
      el.innerHTML = `<b>${v == null ? '–' : F.fmt(v, 0)}<small>${C.mode === 'air' ? 'µg/m³' : '°C'}</small></b><span>${F.esc(F.t('city_' + k))}</span>`;
    });
  }

  /* ---------------- 패널 ---------------- */
  function chart(mode, o, ni) {
    const w = 420, h = 128, pad = 6, v = o.v.map(x => x ?? null), ok = v.filter(x => x != null);
    if (ok.length < 2) return '';
    const lo = mode === 'air' ? 0 : Math.min(...ok) - 1, hi = Math.max(...ok, mode === 'air' ? WHO_PM25 * 1.4 : 34) * 1.06;
    const Y = x => h - pad - (x - lo) / (hi - lo) * (h - pad * 2 - 8), X = i => i / (v.length - 1) * w;
    const pts = v.map((x, i) => x == null ? null : [X(i), Y(x)]).filter(Boolean);
    const line = 'M' + pts.map(p => p[0].toFixed(1) + ',' + p[1].toFixed(1)).join('L');
    const T = mode === 'air' ? AIR_CAT : HEAT_CAT, gid = 'cg' + mode;
    let stops = T.map(c => { const y = Math.max(0, Math.min(1, (Y(Math.max(lo, c[0])) / h))); return `<stop offset="${(1 - y).toFixed(3)}" stop-color="${c[2]}"/>`; });
    let s = `<svg viewBox="0 0 ${w} ${h + 18}" class="cl-chart" aria-hidden="true"><defs><linearGradient id="${gid}" gradientUnits="userSpaceOnUse" x1="0" y1="${h}" x2="0" y2="0">${stops.join('')}</linearGradient></defs>`;
    // 날짜 경계
    o.times.forEach((tm, i) => { if (tm.endsWith('T00:00') && i > 0) s += `<line x1="${X(i)}" x2="${X(i)}" y1="0" y2="${h}" stroke="#e6eaf0"/><text x="${X(i) + 4}" y="${h + 14}" class="ax">${F.esc(dayName(tm.slice(0, 10)))}</text>`; });
    const ref = mode === 'air' ? WHO_PM25 : 32.2;
    s += `<line x1="0" x2="${w}" y1="${Y(ref)}" y2="${Y(ref)}" stroke="#0f172a" stroke-dasharray="4 4" opacity=".5"/><text x="${w - 4}" y="${Y(ref) - 5}" text-anchor="end" class="ax ref">${F.esc(F.t(mode === 'air' ? 'refWho' : 'refHeat'))}</text>`;
    s += `<path d="${line}L${pts[pts.length - 1][0]},${h}L${pts[0][0]},${h}Z" fill="url(#${gid})" opacity=".16"/><path d="${line}" fill="none" stroke="url(#${gid})" stroke-width="3" stroke-linejoin="round" class="draw2"/>`;
    if (v[ni] != null) s += `<line x1="${X(ni)}" x2="${X(ni)}" y1="0" y2="${h}" stroke="#0f172a" stroke-dasharray="2 3"/><circle cx="${X(ni)}" cy="${Y(v[ni])}" r="5" fill="#0f172a" stroke="#fff" stroke-width="2"/><text x="${X(ni) + 6}" y="12" class="ax">${F.esc(F.t('tideNow'))}</text>`;
    return s + '</svg>';
  }

  function renderPanel() {
    const mode = C.mode, D = C.data[mode]; if (!D) return;
    const k = F.S.city, st = cityStats(mode, k), city = F.t('city_' + k);
    const u = mode === 'air' ? 'µg/m³' : '°C';
    F.$('#clUpd').textContent = F.t('upd', { t: D.at });
    F.$('#clTitle').textContent = F.t(mode === 'air' ? 'airNowT' : 'heatNowT', { city });
    const cNow = cat(mode, mode === 'air' ? st.day : st.now);
    const facts = mode === 'air'
      ? [[F.t('fDayAvg'), F.fmt(st.day, 1) + ' ' + u], [F.t('fPeak'), F.fmt(st.peak, 0) + ' ' + u + ' · ' + stamp(st.peakAt)], [F.t('fAqi'), st.aqi == null ? '–' : F.fmt(st.aqi, 0)]]
      : [[F.t('fTemp'), F.fmt(st.temp, 1) + '°C · ' + F.t('fRh', { v: F.fmt(st.rh, 0) })], [F.t('fDayMaxHi'), F.fmt(st.day, 0) + '°C'], [F.t('fHot'), F.t('hours', { n: F.fmt(st.hot) })], [F.t('fUv'), st.uv == null ? '–' : F.fmt(st.uv, 1) + ' · ' + F.t(uvCat(st.uv))]];
    F.$('#clNow').innerHTML = `
      <div class="cl-big"><b style="color:${cNow[2]}">${F.fmt(st.now, mode === 'air' ? 1 : 0)}</b><span>${u}</span><em class="cat" style="--c:${cNow[2]}">${F.esc(F.t(mode === 'air' ? 'catDay' : 'catNow', { c: F.t(cNow[1]) }))}</em></div>
      <small class="cl-cap">${F.esc(F.t(mode === 'air' ? 'capAir' : 'capHeat'))}</small>
      ${chart(mode, D.city[k], st.ni)}
      <dl class="facts">${facts.map(([a, b]) => `<div><dt>${F.esc(a)}</dt><dd>${F.esc(b)}</dd></div>`).join('')}</dl>`;
    // 순위
    const rows = ORDER.map(c => ({ c, s: cityStats(mode, c) })).sort((a, b) => b.s.day - a.s.day);
    const max = Math.max(...rows.map(r => r.s.day), mode === 'air' ? WHO_PM25 : 40);
    F.$('#clRankT').textContent = F.t(mode === 'air' ? 'rankAir' : 'rankHeat');
    F.$('#clShare').innerHTML = F.t(mode === 'air' ? 'shareAir' : 'shareHeat', { p: `<b>${F.fmt(D.share, 0)}%</b>` });
    F.$('#clRank').innerHTML = rows.map((r, i) => {
      const c = cat(mode, r.s.day), ratio = mode === 'air' ? r.s.day / WHO_PM25 : null;
      return `<li style="animation-delay:${i * 40}ms"><button data-city="${r.c}" class="${r.c === k ? 'on' : ''}"><span class="rk">${i + 1}</span><span class="rn">${F.esc(F.t('city_' + r.c))}</span><span class="rb"><i style="width:${Math.max(4, r.s.day / max * 100)}%;background:${c[2]}"></i></span><span class="rv">${F.fmt(r.s.day, mode === 'air' ? 1 : 0)}<small>${u}</small></span><span class="rc" style="--c:${c[2]}">${F.esc(F.t(c[1]))}${ratio != null && ratio >= 1.05 ? ' · ' + F.t('xWho', { x: F.fmt(ratio, 1) }) : ''}</span></button></li>`;
    }).join('');
    F.$$('#clRank [data-city]').forEach(b => b.addEventListener('click', () => F.pickCity(b.dataset.city)));
    renderVs(mode, k, st);
  }
  // 같은 시간대(베트남 기준 오늘 0~23시) 서울 값과 비교
  function renderVs(mode, k, st) {
    const box = F.$('#clVs'); if (!C.data[mode].city.seoul) { box.hidden = true; return; }
    const se = cityStats(mode, 'seoul'), u = mode === 'air' ? 'µg/m³' : '°C', d = mode === 'air' ? 1 : 0;
    const a = st.day, b = se.day, max = Math.max(a, b, mode === 'air' ? WHO_PM25 : 1) * 1.08;
    const ca = cat(mode, a), cb = cat(mode, b);
    let msg;
    if (mode === 'air') msg = a >= b * 1.05 ? F.t('vsAirX', { city: F.t('city_' + k), x: `<b>${F.fmt(a / b, 1)}</b>` }) : F.t('vsAirLow', { city: F.t('city_' + k) });
    else msg = a - b >= 1 ? F.t('vsHeatD', { city: F.t('city_' + k), d: `<b>${F.fmt(a - b, 0)}°C</b>` }) : F.t('vsHeatLow', { city: F.t('city_' + k) });
    const bar = (n, v, c, me) => `<div class="vs-r ${me ? 'me' : ''}"><span class="vn">${F.esc(n)}</span><span class="vb"><i style="width:${Math.max(3, v / max * 100)}%;background:${c[2]}"></i></span><span class="vv">${F.fmt(v, d)}<small>${u}</small></span></div>`;
    box.hidden = false;
    box.innerHTML = `<h3>${F.esc(F.t(mode === 'air' ? 'vsAirT' : 'vsHeatT'))}</h3><p class="vs-msg">${msg}</p>${bar(F.t('city_' + k), a, ca, true)}${bar(F.t('city_seoul'), b, cb, false)}<small class="vs-note">${F.esc(F.t('vsNote'))}</small>`;
  }
  const uvCat = v => v >= 11 ? 'uv4' : v >= 8 ? 'uv3' : v >= 6 ? 'uv2' : v >= 3 ? 'uv1' : 'uv0';

  function renderHero() {
    const mode = C.mode, D = C.data[mode]; if (!D) return;
    const k = F.S.city, st = cityStats(mode, k), city = F.t('city_' + k);
    let h, s;
    if (mode === 'air') {
      const x = st.day / WHO_PM25;
      h = x >= 1.05 ? F.t('hAir', { city, x: `<em>${F.fmt(x, 1)}</em>` }) : F.t('hAirOk', { city });
      s = F.t('sAir', { v: F.fmt(st.day, 1), when: stamp(st.peakAt), pk: F.fmt(st.peak, 0) });
    } else {
      const c = cat('heat', st.day);
      h = F.t('hHeat', { city, v: `<em>${F.fmt(st.day, 0)}°C</em>`, c: F.t(c[1]) });
      s = F.t('sHeat', { t: F.fmt(st.dayMaxT, 0), n: F.fmt(st.hot) });
    }
    F.setHero(h, s);
  }

  function renderLegend() {
    const mode = C.mode;
    const grad = (mode === 'air' ? AIR_RAMP : HEAT_RAMP).map(([v, c], i, a) => `rgb(${c.join(',')}) ${(i / (a.length - 1) * 100).toFixed(0)}%`).join(',');
    const ticks = mode === 'air' ? ['0', '15 WHO', '35', '55', '125+'] : ['22', '27', '32', '39', '52°C+'];
    F.$('#legend').innerHTML = `<div class="lg-row"><span class="lg-k">${F.esc(F.t(mode === 'air' ? 'lgAir' : 'lgHeat'))}</span></div><div class="lg-bar" style="background:linear-gradient(90deg,${grad})"></div><div class="lg-ticks">${ticks.map(x => `<span>${x}</span>`).join('')}</div>`;
  }
  function renderSources() {
    const keys = C.mode === 'air' ? ['srcAir1', 'srcAir2', 'srcAir3'] : ['srcHeat1', 'srcHeat2', 'srcHeat3'];
    F.$('#srcs').innerHTML = keys.map(x => `<li>${F.esc(F.t(x))}</li>`).join('');
    F.$('#caveat').textContent = F.t(C.mode === 'air' ? 'cavAir' : 'cavHeat');
  }

  /* ---------------- 시간 재생 ---------------- */
  function stop() { C.playing = false; clearTimeout(timer); F.$('#clPlay').classList.remove('on'); }
  function play() {
    const D = C.data[C.mode]; if (!D) return;
    if (C.playing) { stop(); return; }
    C.playing = true; F.$('#clPlay').classList.add('on');
    if (C.idx >= D.times.length - 1) C.idx = 0;
    const tick = () => {
      if (!C.playing) return;
      C.idx++; draw();
      if (C.idx >= D.times.length - 1) { stop(); return; }
      timer = setTimeout(tick, F.MOTION ? 110 : 0);
    };
    timer = setTimeout(tick, 60);
  }

  /* ---------------- 바깥에서 부르는 것 ---------------- */
  let seq = 0;
  window.CL = {
    init(f) {
      F = f; map = f.map;
      F.$('#clRange').addEventListener('input', e => { stop(); C.idx = +e.target.value; draw(); });
      F.$('#clPlay').addEventListener('click', play);
      F.$('#clNowBtn').addEventListener('click', () => { stop(); const D = C.data[C.mode]; if (D) { C.idx = Math.max(0, D.times.findIndex(tm => tm.slice(0, 13) === F.vnNow())); draw(); } });
    },
    async enter(mode, first) {
      const my = ++seq;
      C.mode = mode; stop();
      document.body.classList.add('loading');
      let D;
      try { D = await load(mode); } catch (e) { document.body.classList.remove('loading'); F.setHero(F.t('loadFail'), ''); F.bootDone(); return; }
      if (my !== seq || C.mode !== mode) return;
      setupMap();
      map.setLayoutProperty('clim', 'visibility', 'visible');
      map.getSource('clim').play();
      if (map.getLayer('cdots')) map.setLayoutProperty('cdots', 'visibility', 'visible');
      if (!markers.length) makeMarkers();
      markers.forEach(m => m.getElement().hidden = false);
      F.$('#clRange').max = D.times.length - 1;
      C.idx = Math.max(0, D.times.findIndex(tm => tm.slice(0, 13) === F.vnNow()));
      draw(); renderPanel(); renderHero(); renderLegend(); renderSources();
      document.body.classList.remove('loading');
      F.bootDone();
      map.fitBounds([[102.1, 8.4], [109.6, 23.4]], { padding: F.padding(true), duration: F.MOTION ? (first ? 3000 : 1600) : 0, pitch: 0, bearing: 0 });
    },
    leave() {
      seq++; stop(); C.mode = null;
      if (map.getLayer('clim')) { map.setLayoutProperty('clim', 'visibility', 'none'); map.getSource('clim').pause(); }
      markers.forEach(m => m.getElement().hidden = true);
      if (map.getLayer('cdots')) map.setLayoutProperty('cdots', 'visibility', 'none');
    },
    onCity() { if (!C.mode) return; updateMarkers(); renderPanel(); renderHero(); },
    onLang() { if (!C.mode || !C.data[C.mode]) return; draw(); renderPanel(); renderHero(); renderLegend(); renderSources(); },
    probe(lon, lat) {
      const D = C.data[C.mode]; if (!D || !grid.at) return null;
      const s = sample(D.grid.map(g => g[C.idx]), lon, lat); if (!s) return null;
      const c = cat(C.mode, s.v);
      return `<b>${F.esc(F.t(C.mode === 'air' ? 'pAir' : 'pHeat', { v: F.fmt(s.v, C.mode === 'air' ? 0 : 0) }))}</b><span class="pt">${F.esc(stamp(D.times[C.idx]))}</span><span class="pe" style="color:${c[2]};font-weight:700">${F.esc(F.t(c[1]))}</span><span class="pt sm">${F.esc(F.t('pGridNote'))}</span>`;
    },
    get mode() { return C.mode; },
    _C: C, _heatIndex: heatIndex
  };
})();

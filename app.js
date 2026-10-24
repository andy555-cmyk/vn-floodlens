(function () {
  'use strict';
  const I = window.I18N;
  const qs = new URLSearchParams(location.search);
  const MOTION = qs.get('motion') !== 'off' && !matchMedia('(prefers-reduced-motion: reduce)').matches;
  const TERR = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
  const AZ = 12; // 분석 줌 — 지형 원자료(약 30m)와 비슷한 격자
  const ORDER = ['hcm', 'cantho', 'hanoi', 'hue', 'danang'];
  const MAXLV = { hcm: 6, cantho: 5, hanoi: 12, hue: 8, danang: 8 };
  const TYPES = ['hospital', 'school', 'police'];
  const COLORS = { hospital: '#e5484d', school: '#f5a524', police: '#3b5bdb', fire: '#3b5bdb' };

  const S = {
    lang: pickLang(), city: ORDER.includes(qs.get('city')) ? qs.get('city') : 'hcm',
    lv: 0, lvShown: -1, listType: 'hospital', cities: null, data: {}, live: {}, roadsOn: true, is3d: false,
    mode: ['air', 'heat', 'storm', 'soc'].includes(qs.get('mode')) ? qs.get('mode') : 'flood', floodCity: null
  };
  const FLOOD_LAYERS = ['flood', 'bbox', 'roads', 'roads-glow', 'pois', 'pois-wet', 'poi-halo'];

  function pickLang() {
    const q = qs.get('lang'); if (I[q]) return q;
    try { const s = localStorage.getItem('fl-lang'); if (I[s]) return s; } catch (e) {}
    const n = (navigator.language || 'ko').slice(0, 2); return I[n] ? n : 'ko';
  }
  function t(k, v) {
    let s = (I[S.lang] && I[S.lang][k]) ?? I.en[k] ?? k;
    if (v) for (const x in v) s = s.split('{' + x + '}').join(v[x]);
    return s;
  }
  const when = s => String(s).replace('\u0001', t('tomorrow') + ' ');
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const loc = () => S.lang === 'vi' ? 'vi-VN' : S.lang === 'ko' ? 'ko-KR' : 'en-US';
  const fmt = (n, d = 0) => Number(n).toLocaleString(loc(), { maximumFractionDigits: d, minimumFractionDigits: d });
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  // rAF가 멈춘 창(가려진 미리보기·백그라운드)에서도 진행되도록 시간 예비로 겨룬다
  const frame = fn => {
    let done = false;
    const go = now => { if (done) return; done = true; cancelAnimationFrame(r); clearTimeout(h); fn(now ?? performance.now()); };
    const r = requestAnimationFrame(go), h = setTimeout(() => go(), 60);
    return r;
  };

  function tween(el, to, d = 0, dur = 650) {
    if (!el) return;
    const from = parseFloat(el.dataset.v ?? '0') || 0;
    el.dataset.v = to;
    if (!MOTION || Math.abs(from - to) < 1e-9) { el.textContent = fmt(to, d); return; }
    const t0 = performance.now(), id = (el._tw = (el._tw || 0) + 1);
    const step = now => {
      if (el._tw !== id) return;
      const k = Math.min(1, (now - t0) / dur), e = 1 - Math.pow(1 - k, 3);
      el.textContent = fmt(from + (to - from) * e, d);
      if (k < 1) frame(step);
    };
    frame(step);
  }

  /* ---------------- 지형 타일 ---------------- */
  const tiles = new Map();
  function lon2x(lon, z) { return (lon + 180) / 360 * 2 ** z; }
  function lat2y(lat, z) { return (1 - Math.asinh(Math.tan(lat * Math.PI / 180)) / Math.PI) / 2 * 2 ** z; }
  function y2lat(y, z) { const n = Math.PI - 2 * Math.PI * y / 2 ** z; return 180 / Math.PI * Math.atan(Math.sinh(n)); }

  function decodeCanvas(img) {
    const cv = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(256, 256) : Object.assign(document.createElement('canvas'), { width: 256, height: 256 });
    const cx = cv.getContext('2d', { willReadFrequently: true });
    cx.drawImage(img, 0, 0);
    const d = cx.getImageData(0, 0, 256, 256).data, e = new Float32Array(65536);
    for (let i = 0; i < 65536; i++) e[i] = d[i * 4] * 256 + d[i * 4 + 1] + d[i * 4 + 2] / 256 - 32768;
    return e;
  }
  function getTile(z, x, y) {
    const k = z + '/' + x + '/' + y;
    if (!tiles.has(k)) {
      const p = (async () => {
        for (let i = 0; i < 3; i++) {
          try {
            const r = await fetch(TERR.replace('{z}', z).replace('{x}', x).replace('{y}', y));
            if (!r.ok) throw 0;
            const bmp = await createImageBitmap(await r.blob());
            const e = decodeCanvas(bmp); p.v = e; return e;
          } catch (err) { await new Promise(res => setTimeout(res, 600 * (i + 1))); }
        }
        return null;
      })();
      tiles.set(k, p);
    }
    return tiles.get(k);
  }
  function elevAt(lon, lat, z = AZ) {
    const fx = lon2x(lon, z), fy = lat2y(lat, z), x = Math.floor(fx), y = Math.floor(fy);
    const p = tiles.get(z + '/' + x + '/' + y);
    if (!p || !p.v) return null;
    const i = Math.min(255, Math.floor((fx - x) * 256)), j = Math.min(255, Math.floor((fy - y) * 256));
    return Math.round(p.v[j * 256 + i]);
  }
  async function elevAtAsync(lon, lat, z = AZ) {
    await getTile(z, Math.floor(lon2x(lon, z)), Math.floor(lat2y(lat, z)));
    return elevAt(lon, lat, z);
  }

  // 물 높이 그림 — 지형 타일을 받아 해발 lv 이하 땅만 파랗게 칠한다
  const DEPTH = [[0, [96, 176, 255, 170]], [1, [58, 138, 240, 195]], [2, [34, 104, 222, 210]], [3, [22, 76, 186, 220]], [5, [12, 48, 136, 228]]];
  function depthColor(d) { let c = DEPTH[0][1]; for (const [k, v] of DEPTH) if (d >= k) c = v; return c; }
  maplibregl.addProtocol('flood', async (params) => {
    const m = params.url.match(/flood:\/\/(\d+)\/(\d+)\/(\d+)\?lv=(-?[\d.]+)/);
    const z = +m[1], x = +m[2], y = +m[3], lv = +m[4];
    const e = await getTile(z, x, y);
    const cv = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(256, 256) : Object.assign(document.createElement('canvas'), { width: 256, height: 256 });
    const cx = cv.getContext('2d');
    const img = cx.createImageData(256, 256), d = img.data;
    if (e && lv > 0) for (let i = 0; i < 65536; i++) {
      const v = Math.round(e[i]);
      if (v > 0 && v <= lv) { const c = depthColor(lv - v); d[i * 4] = c[0]; d[i * 4 + 1] = c[1]; d[i * 4 + 2] = c[2]; d[i * 4 + 3] = c[3]; }
    }
    cx.putImageData(img, 0, 0);
    const blob = cv.convertToBlob ? await cv.convertToBlob({ type: 'image/png' }) : await new Promise(r => cv.toBlob(r, 'image/png'));
    return { data: await blob.arrayBuffer() };
  });

  /* ---------------- 도시 자료 ---------------- */
  function metersBetween(a, b) {
    const k = 111320, dx = (a[0] - b[0]) * k * Math.cos((a[1] + b[1]) / 2 * Math.PI / 180);
    return Math.hypot(dx, (a[1] - b[1]) * k);
  }

  async function prepareCity(key) {
    if (S.data[key]) return S.data[key];
    const c = S.cities[key];
    const [w, s, e, n] = c.bbox;
    const osmP = fetch('data/osm_' + key + '.json').then(r => r.json());
    const x0 = Math.floor(lon2x(w, AZ)), x1 = Math.floor(lon2x(e, AZ)), y0 = Math.floor(lat2y(n, AZ)), y1 = Math.floor(lat2y(s, AZ));
    const jobs = [];
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) jobs.push(getTile(AZ, x, y).then(v => ({ x, y, v })));
    const got = await Promise.all(jobs);

    // 높이별 면적표(1m 단위)
    const hist = new Float64Array(200); // 인덱스 = 해발 m + 20
    const R = 40075016.686;
    for (const { x, y, v } of got) {
      if (!v) continue;
      for (let j = 0; j < 256; j++) {
        const gy = y + (j + 0.5) / 256, lat = y2lat(gy, AZ);
        if (lat < s || lat > n) continue;
        const px = R * Math.cos(lat * Math.PI / 180) / 2 ** (AZ + 8), area = px * px / 1e6;
        for (let i = 0; i < 256; i++) {
          const lon = (x + (i + 0.5) / 256) / 2 ** AZ * 360 - 180;
          if (lon < w || lon > e) continue;
          const h = Math.max(-20, Math.min(179, Math.round(v[j * 256 + i])));
          hist[h + 20] += area;
        }
      }
    }
    let land = 0; for (let h = 1; h < 180; h++) land += hist[h + 20];
    let acc = 0, median = 0; for (let h = 1; h < 180; h++) { acc += hist[h + 20]; if (acc >= land / 2) { median = h; break; } }

    const osm = await osmP;
    const NOT_MED = /yoga|spa\b|massage|thẩm mỹ|tham my|beauty|nail|gym|thú y|thu y|vet/i;
    const pois = osm.pois.filter(p => !(p.t === 'hospital' && NOT_MED.test(p.n || ''))).map((p, i) => ({ ...p, t: p.t === 'fire' ? 'police' : p.t, i, e: elevAt(p.c[0], p.c[1]) ?? 99 }));

    // 도로를 약 40m 토막으로 나눠 토막마다 높이를 단다
    const segs = [];
    let roadKm = 0;
    for (const r of osm.roads) {
      for (let i = 1; i < r.c.length; i++) {
        const a = r.c[i - 1], b = r.c[i], L = metersBetween(a, b), k = Math.max(1, Math.ceil(L / 40));
        roadKm += L / 1000;
        for (let j = 0; j < k; j++) {
          const p0 = [a[0] + (b[0] - a[0]) * j / k, a[1] + (b[1] - a[1]) * j / k];
          const p1 = [a[0] + (b[0] - a[0]) * (j + 1) / k, a[1] + (b[1] - a[1]) * (j + 1) / k];
          const ev = r.b ? 99 : (elevAt((p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2) ?? 99);
          const last = segs[segs.length - 1];
          if (last && last.e === ev && last.end === a + ':' + i + ':' + j) { last.c.push(p1); last.len += L / k; }
          else segs.push({ e: ev, c: [p0, p1], len: L / k });
          segs[segs.length - 1].end = a + ':' + i + ':' + (j + 1);
        }
      }
    }
    const roadByE = new Float64Array(200);
    segs.forEach(sg => { if (sg.e > 0 && sg.e < 180) roadByE[sg.e + 20] += sg.len / 1000; });

    const D = { key, hist, land, median, pois, segs, roadByE, roadKm, osmDate: osm.osm_date };
    S.data[key] = D;
    return D;
  }

  function landBelow(D, lv) { let a = 0; for (let h = 1; h <= Math.floor(lv); h++) a += D.hist[h + 20]; return a; }
  function roadBelow(D, lv) { let a = 0; for (let h = 1; h <= Math.floor(lv); h++) a += D.roadByE[h + 20]; return a; }

  /* ---------------- 실시간 자료 ---------------- */
  async function getJson(url, tries = 4) {
    for (let i = 0; i < tries; i++) {
      try { const r = await fetch(url); if (r.ok) return await r.json(); } catch (e) {}
      await new Promise(res => setTimeout(res, 700 * (i + 1)));
    }
    throw new Error('fetch');
  }
  function vnNow() { // 베트남 현지 시각의 'YYYY-MM-DDTHH'
    return new Date(Date.now() + 7 * 3600e3).toISOString().slice(0, 13);
  }
  async function loadLive(key) {
    const c = S.cities[key], L = { key };
    const tz = '&timezone=Asia%2FBangkok';
    const jobs = [];
    if (c.tide) jobs.push(getJson(`https://marine-api.open-meteo.com/v1/marine?latitude=${c.tide[0]}&longitude=${c.tide[1]}&hourly=sea_level_height_msl&past_days=1&forecast_days=2${tz}`).then(j => {
      const now = vnNow(), today = now.slice(0, 10);
      const H = j.hourly.time.map((tm, i) => ({ tm, v: j.hourly.sea_level_height_msl[i] })).filter(h => h.v != null);
      const ni = Math.max(0, H.findIndex(h => h.tm.slice(0, 13) === now));
      // 지금부터 24시간 안의 가장 높은 물 = 다가오는 만조
      const next = H.slice(ni, ni + 25);
      const pk = next.reduce((a, h) => h.v > a.v ? h : a, next[0]);
      L.tide = { now: H[ni].v, peak: pk.v, peakAt: (pk.tm.slice(0, 10) !== today ? '\u0001' : '') + pk.tm.slice(11, 16), series: H.filter(h => h.tm.slice(0, 10) >= today).slice(0, 48), nowIdx: H.filter(h => h.tm.slice(0, 10) >= today).findIndex(h => h.tm.slice(0, 13) === now) };
    }).catch(() => { L.tideErr = true; }));
    jobs.push(getJson(`https://api.open-meteo.com/v1/forecast?latitude=${c.center[1]}&longitude=${c.center[0]}&hourly=precipitation&current=precipitation&forecast_days=3${tz}`).then(j => {
      const now = vnNow();
      const i0 = Math.max(0, j.hourly.time.findIndex(tm => tm.slice(0, 13) === now));
      const next = j.hourly.precipitation.slice(i0, i0 + 48).map(v => v || 0);
      L.rain = { now: j.current ? j.current.precipitation : next[0], sum: next.reduce((a, b) => a + b, 0), series: next };
    }).catch(() => { L.rainErr = true; }));
    jobs.push(getJson(`https://flood-api.open-meteo.com/v1/flood?latitude=${c.river[0]}&longitude=${c.river[1]}&daily=river_discharge&past_days=7&forecast_days=8`).then(j => {
      const v = j.daily.river_discharge, today = vnNow().slice(0, 10), ti = Math.max(0, j.daily.time.indexOf(today));
      L.river = { now: v[ti], d7: v[Math.min(v.length - 1, ti + 7)], series: v, nowIdx: ti };
    }).catch(() => { L.riverErr = true; }));
    await Promise.all(jobs);
    L.at = new Date(Date.now() + 7 * 3600e3).toISOString().slice(11, 16);
    S.live[key] = L;
    return L;
  }

  /* ---------------- 작은 그래프 ---------------- */
  function areaChart(vals, nowIdx, color, peakIdx) {
    const w = 240, h = 56; if (!vals || vals.length < 2) return '';
    const max = Math.max(...vals), min = Math.min(...vals), rng = max - min || 1;
    const P = vals.map((v, i) => [i / (vals.length - 1) * w, h - 6 - (v - min) / rng * (h - 14)]);
    const line = 'M' + P.map(p => p[0].toFixed(1) + ',' + p[1].toFixed(1)).join('L');
    const gid = 'g' + Math.random().toString(36).slice(2, 7);
    let s = `<svg viewBox="0 0 ${w} ${h}" class="chart" preserveAspectRatio="none" aria-hidden="true"><defs><linearGradient id="${gid}" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="${color}" stop-opacity=".35"/><stop offset="1" stop-color="${color}" stop-opacity="0"/></linearGradient></defs>`;
    s += `<path d="${line}L${w},${h}L0,${h}Z" fill="url(#${gid})"/><path d="${line}" fill="none" stroke="${color}" stroke-width="2" vector-effect="non-scaling-stroke" class="draw"/>`;
    if (nowIdx >= 0 && nowIdx < P.length) s += `<line x1="${P[nowIdx][0]}" x2="${P[nowIdx][0]}" y1="0" y2="${h}" stroke="#111827" stroke-dasharray="2 3" vector-effect="non-scaling-stroke"/><circle cx="${P[nowIdx][0]}" cy="${P[nowIdx][1]}" r="3.5" fill="#111827"/>`;
    if (peakIdx >= 0) s += `<circle cx="${P[peakIdx][0]}" cy="${P[peakIdx][1]}" r="3.5" fill="#fff" stroke="${color}" stroke-width="2"/>`;
    return s + '</svg>';
  }
  function barChart(vals, color) {
    const w = 240, h = 56; if (!vals || !vals.length) return '';
    const max = Math.max(...vals, 0.5), bw = w / vals.length;
    return `<svg viewBox="0 0 ${w} ${h}" class="chart" preserveAspectRatio="none" aria-hidden="true">${vals.map((v, i) => `<rect x="${i * bw + 0.6}" y="${h - 2 - v / max * (h - 8)}" width="${Math.max(1, bw - 1.2)}" height="${Math.max(v ? 1.5 : 0.8, v / max * (h - 8))}" rx="1" fill="${color}" opacity="${v ? .9 : .18}"/>`).join('')}</svg>`;
  }

  /* ---------------- 지도 ---------------- */
  let map, booted = false;
  function initMap() {
    const c = S.cities[S.city];
    map = new maplibregl.Map({
      container: 'map', style: 'https://tiles.openfreemap.org/styles/positron',
      center: [106.4, 15.6], zoom: 4.8, attributionControl: { compact: true }, maxPitch: 70, maxTileCacheSize: 1000
    });
    map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'bottom-right');
    window.__map = map;
    const boot = () => { if (booted) return; booted = true; onMapReady(); };
    map.on('load', boot);
    map.once('styledata', () => setTimeout(boot, 1500));
    setTimeout(boot, 7000);
  }

  function localize() {
    const key = 'name:' + S.lang;
    map.getStyle().layers.forEach(l => {
      if (l.type === 'symbol' && l.layout && l.layout['text-field']) {
        try { map.setLayoutProperty(l.id, 'text-field', ['coalesce', ['get', key], ['get', 'name:latin'], ['get', 'name']]); } catch (e) {}
      }
    });
  }
  function firstSymbol() { const l = map.getStyle().layers.find(l => l.type === 'symbol'); return l && l.id; }

  function onMapReady() {
    localize();
    try { map.setPaintProperty('water', 'fill-color', '#bcd6ee'); } catch (e) {}
    const before = firstSymbol();
    map.addSource('hs', { type: 'raster-dem', tiles: [TERR], encoding: 'terrarium', tileSize: 256, maxzoom: 14 });
    map.addLayer({ id: 'hillshade', type: 'hillshade', source: 'hs', paint: { 'hillshade-exaggeration': 0.35, 'hillshade-shadow-color': '#5b6472', 'hillshade-highlight-color': '#ffffff' } }, before);
    map.addSource('dem3d', { type: 'raster-dem', tiles: [TERR], encoding: 'terrarium', tileSize: 256, maxzoom: 14 });
    map.addSource('flood', { type: 'raster', tiles: ['flood://{z}/{x}/{y}?lv=0'], tileSize: 256, maxzoom: 13 });
    map.addLayer({ id: 'flood', type: 'raster', source: 'flood', paint: { 'raster-opacity': 0.9, 'raster-fade-duration': 0, 'raster-resampling': 'linear' } }, before);
    map.addSource('bbox', { type: 'geojson', data: fc([]) });
    map.addLayer({ id: 'bbox', type: 'line', source: 'bbox', paint: { 'line-color': '#111827', 'line-width': 1.2, 'line-dasharray': [3, 3], 'line-opacity': 0.45 } });
    map.addSource('roads', { type: 'geojson', data: fc([]) });
    map.addLayer({ id: 'roads-glow', type: 'line', source: 'roads', filter: wetFilter(0), layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#e5484d', 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 4, 15, 12], 'line-opacity': 0.18 } });
    map.addLayer({ id: 'roads', type: 'line', source: 'roads', filter: wetFilter(0), layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#d42c3c', 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 1.1, 15, 4] } });
    map.addSource('pois', { type: 'geojson', data: fc([]) });
    map.addLayer({ id: 'poi-halo', type: 'circle', source: 'pois', filter: wetFilter(0, true), paint: { 'circle-radius': 12, 'circle-color': '#e5484d', 'circle-opacity': 0.22 } });
    map.addLayer({
      id: 'pois', type: 'circle', source: 'pois', minzoom: 12.8,
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, ['match', ['get', 't'], 'school', 2, 3], 15, ['match', ['get', 't'], 'school', 5, 7.5]],
        'circle-color': ['match', ['get', 't'], 'hospital', COLORS.hospital, 'school', COLORS.school, COLORS.police],
        'circle-stroke-color': '#fff', 'circle-stroke-width': 1.2, 'circle-opacity': 0.55, 'circle-stroke-opacity': 0.6
      }
    });
    map.addLayer({
      id: 'pois-wet', type: 'circle', source: 'pois', filter: wetFilter(0, true),
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, ['match', ['get', 't'], 'school', 3.5, 5], 15, ['match', ['get', 't'], 'school', 7, 10]],
        'circle-color': ['match', ['get', 't'], 'hospital', COLORS.hospital, 'school', COLORS.school, COLORS.police],
        'circle-stroke-color': '#111827', 'circle-stroke-width': 2
      }
    });

    const pop = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 12, className: 'pop' });
    ['pois', 'pois-wet'].forEach(id => {
      map.on('mouseenter', id, e => {
        map.getCanvas().style.cursor = 'pointer';
        const p = e.features[0].properties;
        pop.setLngLat(e.features[0].geometry.coordinates).setHTML(poiHtml(p)).addTo(map);
      });
      map.on('mouseleave', id, () => { map.getCanvas().style.cursor = ''; pop.remove(); });
    });
    map.on('click', async e => {
      if (S.mode === 'storm') return;
      if (S.mode !== 'flood') {
        if (openPop) openPop.remove();
        const h = S.mode === 'soc' ? SC.probe(e.lngLat.lng, e.lngLat.lat) : CL.probe(e.lngLat.lng, e.lngLat.lat);
        if (h) { openPop = new maplibregl.Popup({ offset: 8, className: 'pop', maxWidth: '280px' }).setLngLat(e.lngLat).setHTML(h).addTo(map); ripple(e.point); }
        return;
      }
      const hit = map.queryRenderedFeatures(e.point, { layers: ['pois-wet', 'pois'] });
      if (hit.length) { pop.remove(); openPoi(hit[0].properties, hit[0].geometry.coordinates); return; }
      inspect([e.lngLat.lng, e.lngLat.lat]);
    });
    pulse();
    CL.init({
      map, S, t, fmt, esc, $, $$, loc, MOTION, getJson, vnNow, lat2y, y2lat, firstSymbol,
      padding: () => padding(true), setHero, bootDone: () => $('#boot').classList.add('gone'),
      pickCity: k => { if (k !== S.city) selectCity(k); }
    });
    const RF = { map, S, t, fmt, esc, $, $$, loc, MOTION, getJson, vnNow, tween, metersBetween, elevAtAsync, padding: () => padding(), animateTo };
    RK.init(RF);
    ST.init({ ...RF, setHero, bootDone: () => $('#boot').classList.add('gone'), firstSymbol });
    SC.init({ ...RF, setHero, bootDone: () => $('#boot').classList.add('gone'), firstSymbol });
    setMode(S.mode, true);
  }
  function fc(f) { return { type: 'FeatureCollection', features: f }; }
  function wetFilter(lv, poi) {
    const f = ['all', ['>', ['get', 'e'], 0], ['<=', ['get', 'e'], Math.floor(lv)]];
    return f;
  }
  function poiHtml(p) {
    const lv = Math.floor(S.lv), wet = p.e > 0 && p.e <= lv;
    const tn = t(p.t === 'hospital' ? 'tHospital' : p.t === 'school' ? 'tSchool' : 'tPolice');
    return `<b>${esc(p.n || tn)}</b><span class="pt">${esc(tn)}</span><span class="pe ${wet ? 'wet' : ''}">${t(wet && S.lv - p.e < 0.5 ? 'itemSubLow' : 'itemSub', { e: p.e === 99 ? '?' : p.e, d: wet ? fmt(S.lv - p.e, 1) : '0' })}</span>`;
  }
  let openPop;
  function openPoi(p, c) {
    if (openPop) openPop.remove();
    openPop = new maplibregl.Popup({ offset: 12, className: 'pop', maxWidth: '300px' }).setLngLat(c).setHTML(poiHtml(p)).addTo(map);
  }
  async function inspect(pt) {
    if (openPop) openPop.remove();
    const e = await elevAtAsync(pt[0], pt[1]);
    const L = S.live[S.city], D = S.data[S.city];
    let h = '';
    if (e == null) return;
    if (e <= 0) h = `<b>${t('pWater')}</b>`;
    else {
      h = `<b>${t('pElev', { e })}</b>`;
      if (L && L.tide) { const d = e - L.tide.peak; h += `<span class="pt ${d < 0 ? 'wet' : ''}">${t(d < 0 ? 'pBelow' : 'pAbove', { d: fmt(Math.abs(d), 1) })}</span>`; }
      const wet = e <= Math.floor(S.lv);
      h += `<span class="pe ${wet ? 'wet' : 'dry'}">${t(wet ? 'pWet' : 'pDry', { lv: fmt(S.lv, 1) })}</span>`;
    }
    const rpBtn = `<button class="rp-btn" data-rp><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 3h7l5 5v13H7zM14 3v5h5M10 13h6M10 17h6"/></svg>${t('rpBtn')}</button>`;
    if (D) {
      let best = null, bd = Infinity;
      D.pois.forEach(p => { if (p.t !== 'hospital') return; const d = metersBetween(pt, p.c); if (d < bd) { bd = d; best = p; } });
      if (best && bd < 15000) h += `<div class="near"><small>${t('pNear')}</small><b>${esc(best.n || t('tHospital'))}</b><span>${t('pDist', { d: bd < 1000 ? fmt(bd, 0) + ' m' : fmt(bd / 1000, 1) + ' km', e: best.e })}</span></div>`;
    }
    openPop = new maplibregl.Popup({ offset: 8, className: 'pop', maxWidth: '300px' }).setLngLat(pt).setHTML(h + rpBtn).addTo(map);
    const rb = openPop.getElement().querySelector('[data-rp]');
    if (rb) rb.addEventListener('click', () => { openPop.remove(); RK.report(pt); });
    ripple(map.project(pt));
  }
  function ripple(p) {
    if (!MOTION) return;
    const r = document.createElement('span'); r.className = 'ripple';
    r.style.left = p.x + 'px'; r.style.top = p.y + 'px';
    $('#map').appendChild(r); setTimeout(() => r.remove(), 900);
  }
  function pulse() {
    const t0 = performance.now();
    const step = now => {
      const k = ((now - t0) % 1600) / 1600;
      if (map.getLayer('poi-halo')) { map.setPaintProperty('poi-halo', 'circle-radius', 6 + k * 18); map.setPaintProperty('poi-halo', 'circle-opacity', 0.32 * (1 - k)); }
      if (MOTION) setTimeout(() => frame(step), 60);
    };
    frame(step);
  }

  /* ---------------- 도시 고르기 ---------------- */
  let loadSeq = 0;
  async function selectCity(key, first) {
    S.city = key;
    renderCities(); syncUrl();
    RK.onCity();
    if (S.mode !== 'flood') { if (openPop) openPop.remove(); if (S.mode === 'storm') ST.onCity(); else if (S.mode === 'soc') SC.onCity(); else CL.onCity(); return; }
    const seq = ++loadSeq;
    const c = S.cities[key];
    $('#lv').max = MAXLV[key];
    $('.ticks').innerHTML = Array.from({ length: 7 }, (_, i) => `<span>${fmt(MAXLV[key] * i / 6, MAXLV[key] % 6 ? 1 : 0)}${i === 6 ? ' m' : ''}</span>`).join('');
    document.body.classList.add('loading');
    if (openPop) openPop.remove();
    const pad = padding();
    map.flyTo({ center: c.center, zoom: c.zoom - (innerWidth < 900 ? 0.6 : 0), duration: MOTION ? (first ? 3800 : 2200) : 0, padding: pad, essential: true, pitch: S.is3d ? 55 : 0 });
    const [D, L] = await Promise.all([prepareCity(key), loadLive(key).catch(() => ({})), RK.load(key), RK.loadSlr()]);
    if (seq !== loadSeq || S.mode !== 'flood') return;
    const [w, s, e, n] = c.bbox;
    map.getSource('bbox').setData(fc([{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [[w, s], [e, s], [e, n], [w, n], [w, s]] } }]));
    map.getSource('pois').setData(fc(D.pois.map(p => ({ type: 'Feature', properties: { t: p.t, n: p.n, e: p.e, i: p.i }, geometry: { type: 'Point', coordinates: p.c } }))));
    map.getSource('roads').setData(fc(D.segs.filter(s => s.e > 0 && s.e <= MAXLV[key]).map(s => ({ type: 'Feature', properties: { e: s.e }, geometry: { type: 'LineString', coordinates: s.c } }))));
    S.floodCity = key;
    document.body.classList.remove('loading');
    $('#boot').classList.add('gone');
    renderLive(); renderHero(); renderSources(); RK.onReady();
    const target = L && L.tide ? Math.floor(L.tide.peak * 10) / 10 : Math.min(MAXLV[key], Math.max(1, D.median - 2));
    $('#btnTide').hidden = !(L && L.tide);
    placeTideMark();
    const startLv = qs.get('lv') && first ? +qs.get('lv') : target;
    setLevel(0, true); updateImpact();
    setTimeout(() => animateTo(startLv, first ? 2600 : 1800), first && MOTION ? 2400 : 300);
  }
  function padding(wide) {
    // 전국 보기는 머리 카드·범례에 가리지 않게 실제 높이만큼 비운다
    const hh = $('#hero').offsetHeight, lh = $('#legend').offsetHeight;
    if (innerWidth < 900) return wide ? { top: hh + 34, bottom: lh + 30, left: 40, right: 70 } : { top: 20, bottom: 20, left: 20, right: 20 };
    const r = innerWidth <= 1240 ? 446 : 500;
    return wide ? { top: 40, bottom: 40, left: Math.min(660, innerWidth - r - 300), right: r + 90 } : { top: 140, bottom: 40, left: 40, right: r };
  }

  /* ---------------- 모드 ---------------- */
  function setMode(m, first) {
    const prev = first ? null : S.mode;
    S.mode = m;
    document.body.dataset.mode = m;
    $$('#modes [data-mode]').forEach(b => { b.classList.toggle('on', b.dataset.mode === m); b.setAttribute('aria-selected', b.dataset.mode === m); });
    syncUrl();
    if (openPop) openPop.remove();
    if (m === 'flood') {
      CL.leave(); ST.leave(); SC.leave();
      FLOOD_LAYERS.forEach(id => map.getLayer(id) && map.setLayoutProperty(id, 'visibility', (id === 'roads' || id === 'roads-glow') && !S.roadsOn ? 'none' : 'visible'));
      renderLegend();
      if (S.floodCity === S.city && S.data[S.city]) {
        renderHero(); renderSources(); RK.update();
        const c = S.cities[S.city];
        map.flyTo({ center: c.center, zoom: c.zoom - (innerWidth < 900 ? 0.6 : 0), duration: MOTION ? 1800 : 0, padding: padding(), essential: true });
      } else selectCity(S.city, first);
    } else {
      if (prev === 'flood' || first) {
        FLOOD_LAYERS.forEach(id => map.getLayer(id) && map.setLayoutProperty(id, 'visibility', 'none'));
        if (S.is3d) $('#btn3d').click();
        RK.leave();
      }
      const OTHER = { storm: ST, soc: SC };
      [CL, ST, SC].forEach(x => { if (x !== (OTHER[m] || CL)) x.leave(); });
      if (OTHER[m]) OTHER[m].enter(first); else CL.enter(m, first);
    }
  }
  function syncUrl() {
    try {
      const u = new URL(location.href);
      u.searchParams.set('city', S.city);
      if (S.mode === 'flood') u.searchParams.delete('mode'); else u.searchParams.set('mode', S.mode);
      history.replaceState(null, '', u);
    } catch (e) {}
  }
  function setHero(h, s) {
    const hero = $('#hero');
    hero.classList.remove('in'); void hero.offsetWidth; hero.classList.add('in');
    $('#headline').innerHTML = h; $('#subline').textContent = s;
  }

  /* ---------------- 물 높이 ---------------- */
  let raf = 0, anim = 0;
  function setLevel(lv, quiet) {
    S.lv = Math.max(0, Math.min(MAXLV[S.city], lv));
    $('#lv').value = S.lv;
    $('#lvNum').textContent = fmt(S.lv, 1);
    $('#lv').style.setProperty('--p', (S.lv / MAXLV[S.city] * 100) + '%');
    const fl = Math.floor(S.lv);
    if (fl !== S.lvShown && map && map.getSource('flood')) {
      S.lvShown = fl;
      map.getSource('flood').setTiles(['flood://{z}/{x}/{y}?lv=' + fl]);
      const f = wetFilter(fl);
      ['roads', 'roads-glow', 'pois-wet', 'poi-halo'].forEach(id => map.setFilter(id, f));
      if (!quiet) updateImpact();
    }
  }
  function animateTo(to, dur = 2200) {
    cancelAnimationFrame(raf);
    const gen = ++anim, from = S.lv, t0 = performance.now();
    if (!MOTION) { setLevel(to); updateImpact(); return; }
    const step = now => {
      if (gen !== anim) return;
      const k = Math.min(1, (now - t0) / dur), e = k < .5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
      setLevel(from + (to - from) * e);
      if (k < 1) raf = frame(step); else updateImpact();
    };
    raf = frame(step);
  }
  function updateImpact() {
    const D = S.data[S.city]; if (!D) return;
    const fl = Math.floor(S.lv);
    const area = landBelow(D, S.lv);
    tween($('#kArea'), area, area < 10 ? 1 : 0);
    const pct = D.land ? area / D.land * 100 : 0;
    $('#kAreaBar').style.width = Math.min(100, pct) + '%';
    $('#kAreaPct').textContent = t('kAreaPct', { p: fmt(pct, 1) });
    $('#impactLv').textContent = t('asl') + ' ' + fmt(fl, 0) + ' m';
    TYPES.forEach(ty => {
      const all = D.pois.filter(p => p.t === ty), wet = all.filter(p => p.e > 0 && p.e <= fl);
      const id = ty === 'hospital' ? 'Hospital' : ty === 'school' ? 'School' : 'Police';
      tween($('#k' + id), wet.length, 0);
      $('#k' + id + 'Of').textContent = t('ofN', { n: fmt(all.length) });
    });
    tween($('#kRoad'), roadBelow(D, S.lv), 0);
    $$('.kpi').forEach(b => b.classList.toggle('on', b.dataset.type === S.listType));
    RK.update();
    renderList();
  }
  function renderList() {
    const D = S.data[S.city]; if (!D) return;
    const fl = Math.floor(S.lv), ty = S.listType === 'road' ? 'hospital' : S.listType;
    const tn = t(ty === 'hospital' ? 'tHospital' : ty === 'school' ? 'tSchool' : 'tPolice');
    // 큰 병원(종합병원)·이름 있는 곳을 먼저, 같은 등급이면 낮은 곳부터
    const rank = p => (p.s === 'hospital' || p.s === 'university' ? 0 : 1) + (p.n ? 0 : 2);
    const wet = D.pois.filter(p => p.t === ty && p.e > 0 && p.e <= fl).sort((a, b) => rank(a) - rank(b) || a.e - b.e);
    $('#listTitle').textContent = wet.length ? t('listWet', { type: S.lang === 'en' ? tn.toLowerCase() : tn, n: fmt(wet.length) }) : t('listNoneT', { type: S.lang === 'en' ? tn.toLowerCase() : tn });
    const show = wet.slice(0, 8);
    $('#flist').innerHTML = show.map(p => `<li><button data-i="${p.i}"><i class="dot ${p.t}"></i><span class="fn">${esc(p.n || tn)}</span><span class="fd">${t(S.lv - p.e < 0.5 ? 'itemSubLow' : 'itemSub', { e: p.e, d: fmt(S.lv - p.e, 1) })}</span></button></li>`).join('') + (wet.length > 8 ? `<li class="more">${t('listMore', { n: fmt(wet.length - 8) })}</li>` : '');
    $$('#flist [data-i]').forEach(b => b.addEventListener('click', () => {
      const p = D.pois[+b.dataset.i];
      map.flyTo({ center: p.c, zoom: 15.2, duration: MOTION ? 1400 : 0, padding: padding() });
      setTimeout(() => openPoi({ t: p.t, n: p.n, e: p.e }, p.c), MOTION ? 1300 : 0);
      if (innerWidth < 900) scrollTo({ top: 0, behavior: MOTION ? 'smooth' : 'auto' });
    }));
  }

  /* ---------------- 화면 그리기 ---------------- */
  function renderCities() {
    $('#cities').innerHTML = ORDER.map(k => `<button role="tab" data-city="${k}" class="${k === S.city ? 'on' : ''}" aria-selected="${k === S.city}">${esc(t('city_' + k))}</button>`).join('');
    $$('#cities [data-city]').forEach(b => b.addEventListener('click', () => { if (b.dataset.city !== S.city) selectCity(b.dataset.city); }));
  }
  function renderLive() {
    const L = S.live[S.city] || {};
    $('#upd').textContent = L.at ? t('upd', { t: L.at }) : '';
    const tide = $('#lcTide');
    if (L.tide) {
      const series = L.tide.series.map(h => h.v), pk = series.indexOf(Math.max(...series.slice(0, 24)));
      tide.innerHTML = `<h3>${t('tideT')}</h3><div class="lv-v"><b>${fmt(L.tide.now, 2)}</b><span>m · ${t('tideNow')}</span></div>${areaChart(series, L.tide.nowIdx, '#2f6fe4', pk)}<p>${t('tidePeak', { v: fmt(L.tide.peak, 2), t: when(L.tide.peakAt) })}</p>`;
      tide.classList.remove('off');
    } else {
      tide.innerHTML = `<h3>${t('tideT')}</h3><p class="none">${t('tideNone')}</p>`;
      tide.classList.add('off');
    }
    $('#lcRain').innerHTML = L.rain ? `<h3>${t('rainT')}</h3><div class="lv-v"><b>${fmt(L.rain.sum, 1)}</b><span>${t('rainUnit')}</span></div>${barChart(L.rain.series, '#4f8ef7')}<p>${t('rainNow', { v: fmt(L.rain.now || 0, 1) })}</p>` : `<h3>${t('rainT')}</h3><p class="none">—</p>`;
    $('#lcRiver').innerHTML = L.river ? `<h3>${t('riverT')}</h3><div class="lv-v"><b>${fmt(L.river.now, 0)}</b><span>m³/s</span></div>${areaChart(L.river.series, L.river.nowIdx, '#0f9d76', -1)}<p>${t('riverSub', { v: fmt(L.river.d7, 0) })}</p>` : `<h3>${t('riverT')}</h3><p class="none">—</p>`;
  }
  function renderHero() {
    const D = S.data[S.city], L = S.live[S.city] || {};
    if (!D) return;
    const city = t('city_' + S.city);
    let h, s;
    if (L.tide) {
      const p = D.land ? landBelow(D, L.tide.peak) / D.land * 100 : 0;
      h = t('hTide', { city, p: `<em>${fmt(p, 0)}</em>` });
      s = t('sTide', { t: when(L.tide.peakAt), v: fmt(L.tide.peak, 2) });
      const pp = RK.peopleBelow(S.city, L.tide.peak);
      if (pp) s += ' ' + t('sPop', { n: RK.compact(pp) });
    } else {
      h = t('hInland', { city, m: `<em>${fmt(D.median, 0)}</em>` });
      s = t('sInland');
    }
    setHero(h, s);
  }
  function placeTideMark() {
    const L = S.live[S.city] || {}, m = $('#tideMark');
    if (!L.tide) { m.hidden = true; return; }
    m.hidden = false;
    m.style.left = (Math.min(1, L.tide.peak / MAXLV[S.city]) * 100) + '%';
    $('#tideMarkT').textContent = t('tidePeak', { v: fmt(L.tide.peak, 2), t: when(L.tide.peakAt) }).split('·')[0].trim();
  }
  function renderSources() {
    const D = S.data[S.city];
    const d = D && D.osmDate ? D.osmDate.slice(0, 4) + '-' + D.osmDate.slice(4, 6) + '-' + D.osmDate.slice(6, 8) : '';
    $('#srcs').innerHTML = ['src1', 'src2', 'src3', 'src4', 'src5', 'src6', 'src7'].map(k => `<li>${esc(t(k, { d }))}</li>`).join('');
    $('#caveat').textContent = t('caveat') + ' ' + t('cavRisk');
  }
  function renderLegend() {
    $('#legend').innerHTML = `
      <div class="lg-row"><span class="lg-k">${t('lgDepth')}</span><span class="lg-grad"></span><span class="lg-s">0 → 5 m+</span></div>
      <div class="lg-row"><span><i class="dot hospital"></i>${t('lgHosp')}</span><span><i class="dot school"></i>${t('lgSchool')}</span><span><i class="dot police"></i>${t('lgPolice')}</span><span><i class="ln"></i>${t('lgRoad')}</span><span><i class="sq iso"></i>${t('lgIso')}</span></div>`;
  }
  function applyLang() {
    document.documentElement.lang = S.lang;
    $$('[data-i]').forEach(el => { el.textContent = t(el.dataset.i); });
    $$('[data-lang]').forEach(b => b.classList.toggle('on', b.dataset.lang === S.lang));
    try { localStorage.setItem('fl-lang', S.lang); } catch (e) {}
    if (S.cities) renderCities();
    if (map && map.isStyleLoaded()) localize();
    const fl = S.mode === 'flood';
    if (fl) { renderLegend(); RK.onLang(); } else if (S.mode === 'storm') ST.onLang(); else if (S.mode === 'soc') SC.onLang(); else CL.onLang();
    if (S.data[S.city] && S.floodCity === S.city) { renderLive(); placeTideMark(); updateImpact(); $('#lvNum').textContent = fmt(S.lv, 1); if (fl) { renderHero(); renderSources(); } }
  }

  /* ---------------- 조작 ---------------- */
  $$('[data-lang]').forEach(b => b.addEventListener('click', () => { S.lang = b.dataset.lang; applyLang(); }));
  $$('#modes [data-mode]').forEach(b => b.addEventListener('click', () => { if (map && booted && b.dataset.mode !== S.mode) setMode(b.dataset.mode); }));
  $('#lv').addEventListener('input', e => { cancelAnimationFrame(raf); anim++; RK.onUserLevel(); setLevel(+e.target.value); });
  $('#lv').addEventListener('change', () => updateImpact());
  $('#btnPlay').addEventListener('click', () => { RK.onUserLevel(); setLevel(0, true); updateImpact(); setTimeout(() => animateTo(MAXLV[S.city], 6500), 150); });
  $('#btnTide').addEventListener('click', () => { RK.onUserLevel(); const L = S.live[S.city]; if (L && L.tide) animateTo(Math.floor(L.tide.peak * 10) / 10, 1400); });
  $$('.kpi').forEach(b => b.addEventListener('click', () => {
    if (b.dataset.type === 'road') { toggleRoads(true); return; }
    S.listType = b.dataset.type; updateImpact();
  }));
  function toggleRoads(force) {
    S.roadsOn = force === true ? true : !S.roadsOn;
    ['roads', 'roads-glow'].forEach(id => map.setLayoutProperty(id, 'visibility', S.roadsOn ? 'visible' : 'none'));
    $('#btnRoads').classList.toggle('on', S.roadsOn); $('#btnRoads').setAttribute('aria-pressed', S.roadsOn);
  }
  $('#btnRoads').addEventListener('click', () => toggleRoads());
  $('#btn3d').addEventListener('click', () => {
    S.is3d = !S.is3d;
    $('#btn3d').classList.toggle('on', S.is3d); $('#btn3d').setAttribute('aria-pressed', S.is3d);
    if (S.is3d) { map.setTerrain({ source: 'dem3d', exaggeration: S.city === 'hue' || S.city === 'danang' ? 2.2 : 6 }); map.easeTo({ pitch: 58, bearing: -18, duration: MOTION ? 1400 : 0 }); }
    else { map.setTerrain(null); map.easeTo({ pitch: 0, bearing: 0, duration: MOTION ? 1000 : 0 }); }
  });

  /* ---------------- 시작 ---------------- */
  // 빠진 글자 보충
  Object.assign(I.ko, { listWet: '잠기는 {type} {n}곳', listNoneT: '이 높이에서 잠기는 {type} 없음' });
  Object.assign(I.vi, { listWet: '{n} {type} bị ngập', listNoneT: 'Không có {type} bị ngập ở mực nước này' });
  Object.assign(I.en, { listWet: '{n} {type} under water', listNoneT: 'No {type} under water at this level' });

  document.body.dataset.mode = S.mode;
  $$('#modes [data-mode]').forEach(b => b.classList.toggle('on', b.dataset.mode === S.mode));
  applyLang();
  fetch('data/cities.json').then(r => r.json()).then(c => { S.cities = c; renderCities(); initMap(); });
  window.__fl = { S, setLevel, animateTo, selectCity, elevAt, landBelow, setMode: m => setMode(m) };
})();

/* 태풍 모드 — GDACS 열대저기압 목록·경로를 받아 베트남 주변 바다만 보여 준다 */
(function () {
  'use strict';
  const ORDER = ['hcm', 'cantho', 'hanoi', 'hue', 'danang'];
  const AREA = [95, -5, 160, 40];         // 남중국해·서태평양
  const VIEW = [[96, 2], [150, 33]];
  const DAYS = 60;
  const ACTIVE_H = 24;                    // 마지막 자료가 이 시간 안이면 「활동 중」
  const AL = { Green: '#2fbf71', Orange: '#f08c2e', Red: '#e5484d' };
  let F, map, seq = 0;
  const T = { on: false, data: null, sel: null };

  const iso = d => d.toISOString().slice(0, 10);
  async function load() {
    if (T.data) return T.data;
    const to = new Date(), from = new Date(Date.now() - DAYS * 864e5);
    const j = await F.getJson(`https://www.gdacs.org/gdacsapi/api/events/geteventlist/SEARCH?eventlist=TC&fromDate=${iso(from)}&toDate=${iso(to)}&alertlevel=green;orange;red`);
    const evs = (j.features || []).filter(f => {
      const [x, y] = f.geometry.coordinates;
      return f.properties.eventtype === 'TC' && x >= AREA[0] && x <= AREA[2] && y >= AREA[1] && y <= AREA[3];
    }).map(f => f.properties);
    const now = Date.now();
    const out = evs.slice(0, 14).map(p => {
      const e = { id: p.eventid, ep: p.episodeid, name: (p.eventname || p.name).replace(/-\d+$/, ''), alert: p.alertlevel, from: p.fromdate, to: p.todate, src: p.source,
        wind: p.severitydata && p.severitydata.severity, report: p.url && p.url.report, lines: [], polys: [], pos: null };
      e.active = now - Date.parse(p.todate + 'Z') < ACTIVE_H * 3600e3;
      e.geo = p.url.geometry;
      return e;
    });
    T.data = { evs: out.sort((a, b) => Date.parse(b.to) - Date.parse(a.to)), at: new Date(Date.now() + 7 * 3600e3).toISOString().slice(11, 16) };
    return T.data;
  }
  // 경로는 하나씩 받아 오는 대로 그린다(GDACS 응답이 느림)
  let tracksP = null;
  function loadTracks(onEach) {
    if (tracksP) return tracksP;
    tracksP = Promise.all(T.data.evs.map(async e => {
      try {
        const g = await F.getJson(e.geo, 2);
        g.features.forEach(f => {
          const c = f.properties.Class || '';
          if (f.geometry.type === 'LineString') e.lines.push({ c: f.geometry.coordinates, fc: !!f.properties.forecast });
          else if (f.geometry.type === 'Point' && c === 'Point_Centroid') e.pos = f.geometry.coordinates;
          else if (e.active && /Polygon/.test(f.geometry.type) && /^Poly_/.test(c)) e.polys.push({ g: f.geometry, a: c.slice(5) });
        });
      } catch (err) { e.failed = true; }
      e.done = true; onEach();
    })).then(() => { T.data.evs = T.data.evs.filter(x => x.lines.length || !x.failed); });
    return tracksP;
  }
  // 경로 점과 도시 중심 사이 가장 짧은 직선거리(km)
  function closest(e, k) {
    const c = F.S.cities[k].center; let best = Infinity;
    e.lines.forEach(l => { if (l.fc) return; l.c.forEach(p => { best = Math.min(best, F.metersBetween(p, c)); }); });
    return best / 1000;
  }
  function nearestCity(e) {
    let b = null; ORDER.forEach(k => { const d = closest(e, k); if (!b || d < b.d) b = { k, d }; }); return b;
  }

  /* ---------------- 지도 ---------------- */
  function fc(f) { return { type: 'FeatureCollection', features: f }; }
  function setupMap() {
    if (map.getSource('st-line')) return;
    const before = F.firstSymbol();
    map.addSource('st-poly', { type: 'geojson', data: fc([]) });
    map.addLayer({ id: 'st-poly', type: 'fill', source: 'st-poly', paint: { 'fill-color': ['get', 'col'], 'fill-opacity': 0.14 } }, before);
    map.addSource('st-line', { type: 'geojson', data: fc([]) });
    map.addLayer({ id: 'st-line-glow', type: 'line', source: 'st-line', filter: ['!', ['get', 'fc']], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': ['get', 'col'], 'line-width': ['case', ['get', 'sel'], 12, 7], 'line-opacity': 0.18 } });
    map.addLayer({ id: 'st-line', type: 'line', source: 'st-line', filter: ['!', ['get', 'fc']], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': ['get', 'col'], 'line-width': ['case', ['get', 'sel'], 3.6, 2.2], 'line-opacity': ['case', ['get', 'dim'], 0.35, 1] } });
    map.addLayer({ id: 'st-line-fc', type: 'line', source: 'st-line', filter: ['get', 'fc'], paint: { 'line-color': ['get', 'col'], 'line-width': 2, 'line-dasharray': [1.5, 1.5], 'line-opacity': ['case', ['get', 'dim'], 0.35, 1] } });
    map.addSource('st-pt', { type: 'geojson', data: fc([]) });
    map.addLayer({ id: 'st-pt-halo', type: 'circle', source: 'st-pt', filter: ['get', 'active'], paint: { 'circle-radius': 18, 'circle-color': ['get', 'col'], 'circle-opacity': 0.25 } });
    map.addLayer({ id: 'st-pt', type: 'circle', source: 'st-pt', paint: { 'circle-radius': ['case', ['get', 'active'], 7, 4.5], 'circle-color': ['get', 'col'], 'circle-stroke-color': '#fff', 'circle-stroke-width': 2 } });
    map.addLayer({ id: 'st-lbl', type: 'symbol', source: 'st-pt', layout: { 'text-field': ['get', 'n'], 'text-font': ['Noto Sans Bold'], 'text-size': 12.5, 'text-offset': [0, 1.25], 'text-anchor': 'top', 'text-allow-overlap': false }, paint: { 'text-color': '#111827', 'text-halo-color': '#fff', 'text-halo-width': 1.6 } });
    map.addSource('st-city', { type: 'geojson', data: fc(ORDER.map(k => ({ type: 'Feature', properties: { k }, geometry: { type: 'Point', coordinates: F.S.cities[k].center } }))) });
    map.addLayer({ id: 'st-city', type: 'circle', source: 'st-city', paint: { 'circle-radius': ['case', ['==', ['get', 'k'], F.S.city], 6, 4], 'circle-color': '#111827', 'circle-stroke-color': '#fff', 'circle-stroke-width': 1.5 } });
    ['st-line', 'st-pt'].forEach(id => {
      map.on('click', id, e => { if (T.on) pick(e.features[0].properties.id); });
      map.on('mouseenter', id, () => { if (T.on) map.getCanvas().style.cursor = 'pointer'; });
      map.on('mouseleave', id, () => { map.getCanvas().style.cursor = ''; });
    });
    pulse();
  }
  const LAYERS = ['st-poly', 'st-line-glow', 'st-line', 'st-line-fc', 'st-pt-halo', 'st-pt', 'st-lbl', 'st-city'];
  function vis(v) { LAYERS.forEach(id => map.getLayer(id) && map.setLayoutProperty(id, 'visibility', v ? 'visible' : 'none')); }
  function paintData() {
    const evs = T.data.evs;
    const L = [], P = [], G = [];
    evs.forEach(e => {
      const col = AL[e.alert] || AL.Green, sel = T.sel === e.id, dim = T.sel != null && !sel;
      e.lines.forEach(l => L.push({ type: 'Feature', properties: { id: e.id, col, fc: l.fc, sel, dim }, geometry: { type: 'LineString', coordinates: l.c } }));
      if (e.pos) P.push({ type: 'Feature', properties: { id: e.id, col, n: e.name, active: e.active }, geometry: { type: 'Point', coordinates: e.pos } });
      e.polys.forEach(p => G.push({ type: 'Feature', properties: { col: AL[p.a] || col }, geometry: p.g }));
    });
    map.getSource('st-line').setData(fc(L)); map.getSource('st-pt').setData(fc(P)); map.getSource('st-poly').setData(fc(G));
    map.setPaintProperty('st-city', 'circle-radius', ['case', ['==', ['get', 'k'], F.S.city], 6.5, 4]);
  }
  function pulse() {
    let t0 = performance.now();
    const step = () => {
      if (!map.getLayer('st-pt-halo')) return;
      if (T.on) { const k = ((performance.now() - t0) % 1800) / 1800; map.setPaintProperty('st-pt-halo', 'circle-radius', 8 + k * 22); map.setPaintProperty('st-pt-halo', 'circle-opacity', 0.35 * (1 - k)); }
      if (F.MOTION) setTimeout(step, 70);
    };
    step();
  }
  function pick(id) {
    T.sel = T.sel === id ? null : id;
    paintData(); renderList();
    const e = T.data.evs.find(x => x.id === id);
    if (T.sel != null && e) {
      const pts = e.lines.flatMap(l => l.c);
      const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
      map.fitBounds([[Math.min(...xs, F.S.cities[F.S.city].center[0]), Math.min(...ys, F.S.cities[F.S.city].center[1])], [Math.max(...xs), Math.max(...ys)]], { padding: F.padding(), duration: F.MOTION ? 1400 : 0, maxZoom: 6.5 });
    } else map.fitBounds(VIEW, { padding: F.padding(), duration: F.MOTION ? 1200 : 0 });
  }

  /* ---------------- 패널 ---------------- */
  const day = s => new Date(s + 'Z').toLocaleDateString(F.loc(), { month: 'short', day: 'numeric', timeZone: 'Asia/Bangkok' });
  function renderList() {
    const evs = T.data.evs, k = F.S.city, city = F.t('city_' + k);
    F.$('#stUpd').textContent = F.t('upd', { t: T.data.at });
    F.$('#stT').textContent = F.t('stListT', { n: DAYS });
    F.$('#stList').innerHTML = evs.length ? evs.map((e, i) => {
      const d = closest(e, k);
      return `<li style="animation-delay:${i * 40}ms"><button data-id="${e.id}" class="${T.sel === e.id ? 'on' : ''}">
        <i class="al" style="--c:${AL[e.alert] || AL.Green}"></i>
        <span class="sn"><b>${F.esc(e.name)}</b>${e.active ? `<em class="live-tag">${F.esc(F.t('stActive'))}</em>` : ''}<small>${F.esc(day(e.from))} – ${F.esc(day(e.to))} · ${F.esc(F.t('al' + e.alert))}</small></span>
        <span class="sd">${isFinite(d) ? `<b>${F.fmt(Math.round(d / 10) * 10, 0)}</b><small>km</small>` : `<b class="wait">…</b>`}<small class="sc">${F.esc(F.t('stFrom', { city }))}</small></span>
        <span class="sw">${e.wind ? F.esc(F.t('stWind', { v: F.fmt(e.wind, 0) })) : ''}</span></button></li>`;
    }).join('') : `<li class="none">${F.esc(F.t('stNone'))}</li>`;
    F.$$('#stList [data-id]').forEach(b => b.addEventListener('click', () => pick(+b.dataset.id)));
  }
  function renderHero() {
    const evs = T.data.evs, act = evs.filter(e => e.active);
    let best = null; evs.forEach(e => { const n = nearestCity(e); if (n && isFinite(n.d) && (!best || n.d < best.d)) best = { ...n, e }; });
    const pending = evs.some(e => !e.done);
    const h = act.length ? F.t('hStormNow', { n: `<em>${F.fmt(act.length)}</em>` }) : F.t('hStormNone');
    const s = pending ? F.t('stTracks') : best ? F.t('sStorm', { n: F.fmt(evs.length), days: DAYS, name: best.e.name, city: F.t('city_' + best.k), d: F.fmt(Math.round(best.d / 10) * 10, 0) }) : F.t('sStormEmpty', { days: DAYS });
    F.setHero(h, s);
  }
  function renderLegend() {
    F.$('#legend').innerHTML = `<div class="lg-row"><span class="lg-k">${F.esc(F.t('lgStorm'))}</span></div><div class="lg-row">${['Green', 'Orange', 'Red'].map(a => `<span><i class="dot" style="background:${AL[a]}"></i>${F.esc(F.t('al' + a))}</span>`).join('')}<span><i class="ln dash"></i>${F.esc(F.t('lgFc'))}</span></div>`;
  }
  function renderSources() {
    F.$('#srcs').innerHTML = ['srcSt1', 'srcSt2'].map(x => `<li>${F.esc(F.t(x))}</li>`).join('');
    F.$('#caveat').textContent = F.t('cavStorm');
  }

  window.ST = {
    init(f) { F = f; map = f.map; },
    async enter(first) {
      const my = ++seq; T.on = true;
      document.body.classList.add('loading');
      renderLegend();
      let D;
      try { D = await load(); } catch (e) { if (my === seq) { document.body.classList.remove('loading'); F.setHero(F.t('stFail'), ''); F.bootDone(); } return; }
      if (my !== seq || !T.on) return;
      setupMap(); vis(true); paintData();
      renderList(); renderHero(); renderSources();
      document.body.classList.remove('loading'); F.bootDone();
      let tm = 0;
      const refresh = () => { clearTimeout(tm); tm = setTimeout(() => { if (!T.on) return; paintData(); renderList(); }, 250); };
      loadTracks(refresh).then(() => { if (T.on) { paintData(); renderList(); renderHero(); } });
      map.fitBounds(VIEW, { padding: F.padding(), duration: F.MOTION ? (first ? 3000 : 1600) : 0, pitch: 0, bearing: 0 });
    },
    leave() { seq++; T.on = false; T.sel = null; if (map && map.getLayer('st-line')) vis(false); },
    onCity() { if (!T.on || !T.data) return; paintData(); renderList(); },
    onLang() { if (!T.on || !T.data) return; renderList(); renderHero(); renderLegend(); renderSources(); },
    _T: T
  };
})();

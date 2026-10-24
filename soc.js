/* 생활권 모드 — 생활 SOC(공원·학교·보건·시장 등)까지 걸어서 닿는지, 인구 칸마다 칠한다 */
(function () {
  'use strict';
  const CAT_COL = { park: '#2fa36b', kinder: '#f59f00', school: '#e8590c', health: '#e5484d', market: '#a855f7', sports: '#0ea5e9', culture: '#db2777', bus: '#475569', civic: '#2563eb' };
  let F, map, seq = 0, cv;
  const SC = { on: false, data: {}, cat: 'all' };

  async function load(key) {
    if (SC.data[key]) return SC.data[key];
    const [j, d, meta, pop] = await Promise.all([
      fetch(`data/soc_${key}.json`).then(r => r.json()), fetch(`data/soc_${key}_d.bin`).then(r => r.arrayBuffer()),
      fetch(`data/risk_${key}.json`).then(r => r.json()), fetch(`data/risk_${key}_pop.bin`).then(r => r.arrayBuffer())
    ]);
    const D = { ...j, d: new Uint8Array(d), g: meta.grid, pop: new Uint16Array(pop) };
    // 칸마다 500m 안에 있는 종류 수 → 인구 가중 평균
    const K = D.cats.length; let s = 0, P = 0;
    for (let i = 0; i < D.pop.length; i++) { const p = D.pop[i]; if (!p) continue; let c = 0; for (let k = 0; k < K; k++) if (D.d[i * K + k] * D.unit <= 500) c++; s += c * p; P += p; }
    D.avg = P ? s / P : 0;
    SC.data[key] = D;
    return D;
  }

  /* ---------------- 지도 ---------------- */
  function setup() {
    if (map.getSource('soc')) return;
    cv = document.createElement('canvas'); cv.width = cv.height = 1;
    const before = F.firstSymbol();
    map.addSource('soc', { type: 'image', url: cv.toDataURL(), coordinates: [[0, 1], [1, 1], [1, 0], [0, 0]] });
    map.addLayer({ id: 'soc', type: 'raster', source: 'soc', paint: { 'raster-opacity': 0.78, 'raster-fade-duration': 0, 'raster-resampling': 'nearest' } }, before);
    map.addSource('soc-pt', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addLayer({ id: 'soc-pt', type: 'circle', source: 'soc-pt', paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 11, 2.4, 15, 6], 'circle-color': ['get', 'col'], 'circle-stroke-color': '#fff', 'circle-stroke-width': 1.2 } });
    map.addSource('soc-box', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addLayer({ id: 'soc-box', type: 'line', source: 'soc-box', paint: { 'line-color': '#111827', 'line-width': 1.2, 'line-dasharray': [3, 3], 'line-opacity': 0.45 } });
    const pop = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 10, className: 'pop' });
    map.on('mouseenter', 'soc-pt', e => { if (!SC.on) return; map.getCanvas().style.cursor = 'pointer'; const p = e.features[0].properties; pop.setLngLat(e.features[0].geometry.coordinates).setHTML(`<b>${F.esc(p.n || F.t('soc_' + p.t))}</b><span class="pt">${F.esc(F.t('soc_' + p.t))}</span>`).addTo(map); });
    map.on('mouseleave', 'soc-pt', () => { map.getCanvas().style.cursor = ''; pop.remove(); });
  }
  const vis = v => ['soc', 'soc-pt', 'soc-box'].forEach(id => map.getLayer(id) && map.setLayoutProperty(id, 'visibility', v ? 'visible' : 'none'));
  // 거리 색: 500m 안 초록 · 1km 안 노랑 · 그 밖 빨강 / 「전체」는 500m 안 종류 수
  const ALL_RAMP = [[0, [214, 40, 57]], [2, [240, 120, 60]], [4, [245, 190, 70]], [6, [150, 205, 110]], [8, [40, 160, 110]]];
  function rampAll(c) { let a = ALL_RAMP[0], b = ALL_RAMP[ALL_RAMP.length - 1]; for (let i = 0; i < ALL_RAMP.length - 1; i++) if (c >= ALL_RAMP[i][0] && c <= ALL_RAMP[i + 1][0]) { a = ALL_RAMP[i]; b = ALL_RAMP[i + 1]; break; } const k = b[0] === a[0] ? 0 : (c - a[0]) / (b[0] - a[0]); return a[1].map((v, i) => Math.round(v + (b[1][i] - v) * k)); }
  function draw() {
    const D = SC.data[F.S.city]; if (!D) return;
    const g = D.g, K = D.cats.length, j = D.cats.indexOf(SC.cat);
    cv.width = g.cols; cv.height = g.rows;
    const cx = cv.getContext('2d'), img = cx.createImageData(g.cols, g.rows), d = img.data;
    for (let i = 0; i < g.cols * g.rows; i++) {
      const p = D.pop[i]; if (!p) continue;
      let col;
      if (j < 0) { let c = 0; for (let k = 0; k < K; k++) if (D.d[i * K + k] * D.unit <= 500) c++; col = rampAll(c); }
      else { const m = D.d[i * K + j] * D.unit; col = m <= 500 ? [40, 160, 110] : m <= 1000 ? [245, 190, 70] : [214, 40, 57]; }
      d[i * 4] = col[0]; d[i * 4 + 1] = col[1]; d[i * 4 + 2] = col[2]; d[i * 4 + 3] = 70 + 130 * Math.min(1, p / 250);
    }
    cx.putImageData(img, 0, 0);
    const e = g.w + g.cols * g.dx, s = g.n - g.rows * g.dy;
    map.getSource('soc').updateImage({ url: cv.toDataURL(), coordinates: [[g.w, g.n], [e, g.n], [e, s], [g.w, s]] });
    const pts = D.pois.filter(p => j < 0 ? p.t !== 'bus' : p.t === SC.cat);
    map.getSource('soc-pt').setData({ type: 'FeatureCollection', features: pts.map(p => ({ type: 'Feature', properties: { t: p.t, n: p.n, col: CAT_COL[p.t] }, geometry: { type: 'Point', coordinates: p.c } })) });
    const [w, ss, ee, n] = F.S.cities[F.S.city].bbox;
    map.getSource('soc-box').setData({ type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [[w, ss], [ee, ss], [ee, n], [w, n], [w, ss]] } }] });
  }

  /* ---------------- 패널 ---------------- */
  function renderPanel() {
    const D = SC.data[F.S.city]; if (!D) return;
    F.$('#scT').textContent = F.t('scListT', { city: F.t('city_' + F.S.city) });
    const rows = ['all', ...D.cats].map((c, i) => {
      if (c === 'all') return `<li style="animation-delay:0ms"><button data-c="all" class="${SC.cat === 'all' ? 'on' : ''}"><i class="sw all"></i><span class="sn">${F.esc(F.t('soc_all'))}</span><span class="sv"><b>${F.fmt(D.avg, 1)}</b><small>/ ${D.cats.length}</small></span><span class="sb sub">${F.esc(F.t('scAllSub'))}</span></button></li>`;
      const st = D.stats[c];
      return `<li style="animation-delay:${i * 35}ms"><button data-c="${c}" class="${SC.cat === c ? 'on' : ''}"><i class="sw" style="background:${CAT_COL[c]}"></i><span class="sn">${F.esc(F.t('soc_' + c))}<small>${F.esc(F.t('scN', { n: F.fmt(st.n) }))}</small></span><span class="sv"><b>${F.fmt(st.p500, 0)}</b><small>%</small></span><span class="sb"><i class="b5" style="width:${st.p500}%"></i><i class="b10" style="width:${Math.max(0, st.p1000 - st.p500)}%"></i></span></button></li>`;
    }).join('');
    F.$('#scList').innerHTML = rows;
    F.$$('#scList [data-c]').forEach(b => b.addEventListener('click', () => { SC.cat = b.dataset.c; draw(); renderPanel(); renderHero(); renderLegend(); }));
  }
  function renderHero() {
    const D = SC.data[F.S.city]; if (!D) return;
    const city = F.t('city_' + F.S.city);
    if (SC.cat === 'all') {
      let worst = D.cats[0]; D.cats.forEach(c => { if (c !== 'bus' && D.stats[c].p500 < D.stats[worst].p500) worst = c; });
      F.setHero(F.t('hSoc', { city, n: `<em>${F.fmt(D.avg, 1)}</em>`, k: D.cats.length }), F.t('sSoc', { c: F.t('soc_' + worst), p: F.fmt(100 - D.stats[worst].p500, 0) }));
    } else {
      const st = D.stats[SC.cat], miss = 100 - st.p500;
      F.setHero(F.t('hSocCat', { city, c: F.t('soc_' + SC.cat), p: `<em>${F.fmt(miss, 0)}%</em>` }), F.t('sSocCat', { n: F.fmt(st.n), p1: F.fmt(100 - st.p1000, 0), c: F.t('soc_' + SC.cat) }));
    }
  }
  function renderLegend() {
    const L = SC.cat === 'all'
      ? `<div class="lg-row"><span class="lg-k">${F.esc(F.t('lgSocAll'))}</span></div><div class="lg-bar" style="background:linear-gradient(90deg,${ALL_RAMP.map(([v, c]) => `rgb(${c.join(',')}) ${v / 8 * 100}%`).join(',')})"></div><div class="lg-ticks"><span>0</span><span>2</span><span>4</span><span>6</span><span>8+</span></div>`
      : `<div class="lg-row"><span class="lg-k">${F.esc(F.t('lgSocCat', { c: F.t('soc_' + SC.cat) }))}</span></div><div class="lg-row"><span><i class="sq" style="background:#28a06e"></i>${F.esc(F.t('lgS500'))}</span><span><i class="sq" style="background:#f5be46"></i>${F.esc(F.t('lgS1k'))}</span><span><i class="sq" style="background:#d62839"></i>${F.esc(F.t('lgSFar'))}</span></div>`;
    F.$('#legend').innerHTML = L;
  }
  function renderSources() {
    F.$('#srcs').innerHTML = ['srcSoc1', 'srcSoc2', 'srcSoc3'].map(x => `<li>${F.esc(F.t(x))}</li>`).join('');
    F.$('#caveat').textContent = F.t('cavSoc');
  }
  function probe(lon, lat) {
    const D = SC.data[F.S.city]; if (!D) return null;
    const g = D.g, q = Math.floor((lon - g.w) / g.dx), r = Math.floor((g.n - lat) / g.dy);
    if (q < 0 || r < 0 || q >= g.cols || r >= g.rows) return null;
    const i = r * g.cols + q, K = D.cats.length;
    const li = D.cats.map((c, k) => { const m = D.d[i * K + k] * D.unit; return `<li><i class="dot" style="background:${CAT_COL[c]}"></i>${F.esc(F.t('soc_' + c))}<b class="${m <= 500 ? 'ok' : m <= 1000 ? 'mid' : 'far'}">${D.d[i * K + k] === 255 ? '6km+' : m < 1000 ? F.fmt(Math.round(m / 50) * 50) + 'm' : F.fmt(m / 1000, 1) + 'km'}</b></li>`; }).join('');
    return `<b>${F.esc(F.t('scProbe'))}</b><span class="pt sm">${F.esc(F.t('scProbeSub', { p: F.fmt(D.pop[i]) }))}</span><ul class="soc-probe">${li}</ul>`;
  }

  window.SC = {
    init(f) { F = f; map = f.map; },
    async enter(first) {
      const my = ++seq; SC.on = true;
      document.body.classList.add('loading');
      let D;
      try { D = await load(F.S.city); } catch (e) { if (my === seq) { document.body.classList.remove('loading'); F.setHero(F.t('loadFail'), ''); F.bootDone(); } return; }
      if (my !== seq || !SC.on) return;
      setup(); vis(true); draw(); renderPanel(); renderHero(); renderLegend(); renderSources();
      document.body.classList.remove('loading'); F.bootDone();
      const c = F.S.cities[F.S.city];
      map.flyTo({ center: c.center, zoom: c.zoom - (innerWidth < 900 ? 0.6 : 0), duration: F.MOTION ? (first ? 2600 : 1600) : 0, padding: F.padding(), pitch: 0, bearing: 0, essential: true });
    },
    leave() { seq++; SC.on = false; if (map && map.getLayer('soc')) vis(false); },
    onCity() { if (SC.on) this.enter(); },
    onLang() { if (!SC.on || !SC.data[F.S.city]) return; renderPanel(); renderHero(); renderLegend(); renderSources(); },
    probe,
    _SC: SC
  };
})();

"""생활 SOC 걸어서 닿는 범위 — OpenStreetMap 시설(OpenFreeMap z14 타일)과 WorldPop 인구 칸(data/risk_<도시>_pop.bin)으로
종류마다 「가장 가까운 시설까지 직선거리」를 칸마다 구하고, 500m·1km 안에 사는 인구 비율을 낸다.

출력: data/soc_<도시>.json(종류별 개수·비율·시설 점), data/soc_<도시>_d.bin(칸×종류, 25m 단위 Uint8, 255=6.4km 이상)
쓰기: python3 tools/build_soc.py [도시 …]
"""
import sys, os, json, math
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
import numpy as np, mapbox_vector_tile
from scipy.spatial import cKDTree
sys.path.insert(0, os.path.dirname(__file__))
from build_city import CITIES, tile_xy, to_lonlat, fetch, Z

ROOT = os.path.join(os.path.dirname(__file__), '..')
CATS = ['park', 'kinder', 'school', 'health', 'market', 'sports', 'culture', 'bus', 'civic']
RULE = {  # OpenMapTiles poi (class, subclass) → 종류. subclass None = 그 class 전부
    ('park', None): 'park', ('garden', None): 'park', ('playground', None): 'park',
    ('school', 'kindergarten'): 'kinder', ('school', 'school'): 'school',
    ('hospital', None): 'health', ('pharmacy', None): 'health', ('dentist', None): 'health',
    ('grocery', 'marketplace'): 'market', ('grocery', 'supermarket'): 'market',
    ('sports_centre', None): 'sports', ('pitch', None): 'sports', ('swimming_pool', None): 'sports', ('stadium', None): 'sports',
    ('library', 'library'): 'culture', ('museum', None): 'culture', ('theatre', None): 'culture', ('cinema', None): 'culture',
    ('town_hall', 'community_centre'): 'culture',
    ('bus', 'bus_stop'): 'bus',
    ('town_hall', 'townhall'): 'civic', ('office', 'government'): 'civic', ('post', 'post_office'): 'civic',
}
UNIT = 25


def run(key, tiles_url):
    w, s, e, n = CITIES[key]['bbox']
    pad = 0.012  # 구역 밖 1km 남짓의 시설도 거리 계산에 넣는다(가장자리 사람이 손해 보지 않게)
    x0, y0 = tile_xy(w - pad, n + pad, Z); x1, y1 = tile_xy(e + pad, s - pad, Z)
    jobs = [(x, y) for x in range(x0, x1 + 1) for y in range(y0, y1 + 1)]
    def one(xy):
        raw = fetch(tiles_url.format(z=Z, x=xy[0], y=xy[1]))
        return xy, (mapbox_vector_tile.decode(raw) if raw else None)
    with ThreadPoolExecutor(8) as ex:
        res = list(ex.map(one, jobs))
    pts, seen = {c: [] for c in CATS}, set()
    inside = []
    for (x, y), d in res:
        if not d or 'poi' not in d:
            continue
        ext = d['poi'].get('extent', 4096)
        for f in d['poi']['features']:
            p = f['properties']
            if f['geometry']['type'] != 'Point':
                continue
            k = RULE.get((p.get('class'), p.get('subclass'))) or RULE.get((p.get('class'), None))
            if not k:
                continue
            px, py = f['geometry']['coordinates']
            if not (0 <= px < ext and 0 <= py < ext):
                continue
            lon, lat = to_lonlat(x, y, Z, px, py, ext)
            sk = (k, round(lon, 4), round(lat, 4))
            if sk in seen:
                continue
            seen.add(sk)
            pts[k].append((lon, lat))
            if w <= lon <= e and s <= lat <= n:
                inside.append({'t': k, 'n': p.get('name') or '', 'c': [round(lon, 5), round(lat, 5)]})
    meta = json.load(open(os.path.join(ROOT, 'data', f'risk_{key}.json')))
    g = meta['grid']
    pop = np.fromfile(os.path.join(ROOT, 'data', f'risk_{key}_pop.bin'), '<u2').astype(float)
    cols, rows = g['cols'], g['rows']
    kx = 111320 * math.cos(math.radians((s + n) / 2)); ky = 111320
    q = np.arange(cols * rows) % cols; r = np.arange(cols * rows) // cols
    cx = (g['w'] + (q + .5) * g['dx']) * kx; cy = (g['n'] - (r + .5) * g['dy']) * ky
    D = np.full((cols * rows, len(CATS)), 255, np.uint8)
    tot = pop.sum(); out = {}
    for j, c in enumerate(CATS):
        P = np.array(pts[c]) if pts[c] else np.zeros((0, 2))
        if len(P):
            tree = cKDTree(np.c_[P[:, 0] * kx, P[:, 1] * ky])
            dist, _ = tree.query(np.c_[cx, cy])
        else:
            dist = np.full(cols * rows, 1e9)
        D[:, j] = np.clip(np.round(dist / UNIT), 0, 255).astype(np.uint8)
        out[c] = {'n': sum(1 for p in inside if p['t'] == c),
                  'p500': round(float(pop[dist <= 500].sum() / tot * 100), 1),
                  'p1000': round(float(pop[dist <= 1000].sum() / tot * 100), 1),
                  'medM': int(np.round(np.median(np.repeat(dist, 1)[pop > 0]) if (pop > 0).any() else 0))}
    D.tofile(os.path.join(ROOT, 'data', f'soc_{key}_d.bin'))
    json.dump({'key': key, 'unit': UNIT, 'cats': CATS, 'stats': out, 'popTotal': round(tot), 'pois': inside},
              open(os.path.join(ROOT, 'data', f'soc_{key}.json'), 'w'), ensure_ascii=False, separators=(',', ':'))
    print(key, {c: (v['n'], v['p500'], v['p1000']) for c, v in out.items()})


if __name__ == '__main__':
    tj = json.loads(fetch('https://tiles.openfreemap.org/planet'))
    for k in sys.argv[1:] or list(CITIES):
        run(k, tj['tiles'][0])

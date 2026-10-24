"""도시별 인구 노출·병원 고립 계산.

1) 인구: WorldPop 100m 격자(3초) 칸마다 지형(Terrarium z12)을 5×5 점으로 재어,
   칸의 사람을 땅(해발>0) 점에 고르게 나눠 「해발 m별 인구표」를 만든다.
2) 고립: OpenFreeMap z14 도로(골목 제외 모든 차도)로 길 그물을 만들고,
   토막마다 지형 높이를 달아 물 높이 L에서 잠기는 길을 끊는다.
   잠기지 않은 종합병원(OSM hospital) 또는 분석 범위 밖으로 나가는 길에 닿지 못하는 동네 사람을 센다.

쓰기: python3 tools/build_risk.py <WorldPop.tif> [도시 ...]
출력: data/risk_<도시>.json, data/risk_<도시>_pop.bin(Uint16 사람 수), data/risk_<도시>_cut.bin(Uint8 끊기는 최저 물 높이, 255=끊기지 않음)
"""
import io, json, math, os, re, sys, time, urllib.request
from collections import defaultdict, deque
from concurrent.futures import ThreadPoolExecutor
import numpy as np
import tifffile
from PIL import Image
import mapbox_vector_tile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CITIES = json.load(open(os.path.join(ROOT, 'data', 'cities.json')))
MAXLV = {'hcm': 6, 'cantho': 5, 'hanoi': 12, 'hue': 8, 'danang': 8}
DZ = 12
ROAD_KEEP = {'motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'minor'}
NOT_MED = re.compile(r'yoga|spa\b|massage|thẩm mỹ|tham my|beauty|nail|gym|thú y|thu y|vet', re.I)
EXIT_M = 150     # 범위 가장자리에서 이 거리 안의 길 마디 = 밖으로 나가는 길
SNAP_HOSP = 300  # 병원 ↔ 가장 가까운 길 마디
SNAP_CELL = 400  # 인구 칸 ↔ 가장 가까운 길 마디


def fetch(url, tries=4):
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0 vn-floodlens build'})
            return urllib.request.urlopen(req, timeout=60).read()
        except Exception:
            time.sleep(1.5 * (i + 1))
    return None


def m_between(a, b):
    k = 111320
    return math.hypot((a[0] - b[0]) * k * math.cos(math.radians((a[1] + b[1]) / 2)), (a[1] - b[1]) * k)


# ---------------- 지형 ----------------
class Dem:
    def __init__(self, w, s, e, n):
        lx = lambda lon: (lon + 180) / 360 * 2 ** DZ
        ly = lambda lat: (1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * 2 ** DZ
        self.lx, self.ly = lx, ly
        self.x0, self.x1 = int(lx(w)), int(lx(e))
        self.y0, self.y1 = int(ly(n)), int(ly(s))
        W, H = (self.x1 - self.x0 + 1) * 256, (self.y1 - self.y0 + 1) * 256
        self.a = np.zeros((H, W), np.float32)
        jobs = [(x, y) for x in range(self.x0, self.x1 + 1) for y in range(self.y0, self.y1 + 1)]

        def one(xy):
            x, y = xy
            raw = fetch(f'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{DZ}/{x}/{y}.png')
            im = np.asarray(Image.open(io.BytesIO(raw)).convert('RGB'), np.float32)
            return xy, im[:, :, 0] * 256 + im[:, :, 1] + im[:, :, 2] / 256 - 32768

        with ThreadPoolExecutor(8) as ex:
            for (x, y), v in ex.map(one, jobs):
                self.a[(y - self.y0) * 256:(y - self.y0 + 1) * 256, (x - self.x0) * 256:(x - self.x0 + 1) * 256] = v

    def at(self, lon, lat):  # 브라우저(elevAt)와 같은 규칙: 해당 화소, 반올림
        lon, lat = np.asarray(lon, float), np.asarray(lat, float)
        fx = (lon + 180) / 360 * 2 ** DZ
        fy = (1 - np.arcsinh(np.tan(np.radians(lat))) / np.pi) / 2 * 2 ** DZ
        i = np.floor((fx - self.x0) * 256).astype(int)
        j = np.floor((fy - self.y0) * 256).astype(int)
        i = np.clip(i, 0, self.a.shape[1] - 1); j = np.clip(j, 0, self.a.shape[0] - 1)
        return np.round(self.a[j, i]).astype(int)


# ---------------- 길 그물 ----------------
def load_roads(w, s, e, n, tiles_url, Z=14):
    def txy(lon, lat):
        k = 2 ** Z
        return int((lon + 180) / 360 * k), int((1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * k)

    def ll(x, y, px, py, ext):
        k = 2 ** Z
        lon = (x + px / ext) / k * 360 - 180
        yy = y + 1 - py / ext
        return lon, math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * yy / k))))

    x0, y0 = txy(w, n); x1, y1 = txy(e, s)
    jobs = [(x, y) for x in range(x0, x1 + 1) for y in range(y0, y1 + 1)]

    def one(xy):
        raw = fetch(tiles_url.format(z=Z, x=xy[0], y=xy[1]))
        return xy, mapbox_vector_tile.decode(raw) if raw else None

    with ThreadPoolExecutor(8) as ex:
        res = list(ex.map(one, jobs))
    lines, missing = [], 0
    for (x, y), d in res:
        if d is None:
            missing += 1; continue
        if 'transportation' not in d:
            continue
        ext = d['transportation'].get('extent', 4096)
        for f in d['transportation']['features']:
            p = f['properties']
            if p.get('class') not in ROAD_KEEP or p.get('brunnel') == 'tunnel':
                continue
            g = f['geometry']
            parts = [g['coordinates']] if g['type'] == 'LineString' else g['coordinates'] if g['type'] == 'MultiLineString' else []
            for part in parts:
                pts = [ll(x, y, px, py, ext) for px, py in part if -8 <= px <= ext + 8 and -8 <= py <= ext + 8]
                if len(pts) >= 2:
                    lines.append((pts, p.get('brunnel') == 'bridge'))
    return lines, len(jobs), missing


class Grid:  # 가까운 점 찾기용 칸 나눔
    def __init__(self, pts, cell=0.004):
        self.c, self.pts, self.h = cell, pts, defaultdict(list)
        for i, (x, y) in enumerate(pts):
            self.h[(int(x / cell), int(y / cell))].append(i)

    def nearest(self, x, y, max_m):
        cx, cy, best, bd = int(x / self.c), int(y / self.c), -1, max_m
        r = int(max_m / 111320 / self.c) + 1
        for i in range(cx - r, cx + r + 1):
            for j in range(cy - r, cy + r + 1):
                for k in self.h.get((i, j), ()):
                    d = m_between((x, y), self.pts[k])
                    if d < bd:
                        bd, best = d, k
        return best, bd


def build(key, pop_tif, tiles_url):
    t0 = time.time()
    c = CITIES[key]
    w, s, e, n = c['bbox']
    dem = Dem(w, s, e, n)

    # ---------- 인구 ----------
    pg = pop_tif
    sx, sy = pg['scale']; ox, oy = pg['origin']
    c0, c1 = int((w - ox) / sx), int(math.ceil((e - ox) / sx))
    r0, r1 = int((oy - n) / sy), int(math.ceil((oy - s) / sy))
    pop = pg['arr'][r0:r1, c0:c1].astype(np.float64)
    pop[pop < 0] = 0
    rows, cols = pop.shape
    gw, gn = ox + c0 * sx, oy - r0 * sy
    # 칸마다 5×5 점의 해발
    K = 5
    sub = (np.arange(K) + 0.5) / K
    jj, ii = np.meshgrid(np.arange(rows), np.arange(cols), indexing='ij')
    lon = gw + (ii[..., None, None] + sub[None, None, None, :]) * sx
    lat = gn - (jj[..., None, None] + sub[None, None, :, None]) * sy
    lon, lat = np.broadcast_arrays(lon, lat)
    ev = dem.at(lon.ravel(), lat.ravel()).reshape(rows, cols, K * K)
    land = (ev > 0)
    nland = land.sum(-1)
    pop_hist = np.zeros(200)
    lost = 0.0  # 땅 점이 하나도 없는 칸(지형상 물 위) 사람
    for r in range(rows):
        for q in range(cols):
            p = pop[r, q]
            if p <= 0:
                continue
            if nland[r, q] == 0:
                lost += p; continue
            vals = ev[r, q][land[r, q]]
            for v in vals:
                pop_hist[min(179, v) + 20] += p / nland[r, q]
    # 칸의 대표 해발(땅 점 중앙값) — 고립 판정에서 「집 자체가 잠김」 구분용
    cell_med = np.full((rows, cols), -99, int)
    for r in range(rows):
        for q in range(cols):
            if nland[r, q]:
                cell_med[r, q] = int(np.median(ev[r, q][land[r, q]]))

    # ---------- 길 그물 ----------
    lines, nt, miss = load_roads(w, s, e, n, tiles_url)
    node_id, nodes = {}, []
    def nid(pt):
        k = (round(pt[0], 5), round(pt[1], 5))
        if k not in node_id:
            node_id[k] = len(nodes); nodes.append(k)
        return node_id[k]
    # 타일 단순화로 T자 교차점 꼭짓점이 빠진다 → 길 끝점을 10m 안 다른 길 토막에 붙이고 그 토막을 쪼갠다
    segs = [(a, b, br) for pts, br in lines for a, b in zip(pts, pts[1:]) if m_between(a, b) >= 0.5]
    SC = 0.001
    sidx = defaultdict(list)
    for i, (a, b, _) in enumerate(segs):
        for gx in range(int(min(a[0], b[0]) / SC), int(max(a[0], b[0]) / SC) + 1):
            for gy in range(int(min(a[1], b[1]) / SC), int(max(a[1], b[1]) / SC) + 1):
                sidx[(gx, gy)].append(i)
    ends = {pts[0] for pts, _ in lines} | {pts[-1] for pts, _ in lines}
    splits, links = defaultdict(list), []
    kx = 111320 * math.cos(math.radians((s + n) / 2)); ky = 111320
    for E in ends:
        best = None
        for gx in (int(E[0] / SC) - 1, int(E[0] / SC), int(E[0] / SC) + 1):
            for gy in (int(E[1] / SC) - 1, int(E[1] / SC), int(E[1] / SC) + 1):
                for i in sidx.get((gx, gy), ()):
                    a, b, _ = segs[i]
                    if E == a or E == b:
                        continue
                    ax, ay, bx, by = a[0] * kx, a[1] * ky, b[0] * kx, b[1] * ky
                    ex, ey = E[0] * kx, E[1] * ky
                    dx, dy = bx - ax, by - ay
                    tt = max(0.0, min(1.0, ((ex - ax) * dx + (ey - ay) * dy) / (dx * dx + dy * dy)))
                    d = math.hypot(ax + dx * tt - ex, ay + dy * tt - ey)
                    if d < 10 and (best is None or d < best[0]):
                        best = (d, i, tt)
        if best:
            d, i, tt = best
            a, b, _ = segs[i]
            P = (a[0] + (b[0] - a[0]) * tt, a[1] + (b[1] - a[1]) * tt)
            if 0 < tt < 1:
                splits[i].append((tt, P))
            links.append((E, P if 0 < tt < 1 else (a if tt == 0 else b)))
    pieces = []
    for i, (a, b, br) in enumerate(segs):
        pts = [a] + [P for _, P in sorted(splits.get(i, []))] + [b]
        pieces += [(p, q, br) for p, q in zip(pts, pts[1:])]
    pieces += [(E, P, False) for E, P in links]
    edges = {}  # (a,b) → 끊기는 최저 물 높이
    road_km = 0.0
    for a, b, bridge in pieces:
            L = m_between(a, b)
            if L < 0.05:
                u, v = nid(a), nid(b)
                if u != v:
                    edges[(min(u, v), max(u, v))] = 999
                continue
            road_km += L / 1000
            k = max(1, int(math.ceil(L / 40)))
            if bridge:
                cut = 999
            else:
                mx = [a[0] + (b[0] - a[0]) * (j + .5) / k for j in range(k)]
                my = [a[1] + (b[1] - a[1]) * (j + .5) / k for j in range(k)]
                es = dem.at(mx, my)
                pos = es[es > 0]
                cut = int(pos.min()) if len(pos) else 999
            u, v = nid(a), nid(b)
            if u == v:
                continue
            key2 = (min(u, v), max(u, v))
            edges[key2] = max(edges.get(key2, 0), cut) if key2 in edges else cut
    adj = defaultdict(list)
    for (u, v), cut in edges.items():
        adj[u].append((v, cut)); adj[v].append((u, cut))
    grid = Grid(nodes)
    # 연결 덩어리 확인(물 없을 때)
    comp = [-1] * len(nodes); sizes = []
    for st in range(len(nodes)):
        if comp[st] >= 0 or not adj[st]:
            continue
        cid = len(sizes); comp[st] = cid; q = [st]; cnt = 0
        while q:
            u = q.pop(); cnt += 1
            for v, _ in adj[u]:
                if comp[v] < 0:
                    comp[v] = cid; q.append(v)
        sizes.append(cnt)
    sizes.sort(reverse=True)
    print(f'  길 덩어리 {len(sizes)}개, 가장 큰 덩어리 {sizes[0]}/{sum(sizes)} 마디, 다음 {sizes[1:4]}, 이음 {len(links)}')

    # 밖으로 나가는 마디
    def near_edge(p):
        return min(m_between(p, (w, p[1])), m_between(p, (e, p[1])), m_between(p, (p[0], s)), m_between(p, (p[0], n))) < EXIT_M
    exits = [i for i, p in enumerate(nodes) if near_edge(p) and adj[i]]

    # 종합병원
    osm = json.load(open(os.path.join(ROOT, 'data', f'osm_{key}.json')))
    hosp = []
    for p in osm['pois']:
        if p['t'] != 'hospital' or p.get('s') != 'hospital' or NOT_MED.search(p['n'] or ''):
            continue
        he = int(dem.at([p['c'][0]], [p['c'][1]])[0])
        k, d = grid.nearest(p['c'][0], p['c'][1], SNAP_HOSP)
        if k >= 0:
            hosp.append({'n': p['n'], 'c': p['c'], 'e': he, 'node': k})

    # 인구 칸 → 마디
    cell_node = np.full((rows, cols), -1, int)
    for r in range(rows):
        for q in range(cols):
            if pop[r, q] > 0:
                k, d = grid.nearest(gw + (q + .5) * sx, gn - (r + .5) * sy, SNAP_CELL)
                cell_node[r, q] = k

    # 물 높이마다 닿는 마디
    maxlv = MAXLV[key]
    cut_lv = np.full((rows, cols), 255, np.uint8)
    cut_pop, unknown = [], float(pop[(cell_node < 0)].sum())
    seen0 = None
    for L in range(0, maxlv + 1):
        src = [h['node'] for h in hosp if h['e'] > L] + exits
        seen = np.zeros(len(nodes), bool)
        dq = deque()
        for x in src:
            if not seen[x]:
                seen[x] = True; dq.append(x)
        while dq:
            u = dq.popleft()
            for v, cut in adj[u]:
                if cut > L and not seen[v]:
                    seen[v] = True; dq.append(v)
        if seen0 is None:
            # 물이 없을 때도 닿지 않는 마디 = 길 자료가 끊긴 곳 → 고립 계산에서 뺀다
            seen0 = seen.copy()
            for r in range(rows):
                for q in range(cols):
                    k = cell_node[r, q]
                    if k >= 0 and pop[r, q] > 0 and not seen0[k]:
                        unknown += float(pop[r, q]); cell_node[r, q] = -1
        # 집은 안 잠겼는데(칸 대표 해발 > L) 병원·바깥으로 갈 길이 없는 사람
        cnt = 0.0
        for r in range(rows):
            for q in range(cols):
                k = cell_node[r, q]
                if k < 0 or pop[r, q] <= 0 or cell_med[r, q] <= L:
                    continue
                if not seen[k]:
                    # 그 칸에서 아직 잠기지 않은 땅 점 비율만큼
                    vals = ev[r, q][land[r, q]]
                    cnt += pop[r, q] * (vals > L).sum() / max(1, nland[r, q])
                    if cut_lv[r, q] == 255:
                        cut_lv[r, q] = L
        cut_pop.append(round(cnt))
        print(f'  {key} L={L} 닿는 병원 {sum(1 for h in hosp if h["e"] > L)} 고립 {cnt:,.0f}명')

    popu16 = np.clip(np.round(pop), 0, 65535).astype('<u2')
    base = os.path.join(ROOT, 'data', f'risk_{key}')
    popu16.tofile(base + '_pop.bin')
    # 칸마다 두 바이트: [끊기는 물 높이(255=안 끊김), 칸 대표 해발(0~254, 땅 없으면 0)]
    np.stack([cut_lv, np.clip(cell_med, 0, 254).astype(np.uint8)], -1).tofile(base + '_cut.bin')
    out = {
        'key': key, 'grid': {'w': gw, 'n': gn, 'dx': sx, 'dy': sy, 'cols': cols, 'rows': rows},
        'popTotal': round(float(pop.sum())), 'popOnWater': round(lost), 'popUnknownRoad': round(unknown),
        'popHist': [round(v) for v in pop_hist], 'cutPop': cut_pop,
        'hospitals': len(hosp), 'roadKm': round(road_km), 'nodes': len(nodes), 'edges': len(edges),
        'tiles': nt, 'missingTiles': miss, 'popSrc': pg['name']
    }
    json.dump(out, open(base + '.json', 'w'), separators=(',', ':'))
    print(key, f"인구 {out['popTotal']:,} 병원 {len(hosp)} 길 {road_km:.0f}km 마디 {len(nodes):,} ({time.time()-t0:.0f}s)")


if __name__ == '__main__':
    tif_path = sys.argv[1]
    t = tifffile.TiffFile(tif_path); p = t.pages[0]
    sx, sy, _ = p.tags['ModelPixelScaleTag'].value
    tp = p.tags['ModelTiepointTag'].value
    print('WorldPop 읽는 중…', p.shape)
    pop_tif = {'arr': p.asarray(), 'scale': (sx, sy), 'origin': (tp[3], tp[4]), 'name': os.path.basename(tif_path)}
    tj = json.loads(fetch('https://tiles.openfreemap.org/planet'))
    keys = sys.argv[2:] or list(CITIES)
    for k in keys:
        build(k, pop_tif, tj['tiles'][0])

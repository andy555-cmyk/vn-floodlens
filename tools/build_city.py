"""도시별 OSM 자료 묶음 만들기 — OpenFreeMap 벡터 타일(z14)에서 주요 시설과 큰길을 뽑는다.

python3 tools/build_city.py            # 다섯 도시 전부
python3 tools/build_city.py hcm hue    # 고른 도시만
"""
import json, math, os, sys, time, urllib.request
from concurrent.futures import ThreadPoolExecutor
import mapbox_vector_tile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STYLE_TILEJSON = 'https://tiles.openfreemap.org/planet'
CITIES = json.load(open(os.path.join(ROOT, 'data', 'cities.json')))

POI_KEEP = {
    'hospital': 'hospital',      # hospital, clinic
    'school': 'school',          # school, kindergarten
    'college': 'school',         # university, college
    'police': 'police',
    'fire_station': 'fire',
}
ROAD_KEEP = {'motorway', 'trunk', 'primary', 'secondary'}
Z = 14


def tile_xy(lon, lat, z):
    n = 2 ** z
    x = int((lon + 180) / 360 * n)
    y = int((1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * n)
    return x, y


def to_lonlat(x, y, z, px, py, extent):
    n = 2 ** z
    lon = (x + px / extent) / n * 360 - 180
    yy = y + 1 - py / extent  # 디코더는 y가 위로 증가
    lat = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * yy / n))))
    return lon, lat


def fetch(url, tries=4):
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0 vn-floodlens build'})
            return urllib.request.urlopen(req, timeout=40).read()
        except Exception:
            time.sleep(1.5 * (i + 1))
    return None


def m_between(a, b):
    k = 111320
    dx = (a[0] - b[0]) * k * math.cos(math.radians((a[1] + b[1]) / 2))
    return math.hypot(dx, (a[1] - b[1]) * k)


def build(key, tiles_url):
    c = CITIES[key]
    w, s, e, n = c['bbox']
    x0, y0 = tile_xy(w, n, Z)
    x1, y1 = tile_xy(e, s, Z)
    jobs = [(x, y) for x in range(x0, x1 + 1) for y in range(y0, y1 + 1)]
    pois, seen, roads = [], set(), []

    def one(xy):
        x, y = xy
        raw = fetch(tiles_url.format(z=Z, x=x, y=y))
        return xy, (mapbox_vector_tile.decode(raw) if raw else None)

    with ThreadPoolExecutor(8) as ex:
        results = list(ex.map(one, jobs))
    missing = sum(1 for _, d in results if d is None)

    for (x, y), d in results:
        if not d:
            continue
        if 'poi' in d:
            ext = d['poi'].get('extent', 4096)
            for f in d['poi']['features']:
                p = f['properties']
                kind = POI_KEEP.get(p.get('class'))
                if not kind or f['geometry']['type'] != 'Point':
                    continue
                px, py = f['geometry']['coordinates']
                if not (0 <= px < ext and 0 <= py < ext):
                    continue  # 이웃 타일 여백에 겹친 것
                lon, lat = to_lonlat(x, y, Z, px, py, ext)
                if not (w <= lon <= e and s <= lat <= n):
                    continue
                name = p.get('name') or ''
                k = (kind, name, round(lon, 4), round(lat, 4))
                if k in seen:
                    continue
                seen.add(k)
                pois.append({'t': kind, 's': p.get('subclass'), 'n': name,
                             'en': p.get('name_en') if p.get('name_en') != name else None,
                             'c': [round(lon, 5), round(lat, 5)]})
        if 'transportation' in d:
            ext = d['transportation'].get('extent', 4096)
            for f in d['transportation']['features']:
                p = f['properties']
                if p.get('class') not in ROAD_KEEP or p.get('brunnel') in ('tunnel',):
                    continue
                g = f['geometry']
                lines = [g['coordinates']] if g['type'] == 'LineString' else g['coordinates'] if g['type'] == 'MultiLineString' else []
                for line in lines:
                    pts = []
                    for px, py in line:
                        # 여백 쪽 점은 잘라 겹침을 줄인다
                        if -8 <= px <= ext + 8 and -8 <= py <= ext + 8:
                            lon, lat = to_lonlat(x, y, Z, px, py, ext)
                            pt = [round(lon, 5), round(lat, 5)]
                            if not pts or m_between(pts[-1], pt) > 12:
                                pts.append(pt)
                    if len(pts) >= 2:
                        roads.append({'k': p['class'], 'b': 1 if p.get('brunnel') == 'bridge' else 0, 'c': pts})

    out = {'key': key, 'osm_date': tiles_url.split('/')[-4].split('_')[0], 'tiles': len(jobs), 'missing': missing,
           'pois': pois, 'roads': roads}
    path = os.path.join(ROOT, 'data', f'osm_{key}.json')
    json.dump(out, open(path, 'w'), ensure_ascii=False, separators=(',', ':'))
    from collections import Counter
    km = sum(m_between(r['c'][i], r['c'][i + 1]) for r in roads for i in range(len(r['c']) - 1)) / 1000
    print(key, 'tiles', len(jobs), 'missing', missing, Counter(p['t'] for p in pois), 'roads', len(roads), f'{km:.0f}km',
          f'{os.path.getsize(path)/1024:.0f}KB')


if __name__ == '__main__':
    tj = json.loads(fetch(STYLE_TILEJSON))
    url = tj['tiles'][0]
    keys = sys.argv[1:] or list(CITIES)
    for k in keys:
        build(k, url)

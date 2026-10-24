# 브라우저 계산과 따로 — 지형 타일에서 면적·시설 수를 다시 센다
import json, math, io, urllib.request, re, sys
from PIL import Image
key = sys.argv[1] if len(sys.argv) > 1 else 'hcm'; LV = int(sys.argv[2]) if len(sys.argv) > 2 else 1
C = json.load(open('data/cities.json'))[key]; Z = 12; R = 40075016.686
w, s, e, n = C['bbox']
lx = lambda lon: (lon + 180) / 360 * 2**Z
ly = lambda lat: (1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * 2**Z
cache = {}
def tile(x, y):
    if (x, y) not in cache:
        im = Image.open(io.BytesIO(urllib.request.urlopen(f'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{Z}/{x}/{y}.png').read())).convert('RGB')
        cache[(x, y)] = im.load()
    return cache[(x, y)]
def elev(lon, lat):
    fx, fy = lx(lon), ly(lat); x, y = int(fx), int(fy); px = tile(x, y)
    r, g, b = px[min(255, int((fx - x) * 256)), min(255, int((fy - y) * 256))]
    return round(r * 256 + g + b / 256 - 32768)
land = wet = 0
for x in range(int(lx(w)), int(lx(e)) + 1):
    for y in range(int(ly(n)), int(ly(s)) + 1):
        px = tile(x, y)
        for j in range(256):
            gy = y + (j + .5) / 256; lat = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * gy / 2**Z))))
            if not (s <= lat <= n): continue
            a = (R * math.cos(math.radians(lat)) / 2**(Z + 8))**2 / 1e6
            for i in range(256):
                lon = (x + (i + .5) / 256) / 2**Z * 360 - 180
                if not (w <= lon <= e): continue
                r, g, b = px[i, j]; v = round(r * 256 + g + b / 256 - 32768)
                if v > 0:
                    land += a
                    if v <= LV: wet += a
osm = json.load(open(f'data/osm_{key}.json'))
NOT_MED = re.compile(r'yoga|spa\b|massage|thẩm mỹ|tham my|beauty|nail|gym|thú y|thu y|vet', re.I)
cnt = {}
for p in osm['pois']:
    t = 'police' if p['t'] == 'fire' else p['t']
    if t == 'hospital' and NOT_MED.search(p['n'] or ''): continue
    v = elev(*p['c'])
    if 0 < v <= LV: cnt[t] = cnt.get(t, 0) + 1
print(key, 'lv', LV, f'land {land:.1f}km2  wet {wet:.1f}km2  {wet/land*100:.1f}%', cnt)

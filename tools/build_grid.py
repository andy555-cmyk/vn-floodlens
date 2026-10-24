"""전국 공기·더위 격자점 만들기.

Natural Earth 1:50m 나라 경계에서 베트남 본토를 꺼내, 경계에서 STEP 간격 격자점 중
경계 안 또는 BUF 도 이내(해안 바다 포함)만 남겨 data/grid.json 으로 쓴다.
경계선 자체는 화면에 그리지 않고 격자점 고르는 데만 쓴다.

쓰기: python3 tools/build_grid.py <ne_50m_admin_0_countries.geojson>
"""
import json, sys, os
from shapely.geometry import shape, Point

STEP, BUF = 0.5, 0.45
W, S, E, N = 101.5, 8.0, 110.0, 23.5

src = json.load(open(sys.argv[1]))
vn = next(f for f in src['features'] if f['properties'].get('ADM0_A3') == 'VNM')
geom = shape(vn['geometry']).buffer(BUF)

lats, lons = [], []
la = S
while la <= N + 1e-9:
    lo = W
    while lo <= E + 1e-9:
        if geom.contains(Point(lo, la)):
            lats.append(round(la, 2)); lons.append(round(lo, 2))
        lo += STEP
    la += STEP

out = {'step': STEP, 'bbox': [W, S, E, N], 'lat': lats, 'lon': lons}
p = os.path.join(os.path.dirname(__file__), '..', 'data', 'grid.json')
json.dump(out, open(p, 'w'), separators=(',', ':'))
print(len(lats), 'points →', os.path.normpath(p))

"""IPCC AR6 지역 해수면 전망(Fox-Kemper 외 2021, Garner 외 2021 자료 10.5281/zenodo.5914710)에서
도시별 「지금(2026)부터 2050·2100년까지 더 오르는 높이」를 뽑아 data/slr.json 으로 쓴다.

호찌민은 붕따우 조위소(id 1495, 땅 침하 포함), 나머지는 가장 가까운 1° 격자점.
값은 medium confidence total, 분위 17/50/83%(「가능성 높은 범위」), 단위 m.
쓰기: python3 tools/build_slr.py <ar6 폴더(ssp126.nc 등)>
"""
import sys, os, json
import h5py, numpy as np

ROOT = os.path.join(os.path.dirname(__file__), '..')
src = sys.argv[1]
cities = json.load(open(os.path.join(ROOT, 'data', 'cities.json')))
NOW = 2026
out = {'base': NOW, 'src': 'IPCC AR6 sea level projections, medium confidence, total', 'doi': '10.5281/zenodo.5914710', 'cities': {}}
for ssp in ['ssp126', 'ssp245', 'ssp585']:
    f = h5py.File(os.path.join(src, ssp + '.nc'), 'r')
    loc, lat, lon = f['locations'][:], f['lat'][:], f['lon'][:]
    yrs = [int(y) for y in f['years'][:]]; q = f['quantiles'][:]
    qi = [int(np.argmin(abs(q - x))) for x in (0.17, 0.5, 0.83)]
    for k, c in cities.items():
        if not c.get('tide'):
            continue  # 바다에서 먼 하노이는 강물이 좌우 → 해수면 시나리오를 붙이지 않는다
        la, lo = c['tide']
        if k == 'hcm':
            idx = int(np.where(loc == 1495)[0][0])
        else:
            d = (lat - la) ** 2 + (lon - lo) ** 2; d[loc < 100000000] = 9e9; idx = int(np.argmin(d))
        v = f['sea_level_change'][:, :, idx].astype(float)
        now = v[:, yrs.index(2020)] + (v[:, yrs.index(2030)] - v[:, yrs.index(2020)]) * (NOW - 2020) / 10
        e = out['cities'].setdefault(k, {'loc': int(loc[idx]), 'at': [round(float(lon[idx]), 2), round(float(lat[idx]), 2)]})
        e[ssp] = {str(Y): [round((v[i, yrs.index(Y)] - now[i]) / 1000, 2) for i in qi] for Y in (2050, 2100)}
p = os.path.join(ROOT, 'data', 'slr.json')
json.dump(out, open(p, 'w'), separators=(',', ':'))
print(json.dumps(out, ensure_ascii=False))

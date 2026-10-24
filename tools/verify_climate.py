"""공기·더위 숫자 독립 재계산 — 화면 값과 대조용. 쓰기: python3 tools/verify_climate.py"""
import json, urllib.request, datetime
D = json.load(open('data/cities.json')); G = json.load(open('data/grid.json'))
ORDER = ['hcm', 'cantho', 'hanoi', 'hue', 'danang']
def g(u): return json.load(urllib.request.urlopen(u, timeout=60))
def hi(tc, rh):
    T = tc * 9 / 5 + 32; H = 0.5 * (T + 61 + (T - 68) * 1.2 + rh * 0.094)
    if (H + T) / 2 >= 80:
        H = -42.379 + 2.04901523*T + 10.14333127*rh - .22475541*T*rh - .00683783*T*T - .05481717*rh*rh + .00122874*T*T*rh + .00085282*T*rh*rh - .00000199*T*T*rh*rh
        if rh < 13 and 80 <= T <= 112: H -= ((13 - rh) / 4) * ((17 - abs(T - 95)) / 17) ** .5
        elif rh > 85 and 80 <= T <= 87: H += ((rh - 85) / 10) * ((87 - T) / 5)
    return (H - 32) * 5 / 9
now = (datetime.datetime.utcnow() + datetime.timedelta(hours=7)).strftime('%Y-%m-%dT%H'); today = now[:10]
la = ','.join(str(D[k]['center'][1]) for k in ORDER); lo = ','.join(str(D[k]['center'][0]) for k in ORDER)
A = g(f'https://air-quality-api.open-meteo.com/v1/air-quality?latitude={la}&longitude={lo}&hourly=pm2_5&past_days=1&forecast_days=3&timezone=Asia%2FBangkok')
W = g(f'https://api.open-meteo.com/v1/forecast?latitude={la}&longitude={lo}&hourly=temperature_2m,relative_humidity_2m&past_days=1&forecast_days=3&timezone=Asia%2FBangkok')
for k, a, w in zip(ORDER, A, W):
    t = a['hourly']['time']; pm = a['hourly']['pm2_5']
    tv = [v for tm, v in zip(t, pm) if tm.startswith(today) and v is not None]
    ni = next(i for i, tm in enumerate(t) if tm[:13] == now)
    pk = max(range(ni, len(pm)), key=lambda i: pm[i] if pm[i] is not None else -1)
    h = [hi(x, y) for x, y in zip(w['hourly']['temperature_2m'], w['hourly']['relative_humidity_2m'])]
    wt = w['hourly']['time']; wi = next(i for i, tm in enumerate(wt) if tm[:13] == now)
    dmax = max(v for tm, v in zip(wt, h) if tm.startswith(today))
    print(f"{k:7s} PM 지금 {pm[ni]:.1f} 오늘평균 {sum(tv)/len(tv):.1f} 최고 {pm[pk]:.0f}@{t[pk]} | 열지수 지금 {h[wi]:.0f} 오늘최고 {dmax:.0f} 극도주의+ {sum(1 for v in h[wi:] if v >= 32.2)}h")
gl = ','.join(map(str, G['lat'])); go = ','.join(map(str, G['lon']))
GA = g(f'https://air-quality-api.open-meteo.com/v1/air-quality?latitude={gl}&longitude={go}&hourly=pm2_5&forecast_days=3&timezone=Asia%2FBangkok')
GW = g(f'https://api.open-meteo.com/v1/forecast?latitude={gl}&longitude={go}&hourly=temperature_2m,relative_humidity_2m&forecast_days=3&timezone=Asia%2FBangkok')
def share(rows, f, test):
    vals = [f(r) for r in rows]; vals = [v for v in vals if v is not None]
    return sum(1 for v in vals if test(v)) / len(vals) * 100
def dmean(r):
    v = [x for tm, x in zip(r['hourly']['time'], r['hourly']['pm2_5']) if tm.startswith(today) and x is not None]; return sum(v) / len(v) if v else None
def dmaxhi(r):
    h = r['hourly']; v = [hi(a, b) for tm, a, b in zip(h['time'], h['temperature_2m'], h['relative_humidity_2m']) if tm.startswith(today) and a is not None]; return max(v) if v else None
print('전국 WHO 초과 %.0f%%' % share(GA, dmean, lambda v: v > 15), '| 전국 극도주의+ %.0f%%' % share(GW, dmaxhi, lambda v: v >= 32.2))

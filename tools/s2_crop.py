"""Sentinel-2 실제 색 사진에서 한 구역만 잘라 PNG로 만든다(전체 파일을 받지 않고 필요한 타일만 범위 요청).

쓰기: python3 tools/s2_crop.py <TCI.tif 주소> <서경> <남위> <동경> <북위> <out.png>
출력: out.png 와 out.json(네 귀퉁이 경위도 — 지도 image 원본의 coordinates 그대로)
"""
import io, json, sys, zlib, urllib.request
import numpy as np
import tifffile
from PIL import Image
from pyproj import Transformer


class RangeFile(io.RawIOBase):
    """HTTP 범위 요청으로 읽는 파일(64KB 단위로 묶어 받아 둠)."""
    BLK = 1 << 16

    def __init__(self, url):
        self.url, self.pos, self.cache = url, 0, {}
        r = urllib.request.urlopen(urllib.request.Request(url, method='HEAD'), timeout=60)
        self.size = int(r.headers['Content-Length'])

    def _blk(self, i):
        if i not in self.cache:
            a = i * self.BLK; b = min(self.size, a + self.BLK) - 1
            req = urllib.request.Request(self.url, headers={'Range': f'bytes={a}-{b}'})
            self.cache[i] = urllib.request.urlopen(req, timeout=120).read()
        return self.cache[i]

    def fetch(self, a, n):  # 큰 덩어리는 한 번에 받는다
        req = urllib.request.Request(self.url, headers={'Range': f'bytes={a}-{a + n - 1}'})
        return urllib.request.urlopen(req, timeout=180).read()

    def readable(self): return True
    def seekable(self): return True
    def tell(self): return self.pos

    def seek(self, off, wh=0):
        self.pos = off if wh == 0 else self.pos + off if wh == 1 else self.size + off
        return self.pos

    def read(self, n=-1):
        if n < 0: n = self.size - self.pos
        n = max(0, min(n, self.size - self.pos))
        out = bytearray()
        while len(out) < n:
            i, o = divmod(self.pos + len(out), self.BLK)
            out += self._blk(i)[o:o + n - len(out)]
        self.pos += n
        return bytes(out)

    def readinto(self, b):
        d = self.read(len(b)); b[:len(d)] = d; return len(d)


def main(url, w, s, e, n, out):
    f = RangeFile(url)
    tif = tifffile.TiffFile(f)
    p = tif.pages[0]
    sx, sy, _ = p.tags['ModelPixelScaleTag'].value
    tp = p.tags['ModelTiepointTag'].value
    x0, y0 = tp[3], tp[4]
    epsg = p.geotiff_tags.get('ProjectedCSTypeGeoKey')
    epsg = int(epsg.value if hasattr(epsg, 'value') else epsg)
    fwd = Transformer.from_crs('EPSG:4326', f'EPSG:{epsg}', always_xy=True)
    inv = Transformer.from_crs(f'EPSG:{epsg}', 'EPSG:4326', always_xy=True)
    xs, ys = fwd.transform([w, e, e, w], [n, n, s, s])
    c0 = int((min(xs) - x0) / sx); c1 = int((max(xs) - x0) / sx) + 1
    r0 = int((y0 - max(ys)) / sy); r1 = int((y0 - min(ys)) / sy) + 1
    tw, th = p.tilewidth, p.tilelength
    ntx = (p.imagewidth + tw - 1) // tw
    img = np.zeros((r1 - r0, c1 - c0, 3), np.uint8)
    for ty in range(r0 // th, (r1 - 1) // th + 1):
        for tx in range(c0 // tw, (c1 - 1) // tw + 1):
            k = ty * ntx + tx
            raw = f.fetch(p.dataoffsets[k], p.databytecounts[k])
            data, _, _ = p.decode(raw, k)
            t = np.asarray(data).reshape(th, tw, -1)[:, :, :3]
            ya, xa = ty * th, tx * tw
            a0, a1 = max(r0, ya), min(r1, ya + th)
            b0, b1 = max(c0, xa), min(c1, xa + tw)
            img[a0 - r0:a1 - r0, b0 - c0:b1 - c0] = t[a0 - ya:a1 - ya, b0 - xa:b1 - xa]
    Image.fromarray(img).save(out, optimize=True)
    # 잘라낸 사각형 네 귀퉁이(왼위·오위·오아래·왼아래)
    X = [x0 + c0 * sx, x0 + c1 * sx, x0 + c1 * sx, x0 + c0 * sx]
    Y = [y0 - r0 * sy, y0 - r0 * sy, y0 - r1 * sy, y0 - r1 * sy]
    lo, la = inv.transform(X, Y)
    json.dump({'coordinates': [[round(a, 6), round(b, 6)] for a, b in zip(lo, la)], 'size': [c1 - c0, r1 - r0], 'src': url}, open(out.rsplit('.', 1)[0] + '.json', 'w'))
    print(out, img.shape, 'black%', round(float((img.sum(2) == 0).mean() * 100), 1))


if __name__ == '__main__':
    a = sys.argv[1:]
    main(a[0], *map(float, a[1:5]), a[5])

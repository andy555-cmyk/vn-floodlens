import math, urllib.request, mapbox_vector_tile, collections, sys
URL='https://tiles.openfreemap.org/planet/20261018_080001_pt/{z}/{x}/{y}.pbf'
def t(lon,lat,z):
    n=2**z; x=int((lon+180)/360*n); y=int((1-math.asinh(math.tan(math.radians(lat)))/math.pi)/2*n); return x,y
z=14; x,y=t(106.70,10.776,z)
raw=urllib.request.urlopen(urllib.request.Request(URL.format(z=z,x=x,y=y),headers={'User-Agent':'Mozilla/5.0'})).read()
d=mapbox_vector_tile.decode(raw)
print({k:len(v['features']) for k,v in d.items()})
c=collections.Counter((f['properties'].get('class'),f['properties'].get('subclass')) for f in d['poi']['features'])
print(c.most_common(40))
print(d['poi']['features'][0]['properties'])

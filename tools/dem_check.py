import json, math, io, urllib.request, sys
from PIL import Image
C=json.load(open('data/cities.json'))
def txy(lon,lat,z):
    n=2**z; return (lon+180)/360*n, (1-math.asinh(math.tan(math.radians(lat)))/math.pi)/2*n
Z=12
for k,c in C.items():
    w,s,e,n=c['bbox']; x0,y0=txy(w,n,Z); x1,y1=txy(e,s,Z)
    vals=[]
    for tx in range(int(x0),int(x1)+1):
        for ty in range(int(y0),int(y1)+1):
            im=Image.open(io.BytesIO(urllib.request.urlopen(f'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{Z}/{tx}/{ty}.png').read())).convert('RGB')
            px=im.load()
            for j in range(256):
                for i in range(256):
                    gx=tx+i/256; gy=ty+j/256
                    if x0<=gx<=x1 and y0<=gy<=y1:
                        r,g,b=px[i,j]; vals.append(r*256+g+b/256-32768)
    vals.sort(); N=len(vals)
    pct=lambda t: 100*sum(1 for v in vals if v<=t)/N
    print(k,N,'p5/50/95',round(vals[N//20],1),round(vals[N//2],1),round(vals[19*N//20],1),'<=0:',round(pct(0),1),'<=1:',round(pct(1),1),'<=2:',round(pct(2),1),'<=3:',round(pct(3),1))

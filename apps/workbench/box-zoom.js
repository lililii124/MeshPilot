// Map the screen rectangle to the current camera target plane, independently of
// geometry and visibility. All matrices come from the active WebGL renderer.
const multiply=(a,b)=>Array.from({length:16},(_,i)=>{const r=i%4,c=Math.floor(i/4);return [0,1,2,3].reduce((s,k)=>s+a[k*4+r]*b[c*4+k],0);});
const transform=(m,v)=>[0,1,2,3].map(r=>[0,1,2,3].reduce((s,k)=>s+m[k*4+r]*v[k],0));

export function regionTarget(params,scale,viewport,box,camera,focusDepth=null) {
  if(!params?.model||!params?.view||!params?.projection||!scale||!viewport?.width||!viewport?.height||!camera?.eye)return null;
  const distance=Math.hypot(...['x','y','z'].map(k=>camera.eye[k]-(camera.center?.[k]||0)));
  if(!Number.isFinite(distance)||distance<=1e-12)return null;
  const depth=transform(params.projection,[0,0,-distance,1]);
  if(!depth.every(Number.isFinite)||Math.abs(depth[3])<1e-15)return null;
  const x=(box.left+box.right)/2,y=(box.top+box.bottom)/2;
  const input=[2*(x-viewport.left)/viewport.width-1,1-2*(y-viewport.top)/viewport.height,
               Number.isFinite(focusDepth)?focusDepth:depth[2]/depth[3],1];
  const matrix=multiply(params.projection,multiply(params.view,params.model));
  const rows=Array.from({length:4},(_,r)=>[...Array.from({length:4},(_,c)=>matrix[c*4+r]),input[r]]);
  for(let c=0;c<4;c++){
    let pivot=c;for(let r=c+1;r<4;r++)if(Math.abs(rows[r][c])>Math.abs(rows[pivot][c]))pivot=r;
    if(!Number.isFinite(rows[pivot][c])||Math.abs(rows[pivot][c])<1e-15)return null;
    [rows[c],rows[pivot]]=[rows[pivot],rows[c]];const d=rows[c][c];for(let j=c;j<5;j++)rows[c][j]/=d;
    for(let r=0;r<4;r++)if(r!==c){const f=rows[r][c];for(let j=c;j<5;j++)rows[r][j]-=f*rows[c][j];}
  }
  const w=rows[3][4];if(!Number.isFinite(w)||Math.abs(w)<1e-15)return null;
  const point=rows.slice(0,3).map((r,i)=>r[4]/w/scale[i]);
  return point.every(Number.isFinite)?point:null;
}

// Geometry is optional: use its depth only when a visible triangle falls in
// the rectangle. The target remains the rectangle center, and empty regions
// still zoom using the current camera target plane.
export function visibleFocusDepth(traces,params,scale,viewport,box) {
  if(!params?.model||!params?.view||!params?.projection||!scale||!viewport?.width||!viewport?.height)return null;
  const matrix=multiply(params.projection,multiply(params.view,params.model));
  const x=(box.left+box.right)/2,y=(box.top+box.bottom)/2;
  const project=(p)=>{
    const q=transform(matrix,[p[0]*scale[0],p[1]*scale[1],p[2]*scale[2],1]);
    if(!q.every(Number.isFinite)||q[3]<=1e-12)return null;
    return {x:viewport.left+(1+q[0]/q[3])*viewport.width/2,
            y:viewport.top+(1-q[1]/q[3])*viewport.height/2,z:q[2]/q[3]};
  };
  let best=null;
  const consider=(px,py,z)=>{
    if(px<box.left||px>box.right||py<box.top||py>box.bottom||z < -1||z > 1)return;
    const d=(px-x)**2+(py-y)**2;
    if(!best||d<best.d-1e-8||(Math.abs(d-best.d)<=1e-8&&z<best.z))best={d,z};
  };
  for(const t of traces||[]){
    if(t.type!=='mesh3d'||!t.x||!t.i)continue;
    const cache=new Map(),vertex=i=>{if(!cache.has(i))cache.set(i,project([t.x[i],t.y[i],t.z[i]]));return cache.get(i);};
    for(let n=0;n<t.i.length;n++){
      const [a,b,c]=[vertex(t.i[n]),vertex(t.j[n]),vertex(t.k[n])];if(!a||!b||!c)continue;
      if(Math.max(a.x,b.x,c.x)<box.left||Math.min(a.x,b.x,c.x)>box.right||Math.max(a.y,b.y,c.y)<box.top||Math.min(a.y,b.y,c.y)>box.bottom)continue;
      const den=(b.y-c.y)*(a.x-c.x)+(c.x-b.x)*(a.y-c.y);
      if(Math.abs(den)>1e-12){
        const u=((b.y-c.y)*(x-c.x)+(c.x-b.x)*(y-c.y))/den,
          v=((c.y-a.y)*(x-c.x)+(a.x-c.x)*(y-c.y))/den,w=1-u-v;
        if(u>=-1e-9&&v>=-1e-9&&w>=-1e-9)consider(x,y,u*a.z+v*b.z+w*c.z);
      }
      for(const [p,q] of [[a,b],[b,c],[c,a]]){
        const dx=q.x-p.x,dy=q.y-p.y,len=dx*dx+dy*dy;
        if(len<=1e-16)continue;
        const f=Math.max(0,Math.min(1,((x-p.x)*dx+(y-p.y)*dy)/len));
        consider(p.x+f*dx,p.y+f*dy,p.z+f*(q.z-p.z));
      }
    }
  }
  return best?.z??null;
}

export function projectPoint(point,params,scale,viewport) {
  if(!params?.model||!params?.view||!params?.projection||!scale||!viewport?.width||!viewport?.height)return null;
  const m=multiply(params.projection,multiply(params.view,params.model));
  const p=transform(m,[point[0]*scale[0],point[1]*scale[1],point[2]*scale[2],1]);
  if(!p.every(Number.isFinite)||p[3]<=1e-12)return null;
  return [viewport.left+(1+p[0]/p[3])*viewport.width/2,viewport.top+(1-p[1]/p[3])*viewport.height/2];
}

export function viewPoint(point,params,scale) {
  if(!params?.model||!params?.view||!scale)return null;
  const v=transform(params.view,transform(params.model,[point[0]*scale[0],point[1]*scale[1],point[2]*scale[2],1]));
  if(!v.every(Number.isFinite)||Math.abs(v[3])<1e-15)return null;
  return v.slice(0,3).map(x=>x/v[3]);
}

export function solve3(matrix,vector) {
  const rows=matrix.map((row,i)=>[...row,vector[i]]);
  for(let col=0;col<3;col++){
    let pivot=col;for(let row=col+1;row<3;row++)if(Math.abs(rows[row][col])>Math.abs(rows[pivot][col]))pivot=row;
    if(!Number.isFinite(rows[pivot][col])||Math.abs(rows[pivot][col])<1e-10)return null;
    [rows[col],rows[pivot]]=[rows[pivot],rows[col]];const d=rows[col][col];
    for(let k=col;k<4;k++)rows[col][k]/=d;
    for(let row=0;row<3;row++)if(row!==col){const f=rows[row][col];for(let k=col;k<4;k++)rows[row][k]-=f*rows[col][k];}
  }
  const result=rows.map(row=>row[3]);return result.every(Number.isFinite)?result:null;
}

export class BoxZoom {
  constructor(viewport, onBox, onChange) {
    this.onBox=onBox;this.onChange=onChange;this.active=false;
    this.overlay=document.createElement('div');this.overlay.className='box-zoom-overlay hidden';
    this.rectangle=document.createElement('div');this.rectangle.className='box-zoom-rectangle hidden';
    this.overlay.append(this.rectangle);viewport.append(this.overlay);
    this.overlay.addEventListener('pointerdown',event=>{
      if(!event.isPrimary||event.button!==0)return;event.preventDefault();event.stopPropagation();
      this.start=[event.clientX,event.clientY];this.overlay.setPointerCapture(event.pointerId);
      this.rectangle.classList.remove('hidden');this.move(event);
    });
    this.overlay.addEventListener('pointermove',event=>{if(this.start){event.preventDefault();event.stopPropagation();this.move(event);}});
    this.overlay.addEventListener('pointerup',event=>{
      if(!this.start)return;event.preventDefault();event.stopPropagation();
      const a=this.start,b=[event.clientX,event.clientY];this.start=null;this.setActive(false);
      if(Math.abs(a[0]-b[0])>=8&&Math.abs(a[1]-b[1])>=8)
        Promise.resolve(this.onBox({left:Math.min(a[0],b[0]),right:Math.max(a[0],b[0]),top:Math.min(a[1],b[1]),bottom:Math.max(a[1],b[1])})).catch(console.error);
    });
    this.overlay.addEventListener('pointercancel',()=>{this.start=null;this.setActive(false);});
  }
  move(event){const r=this.overlay.getBoundingClientRect(),a=this.start;
    const left=Math.min(a[0],event.clientX)-r.left,top=Math.min(a[1],event.clientY)-r.top;
    Object.assign(this.rectangle.style,{left:`${left}px`,top:`${top}px`,width:`${Math.abs(a[0]-event.clientX)}px`,height:`${Math.abs(a[1]-event.clientY)}px`});}
  setActive(value){this.active=!!value;this.start=null;this.overlay.classList.toggle('hidden',!this.active);
    this.rectangle.classList.add('hidden');this.onChange?.(this.active);}
}

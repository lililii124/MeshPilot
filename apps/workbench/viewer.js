import {BoxZoom, regionTarget, projectPoint, viewPoint, solve3, visibleFocusDepth} from './box-zoom.js';
const COLORS = ['#4979ba', '#668ca8', '#7488a9', '#608b91', '#8193a3'];

function meshFaceColor(color) {
  return '#' + color.slice(1).match(/../g).map(pair =>
    Math.round(parseInt(pair,16)*.82+255*.18).toString(16).padStart(2,'0')).join('');
}

// Plotly reports a mesh vertex, not a mouse intersection. Unproject the pointer
// with the actual WebGL matrices, then find the nearest visible display triangle.
function triangleHit(el, surface, metadata, pointer) {
  const scene=el._fullLayout?.scene?._scene, gl=scene?.glplot, params=gl?.cameraParams;
  const scale=scene?.dataScale, rect=gl?.canvas?.getBoundingClientRect();
  if(!pointer||!scale||!rect?.width||!rect?.height||!params?.model||!params?.view||!params?.projection)return null;
  const mul=(a,b)=>Array.from({length:16},(_,i)=>{const row=i%4,col=Math.floor(i/4);return [0,1,2,3].reduce((s,k)=>s+a[k*4+row]*b[col*4+k],0);});
  const m=mul(params.projection,mul(params.view,params.model));
  const unproject=z=>{
    const input=[2*(pointer[0]-rect.left)/rect.width-1,1-2*(pointer[1]-rect.top)/rect.height,z,1];
    const rows=Array.from({length:4},(_,r)=>[...Array.from({length:4},(_,c)=>m[c*4+r]),input[r]]);
    for(let c=0;c<4;c++){let pivot=c;for(let r=c+1;r<4;r++)if(Math.abs(rows[r][c])>Math.abs(rows[pivot][c]))pivot=r;
      if(!Number.isFinite(rows[pivot][c])||Math.abs(rows[pivot][c])<1e-15)return null;
      [rows[c],rows[pivot]]=[rows[pivot],rows[c]];const d=rows[c][c];for(let j=c;j<5;j++)rows[c][j]/=d;
      for(let r=0;r<4;r++)if(r!==c){const f=rows[r][c];for(let j=c;j<5;j++)rows[r][j]-=f*rows[c][j];}}
    const w=rows[3][4];if(!Number.isFinite(w)||Math.abs(w)<1e-15)return null;
    const result=rows.slice(0,3).map((r,i)=>r[4]/w/scale[i]);return result.every(Number.isFinite)?result:null;
  };
  const origin=unproject(-1),end=unproject(1);if(!origin||!end)return null;
  const sub=(x,y)=>x.map((v,i)=>v-y[i]),dot=(x,y)=>x.reduce((s,v,i)=>s+v*y[i],0),cross=(x,y)=>[x[1]*y[2]-x[2]*y[1],x[2]*y[0]-x[0]*y[2],x[0]*y[1]-x[1]*y[0]];
  const dir=sub(end,origin);let best=null;
  surface.triangles.forEach((triangle,index)=>{
    if(!metadata[index])return;
    const [a,b,c]=triangle.map(i=>surface.points[i]);if(!a||!b||!c)return;
    const ab=sub(b,a),ac=sub(c,a),p=cross(dir,ac),det=dot(ab,p);
    if(!Number.isFinite(det)||Math.abs(det)<=1e-14*Math.hypot(...ab)*Math.hypot(...ac)*Math.hypot(...dir))return;
    const s=sub(origin,a),u=dot(s,p)/det,q=cross(s,ab),v=dot(dir,q)/det,t=dot(ac,q)/det;
    if(u < -1e-8||v < -1e-8||u+v > 1+1e-8||t<0||t>1||(best&&t>=best.t))return;
    const point=a.map((value,i)=>value+u*ab[i]+v*ac[i]);if(point.every(Number.isFinite))best={point,meta:metadata[index],t};
  });
  return best||false;
}

export function partKey(surface, id) {
  return surface?.region_table?.[String(id)]?.id || `legacy:${surface?.part_names?.[String(id)] || id}`;
}

export class Viewer {
  constructor(element, onSelect) {
    this.el = element;
    this.onSelect = onSelect;
    this.meshSurface = null;
    this.surface = null;
    this.mode = 'preview';
    this.hidden = new Set();
    this.isolated = null;
    this.partColors = new Map();
    this.edges = true;
    this.camera = null;
    this.bound = false;
    this.manualCamera = false;
    this.programmaticCamera = false;
    this.rendering = false;
    this.renderPending = false;
    this.rebuildPending = false;
    this.clearPending = false;
    this.cameraPending = false;
    this.renderQueue = null;
    this.renderGeneration = 0;
    this.resizeTimer = null;
    this.selection = null;
    this.pickingEnabled = false;
    this.boxZoom = new BoxZoom(this.el.parentElement, box=>this.zoomToBox(box), active=>{
      this.el.dispatchEvent(new CustomEvent('boxzoomchange',{detail:{active}}));
    });
    this.gizmo = document.createElementNS('http://www.w3.org/2000/svg','svg');
    this.gizmo.setAttribute('viewBox','0 0 96 96');
    this.gizmo.setAttribute('class','orientation-gizmo');
    this.gizmo.setAttribute('role','img');
    this.gizmo.setAttribute('aria-label','全局坐标方向 X Y Z');
    this.gizmo.style.display='none';
    this.el.parentElement.append(this.gizmo);
    this.pointerSequence = 0;
    this.pickedSequence = 0;
    this.el.addEventListener('pointerdown', event => {
      if (event.isPrimary && event.button === 0 && !event.target.closest('.modebar')) {
        this.dragOrigin=[event.clientX,event.clientY];this.dragged=false;this.lastGestureDragged=false;this.pickPointer=[event.clientX,event.clientY];
        this.pointerSequence++;
        if (this.rendering) this.pickedSequence = this.pointerSequence;
      }
    }, true);
    // Plotly's GL orbit controller does not emit relayouting in every build.
    // Read its camera on drag frames so the corner indicator follows smoothly.
    const followCamera=()=>{
      if(this.orientationFrame)return;
      this.orientationFrame=requestAnimationFrame(()=>{
        this.orientationFrame=null;
        if(this.rendering||!this.surface)return;
        const camera=this.el._fullLayout?.scene?._scene?.getCamera?.();
        if(camera){this.camera=camera;this.manualCamera=true;this.updateOrientation(camera);}
      });
    };
    // Wheel zoom is applied by the GL controller after the browser event; some
    // Plotly builds emit a stale relayout camera. Read the controller itself.
    this.el.addEventListener('wheel',()=>{this.manualCamera=true;followCamera();},true);
    this.el.addEventListener('pointermove',event=>{
      if(event.buttons&&this.dragOrigin&&Math.hypot(event.clientX-this.dragOrigin[0],event.clientY-this.dragOrigin[1])>3){this.dragged=true;followCamera();}
    },true);
    this.el.addEventListener('pointerup',event=>{if(this.dragged)followCamera();this.lastGestureDragged=this.dragged;this.pickPointer=[event.clientX,event.clientY];this.dragOrigin=null;this.dragged=false;
      if(this.pickingEnabled&&!this.lastGestureDragged){const sequence=this.pointerSequence;setTimeout(()=>{
        if(this.pickingEnabled&&!this.rendering&&this.pointerSequence===sequence&&this.pickedSequence!==sequence){this.pickedSequence=sequence;this.selection=null;this.onSelect(null,{empty:true});this.render();}
      },250);}},true);
    const onResize = () => {
      clearTimeout(this.resizeTimer);
      this.resizeTimer = setTimeout(() => this.fitOnResize(), 180);
    };
    try {
      if (typeof ResizeObserver !== 'function') throw new Error('ResizeObserver unavailable');
      this.resizeObserver = new ResizeObserver(onResize);
      this.resizeObserver.observe(this.el);
    } catch (error) {
      this.resizeObserver?.disconnect();this.resizeObserver = null;
      window.addEventListener('resize', onResize);
      console.warn('Viewport resize observer unavailable; using window resize.', error);
    }
  }
  setPreview(data) {
    const oldHash=this.surface?.geometry_hash, newHash=data?.geometry_hash;
    if (oldHash && newHash && oldHash!==newHash) { this.camera=null; this.manualCamera=false; }
    if (!this.camera) this.manualCamera = false; this.mode = 'preview'; this.surface = data; return this.render();
  }
  setSurface(data) { if (!this.camera) this.manualCamera = false; this.meshSurface = data; return this.showMesh(); }
  showMesh() { if (!this.meshSurface) return; this.mode = 'mesh'; this.surface = this.meshSurface; return this.render(); }
  resetParts() { this.hidden.clear(); this.isolated = null; this.partColors.clear(); }
  partColor(key) {
    if (!this.partColors.has(key)) this.partColors.set(key, COLORS[this.partColors.size % COLORS.length]);
    return this.partColors.get(key);
  }
  setEdges(value) { this.edges = value; return this.render(); }
  clearSelection() { this.selection = null; return this.render(); }
  setPickingEnabled(enabled) {
    const changed=this.pickingEnabled!==!!enabled;
    this.pickingEnabled=!!enabled;
    if(changed&&this.surface)this.render();
  }
  setBoxZoomEnabled(enabled) {
    if(enabled && (!this.surface || this.rendering)) return false;
    this.boxZoom.setActive(enabled);return true;
  }
  async zoomToBox(box) {
    let scene=this.el._fullLayout?.scene?._scene,gl=scene?.glplot,params=gl?.cameraParams;
    const viewport=gl?.canvas?.getBoundingClientRect();
    const source=scene?.getCamera?.()||this.camera;
    if(!viewport){this.el.dispatchEvent(new CustomEvent('boxzoomerror'));return;}
    box={left:Math.max(viewport.left,Math.min(viewport.right,box.left)),right:Math.max(viewport.left,Math.min(viewport.right,box.right)),
         top:Math.max(viewport.top,Math.min(viewport.bottom,box.top)),bottom:Math.max(viewport.top,Math.min(viewport.bottom,box.bottom))};
    if(box.right-box.left<8||box.bottom-box.top<8)return;
    const focus=visibleFocusDepth(this.el.data,params,scene?.dataScale,viewport,box);
    const fallback=regionTarget(params,scene?.dataScale,viewport,box,source);
    let point=focus===null?fallback:regionTarget(params,scene?.dataScale,viewport,box,source,focus);
    if(!point||!source?.eye||!source?.center||!viewport){this.el.dispatchEvent(new CustomEvent('boxzoomerror'));return;}
    const factor=Math.max(.03,Math.min(.95,Math.max((box.right-box.left)/viewport.width,(box.bottom-box.top)/viewport.height)));
    let camera=JSON.parse(JSON.stringify(source));
    const update=async(value)=>{
      await Plotly.relayout(this.el,{'scene.camera':value});
      await new Promise(resolve=>setTimeout(resolve,120));
    };
    const coordinates=()=>{scene=this.el._fullLayout?.scene?._scene;gl=scene?.glplot;params=gl?.cameraParams;
      const screen=projectPoint(point,params,scene?.dataScale,gl?.canvas?.getBoundingClientRect());
      const view=viewPoint(point,params,scene?.dataScale);
      return screen&&view?[screen[0],screen[1],view[2]]:null;};
    this.programmaticCamera=true;this.el.setAttribute('data-boxzoom-busy','true');
    this.el.dispatchEvent(new CustomEvent('boxzoombusy',{detail:{busy:true}}));
    const centerTarget=async()=>{
      for(let iteration=0;iteration<4;iteration++){
        const position=coordinates();if(!position)throw new Error('Selected region is outside the camera');
        const distance=Math.hypot(...['x','y','z'].map(k=>camera.eye[k]-camera.center[k]));
        const residual=[viewport.left+viewport.width/2-position[0],viewport.top+viewport.height/2-position[1],-distance-position[2]];
        if(Math.hypot(residual[0],residual[1])<2&&Math.abs(residual[2])<1e-5*Math.max(1,distance))break;
        const derivatives=[];
        for(const k of ['x','y','z']){
          const trial=JSON.parse(JSON.stringify(camera));trial.center[k]+=.005;trial.eye[k]+=.005;
          await update(trial);const p=coordinates();if(!p)throw new Error('Camera projection unavailable');
          derivatives.push(p.map((v,i)=>(v-position[i])/.005));
        }
        const delta=solve3([0,1,2].map(i=>derivatives.map(column=>column[i])),residual);
        if(!delta)throw new Error('Camera translation cannot be resolved');
        for(let i=0;i<3;i++){const k='xyz'[i];camera.center[k]+=delta[i];camera.eye[k]+=delta[i];}
        await update(camera);
      }
      const final=coordinates();
      if(!final||Math.hypot(final[0]-(viewport.left+viewport.width/2),final[1]-(viewport.top+viewport.height/2))>12)
        throw new Error('Camera could not center the selected region');
      const distance=Math.hypot(...['x','y','z'].map(k=>camera.eye[k]-camera.center[k]));
      if(Math.abs(final[2]+distance)>1e-3*Math.max(1,distance))throw new Error('Camera could not focus the selected region');
    };
    try {
      // First pan the target plane at the current scale, then zoom around it.
      // Recheck the result with the real matrices, without assuming any FOV.
      const attempt=async()=>{
        camera=JSON.parse(JSON.stringify(source));await update(camera);await centerTarget();
        camera.eye=Object.fromEntries(['x','y','z'].map(k=>[k,camera.center[k]+(camera.eye[k]-camera.center[k])*factor]));
        await update(camera);await centerTarget();
      };
      try {await attempt();}
      catch(error) {
        if(focus===null||!fallback)throw error;
        await update(source);point=fallback;await attempt();
      }
      this.camera=scene?.getCamera?.()||camera;this.manualCamera=true;this.updateOrientation(this.camera);
    } catch(error) {
      await update(source);this.el.dispatchEvent(new CustomEvent('boxzoomerror',{detail:{message:String(error.message||error)}}));
    } finally {this.programmaticCamera=false;this.el.setAttribute('data-boxzoom-busy','false');
      this.el.dispatchEvent(new CustomEvent('boxzoombusy',{detail:{busy:false}}));}
  }
  togglePart(id) { this.hidden.has(id) ? this.hidden.delete(id) : this.hidden.add(id); this.isolated = null; return this.render(); }
  isolate(id) {
    if (this.isolated === id) this.isolated = null;
    else { this.hidden.delete(id); this.isolated = id; }
    return this.render();
  }
  clear() {
    this.renderGeneration++;
    this.surface = null;
    this.meshSurface = null;
    this.selection = null;
    this.boxZoom.setActive(false);
    this.gizmo.style.display='none';
    this.renderPending = false;
    this.rebuildPending = false;
    this.cameraPending = false;
    this.clearPending = true;
    return this.drainRenders();
  }
  render(rebuild = false) {
    if (!this.surface) return Promise.resolve();
    if (!window.Plotly) return Promise.reject(new Error('绘图组件不可用，无法显示几何或网格。'));
    this.renderPending = true;
    this.rebuildPending ||= rebuild;
    return this.drainRenders();
  }
  drainRenders() {
    if (this.renderQueue) return this.renderQueue;
    this.rendering = true;
    this.el.setAttribute('aria-busy', 'true');
    this.pickedSequence = this.pointerSequence;
    this.renderQueue = Promise.resolve().then(async () => {
      let failure = null;
      try {
        while (this.clearPending || this.renderPending || this.cameraPending) {
          if (this.clearPending) {
            this.clearPending = false;
            if (window.Plotly) Plotly.purge(this.el);
            this.bound = false;
            continue;
          }
          const generation = this.renderGeneration;
          const render = this.renderPending, rebuild = this.rebuildPending;
          if (render) { this.renderPending = false; this.rebuildPending = false; }
          else this.cameraPending = false;
          try {
            if (render) await this.renderOnce(rebuild, generation);
            else await this.applyAutomaticCamera(generation);
          }
          catch (error) { if (generation === this.renderGeneration) failure = error; }
        }
      } finally {
        this.rendering = false;
        this.el.setAttribute('aria-busy', 'false');
        this.renderQueue = null;
      }
      if (failure) throw failure;
    });
    return this.renderQueue;
  }
  sceneFrame() {
    const points = this.surface?.points || [];
    const bounds = this.surface?.bounds || [[Infinity,Infinity,Infinity],[-Infinity,-Infinity,-Infinity]];
    if (!this.surface?.bounds) points.forEach(point => point.forEach((value,index) => {
      bounds[0][index] = Math.min(bounds[0][index],value);
      bounds[1][index] = Math.max(bounds[1][index],value);
    }));
    const ranges = [0,1,2].map(index => {
      const lo=bounds[0][index],hi=bounds[1][index];
      if (!Number.isFinite(lo)||!Number.isFinite(hi)||hi<lo) return [-1,1];
      const pad=Math.max((hi-lo)*.04,1e-6);
      return [lo-pad,hi+pad];
    });
    const spans=ranges.map(([lo,hi])=>hi-lo), longest=Math.max(...spans);
    // Equal distance in model units has equal displayed length. Normalizing by
    // the longest axis keeps thin/long models inside a bounded scene cube.
    return {ranges,aspect:{x:spans[0]/longest,y:spans[1]/longest,z:spans[2]/longest}};
  }
  updateOrientation(camera) {
    if(!camera?.eye)return;
    const vec=v=>[v?.x||0,v?.y||0,v?.z||0];
    const dot=(a,b)=>a.reduce((sum,v,i)=>sum+v*b[i],0);
    const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
    const unit=v=>{const length=Math.hypot(...v);return length>1e-10?v.map(x=>x/length):null;};
    const eye=vec(camera.eye),center=vec(camera.center),forward=unit(eye.map((v,i)=>v-center[i]));
    if(!forward)return;
    const right=unit(cross(vec(camera.up||{x:0,y:0,z:1}),forward));
    if(!right)return;
    const up=cross(forward,right),ns='http://www.w3.org/2000/svg';
    const node=(tag,attrs,text)=>{const el=document.createElementNS(ns,tag);Object.entries(attrs).forEach(([k,v])=>el.setAttribute(k,String(v)));if(text)el.textContent=text;return el;};
    const axes=[{name:'X',v:[1,0,0],color:'#c94545'},{name:'Y',v:[0,1,0],color:'#20865a'},{name:'Z',v:[0,0,1],color:'#356fc3'}];
    this.gizmo.replaceChildren();
    axes.sort((a,b)=>dot(a.v,forward)-dot(b.v,forward)).forEach(axis=>{
      const dx=dot(axis.v,right),dy=-dot(axis.v,up),x=48+29*dx,y=49+29*dy;
      this.gizmo.append(node('line',{x1:48,y1:49,x2:x,y2:y,stroke:axis.color,'stroke-width':2.6,'stroke-linecap':'round'}));
      this.gizmo.append(node('circle',{cx:x,cy:y,r:3,fill:axis.color}));
      const length=Math.hypot(dx,dy),tx=length>.1?dx/length*10:9,ty=length>.1?dy/length*10:-9;
      this.gizmo.append(node('text',{x:x+tx,y:y+ty,'text-anchor':'middle','dominant-baseline':'central',fill:axis.color,'font-size':12,'font-weight':700},axis.name));
    });
    this.gizmo.append(node('circle',{cx:48,cy:49,r:3,fill:'#637780'}));
    this.gizmo.style.display='block';
  }
  defaultCamera(frame = this.sceneFrame()) {
    const width = Math.max(this.el.clientWidth, 1);
    const height = Math.max(this.el.clientHeight, 1);
    const normalize=v=>{const length=Math.hypot(...v);return v.map(value=>value/length);};
    const direction=normalize([1,1,.82]),right=normalize([-direction[1],direction[0],0]);
    const up=[-direction[2]*right[1],direction[2]*right[0],direction[0]*right[1]-direction[1]*right[0]];
    const dot=(a,b)=>a.reduce((sum,value,index)=>sum+value*b[index],0);
    const half=[frame.aspect.x/2,frame.aspect.y/2,frame.aspect.z/2];
    // Plotly's perspective has a 45-degree vertical field of view. For every
    // visible model point, d-depth must exceed its horizontal and vertical projection
    // Axes live outside the scene; use more of the available viewport.
    const tanY=Math.tan(Math.PI/8),tanX=tanY*width/height,fill=.9;
    let distance=0;
    const fit=point=>{
      distance=Math.max(distance,dot(point,direction)+Math.max(Math.abs(dot(point,right))/tanX,Math.abs(dot(point,up))/tanY)/fill);
    };
    if(this.surface?.points?.length){
      for(const point of this.surface.points)fit(point.map((value,index)=>
        (value-(frame.ranges[index][0]+frame.ranges[index][1])/2)/(frame.ranges[index][1]-frame.ranges[index][0])*half[index]*2));
    }else for(const x of [-1,1])for(const y of [-1,1])for(const z of [-1,1])fit([x*half[0],y*half[1],z*half[2]]);
    return {eye:{x:direction[0]*distance,y:direction[1]*distance,z:direction[2]*distance},
      center:{x:0,y:0,z:0},up:{x:0,y:0,z:1},projection:{type:'perspective'}};
  }
  setAutomaticCamera() {
    if (!window.Plotly || !this.el.data || this.manualCamera) return;
    this.cameraPending = true;
    return this.drainRenders();
  }
  async applyAutomaticCamera(generation) {
    if (!window.Plotly || !this.el.data || this.manualCamera) return;
    this.programmaticCamera = true;
    try {
      const camera = this.defaultCamera();
      await Plotly.relayout(this.el, {'scene.camera': camera});
      if (generation !== this.renderGeneration) return;
      this.camera = camera;
      // Recreate the orbit controller on an explicit reset: older WebGL scenes
      // can retain a manually dragged view even after the layout camera changes.
      this.renderPending = true;
      this.rebuildPending = true;
    } finally {
      this.programmaticCamera = false;
    }
  }
  fitOnResize() {
    if (!window.Plotly || !this.el.data || !this.surface) return;
    // The canvas must follow container-only resizes too. Queue the resize with
    // ordinary renders; renderOnce preserves a manually chosen camera.
    return this.render();
  }
  resetCamera() {
    this.boxZoom.setActive(false);
    this.manualCamera = false;
    this.camera = null;
    return this.setAutomaticCamera();
  }
  async renderOnce(rebuild, generation) {
    if (!window.Plotly || !this.surface) return;
    const surface = this.surface, points = surface.points || [];
    let triangles = surface.triangles || [];
    let parts = surface.part_ids || [], cells = surface.cell_ids || [];
    const visibleKeys=new Set(parts.map(id=>partKey(surface,id)));
    if(this.isolated!==null&&!visibleKeys.has(this.isolated))this.isolated=null;
    const traces = [],pickMetadata=[];
    [...new Set(parts.map(String))].forEach(id => {
      const key = partKey(surface, id), color = this.partColor(key);
      if (this.hidden.has(key) || (this.isolated !== null && this.isolated !== key)) return;
      const x=[], y=[], z=[], i=[], j=[], k=[], custom=[], ex=[], ey=[], ez=[], seenEdges=new Set(), vertexGroups=new Map();
      const addEdge=(a,b)=>{const edge=a<b?`${a}:${b}`:`${b}:${a}`;if(seenEdges.has(edge))return;seenEdges.add(edge);
        [a,b].forEach(vertex=>{ex.push(points[vertex][0]);ey.push(points[vertex][1]);ez.push(points[vertex][2]);});ex.push(null);ey.push(null);ez.push(null);};
      triangles.forEach((triangle, n) => {
        if (String(parts[n]) !== id) return;
        const [a,b,c]=triangle.map(vertex=>points[vertex]);
        const u=b.map((v,index)=>v-a[index]),v=c.map((value,index)=>value-a[index]);
        const normal=[u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0]];
        const length=Math.hypot(...normal);
        const numericPart=Number(id);
        const center=a.map((value,index)=>(value+b[index]+c[index])/3);
        const meta={part_id:Number.isSafeInteger(numericPart)&&numericPart>=0?numericPart:null,part_name:(surface.part_names||{})[id]||`部件 ${id}`,cell_id:cells[n]??null,triangle_id:n,point:center,normal:length?normal.map(value=>value/length):null};
        if(surface.units)meta.units=surface.units;
        if(surface.schema_version)meta.schema_version=surface.schema_version;
        const binding=surface.region_table?.[id];
        if(binding){meta.region_id=binding.id;meta.source_operation_id=binding.source;}
        if(surface.face_ids?.[n]!=null)meta.face_id=surface.face_ids[n];
        if(surface.geometry_hash)meta.geometry_hash=surface.geometry_hash;
        if(surface.artifact_id)meta.artifact_id=surface.artifact_id;
        if(surface.surface_id)meta.surface_id=surface.surface_id;
        if(surface.surface_view)meta.surface_view=surface.surface_view;
        pickMetadata[n]=meta;
        const indices=triangle.map(vertex=>{
          const point=points[vertex],face=surface.face_ids?.[n]??null;
          let groups=vertexGroups.get(vertex);
          if(!groups){groups=[];vertexGroups.set(vertex,groups);}
          // Per-triangle vertices retain exact click metadata when selection is
          // active. Otherwise share vertices only within a CAD face or across
          // similarly oriented triangles, preserving sharp model edges.
          let group=!this.pickingEnabled&&groups.find(item=>face!==null
            ? item.face===face : item.face===null&&length&&item.normal.reduce((sum,v,q)=>sum+v*normal[q]/length,0)>.866);
          if(!group){group={index:x.length,face,normal:length?normal.map(value=>value/length):[0,0,0]};groups.push(group);
            x.push(point[0]);y.push(point[1]);z.push(point[2]);custom.push(meta);}
          return group.index;
        });
        i.push(indices[0]); j.push(indices[1]); k.push(indices[2]);
        if (this.mode === 'mesh' && this.edges && !surface.quad_edges) {
          triangle.forEach((vertex,index)=>addEdge(vertex,triangle[(index+1)%3]));
        }
      });
      if (this.mode === 'mesh' && this.edges && surface.quad_edges) {
        surface.quad_edges.forEach((edge, n) => {
          if (String(surface.quad_edge_part_ids?.[n]) !== id) return;
          addEdge(edge[0],edge[1]);
        });
      }
      traces.push({type:'mesh3d', x,y,z,i,j,k,customdata:custom,color:this.mode==='mesh'?meshFaceColor(color):color,flatshading:this.pickingEnabled,
        name:(surface.part_names||{})[id]||`部件 ${id}`, hoverinfo:'name',
        lighting:{ambient:.62,diffuse:.72,specular:.3,roughness:.48,fresnel:.04},lightposition:{x:1000,y:1500,z:2000}});
      if (this.mode === 'mesh' && this.edges) traces.push({type:'scatter3d',mode:'lines',x:ex,y:ey,z:ez,line:{color:'#274d6a',width:2},opacity:1,hoverinfo:'skip',showlegend:false});
    });
    if(this.selection){const point=this.selection.point;traces.push({type:'scatter3d',mode:'markers',x:[point[0]],y:[point[1]],z:[point[2]],marker:{size:7,color:'#ffb020',line:{color:'#ffffff',width:2}},hoverinfo:'skip',showlegend:false});}
    // Keep physical bounds stable when Plotly changes camera/projection or traces.
    const frame=this.sceneFrame();
    const axis=(title,index)=>({title:{text:''},visible:false,showticklabels:false,ticks:'',showgrid:false,zeroline:false,showbackground:false,showspikes:false,autorange:false,range:frame.ranges[index]});
    // The controller can be newer than plotly_relayout, especially during wheel
    // zoom. Capture it before react replaces the scene's camera.
    if (this.manualCamera && !rebuild) {
      const live=this.el._fullLayout?.scene?._scene?.getCamera?.();
      if (live) this.camera=live;
    }
    const camera=this.manualCamera&&this.camera?this.camera:this.defaultCamera(frame);
    if (rebuild) this.bound = false;
    await Plotly[rebuild ? 'newPlot' : 'react'](this.el,traces,{width:Math.max(this.el.clientWidth,1),height:Math.max(this.el.clientHeight,1),margin:{l:0,r:0,t:0,b:0},paper_bgcolor:'rgba(0,0,0,0)',plot_bgcolor:'rgba(0,0,0,0)',showlegend:false,uirevision:'meshpilot',
        scene:{bgcolor:'rgba(0,0,0,0)',aspectmode:'manual',aspectratio:frame.aspect,camera,xaxis:axis('X',0),yaxis:axis('Y',1),zaxis:axis('Z',2)}},
        {responsive:true,displaylogo:false,modeBarButtonsToRemove:['toImage']});
    if (generation !== this.renderGeneration) return;
    this.pickMetadata=pickMetadata;
    if (!this.manualCamera) this.camera=camera;
    this.updateOrientation(this.camera||camera);
    if (!this.bound) {
      this.el.on('plotly_relayouting', event => {if(event['scene.camera'])this.updateOrientation(event['scene.camera']);});
      this.el.on('plotly_relayout', event => {
        if(event['scene.camera'])this.updateOrientation(event['scene.camera']);
        if (event['scene.camera'] && !this.programmaticCamera && !this.rendering) {
          const previousProjection=this.camera?.projection?.type||'perspective';
          this.camera=event['scene.camera'];
          this.manualCamera=true;
          // Older Plotly WebGL scenes can go blank when changing projection in place.
          // Recreate the scene after the relayout finishes, retaining its camera.
          if ((this.camera.projection?.type||'perspective') !== previousProjection)
            setTimeout(() => this.render(true), 0);
        }
      });
      this.el.on('plotly_click', event => {
        if (!this.pickingEnabled) return;
        // A WebGL redraw can emit another click while processing the previous pick.
        // Only one selection may be made for each actual pointer gesture.
        if (this.rendering) { this.pickedSequence = this.pointerSequence; return; }
        if (this.pickedSequence === this.pointerSequence) return;
        this.pickedSequence = this.pointerSequence;
        if (this.lastGestureDragged) return;
        const p=event.points?.[0],meta=p?.data?.customdata?.[p.pointNumber];
        if(!meta||!meta.point.every(Number.isFinite))return;
        const hit=triangleHit(this.el,this.surface,this.pickMetadata||[],this.pickPointer);
        if(!hit){this.selection=null;this.onSelect(null,{empty:hit===false});requestAnimationFrame(()=>this.render());return;}
        this.selection={...hit.meta,point:hit.point,surface_kind:this.mode==='mesh'?'mesh':'geometry_preview'};
        this.onSelect(this.selection);
        requestAnimationFrame(() => this.render());
      });
      this.bound=true;
    }
  }
}
export {COLORS};

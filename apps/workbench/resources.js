// Display buffers only. WebGL does not expose reliable available VRAM.
// Estimates are advisory: neither this module nor its callers reject a mesh.
export function displayMemoryEstimate(surface) {
  const nodes=surface?.points?.length||0, triangles=surface?.triangles?.length||0;
  const edges=surface?.edges?.length??triangles*3;
  if(!nodes||!triangles)return null;
  // Indexed coordinates/normals/colors plus expanded triangles and edge buffers.
  const low=nodes*40+triangles*48+edges*32;
  return {lowBytes:low,highBytes:low*3,availableBytes:null,basis:'surface'};
}

export function generationMemoryEstimate(config, surface) {
  const mesh=config?.mesh||{},size=Number(mesh.recipe?.size??mesh.size);
  if(!(size>0)||!Number.isFinite(size)||!surface?.points?.length)return null;
  const lo=[Infinity,Infinity,Infinity],hi=[-Infinity,-Infinity,-Infinity];
  for(const p of surface.points)for(let i=0;i<3;i++){lo[i]=Math.min(lo[i],p[i]);hi[i]=Math.max(hi[i],p[i]);}
  const counts=lo.map((v,i)=>Math.max(1,Math.ceil((hi[i]-v)/size)));
  const shell=mesh.dimension===2||String(mesh.element_type).startsWith('quad')||String(mesh.element_type).startsWith('tri');
  const faceCells=2*(counts[0]*counts[1]+counts[1]*counts[2]+counts[0]*counts[2]);
  const cells=shell?faceCells:counts[0]*counts[1]*counts[2];
  if(!Number.isFinite(cells))return {lowBytes:null,highBytes:null,availableBytes:null,basis:'unknown'};
  // Bounding-box sizing is not an element count prediction for curved/local meshes.
  // Range spans a compact exterior to exposed internal faces, with buffer overhead.
  return {lowBytes:Math.min(faceCells,cells*6)*160,highBytes:cells*(shell?640:3840),availableBytes:null,basis:'bounds'};
}

export function memoryNotice(estimate) {
  if(!estimate)return '';
  if(estimate.highBytes===null)return '显示显存需求暂无法估算；可用显存未知。可继续生成。';
  if(estimate.highBytes<256*1024**2)return '';
  const format=n=>n>=1024**3?(n/1024**3).toFixed(1)+' GiB':Math.ceil(n/1024**2)+' MiB';
  return `${estimate.basis==='bounds'?'按尺寸和包围盒粗估':'按显示表面估算'}显示显存 ${format(estimate.lowBytes)}–${format(estimate.highBytes)}（软件渲染时使用内存）；可用显存未知。仅供参考，不限制生成。`;
}

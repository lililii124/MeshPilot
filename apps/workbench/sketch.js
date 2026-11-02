const TOOLS = [['pen','自由线'],['line','直线'],['rectangle','矩形'],['ellipse','椭圆'],['arrow','箭头'],['dimension','尺寸'],['text','文字'],['erase','橡皮']];

// A visual reference editor: coordinates are pixels, never engineering lengths.
export class SketchEditor {
  constructor(onAttach) {
    this.onAttach=onAttach;this.documents=new Map();this.project=null;this.tool='pen';this.active=null;this.busy=false;
    this.dialog=document.createElement('dialog');this.dialog.className='sketch-dialog';this.dialog.id='sketch-dialog';
    this.dialog.setAttribute('aria-labelledby','sketch-title');
    this.dialog.innerHTML=`<div class="dialog-header"><div><h2 id="sketch-title">画一张草图</h2><p>表达外形和关系；用尺寸标注或对话补充实际大小。</p></div><button type="button" data-sketch="close" class="icon-button" aria-label="关闭草图">×</button></div>
      <div class="sketch-toolbar" role="toolbar" aria-label="绘图工具"></div>
      <div class="sketch-options"><label>标注文字<input id="sketch-label" maxlength="120" placeholder="例如：50 mm、俯视图、通孔"></label><span class="hint">不按比例 · 像素长度不作为模型尺寸</span></div>
      <div class="sketch-paper"><canvas id="sketch-canvas" width="1600" height="900" aria-label="草图画布，支持鼠标和触控笔"></canvas><span class="sketch-paper-note">SKETCH / 形状参考</span></div>
      <div class="sketch-footer"><span id="sketch-status" role="status">选择工具，在画布上绘制。</span><button type="button" data-sketch="attach" class="primary">添加到对话</button></div>`;
    document.body.append(this.dialog);this.canvas=this.dialog.querySelector('canvas');this.context=this.canvas.getContext('2d');
    const toolbar=this.dialog.querySelector('.sketch-toolbar');
    TOOLS.forEach(([id,label])=>{const b=document.createElement('button');b.type='button';b.dataset.tool=id;b.textContent=label;b.onclick=()=>{this.tool=id;this.active=null;this.refresh();if(['text','dimension'].includes(id))this.dialog.querySelector('input').focus();};toolbar.append(b);});
    const divider=document.createElement('span');divider.className='sketch-divider';toolbar.append(divider);
    [['undo','撤销'],['redo','重做'],['clear','清空']].forEach(([id,label])=>{const b=document.createElement('button');b.type='button';b.dataset.sketch=id;b.textContent=label;toolbar.append(b);});
    this.dialog.querySelector('[data-sketch=close]').onclick=()=>this.dialog.close();
    this.dialog.querySelector('[data-sketch=undo]').onclick=()=>{const d=this.document();if(d.index>0)d.index--;this.active=null;this.refresh();};
    this.dialog.querySelector('[data-sketch=redo]').onclick=()=>{const d=this.document();if(d.index<d.history.length-1)d.index++;this.active=null;this.refresh();};
    this.dialog.querySelector('[data-sketch=clear]').onclick=()=>{if(this.shapes().length)this.commit([]);};
    this.dialog.querySelector('[data-sketch=attach]').onclick=()=>this.attach();
    this.dialog.addEventListener('cancel',event=>{if(this.busy)event.preventDefault();});
    this.dialog.addEventListener('close',()=>{this.active=null;});
    this.dialog.addEventListener('keydown',event=>{
      if(event.target instanceof HTMLInputElement)return;
      if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='z'){event.preventDefault();this.dialog.querySelector(`[data-sketch=${event.shiftKey?'redo':'undo'}]`).click();}
    });
    this.canvas.addEventListener('pointerdown',event=>this.begin(event));
    this.canvas.addEventListener('pointermove',event=>this.move(event));
    this.canvas.addEventListener('pointerup',event=>this.end(event));
    this.canvas.addEventListener('pointercancel',()=>{this.active=null;this.refresh();});
  }
  document(){if(!this.documents.has(this.project))this.documents.set(this.project,{history:[[]],index:0});return this.documents.get(this.project);}
  shapes(){const d=this.document();return d.history[d.index];}
  open(project){this.project=project;this.active=null;this.refresh();this.dialog.showModal();}
  point(event){const r=this.canvas.getBoundingClientRect();return [Math.max(0,Math.min(1600,(event.clientX-r.left)*1600/r.width)),Math.max(0,Math.min(900,(event.clientY-r.top)*900/r.height))];}
  say(message){this.dialog.querySelector('#sketch-status').textContent=message;}
  commit(shapes){const d=this.document();d.history=d.history.slice(0,d.index+1);d.history.push(shapes);if(d.history.length>101)d.history.shift();d.index=d.history.length-1;this.refresh();}
  begin(event){
    if(this.busy||event.button!==0)return;event.preventDefault();const p=this.point(event);
    if(this.tool==='erase'){const index=this.shapes().findLastIndex(shape=>this.hit(shape,p));if(index>=0)this.commit(this.shapes().filter((_,i)=>i!==index));return;}
    if(this.shapes().length>=300){this.say('当前草图最多 300 个笔画或图形，请精简后继续。');return;}
    const text=this.dialog.querySelector('input').value.trim();
    if(['text','dimension'].includes(this.tool)&&!text){this.say('先填写尺寸或文字，再在画布上标注。');this.dialog.querySelector('input').focus();return;}
    if(this.tool==='text'){this.commit([...this.shapes(),{tool:'text',points:[p],text}]);return;}
    this.canvas.setPointerCapture(event.pointerId);this.active={tool:this.tool,points:[p,p],text,pointer:event.pointerId};this.refresh();
  }
  move(event){
    if(!this.active||event.pointerId!==this.active.pointer)return;const p=this.point(event),a=this.active;
    if(a.tool==='pen'){const last=a.points.at(-1);if(Math.hypot(p[0]-last[0],p[1]-last[1])>=2&&a.points.length<2000)a.points.push(p);}else a.points[1]=p;
    this.draw();
  }
  end(event){
    if(!this.active||event.pointerId!==this.active.pointer)return;this.move(event);const a=this.active;this.active=null;
    if(this.canvas.hasPointerCapture(event.pointerId))this.canvas.releasePointerCapture(event.pointerId);
    const [p,q]=[a.points[0],a.points.at(-1)];if(a.tool==='pen'||Math.hypot(q[0]-p[0],q[1]-p[1])>4){delete a.pointer;this.commit([...this.shapes(),a]);}else this.refresh();
  }
  path(shape){
    const [p,q=p]=shape.points;
    if(shape.tool==='rectangle')return [p,[q[0],p[1]],q,[p[0],q[1]],p];
    if(shape.tool==='ellipse')return Array.from({length:49},(_,i)=>{const a=i*Math.PI/24;return [(p[0]+q[0])/2+Math.abs(q[0]-p[0])/2*Math.cos(a),(p[1]+q[1])/2+Math.abs(q[1]-p[1])/2*Math.sin(a)];});
    return shape.points;
  }
  hit(shape,p){
    if(shape.tool==='text'){const a=shape.points[0];return p[0]>=a[0]-12&&p[0]<=a[0]+shape.text.length*26&&Math.abs(p[1]-a[1])<30;}
    const points=this.path(shape);
    return points.slice(1).some((b,i)=>{const a=points[i],dx=b[0]-a[0],dy=b[1]-a[1],t=Math.max(0,Math.min(1,((p[0]-a[0])*dx+(p[1]-a[1])*dy)/(dx*dx+dy*dy||1)));return Math.hypot(p[0]-a[0]-t*dx,p[1]-a[1]-t*dy)<16;});
  }
  draw(){
    const c=this.context;c.fillStyle='#ffffff';c.fillRect(0,0,1600,900);c.strokeStyle='#203c46';c.fillStyle='#203c46';c.lineWidth=4;c.lineCap='round';c.lineJoin='round';c.font='28px system-ui, sans-serif';c.textBaseline='middle';
    const line=points=>{c.beginPath();points.forEach((p,i)=>i?c.lineTo(...p):c.moveTo(...p));c.stroke();};
    const arrow=(a,b)=>{const angle=Math.atan2(b[1]-a[1],b[0]-a[0]);line([[b[0]-18*Math.cos(angle-.45),b[1]-18*Math.sin(angle-.45)],b,[b[0]-18*Math.cos(angle+.45),b[1]-18*Math.sin(angle+.45)]]);};
    [...this.shapes(),...(this.active?[this.active]:[])].forEach(shape=>{const p=shape.points[0],q=shape.points.at(-1);
      if(shape.tool==='text'){c.fillText(shape.text,p[0],p[1]);return;}
      line(this.path(shape));
      if(['arrow','dimension'].includes(shape.tool))arrow(p,q);
      if(shape.tool==='dimension'){arrow(q,p);const text=shape.text,x=(p[0]+q[0])/2,y=(p[1]+q[1])/2-24,w=c.measureText(text).width;c.fillStyle='#fff';c.fillRect(x-w/2-6,y-18,w+12,36);c.fillStyle='#203c46';c.fillText(text,x-w/2,y);}
    });
  }
  refresh(){
    const d=this.document();this.dialog.querySelectorAll('[data-tool]').forEach(b=>{const active=b.dataset.tool===this.tool;b.classList.toggle('active',active);b.setAttribute('aria-pressed',String(active));});
    this.dialog.querySelector('[data-sketch=undo]').disabled=this.busy||d.index===0;
    this.dialog.querySelector('[data-sketch=redo]').disabled=this.busy||d.index===d.history.length-1;
    this.dialog.querySelector('[data-sketch=clear]').disabled=this.busy||!this.shapes().length;
    this.dialog.querySelector('[data-sketch=attach]').disabled=this.busy||!this.shapes().length;
    this.draw();
  }
  async attach(){
    if(this.busy||!this.shapes().length)return;this.active=null;this.busy=true;this.refresh();
    this.dialog.querySelectorAll('[data-tool],input,[data-sketch=close]').forEach(c=>c.disabled=true);this.say('正在添加草图…');
    try{const blob=await new Promise(resolve=>this.canvas.toBlob(resolve,'image/png'));if(!blob)throw new Error('草图导出失败，请重试');await this.onAttach(blob,this.project);this.dialog.close();this.say('草图已添加，继续用文字描述建模要求。');}
    catch(error){this.say(error.message||'添加失败，请重试。');}
    finally{this.busy=false;this.dialog.querySelectorAll('[data-tool],input,[data-sketch=close]').forEach(c=>c.disabled=false);this.refresh();}
  }
}

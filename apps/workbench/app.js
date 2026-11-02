import {Viewer, partKey} from './viewer.js';
import {SketchEditor} from './sketch.js';
import {displayMemoryEstimate,generationMemoryEstimate,memoryNotice} from './resources.js';
const $ = id => document.getElementById(id);

function showResourceNotice(estimate){
  let hint=$('resource-notice');
  if(!hint){hint=document.createElement('div');hint.id='resource-notice';hint.setAttribute('role','status');document.querySelector('.workspace').append(hint);}
  hint.textContent=memoryNotice(estimate);hint.classList.toggle('hidden',!hint.textContent);
}
document.querySelectorAll('[data-tab]').forEach(b=>b.onclick=()=>activateTab(b.dataset.tab));
const api = '/api/v1';
const state = {project:null, config:null, dirty:false, artifact:null, report:null, check:null, checkStartedAt:null, checkTimer:null, job:null, jobReport:null,
  selected:null, selection:null, preview:null, previewKey:null, previewSeq:0, viewSeq:0,
  surfaceSeq:0, projectSeq:0, view:'preview', submitting:false, conversing:false, transaction:false, saving:0, provider:null,
  providers:[], catalog:{}, providerDirty:false, providerSwitched:false, redoStack:[], generationStage:null, generationStartedAt:null, generationTimer:null};
const conversations = new Map();
const drafts = new Map();
const attachmentDrafts = new Map();
const attachmentUploads = new Map();
let attachmentLimits={max_images_per_turn:4,max_file_bytes:5*1024*1024,max_turn_bytes:10*1024*1024};
let sketch=null, initializationErrors=[];
let licenseState=null, licenseRequiredAtStart=false;
try {sketch=new SketchEditor((blob,project)=>uploadImage(blob,project,'在线草图'));}
catch(error){initializationErrors.push('草图功能初始化失败：'+(error.message||String(error)));console.error('Sketch initialization failed',error);}
function currentAttachments(id=state.project?.id){return attachmentDrafts.get(id)||[];}
function imageLimit(){return attachmentLimits.max_images_per_turn||4;}
function addExistingImage(item){const id=state.project?.id;if(!id||item.project_id!==id||state.conversing)return;
  const items=currentAttachments(id);if(items.some(image=>image.id===item.id))return;
  if(items.length>=imageLimit()){toast(`每条消息最多附 ${imageLimit()} 张图片`);return;}
  attachmentDrafts.set(id,[...items,item]);renderAttachments();}
function renderAttachments(){
  const tray=$('attachment-tray');if(!tray)return;tray.replaceChildren();
  currentAttachments().forEach(item=>{const card=document.createElement('div');card.className='attachment-card';
    const img=document.createElement('img');img.src=item.url;img.alt=item.label||item.name;img.width=64;img.height=48;
    const name=document.createElement('span');name.textContent=item.label||item.name;
    const remove=document.createElement('button');remove.type='button';remove.textContent='×';remove.setAttribute('aria-label',`从当前消息移除${name.textContent}`);remove.disabled=state.conversing;
    remove.onclick=()=>{attachmentDrafts.set(state.project.id,currentAttachments().filter(image=>image.id!==item.id));renderAttachments();};card.append(img,name,remove);tray.append(card);});
  if(attachmentUploads.get(state.project?.id)){const pending=document.createElement('span');pending.className='hint';pending.textContent='图片上传中…';tray.append(pending);}
  if(currentAttachments().length){const hint=document.createElement('span');hint.className='attachment-hint';hint.textContent='参考图会随后续对话发送；点 × 可停止引用。';tray.append(hint);}
  tray.classList.toggle('hidden',!tray.children.length);
}
async function uploadImage(file,id=state.project?.id,label=null){
  if(!id)throw new Error('请先新建或打开项目');
  if(!['image/png','image/jpeg','image/webp'].includes(file.type))throw new Error('请使用 PNG、JPEG 或 WebP 图片');
  if(file.size>(attachmentLimits.max_file_bytes||5*1024*1024))throw new Error('图片超过当前大小限制，请缩小后重试');
  if(currentAttachments(id).reduce((total,item)=>total+item.byte_count,0)+file.size>(attachmentLimits.max_turn_bytes||10*1024*1024))throw new Error('本轮图片总大小超过限制，请移除部分参考图或缩小图片');
  if(currentAttachments(id).length+(attachmentUploads.get(id)||0)>=imageLimit())throw new Error(`每条消息最多附 ${imageLimit()} 张图片`);
  attachmentUploads.set(id,(attachmentUploads.get(id)||0)+1);renderAttachments();updateButtons();
  try{const result=await request(`/projects/${encodeURIComponent(id)}/attachments`,{method:'POST',headers:{'Content-Type':file.type},body:file});
    attachmentDrafts.set(id,[...currentAttachments(id),{...result.attachment,label:label||file.name||result.attachment.name}]);
  }finally{attachmentUploads.set(id,Math.max(0,(attachmentUploads.get(id)||1)-1));renderAttachments();updateButtons();}
}
function configKey(value) {
  const canonical = item => Array.isArray(item) ? item.map(canonical)
    : item && typeof item==='object' ? Object.fromEntries(Object.keys(item).sort().map(key=>[key,canonical(item[key])])) : item;
  return JSON.stringify(canonical(value));
}
function renderConversation() {
  const log=$('chat-log'); log.replaceChildren();
  const messages=conversations.get(state.project?.id)||[];
  if(!messages.length)return;
  messages.forEach(message=>{const item=document.createElement('div');item.className='chat-tip';item.style.marginBottom='8px';item.textContent=(message.role==='user'?'您：':'助手：')+message.content+(message.pending?'（处理中…）':message.failed?'（发送失败，可在输入框重试）':'');
    if(message.images?.length){const images=document.createElement('div');images.className='chat-images';message.images.forEach(meta=>{const b=document.createElement('button');b.type='button';b.title='再次用于当前对话';b.setAttribute('aria-label',`再次使用${meta.label||meta.name}`);const img=document.createElement('img');img.src=meta.url;img.alt=meta.label||meta.name;b.append(img);b.onclick=()=>addExistingImage(meta);images.append(b);});item.append(images);}log.append(item);});
  log.scrollTop=log.scrollHeight;
}
function appendConversation(id, summary) {
  const messages=[...(conversations.get(id)||[]),{role:'assistant',content:summary.slice(0,4000)}];
  while(messages.length>20||messages.reduce((sum,message)=>sum+message.content.length,0)>20000)messages.splice(0,2);
  conversations.set(id,messages);
}
let viewer;
try {viewer = new Viewer($('plot'), (selection, detail={}) => {
  if(!selection){clearSelection(false);if(!detail.empty)toast('视图尚未准备好，请稍后再试');return;}
  if(!selection.normal){clearSelection(false);toast('此位置无法确定面方向，请选择其他位置');return;}
  if(!state.project||state.dirty||(state.view==='preview'&&state.previewKey!==configKey(state.config))||(state.view==='mesh'&&state.artifact?.revision!==state.project.revision_id)){
    clearSelection(false);toast('请先保存修改并切换到当前版本的几何预览或网格');return;
  }
  state.selection={...selection,revision_id:state.project.revision_id};
  if(state.view==='mesh'&&!state.selection.artifact_id)state.selection.artifact_id=state.artifact.id;
  if(selection.source_operation_id&&state.config?.operations?.some(item=>item.id===selection.source_operation_id))selectOperation(selection.source_operation_id);
  const position=selection.point.map(value=>Number(value.toPrecision(5))).join('，');
  const coordinateUnits=selection.units==='unitless'?'':` ${selection.units||'mm'}`;
  $('selection-summary').classList.remove('hidden');$('selection').textContent=`${selection.part_name} · ${position}`;
  $('chat-region').classList.remove('hidden');$('chat-region').textContent=`已选表面位置 ${selection.part_name}：(${position})`;
  $('clear-selection').classList.remove('hidden');
  $('selection').textContent+=coordinateUnits;
  $('chat-region').textContent+=coordinateUnits;
});} catch(error) {
  initializationErrors.push('三维视图初始化失败：'+(error.message||String(error)));
  console.error('Viewer initialization failed',error);
  const unavailable=()=>Promise.reject(new Error('三维视图不可用，无法显示几何或网格。'));
  viewer={hidden:new Set(),isolated:null,surface:null,meshSurface:null,selection:null,camera:null,
    resetParts(){},clear:()=>Promise.resolve(),render:()=>Promise.resolve(),partColor:()=> '#168b80',
    setPreview:unavailable,setSurface:unavailable,showMesh:unavailable,setEdges:()=>Promise.resolve(),
    resetCamera(){},togglePart(){},isolate(){},setPickingEnabled(){},setBoxZoomEnabled(){return false;}};
}

async function request(path, options={}) {
  let response;
  try { response=await fetch(api+path,{credentials:'same-origin',...options,
    headers:{...(options.body?{'Content-Type':'application/json'}:{}),...options.headers}}); }
  catch { throw new Error('无法连接本地服务，请确认 MeshPilot 正在运行。'); }
  let data;
  try { data=await response.json(); } catch { throw new Error('服务响应异常，请重试。'); }
  if (!response.ok) {
    const message=data.error?.message||'操作未完成，请检查设置后重试。';
    const code=data.error?.code;
    const hints={REVISION_CONFLICT:'项目已在其他窗口修改，请记下当前输入后重新打开项目。',
      UNAUTHORIZED:'当前会话已失效，请刷新页面后重试。', NOT_FOUND:'项目或结果不存在，请重新打开项目。'};
    const inputHint=code==='INVALID_INPUT'&&!/[\u3400-\u9fff]/.test(message)
      ? (/GEO or mixed-kernel|does not establish OCC/i.test(message)?'当前模型不能直接执行此编辑，请保留原模型并尝试其他操作。'
        :/no retained solid sources/i.test(message)?'当前表面没有保留的实体来源，无法转换为实体网格或执行实体操作。'
        :/existing local refinements cannot be preserved/i.test(message)?'当前局部加密无法保留在所选网格类型中，请先通过对话调整或移除局部加密。'
        :/coarsening an existing discrete mesh/i.test(message)?'当前网格不能直接变粗，请重新构造网格或选择体素网格。'
        :/changing the cell type of a discrete mesh|cannot be converted to the requested shell cell type/i.test(message)?'当前网格不能直接转换为所选单元类型，请选择其他类型或重新构造网格。'
        :/workload|limit|budget/i.test(message)?'模型规模超过当前资源限制，请增大网格尺寸或简化模型。':'输入无效，请检查建模步骤和网格尺寸。') : null;
    const retry=response.status===429?response.headers.get('Retry-After'):null;
    const error=new Error((hints[code]||inputHint||message)+(retry?`（${retry} 秒后可重试）`:''));
    error.code=code;error.status=response.status;
    if((response.status===401||response.status===403)&&String(code||'').startsWith('LICENSE_')&&path!=='/license/import'){licenseState=null;showLicense(false,message);}
    throw error;
  }
  return data;
}
const post=(path,data)=>request(path,{method:'POST',body:JSON.stringify(data)});

function renderLicense(message=''){
  $('license-machine').value=licenseState?.machine_code||'';
  $('license-copy').disabled=!licenseState?.machine_code;
  $('license-details').textContent=licenseState?.valid?[licenseState.customer,licenseState.version_scope].filter(Boolean).join(' · '):'';
  $('license-status').textContent=message||licenseState?.message||'';
  $('license-close').hidden=licenseRequiredAtStart;
}
function showLicense(required=false,message=''){
  if(required)licenseRequiredAtStart=true;
  renderLicense(message);
  if(!$('license-dialog').open)$('license-dialog').showModal();
  if(!licenseState?.machine_code)request('/license').then(value=>{licenseState=value;renderLicense(message);}).catch(error=>{$('license-status').textContent=error.message;});
}
async function copyMachineCode(){
  const input=$('license-machine');
  try{if(!navigator.clipboard?.writeText)throw new Error();await navigator.clipboard.writeText(input.value);}
  catch{input.focus();input.select();if(!document.execCommand('copy')){$('license-status').textContent='请手动复制机器码';return;}}
  $('license-status').textContent='已复制机器码';
}
async function refreshBootstrap(){
  const boot=await request('/bootstrap');$('version').textContent=`v${String(boot.version||'0.2').replace(/^v/i,'')}`;
  state.provider=boot.provider||null;state.catalog=boot.capabilities?.operations||{};attachmentLimits=boot.attachment_limits||attachmentLimits;
  populateProviders(boot.providers,state.provider);licenseState=boot.license||null;return boot;
}
function bindLicense(){
  $('license-open').onclick=async()=>{try{licenseState=await request('/license');showLicense();}catch(error){fail(error);}};
  $('license-close').onclick=()=>{if(!licenseRequiredAtStart)$('license-dialog').close();};
  $('license-dialog').addEventListener('cancel',event=>{if(licenseRequiredAtStart)event.preventDefault();});
  $('license-copy').onclick=()=>copyMachineCode().catch(()=>{$('license-status').textContent='请手动复制机器码';});
  $('license-import').onclick=()=>$('license-file').click();
  $('license-file').onchange=async event=>{
    const file=event.target.files?.[0];event.target.value='';if(!file)return;
    const button=$('license-import');button.disabled=true;
    try{
      if(file.size>16384)throw new Error('许可证文件过大，请选择正确的 .lic 文件');
      const result=await post('/license/import',{license:await file.text()});
      if(!result.valid)throw new Error(result.message||'许可证无效');
      licenseState=result;const initial=licenseRequiredAtStart;await refreshBootstrap();
      if(licenseState?.required&&!licenseState.valid)throw new Error(licenseState.message||'许可证无效');
      licenseRequiredAtStart=false;$('license-dialog').close();
      if(initial&&!state.project)await showProjects();
      else toast('授权已更新');
    }catch(error){$('license-status').textContent=error.message;}
    finally{button.disabled=false;}
  };
}

function showProviderHint(id){
  const provider=state.providers.find(item=>item.id===id);
  $('provider-model-hint').textContent=provider?.model_hint||'';
  const capability=state.provider?.provider_id===id?state.provider.image_input:provider?.image_input;
  const labels={supported:'当前模型支持图片输入。',unsupported:'当前模型仅支持文字；使用草图时请选择支持图片的模型。',unknown:'此模型的图片能力尚未确认。',user_declared:'图片能力由您声明，尚未通过真实请求验证。'};
  $('provider-image-hint').textContent=labels[capability?.status]||'图片能力将在保存模型设置后检查。';
}
function setProviderBusy(busy){
  const form=$('provider-form');
  [form.elements.provider_id,form.elements.base_url,form.elements.model,form.elements.api_key,form.elements.supports_images].forEach(control=>control.disabled=busy);
}
function populateProviders(providers,status){
  state.providers=Array.isArray(providers)?providers:[];
  const select=$('provider-select');select.replaceChildren();
  state.providers.forEach(provider=>{const option=document.createElement('option');option.value=provider.id;option.textContent=provider.label;select.append(option);});
  if(!state.providers.length){const option=document.createElement('option');option.value='custom';option.textContent='自定义兼容服务';select.append(option);}
  const id=status?.configured&&state.providers.some(provider=>provider.id===status.provider_id)?status.provider_id:(state.providers.find(provider=>provider.id==='deepseek')?.id||state.providers[0]?.id||'custom');
  select.value=id;showProviderHint(id);
  const form=$('provider-form');const selected=state.providers.find(provider=>provider.id===id);
  form.api_key.required=!status?.configured;
  form.base_url.value=(status?.configured&&status.base_url)||selected?.base_url||'';
  form.model.value=(status?.configured&&status.model)||selected?.default_model||'';
  form.supports_images.value=status?.supports_images===true?'true':status?.supports_images===false?'false':'auto';
  $('provider-address').open=false;
  $('test-provider').disabled=!status?.configured;
  $('provider-status').textContent=status?.credentials_saved?'已安全保存在此设备。':status?.configured?'已保存到当前会话':'';
  $('remember-provider').checked=!status?.configured || status?.credentials_saved===true;
  if(status?.credential_error)$('provider-key-hint').textContent=credentialHint(status.credential_error);
  updateNextStep();
}
function credentialHint(message) {
  if(!message)return '';
  if(/could not be read/i.test(message))return '无法读取已保存的密钥，原有记录仍保留。';
  if(/could not be removed/i.test(message))return '无法删除已保存的密钥，请检查设备权限后重试。';
  if(/could not be saved/i.test(message))return '无法安全保存密钥，请检查设备权限后重试。';
  return '此设备暂时无法安全保存密钥，可在当前会话中使用。';
}
function toast(message) {
  $('toast').textContent=message; $('toast').classList.remove('hidden');
  clearTimeout(toast.timer); toast.timer=setTimeout(()=>$('toast').classList.add('hidden'),5000);
}
function status(label, detail='', error=false) {
  $('status').textContent=label; $('status-detail').textContent=detail;
  $('status-dot').style.background=error?'#dc866a':'#58ab91';
}
function fail(error) { status('操作失败',error.message,true); toast(error.message); }
function guard() { return !state.dirty || confirm('当前修改尚未保存。放弃修改并继续？'); }
function beginEditTransaction() {
  if(state.transaction||state.saving||state.submitting||state.conversing)return false;
  state.transaction=true;state.projectSeq++;updateButtons();return true;
}
function endEditTransaction() {state.transaction=false;updateButtons();}
function activateTab(id) {
  document.querySelectorAll('[data-tab]').forEach(b=>b.classList.toggle('active',b.dataset.tab===id));
  document.querySelectorAll('.tab-content').forEach(el=>el.classList.toggle('hidden',el.id!==id));
}
function availableExports() {
  const report=state.report;
  const eligible=report?.delivery_verified===true&&(report?.quality_advisory===true
      ||report?.quality?.status==='not_checked'||(report?.quality?.status==='passed'&&report?.quality?.complete===true));
  if(!state.artifact||state.view!=='mesh'||!eligible)return [];
  return (report.export_formats||[]).filter(format=>['k','msh','inp'].includes(format));
}
function previewPresentation(surface) {
  if(surface?.preview_basis==='existing_mesh')
    return {label:'已有网格预览',note:'当前显示已有网格的外形；没有可显示的原始几何。'};
  if(surface?.preview_basis==='mixed')
    return {label:'几何与网格预览',note:'当前同时显示几何外形和已有网格；已有网格部分没有原始几何。'};
  if(surface?.preview_basis==='cad_tessellation'||(!surface?.preview_basis&&state.config?.schema_version!==3))
    return {label:'几何预览',note:'CAD 几何外形'};
  return {label:'预览',note:'当前显示模型外形；几何来源尚未确认。'};
}
function updateButtons() {
  const running=state.job && ['queued','running','cancelling'].includes(state.job.status);
  $('save').classList.toggle('hidden',!state.dirty);$('save').disabled=!state.project||!state.dirty||state.conversing||state.transaction||!!state.saving;
  $('manual-model').disabled=!state.project||state.transaction||state.submitting||state.conversing||!!state.saving;
  $('named-set').disabled=!state.project||!state.artifact||state.artifact.revision!==state.project.revision_id||state.dirty||state.transaction||state.submitting||state.conversing||!!state.saving;
  for(const id of ['workflow-export','workflow-import'])$(id).disabled=!state.project||state.transaction||state.submitting||state.conversing||!!state.saving;
  $('mesh-settings').disabled=!state.config||state.transaction||state.submitting||state.conversing||!!state.saving;
  for(const id of ['manual-dialog','mesh-dialog','named-set-dialog','workflow-dialog'])$(id).querySelectorAll('input,select,button,textarea').forEach(el=>el.disabled=state.transaction);
  $('undo').disabled=!state.project||running||state.submitting||state.conversing;
  $('redo').disabled=!state.project||running||state.submitting||state.conversing||!state.redoStack.length;
  $('generate').disabled=!state.config||state.submitting||state.conversing||!!(running&&state.job.revision_id===state.project?.revision_id&&!state.dirty);
  $('restore-revision').disabled=!state.project||!!running||state.submitting||state.conversing;
  $('config-form').querySelectorAll('input,select,button').forEach(control=>control.disabled=state.conversing||state.transaction);
  for(const id of ['open','new','empty-new','create','history-select'])$(id).disabled=state.transaction;
  if(state.transaction||state.saving){for(const id of ['undo','redo','restore-revision','generate'])$(id).disabled=true;}
  $('empty-new').disabled=!!state.project||state.transaction;
  const formats=availableExports();
  $('export').disabled=!formats.length;
  document.querySelectorAll('[data-format]').forEach(button=>{const available=formats.includes(button.dataset.format);button.classList.toggle('hidden',!available);button.disabled=!available;});
  $('export').title=state.artifact&&state.report?.quality?.status!=='passed'&&state.report?.quality?.status!=='not_checked'&&state.report?.quality_advisory!==true?'该网格尚未通过完整自检，请查看检查报告。':'';
  const checked=!!state.check&&state.check.artifact_id===state.artifact?.id&&state.check.status==='succeeded';
  $('report').classList.toggle('hidden',!checked);$('report').disabled=!checked;
  $('check-mesh').disabled=!state.artifact||state.dirty||state.submitting||!!(state.check&&state.check.artifact_id===state.artifact.id&&['queued','running'].includes(state.check.status));
  const checking=!!state.check&&state.check.artifact_id===state.artifact?.id&&['queued','running'].includes(state.check.status);
  $('check-mesh').textContent=checking?'检查中…':checked||['failed','cancelled','interrupted'].includes(state.check?.status)?'重新检查':'检查网格';
  updateCheckCard();
  $('show-preview').disabled=!state.preview;
  $('show-preview').textContent=state.preview?previewPresentation(state.preview).label:'几何预览';
  $('show-mesh').disabled=!state.artifact||!viewer.meshSurface;
  const zoomBusy=$('plot').getAttribute('data-boxzoom-busy')==='true';
  $('box-zoom').disabled=!viewer.surface||zoomBusy;
  $('zoom-reset').disabled=!viewer.surface||zoomBusy;
  $('axis').disabled=state.view!=='mesh';
  $('fraction').disabled=state.view!=='mesh'||!$('axis').value;
  $('edges').disabled=state.view!=='mesh';
  $('cancel').classList.toggle('hidden',!running);
  $('dirty').classList.toggle('hidden',!state.dirty);
  const uploading=!!attachmentUploads.get(state.project?.id);
  $('attach-image').disabled=!state.project||state.conversing||uploading;
  $('draw-sketch').disabled=!sketch||!state.project||state.conversing||uploading;
  $('chat-form').querySelector('button').disabled=state.conversing||uploading||state.transaction;
  document.querySelectorAll('.operation-delete').forEach(button=>button.disabled=!!(running&&state.job.revision_id===state.project?.revision_id)||state.submitting||state.conversing||state.transaction||!!state.saving);
  $('generate').textContent=state.generationStage||running?'正在生成…':'生成网格';
  if(state.view==='preview'&&state.preview&&$('summary-status').textContent===previewPresentation(state.preview).label){
    const needsMesh=!state.artifact||state.dirty||state.artifact.revision!==state.project?.revision_id;
    const label=previewPresentation(state.preview).label;
    $('mesh-state').textContent=needsMesh&&!running&&!state.submitting&&!state.conversing?`${label} · 点击「生成网格」继续`:label;
  }
  updateGenerationCard();
  updateNextStep();
}
function updateCheckCard(){
  const card=$('check-card');if(!card)return;
  const isCurrent=!!state.check&&state.check.artifact_id===state.artifact?.id;
  const running=isCurrent&&['queued','running'].includes(state.check.status);
  card.classList.toggle('hidden',!running);
  if(!running){clearInterval(state.checkTimer);state.checkTimer=null;state.checkStartedAt=null;return;}
  if(!state.checkStartedAt)state.checkStartedAt=Date.now()-Math.max(0,Number(state.check.elapsed_seconds)||0)*1000;
  $('check-stage').textContent=state.check.status==='queued'?'正在排队检查':'正在检查网格';
  const elapsed=Math.max(0,Math.floor((Date.now()-state.checkStartedAt)/1000));
  $('check-elapsed').textContent=`已用时 ${Math.floor(elapsed/60)}:${String(elapsed%60).padStart(2,'0')}`;
  if(!state.checkTimer)state.checkTimer=setInterval(updateCheckCard,1000);
}
function updateGenerationCard(){
  const card=$('generation-card');if(!card)return;
  const running=state.job&&['queued','running','cancelling'].includes(state.job.status);
  const visible=!!(running||state.submitting&&state.generationStage);
  card.classList.toggle('hidden',!visible);
  if(!visible){clearInterval(state.generationTimer);state.generationTimer=null;state.generationStartedAt=null;return;}
  if(!state.generationStartedAt)state.generationStartedAt=Date.now();
  let stage=state.generationStage||'正在生成网格';
  if(running){if(state.job.status==="queued")stage="正在排队";else if(state.job.status==="cancelling")stage="正在取消旧任务";else stage=state.job.stage==="verifying"?"正在整理结果":state.job.stage==="validating"?"正在准备网格":"正在生成网格";}
  $('generation-stage').textContent=stage;
  const elapsed=Math.max(0,Math.floor((Date.now()-state.generationStartedAt)/1000));
  $('generation-elapsed').textContent=`已等待 ${Math.floor(elapsed/60)}:${String(elapsed%60).padStart(2,'0')}`;
  if(!state.generationTimer)state.generationTimer=setInterval(updateGenerationCard,1000);
}
function updateNextStep(){
  const el=$('next-step');if(!el)return;
  if(!state.project){el.textContent='下一步：打开或新建一个项目。';return;}
  const running=state.job&&['queued','running','cancelling'].includes(state.job.status);
  if(running){el.textContent='网格正在生成，也可以继续对话修改模型。';return;}
  const hasModel=!!state.config&&(state.config.schema_version===3?!!Object.keys(state.config.program?.bindings||{}).length:!!state.config.operations?.length);
  if(!state.provider?.configured&&!hasModel){el.textContent='下一步：点击“建模”手动创建，或在设置中连接模型服务。';return;}
  if(!hasModel){el.textContent='下一步：描述几何形状、尺寸和网格要求。';return;}
  if(state.artifact?.revision===state.project.revision_id&&!state.dirty){el.textContent=state.check?.artifact_id===state.artifact.id&&state.check.status==="succeeded"?"下一步：查看检查报告或描述修改。":"下一步：点击检查网格或选择模型位置描述修改。";return;}
  el.textContent=state.dirty?'下一步：生成网格会自动保存，也可继续修改。':'下一步：继续对话修改，或点击“生成网格”。';
}
function meshLabel() {
  if (state.view!=='mesh') return;
  const report=activeReport();
  const advisory=report?.quality_advisory===true&&report?.quality?.status!=='passed'&&report?.quality?.status!=='not_checked';
  const unchecked=report?.quality?.status==='not_checked';
  const baseLabel=!state.artifact?'尚无网格':state.dirty||state.artifact.revision!==state.project?.revision_id?'旧版网格':unchecked?'网格已生成 · 未检查':'当前网格';
  const label=baseLabel+(advisory?' · 需复核':'');
  $('mesh-state').textContent=label; $('summary-status').textContent=label;
  if(advisory){$('view-note').textContent=report.quality_recommendation||'网格存在质量问题，请查看检查报告。';$('view-note').classList.remove('hidden');}
  else $('view-note').classList.add('hidden');
  if(!state.selection)$('selection').textContent='未选择位置';
}
function setProject(project) {
  const sameProject=state.project?.id===project.id;
  const revisionChanged=sameProject&&state.project.revision_id!==project.revision_id;
  if(!sameProject)state.redoStack=[];
  const selectedRegion=sameProject&&state.config?.schema_version===2
    ?state.config.outputs.find(item=>item.source===state.selected)?.id:null;
  if(state.project?.id!==project.id||state.project?.revision_id!==project.revision_id)clearSelection(false);
  if (state.project?.id!==project.id) state.selected=null;
  state.project=project; state.config=structuredClone(project.config); state.dirty=false;
  if(selectedRegion&&state.config?.schema_version===2){
    state.selected=(state.config.outputs.find(item=>item.id===selectedRegion)||state.config.outputs[0])?.source||null;
  }
  $('project-name').textContent=project.name;
  const current=project.revisions?.find(item=>item.id===project.revision_id);
  $('revision').textContent=current?.label||((project.config?.operations||[]).length?'当前模型':'空模型');
  if (!state.config?.operations?.some(op=>op.id===state.selected)) state.selected=state.config?.operations?.[0]?.id||null;
  renderFields(); renderTree(); renderHistory(); updateButtons();
  if (state.config) schedulePreview(revisionChanged); else clearPreview();
  meshLabel();
}
function clearPreview() {
  clearTimeout(schedulePreview.timer); state.previewSeq++; state.preview=null; state.previewKey=null;
  state.surfaceSeq++;clearInterval(state.checkTimer);state.checkTimer=null;state.check=null;state.checkStartedAt=null;state.artifact=null; state.report=null; state.jobReport=null;
  viewer.resetParts();viewer.clear().catch(fail);
  state.view='preview'; state.viewSeq++;
  $('mesh-state').textContent='尚无模型'; $('summary-status').textContent='等待描述';
  $('summary-nodes').textContent='—'; $('summary-cells').textContent='—';
  $('view-note').classList.add('hidden'); $('viewport-empty').classList.remove('hidden');
  $('viewport-empty').querySelector('p').textContent='点击“建模”或使用对话开始';
  $('empty-new').classList.toggle('hidden',!!state.project); updateButtons();
  renderTree();
}
function changed() {
  state.dirty=true; clearSelection(false);
  schedulePreview(true); renderTree(); updateButtons();
}
function selectOperation(id) {
  if(state.transaction)return;
  state.selected=id; renderFields(); renderTree();
}
function clearSelection(redraw=true){
  state.selection=null;viewer.selection=null;
  $('selection-summary').classList.add('hidden');$('selection').textContent='未选择位置';
  $('chat-region').classList.add('hidden');$('chat-region').textContent='未选择位置';$('clear-selection').classList.add('hidden');
  if(redraw&&viewer.surface)viewer.render().catch(fail);
}
function setPicking(enabled, {preserveSelection=false}={}) {
  if(enabled)viewer.setBoxZoomEnabled(false);
  viewer.setPickingEnabled(enabled);
  $('select-part').setAttribute('aria-pressed',String(enabled));
  $('select-part').textContent=enabled?'退出选部位':'选择部位';
  if(!enabled&&!preserveSelection)clearSelection();
}
function matchSelectionToSurface(surface,kind){
  if(state.selection&&(state.selection.surface_kind!==kind||!surface?.surface_id||state.selection.surface_id!==surface.surface_id
      ||(kind==='mesh'&&state.selection.artifact_id!==surface.artifact_id)))clearSelection(false);
}
function renderHistory(){
  const select=$('history-select');select.replaceChildren();
  const revisions=state.project?.revisions||[];
  [...revisions].reverse().forEach(revision=>{const option=document.createElement('option');option.value=revision.id;option.textContent=revision.label||revision.operation_label||revision.operation||revision.command||'模型操作';if(revision.id===state.project.revision_id)option.textContent+= '（当前）';select.append(option);});
  select.value=state.project?.revision_id||'';$('restore-revision').disabled=!state.project;
}
function renderFields() {
  const fields=$('fields'); fields.replaceChildren();
  if (!state.config) { const p=document.createElement('p'); p.className='muted'; p.textContent='通过对话创建模型后，可在这里检查步骤。'; fields.append(p); return; }
  const operations=state.config.operations||[];
  const label=document.createElement('label'); label.textContent='选择步骤';
  const select=document.createElement('select');
  operations.forEach(op=>{const o=document.createElement('option');o.value=op.id;o.textContent=`${op.id} · ${op.op}`;select.append(o);});
  select.value=state.selected; select.onchange=()=>selectOperation(select.value); label.append(select); fields.append(label);
  const op=operations.find(item=>item.id===state.selected);
  if (op) {
    const info=document.createElement('p'); info.className='hint'; info.textContent=`操作：${op.op}　输入：${(op.inputs||[]).join('、')||'无'}`; fields.append(info);
    const group=document.createElement('fieldset'), legend=document.createElement('legend'); legend.textContent='步骤参数'; group.append(legend);
    const edit=(value,path,labelText)=>{
      if (typeof value==='number') {
        const item=document.createElement('label'); item.textContent=labelText;
        const input=document.createElement('input'); input.type='number'; input.step='any'; input.value=value;
        input.oninput=()=>{let node=state.config;path.slice(0,-1).forEach(key=>node=node[key]);node[path.at(-1)]=input.value===''?null:Number(input.value);changed();};
        item.append(input); group.append(item);
      } else if (Array.isArray(value)) value.forEach((v,i)=>edit(v,[...path,i],`${labelText} · ${i+1}`));
      else if (value && typeof value==='object') Object.entries(value).forEach(([k,v])=>edit(v,[...path,k],labelText?`${labelText} / ${k}`:k));
    };
    edit(op.args||{},['operations',operations.indexOf(op),'args'],'');
    if (group.children.length===1) {const p=document.createElement('p');p.className='muted';p.textContent='该步骤没有可编辑数值。';group.append(p);}
    fields.append(group);
  }
  const mesh=state.config.mesh;
  if (mesh && (typeof mesh.size==='number' || ['gmsh_subdivision','voxel'].includes(mesh.recipe?.kind))) {
    const target=['gmsh_subdivision','voxel'].includes(mesh.recipe?.kind)?mesh.recipe:mesh;
    const field=document.createElement('label');field.textContent='单元尺寸';const input=document.createElement('input');input.id='model-element-size';input.type='number';input.step='any';
    input.value=target.size;
    input.oninput=()=>{target.size=input.value===''?null:Number(input.value);changed();};field.append(input);fields.prepend(field);
  }
  if(mesh?.element_type==='hex8'){
    const info=document.createElement('p');info.className='hint';info.textContent=mesh.recipe?.kind==='voxel'?'体素 · HEX8':mesh.recipe?.kind==='gmsh_subdivision'?'六面体 · 自动细分':mesh.recipe?.kind==='sweep_blocks'?'六面体 · 分块扫掠':'六面体 · HEX8';fields.append(info);
    const integerField=(labelText,value,assign)=>{
      const label=document.createElement('label');label.textContent=labelText;
      const input=document.createElement('input');input.type='number';input.min='1';input.step='1';input.value=value;
      input.oninput=()=>{assign(input.value===''?null:Number(input.value));changed();};label.append(input);fields.append(label);
    };
    (mesh.recipe?.kind==='sweep_blocks'?mesh.recipe.sweeps||[]:[]).forEach(sweep=>{
      integerField(`${sweep.id} · 扫掠层数`,sweep.layers,value=>sweep.layers=value);
      (sweep.patches||[]).forEach(patch=>{
        const discretization=patch.discretization;
        if(discretization?.kind==='regular')discretization.divisions.forEach((value,index)=>
          integerField(`${patch.region_id} / ${patch.id} · 面内方向 ${index+1} 分段`,value,next=>discretization.divisions[index]=next));
        else if(discretization)integerField(`${patch.region_id} / ${patch.id} · ${discretization.kind==='transition31'?'3:1':'2:1'} 过渡粗边分段`,discretization.coarse_segments,value=>discretization.coarse_segments=value);
      });
    });
  }
}
function renderTree() {
  const tree=$('tree');tree.replaceChildren();tree.classList.remove('empty');
  if (!state.project) {tree.classList.add('empty');tree.textContent='暂无模型';return;}
  const head=document.createElement('div');head.className='tree-sub';head.textContent=state.config?.schema_version===3?'构形部件':'建模步骤';tree.append(head);
  if(state.config?.schema_version===3)Object.keys(state.config.program.bindings).forEach(id=>{
    const row=document.createElement('div');row.className='operation-row';
    const name=document.createElement('span');name.className='region-item';name.textContent=id;
    const remove=document.createElement('button');remove.type='button';remove.className='operation-delete';remove.textContent='删除';remove.setAttribute('aria-label',`删除部件 ${id}`);remove.title='移除此输出部件，程序调用仍保留；可撤销';
    remove.disabled=!!(state.job&&['queued','running','cancelling'].includes(state.job.status)&&state.job.revision_id===state.project?.revision_id)||state.submitting||state.conversing||state.transaction||!!state.saving;
    remove.onclick=()=>deleteOperation(id).catch(fail);row.append(name,remove);tree.append(row);
  });
  (state.config?.operations||[]).forEach(op=>{
    const row=document.createElement('div');row.className='operation-row';
    const b=document.createElement('button');b.className='region-item'+(state.selected===op.id?' selected':'');b.textContent=`${op.id} · ${op.op}`;b.onclick=()=>selectOperation(op.id);
    const remove=document.createElement('button');remove.type='button';remove.className='operation-delete';remove.textContent='删除';remove.setAttribute('aria-label',`删除步骤 ${op.id}（${op.op}）`);remove.title='删除此步骤；具体影响会在完成后说明';remove.disabled=!!(state.job&&['queued','running','cancelling'].includes(state.job.status)&&state.job.revision_id===state.project?.revision_id)||state.submitting||state.conversing||state.transaction||!!state.saving;
    remove.onclick=()=>deleteOperation(op.id).catch(fail);row.append(b,remove);tree.append(row);
  });
  const partTitle=document.createElement('div');partTitle.className='tree-sub';partTitle.textContent='模型部件';tree.append(partTitle);
  const surface=state.view==='preview'?state.preview:viewer.meshSurface;
  Object.entries(surface?.part_names||{}).forEach(([id,name])=>{
    const key=partKey(surface,id);
    const row=document.createElement('div');row.className='part-row';row.dataset.region=surface.region_table?.[id]?.id||name;
    const sw=document.createElement('span');sw.className='swatch';sw.style.background=viewer.partColor(key);
    const text=document.createElement('span');text.className='part-name';text.textContent=name;
    const show=document.createElement('button');show.textContent=viewer.hidden.has(key)?'显示':'隐藏';show.setAttribute('aria-label',`${show.textContent} ${name}`);show.onclick=()=>{clearSelection(false);viewer.togglePart(key);renderTree();};
    const isolate=document.createElement('button');isolate.textContent=viewer.isolated===key?'恢复':'隔离';isolate.setAttribute('aria-label',`${isolate.textContent} ${name}`);isolate.onclick=()=>{clearSelection(false);viewer.isolate(key);renderTree();};
    row.append(sw,text,show,isolate);tree.append(row);
  });
}
async function deleteOperation(id) {
  const isRegion=state.config?.schema_version===3&&Object.hasOwn(state.config.program.bindings,id);
  const op=state.config?.operations?.find(item=>item.id===id);if((!op&&!isRegion)||!state.project||state.conversing||state.submitting)return;
  const running=state.job&&['queued','running','cancelling'].includes(state.job.status)&&state.job.revision_id===state.project.revision_id;if(running){toast('当前版本任务运行期间无法删除步骤');return;}
  if(!beginEditTransaction())return;
  try {
  if(state.dirty)await save();
  const projectId=state.project.id,revision=state.project.revision_id;
  const result=await post(`/projects/${encodeURIComponent(projectId)}/commands`,{base_revision:revision,idempotency_key:crypto.randomUUID(),operation:'delete_operation',parameters:{operation_id:id}});
  if(state.project?.id!==projectId||state.project.revision_id!==revision)return;
  state.redoStack=[];setProject(result);const effect=result.deletion_effect||result.command?.deletion_effect;
  const label=isRegion?'部件':'步骤';toast(effect?`已删除${label} ${id}。${effect} 可使用“撤销最近操作”恢复。`:`已删除${label} ${id}。可使用“撤销最近操作”恢复。`);
  status(`${label}已删除`,'可撤销');
  } finally {endEditTransaction();}
}
function schedulePreview(force=true, config=state.config) {
  clearTimeout(schedulePreview.timer);const seq=++state.previewSeq;state.preview=null;state.previewKey=null;
  if (!config) {clearPreview();return;}
  if(force||!state.artifact){state.view='preview';state.viewSeq++;}
  if(state.view==='preview'){$('mesh-state').textContent='正在准备几何预览…';$('summary-status').textContent='预览更新中';$('summary-nodes').textContent='—';$('summary-cells').textContent='—';$('view-note').textContent='正在更新几何外形。';$('view-note').classList.remove('hidden');}
  updateButtons();renderTree();const key=configKey(config);schedulePreview.timer=setTimeout(()=>loadPreview(seq,key),500);
}
async function loadPreview(seq,key) {
  const id=state.project?.id;if(!id||seq!==state.previewSeq)return;
  try {
    const config=JSON.parse(key),request={config};
    if(config.program?.inputs&&Object.keys(config.program.inputs).length){request.project_id=id;request.base_revision=state.project.revision_id;}
    const preview=await post('/preview',request);
    if(seq!==state.previewSeq||state.project?.id!==id)return;
    state.preview=preview;state.previewKey=key;
    if(state.view==='preview')await showPreview();updateButtons();
  } catch(error) {
    if(seq!==state.previewSeq||state.project?.id!==id)return;
    state.preview=null;state.previewKey=null;
    if(state.view==='preview'){$('mesh-state').textContent='几何预览不可用';$('summary-status').textContent='预览不可用';$('view-note').textContent='预览失败，请检查建模步骤或调整描述。';$('view-note').classList.remove('hidden');}
    updateButtons();fail(error);
  }
}
async function showPreview() {
  if(!state.preview)return;state.view='preview';const seq=++state.viewSeq,previewSeq=state.previewSeq;matchSelectionToSurface(state.preview,'geometry_preview');updateButtons();renderTree();
  showResourceNotice(generationMemoryEstimate(state.config,state.preview));
  await viewer.setPreview(state.preview);if(seq!==state.viewSeq||previewSeq!==state.previewSeq)return;
  const presentation=previewPresentation(state.preview);
  $('viewport-empty').classList.add('hidden');$('mesh-state').textContent=presentation.label;$('summary-status').textContent=presentation.label;
  $('summary-nodes').textContent='—';$('summary-cells').textContent='—';if(!state.selection)$('selection').textContent='未选择位置';
  $('view-note').textContent=presentation.note;$('view-note').classList.remove('hidden');updateButtons();
}
async function showMesh() {
  if(!state.artifact||!viewer.meshSurface)return;state.view='mesh';const seq=++state.viewSeq;matchSelectionToSurface(viewer.meshSurface,'mesh');updateButtons();renderTree();
  await viewer.showMesh();if(seq!==state.viewSeq)return;$('view-note').classList.add('hidden');
  const m=state.report?.manifest||{};$('summary-nodes').textContent=m.nodes??'—';$('summary-cells').textContent=m.elements??'—';meshLabel();updateButtons();
}
async function save(config=state.config) {
  if(!state.project||!config)return;
  state.saving++;updateButtons();
  try {
  const id=state.project.id, revision=state.project.revision_id, snapshot=structuredClone(config), editing=configKey(state.config);
  const project=await post(`/projects/${encodeURIComponent(id)}/commands`,{base_revision:revision,idempotency_key:crypto.randomUUID(),operation:'set_config',parameters:snapshot});
  if(state.project?.id!==id||state.project.revision_id!==revision)return;
  const later=configKey(state.config)!==editing?structuredClone(state.config):null;state.redoStack=[];setProject(project);
  if(later){state.config=later;state.dirty=true;renderFields();schedulePreview(true);}updateButtons();
  status('已保存',later?'后续修改尚未保存':'当前模型已更新');
  } finally {state.saving--;updateButtons();}
}
async function loadSurface() {
  if(!state.artifact)return;const id=state.artifact.id,seq=++state.surfaceSeq,project=state.project.id,viewSeq=state.viewSeq;
  const query=new URLSearchParams();if($('axis').value){query.set('axis',$('axis').value);query.set('fraction',$('fraction').value);}
  const surface=await request(`/artifacts/${encodeURIComponent(id)}/surface${query.size?'?'+query:''}`);
  if(seq!==state.surfaceSeq||state.project?.id!==project||state.artifact?.id!==id)return;
  viewer.meshSurface=surface;if(state.view!=='mesh'||state.viewSeq!==viewSeq){updateButtons();renderTree();return;}
  matchSelectionToSurface(surface,'mesh');
  showResourceNotice(displayMemoryEstimate(surface));
  await viewer.setSurface(surface);if(state.view!=='mesh'||state.viewSeq!==viewSeq)return;
  $('viewport-empty').classList.add('hidden');renderTree();updateButtons();meshLabel();
}
async function loadArtifact() {
  const id=state.artifact.id,project=state.project.id;await loadSurface();
  try {const [report,latest]=await Promise.all([request(`/artifacts/${encodeURIComponent(id)}/report`),request(`/artifacts/${encodeURIComponent(id)}/checks`)]);if(state.artifact?.id!==id||state.project?.id!==project)return;state.check=latest.check||null;state.checkStartedAt=state.check&&["queued","running"].includes(state.check.status)?Date.now()-Math.max(0,Number(state.check.elapsed_seconds)||0)*1000:null;if(state.check&&["queued","running"].includes(state.check.status))pollCheck(state.check,id).catch(error=>{if(state.artifact?.id===id){state.check.status="failed";updateButtons();fail(error);}});
    state.report=report;if(state.view==='mesh'){const m=report.manifest||{},a=report.audit||{};$('summary-nodes').textContent=m.nodes??a.nodes??'—';$('summary-cells').textContent=m.elements??a.elements??'—';meshLabel();}updateButtons();
  } catch(e){toast('报告读取失败：'+e.message);}
}
async function checkMesh(){
  const artifactId=state.artifact?.id;if(!artifactId||state.dirty||state.submitting)return;
  if(state.check?.artifact_id===artifactId&&['queued','running'].includes(state.check.status))return;
  state.check={id:null,artifact_id:artifactId,revision_id:state.artifact.revision,status:'queued',elapsed_seconds:0};state.checkStartedAt=Date.now();updateButtons();
  try{const response=await post(`/artifacts/${encodeURIComponent(artifactId)}/checks`,{});if(state.artifact?.id!==artifactId)return;state.check=response.check;state.checkStartedAt=Date.now()-Math.max(0,Number(response.check.elapsed_seconds)||0)*1000;updateButtons();pollCheck(response.check,artifactId).catch(error=>{if(state.artifact?.id===artifactId&&state.check?.id===response.check.id){state.check.status="failed";updateButtons();}fail(error);});}
  catch(error){if(state.artifact?.id===artifactId){state.check=null;updateButtons();}fail(error);}
}
async function pollCheck(check,artifactId){
  while(state.artifact?.id===artifactId&&state.check?.id===check.id){state.check=check;updateButtons();
    if(!['queued','running'].includes(check.status)){
      if(check.status==='succeeded'){
        const report=await request(`/artifacts/${encodeURIComponent(artifactId)}/report`);
        if(state.artifact?.id!==artifactId||state.check?.id!==check.id)return;
        state.report=report;meshLabel();updateButtons();showQualityReport();status('检查完成','可查看检查报告');
      }else if(check.status==='failed'){status('检查失败',check.error?.message||'可重新检查',true);toast(check.error?.message||'检查失败，可重新检查');}
      state.check=check;updateButtons();return;
    }
    await new Promise(resolve=>setTimeout(resolve,1000));const result=await request(`/checks/${encodeURIComponent(check.id)}`);if(state.artifact?.id!==artifactId||state.check?.id!==check.id)return;check=result.check;
  }
}
function activeReport(){
  return state.view==='mesh'?state.report:null;
}
async function loadJobReport(job,id){
  const report=await request(`/jobs/${encodeURIComponent(job.id)}/report`);
  if(state.project?.id!==id||state.project.revision_id!==job.revision_id)return;
  state.jobReport=report;updateButtons();
}
function showQualityReport(){
  const report=activeReport();if(!report)return;
  const m=report.manifest||{},a=report.audit||{},q=report.quality||a.quality,measure={...(a.measures||{})};
  if(!measure.mean_ratio&&Number.isFinite(q?.checks?.shape?.observed?.minimum_mean_ratio)){const shape=q.checks.shape.observed;measure.mean_ratio={min:shape.minimum_mean_ratio,p01:shape.p01};}
  if(!measure.edge_size&&q?.statistics?.edge_size)measure.edge_size=q.statistics.edge_size;
  if(!measure.adjacent_size_ratio&&q?.checks?.gradation?.observed){const ratio=q.checks.gradation.observed;measure.adjacent_size_ratio={status:'evaluated',p99:ratio.p99,max:ratio.maximum_adjacent_size_ratio,evaluated_pairs:ratio.evaluated_pairs};}
  const number=value=>Number.isFinite(value)?Number(value.toPrecision(5)).toString():'未提供';
  const units=q?.units||m.provenance?.units||state.config?.units||'mm', unitLabel=units==='unitless'?'':units;
  const unitSuffix=unitLabel?` ${unitLabel}`:'', volumeSuffix=units==='unitless'?'':' mm³';
  const volumeKey=units==='unitless'?'minimum_volume':'minimum_volume_mm3';
  const centerKey=units==='unitless'?'center':'center_mm';
  const gapKey=units==='unitless'?'gap_distance':'distance_mm';
  const gapToleranceKey=units==='unitless'?'gap_tolerance':'gap_tolerance_mm';
  const cellTypes=[...new Set((m.cell_blocks||[]).map(block=>block.cell_type).filter(Boolean))];
  const cellType=q?.cell_type||q?.policy?.cell_type||(cellTypes.length===1?cellTypes[0]:null)||(String(a.scope||q?.scope||'').includes('tet4')?'tet4':'未提供');
  const hex=cellType==='hex8';
  const shell=cellType==='tri3'||cellType==='quad4';
  const lines=['模型检查结果'];
  if(units==='unitless')lines.push('坐标按原始数值解释，未假定物理单位。');
  if(q){
    const labels={passed:'当前检查范围内达标',failed:'未达到网格质量要求',incomplete:'必需检查尚未完成'};
    lines.push(`自检结果：${labels[q.status]||'尚无有效检查结果'}`,`必需检查：${q.complete?'已全部完成':'未全部完成'}`);
    if(q.status!=='passed'&&report.quality_advisory!==true)lines.push('本次候选网格未获交付资格；画面中已有网格不代表本次失败候选。');
    if(q.status!=='passed'&&report.quality_advisory===true&&report.quality_recommendation)lines.push(`建议：${report.quality_recommendation}`);
    if(q.policy){
      if(shell)lines.push(cellType==='tri3'?`三角形质量最低要求：${number(q.policy.min_triangle_quality)}；相邻尺寸比上限：${number(q.policy.max_adjacent_size_ratio)}`:`四边形翘曲角上限：${number(q.policy.max_quad_warpage_degrees)}°；相邻尺寸比上限：${number(q.policy.max_adjacent_size_ratio)}`);
      else lines.push(`${hex?'缩放雅可比':'形状质量'}最低要求：${number(hex?q.policy.min_scaled_jacobian:q.policy.min_mean_ratio)}；相邻尺寸比上限：${number(q.policy.max_adjacent_size_ratio)}`);
      if(hex)lines.push(`面翘曲角上限：${number(q.policy.max_face_warpage_degrees)}°`);
    }
    if(q.reason)lines.push(`说明：${q.reason}`);
  }else lines.push('旧报告仅含基础统计，尚未完成当前完整自检门槛。');
  lines.push('',`节点：${m.nodes??q?.budget?.observed?.nodes??a.nodes??'未提供'}`,`单元：${m.elements??q?.budget?.observed?.cells??a.elements??'未提供'}`,`单元类型：${cellType}`);
  if(hex){
    lines.push(`全单元域雅可比行列式下界：${number(q?.checks?.positive_jacobian?.observed?.minimum_certified_lower_bound)}`,
      `全单元域缩放雅可比下界：${number(q?.checks?.shape?.observed?.minimum_certified_lower_bound)}`,
      `最大面翘曲角：${number(q?.checks?.face_warpage?.observed?.maximum_degrees)}°`);
  }else if(!shell)lines.push(`最小有向体积：${number(a.minimum_volume??q?.checks?.positive_volume?.observed?.[volumeKey])}${volumeSuffix}`);
  if(measure.mean_ratio)lines.push('',`形状质量（正四面体为 1，趋近 0 表示退化）`,`最小值：${number(measure.mean_ratio.min)}；1% 分位：${number(measure.mean_ratio.p01)}`);
  if(measure.edge_size)lines.push(`单元平均边长：${number(measure.edge_size.min)} ～ ${number(measure.edge_size.max)}${unitSuffix}；中位数 ${number(measure.edge_size.median)}${unitSuffix}`);
  if(measure.adjacent_size_ratio){const ratio=measure.adjacent_size_ratio;lines.push(ratio.status==='evaluated'?`相邻单元尺寸比：${Number.isFinite(ratio.p99)?`99% 分位 ${number(ratio.p99)}，`:''}最大 ${number(ratio.max)}（共 ${ratio.evaluated_pairs} 对）`:'描述性尺寸统计未完成，最终以必需检查结果为准。');}
  if(hex&&q?.sweep_contract){
    lines.push(`扫掠分块：${q.sweep_contract.patches}；配方要求单元：${q.sweep_contract.expected_elements}`);
    const interfaces=q.checks?.sweep_recipe_mesh?.observed;
    if(Number.isFinite(interfaces?.maximum_interface_normal_spacing_ratio))lines.push(`跨界面最大平均边长比：${number(interfaces.maximum_interface_mean_edge_ratio)}；法向厚度比：${number(interfaces.maximum_interface_normal_spacing_ratio)}`);
  }
  const checkNames={finite_geometry:'有限坐标与几何',positive_volume:'正向体积',positive_jacobian:'全单元域正雅可比',nondegenerate:'退化单元',unique_cells:'重复单元',used_nodes:'未引用节点',face_manifold:'面连接',face_orientation:'共享面朝向',boundary_edge_manifold:'边界边连接',geometry_components:'预期几何连通体',global_geometry_components:'整体连通体',shape:'形状质量',face_warpage:'面翘曲',gradation:'尺寸过渡',interfaces:'部件界面',contract_regions:'区域身份',contract_components:'区域连通体',contract_interfaces:'接口约束',contract_layers:'扫掠层数',contract_volumes:'几何体积',contract_bounds:'几何范围',sweep_recipe_mesh:'扫掠配方与实际网格',sweep_layers:'扫掠方向与层数',sweep_cad_coverage:'原始 CAD 完整覆盖'};
  if(q?.checks){lines.push('','逐项检查：');Object.entries(q.checks).forEach(([name,item])=>{const label={passed:'通过',failed:'不通过',not_checked:'未检查',incomplete:'未完成'}[item.status]||'未完成';lines.push(`${checkNames[name]||name}：${label}${Number.isInteger(item.failed_count)?`，异常 ${item.failed_count}`:''}`);});}
  if(q?.interfaces){
    const labels={shared:'共享节点',split:'分离节点',gap:'保留间隙'},statuses={passed:'通过',failed:'不通过',incomplete:'未完成'};
    lines.push('','部件界面：');
    const interfaceChecks={region_identity:'部件身份',declared_contacts:'接触定义与面归属',cad_volume_conservation:'CAD 分割体积守恒'};
    for(const [key,item] of Object.entries(q.interfaces.checks||{}))lines.push(`${interfaceChecks[key]||key}：${statuses[item.status]||'未完成'}${Number.isInteger(item.failed_count)?`，异常 ${item.failed_count}`:''}`);
    if(q.interfaces.reason)lines.push(`未完成原因：${q.interfaces.reason}`);
    const failureLabels={native_cad_evidence:'缺少有效 CAD 界面证据',gap_distance:'最小间隙不符合要求',gap_nodes_shared:'间隙两侧存在共用节点',gap_has_contact_facets:'间隙被错误连接为接触面',cad_contact_area:'CAD 接触面积证据无效',paired_area:'两侧网格面面积不匹配',invalid_ownership:'界面面归属错误',invalid_orientation:'两侧面朝向错误',invalid_node_relation:'节点共享或分离关系错误',invalid_node_sets:'界面节点集合不匹配',failed_gradation_pairs:'跨界面尺寸过渡不达标'};
    for(const [id,item] of Object.entries(q.interfaces.per_interface||{})){
      lines.push(`${(item.regions||[]).join(' ↔ ')} · ${labels[item.mode]||item.mode}：${statuses[item.status]||'未完成'}`);
      const observed=item.observed||{},threshold=item.threshold||{};
      if(item.mode==='gap'){
        if(Number.isFinite(observed[gapKey]))lines.push(`CAD 实测最小间隙 ${number(observed[gapKey])}${unitSuffix}；要求 ${number(threshold[gapKey])}${unitSuffix}，容差 ${number(threshold[gapToleranceKey])}${unitSuffix}`);
      }else{
        if(Number.isInteger(observed.paired_facets))lines.push(`匹配面 ${observed.paired_facets} 对；未匹配 ${observed.unmatched_facets??'未提供'}；节点关系异常 ${observed.invalid_node_relation??'未提供'}`);
        if(Number.isFinite(observed.maximum_adjacent_size_ratio))lines.push(`界面相邻尺寸比最大 ${number(observed.maximum_adjacent_size_ratio)}；上限 ${number(threshold.max_adjacent_size_ratio)}`);
      }
      if(item.status!=='passed')lines.push(`界面 ${id} 尚未通过完整检查。`,...(item.failures||[]).map(value=>`原因：${failureLabels[value]||value}`));
    }
    if(!Object.keys(q.interfaces.per_interface||{}).length)lines.push(`区域身份与未声明接触检查：${statuses[q.interfaces.status]||'未完成'}`);
  }
  if(q?.optimization?.attempted)lines.push('',`已进行一次内置优化并重新检查；原约束${q.optimization.constraints_preserved?'保持不变':'未能确认，禁止交付'}。`);
  if(q?.budget?.exceeded?.length)lines.push('',`超过检查预算：${q.budget.exceeded.join('、')}`);
  if(q?.locations?.length){lines.push('','候选网格问题位置（单元/节点索引从 0 开始）：');q.locations.slice(0,32).forEach(point=>lines.push(`${checkNames[point.check]||point.check}；${point.cell_ids?.length?'单元 '+point.cell_ids.join(', '):'节点 '+(point.node_ids||[]).join(', ')}；坐标 (${(point[centerKey]||[]).map(number).join(', ')})${unitSuffix}${Number.isFinite(point.observed)?'；实测 '+number(point.observed):''}`));lines.push(`候选网格指纹：${q.mesh_fingerprint||'未提供'}；这些索引不用于定位旧版本网格。`);}
  if(q?.not_covered?.length){const uncovered={'CAD volume coverage and pointwise containment':'CAD 体积覆盖与逐点包含','CAD coverage and containment':'CAD 覆盖与包含','intersections between nonadjacent cells':'非相邻单元相交','nonadjacent-cell intersections and global injectivity':'非相邻单元相交与整体重叠','arbitrary curved or imported mesh coverage and global injectivity':'任意曲面或外部网格的完整覆盖与整体重叠','vertex-link manifoldness':'顶点邻域完整流形','assembly interface contracts':'装配接口约束','requested layer counts and 3:1 topology':'指定层数与 3:1 拓扑','solver-specific accuracy or convergence':'具体求解器的精度与收敛性','solver-specific accuracy, aspect-ratio suitability or convergence':'具体求解器的精度、长宽比适用性与收敛性'};lines.push('','本次未覆盖：'+q.not_covered.map(item=>uncovered[item]||item).join('；')+'。');}
  if(report.readback){
    const formats=report.export_formats?.length?report.export_formats:(hex?['k','msh','inp']:['msh','inp']);
    lines.push('','导出独立回读：'+formats.map(format=>`${format.toUpperCase()} ${report.readback[format]?.passed===true?'通过':'未确认'}`).join(' / '));
  }
  const content=$('report-content');content.replaceChildren();content.dataset.status=q?.status||'incomplete';
  lines.join('\n').split('\n\n').forEach((text,index)=>{const section=document.createElement('section');section.className=index?'report-section':'report-overview';section.textContent=text;content.append(section,document.createTextNode('\n\n'));});
  $('report-dialog').showModal();
}
async function poll(job,id) {
  if(!state.generationStartedAt)state.generationStartedAt=Date.now();
  while(state.project?.id===id&&state.job?.id===job.id){state.job=job;updateButtons();
    const labels={queued:'等待生成',running:'正在生成',cancelling:'正在取消',cancelled:'任务已取消',failed:'生成失败',interrupted:'任务中断',succeeded:'生成完成'};
    status(labels[job.status]||job.status,job.message||'');
    if(!['queued','running','cancelling'].includes(job.status)){
      if(job.status==='succeeded'&&job.artifact_id&&job.revision_id!==state.project.revision_id){
        state.generationStage=null;status('旧版本网格已生成','可从历史记录恢复查看');updateButtons();return;
      }
      if(job.status==='succeeded'&&job.artifact_id){clearInterval(state.checkTimer);state.checkTimer=null;state.check=null;state.checkStartedAt=null;state.artifact={id:job.artifact_id,revision:job.revision_id};state.report=null;state.jobReport=null;viewer.meshSurface=null;
        if(!state.dirty&&state.config&&job.revision_id===state.project?.revision_id){state.view='mesh';state.viewSeq++;}await loadArtifact();status('生成完成',job.revision_id===state.project?.revision_id?'当前版本':'结果属于旧版本');}
      else if(job.status==='failed'){
        const message={MESH_QUALITY_FAILED:'网格未达到当前质量要求，请查看质量报告。',MESH_QUALITY_INCOMPLETE:'网格自检未完成，本次结果无法交付。'}[job.error?.code];
        fail(new Error(message||job.error?.message||'生成失败'));
      }state.generationStage=null;updateButtons();return;
    }
    await new Promise(resolve=>setTimeout(resolve,1000));const next=await request(`/jobs/${encodeURIComponent(job.id)}`);if(state.job?.id!==job.id)return;job=next;
  }
}
async function generate() {
  if(!state.project||state.submitting||state.transaction||!state.config)return;
  if(state.job&&['queued','running','cancelling'].includes(state.job.status)&&state.job.revision_id===state.project.revision_id&&!state.dirty){toast('当前版本已有网格任务运行');return;}
  const snapshot=configKey(state.config);
  const id=state.project.id,revision=state.project.revision_id;state.generationStartedAt=Date.now();state.generationStage='正在准备几何预览';state.submitting=true;updateButtons();
  try {
    if(state.view!=='preview'||state.previewKey!==snapshot){state.generationStage='正在准备几何预览';updateGenerationCard();schedulePreview(true);const seq=state.previewSeq;clearTimeout(schedulePreview.timer);await loadPreview(seq,snapshot);if(state.project?.id!==id||state.previewKey!==snapshot||configKey(state.config)!==snapshot)return;}
    if(state.dirty){state.generationStage='正在保存模型';updateGenerationCard();await save(JSON.parse(snapshot));if(state.project?.id!==id||state.project.revision_id===revision||state.dirty||configKey(state.config)!==snapshot){toast('模型已变化，请重新检查预览');return;}}
    else if(state.project?.id!==id||state.project.revision_id!==revision)return;
    showResourceNotice(generationMemoryEstimate(state.config,state.preview));
    const previous=state.job;if(previous&&['queued','running','cancelling'].includes(previous.status)){state.generationStage='正在停止旧任务';updateGenerationCard();await post(`/jobs/${encodeURIComponent(previous.id)}/cancel`,{});if(state.project?.id!==id)return;state.job=null;}
    state.generationStage='正在提交网格任务';updateGenerationCard();const job=await post(`/projects/${encodeURIComponent(id)}/jobs`,{base_revision:state.project.revision_id});if(state.project?.id!==id)return;state.jobReport=null;state.job=job;state.submitting=false;updateButtons();poll(job,id).catch(error=>{if(state.project?.id!==id||state.job?.id!==job.id)return;state.generationStage=null;state.job=null;updateButtons();fail(error);});
  } finally {state.submitting=false;if(!state.job||!['queued','running','cancelling'].includes(state.job.status))state.generationStage=null;updateButtons();}
}
async function chooseProject(id, skipGuard=false, transaction=false) {
  if(state.transaction&&!transaction)return;
  if(!skipGuard&&!guard())return;const seq=++state.projectSeq;const project=await request(`/projects/${encodeURIComponent(id)}`);if(seq!==state.projectSeq)return;
  if(state.project)drafts.set(state.project.id,$('prompt').value);
  showResourceNotice(null);
  state.surfaceSeq++;state.previewSeq++;state.viewSeq++;clearInterval(state.checkTimer);state.checkTimer=null;state.check=null;state.checkStartedAt=null;state.artifact=null;state.report=null;state.job=null;state.jobReport=null;state.preview=null;state.previewKey=null;state.view='preview';state.generationStage=null;state.generationStartedAt=null;
  setPicking(false);viewer.camera=null;viewer.resetParts();viewer.clear().catch(fail);
  setProject(project);$('prompt').value=drafts.get(id)||'';renderConversation();renderAttachments();$('project-dialog').close();status('项目已打开',project.name);
  if(project.artifact_id){const job=(project.jobs||[]).find(j=>j.artifact_id===project.artifact_id);state.artifact={id:project.artifact_id,revision:job?.revision_id};state.view='mesh';state.viewSeq++;await loadArtifact();}
  if(seq!==state.projectSeq)return;const active=(project.jobs||[]).find(j=>['queued','running','cancelling'].includes(j.status));
  if(active){state.job=active;poll(active,id).catch(fail);}else if(project.jobs?.[0]?.status==='interrupted')status('上次任务中断','请重新生成网格',true);updateButtons();
}
async function showProjects() {
  if(state.transaction)return;
  const data=await request('/projects'),list=$('projects');list.replaceChildren();
  if(!data.projects?.length){const p=document.createElement('p');p.textContent='还没有项目';list.append(p);}
  (data.projects||[]).forEach(project=>{const button=document.createElement('button');button.textContent=project.name;button.onclick=()=>chooseProject(project.id).catch(fail);list.append(button);});
  $('project-dialog').showModal();
}
const manualNames={split_solid:'平面分割体',circle:'圆面',profile_surface:'线弧轮廓',split_surface:'分割面',rectangle:'矩形面',plane_surface:'多边形面',box:'方块',sphere:'球',cylinder:'圆柱',extrude_polygon:'直线拉伸多边形',translate:'平移',rotate:'旋转',scale:'缩放',union:'布尔并集',subtract:'布尔差集',intersect:'布尔交集'};
const manualToolLabels={...manualNames,extrude_polygon:'拉伸',union:'并集',subtract:'差集',intersect:'交集'};
const manualIcons={
  split_solid:'<path d="M4 7 12 3l8 4v10l-8 4-8-4ZM12 3v18M2 12h20"/>',
  circle:'<circle cx="12" cy="12" r="9"/>',
  profile_surface:'<path d="M3 19V9a8 8 0 0 1 16 0v10Z"/>',
  split_surface:'<rect x="3" y="4" width="18" height="16"/><path d="M12 2v20" stroke-dasharray="2 2"/>',
  rectangle:'<rect x="3" y="5" width="18" height="14"/>',
  plane_surface:'<path d="M3 16 6 5l10-2 5 9-5 9H7Z"/>',
  box:'<path d="m12 3 8 4.5v9L12 21l-8-4.5v-9L12 3Zm0 9 8-4.5M12 12 4 7.5M12 12v9"/>',
  sphere:'<circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="4" ry="9"/><path d="M3 12c4-4 14-4 18 0M3 12c4 4 14 4 18 0"/>',
  cylinder:'<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 4 16 4 16 0V5M4 15c0 4 16 4 16 0"/>',
  extrude_polygon:'<path d="m4 12 7-3 9 4-7 4-9-5v6l9 5 7-4v-6M13 17v6M12 7V1m-3 3 3-3 3 3"/>',
  translate:'<path d="M12 2v20M2 12h20M8 6l4-4 4 4M8 18l4 4 4-4M6 8l-4 4 4 4M18 8l4 4-4 4"/>',
  rotate:'<path d="M20 8a9 9 0 1 0 1 8M20 3v5h-5"/><path d="m9 10 4-2 3 4-4 3-3-5Z"/>',
  scale:'<rect x="3" y="13" width="8" height="8" rx="1"/><path d="M3 9V3h6M15 3h6v6M21 15v6h-6M10 14 21 3M15 3h6v6"/>',
  union:'<path d="M3 3h11v7h7v11H10v-7H3Z"/><path d="M10 10h4v4h-4Z" fill="currentColor" stroke="none"/>',
  subtract:'<path d="M3 3h12v6H9v6H3Z"/><path d="M9 9h12v12H9Z" stroke-dasharray="2 3"/>',
  intersect:'<path d="M3 3h12v12H3ZM9 9h12v12H9Z" opacity=".45"/><path d="M9 9h6v6H9Z" fill="currentColor"/>'
};
function renderManualTools() {
  const container=$('manual-tools');container.replaceChildren();
  Object.entries(manualNames).forEach(([op,label])=>{
    if(!state.catalog[op==='rectangle'||op==='split_surface'?'plane_surface':op==='split_solid'?'box':op==='circle'?'profile_surface':op])return;
    const button=document.createElement('button');button.type='button';button.className='manual-tool';button.dataset.manualOp=op;
    button.title=label;button.setAttribute('aria-label',label);
    button.innerHTML=`<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${manualIcons[op]}</svg><span>${manualToolLabels[op]}</span>`;
    button.onclick=()=>{if(state.transaction)return;$('manual-operation').value=op;renderManualFields();};container.append(button);
  });
}
const manualLabels={point:'平面上的点',normal:'平面法向',loops:'轮廓与孔（线段 / 圆弧）',start:'分割线起点',end:'分割线终点',width:'宽度',height:'高度',origin:'起点 / 原点',size:'长、宽、高',center:'中心',radius:'半径',axis:'轴向',vector:'位移向量',points:'多边形顶点',angle_degrees:'角度（度）',factors:'缩放倍数'};
const manualDefaults={point:[5,0,0],normal:[1,0,0],loops:[[{kind:'arc',start:[5,0,0],end:[0,5,0],center:[0,0,0]},{kind:'arc',start:[0,5,0],end:[-5,0,0],center:[0,0,0]},{kind:'arc',start:[-5,0,0],end:[0,-5,0],center:[0,0,0]},{kind:'arc',start:[0,-5,0],end:[5,0,0],center:[0,0,0]}]],start:[5,-1,0],end:[5,11,0],width:10,height:10,origin:[0,0,0],size:[10,10,10],center:[0,0,0],radius:5,axis:[0,0,10],vector:[0,0,10],points:[[0,0,0],[10,0,0],[10,10,0],[0,10,0]],angle_degrees:90,factors:[1,1,1]};
function renderManualFields() {
  const op=$('manual-operation').value,spec=op==='split_solid'?{inputs:1,args:{point:'vector3',normal:'nonzero_vector3'}}:op==='circle'?{inputs:0,args:{center:'vector3',radius:'positive'}}:op==='rectangle'?{inputs:0,args:{origin:'vector3',width:'positive',height:'positive'}}:op==='split_surface'?{inputs:1,args:{start:'vector3',end:'vector3'}}:state.catalog[op],inputs=$('manual-inputs'),args=$('manual-args');
  $('manual-tools').querySelectorAll('button').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.manualOp===op)));
  inputs.replaceChildren();args.replaceChildren();if(!spec)return;
  const outputs=state.config?.schema_version===3?Object.keys(state.config.program?.bindings||{}).map(id=>({id,source:id})):(state.config?.outputs||[]).map(item=>typeof item==='string'?{id:item,source:item}:item);
  for(let i=0;i<spec.inputs;i++){
    const label=document.createElement('label');label.textContent=spec.inputs===2?(i?'第二部件（差集的工具）':'第一部件（差集的主体）'):'部件';
    const select=document.createElement('select');select.name='input'+i;select.required=true;
    outputs.forEach(item=>{const option=document.createElement('option');option.value=item.id;option.textContent=item.id;select.append(option);});
    if(i&&outputs.length>1)select.selectedIndex=1;label.append(select);inputs.append(label);
  }
  for(const [key,type] of Object.entries(spec.args||{})){
    const label=document.createElement('label');label.textContent=manualLabels[key]||key;
    const input=document.createElement(['polygon3','profile_loops'].includes(type)?'textarea':'input');input.name=key;input.required=true;
    input.value=typeof manualDefaults[key]==='number'?String(manualDefaults[key]):JSON.stringify(manualDefaults[key]);
    if(['polygon3','profile_loops'].includes(type))input.rows=5;
    else if(typeof manualDefaults[key]==='number'){input.type='number';input.step='any';}
    label.append(input);args.append(label);
  }
  if(op==='plane_surface'||op==='split_surface')renderProfileCanvas(op,args);
  if(op==='profile_surface')renderCurveEditor(args);
  $('manual-help').textContent=op==='split_solid'?'选择实体；输入平面上一点及法向，得到平面两侧的两个部件。':op==='profile_surface'?'每个闭合轮廓由顺序相连的 line 或 arc 构成；第一组为外轮廓，后续组为孔。圆弧使用圆心和端点，单段小于 180°。':op==='split_surface'?'选择 XY 平面区域；输入两点定义贯穿整个面的直线，可切分圆弧和孔洞。分割后得到两个部件。':op==='extrude_polygon'?'按轮廓顺序输入世界坐标点数组，如 [[0,0,0],[10,0,0],[10,10,0],[0,10,0]]；沿位移向量直线拉伸。':(spec.inputs?'变换或布尔运算作用于所选部件。向量使用 [x,y,z]。':'向量使用 [x,y,z]；坐标按项目原始单位解释。');
}

function renderProfileCanvas(op,container){
  const wrapper=document.createElement('div');wrapper.className='profile-editor';
  const controls=document.createElement('div');controls.className='profile-controls';
  const label=document.createElement('label');label.textContent='画布范围（半宽）';
  const extent=document.createElement('input');extent.type='number';extent.min='0.001';extent.step='any';extent.value='20';label.append(extent);
  const clear=document.createElement('button');clear.type='button';clear.textContent='清除画布点';controls.append(label,clear);
  const canvas=document.createElement('canvas');canvas.width=500;canvas.height=500;canvas.setAttribute('aria-label','XY 坐标画布：点击添加顶点');
  const hint=document.createElement('p');hint.className='hint';hint.textContent=op==='plane_surface'?'依次点击轮廓顶点，末点自动与首点连接；坐标也可在下方直接编辑。':'依次点击直线上两点；坐标也可在下方直接编辑。';
  wrapper.append(controls,canvas,hint);container.prepend(wrapper);
  const field=name=>container.querySelector(`[name="${name}"]`);
  function points(){try{return op==='plane_surface'?JSON.parse(field('points').value):[JSON.parse(field('start').value),JSON.parse(field('end').value)];}catch{return [];}}
  function draw(){const ctx=canvas.getContext('2d'),e=Number(extent.value);if(!Number.isFinite(e)||e<=0)return;ctx.clearRect(0,0,500,500);ctx.fillStyle='#fff';ctx.fillRect(0,0,500,500);ctx.strokeStyle='#dce6e7';ctx.lineWidth=1;for(let i=0;i<=10;i++){ctx.beginPath();ctx.moveTo(i*50,0);ctx.lineTo(i*50,500);ctx.moveTo(0,i*50);ctx.lineTo(500,i*50);ctx.stroke();}ctx.strokeStyle='#90a6a8';ctx.beginPath();ctx.moveTo(250,0);ctx.lineTo(250,500);ctx.moveTo(0,250);ctx.lineTo(500,250);ctx.stroke();const ps=points().filter(p=>Array.isArray(p)&&p.length>=2&&p.every(Number.isFinite));ctx.strokeStyle='#08796f';ctx.fillStyle='#08796f';ctx.lineWidth=2;ctx.beginPath();ps.forEach((p,i)=>{const x=250+p[0]*250/e,y=250-p[1]*250/e;if(i)ctx.lineTo(x,y);else ctx.moveTo(x,y);});if(op==='plane_surface'&&ps.length>2)ctx.closePath();ctx.stroke();ps.forEach(p=>{ctx.beginPath();ctx.arc(250+p[0]*250/e,250-p[1]*250/e,4,0,2*Math.PI);ctx.fill();});}
  let clicked=[];canvas.onclick=event=>{const e=Number(extent.value),r=canvas.getBoundingClientRect();if(!Number.isFinite(e)||e<=0)return;const round=n=>Math.round(n*1000)/1000;const point=[round(((event.clientX-r.left)/r.width*2-1)*e),round((1-(event.clientY-r.top)/r.height*2)*e),0];if(op==='split_surface'&&clicked.length===2)clicked=[];clicked.push(point);if(op==='plane_surface')field('points').value=JSON.stringify(clicked);else {field(clicked.length===1?'start':'end').value=JSON.stringify(point);}draw();};
  clear.onclick=()=>{clicked=[];if(op==='plane_surface')field('points').value='[]';draw();};extent.oninput=draw;container.querySelectorAll('textarea,input').forEach(input=>input.addEventListener('input',draw));draw();
}


function renderCurveEditor(container){
  const raw=container.querySelector('[name=loops]'),rawLabel=raw.parentElement;rawLabel.hidden=true;raw.required=false;
  let loops=[],current=[],start=null,pending=null,tool='line';
  const editor=document.createElement('div');editor.className='profile-editor';
  const toolbar=document.createElement('div');toolbar.className='profile-controls';
  const canvas=document.createElement('canvas');canvas.width=500;canvas.height=500;canvas.setAttribute('aria-label','线弧轮廓画布');
  const message=document.createElement('p');message.className='hint';
  const coords=document.createElement('div');const scaleLabel=document.createElement('label');scaleLabel.textContent='画布范围（半宽）';const scale=document.createElement('input');scale.type='number';scale.min='.001';scale.step='any';scale.value='20';scaleLabel.append(scale);
  function button(label,fn){const b=document.createElement('button');b.type='button';b.textContent=label;b.onclick=fn;toolbar.append(b);return b;}
  const line=button('直线',()=>{tool='line';pending=null;draw();});const arc=button('圆弧',()=>{tool='arc';pending=null;draw();});
  const rectangle=button('矩形',()=>{tool='rectangle';pending=null;draw();});const circle=button('圆',()=>{tool='circle';pending=null;draw();});
  button('闭合轮廓',()=>{if(start&&current.length){const end=current[current.length-1].end;if(JSON.stringify(end)!==JSON.stringify(start))current.push({kind:'line',start:end,end:start});loops.push(current);current=[];start=null;pending=null;sync();}});
  button('新建孔',()=>{if(current.length){message.textContent='请先闭合当前轮廓。';return;}tool='line';start=null;pending=null;message.textContent='点击孔的起点，然后绘制并闭合。';});
  button('撤销线段',()=>{if(current.length){current.pop();if(!current.length)start=null;}else if(loops.length){current=loops.pop();current.pop();start=current[0]?.start||null;}pending=null;sync();});
  button('清空',()=>{loops=[];current=[];start=null;pending=null;sync();});editor.append(toolbar,scaleLabel,canvas,message,coords);container.prepend(editor);
  function sync(){raw.value=JSON.stringify(loops);renderCoordinates();draw();}
  function renderCoordinates(){coords.replaceChildren();[...loops,...(current.length?[current]:[])].forEach((loop,li)=>{const title=document.createElement('strong');title.textContent=li===0?'外轮廓':`孔 ${li}`;coords.append(title);loop.forEach((segment,si)=>{const row=document.createElement('div');row.className='curve-coordinate';const title=document.createElement('span');title.textContent=`${si+1} ${segment.kind==='line'?'直线':'圆弧'}`;row.append(title);for(const key of ['start',...(segment.kind==='arc'?['center']:[])]){const label=document.createElement('label');label.textContent=key==='start'?'起点':'圆心';['X','Y'].forEach((axis,i)=>{const input=document.createElement('input');input.type='number';input.step='any';input.value=segment[key][i];input.setAttribute('aria-label',`${title.textContent} ${label.textContent} ${axis}`);input.onchange=()=>{const value=Number(input.value);if(!Number.isFinite(value))return;segment[key][i]=value;if(key==='start'){const previous=loop[(si+loop.length-1)%loop.length];if(previous&&previous!==segment)previous.end=segment.start;}sync();};label.append(input);});row.append(label);}coords.append(row);});});}
  function draw(){const c=canvas.getContext('2d'),e=Number(scale.value);if(!(e>0))return;c.clearRect(0,0,500,500);c.fillStyle='white';c.fillRect(0,0,500,500);c.strokeStyle='#dce6e7';for(let i=0;i<=10;i++){c.beginPath();c.moveTo(i*50,0);c.lineTo(i*50,500);c.moveTo(0,i*50);c.lineTo(500,i*50);c.stroke();}const map=p=>[250+p[0]*250/e,250-p[1]*250/e];c.strokeStyle='#08796f';c.lineWidth=2;for(const loop of [...loops,current])for(const seg of loop){const a=map(seg.start),b=map(seg.end);c.beginPath();c.moveTo(...a);if(seg.kind==='arc'){const ctr=map(seg.center),r=Math.hypot(a[0]-ctr[0],a[1]-ctr[1]);let aa=Math.atan2(a[1]-ctr[1],a[0]-ctr[0]),bb=Math.atan2(b[1]-ctr[1],b[0]-ctr[0]);let delta=(bb-aa+Math.PI*3)%(Math.PI*2)-Math.PI;c.arc(ctr[0],ctr[1],r,aa,aa+delta,delta<0);}else c.lineTo(...b);c.stroke();}for(const b of [line,arc,rectangle,circle])b.classList.remove('active');({line,arc,rectangle,circle})[tool].classList.add('active');message.textContent=tool==='arc'?'先点击终点，再点击圆弧经过的点；单段圆弧小于 180°。':tool==='line'?'点击起点和后续顶点，完成后点击闭合轮廓。':'依次点击两个角点（圆为圆心和圆周点）。';}
  canvas.onclick=event=>{const e=Number(scale.value),r=canvas.getBoundingClientRect();if(!(e>0))return;const round=n=>Math.round(n*1000)/1000,p=[round(((event.clientX-r.left)/r.width*2-1)*e),round((1-(event.clientY-r.top)/r.height*2)*e),0];if(tool==='rectangle'||tool==='circle'){if(!pending){pending=p;return;}let segments;if(tool==='rectangle'){const a=pending,b=p,pts=[a,[b[0],a[1],0],b,[a[0],b[1],0]];segments=pts.map((v,i)=>({kind:'line',start:v,end:pts[(i+1)%4]}));}else{const c=pending,rad=Math.hypot(p[0]-c[0],p[1]-c[1]),pts=[[c[0]+rad,c[1],0],[c[0],c[1]+rad,0],[c[0]-rad,c[1],0],[c[0],c[1]-rad,0]];segments=pts.map((v,i)=>({kind:'arc',start:v,end:pts[(i+1)%4],center:c}));}if(current.length){message.textContent='请先闭合当前轮廓。';return;}loops.push(segments);pending=null;sync();return;}if(!start){start=p;draw();return;}const last=current.length?current[current.length-1].end:start;if(tool==='line'){current.push({kind:'line',start:last,end:p});sync();}else if(!pending){pending=p;}else{const [ax,ay]=last,[bx,by]=pending,[cx,cy]=p,d=2*(ax*(by-cy)+bx*(cy-ay)+cx*(ay-by));if(Math.abs(d)<1e-9){message.textContent='三点不能共线，请重新选择圆弧经过的点。';return;}const aa=ax*ax+ay*ay,bb=bx*bx+by*by,cc=cx*cx+cy*cy,center=[(aa*(by-cy)+bb*(cy-ay)+cc*(ay-by))/d,(aa*(cx-bx)+bb*(ax-cx)+cc*(bx-ax))/d,0];const angle=q=>Math.atan2(q[1]-center[1],q[0]-center[0]),delta=q=>(q+Math.PI*3)%(Math.PI*2)-Math.PI,ab=delta(angle(pending)-angle(last)),am=delta(angle(p)-angle(last));if(am*ab<0||Math.abs(am)>Math.abs(ab)+1e-8){message.textContent='圆弧超过 180°，请分成两段。';return;}current.push({kind:'arc',start:last,end:pending,center});pending=null;sync();}};scale.oninput=draw;sync();
}

async function applyManualCommand(operation,parameters) {
  if(!state.project||!beginEditTransaction())return false;
  try {
    if(state.dirty)await save();
    const id=state.project.id,revision=state.project.revision_id;
    const resetProgramMesh=operation==='set_mesh_strategy'&&state.config?.schema_version===3&&!!state.config.program?.mesh?.length;
    const result=await post(`/projects/${encodeURIComponent(id)}/commands`,{base_revision:revision,idempotency_key:crypto.randomUUID(),operation,parameters});
    if(state.project?.id!==id||state.project.revision_id!==revision)return false;
    state.redoStack=[];setProject(result);status('模型已更新',resetProgramMesh?'原程序网格控制已重置，可撤销恢复':'可撤销');return true;
  } finally {endEditTransaction();}
}
let importedWorkflow=null;
function showWorkflow(workflow){
  if(!workflow||workflow.format!=='meshpilot-workflow'||!workflow.parameters||typeof workflow.parameters!=='object')throw new Error('流程文件格式无效');
  importedWorkflow=workflow;const fields=$('workflow-parameters');fields.replaceChildren();
  Object.entries(workflow.parameters).forEach(([name,spec])=>{const label=document.createElement('label');label.textContent=spec.label||name;const input=document.createElement('input');input.type='number';input.step='any';input.required=true;input.name=name;input.value=spec.default;label.append(input);fields.append(label);});
  if(!fields.children.length){const hint=document.createElement('p');hint.textContent='此流程没有可调整参数。';fields.append(hint);}$('workflow-dialog').showModal();
}
function bind() {
  const setForm=$('named-set-form'),setKind=setForm.elements.kind;
  function setHelp(){const face=setKind.value==='face';setForm.elements.block_id.disabled=setKind.value==='node';setForm.elements.members.placeholder=face?'例如 1, 2, 1; 4, 3, -1':'例如 1, 2, 3';$('named-set-help').textContent=face?(state.config?.mesh?.dimension===2?'壳面按“单元序号, 局部面序号, 方向”输入，方向为 1 或 -1；序号从 1 开始，多组用分号分隔。':'实体面按“单元序号, 局部面序号, 方向”输入，序号从 1 开始；实体导出仅支持朝外方向 1，多组用分号分隔。'):'输入逗号或空格分隔的成员序号，序号从 1 开始。这些是当前网格的内部顺序，不是求解器编号。';}
  $('named-set').onclick=()=>{setHelp();$('named-set-dialog').showModal();};setKind.onchange=setHelp;$('named-set-close').onclick=()=>{if(!state.transaction)$('named-set-dialog').close();};
  setForm.onsubmit=async event=>{event.preventDefault();if(!state.project||!state.artifact||!beginEditTransaction())return;try{const kind=setKind.value,text=setForm.elements.members.value.trim(),positive=value=>{if(!/^\d+$/.test(value)||Number(value)<1||!Number.isSafeInteger(Number(value)))throw new Error('成员序号必须是从 1 开始的整数');return Number(value)-1;};let members;if(kind==='face'){members=text.split(';').map(group=>{const parts=group.trim().split(/[\s,]+/);if(parts.length!==3||!['1','-1'].includes(parts[2]))throw new Error('每个面需要单元序号、局部面序号及方向');return [positive(parts[0]),positive(parts[1]),Number(parts[2])];});}else members=text.split(/[\s,]+/).map(positive);const id=state.project.id,revision=state.project.revision_id,artifact_id=state.artifact.id;const payload={base_revision:revision,idempotency_key:crypto.randomUUID(),artifact_id,name:setForm.elements.name.value,kind,members};if(kind!=='node'&&setForm.elements.block_id.value.trim())payload.block_id=setForm.elements.block_id.value.trim();const project=await post(`/projects/${encodeURIComponent(id)}/named-set`,payload);if(state.project?.id===id&&state.project.revision_id===revision){state.redoStack=[];setProject(project);$('named-set-dialog').close();status('集合已创建','生成网格后可显示和导出');}}catch(error){fail(error);}finally{endEditTransaction();}};

  $('workflow-export').onclick=async()=>{try{if(!state.project)throw new Error('请先打开项目');if(state.dirty)await save();const workflow=await request(`/projects/${encodeURIComponent(state.project.id)}/workflow`);const url=URL.createObjectURL(new Blob([JSON.stringify(workflow,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download='meshpilot-workflow.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}catch(error){fail(error);}};
  $('workflow-import').onclick=()=>{if(!state.project){toast('请先打开项目');return;}$('workflow-file').click();};
  $('workflow-file').onchange=async event=>{try{const file=event.target.files[0];if(file)showWorkflow(JSON.parse(await file.text()));}catch(error){fail(error);}finally{event.target.value='';}};
  $('workflow-close').onclick=()=>{if(!state.transaction)$('workflow-dialog').close();};
  $('workflow-form').onsubmit=async event=>{event.preventDefault();if(!state.project||!importedWorkflow||!beginEditTransaction())return;try{if(state.dirty)await save();const id=state.project.id,revision=state.project.revision_id,values={};for(const [name] of Object.entries(importedWorkflow.parameters)){const value=Number(event.target.elements[name].value);if(!Number.isFinite(value))throw new Error('请输入有效参数');values[name]=value;}const project=await post(`/projects/${encodeURIComponent(id)}/workflow/run`,{workflow:importedWorkflow,values,base_revision:revision,idempotency_key:crypto.randomUUID()});if(state.project?.id===id&&state.project.revision_id===revision){state.redoStack=[];setProject(project);$('workflow-dialog').close();status('流程已运行','可撤销');}}catch(error){fail(error);}finally{endEditTransaction();}};

  $('manual-model').onclick=()=>{if(!state.project||state.transaction)return;if(!state.catalog[$('manual-operation').value])$('manual-operation').value=Object.keys(manualNames).find(op=>state.catalog[op])||'';renderManualTools();renderManualFields();$('manual-dialog').showModal();};
  $('manual-operation').onchange=renderManualFields;
  $('manual-close').onclick=()=>{if(!state.transaction)$('manual-dialog').close();};
  $('mesh-close').onclick=()=>{if(!state.transaction)$('mesh-dialog').close();};
  for(const id of ['manual-dialog','mesh-dialog','named-set-dialog','workflow-dialog'])$(id).addEventListener('cancel',event=>{if(state.transaction)event.preventDefault();});
  $('manual-form').onsubmit=async event=>{event.preventDefault();if(state.transaction)return;try{
    let op=$('manual-operation').value;const spec=op==='split_solid'?{inputs:1,args:{point:'vector3',normal:'nonzero_vector3'}}:op==='circle'?{inputs:0,args:{center:'vector3',radius:'positive'}}:op==='rectangle'?{inputs:0,args:{origin:'vector3',width:'positive',height:'positive'}}:op==='split_surface'?{inputs:1,args:{start:'vector3',end:'vector3'}}:state.catalog[op];if(!spec)throw new Error('当前操作不可用');
    const inputs=Array.from($('manual-inputs').querySelectorAll('select')).map(item=>item.value);
    if(inputs.length!==spec.inputs||inputs.some(value=>!value)||new Set(inputs).size!==inputs.length)throw new Error('请选择不同的有效部件');
    const args={};for(const [key,type] of Object.entries(spec.args||{})){const text=$('manual-form').elements[key].value;try{args[key]=['positive','degrees'].includes(type)?Number(text):JSON.parse(text);}catch{throw new Error(`${manualLabels[key]||key}格式无效，请检查数字或数组`);}if(typeof args[key]==='number'&&(!Number.isFinite(args[key])||(type==='positive'&&args[key]<=0)))throw new Error('请输入有效的正数');}
    if(op==='circle'){const [x,y,z]=args.center,r=args.radius,c=[x,y,z],p=[[x+r,y,z],[x,y+r,z],[x-r,y,z],[x,y-r,z]];op='profile_surface';Object.keys(args).forEach(key=>delete args[key]);args.loops=[p.map((start,i)=>({kind:'arc',start,end:p[(i+1)%4],center:c}))];}
    if(op==='rectangle'){const [x,y,z]=args.origin,w=args.width,h=args.height;op='plane_surface';Object.keys(args).forEach(key=>delete args[key]);args.points=[[x,y,z],[x+w,y,z],[x+w,y+h,z],[x,y+h,z]];}
    if(await applyManualCommand('model_operation',{op,args,inputs}))$('manual-dialog').close();
  }catch(error){fail(error);}};
  $('mesh-settings').onclick=()=>{if(!state.config||state.transaction)return;const mesh=state.config.mesh||{};
    $('mesh-strategy').value=mesh.element_type==='tri3'?'shell_tri3':mesh.element_type==='quad4'?'shell_quad4':mesh.element_type==='tet4'?'tet4':mesh.recipe?.kind==='voxel'?'voxel':'hex8';
    $('mesh-size').value=mesh.size||mesh.recipe?.size||1;$('mesh-dialog').showModal();};
  $('mesh-form').onsubmit=async event=>{event.preventDefault();if(state.transaction)return;try{const size=Number($('mesh-size').value);if(!Number.isFinite(size)||size<=0)throw new Error('请输入大于零的尺寸');if(await applyManualCommand('set_mesh_strategy',{strategy:$('mesh-strategy').value,size}))$('mesh-dialog').close();}catch(error){fail(error);}};
  $('open').onclick=()=>showProjects().catch(fail);$('new').onclick=()=>showProjects().catch(fail);
  $('empty-new').onclick=()=>showProjects().catch(fail);$('close-dialog').onclick=()=>$('project-dialog').close();
  $('create').onclick=async()=>{if(!guard())return;try{const project=await post('/projects',{name:$('new-name').value.trim()||'我的网格项目'});await chooseProject(project.id,true);activateTab('chat');}catch(error){fail(error);}};
  $('config-form').onsubmit=event=>{event.preventDefault();if(!state.transaction)save().catch(fail);};$('save').onclick=()=>{if(!state.transaction)save().catch(fail);};
  $('generate').onclick=()=>generate().catch(fail);$('show-preview').onclick=()=>showPreview().catch(fail);$('show-mesh').onclick=()=>showMesh().catch(fail);$('check-mesh').onclick=()=>checkMesh();
  $('undo').onclick=async()=>{if(state.transaction||state.saving||!guard()||!beginEditTransaction())return;try{const current=(state.project.revisions||[]).find(r=>r.id===state.project.revision_id);
    if(!current?.parent_id){toast('没有可撤销的版本');return;}const id=state.project.id,revision=state.project.revision_id;
    const result=await post(`/projects/${encodeURIComponent(id)}/history`,{revision_id:current.parent_id,base_revision:revision});
    if(state.project?.id!==id||state.project.revision_id!==revision)return;
    state.redoStack.push(revision);await chooseProject(id,true,true);if(state.project?.id===id&&state.project.revision_id===result.revision_id){status('已恢复上一版本');updateButtons();}
  }catch(error){fail(error);}finally{endEditTransaction();}};
  $('redo').onclick=async()=>{if(state.transaction||state.saving||!guard()||!state.project||!beginEditTransaction())return;try{const current=state.project.revision_id,target=state.redoStack.at(-1),child=(state.project.revisions||[]).find(r=>r.id===target&&r.parent_id===current);if(!child){toast('没有可重做的后续版本');return;}const id=state.project.id;const result=await post(`/projects/${encodeURIComponent(id)}/history`,{revision_id:child.id,base_revision:current});if(state.project?.id!==id||state.project.revision_id!==current)return;state.redoStack.pop();await chooseProject(id,true,true);if(state.project?.revision_id===result.revision_id){status('已重做最近操作');updateButtons();}}catch(error){fail(error);}finally{endEditTransaction();}};
  $('cancel').onclick=()=>{const id=state.job?.id;if(id)post(`/jobs/${encodeURIComponent(id)}/cancel`,{}).then(job=>{if(state.job?.id===id){state.job=job;updateButtons();}}).catch(fail);};
  $('edges').onchange=event=>viewer.setEdges(event.target.checked);$('reset').onclick=()=>viewer.resetCamera();
  $('select-part').onclick=()=>setPicking($('select-part').getAttribute('aria-pressed')!=='true');
  $('box-zoom').onclick=async()=>{
    const enable=$('box-zoom').getAttribute('aria-pressed')!=='true';
    if(enable)setPicking(false,{preserveSelection:true});
    if(viewer.renderQueue)await viewer.renderQueue;
    if(!viewer.setBoxZoomEnabled(enable))toast('视图尚未准备好');
  };
  $('zoom-reset').onclick=()=>viewer.resetCamera();
  $('plot').addEventListener('boxzoomchange',event=>{
    const active=event.detail.active;$('box-zoom').setAttribute('aria-pressed',String(active));
    $('box-zoom').textContent=active?'退出框选':'框选放大';
  });
  $('plot').addEventListener('boxzoomerror',()=>toast('视图调整失败，请重试'));
  $('plot').addEventListener('boxzoombusy',event=>{
    $('box-zoom').disabled=event.detail.busy||!viewer.surface;
    $('zoom-reset').disabled=event.detail.busy||!viewer.surface;
  });
  document.addEventListener('keydown',event=>{if(event.key==='Escape'){
    if($('select-part').getAttribute('aria-pressed')==='true')setPicking(false);
    if($('box-zoom').getAttribute('aria-pressed')==='true')viewer.setBoxZoomEnabled(false);
  }});
  $('axis').onchange=()=>{updateButtons();loadSurface().catch(fail);};
  $('fraction').oninput=()=>{$('fraction-label').textContent=Math.round(100*$('fraction').value)+'%';clearTimeout(bind.timer);bind.timer=setTimeout(()=>loadSurface().catch(fail),180);};
  $('report').onclick=showQualityReport;
  $('close-report').onclick=()=>$('report-dialog').close();$('export').onclick=()=>$('export-menu').classList.toggle('hidden');
  document.querySelectorAll('[data-format]').forEach(button=>button.onclick=()=>{if(availableExports().includes(button.dataset.format))window.location.href=`${api}/artifacts/${encodeURIComponent(state.artifact.id)}/download/${button.dataset.format}`;$('export-menu').classList.add('hidden');});
  $('provider-select').onchange=event=>{
    const form=$('provider-form'),provider=state.providers.find(item=>item.id===event.target.value);
    form.api_key.value='';form.api_key.required=true;form.base_url.value=provider?.base_url||'';form.model.value=provider?.default_model||'';form.supports_images.value='auto';
    state.providerDirty=true;state.providerSwitched=true;showProviderHint(event.target.value);
    $('provider-address').open=event.target.value==='custom';$('test-provider').disabled=true;
    $('provider-key-hint').textContent='服务商已切换，请填写该服务商的密钥。';$('provider-status').textContent='修改尚未保存';
  };
  ['base_url','model','api_key','supports_images'].forEach(name=>$('provider-form').elements[name].addEventListener('input',()=>{
    state.providerDirty=true;$('test-provider').disabled=true;$('provider-status').textContent='修改尚未保存';$('provider-image-hint').textContent='保存后检查当前模型的图片输入能力。';
  }));
  $('provider-form').onsubmit=async event=>{event.preventDefault();const form=event.currentTarget,button=form.querySelector('button');
    if(state.providerSwitched&&!form.api_key.value){$('provider-status').textContent='请填写新服务商的密钥';return;}
    button.disabled=true;$('test-provider').disabled=true;setProviderBusy(true);button.textContent='正在保存…';
    try{state.provider=await post('/provider',{provider_id:$('provider-select').value,base_url:form.base_url.value,model:form.model.value,api_key:form.api_key.value,supports_images:form.supports_images.value==='auto'?null:form.supports_images.value==='true',remember:form.remember.checked});form.api_key.value='';form.api_key.required=!state.provider.configured;state.providerDirty=false;state.providerSwitched=false;showProviderHint(state.provider.provider_id);form.remember.checked=state.provider.credentials_saved===true;$('provider-key-hint').textContent=credentialHint(state.provider.credential_error)|| (state.provider.credentials_saved?'密钥已安全保存在此设备。':'密钥仅保存在当前会话。');$('provider-status').textContent=credentialHint(state.provider.credential_error)|| (state.provider.credentials_saved?'连接信息已保存在此设备。':'已保存到当前会话');if(state.provider.configured&&!state.provider.credential_error){activateTab('chat');if(!state.project)await showProjects();}}
    catch(error){form.api_key.value='';$('provider-status').textContent='保存失败，请检查连接信息';fail(error);}finally{setProviderBusy(false);button.disabled=false;$('test-provider').disabled=!state.provider?.configured||state.providerDirty;button.textContent='保存连接';}};
  $('forget-provider').onclick=async()=>{const button=$('forget-provider');button.disabled=true;try{state.provider=await post('/provider/forget',{});$('provider-key-hint').textContent=credentialHint(state.provider.credential_error)||'已从此设备清除保存的密钥。';$('provider-status').textContent=credentialHint(state.provider.credential_error)||'连接密钥已清除；当前会话仍可继续使用。';$('remember-provider').checked=state.provider.credentials_saved===true;}catch(error){fail(error);}finally{button.disabled=false;}};
  $('test-provider').onclick=async()=>{const button=$('test-provider'),saveButton=$('provider-form').querySelector('button');
    if(!state.provider?.configured){$('provider-status').textContent='未配置 API，请先保存连接设置。';return;}
    if(button.disabled||state.providerDirty)return;
    button.disabled=true;saveButton.disabled=true;setProviderBusy(true);button.textContent='正在测试…';
    const controller=new AbortController();let timer,timedOut=false;
    try{
      await Promise.race([request('/provider/test',{method:'POST',body:'{}',signal:controller.signal}),new Promise((_,reject)=>{timer=setTimeout(()=>{timedOut=true;controller.abort();reject(new Error('API 连接测试超时，请检查网络或稍后重试。'));},70000);})]);
      $('provider-status').textContent='连接成功';
    }catch(error){$('provider-status').textContent=timedOut?'API 连接测试超时，请检查网络或稍后重试。':'连接失败，请检查地址、模型和密钥';if(!timedOut)fail(error);}
    finally{clearTimeout(timer);setProviderBusy(false);button.disabled=state.providerDirty||!state.provider?.configured;saveButton.disabled=false;button.textContent='测试连接';}};
  $('clear-selection').onclick=()=>clearSelection();
  $('draw-sketch').onclick=()=>{if(sketch&&state.project&&!state.conversing)sketch.open(state.project.id);};
  $('attach-image').onclick=()=>$('image-input').click();
  $('image-input').onchange=async event=>{const files=[...event.target.files],id=state.project?.id;event.target.value='';for(const file of files){try{await uploadImage(file,id);}catch(error){fail(error);break;}}};
  $('prompt').addEventListener('paste',async event=>{if(state.conversing)return;const files=[...(event.clipboardData?.items||[])].filter(item=>item.kind==='file').map(item=>item.getAsFile()).filter(Boolean);if(!files.length)return;event.preventDefault();const id=state.project?.id;for(const file of files){try{await uploadImage(file,id);}catch(error){fail(error);break;}}});
  $('restore-revision').onclick=async()=>{
    if(state.transaction||state.saving||!guard()||!state.project)return;
    const id=state.project.id,revision=state.project.revision_id,target=$('history-select').value;
    if(!target||target===revision||!beginEditTransaction())return;
    try{const result=await post(`/projects/${encodeURIComponent(id)}/history`,{revision_id:target,base_revision:revision});
      if(state.project?.id!==id||state.project.revision_id!==revision)return;
      state.redoStack=[];await chooseProject(id,true,true);if(state.project?.id===id&&state.project.revision_id===result.revision_id){status('已恢复选中版本');updateButtons();}
    }catch(error){fail(error);}finally{endEditTransaction();}
  };
  $('chat-form').onsubmit=async event=>{
    event.preventDefault();
    if(state.conversing||state.transaction)return;
    if(!state.project){toast('请先新建或打开项目');return;}
    if(attachmentUploads.get(state.project.id)){toast('请等待图片上传完成');return;}
    const images=[...currentAttachments()];
    const input=$('prompt').value.trim();
    const prompt=input||(images.length?'请结合附图理解要建模的对象；如果缺少关键尺寸或视图关系，请先向我澄清。':'');
    if(!prompt){toast('请描述您的建模需求，或添加草图');return;}
    if(prompt.length>4000){toast('每条消息最多 4000 字，请缩短后重试');return;}
    const id=state.project.id;
    const previous=conversations.get(id)||[];
    if(!state.provider?.configured){
      conversations.set(id,[...previous,{role:'user',content:prompt,images,localOnly:true},
        {role:'assistant',content:'未配置 API。请在连接设置中填写地址、模型和密钥；您仍可使用手动建模和网格功能。',localOnly:true}].slice(-20));
      $('prompt').value='';attachmentDrafts.set(id,[]);renderConversation();renderAttachments();updateButtons();return;
    }
    if(state.providerDirty){toast('请先保存当前服务商设置');activateTab('settings');return;}
    const history=previous.filter(message=>!message.pending&&!message.failed&&!message.localOnly).map(({role,content})=>({role,content}));
    // Replace only the latest matching failed attempt, preserving earlier attempts.
    const retry=previous.findLastIndex(message=>message.failed&&message.content===prompt&&
      JSON.stringify((message.images||[]).map(image=>image.id))===JSON.stringify(images.map(image=>image.id)));
    const messages=previous.filter((_,index)=>index!==retry);
    const sent={role:'user',content:prompt,images,pending:true};
    conversations.set(id,[...messages,sent]);
    $('prompt').value='';attachmentDrafts.set(id,[]);renderConversation();renderAttachments();
    const button=event.currentTarget.querySelector('button');button.disabled=true;button.textContent='正在处理…';state.conversing=true;updateButtons();
    try{
      if(state.dirty){await save();if(state.dirty)throw new Error('请先保存当前修改后重试');}
      if(state.project?.id!==id)throw new Error('项目已更改，请重新发送消息');
      const revision=state.project.revision_id;
      let updatedRevision=null;
      const result=await post(`/projects/${encodeURIComponent(id)}/conversation`,{prompt,base_revision:revision,selected_operation:state.selected,selection:state.selection,attachment_ids:images.map(image=>image.id),history});
      if(state.project?.id!==id||state.project.revision_id!==revision||state.dirty){throw new Error('项目已更改，请重新发送消息');}
      if(result.base_revision&&result.base_revision!==revision)throw new Error('对话结果对应的版本已过期，请重新发送消息');
      const clearing=result.action==='clear_model';
      if((clearing&&state.config)||(result.config&&configKey(result.config)!==configKey(state.config))){
        const updated=await post(`/projects/${encodeURIComponent(id)}/commands`,{base_revision:revision,idempotency_key:crypto.randomUUID(),operation:clearing?'clear_model':'set_config',parameters:clearing?null:result.config,...(result.edits?{edits:result.edits}:{})});
        if(state.project?.id!==id||state.project.revision_id!==revision||state.dirty){throw new Error('项目已更改，请重新打开项目');}
        state.redoStack=[];setProject(updated);updatedRevision=updated.revision_id;status(clearing?'模型已清空，可从操作记录恢复':'模型已更新','可撤销');
      }
      sent.pending=false;appendConversation(id,String(result.summary||'已完成'));
      renderConversation();renderAttachments();
      if(updatedRevision||(result.action==='mesh'&&state.config)){
        const notice=document.createElement('div');notice.className='hint';
        const saved=updatedRevision?'模型已更新。':'';
        notice.textContent=clearing?'模型已清空，之前的版本仍可恢复。':saved+(result.action==='mesh'?'网格生成进度见下方状态栏。':'可继续对话修改。');
        $('chat-log').append(notice);$('chat-log').scrollTop=$('chat-log').scrollHeight;
      }
      if(result.action==='mesh'&&state.config){
        const key=configKey(state.config),seq=state.previewSeq;
        clearTimeout(schedulePreview.timer);await loadPreview(seq,key);
        if(state.project?.id===id&&state.previewKey===key&&configKey(state.config)===key&&!state.dirty){status('正在生成网格');generate().catch(fail);}
      }
    }catch(error){
      if(sent.pending){sent.pending=false;sent.failed=true;
        if(state.project?.id===id){if(!$('prompt').value.trim())$('prompt').value=input;
          if(!currentAttachments(id).length)attachmentDrafts.set(id,images);renderConversation();}}
      fail(error);
    }finally{state.conversing=false;updateButtons();renderAttachments();button.textContent='发送';}
  };
  window.addEventListener('beforeunload',event=>{if(state.dirty){event.preventDefault();event.returnValue='';}});
}
async function start() {
  bind();bindLicense();renderTree();updateButtons();
  try{const boot=await refreshBootstrap();
    if(boot.license?.required&&!boot.license.valid)showLicense(true);
    else await showProjects();
  }catch(error){status('服务不可用','请确认本地服务已启动',true);toast(error.message);return;}
  if(initializationErrors.length){status('部分功能不可用',initializationErrors.join('；'),true);toast(initializationErrors.join('；'));}
}
start().catch(error=>{console.error('Workbench initialization failed',error);status('界面初始化失败',error.message||String(error),true);toast('界面初始化失败，请重启应用：'+(error.message||String(error)));});

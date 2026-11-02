"""External black-box acceptance for an installed desktop; no product imports."""
import argparse,json,os,socket,subprocess,tempfile,time,traceback,urllib.request
from pathlib import Path
import psutil,websocket

def wait(fn,seconds=180):
 end=time.monotonic()+seconds;last=None
 while time.monotonic()<end:
  try:
   last=fn()
   if last:return last
  except (OSError,ValueError):pass
  time.sleep(.25)
 raise RuntimeError('Timeout: '+repr(last))

class Page:
 def __init__(self,url):self.ws=websocket.create_connection(url,timeout=20,suppress_origin=True);self.seq=0
 def call(self,method,params=None):
  self.seq+=1;seq=self.seq;self.ws.send(json.dumps({'id':seq,'method':method,'params':params or {}}))
  while True:
   response=json.loads(self.ws.recv())
   if response.get('id')==seq:
    if 'error' in response:raise RuntimeError(str(response['error']))
    return response.get('result',{})
 def js(self,expression):
  result=self.call('Runtime.evaluate',{'expression':expression,'awaitPromise':True,'returnByValue':True})
  if 'exceptionDetails' in result:raise RuntimeError(str(result['exceptionDetails']))
  return result.get('result',{}).get('value')
 def click(self,selector):
  rect=self.js('(()=>{const e=document.querySelector('+json.dumps(selector)+');if(!e)throw Error("missing control");e.scrollIntoView();return e.getBoundingClientRect().toJSON()})()')
  if not rect['width'] or not rect['height']:raise RuntimeError('Hidden control '+selector)
  for kind in ('mouseMoved','mousePressed','mouseReleased'):
   data={'type':kind,'x':rect['x']+rect['width']/2,'y':rect['y']+rect['height']/2}
   if kind!='mouseMoved':data.update(button='left',buttons=1 if kind=='mousePressed' else 0,clickCount=1)
   self.call('Input.dispatchMouseEvent',data)

def get(url):
 with urllib.request.urlopen(url,timeout=3) as response:return json.load(response)

def api(page,path,method='GET',data=None):
 expression='''(async()=>{const r=await fetch(PATH,{method:METHOD,headers:{'Content-Type':'application/json'},body:BODY});let t=await r.text();let v;try{v=JSON.parse(t)}catch{v=t}return {status:r.status,body:v}})()'''
 return page.js(expression.replace('PATH',json.dumps('/api/v1'+path)).replace('METHOD',json.dumps(method)).replace('BODY','undefined' if data is None else json.dumps(json.dumps(data))))

def run(exe,out):
 report={'status':'running','cases':{},'model_calls':0};proc=None;page=None
 with tempfile.TemporaryDirectory(prefix='meshpilot-ci-') as tmp:
  tmp=Path(tmp)
  for name in ('local','roaming','data','profile'): (tmp/name).mkdir()
  env={k:v for k,v in os.environ.items() if k.upper() not in {'PYTHONPATH','PYTHONHOME','ELECTRON_RUN_AS_NODE','NODE_OPTIONS','BROWSER'}}
  env.update(PATH=str(Path(os.environ['SystemRoot'])/'System32'),LOCALAPPDATA=str(tmp/'local'),APPDATA=str(tmp/'roaming'),OPENBLAS_NUM_THREADS='1')
  with socket.socket() as s:s.bind(('127.0.0.1',0));port=s.getsockname()[1]
  base='http://127.0.0.1:'+str(port)
  try:
   proc=subprocess.Popen([str(exe),'--data-dir='+str(tmp/'data'),'--user-data-dir='+str(tmp/'profile'),'--remote-debugging-port='+str(port),'--remote-allow-origins='+base],cwd=str(exe.parent),env=env,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
   target=wait(lambda:next((x for x in get(base+'/json/list') if x.get('type')=='page' and x.get('url','').startswith('http://127.0.0.1:')),None),90)
   page=Page(target['webSocketDebuggerUrl']);wait(lambda:page.js("document.readyState==='complete' && document.querySelector('#project-dialog')?.open"),60)
   page.click('#close-dialog');page.click('[data-tab="settings"]');assert page.js("!document.querySelector('#settings').classList.contains('hidden')")
   bootstrap=api(page,'/bootstrap');assert bootstrap['status']==200 and not bootstrap['body']['provider']['configured']
   baseplan={'schema_version':2,'name':'ci_box','units':'unitless','operations':[{'id':'solid','op':'box','args':{'origin':[0,0,0],'size':[2,2,2]}}],'outputs':[{'id':'body','source':'solid'}],'interfaces':[]}
   shell={'schema_version':2,'name':'ci_shell','units':'unitless','operations':[{'id':'surface','op':'plane_surface','args':{'points':[[0,0,0],[2,0,0],[2,2,0],[0,2,0]]}}],'outputs':[{'id':'body','source':'surface'}],'interfaces':[],'mesh':{'dimension':2,'element_type':'quad4','size':1}}
   cases={'mapped':dict(baseplan,mesh={'dimension':3,'element_type':'hex8','recipe':{'kind':'section_sweep','size':1}}),'voxel':dict(baseplan,mesh={'dimension':3,'element_type':'hex8','recipe':{'kind':'voxel','size':1}}),'shell':shell,'hexmicro':{'schema_version':1,'name':'ci_hexmicro','units':'unitless','operations':[{'id':'solid','op':'box','args':{'origin':[0,0,0],'size':[6,6,6]}}],'outputs':['solid'],'mesh':{'dimension':3,'element_type':'hex8','recipe':{'kind':'hexmicro','config':{'name':'ci','mode':'3d','backend':'voronoi','domain':{'size':[6,6,6],'units':'unitless'},'tessellation':{'seeds':[[1.5,1.5,3],[4.5,1.5,3],[1.5,4.5,3],[4.5,4.5,3]]},'interface':'shared','mesh':{'size_min':1.2,'size_max':1.2,'seed':42,'threads':1}}}}}}
   for name,plan in cases.items():
    created=api(page,'/projects','POST',{'name':'CI '+name});assert created['status']==200,created;p=created['body'];pid=p['id']
    if name=='mapped':
     failure=api(page,'/projects/'+pid+'/conversation','POST',{'prompt':'test','base_revision':p['revision_id']});report['unconfigured_provider']=failure
     assert failure['status']>=400 and 'PROVIDER_NOT_CONFIGURED' in json.dumps(failure['body']),failure
    saved=api(page,'/projects/'+pid+'/commands','POST',{'base_revision':p['revision_id'],'idempotency_key':'ci-'+name,'operation':'set_config','parameters':plan});assert saved['status']==200,saved
    started=api(page,'/projects/'+pid+'/jobs','POST',{'base_revision':saved['body']['revision_id']});assert started['status']==200,started
    jid=started['body']['id'];job=wait(lambda:(lambda j:j if j['status'] not in ('queued','running','cancelling') else None)(api(page,'/jobs/'+jid)['body']),300);assert job['status']=='succeeded',job
    artifact=job['artifact_id'];downloads={}
    for ext in ('msh','inp','k'):
     download=page.js("fetch('/api/v1/artifacts/"+artifact+"/download/"+ext+"').then(async r=>({status:r.status,bytes:(await r.arrayBuffer()).byteLength}))")
     assert download['status']==200 and download['bytes']>0,download;downloads[ext]=download['bytes']
    start=api(page,'/artifacts/'+artifact+'/checks','POST',{});assert 200<=start['status']<300,start
    cid=start['body']['check']['id'];check=wait(lambda:(lambda x:x if x['status'] not in ('queued','running') else None)(api(page,'/checks/'+cid)['body']['check']),300);assert check['status']=='succeeded',check
    readback=check['report']['readback'];assert readback['status']=='passed' and readback.get('passed',True),readback
    assert all(readback[ext]['status']=='passed' and readback[ext].get('passed',True) for ext in ('msh','inp','k')),readback
    quality=check['report']['quality'];report['cases'][name]={'job':job['status'],'downloads':downloads,'readback':readback,'quality':quality}
    if quality['status']!='passed':raise RuntimeError(name+' quality '+quality['status'])
   report['status']='passed'
  except Exception as exc:report.update(status='failed',error=repr(exc),traceback=traceback.format_exc())
  finally:
   if page:page.ws.close()
   if proc:
    try:
     parent=psutil.Process(proc.pid);children=parent.children(recursive=True);parent.terminate();gone,alive=psutil.wait_procs([parent]+children,timeout=15)
     for child in alive:child.kill()
     psutil.wait_procs(alive,timeout=10);report['process_exit']=proc.poll();report['remaining_processes']=[p.pid for p in alive if p.is_running()]
    except psutil.NoSuchProcess:report['process_exit']=proc.poll();report['remaining_processes']=[]
 out.mkdir(parents=True,exist_ok=True);(out/'controller.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf8')
 if report['status']!='passed' or report.get('remaining_processes'):raise SystemExit(1)

if __name__=='__main__':
 parser=argparse.ArgumentParser();parser.add_argument('--exe',type=Path,required=True);parser.add_argument('--output',type=Path,required=True);args=parser.parse_args();run(args.exe.resolve(),args.output.resolve())

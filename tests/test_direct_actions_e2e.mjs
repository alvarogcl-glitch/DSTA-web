import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import vm from 'node:vm';
const source = readFileSync(new URL('../src/worker.js', import.meta.url), 'utf8').replace('import { DurableObject } from "cloudflare:workers";', 'class DurableObject { constructor(ctx,env){this.ctx=ctx;this.env=env} }');
const {default:worker,DashboardChatQueue}=await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const store=new Map();
const env={DASHBOARD_USER:'test',DASHBOARD_PASSWORD:'test',DSTA_BRIDGE_TOKEN:'bridge-test',INGEST_TOKEN:'ingest-test',DASHBOARD_DATA:{async get(){return null}}};
const queue=new DashboardChatQueue({storage:{kv:{get:k=>store.get(k),put:(k,v)=>store.set(k,structuredClone(v)),delete:k=>store.delete(k),list:({prefix})=>[...store].filter(([k])=>k.startsWith(prefix))}}},env);
env.CHAT_STATE={getByName:()=>new Proxy({}, {get:(_,key)=>key==='fetch' ? r=>queue.fetch(typeof r==='string'?new Request(r):r) : (...args)=>queue[key](...args)})};
const fields='id title description project_id done due_date reminders repeat_after repeat_mode priority start_date end_date assignees hex_color percent_done cover_image_attachment_id is_favorite'.split(' ');
let task=Object.fromEntries(fields.map(k=>[k,null]));
Object.assign(task,{id:15,title:'Synthetic task',description:'SOURCE: synthetic\nACTION_KEY: stable',project_id:3,done:false});
const original=structuredClone(task);
const projects=[{id:2,title:'PMO-DSTA',is_archived:false},{id:3,title:'LT1',parent_project_id:2,is_archived:false}];
let writes=0;
const server=createServer(async(req,res)=>{
 try {
  const chunks=[];for await(const c of req)chunks.push(c);const raw=Buffer.concat(chunks);
  const path=new URL(req.url,'http://local').pathname;
  if(path.startsWith('/api/v1/')){
   assert.equal(req.headers.authorization,'Bearer vikunja-test');
   let value;
   if(path==='/api/v1/projects')value=projects;
   else if(path==='/api/v1/projects/2')value=projects[0];
   else if(path==='/api/v1/projects/3')value=projects[1];
   else if(path==='/api/v1/projects/3/tasks')value=[task];
   else if(path==='/api/v1/tasks/15'){
    if(req.method==='POST'){writes++;const payload=JSON.parse(raw);assert.deepEqual(payload,{...original,done:true});task=payload}
    value=task;
   }else throw Error('unexpected fake endpoint');
   res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(value));return;
  }
  const request=new Request('https://example.test'+req.url,{method:req.method,headers:req.headers,...(raw.length?{body:raw}:{} )});
  const reply=await worker.fetch(request,env);res.writeHead(reply.status,Object.fromEntries(reply.headers));res.end(await reply.text());
 }catch(e){res.writeHead(500);res.end(JSON.stringify({error:e.message}));}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base=`http://127.0.0.1:${server.address().port}`;
const authorization='Basic '+Buffer.from('test:test').toString('base64');
const browserFetch=(url,opts={})=>fetch(base+url,{...opts,headers:{authorization,...opts.headers}});
try{
 await queue.saveSnapshot({timestamp:new Date(Date.now()-60000).toISOString(),projects:[projects[1]],tasks:[task]});
 await browserFetch('/api/assistant',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({message:'Long chat remains queued'})});
 const requestId=crypto.randomUUID();
 const action={action:'complete',taskId:15,requestId};
 const submitted=await browserFetch('/api/task-actions',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(action)});
 assert.equal(submitted.status,202);
 const job=(await(await fetch(base+'/api/bridge/next?kind=action',{headers:{authorization:'Bearer bridge-test'}})).json()).job;
 let pending=JSON.stringify({id:requestId,taskId:'15',kind:'complete',endpoint:'/api/task-actions'});
 let toast;
 const element=()=>({children:[],append(...x){this.children.push(...x)},setAttribute(){},addEventListener(){}});
 const context={window:{},Intl,Date,clearTimeout,setTimeout:(fn,delay)=>setTimeout(fn,delay===6000?6000:5),tasks:[{...task}],
  sessionStorage:{getItem:()=>pending,setItem:(k,v)=>pending=v,removeItem:()=>pending=null},
  document:{head:{append(){}},body:{append(v){toast=v}},createElement:element},fetch:browserFetch,
  refresh:async(timestamp)=>{const snapshot=await(await browserFetch('/api/dashboard')).json();context.tasks=snapshot.tasks;return Date.parse(snapshot.timestamp)>=Date.parse(timestamp)}};
 vm.runInNewContext(readFileSync(new URL('../public/task-actions.js',import.meta.url),'utf8'),context);
 const script=`import importlib.util,json,sys\nfrom pathlib import Path\nspec=importlib.util.spec_from_file_location('bridge',Path('tools/hermes_bridge.py'));b=importlib.util.module_from_spec(spec);spec.loader.exec_module(b)\nb.answer_chat=lambda *a: (_ for _ in ()).throw(AssertionError('AI forbidden'))\nb.process_job(json.loads(sys.argv[2]),sys.argv[1],'bridge-test','unused',Path('.'),'unused','unused','vikunja-test',sys.argv[1])\n`;
 const skewedScript=script.replace('b.process_job(',`from datetime import datetime,timedelta
original_fetch=b.fetch_dashboard
def skewed_fetch(*args):
    snapshot=original_fetch(*args)
    for field in ('timestamp','observationStartedAt'):
        snapshot[field]=(datetime.fromisoformat(snapshot[field])-timedelta(seconds=5)).isoformat()
    return snapshot
b.fetch_dashboard=skewed_fetch
b.process_job(`);
 const child=spawn('python',['-c',skewedScript,base,JSON.stringify(job)],{stdio:['ignore','pipe','pipe']});
 let output='';child.stdout.on('data',x=>output+=x);child.stderr.on('data',x=>output+=x);
 const exit=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',resolve)});
 assert.equal(exit,0,output);
 for(let i=0;i<100 && pending;i++)await new Promise(r=>setTimeout(r,10));
 assert.equal(pending,null,'frontend only clears after real published done snapshot');
 assert.match(toast.children[0].textContent,/Tarea completada/);
 assert.equal(writes,1);
 assert.equal((await(await browserFetch('/api/task-actions?id='+requestId)).json()).status,'completed');
 const duplicate=await browserFetch('/api/task-actions',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(action)});
 assert.equal((await duplicate.json()).status,'completed');assert.equal(writes,1);
 assert.equal(store.get('job:'+store.get('current')).status,'queued','copilot independent');
 console.log('real localhost HTTP with VM clock 5s behind: Worker queue -> Python deterministic Vikunja -> snapshot -> frontend success; one write, no AI');
}finally{server.closeAllConnections();await new Promise(r=>server.close(r));}

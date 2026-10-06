import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const source = readFileSync(new URL('../public/task-actions.js', import.meta.url), 'utf8');
const id='12345678-1234-4234-8234-123456789012';
async function recover({endpoint='/api/task-actions',missing=false,storageFails=false,refreshFails=false}={}) {
  let now=0, posts=0, gets=0, saved, success=false;
  let job={id,taskId:'17',kind:'complete',endpoint};
  const task={id:17,done:false};
  const element=()=>({children:[], append(...x){this.children.push(...x)},setAttribute(){},addEventListener(){}});
  const ctx={window:{}, crypto:{randomUUID:()=>id}, tasks:[task],Intl,
    Date:class extends Date {static now(){return now}},clearTimeout(){},setTimeout(fn){now+=2000;fn()},
    sessionStorage:{getItem:()=>JSON.stringify(job),setItem(k,v){if(storageFails)throw Error('blocked');saved=v},removeItem(){job=null}},
    document:{head:{append(){}},body:{append(){}},createElement:element},
    refresh:async()=>{task.done=true; return !refreshFails},
    fetch:async(url,opts)=>{
      if(opts.method==='POST'){posts++; assert.equal(url,endpoint);assert.equal(JSON.parse(opts.body).requestId,id);return {ok:true,json:async()=>({id,status:'queued'})}}
      gets++;assert.equal(url,endpoint+'?id='+id);
      if(missing && gets===1)return {ok:false,status:404,json:async()=>({error:'not found'})};
      return {ok:true,json:async()=>({status:'completed',snapshotTimestamp:'2026-10-06T12:00:00Z'})};
    }};
  vm.runInNewContext(source,ctx);
  for(let i=0;i<500;i++)await Promise.resolve();
  assert.equal(posts,missing?1:0,'reload uses saved endpoint/id, never new request');
  assert.equal(job===null,!refreshFails,'snapshot failure retains structured id');
}
await recover();
await recover({missing:true});
await recover({refreshFails:true});
await recover({endpoint:'/api/assistant'}); // preexisting AI completion jobs remain readable
console.log('structured reload, missing POST replay, snapshot uncertainty and legacy recovery passed');

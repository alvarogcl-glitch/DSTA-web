import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const source=readFileSync(new URL('../public/task-actions.js',import.meta.url),'utf8').replace('window.DstaTaskActions = { mount };','window.DstaTaskActions = { mount, submit, getPending: () => pending };');
for(const mode of ['initial','post','terminal','cleanup']) {
 let posts=0,writes=0,uuid=0,now=0;const storage=new Map();const task={id:17,done:false};
 const node=()=>({children:[],append(...n){this.children.push(...n)},setAttribute(){},addEventListener(){}});
 const c={tasks:[task],inspection:null,Intl,Date:class extends Date{static now(){return now}},
 crypto:{randomUUID:()=>`12345678-1234-4234-8234-${String(++uuid).padStart(12,'0')}`},
 setTimeout(fn){now+=2000;fn()},clearTimeout(){},
 sessionStorage:{getItem:k=>storage.get(k),setItem(k,v){writes++;if(writes===({initial:1,post:2,terminal:3}[mode]))throw Error('storage');storage.set(k,v)},removeItem(k){if(mode==='cleanup')throw Error('storage');storage.delete(k)}},
 document:{createElement:node,head:{append(){}},body:{append(){}}},
 refresh:async()=>{task.done=true;return true},taskView(){},showInspection(){},
 fetch:async(url,o)=>{if(o.method==='POST'){posts++;return{ok:true,status:202,json:async()=>({id:JSON.parse(o.body).requestId})}}return{ok:true,json:async()=>mode==='terminal'?{status:'error',error:'Synthetic terminal'}:{status:'completed',snapshotTimestamp:'2026-10-06T12:00:00Z'}}}
 };c.window={};vm.runInNewContext(source,c);const api=c.window.DstaTaskActions;
 await api.submit('17','complete');
 if(mode==='initial'){assert.equal(posts,0);assert.equal(api.getPending(),null)}
 else{assert.ok(api.getPending(),mode+' storage failure must retain pending fence');assert.equal(api.getPending().id,'12345678-1234-4234-8234-000000000001');await api.submit('17','complete');assert.equal(posts,1,'no second POST or new UUID after accepted storage failure')}
}
console.log('initial/post-acceptance/terminal/cleanup storage fault fences passed');

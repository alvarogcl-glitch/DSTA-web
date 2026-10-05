import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const html=readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
const manual=html.slice(html.indexOf('async function manualRefresh(){'),html.indexOf('async function refresh('));
async function scenario(mode){
 const button={disabled:false,textContent:'Actualizar ahora'},error={textContent:''};
 let now=0,posts=0,polls=0,rendered;
 const context={healthRefreshing:false,$:id=>id==='#refresh'?button:error,
  Date:{now:()=>now},setTimeout:resolve=>{now+=2000;resolve()},
  refresh:async()=>true,renderHealth:value=>{rendered=value},
  fetch:async(url,options)=>{
   if(options?.method==='POST'){posts++;return {ok:true,json:async()=>({id:'new'})}}
   polls++;
   if(mode==='error')return {ok:false};
   const requestId=mode==='success'&&polls>1?'new':'old';
   return {ok:true,json:async()=>({health:{vikunja:{ok:true,requestId},granola:{ok:true,requestId}}})};
  }};
 vm.createContext(context);vm.runInContext(manual,context);
 const first=context.manualRefresh();
 assert.equal(button.disabled,true);
 await context.manualRefresh();
 await first;
 assert.equal(posts,1,'a second click must not enqueue a second request');
 assert.equal(button.disabled,false);
 assert.equal(button.textContent,'Actualizar ahora');
 if(mode==='success'){assert.equal(rendered.granola.requestId,'new');assert.equal(polls,2)}
 else{assert.equal(rendered,undefined);assert.ok(error.textContent)}
}
await scenario('success');await scenario('timeout');await scenario('error');
// A heartbeat must not make an old measurement look fresh.
const renderer=html.slice(html.indexOf('const HEALTH_STALE_MS='),html.indexOf('function render(){'));
let content='';
const context={$:()=>({set innerHTML(value){content=value}}),esc:String,Date};
vm.runInNewContext(renderer+`;renderHealth({granola:{ok:true,checkedAt:new Date(Date.now()-13*60000).toISOString(),receivedAt:new Date().toISOString()}})`,context);
assert.match(content,/sin reporte reciente/);
console.log('manual health button and stale measurement checks passed');

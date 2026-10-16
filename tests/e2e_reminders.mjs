// Real Worker, per-account DO and Chrome over localhost. No live services/models/push endpoints.
import assert from 'node:assert/strict';
import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),{chromium}=require(process.env.DSTA_PLAYWRIGHT_MODULE||'playwright');
const root=fileURLToPath(new URL('..',import.meta.url)),evidence=join(root,'docs/convergencia/evidencia/recordatorios');mkdirSync(evidence,{recursive:true});
const reminderURL=new URL('../src/reminders.js',import.meta.url).href;
const source=readFileSync(join(root,'src/worker.js'),'utf8').replace('import { DurableObject } from "cloudflare:workers";','class DurableObject{constructor(ctx,env){this.ctx=ctx;this.env=env;}}').replaceAll('import("./reminders.js")',`import(${JSON.stringify(reminderURL)})`);
const {default:worker,DashboardChatQueue}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
const users={},boxes=new Map();for(const actor of ['qa-a','qa-b']){const hash=Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(actor))).toString('base64url');users[hash]={id:actor,token_hash:hash,display_name:actor,email:actor+'@qa.test'};}
const env={AUTH_MODE:'accounts',DSTA_BRIDGE_TOKEN:'synthetic-qa',DB:{prepare(){return {bind(hash){return {first:async()=>users[hash]||Object.values(users).find(u=>u.id===hash)||null,all:async()=>({results:[]}),run:async()=>({success:true})}}}}},DASHBOARD_DATA:{get:async()=>null},ASSETS:{fetch:async request=>{const path=new URL(request.url).pathname;try{return new Response(readFileSync(join(root,'public',path==='/'?'index.html':path)),{headers:{'content-type':path.endsWith('.js')?'text/javascript':path.endsWith('.css')?'text/css':path.endsWith('.png')?'image/png':'text/html'}});}catch{return new Response('not found',{status:404});}}}};
env.CHAT_STATE={getByName(name){if(!boxes.has(name)){const data=new Map();const ctx={id:{name},storage:{setAlarm:async at=>ctx.alarm=at,deleteAlarm:async()=>ctx.alarm=null,kv:{get:k=>structuredClone(data.get(k)),put:(k,v)=>data.set(k,structuredClone(v)),delete:k=>data.delete(k),list:({prefix})=>new Map([...data].filter(([k])=>k.startsWith(prefix)))}}};boxes.set(name,new DashboardChatQueue(ctx,env));}const b=boxes.get(name);return new Proxy(b,{get(t,k){if(k==='fetch')return input=>t.fetch(typeof input==='string'?new Request(input):input);return typeof t[k]==='function'?t[k].bind(t):t[k];}});}};
for(const [i,actor] of ['qa-a','qa-b'].entries())await env.CHAT_STATE.getByName('u:'+actor).saveSnapshot({timestamp:new Date().toISOString(),projects:[{id:3+i,title:'LT de '+actor}],labels:[],tasks:[{id:70+i,project_id:3+i,project:'LT de '+actor,title:'Revisar entrega '+actor,owner:'QA',description:'Responsable: QA',date:'',dependency:'',done:false}]});
const server=createServer(async(req,res)=>{try{const chunks=[];for await(const c of req)chunks.push(c);const body=Buffer.concat(chunks);const r=await worker.fetch(new Request(`http://localhost:${server.address().port}${req.url}`,{method:req.method,headers:req.headers,...(body.length?{body}:{})}),env);res.writeHead(r.status,Object.fromEntries(r.headers));res.end(Buffer.from(await r.arrayBuffer()));}catch(e){res.writeHead(500);res.end(e.message);}});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base='http://localhost:'+server.address().port;
const browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe'}),errors=[];
async function pageFor(actor,viewport){const context=await browser.newContext({viewport});await context.addCookies([{name:'__Host-dsta_session',value:actor,url:base.replace('http:','https:'),secure:true,sameSite:'Lax'}]);const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));await page.goto(base);await page.locator('#dsta-reminders-toggle').waitFor();return page;}
try {
  const a=await pageFor('qa-a',{width:1280,height:900}),b=await pageFor('qa-b',{width:390,height:844});
  await a.locator('#dsta-reminders-toggle').click();await a.getByRole('button',{name:'+ Nuevo recordatorio',exact:true}).click();
  const edit=a.locator('.reminders-editor');await edit.locator('[name=text]').fill('Revisar informe QA');
  await edit.locator('[name=repeat]').selectOption('daily');
  // Lose the POST response after the server persisted the operation. The receipt recovers it.
  let lost=false;await a.route('**/api/reminders/save',async route=>{if(!lost){lost=true;await route.fetch();await route.abort();}else await route.continue();});
  await edit.getByRole('button',{name:'Guardar recordatorio',exact:true}).click();await edit.waitFor({state:'hidden'});
  assert.equal([...boxes.get('u:qa-a').ctx.storage.kv.list({prefix:'reminder:'})].length,1);
  await a.screenshot({path:join(evidence,'proximos-desktop.png')});
  await b.locator('#dsta-reminders-toggle').click();assert.equal(await b.locator('.reminder-card').count(),0,'A/B isolation in UI');
  // A reload recovers server data without storing the reminder's text locally.
  await a.reload();await a.locator('#dsta-reminders-toggle').click();await a.locator('.reminder-card').filter({hasText:'Revisar informe QA'}).waitFor();
  assert.ok(!(await a.evaluate(()=>JSON.stringify({...localStorage,...sessionStorage}))).includes('Revisar informe QA'));
  const box=boxes.get('u:qa-a'),r=[...box.ctx.storage.kv.list({prefix:'reminder:'})][0][1];
  const realNow=Date.now,fireAt=r.nextAt+1000;Date.now=()=>fireAt;try{await box.alarm();await box.alarm();}finally{Date.now=realNow;}
  await a.evaluate(()=>window.DstaReminders.refresh());assert.equal(await a.locator('.reminder-due').count(),1);
  await a.setViewportSize({width:390,height:844});await a.screenshot({path:join(evidence,'pendiente-mobile.png')});
  assert.ok(await a.locator('#dsta-reminders').evaluate(e=>e.scrollWidth<=e.clientWidth+1),'no mobile horizontal overflow');
  await a.locator('.reminder-due').getByRole('button',{name:'15 min',exact:true}).click();await a.waitForFunction(()=>document.querySelectorAll('.reminder-due').length===0);
  await a.getByRole('button',{name:'Historial',exact:true}).click();assert.equal(await a.locator('.reminder-due').count(),1);
  await a.screenshot({path:join(evidence,'historial-mobile.png')});
  await a.getByRole('button',{name:'Próximos y pendientes',exact:true}).click();
  await a.locator('.reminder-card').getByRole('button',{name:'Editar',exact:true}).click();await edit.locator('[name=text]').fill('Informe QA actualizado');await edit.getByRole('button',{name:'Guardar recordatorio',exact:true}).click();await edit.waitFor({state:'hidden'});
  await a.locator('.reminder-card').getByRole('button',{name:'Cancelar',exact:true}).click();await a.waitForFunction(()=>document.querySelectorAll('.reminder-card').length===0);
  await a.getByRole('button',{name:'Cerrar',exact:true}).click();
  // Task inspector path: linked reminder keeps its task; completing a notice never writes Vikunja.
  await a.evaluate(()=>showTask('70'));await a.getByRole('button',{name:'⏰ Recordarme',exact:true}).click();assert.match(await edit.textContent(),/Vinculado a: Revisar entrega qa-a/);
  await a.screenshot({path:join(evidence,'editor-mobile.png')});
  await edit.locator('[name=repeat]').selectOption('none');await edit.getByRole('button',{name:'Guardar recordatorio',exact:true}).click();await edit.waitFor({state:'hidden'});
  const linked=[...box.ctx.storage.kv.list({prefix:'reminder:'})].map(([,r])=>r).find(r=>r.status==='scheduled');assert.equal(linked.taskId,70);
  const linkedFireAt=linked.nextAt+1000;Date.now=()=>linkedFireAt;try{await box.alarm();}finally{Date.now=realNow;}
  await a.evaluate(()=>window.DstaReminders.refresh());await a.locator('.reminder-due').getByRole('button',{name:'Atendido',exact:true}).click();await a.waitForFunction(()=>document.querySelectorAll('.reminder-due').length===0);
  assert.equal((await box.snapshot()).tasks[0].done,false,'attending never completes the task');
  // Escape closes only the top dialog and restores focus.
  await a.getByRole('button',{name:'+ Nuevo recordatorio',exact:true}).click();await a.keyboard.press('Escape');assert.equal(await edit.isVisible(),false);assert.equal(await a.locator('#dsta-reminders').isVisible(),true);
  assert.deepEqual(errors,[]);
  writeFileSync(join(evidence,'ui-resultados.json'),JSON.stringify({ok:true,viewports:['1280x900','390x844'],checks:['create','repetition','lost-response receipt','reload','A/B isolation','alarm replay','snooze','edit','cancel','task link','attend preserves task','Escape/focus','mobile overflow'],errors},null,2));
  console.log('Chrome E2E recordatorios: create/recover/repeat/snooze/edit/cancel/attend/task scope and mobile OK');
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));}

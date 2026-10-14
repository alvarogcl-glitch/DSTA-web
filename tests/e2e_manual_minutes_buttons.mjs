// No external services: real Worker/DO over localhost, real Python bridge and Chrome UI.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdtempSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createRequire} from 'node:module';
import {createServer} from 'node:http';
import {spawn,execFileSync} from 'node:child_process';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.DSTA_PLAYWRIGHT_MODULE||'playwright');
const source=readFileSync(new URL('../src/worker.js',import.meta.url),'utf8').replace('import { DurableObject } from "cloudflare:workers";','class DurableObject { constructor(ctx,env){this.ctx=ctx;this.env=env;} }');
const {default:worker,DashboardChatQueue}=await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const root=resolve(new URL('..',import.meta.url).pathname.replace(/^\/([A-Za-z]:)/,'$1'));
const baselineHTML=execFileSync('git',['show','1bd8846:public/index.html'],{cwd:root});
const work=mkdtempSync(join(tmpdir(),'dsta-manual-qa-'));
const screenshots=process.env.DSTA_EVIDENCE_DIR||join(work,'screenshots');mkdirSync(screenshots,{recursive:true});
const users={'qa-a':{id:'qa-a',display_name:'QA A',email:'a@qa.test'},'qa-b':{id:'qa-b',display_name:'QA B',email:'b@qa.test'}};
const tokens={};for(const a of Object.keys(users))tokens[Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(a))).toString('base64url')]=a;
const boxes=new Map();
const env={AUTH_MODE:'accounts',DSTA_BRIDGE_TOKEN:'qa-only',DB:{prepare(sql){return{bind(...args){return{
  async first(){if(sql.includes('FROM sessions'))return users[tokens[args[0]]]||null;if(sql.includes('FROM users'))return users[args[0]]||null;return null;},async run(){return{success:true};},async all(){return{results:[]};}
};}};}},ASSETS:{async fetch(req){let path=new URL(req.url).pathname;if(path==='/')path='/index.html';try{return new Response(path==='/index.html'&&req.headers.get('x-qa-baseline')==='1'?baselineHTML:readFileSync(join(root,'public',path)),{headers:{'content-type':path.endsWith('.html')?'text/html':path.endsWith('.js')?'text/javascript':path.endsWith('.css')?'text/css':'application/json'}});}catch{return new Response('not found',{status:404});}}}};
env.CHAT_STATE={getByName(name){if(!boxes.has(name)){const map=new Map();const kv={get:k=>structuredClone(map.get(k)),put:(k,v)=>map.set(k,structuredClone(v)),delete:k=>map.delete(k),list:({prefix})=>new Map([...map].filter(([k])=>k.startsWith(prefix)))};boxes.set(name,new DashboardChatQueue({id:{name},storage:{kv}},env));}const b=boxes.get(name);return new Proxy(b,{get(t,k){if(k==='fetch')return r=>t.fetch(typeof r==='string'?new Request(r):r);return typeof t[k]==='function'?t[k].bind(t):t[k];}});}};
const snapshots={};for(const a of Object.keys(users))snapshots[a]={timestamp:new Date().toISOString(),projects:[{id:a==='qa-a'?3:4,title:`LT ${a}`,parent_project_id:2}],labels:[{id:7,title:'Etiqueta QA',hex_color:'f6c85f'}],tasks:[{id:a==='qa-a'?63:23,project_id:a==='qa-a'?3:4,project:`LT ${a}`,title:`Entrega ${a}`,done:false,label_ids:[7],description:'Responsable: QA',owner:'QA',date:new Date(Date.now()+3*86400000).toISOString().slice(0,10),dependency:''}]};
writeFileSync(join(work,'vikunja.json'),JSON.stringify(snapshots));
for(const [a,s] of Object.entries(snapshots))await env.CHAT_STATE.getByName('u:'+a).saveSnapshot(s);
const http=createServer(async(req,res)=>{try{const chunks=[];for await(const c of req)chunks.push(c);const body=Buffer.concat(chunks);const response=await worker.fetch(new Request(`http://localhost:${http.address().port}${req.url}`,{method:req.method,headers:req.headers,...(body.length?{body}:{})}),env);res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));}catch(e){res.writeHead(500);res.end(e.message);}});
await new Promise(r=>http.listen(0,'127.0.0.1',r));const base=`http://localhost:${http.address().port}`;

const browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe'});
const errors=[];
async function pageFor(actor){const context=await browser.newContext({viewport:{width:1280,height:900}});await context.addCookies([{name:'__Host-dsta_session',value:actor,url:base.replace('http:','https:'),secure:true,sameSite:'Lax'}]);const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));await page.goto(base+'/');await page.waitForFunction(()=>typeof tasks!=='undefined'&&tasks.length>0);return page;}
const results={};
try{
 const a=await pageFor('qa-a');
 // Every "Generar minuta" button must open the same flow: template + title/date + save/process.
 const check=async(name,open)=>{
   await a.evaluate(()=>document.querySelector('#close')?.click());
   await open();
   await a.locator('#minute-text').waitFor({timeout:10000});
   const ok=await a.locator('.manual-meta').waitFor({timeout:8000}).then(()=>true,()=>false);
   results[name]=ok&&await a.locator('[data-submit]').count()>0;
 };
 await check('portafolio (selección)',async()=>{await a.evaluate(()=>{enterSelectMode('portfolio');toggleSelection('portfolio','3');});await a.locator('#portfolio-minute').click();});
 await check('fechas próximas',async()=>{await a.locator('#upcoming-minute').click();});
 await check('inspector de línea',async()=>{await a.locator('[data-project="3"]').click();await a.locator('#inspector-minute').click();});
 await check('portafolio por etiqueta',async()=>{await a.locator('[data-label-group="7"]').click();await a.locator('#inspector-minute').click();});
 await a.evaluate(async()=>{const cur=(await(await fetch('/api/preferences/layout')).json()).layout;cur.sections.push({id:'c-qa',kind:'custom',title:'Sección QA',enabled:true,filters:{keywords:['Entrega'],fields:['title'],status:'open'}});
   const r=await fetch('/api/preferences/layout',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({layout:cur})});if(!r.ok)throw Error('layout '+r.status);});
 await a.reload();await a.waitForFunction(()=>document.querySelector('[data-custom-section="c-qa"] .dsta-custom-minute'));
 await check('sección personalizada',async()=>{await a.locator('[data-custom-section="c-qa"] .dsta-custom-minute').click();});
 await check('de nuevo portafolio por etiqueta',async()=>{await a.locator('[data-label-group="7"]').click();await a.locator('#inspector-minute').click();});
 // «Minutas»: every stored minute with its origin, filters, detail and jump to the inbox.
 const kv=boxes.get('u:qa-a').ctx.storage.kv;
 kv.put('minute:g-1',{id:'g-1',source:'Granola',sourceId:'g1',digest:'v',titulo:'Comité de dirección',fecha:'2026-10-10',detectadaEn:'2026-10-10T12:00:00Z',resumen:'Se revisó el avance del proyecto y se acordó cerrar la entrega.',acciones:[{id:'a1',tipo:'completar',estado:'propuesta',auto:false,task_id:63,nota:'Entrega cerrada',evidencia:'cerrar la entrega'}],antecedentes:['Contexto del comité'],estado:'procesada',vista:false});
 kv.put('minute-text:g-1','Texto textual de la reunión según Granola.\nAcuerdos: cerrar la entrega.');
 kv.put('minute:g-2',{id:'g-2',source:'Granola',sourceId:'g2',digest:'v',titulo:'Revisión semanal',fecha:'2026-09-28',detectadaEn:'2026-09-28T12:00:00Z',resumen:'Sin acuerdos nuevos.',acciones:[],antecedentes:[],estado:'procesada',vista:true});
 await a.reload();await a.waitForFunction(()=>document.querySelector('#manual-minutes-open'));
 assert.equal(await a.locator('#manual-minutes-open').innerText(),'Minutas');
 await a.locator('#manual-minutes-open').click();await a.locator('.mm-item').first().waitFor();
 const chipText=await a.locator('.mm-chip').allInnerTexts();
 assert.ok(chipText.some(t=>/^Granola · 2$/.test(t)),'Granola minutes are listed with their origin: '+chipText.join('|'));
 assert.ok(chipText.some(t=>/^Manual · \d+$/.test(t)));
 assert.ok(chipText.some(t=>/^Por revisar · 1$/.test(t)));
 if(process.env.SHOT_DIR)await a.screenshot({path:process.env.SHOT_DIR+'/minutas-escritorio.png'});
 await a.locator('.mm-chip',{hasText:'Granola'}).click();
 assert.equal(await a.locator('.mm-item').count(),2);
 await a.locator('.mm-item',{hasText:'Comité de dirección'}).click();
 await a.locator('.mm-detail',{hasText:'Se revisó el avance'}).waitFor();
 await a.locator('.mm-original',{hasText:'Texto textual de la reunión según Granola'}).waitFor();
 results['texto original de Granola en el detalle']=true;
 if(process.env.SHOT_DIR)await a.screenshot({path:process.env.SHOT_DIR+'/minutas-detalle.png'});
 await a.locator('.mm-actions button',{hasText:'Revisar 1 propuesta'}).click();
 await a.locator('#dsta-inbox').waitFor({state:'visible'});
 await a.locator('#dsta-inbox',{hasText:'Entrega cerrada'}).waitFor();
 results['ventana Minutas: origen, filtros, detalle y bandeja']=true;
 // Eliminar: a Granola minute (with confirmation) and a draft; both leave the list.
 await a.locator('#dsta-inbox-close').click();
 await a.locator('#manual-minutes-open').click();await a.locator('.mm-item').first().waitFor();
 await a.locator('.mm-item',{hasText:'Revisión semanal'}).click();
 await a.locator('.mm-actions .mm-danger',{hasText:'Eliminar'}).click();
 await a.locator('.mm-confirm').waitFor();
 await a.locator('.mm-actions .mm-danger',{hasText:'Sí, eliminar'}).click();
 await a.locator('.mm-item',{hasText:'Revisión semanal'}).waitFor({state:'detached'});
 assert.ok((await a.locator('.mm-chip').allInnerTexts()).some(t=>/^Granola · 1$/.test(t)));
 await a.locator('.mm-chip',{hasText:'Todas'}).click();
 const drafts=await a.locator('.mm-item',{hasText:'Borrador'}).count();
 await a.locator('.mm-item',{hasText:'Borrador'}).first().click();
 await a.locator('.mm-editor-del .mm-danger').click();await a.locator('.mm-editor-del .mm-danger',{hasText:'Sí, eliminar'}).click();
 await a.waitForFunction(n=>document.querySelectorAll('.mm-item').length&&[...document.querySelectorAll('.mm-item')].filter(e=>e.textContent.includes('Borrador')).length===n-1,drafts);
 results['eliminar minuta y borrador']=true;
 // The «Minutas» header button is spaced like the others.
 const gap=await a.evaluate(()=>{const m=document.querySelector('#manual-minutes-open').getBoundingClientRect(),r=document.querySelector('#refresh').getBoundingClientRect();return r.left-m.right;});
 assert.ok(gap>=4,'Minutas button is not glued to the next one: '+gap);
 await a.keyboard.press('Escape');
 await a.locator('#dsta-inbox-toggle').click();
 await a.setViewportSize({width:390,height:844});await a.locator('#dsta-inbox-close').click();
 await a.locator('#manual-minutes-open').click();await a.locator('.mm-item').first().waitFor();
 if(process.env.SHOT_DIR)await a.screenshot({path:process.env.SHOT_DIR+'/minutas-movil.png'});
 assert.ok(await a.locator('.manual-dialog').evaluate(e=>e.getBoundingClientRect().width<=390));
 console.log(JSON.stringify(results));
 assert.ok(Object.values(results).every(Boolean),'every Generar minuta opens the manual minutes flow');
 assert.deepEqual(errors,[]);
 console.log('PASS: todos los botones Generar minuta usan el flujo de minutas manuales');
}finally{await browser.close();await new Promise(r=>http.close(r));}

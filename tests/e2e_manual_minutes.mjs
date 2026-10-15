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
const previousInbox=execFileSync('git',['show','37c5734:public/inbox.js'],{cwd:root});
const previousInboxCSS=execFileSync('git',['show','37c5734:public/inbox.css'],{cwd:root});
const work=mkdtempSync(join(tmpdir(),'dsta-manual-qa-'));
const screenshots=process.env.DSTA_EVIDENCE_DIR||join(work,'screenshots');mkdirSync(screenshots,{recursive:true});
const users={'qa-a':{id:'qa-a',display_name:'QA A',email:'a@qa.test'},'qa-b':{id:'qa-b',display_name:'QA B',email:'b@qa.test'}};
const tokens={};for(const a of Object.keys(users))tokens[Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(a))).toString('base64url')]=a;
const boxes=new Map();
const env={AUTH_MODE:'accounts',DSTA_BRIDGE_TOKEN:'qa-only',DB:{prepare(sql){return{bind(...args){return{
  async first(){if(sql.includes('FROM sessions'))return users[tokens[args[0]]]||null;if(sql.includes('FROM users'))return users[args[0]]||null;return null;},async run(){return{success:true};},async all(){return{results:[]};}
};}};}},ASSETS:{async fetch(req){let path=new URL(req.url).pathname;if(path==='/')path='/index.html';try{return new Response(path==='/index.html'&&req.headers.get('x-qa-baseline')==='1'?baselineHTML:readFileSync(join(root,'public',path)),{headers:{'content-type':path.endsWith('.html')?'text/html':path.endsWith('.js')?'text/javascript':path.endsWith('.css')?'text/css':'application/json'}});}catch{return new Response('not found',{status:404});}}}};
env.CHAT_STATE={getByName(name){if(!boxes.has(name)){const map=new Map();const kv={get:k=>structuredClone(map.get(k)),put:(k,v)=>map.set(k,structuredClone(v)),delete:k=>map.delete(k),list:({prefix})=>new Map([...map].filter(([k])=>k.startsWith(prefix)))};boxes.set(name,new DashboardChatQueue({id:{name},storage:{kv}},env));}const b=boxes.get(name);return new Proxy(b,{get(t,k){if(k==='fetch')return r=>t.fetch(typeof r==='string'?new Request(r):r);return typeof t[k]==='function'?t[k].bind(t):t[k];}});}};
const snapshots={};for(const a of Object.keys(users))snapshots[a]={timestamp:new Date().toISOString(),projects:[{id:a==='qa-a'?3:4,title:`LT ${a}`,parent_project_id:2}],labels:[],tasks:[{id:a==='qa-a'?63:23,project_id:a==='qa-a'?3:4,project:`LT ${a}`,title:`Entrega ${a}`,done:false,label_ids:[],description:'Responsable: QA',owner:'QA',date:'',dependency:''}]};
writeFileSync(join(work,'vikunja.json'),JSON.stringify(snapshots));
for(const [a,s] of Object.entries(snapshots))await env.CHAT_STATE.getByName('u:'+a).saveSnapshot(s);
const http=createServer(async(req,res)=>{try{const chunks=[];for await(const c of req)chunks.push(c);const body=Buffer.concat(chunks);const response=await worker.fetch(new Request(`http://localhost:${http.address().port}${req.url}`,{method:req.method,headers:req.headers,...(body.length?{body}:{})}),env);res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));}catch(e){res.writeHead(500);res.end(e.message);}});
await new Promise(r=>http.listen(0,'127.0.0.1',r));const base=`http://localhost:${http.address().port}`;
const bridge=spawn(process.env.DSTA_PYTHON||'python',[join(root,'tests/manual_bridge_fixture.py'),base,work],{cwd:root,env:{...process.env,PYTHONUTF8:'1'},stdio:['ignore','pipe','pipe']});let bridgeLog='';bridge.stdout.on('data',d=>bridgeLog+=d);bridge.stderr.on('data',d=>bridgeLog+=d);
const browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe'});
const errors=[];
async function pageFor(actor,manual=true,previous=false){const context=await browser.newContext({viewport:{width:1280,height:900},permissions:['clipboard-read','clipboard-write'],extraHTTPHeaders:manual?{}:{'x-qa-baseline':'1'}});await context.addCookies([{name:'__Host-dsta_session',value:actor,url:base.replace('http:','https:'),secure:true,sameSite:'Lax'}]);const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept());if(previous){await page.route('**/inbox.js',route=>route.fulfill({contentType:'text/javascript',body:previousInbox}));await page.route('**/inbox.css',route=>route.fulfill({contentType:'text/css',body:previousInboxCSS}));}await page.goto(base);await page.locator(manual?'#manual-minutes-open':'#rows tr').waitFor();return page;}
try{
 const before=await pageFor('qa-a',false);await before.locator('[data-project="3"]').click();await before.locator('#inspector-minute').click();await before.screenshot({path:join(screenshots,'template-before-desktop.png')});await before.setViewportSize({width:390,height:844});await before.screenshot({path:join(screenshots,'template-before-mobile.png')});await before.context().close();
 const a=await pageFor('qa-a'),b=await pageFor('qa-b');
 await a.locator('[data-project="3"]').click({modifiers:['Shift']});
 // The existing inspector generation uses exactly the same task text.
 await a.locator('#inspector-minute').click();await a.locator('.manual-meta').waitFor();
 assert.match(await a.locator('#minute-text').inputValue(),/#63 Entrega qa-a/);
 await a.locator('[data-title]').fill('Minuta QA');
 await a.locator('#minute-text').fill('Portafolio\nAcuerdo: entrega completada.\nCrear seguimiento QA.');
 await a.locator('.manual-tools button').filter({hasText:'Negrita'}).click();
 await a.locator('[data-preview]').click();assert.equal(await a.locator('.manual-preview strong').count(),1);
 await a.locator('[data-save]').click();await a.locator('.manual-status').filter({hasText:'guardado en tu cuenta'}).waitFor();
 const encrypted=await a.evaluate(()=>Object.values(localStorage).join(''));assert.ok(!encrypted.includes('Acuerdo:')&&!encrypted.includes('Minuta QA'),'local recovery is encrypted');
 await a.locator('#copy-minute').click();assert.ok((await a.evaluate(()=>navigator.clipboard.readText())).includes('Acuerdo:'));
 await a.screenshot({path:join(screenshots,'editor-desktop.png')});
 await a.reload();await a.locator('#manual-minutes-open').click();await a.locator('.manual-list button').filter({hasText:'Minuta QA'}).first().click();
 assert.ok((await a.locator('dialog textarea').inputValue()).includes('Acuerdo:'),'recovered draft after reload');
 // Recover an unsent edit after an HTTP failure and a reload.
 let offline=true;await a.route('**/api/manual-minutes',route=>route.request().method()==='POST'&&offline?route.abort():route.continue());
 await a.locator('dialog textarea').fill('Portafolio\nAcuerdo: entrega completada.\nRecuperación sin conexión QA.');
 await a.locator('[data-save]').click();await a.waitForTimeout(200);offline=false;
 await a.reload();await a.locator('#manual-minutes-open').click();await a.locator('.manual-list button').filter({hasText:'Minuta QA'}).first().click();
 assert.match(await a.locator('dialog textarea').inputValue(),/Recuperación sin conexión QA/);
 await a.locator('[data-save]').click();await a.locator('.manual-status').filter({hasText:'guardado en tu cuenta'}).waitFor();
 await a.setViewportSize({width:390,height:844});await a.locator('.manual-dialog').evaluate(e=>e.scrollTop=0);await a.screenshot({path:join(screenshots,'editor-mobile.png')});
 assert.ok(await a.locator('.manual-dialog').evaluate(e=>e.getBoundingClientRect().width<=390));
 await a.locator('.manual-buttons [data-submit]').click();await a.locator('.manual-status').filter({hasText:/En cola|Procesando|Procesada/}).waitFor();await a.locator('.manual-dialog [data-close]').click();
 await a.waitForFunction(async()=>{const d=await(await fetch('/api/minutes')).json();return d.minutes.length===1;},null,{timeout:20000});await a.locator('#dsta-inbox-toggle').click();await a.locator('#dsta-inbox').getByText('Minuta QA',{exact:false}).first().waitFor({timeout:20000});
 await b.locator('#manual-minutes-open').click();assert.equal(await b.locator('.manual-list button').count(),0);
 assert.equal(snapshots['qa-a'].tasks[0].done,false);
 const records=[...boxes.get('u:qa-a').ctx.storage.kv.list({prefix:'minute:'}).values()];assert.equal(records.length,1);assert.ok(records[0].acciones.every(x=>x.estado==='propuesta'&&!x.auto));
 const state=JSON.parse(readFileSync(join(work,'vikunja.json')));assert.equal(state['qa-a'].tasks[0].done,false,'no automatic changes');assert.equal(state['qa-a'].tasks.length,1);
 const previous=await pageFor('qa-a',true,true);await previous.locator('#dsta-inbox-toggle').click();await previous.locator(`[data-open="${records[0].id}"]`).click();
 await previous.screenshot({path:join(screenshots,'review-before-desktop.png')});await previous.setViewportSize({width:390,height:844});await previous.screenshot({path:join(screenshots,'review-before-mobile.png')});await previous.context().close();
 // Approve through the existing browser endpoint: the real Python decision engine writes then publishes.
 await a.locator(`[data-open="${records[0].id}"]`).click();
 await a.setViewportSize({width:1280,height:900});await a.screenshot({path:join(screenshots,'review-top-desktop.png')});
 await a.setViewportSize({width:390,height:844});await a.screenshot({path:join(screenshots,'review-top-mobile.png')});
 const first=a.locator('.dsta-inbox-action').nth(0),second=a.locator('.dsta-inbox-action').nth(1),third=a.locator('.dsta-inbox-action').nth(2);
 assert.equal(await first.locator('input[type=radio]').count(),3);
 assert.equal(await first.locator('textarea').isVisible(),false);
 await first.locator('[value="instruccion"]').check();await first.locator('textarea').fill('NO DEBE ENVIARSE');
 await first.locator('[value="aprobar"]').check();assert.equal(await first.locator('textarea').isVisible(),false);
 await second.locator('[value="instruccion"]').check();await second.locator('textarea').fill('Cambiar título a Seguimiento QA ajustado');
 await third.locator('[value="rechazar"]').check();
 await a.locator('.dsta-inbox-other summary').click();
 assert.match(await a.locator('.dsta-inbox-other').innerText(),/Presupuesto tratado/);
 await a.locator('.dsta-inbox-other textarea').fill('Registrar presupuesto validado QA en la tarea existente');
 assert.equal(await a.locator(`#dsta-inbox [data-submit="${records[0].id}"]`).innerText(),'Enviar (4)');
 await a.setViewportSize({width:1280,height:900});
 await a.screenshot({path:join(screenshots,'review-desktop.png')});
 await a.setViewportSize({width:390,height:844});
 await a.screenshot({path:join(screenshots,'inbox-mobile.png')});
 assert.ok(await a.locator('#dsta-inbox').evaluate(e=>e.scrollWidth<=e.clientWidth),'no mobile horizontal overflow');
 await a.locator(`#dsta-inbox [data-submit="${records[0].id}"]`).click();

 const deadline=Date.now()+20000;while(true){const ok=await a.evaluate(async()=>{const d=await(await fetch('/api/dashboard')).json();return d.tasks.some(t=>t.id===63&&t.done)&&d.tasks.some(t=>t.id===200);});if(ok)break;if(Date.now()>deadline)throw Error('Approved changes missing from snapshot');await new Promise(r=>setTimeout(r,100));}
 const final=JSON.parse(readFileSync(join(work,'vikunja.json')));assert.equal(final['qa-b'].tasks.length,1);assert.ok(final['qa-a'].tasks.find(t=>t.id===200).description.includes('manual-dashboard-manual-'));
 assert.equal(final['qa-a'].tasks.find(t=>t.id===200).title,'Seguimiento QA ajustado');
 // Snapshot completion can precede the instruction at the end of the batch.
 await a.waitForFunction(async()=>{const d=await(await fetch('/api/dashboard')).json();return d.tasks.some(t=>t.id===63&&t.description.includes('Presupuesto validado QA'));},null,{timeout:20000});
 const reviewed=JSON.parse(readFileSync(join(work,'vikunja.json')));
 assert.equal(reviewed['qa-a'].tasks.length,2);assert.equal(reviewed['qa-a'].tasks[0].description.split('Presupuesto validado QA').length-1,1);
 // Storage failure still permits an explicit, confirmed cloud save.
 await b.locator('[data-new]').click();await b.locator('.manual-dialog [data-title]').fill('B sin almacenamiento local');
 await b.evaluate(()=>{Storage.prototype.setItem=()=>{throw new DOMException('QA quota failure','QuotaExceededError');};});
 await b.locator('.manual-dialog textarea').fill('Notas propias de B');await b.locator('.manual-dialog [data-save]').click();
 await b.locator('.manual-status').filter({hasText:'guardado en tu cuenta'}).waitFor();
 assert.equal([...boxes.get('u:qa-b').ctx.storage.kv.list({prefix:'manual:'}).values()][0].content,'Notas propias de B');
 assert.deepEqual(errors,[]);console.log('PASS: template/copy, format, durable reload, encrypted offline recovery, desktop/mobile, account isolation, manual -> existing engine -> inbox -> human approval -> snapshot; no external writes');console.log('Evidence: '+screenshots);
}catch(e){console.error('Bridge diagnostics: '+bridgeLog);console.error(JSON.stringify([...boxes.get('u:qa-a').ctx.storage.kv.list({prefix:'manual:'}).values()]));throw e;}finally{bridge.kill();await browser.close();await new Promise(r=>http.close(r));}

// Integration test: local Wrangler only, synthetic data, simulated VM handoff.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
const {chromium}=createRequire(import.meta.url)('playwright');
const base=process.env.DSTA_BROWSER_BASE || 'http://127.0.0.1:8787';
assert.ok(['127.0.0.1','localhost'].includes(new URL(base).hostname),'Never run fixtures against production');
const values={};for(const line of readFileSync(new URL('../.dev.vars',import.meta.url),'utf8').split('\n')) {
 if(line.trim()&&!line.startsWith('#')&&line.includes('=')){const i=line.indexOf('=');values[line.slice(0,i).trim()]=line.slice(i+1).trim().replace(/^["']|["']$/g,'');}
}
const auth='Basic '+Buffer.from(values.DASHBOARD_USER+':'+values.DASHBOARD_PASSWORD).toString('base64');
const snapshot={timestamp:new Date().toISOString(),projects:[{id:3,title:'LT1 · Prueba local'}],
 labels:[{id:1,title:'Carrera tecnológica',hex_color:'86e2bb'},{id:2,title:'Seguimiento',hex_color:'8bbcff'},{id:3,title:'Antigua',hex_color:'f5a9cf'}],
 tasks:[{id:15,title:'Primera tarea',project_id:3,project:'LT1 · Prueba local',done:false,owner:'Ana',date:'',dependency:'',description:'SOURCE: local\nACTION_KEY: local',label_ids:[1]},
 {id:16,title:'Segunda tarea',project_id:3,project:'LT1 · Prueba local',done:false,owner:'Luis',date:'',dependency:'',description:'',label_ids:[2]},
 {id:17,title:'Sin clasificar',project_id:3,project:'LT1 · Prueba local',done:false,owner:'Ana',date:'',dependency:'',description:'',label_ids:[]}]};
async function call(path,body,token=values.DSTA_BRIDGE_TOKEN){
 const response=await fetch(base+path,{method:body?'POST':'GET',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:body?JSON.stringify(body):undefined});
 const result=await response.json();assert.ok(response.ok,JSON.stringify(result));return result;
}
async function publish(extra={}){
 snapshot.observationStartedAt=new Date().toISOString();snapshot.timestamp=snapshot.observationStartedAt;
 await call('/api/bridge/snapshot',{...snapshot,...extra});
}
await publish();
let stop=false,bridgeError;
const bridge=(async()=>{while(!stop){
 try{
  const {job}=await call('/api/bridge/next?kind=label');
  if(job){
   let labelId=job.labelId;
   const task=snapshot.tasks.find(t=>t.id===job.taskId);
   if(job.action==='create'){labelId=Math.max(...snapshot.labels.map(l=>l.id))+1;snapshot.labels.push({id:labelId,title:job.title,hex_color:job.color});if(task)task.label_ids.push(labelId);}
   if(job.action==='update'){Object.assign(snapshot.labels.find(l=>l.id===labelId),{title:job.title,hex_color:job.color});}
   if(job.action==='assign'&&!task.label_ids.includes(labelId))task.label_ids.push(labelId);
   if(job.action==='unassign')task.label_ids=task.label_ids.filter(id=>id!==labelId);
   if(['delete','reset'].includes(job.action)){
    const remove=job.action==='reset'?job.targets.map(l=>l.id):[labelId];snapshot.labels=snapshot.labels.filter(l=>!remove.includes(l.id));snapshot.tasks.forEach(t=>{t.label_ids=t.label_ids.filter(id=>!remove.includes(id));});
   }
   await publish({labelConfirmation:{id:job.id,attempt:job.attempt,result:{labelId}}});
   await call('/api/bridge/complete',{kind:'label',id:job.id,attempt:job.attempt,snapshotTimestamp:snapshot.timestamp});
  }
 }catch(error){bridgeError=error;stop=true;}
 await new Promise(r=>setTimeout(r,100));
}})();
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',headless:true,args:['--no-sandbox']});
const context=await browser.newContext({httpCredentials:{username:values.DASHBOARD_USER,password:values.DASHBOARD_PASSWORD}});
const page=await context.newPage();const errors=[];page.on('pageerror',error=>errors.push(error.message));
try {
 await page.goto(base);await page.waitForFunction(()=>window.DstaLabels&&document.querySelector('#rows').children.length===3);
 assert.equal(await page.locator('#label-groups .label-group').count(),4);
 const c=await page.locator('#rows .label-chip').first().evaluate(el=>getComputedStyle(el).backgroundColor);assert.equal(c,'rgb(134, 226, 187)');
 await page.locator('#label-filter [role=combobox]').click();
 await page.locator('#label-filter [data-label-id="1"]').click();assert.equal(await page.locator('#rows tr').count(),1);
 await page.locator('#label-filter [data-label-id="2"]').click();assert.equal(await page.locator('#rows tr').count(),2,'multi-select uses OR semantics');
 await page.locator('#label-filter input').press('Escape');
 await page.locator('#label-filter .label-clear').click();assert.equal(await page.locator('#rows tr').count(),3);
 await page.locator('#q').fill('Ana');await page.locator('#s').selectOption('open');assert.equal(await page.locator('#rows tr').count(),2);
 await page.locator('#q').fill('');await page.locator('#s').selectOption('');
 await page.locator('#rows [data-task="15"]').click();
 await page.locator('.task-labels [role=combobox]').click();await page.locator('.task-labels [data-label-id="2"]').click();
 await page.waitForFunction(()=>document.querySelector('.label-notice').textContent.startsWith('Etiquetas actualizadas.'));
 assert.equal(await page.locator('.task-label-chips .label-chip').count(),2);
 await page.locator('.task-labels [role=combobox]').click(); // close dropdown retained through refresh
 await page.locator('.task-labels [data-remove-label="2"]').click();
 await page.waitForFunction(()=>document.querySelector('.task-label-chips').children.length===1&&!sessionStorage.getItem('dsta-label-pending-v1'));
 await page.locator('.task-labels [role=combobox]').click();await page.locator('.task-labels .label-search').fill('Innovación');
 await page.locator('.task-labels .label-create-option').click();
 assert.equal(await page.locator('.label-palette [role=radio]').count(),10);assert.equal(await page.locator('input[type=color]').count(),0);
 await page.locator('[data-color="f6c85f"]').click();await page.locator('dialog form button[type=submit]').click();
 await page.waitForFunction(()=>document.querySelector('.task-label-chips').textContent.includes('Innovación')&&!sessionStorage.getItem('dsta-label-pending-v1'));
 await page.locator('#close').click();await page.locator('#customize-labels').click();
 await page.locator('[data-edit-label="4"]').click();await page.locator('dialog form input[name=title]').fill('Innovación aplicada');
 await page.locator('[data-color="c6a0f6"]').click();await page.locator('dialog form button[type=submit]').click();
 await page.waitForFunction(()=>document.querySelector('#label-manager-list').textContent.includes('Innovación aplicada')&&!sessionStorage.getItem('dsta-label-pending-v1'));
 assert.equal(await page.locator('[data-delete-label="1"]').isDisabled(),true);
 await page.locator('#reset-labels').click();await page.locator('[data-confirm]').click();
 await page.waitForFunction(()=>document.querySelectorAll('#label-manager-list .label-manager-row').length===1&&!sessionStorage.getItem('dsta-label-pending-v1'));
 assert.deepEqual(snapshot.labels.map(l=>l.title),['Carrera tecnológica']);
 await page.locator('#label-manager-title').locator('..').locator('[data-close]').click();
 await page.setViewportSize({width:390,height:844});await page.evaluate(()=>window.scrollTo(0,document.getElementById('label-section').offsetTop));
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'mobile page has no horizontal overflow');
 await page.screenshot({path:'/workspace/scratch/dsta-labels-mobile.png',fullPage:true});
 await page.setViewportSize({width:1440,height:1000});await page.screenshot({path:'/workspace/scratch/dsta-labels-desktop.png',fullPage:true});
 assert.deepEqual(errors,[]);if(bridgeError)throw bridgeError;
 console.log('PASS: real local Worker + browser; multi-filter, grouping, filled chips, assign/remove, inline creation, rename, palette, protected cleanup and mobile layout');
} finally {stop=true;await bridge;await browser.close();}

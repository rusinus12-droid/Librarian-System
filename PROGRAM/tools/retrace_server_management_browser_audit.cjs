'use strict';
// Actual Chromium GUI, deployed Flashback owner, loopback HTTP and SQLite.
// Host/IPC and seed data are synthetic. Models and external network are forbidden.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
process.umask(0o077);
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const root=path.resolve(__dirname,'..');
const {createMemorySuiteServer}=require(root+'/server/server.cjs');
const {createFixture}=require(root+'/tests/fixtures/flashback_native_runtime_fixture.cjs');
const out=process.env.AUDIT_OUT?path.resolve(process.env.AUDIT_OUT):fs.mkdtempSync(path.join(os.tmpdir(),'retrace-server-browser-'));
fs.mkdirSync(out,{recursive:true,mode:0o700});
const relative=path.relative(fs.realpathSync(path.resolve(root,'..')),fs.realpathSync(out));
if(!relative||(!relative.startsWith('..'+path.sep)&&!path.isAbsolute(relative)))throw Error('audit_output_must_be_outside_repository');
const source=process.env.RETRACE_SOURCE_FILE||root+'/plugins/RETRACE.js';
const cases=[],http=[],errors=[];let app,fixture,browser;
const check=(label,condition)=>{cases.push({label,passed:!!condition});assert.ok(condition,label);};
const hostSetup=({base,pluginRows,localRows})=>{
  const store=rows=>{const values=new Map(rows);return {values,async getItem(k){return values.get(String(k))??null;},async setItem(k,v){values.set(String(k),v);return true;},async removeItem(k){values.delete(String(k));return true;},async keys(){return [...values.keys()];}};};
  const chats=['active-a','active-b'].map((id,i)=>({id,chatId:id,name:['항구 마을 이야기','북쪽 탑 원정'][i],message:[],messages:[]}));
  const char={id:'management-character',chaId:'management-character',name:'Management audit',chatPage:0,chats};
  const callbacks=new Map(),channels=new Map(),unloads=[],args=new Map(Object.entries({memory_suite_server_mode:'plugin_only',memory_suite_server_url:base,enable_gui:'false',hook_recall_timeout_ms:'1000'}));
  const host={pluginStorage:store(pluginRows),safeLocalStorage:store(localRows),calls:{models:0},callbacks,
    async getLocalPluginStorage(){return host.safeLocalStorage;},async getArgument(k){return args.get(k)||'';},async getArg(k){return host.getArgument(k);},async setArgument(k,v){args.set(k,String(v));return true;},
    async getDatabase(fields){const db={characters:[char],personas:[],selectedPersona:'',plugins:[]};return fields?Object.fromEntries(fields.map(k=>[k,db[k]??null])):db;},async setDatabase(){throw Error('host database writes forbidden');},
    async getCurrentCharacterIndex(){return 0;},async getCurrentChatIndex(){return 0;},async getCharacter(){return char;},async getCharacterFromIndex(){return char;},async getChat(){return chats[0];},async getCurrentChat(){return chats[0];},async getChatFromIndex(c,i){return chats[i??c]||chats[0];},
    async getRootDocument(){return document;},async getRootContainer(){return document.body;},async getPluginRoot(){return document.body;},async showContainer(){return true;},async hideContainer(){return true;},
    async nativeFetch(url,init={}){const data=await window.__auditHttp({url:String(url),init:{method:init.method||'GET',headers:[...new Headers(init.headers).entries()],body:init.body==null?null:String(init.body)}});return new Response(Uint8Array.from(data.body),{status:data.status,headers:data.headers});},
    async getRuntimeInfo(){return {apiVersion:'3.0',platform:'web',saveMethod:'local'};},async runLLMModel(){host.calls.models++;throw Error('model forbidden');},async runEmbedding(){host.calls.models++;throw Error('embedding forbidden');},
    async registerSetting(n,cb,i,t,id){callbacks.set(id,cb);return{id};},async registerButton(o,cb){callbacks.set(o.id,cb);return{id:o.id};},async unregisterUIPart(id){callbacks.delete(id);return true;},
    async onUnload(cb){unloads.push(cb);return true;},async addPluginChannelListener(c,cb){const set=channels.get(c)||new Set();set.add(cb);channels.set(c,set);return{channel:c,handler:cb};},async removePluginChannelListener(c,cb){channels.get(c)?.delete(cb);return true;},
    async postPluginChannelMessage(_peer,c,m){const sender=c==='flashback_memory_bridge_response_v1'?'flashback_memory':'flashback_hayaku_bridge';for(const cb of [...(channels.get(c)||[])])await cb(m,{sender});return channels.has(c);}
  };
  for(const m of ['registerBodyIntercepter','unregisterBodyIntercepter','addRisuReplacer','removeRisuReplacer','addRisuChatListener','removeRisuChatListener','addRisuScriptHandler','removeRisuScriptHandler','unregisterSetting','unregisterButton'])host[m]=async()=>true;
  window.__auditHost=host;window.__auditDispose=async()=>{for(const cb of [...unloads].reverse())await cb();};
  window.risuai=window.Risuai=window.RisuAI=host;window.confirm=()=>false;window.prompt=()=>null;window.alert=()=>{};
};
const dialog=async(page,id,accept=true)=>{
  const layer=page.locator(id);await layer.waitFor({state:'visible'});
  const typed=layer.locator('[data-dialog-typed-input]');
  if(accept&&await typed.isVisible()){const label=id==='#dlg-del'?'정리':id==='#dlg-reset'?'초기화':'복원';await typed.fill(label);}
  await layer.locator(accept?'[data-dialog-confirm]':'[data-dialog-cancel]').click();
};
async function waitIdle(page){await page.waitForFunction(()=>!document.querySelector('#flashback-hayaku-bridge-root')?.getAttribute('aria-busy')||document.querySelector('#flashback-hayaku-bridge-root').getAttribute('aria-busy')==='false');}
(async()=>{
 try{
  const dataDir=fs.mkdtempSync(path.join(out,'DATA-'));
  app=createMemorySuiteServer({host:'127.0.0.1',port:0,dataDir,autoBackup:false,computeEnabled:false});const base='http://127.0.0.1:'+(await app.listen()).port;
  fixture=await createFixture({exposeStorageBridge:true,characterId:'management-character',arguments:{memory_suite_server_url:base},nativeFetch:(u,i)=>{assert.equal(new URL(String(u)).origin,base,'seed transport stays on loopback');return fetch(u,i);}});
  const bridge=fixture.context.__fixtureStorageBridge,t=fixture.api._test,scopes=[];
  for(const [index,chatId] of ['active-a','active-b','lost-chat'].entries()){
    Object.assign(fixture.currentChat,{id:chatId,chatId,name:['항구 마을 이야기','북쪽 탑 원정','지워진 채팅'][index],message:[],messages:[]});
    const scope=(await t.resolveCurrentScopeIdentityBundle(false)).scope;const config=await bridge.getConnectionSettings({force:true});await bridge.setScopeMode(config.scope,'server_only');
    await t.saveAllRecords([{id:'m-'+chatId,hash:'m-'+chatId,type:'response',sourceType:'response',text:'Preserved memory '+chatId,dim:4,vector:[1,0,0,0],turnIndex:1,sourceTurn:1,lifecycleStatus:'active'}],null,scope);
    scopes.push(scope);
  }
  await fixture.context.__fixtureStorageBridge.whenFlashbackWritersIdle();
  await new Promise(resolve=>setTimeout(resolve,1000));
  const pluginRows=[...fixture.pluginStorage.values],localRows=[...fixture.host.safeLocalStorage.values];await fixture.dispose();fixture=null;
  browser=await chromium.launch({...(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:fs.existsSync('/usr/bin/chromium')?{executablePath:'/usr/bin/chromium'}:{}),headless:true,args:['--no-sandbox']});const page=await browser.newPage({viewport:{width:1280,height:920}});
  page.on('pageerror',e=>errors.push(e.message));await page.route('**/*',route=>route.request().url()===base+'/__audit'?route.fulfill({contentType:'text/html',body:'<!doctype html><meta charset="utf-8"><body></body>'}):route.abort());
  await page.exposeFunction('__auditHttp',async({url,init})=>{assert.equal(new URL(url).origin,base);const response=await fetch(url,{method:init.method,headers:init.headers,...(init.body==null?{}:{body:init.body})});http.push({path:new URL(url).pathname,status:response.status});return{status:response.status,headers:[...response.headers.entries()],body:[...new Uint8Array(await response.arrayBuffer())]};});
  await page.goto(base+'/__audit');await page.evaluate(hostSetup,{base,pluginRows,localRows});
  await page.addScriptTag({path:root+'/plugins/Flashback_Memory.js'});await page.waitForFunction(()=>!!globalThis.__FlashbackMemory);
  await page.addScriptTag({path:source});await page.waitForFunction(()=>!!globalThis.__auditHost.callbacks.get('retrace-main-hamburger'));
  // Verify normal management after owner startup has settled. Concurrent
  // reappearance is a separate negative readback case, never a success bypass.
  await page.waitForTimeout(2000);
  await page.evaluate(()=>globalThis.__auditHost.callbacks.get('retrace-main-hamburger')());
  await page.locator('#tab-serverdata').click();await page.waitForFunction(()=>document.querySelector('#serverControlDetails')?.textContent.includes('DATA 식별자'));
  await page.locator('.tabs [data-server-page="data"]').click();
  await page.waitForFunction(()=>document.querySelectorAll('#serverDataBody .scope-card').length===3);
  check('three real server scopes discovered',await page.locator('#serverDataBody .scope-card').count()===3);
  check('server navigation count refreshed',await page.locator('#serverNavCount').textContent()==='3');
  check('active scope bulk checkboxes disabled',await page.locator('[data-scope-status="active"] [data-server-scope-select]:disabled').count()===2);
  await page.locator('[data-server-scope-select-all]').click();
  check('bulk selection only orphan',await page.locator('#serverDataBody input:checked').count()===1 && await page.locator('[data-scope-status="active"] input:checked').count()===0);
  await page.locator('[data-server-scope-select-clear]').click();
  let orphan=page.locator('[data-scope-status="orphan_candidate"] .scope-card');
  await orphan.locator('[data-server-scope-pin]').click();await dialog(page,'#retraceDialogLayer');
  check('pinned scope cannot be deleted',await orphan.locator('[data-server-scope-delete]').isDisabled());
  await orphan.locator('[data-server-scope-pin]').click();await dialog(page,'#retraceDialogLayer');
  await page.screenshot({path:path.join(out,'scopes-before-delete.png')});
  await orphan.locator('[data-server-scope-delete]').click();await dialog(page,'#dlg-del');
  await page.waitForFunction(()=>document.querySelector('#job-del [data-job-hide]')?.textContent==='결과 닫기');
  await page.screenshot({path:path.join(out,'delete-result.png')});
  fs.writeFileSync(path.join(out,'delete-result.json'),JSON.stringify(await page.evaluate(()=>({job:document.querySelector('#job-del')?.textContent,status:document.querySelector('#serverScopeDeleteStatus')?.textContent,scopes:document.querySelector('#serverDataBody')?.textContent})),null,2),{mode:0o600});
  check('verified deletion finishes four phases',await page.locator('#job-del .step.is-done').count()===4);
  check('server navigation count after deletion',await page.locator('#serverNavCount').textContent()==='2');
  const orphanKey='vector_rag_memory:scope:'+fixtureHash(scopes[2].scopeKey)+':manifest:v2';
  check('actual server deletion committed',app.repositories.flashback.get('plugin',orphanKey).tombstone===true);
  const local=await page.evaluate(async key=>{const row=await __auditHost.pluginStorage.getItem(key);return typeof row==='string'?JSON.parse(row):row;},orphanKey);
  check('owner local source preserved',local?.scopeKey===scopes[2].scopeKey);
  await page.screenshot({path:path.join(out,'delete-completed.png')});await page.locator('#job-del [data-job-hide]').click();
  const canaryKey='hayaku.v2.ledger.browser-restore-canary';
  app.repositories.hayaku.mutate({kind:'set',space:'plugin',key:canaryKey,value:{schema:'fixture-namespace-record.v1',text:'original backup bytes'},expectedRevision:0,operationId:'browser_audit_seed_canary_0001'});
  await page.locator('.tabs [data-server-page="backups"]').click();await page.locator('[data-server-control="backup-create"]').click();
  await page.waitForFunction(()=>document.querySelector('#job-backup [data-job-hide]')?.textContent==='결과 닫기');
  check('backup phases verified',await page.locator('#job-backup .step.is-done').count()===3);
  check('backup ISO date visible',!/마지막 -|미확인/.test(await page.locator('#bk-badge').textContent()));
  await page.screenshot({path:path.join(out,'backup-completed.png')});await page.locator('#job-backup [data-job-hide]').click();
  const backupId=await page.locator('#serverControlBackups').inputValue();check('created backup selected',!!backupId);
  check('physical backup checked',await page.locator('#serverControlBackupCards').textContent().then(s=>s.includes('검사 완료')));
  const activeKey='vector_rag_memory:scope:'+fixtureHash(scopes[0].scopeKey)+':manifest:v2';const before=app.repositories.hayaku.get('plugin',canaryKey);
  const value={...before.value,managementAudit:'later value'};app.repositories.hayaku.mutate({kind:'set',space:'plugin',key:canaryKey,value,expectedRevision:before.revision,operationId:'browser_audit_mutate_0001'});
  await page.locator('[data-control-namespace][value="hayaku"]').check();
  await page.locator('[data-server-control="restore-plan"]').click();await page.locator('#serverControlPreview').getByText('미리본 복원 범위',{exact:true}).waitFor();
  await page.locator('[data-server-control="restore-execute"]').click();await dialog(page,'#dlg-restore',false);
  check('cancelled restore leaves real bytes',app.repositories.hayaku.get('plugin',canaryKey).value.managementAudit==='later value');
  await page.locator('[data-server-control="restore-execute"]').click();await dialog(page,'#dlg-restore');
  await page.waitForFunction(()=>document.querySelector('#job-restore [data-job-hide]')?.textContent==='결과 닫기');
  check('confirmed restore finishes phases',await page.locator('#job-restore .step.is-done').count()===3);
  check('actual SQLite restore',JSON.stringify(app.repositories.hayaku.get('plugin',canaryKey).value)===JSON.stringify(before.value));
  await page.screenshot({path:path.join(out,'restore-completed.png')});await page.locator('#job-restore [data-job-hide]').click();
  const downloaded=page.waitForEvent('download');await page.locator('[data-portable-action="export"]').click();
  const download=await downloaded;const zipPath=path.join(out,'verified-migration.zip');await download.saveAs(zipPath);
  await page.waitForFunction(()=>document.querySelector('#job-backup [data-job-hide]')?.textContent==='결과 닫기');
  check('ZIP export checksum phases verified',await page.locator('#job-backup .step.is-done').count()===3);
  check('ZIP download saved',fs.statSync(zipPath).size>22);await page.locator('#job-backup [data-job-hide]').click();
  await page.locator('#portableBackupCard details summary').click();await page.locator('#portableBackupFile').setInputFiles(zipPath);
  await page.locator('[data-portable-action="upload"]').click();await page.waitForFunction(()=>document.querySelector('#job-backup [data-job-hide]')?.textContent==='결과 닫기');
  check('ZIP upload integrity phases verified',await page.locator('#job-backup .step.is-done').count()===3);
  check('ZIP restore preview visible',await page.locator('#portableRestorePreview').isVisible());await page.locator('#job-backup [data-job-hide]').click();
  await page.locator('[data-portable-action="restore"]').click();await dialog(page,'#dlg-restore');
  await page.waitForFunction(()=>document.querySelector('#job-restore [data-job-hide]')?.textContent==='결과 닫기');
  check('ZIP full restore phases verified',await page.locator('#job-restore .step.is-done').count()===3);
  check('ZIP full restore physical data',app.repositories.flashback.get('plugin',activeKey).exists===true && app.repositories.hayaku.get('plugin',canaryKey).value.text==='original backup bytes');
  await page.screenshot({path:path.join(out,'zip-restore-completed.png')});await page.locator('#job-restore [data-job-hide]').click();
  await page.locator('.tabs [data-server-page="connection"]').click();await page.locator('[data-server-control="diagnose"]').click();await page.waitForFunction(()=>document.querySelectorAll('#serverControlDiagnosis .check-item.ok').length===2);
  check('connection and management diagnosis verified',await page.locator('#serverControlDiagnosis .check-item.ok').count()===2);
  await page.locator('.tabs [data-server-page="history"]').click();await page.waitForFunction(()=>document.querySelector('#serverControlHistory')?.textContent.includes('복원'));
  check('history displays real completed operations',(await page.locator('#serverControlHistory').textContent()).includes('완료'));
  await page.locator('.tabs [data-server-page="overview"]').click();
  check('owner contact matched',(await page.locator('#serverControlPlugins').textContent()).includes('마지막 접촉 20'));
  await page.screenshot({path:path.join(out,'server-overview.png')});
  await page.setViewportSize({width:390,height:844});
  check('mobile has no horizontal overflow',await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.screenshot({path:path.join(out,'mobile-overview.png')});await page.setViewportSize({width:1280,height:920});
  await page.locator('.tabs [data-server-page="backups"]').click();await page.locator('#serverResetTarget').selectOption('flashback');await page.locator('#serverResetBegin').click();await dialog(page,'#dlg-reset');
  await page.waitForFunction(()=>document.querySelector('#job-reset [data-job-hide]')?.textContent==='결과 닫기');
  check('reset phases verified',await page.locator('#job-reset .step.is-done').count()===4);
  check('actual namespace empty',app.repositories.flashback.get('plugin',activeKey).exists===false);
  check('no model calls',await page.evaluate(()=>__auditHost.calls.models)===0);
  check('no browser exceptions',errors.length===0);
  await page.screenshot({path:path.join(out,'reset-completed.png')});
  fs.writeFileSync(path.join(out,'RESULTS.json'),JSON.stringify({source,cases,http,errors},null,2),{mode:0o600});console.log(JSON.stringify({out,cases,httpRequests:http.length,errors}));
 }finally{await browser?.close();await fixture?.dispose();await app?.close();}
})().catch(e=>{fs.writeFileSync(path.join(out,'FAILURE.json'),JSON.stringify({message:e.message,stack:e.stack,cases,http,errors},null,2),{mode:0o600});console.error(e);process.exitCode=1;});
function fixtureHash(s){let h=2166136261;for(let i=0;i<s.length;i++){h^=s.charCodeAt(i);h=Math.imul(h,16777619);}return(h>>>0).toString(36);}

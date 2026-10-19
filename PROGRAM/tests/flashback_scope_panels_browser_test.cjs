'use strict';
// Real Flashback source + real Chromium DOM/event handlers. The RisuAI host
// storage/API boundary is supplied; no replacement UI or cleanup code is used.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http'),assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const {resolveChromeExecutable}=require('./fixtures/browser_resolver.cjs');
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const out=process.env.MEMORY_PATCH_BROWSER_OUTPUT||path.join(os.tmpdir(),'flashback-scope-panels-evidence');fs.mkdirSync(out,{recursive:true});
const profile=fs.mkdtempSync(path.join(os.tmpdir(),'flashback-browser-'));
// Chromium's singleton Unix socket must fit sun_path even when evidence TMPDIR is long.
const socketTmp=fs.mkdtempSync(path.join(process.platform==='win32'?os.tmpdir():'/tmp','fb-chrome-'));
const stderrFile=path.join(out,'chromium.stderr.log'),stderrFd=fs.openSync(stderrFile,'a');
const child=spawn(resolveChromeExecutable(),['--headless=new','--no-sandbox','--disable-gpu','--no-first-run','--disable-dev-shm-usage','--remote-debugging-port=0','--user-data-dir='+profile,'about:blank'],{env:{...process.env,TMPDIR:socketTmp,XDG_CONFIG_HOME:path.join(profile,'config'),XDG_CACHE_HOME:path.join(profile,'cache')},stdio:['ignore','ignore',stderrFd]});
fs.closeSync(stderrFd);
let childExit;child.on('error',error=>{childExit={error:error.message};});child.on('exit',(code,signal)=>{childExit={code,signal};});
let ws,referenceServer;const watchdog=setTimeout(()=>{child.kill('SIGKILL');console.error('Flashback browser timeout');process.exit(1);},90000);
(async()=>{
 let port;for(let n=0;n<100;n++){try{port=fs.readFileSync(path.join(profile,'DevToolsActivePort'),'utf8').split('\n')[0];break;}catch{}if(childExit)break;await pause(100);}assert.ok(port,'Chromium starts: '+JSON.stringify(childExit||{})+'; stderr='+stderrFile);
 const pages=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json();ws=new WebSocket(pages.find(x=>x.type==='page').webSocketDebuggerUrl);await new Promise(r=>ws.addEventListener('open',r,{once:true}));
 let seq=0;const pending=new Map();ws.addEventListener('message',e=>{const m=JSON.parse(e.data);if(m.id){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(m.error):p.resolve(m.result);}});
 const call=(method,params={})=>new Promise((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}));});
 const ev=async expression=>{const r=await call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw new Error(JSON.stringify(r.exceptionDetails));return r.result.value;};
 const wait=async(expression)=>{for(let i=0;i<160;i++){if(await ev(expression))return;await pause(50);}throw new Error('Condition not reached: '+expression);};
 await call('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false});
 await ev(`window.hostWrites=0;window.hostMessages=[];window.unloads=[];
 const makeStore=()=>{const m=new Map();return {m,getItem:async k=>m.get(String(k))??null,setItem:async(k,v)=>{hostWrites++;m.set(String(k),v);return true;},removeItem:async k=>{hostWrites++;m.delete(String(k));return true;},keys:async()=>[...m.keys()]};};
 window.pluginStore=makeStore();window.localStore=makeStore();window.chat={id:'active',chatId:'active',name:'현재 채팅',message:[],messages:[]};window.character={id:'actor',chaId:'actor',name:'류지현',chats:[chat]};
 const argumentsMap=new Map([['memory_suite_server_mode','plugin_only'],['enable_gui','false'],['embedding_provider','hash']]);
 window.risuai={pluginStorage:pluginStore,safeLocalStorage:localStore,getLocalPluginStorage:async()=>localStore,getArgument:async n=>argumentsMap.get(n)||'',getArg:async n=>argumentsMap.get(n)||'',setArgument:async(k,v)=>{argumentsMap.set(k,String(v));return true;},getCurrentCharacterIndex:async()=>0,getCurrentChatIndex:async()=>0,getCharacter:async()=>character,getCharacterFromIndex:async()=>character,getChat:async()=>chat,getCurrentChat:async()=>chat,getChatFromIndex:async()=>chat,getDatabase:async fields=>{const db={characters:[character],personas:[],selectedPersona:'',plugins:[]};return Array.isArray(fields)?Object.fromEntries(fields.map(k=>[k,db[k]??null])):db;},setDatabase:async()=>true,nativeFetch:async()=>{throw new Error('Network not used in DOM test');},onUnload:async fn=>{unloads.push(fn);return true;},getRootContainer:async()=>null,getPluginRoot:async()=>null,showContainer:async()=>true,hideContainer:async()=>true};
 for(const name of ['addPluginChannelListener','removePluginChannelListener','removePluginChannelHandler','offPluginChannelMessage','postPluginChannelMessage','registerSetting','registerButton','unregisterSetting','unregisterButton','unregisterUIPart','addRisuReplacer','removeRisuReplacer','addRisuScriptHandler','removeRisuScriptHandler','addRisuChatListener','removeRisuChatListener']) risuai[name]=async()=>true;`);
 const rawSource=fs.readFileSync(process.env.FLASHBACK_GUI_SOURCE||path.join(__dirname,'../plugins/Flashback_Memory.js'),'utf8');
 console.log('sourceSha256 '+require('node:crypto').createHash('sha256').update(rawSource).digest('hex'));
 assert.equal(rawSource.split('    const notice = async (title, body, danger = false)').length,2,'one portable-mode test boundary');
 const source=rawSource.replace('_test: { maintenanceResultText,','_test: { Runtime, buildUiHtml, mountGuiRoot, rememberScope, readRegistry, scopeKeys, maintenanceResultText, inspectMemoryMaintenance, renderMaintenancePlanInUi, maintenancePlanText,').replace('    const notice = async (title, body, danger = false)','    globalThis.__flashbackPortableModeForBrowser = restoreModeModal;\n    const notice = async (title, body, danger = false)');
 await ev(source);await wait('!!window.__FlashbackMemory?._test');
 await ev(`(async()=>{window.fb=__FlashbackMemory;window.t=fb._test;t.Runtime.nativeCopyObserver.running=false;
 window.activeScope=(await t.resolveCurrentScopeIdentityBundle(false)).scope;
 await t.saveAllRecords([{id:'memory-1',hash:'memory-1',title:'Alpha memory',type:'response',sourceType:'response',text:'안전하게 보존할 기억 Alpha memory',dim:4,vector:[1,0,0,0]},{id:'memory-2',hash:'memory-2',title:'Beta memory',type:'response',sourceType:'response',text:'안전하게 보존할 기억 Beta memory',dim:4,vector:[0,1,0,0]}],null,activeScope);
 for(const scopeKey of ['unused-1','unused-2'])await t.rememberScope({scopeKey,chatTitle:scopeKey});
 await fb.showUi();})()`);
 await wait('!!document.querySelector("[data-page=lab]")');
 await ev(`document.documentElement.style.width='100vw';document.body.style.width='100vw';document.body.style.minHeight='100vh'`);
 const snap=async name=>{const bounds=await ev(`(()=>{const r=document.querySelector('.app').getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}})()`);const r=await call('Page.captureScreenshot',{format:'png',clip:{...bounds,scale:1}});fs.writeFileSync(path.join(out,name+'.png'),Buffer.from(r.data,'base64'));};
 const productShell = new Map();
 const navHeaderChecks=[];
 for(const viewport of [{name:'desktop',width:1280,height:900},{name:'tablet',width:900,height:1024},{name:'boundary901',width:901,height:900},{name:'tablet820',width:820,height:900},{name:'boundary641',width:641,height:900},{name:'compact',width:640,height:900},{name:'mobile',width:390,height:844}]){
  await call('Emulation.setDeviceMetricsOverride',{width:viewport.width,height:viewport.height,deviceScaleFactor:1,mobile:false});
  productShell.set(viewport.name, await ev(`(()=>{const r=document.querySelector('.app').getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,background:getComputedStyle(document.querySelector('#vector-rag-memory-root')).backgroundColor}})()`));
  for(const route of ['lab','vault','care','connect','log','settings']){
   await ev(`document.querySelector('[data-go="${route}"]').click()`);
   await wait(`document.querySelector('[data-page="${route}"]').classList.contains('is-active')`);
   const layout=await ev(`(()=>{const f=document.querySelector('.frame'),a=document.querySelector('.app');return {frameWidth:f.getBoundingClientRect().width,appWidth:a.clientWidth,scrollWidth:a.scrollWidth,route:document.querySelector('.page.is-active')?.dataset.page}})()`);
   assert.equal(layout.route,route,`${viewport.name}: ${route} route selected`);
   if(route==='lab'){
    await pause(200);
    const chrome=await ev(`(()=>{const bar=document.querySelector('.tabbar'),h=document.querySelector('.topbar'),brand=h.querySelector('.brand'),name=h.querySelector('.brand__name'),ver=h.querySelector('.brand__ver'),health=h.querySelector('#sidebarHealth'),menu=h.querySelector('#topMoreBtn');const r=n=>{const b=n.getBoundingClientRect();return {left:b.left,right:b.right,top:b.top,bottom:b.bottom,width:b.width,height:b.height}};const hr=r(h),br=r(brand),nr=r(name),vr=r(ver),sr=r(health),mr=r(menu);return {buttons:[...bar.children].map(n=>({text:n.textContent.trim(),go:n.dataset.go||null,more:n.dataset.more||null,icon:n.querySelector('use')?.getAttribute('href')})),sheet:!!document.querySelector('#sheet-more [data-more-list]'),sheetRows:[...document.querySelectorAll('#sheet-more [data-more-list]>button')].map(n=>({go:n.dataset.go,title:n.querySelector('.row__title')?.textContent,icon:n.querySelector('use')?.getAttribute('href'),arrow:n.querySelector('svg.faint use')?.getAttribute('href')})),bottomHit:getComputedStyle(bar).display==='none'||[...bar.children].every(n=>{const b=r(n),hit=document.elementFromPoint((b.left+b.right)/2,(b.top+b.bottom)/2);return !!hit&&n.contains(hit)}),healthClass:health.className,healthText:health.textContent,headerInside:nr.top>=hr.top&&vr.bottom<=hr.bottom&&br.right<=sr.left+1&&sr.right<=mr.left+1,header:{hr,br,nr,vr,sr,mr},hit:[name,health,menu].every(n=>{const b=r(n),hit=document.elementFromPoint((b.left+b.right)/2,(b.top+b.bottom)/2);return !!hit&&(n.contains(hit)||hit.contains(n))})}})()`);
    navHeaderChecks.push({viewport:viewport.name,...chrome});
    assert.ok(await ev(`!document.querySelector('.topbar .sidebar-health,.topbar .badge-on,.topbar .badge-off,[data-page="lab"] .type-row,[data-page="lab"] .row__body')`),viewport.name+': no old header or Lab hydration HTML/classes');
    assert.ok(await ev(`(()=>{const p=document.querySelector('#lastRecallPanel');return !!p.querySelector('.lab .lab__q')&&!!p.querySelector('.frames')&&!!p.querySelector('.film')&&!!p.querySelector('.fold')})()`),viewport.name+': empty current frame preserves original dark Lab, frame grid, film and diagnostic fold');
    assert.ok(await ev(`(()=>{const d=document.querySelector('#miniCounts'),a=document.querySelector('#overviewActivityList');return [...d.children].every(n=>['DT','DD'].includes(n.tagName))&&a.tagName==='DL'&&[...a.children].every(n=>['DT','DD'].includes(n.tagName))})()`),viewport.name+': hydrated Lab distribution/activity preserve original kv dt/dd structure');

   }

   assert.ok(layout.appWidth>0 && layout.scrollWidth<=layout.appWidth+1,`${viewport.name}: ${route} overflow ${layout.scrollWidth}/${layout.appWidth}`);
   if(route==='care'&&viewport.name==='desktop'){
    const status=await ev(`(()=>{const b=document.querySelector('#fbReanalysisRefresh');if(!b)return 'missing refresh control';b.click();return document.querySelector('#fbSourceEditStatus')?.textContent||''})()`);
    assert.equal(status,'구간을 읽는 중…','care route wires the original selected-source reanalysis refresh action');
    const planState=await ev(`(()=>{const plan={liveTurns:14,storedTurns:11,missingTurns:3,changedTurns:1,staleStoredTurns:2,dirtyRecords:1,externalRecords:0,sanitizerVersionMismatch:0,narrativeChunkSchemaVersion:3,liveChunkSchemaMismatch:0,inheritedChunkSchemaMismatch:0,shardIndexVersion:8,shardIndexExpectedVersion:8,shardIndexMismatch:false,storageManifestCorrupt:false,storageArchiveRefInvalid:false,storageMissingShards:1,storageCorruptShards:0,storageRecordCountMismatch:false,storageForeignScopeKey:false,missingShardIndexes:[2],expectedPermanentHistory:7,readablePermanentHistory:7,unrecoverablePermanentHistory:0,recordsNeedingEmbedding:2,localRecordsNeedingEmbedding:2,archiveRecordsNeedingEmbedding:0,providerMismatch:0,embeddingCredentialRequired:false,episodeStale:false,automatic:{blocked:false},estimatedReusableVectors:9,estimatedEmbeddingChunks:2,estimatedEmbeddingTokens:4800,embeddingCost:'provider tariff',healthy:false};t.renderMaintenancePlanInUi(plan);return JSON.stringify({grid:document.querySelectorAll('#maintenancePlan>.plan-grid>div').length,table:!!document.querySelector('#maintenancePlan>.cost-table'),oldCards:document.querySelectorAll('#maintenancePlan>.card').length,missing:document.querySelector('#maintenancePlan .plan-grid')?.textContent.includes('3턴'),damage:document.querySelector('#maintenancePlan .plan-grid')?.textContent.includes('1'),tokens:document.querySelector('#maintenancePlan .plan-grid')?.textContent.includes('4,800'),detail:document.querySelector('#maintenancePlan .cost-table')?.textContent.includes('누락 3'),call:document.querySelector('#maintenancePlan .cost-table')?.textContent.includes('새 임베딩 2개')})})()`);
    assert.deepEqual(JSON.parse(planState),{grid:8,table:true,oldCards:0,missing:true,damage:true,tokens:true,detail:true,call:true},'maintenance plan uses original eight-cell grid and cost-table hierarchy with current variable data and full detail');
   }
   if(route==='settings'&&viewport.name==='desktop'){
    assert.ok(await ev(`(()=>{const b=document.querySelector('[data-recall-quality-preset="balanced"]');return b.querySelector('span')?.textContent==='Top 12 · 권장'&&b.querySelector('small')?.textContent==='기본값'&&document.querySelector('[data-recall-quality-preset="light"] span')?.textContent==='Top 6 · 빠름'&&document.querySelector('[data-recall-quality-preset="heavy"] span')?.textContent==='Top 20 · 느림'})()`),'preset choices retain the canonical descriptions while reflecting actual product Top K');
    const arg=await ev(`(()=>{const b=document.querySelector('button[data-toggle-arg-setting-group][aria-expanded="false"]');if(!b)return 'missing collapsed ARG group';const panel=document.getElementById(b.getAttribute('aria-controls'));b.click();return JSON.stringify({expanded:b.getAttribute('aria-expanded'),hidden:panel?.hidden})})()`);
    assert.deepEqual(JSON.parse(arg),{expanded:'true',hidden:false},'ARG group toggle expands its original group panel');
    const light=await ev(`(()=>{const b=document.querySelector('[data-recall-quality-preset="light"]');b.click();return JSON.stringify({pressed:b.getAttribute('aria-pressed'),selected:b.classList.contains('is-on')})})()`);
    assert.deepEqual(JSON.parse(light),{pressed:'true',selected:true},'preset click updates visible selection to actual Light value');
    const balanced=await ev(`(()=>{const b=document.querySelector('[data-recall-quality-preset="balanced"]');b.click();return JSON.stringify({pressed:b.getAttribute('aria-pressed'),selected:b.classList.contains('is-on'),light:document.querySelector('[data-recall-quality-preset="light"]').classList.contains('is-on')})})()`);
    assert.deepEqual(JSON.parse(balanced),{pressed:'true',selected:true,light:false},'preset selection has one canonical visual state');
    await ev(`document.querySelector('#saveAdvancedSettingsBtn').click()`);
    await wait(`document.querySelector('#saveAdvancedSettingsBtn')?.disabled===false && document.querySelector('[data-recall-quality-preset="balanced"]')?.classList.contains('is-on')`);
    await ev(`document.querySelector('[data-go="lab"]').click();document.querySelector('[data-go="settings"]').click()`);
    await wait(`document.querySelector('[data-recall-quality-preset="balanced"]')?.getAttribute('aria-pressed')==='true'`);
    assert.ok(await ev(`document.querySelector('[data-recall-quality-preset="balanced"]')?.classList.contains('is-on')`),'saved preset readback and reopened UI retain the selected styling');
   }
   if(route==='vault'||route==='connect'||route==='log'){
    const group={vault:'v',connect:'c',log:'l'}[route];
    const firstExists=await ev(`!!document.querySelector('[data-subtab][data-group="${group}"]')`);
    assert.ok(firstExists,`${route} detail tabs are present`);
    const details={vault:['resp','wl','scopes'],connect:['emb','mig','srv'],log:['a','b','c']}[route];
    for(const [index,detail] of details.entries()){
     await ev(`document.querySelector('[data-subtab="${detail}"][data-group="${group}"]').click()`);
     await wait(`document.querySelector('[data-subtab="${detail}"][data-group="${group}"]').getAttribute('aria-selected')==='true'`);
     assert.ok(await ev(`document.querySelector('[data-subpanel="${detail}"][data-group="${group}"]').classList.contains('is-active')`),`${route}/${detail} detail destination works`);
     if(route==='vault'&&detail==='resp'&&viewport.name==='desktop'){
      await wait(`!!document.querySelector('#manualEditorPanel [data-manual-editor]')`);
      const readback=await ev(`({count:document.querySelectorAll('#manualEditorPanel [data-manual-record-key]').length,empty:document.querySelector('#manualEditorPanel')?.innerText?.slice(0,180)})`);
      assert.equal(readback.count,2,`synthetic response records read back in the manual editor: ${JSON.stringify(readback)}`);
     }
     if(route==='connect'&&detail==='mig'&&viewport.name==='desktop'){
      const mig=await ev(`(()=>{const root=document.querySelector('[data-subpanel="mig"][data-group="c"]>.stack');return JSON.stringify({cards:root?.children.length,headings:[...root.querySelectorAll(':scope>.card .card__title')].map(x=>x.textContent.trim()),preview:!!root?.querySelector('#sameSpacePreviewBtn'),probe:!!root?.querySelector('#multilingualProbeBtn'),applyUnderFirst:!!root?.querySelector(':scope>.card:first-child #sameSpaceApplyBtn'),probeUnderSecond:!!root?.querySelector(':scope>.card:nth-child(2) #multilingualProbeBtn'),desc:root?.querySelector(':scope>.card:first-child .card__desc')?.textContent||''})})()`);
      const state=JSON.parse(mig);assert.equal(state.cards,2);assert.deepEqual(state.headings,['같은 공간 이전 미리보기','다국어 리콜 검증']);assert.ok(state.preview&&state.probe&&state.applyUnderFirst&&state.probeUnderSecond);assert.match(state.desc,/벡터 원본 보존 · API 호출 0/);
      await ev(`document.querySelector('#sameSpacePreviewBtn').click()`);
      await wait(`!!t.Runtime.sameSpacePreview`);
      const counts=await ev(`({eligible:document.querySelector('#sameSpaceEligibleCount').textContent,unknown:document.querySelector('#sameSpaceUnknownCount').textContent,rows:t.Runtime.sameSpacePreview.rows.length,unverified:t.Runtime.sameSpacePreview.unknown.length})`);
      assert.equal(counts.eligible,counts.rows.toLocaleString());assert.equal(counts.unknown,counts.unverified.toLocaleString()+' (등록부·생성 이력 검증 불일치)','read-only preview refreshes table from the actual result');
     }
     if(index===0) await snap(`${viewport.name}-product-${route}`);
     else if(viewport.name==='desktop') await snap(`${viewport.name}-product-${route}-${detail}`);
    }
   }
   else await snap(`${viewport.name}-product-${route}`);
  }
 }
 assert.ok(await ev(`document.querySelectorAll('#storageRows').length===1`),'real scope list mount exists');
 assert.ok(await ev(`document.querySelectorAll('[data-portable-backup-host="flashback_memory"]').length===1`),'portable backup host remains connected');
 await ev(`document.querySelector('[data-go="care"]').click()`);
 await wait(`!!document.querySelector('[data-portable-backup]')`);
 await ev(`window.portableOpener=document.querySelector('[data-portable-backup]');portableOpener.focus();portableOpener.click()`);
 await wait(`!!document.querySelector('[data-portable-backup-modal="flashback_memory"]')`);
 assert.ok(await ev(`(()=>{const overlay=document.querySelector('[data-portable-backup-modal="flashback_memory"]'),buttons=[...overlay.querySelectorAll('button')];buttons[0].focus();buttons[0].dispatchEvent(new KeyboardEvent('keydown',{key:'Tab',shiftKey:true,bubbles:true,cancelable:true}));if(document.activeElement!==buttons.at(-1))return false;buttons.at(-1).dispatchEvent(new KeyboardEvent('keydown',{key:'Tab',bubbles:true,cancelable:true}));return document.activeElement===buttons[0]})()`),'portable backup modal contains forward/reverse keyboard focus');
 await ev(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}))`);
 assert.ok(await ev(`!document.querySelector('[data-portable-backup-modal="flashback_memory"]')&&document.activeElement===window.portableOpener`),'Escape declines backup without starting it and returns focus');
 await ev(`window.portableOpener.focus();void (window.portableChoicePromise=__flashbackPortableModeForBrowser({payload:{source:{characterName:'Synthetic actor',chatTitle:'Synthetic scope'},records:[]},target:{scope:{characterName:'Synthetic actor',chatTitle:'Synthetic scope'},empty:true},transcriptMatches:true,modes:{same_chat_replace:{allowed:true,reason:'same_chat_verified'},chat_migration_archive:{allowed:false,reason:'same_chat_use_replace'},chat_copy_rebind:{allowed:false,reason:'same_chat_use_replace'}}}))`);
 assert.ok(await ev(`(()=>{const overlay=document.querySelector('[data-portable-restore-mode-modal="flashback_memory"]'),buttons=[...overlay.querySelectorAll('button')].filter(button=>!button.disabled);if(buttons.length<2)return false;buttons[0].focus();buttons[0].dispatchEvent(new KeyboardEvent('keydown',{key:'Tab',shiftKey:true,bubbles:true,cancelable:true}));if(document.activeElement!==buttons.at(-1))return false;buttons.at(-1).dispatchEvent(new KeyboardEvent('keydown',{key:'Tab',bubbles:true,cancelable:true}));return document.activeElement===buttons[0]})()`),'actual restore-choice UI traps keyboard focus while skipping blocked modes');
 await ev(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}))`);
 assert.equal(await ev(`window.portableChoicePromise`),'','Escape returns the existing empty decline value without restore');
 assert.ok(await ev(`document.activeElement===window.portableOpener`),'restore-choice decline returns focus to opener');
 const productLabels=await ev(`({healthText:document.querySelector('#sidebarHealth')?.textContent||'',healthClass:document.querySelector('#sidebarHealth')?.className||'',model:document.querySelector('#foot-model')?.textContent||'',meta:document.querySelector('#foot-meta')?.textContent||'',scope:document.querySelector('#currentScopeText')?.textContent||'',chat:document.querySelector('#currentChatText')?.textContent||'',log:document.querySelector('#nav-log-n')?.textContent||'0',scopeCount:document.querySelector('#nav-scope-n')?.textContent||'0',mode:document.querySelector('#topModeBadge')?.textContent||'ON',provider:document.querySelector('#embeddingProvider')?.value||'',embeddingModel:document.querySelector('#embeddingModel')?.value||'',url:document.querySelector('#embeddingUrl')?.value||'',keyPlaceholder:document.querySelector('#embeddingKey')?.placeholder||''})`);
 await ev(`document.querySelector('[data-go="log"]').click();document.querySelector('[data-subtab="a"][data-group="l"]').click();window.lastActionNode=document.querySelector('#lastActionLog');window.lastActionNode.textContent='synthetic last-action detail';document.querySelector('#clearActivityLogBtn').click()`);
 const cleared=await ev(`JSON.stringify({records:t.Runtime.activityLog.length,nav:document.querySelector('#nav-log-n')?.textContent,tab:document.querySelector('#tab-log-n')?.textContent,detailNode:document.querySelector('#lastActionLog')===window.lastActionNode,detail:document.querySelector('#lastActionLog')?.textContent})`);
 assert.deepEqual(JSON.parse(cleared),{records:0,nav:'0',tab:'0',detailNode:true,detail:'synthetic last-action detail'},'clear empties session records, synchronizes mockup counters and preserves last-action detail component');
 await ev(`t.pushActivityLog('synthetic-log','Synthetic log row',{fixture:true},'info')`);
 const pushed=await ev(`JSON.stringify({records:t.Runtime.activityLog.length,nav:document.querySelector('#nav-log-n')?.textContent,tab:document.querySelector('#tab-log-n')?.textContent,rows:document.querySelectorAll('#activityLogList article').length,text:document.querySelector('#activityLogList')?.textContent,detailNode:document.querySelector('#lastActionLog')===window.lastActionNode,detail:document.querySelector('#lastActionLog')?.textContent})`);
 const pushedState=JSON.parse(pushed);assert.equal(pushedState.records,1);assert.equal(pushedState.nav,'1');assert.equal(pushedState.tab,'1');assert.equal(pushedState.rows,1);assert.match(pushedState.text,/Synthetic log row/);assert.equal(pushedState.detailNode,true);assert.equal(pushedState.detail,'synthetic last-action detail');
 await ev(`document.querySelector('[data-subtab="b"][data-group="l"]').click();document.querySelector('[data-subtab="a"][data-group="l"]').click()`);
 assert.ok(await ev(`document.querySelector('#activityLogList article')?.textContent.includes('Synthetic log row')`),'activity row remains after switching to and from swallowed-errors subtab');
 await ev(`document.querySelector('#clearActivityLogBtn').click()`);
 assert.ok(await ev(`t.Runtime.activityLog.length===0&&document.querySelector('#nav-log-n')?.textContent==='0'&&document.querySelector('#tab-log-n')?.textContent==='0'&&document.querySelector('#lastActionLog')===window.lastActionNode`),'second clear/readback remains consistent');
 fs.writeFileSync(path.join(out,'bottom-header-checks.json'),JSON.stringify(navHeaderChecks,null,2));
 for(const check of navHeaderChecks){
  assert.deepEqual(check.buttons,[{text:'현상실',go:'lab',more:null,icon:'#i-eye'},{text:'보관함',go:'vault',more:null,icon:'#i-film'},{text:'관리',go:'care',more:null,icon:'#i-wrench'},{text:'연결',go:'connect',more:null,icon:'#i-link'},{text:'더보기',go:null,more:'1',icon:'#i-more'}],check.viewport+': literal four primary tabs plus More');
  assert.ok(check.sheet,check.viewport+': canonical More sheet exists');
  assert.deepEqual(check.sheetRows,[{go:'log',title:'현상 기록',icon:'#i-log',arrow:'#i-arrow'},{go:'settings',title:'리콜 설정',icon:'#i-sliders',arrow:'#i-arrow'}],check.viewport+': exact canonical More rows/icons');
  assert.ok(check.bottomHit,check.viewport+': visible bottom controls are unobstructed hit targets');
  assert.match(check.healthClass,/^health health--/,check.viewport+': hydration preserves canonical health component');
  assert.ok(check.headerInside&&check.hit,check.viewport+': product name/version/status/menu remain visible without overlap: '+JSON.stringify(check.header));
 }
 for(const width of [820,390]){
  await call('Emulation.setDeviceMetricsOverride',{width,height:844,deviceScaleFactor:1,mobile:false});
  for(const route of ['lab','vault','care','connect']){
   const point=await ev(`(()=>{const b=document.querySelector('.tabbar [data-go="${route}"]').getBoundingClientRect();return {x:b.x+b.width/2,y:b.y+b.height/2}})()`);
   await call('Input.dispatchMouseEvent',{type:'mousePressed',...point,button:'left',clickCount:1});await call('Input.dispatchMouseEvent',{type:'mouseReleased',...point,button:'left',clickCount:1});
   await wait(`document.querySelector('[data-page="${route}"]').classList.contains('is-active')`);
   assert.equal(await ev(`document.querySelector('.tabbar [data-go="${route}"]').getAttribute('aria-current')`),'page',width+': actual bottom pointer action selects '+route);
  }
 }
 await call('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:false});
 await ev(`document.querySelector('.tabbar [data-more]').focus();document.querySelector('.tabbar [data-more]').click()`);
 await wait(`document.querySelector('#sheet-more').classList.contains('is-open')`);
 assert.ok(await ev(`(()=>{const s=document.querySelector('#sheet-more'),b=[...s.querySelectorAll('button')];b[0].focus();b[0].dispatchEvent(new KeyboardEvent('keydown',{key:'Tab',shiftKey:true,bubbles:true,cancelable:true}));if(document.activeElement!==b.at(-1))return false;b.at(-1).dispatchEvent(new KeyboardEvent('keydown',{key:'Tab',bubbles:true,cancelable:true}));return document.activeElement===b[0]})()`),'More contains keyboard focus');
 await ev(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}))`);
 assert.ok(await ev(`!document.querySelector('#sheet-more').classList.contains('is-open')&&document.activeElement===document.querySelector('.tabbar [data-more]')`),'More Escape closes without action and returns focus');
 for(const route of ['log','settings']){await ev(`document.querySelector('.tabbar [data-more]').click();document.querySelector('#sheet-more [data-go="${route}"]').click()`);await wait(`document.querySelector('[data-page="${route}"]').classList.contains('is-active')`);assert.ok(await ev(`!document.querySelector('#sheet-more').classList.contains('is-open')`),'More route closes sheet '+route);}
 await ev(`document.querySelector('.tabbar [data-go="vault"]').click();document.querySelector('[data-subtab="wl"][data-group="v"]').click();document.querySelector('#panel-worldline [data-open-manual-editor="response"]').click()`);
 await wait(`document.querySelector('[data-subpanel="resp"][data-group="v"]').classList.contains('is-active')`);
 assert.ok(await ev(`!document.querySelector('[data-subpanel="wl"][data-group="v"]').classList.contains('is-active')`),'actual worldline source action reveals response editor');
 await ev('Promise.all(unloads.map(fn=>fn()))');
 // Capture the original mockup at the same viewport sizes and route states.
 // Only the screenshot reference page loads suite.js; product execution above
 // uses the actual Flashback source and never imports mockup behavior.
 const mockupRoot=path.resolve(__dirname,'../docs/gui-redesign');
 referenceServer=http.createServer((req,res)=>{const relative=decodeURIComponent(new URL(req.url,'http://localhost').pathname).replace(/^\/+/, '');const file=path.resolve(mockupRoot,relative||'flashback.html');if(!file.startsWith(mockupRoot+path.sep)&&file!==path.join(mockupRoot,'flashback.html')){res.writeHead(403).end();return;}try{const ext=path.extname(file);res.setHeader('content-type',ext==='.css'?'text/css':ext==='.js'?'text/javascript':'text/html');res.end(fs.readFileSync(file));}catch{res.writeHead(404).end();}});
 await new Promise((resolve,reject)=>{referenceServer.once('error',reject);referenceServer.listen(0,'127.0.0.1',resolve);});
 const mockup=`http://127.0.0.1:${referenceServer.address().port}/flashback.html`;
 await call('Page.navigate',{url:mockup});
 await wait('!!document.querySelector(".app") && !!document.querySelector("[data-page=lab]")');
 await ev(`document.documentElement.style.width='100vw';document.body.style.width='100vw';document.body.style.minHeight='100vh';document.querySelector('.proto-bar')?.remove();
 const scope=document.querySelector('.scope');if(scope){const parts=scope.querySelectorAll('b,span');if(parts[0])parts[0].textContent=${JSON.stringify(productLabels.scope)};if(parts[2])parts[2].textContent=${JSON.stringify(productLabels.chat)};const badge=scope.querySelector('.badge');if(badge)badge.textContent=${JSON.stringify(productLabels.mode)};}
 const count=document.querySelector('#nav-scope-n');if(count)count.textContent=${JSON.stringify(productLabels.scopeCount)};const tabCount=document.querySelector('#tab-scope-n');if(tabCount)tabCount.textContent=${JSON.stringify(productLabels.scopeCount)};const log=document.querySelector('#nav-log-n');if(log)log.textContent=${JSON.stringify(productLabels.log)};const footModel=document.querySelector('#foot-model');if(footModel)footModel.textContent=${JSON.stringify(productLabels.model)};const footMeta=document.querySelector('#foot-meta');if(footMeta)footMeta.textContent=${JSON.stringify(productLabels.meta)};const health=document.querySelector('.health');if(health){health.textContent=${JSON.stringify(productLabels.healthText)};health.className=${JSON.stringify(productLabels.healthClass)};}
 const provider=document.querySelector('#emb-provider');if(provider){let opt=[...provider.options].find(item=>item.value===${JSON.stringify(productLabels.provider)});if(!opt){opt=document.createElement('option');opt.value=${JSON.stringify(productLabels.provider)};opt.textContent=${JSON.stringify(productLabels.provider)};provider.add(opt);}provider.value=${JSON.stringify(productLabels.provider)};}
 const model=document.querySelector('#emb-model');if(model)model.value=${JSON.stringify(productLabels.embeddingModel)};const url=document.querySelector('#emb-url');if(url)url.value=${JSON.stringify(productLabels.url)};const key=document.querySelector('#emb-key');if(key)key.placeholder=${JSON.stringify(productLabels.keyPlaceholder)};
 const category=document.querySelector('[data-detail-root-list]');if(category){const rows=[...category.querySelectorAll('[data-select-row]')];rows.slice(1).forEach(row=>row.remove());if(rows[0]){const icon=rows[0].querySelector('.row__icon');if(icon)icon.textContent='2';const title=rows[0].querySelector('.row__title');if(title)title.textContent='응답 턴';}}
 const records=[...document.querySelectorAll('[data-detail="a"] article')];for(const [index,title] of ['Alpha memory','Beta memory'].entries()){const card=records[index];if(!card)continue;const heading=card.querySelector('.split b');if(heading)heading.textContent=title;const summary=card.querySelector('p');if(summary)summary.textContent='안전하게 보존할 기억 '+title;const badge=card.querySelector('.split .badge');if(badge){badge.textContent=index===0?'활성 기록 · 24자':'활성 기록 · 23자';badge.className='badge';}const buttons=card.querySelectorAll('button');if(buttons[1]){buttons[1].disabled=false;buttons[1].textContent='삭제 후보에 추가';buttons[1].classList.add('btn--danger');}}
 const stale=document.querySelector('[data-detail="a"]');if(stale)stale.querySelectorAll('.why-d').forEach(note=>note.remove());`);
 for(const viewport of [{name:'desktop',width:1280,height:900},{name:'tablet',width:900,height:1024},{name:'boundary901',width:901,height:900},{name:'tablet820',width:820,height:900},{name:'boundary641',width:641,height:900},{name:'compact',width:640,height:900},{name:'mobile',width:390,height:844}]){
  await call('Emulation.setDeviceMetricsOverride',{width:viewport.width,height:viewport.height,deviceScaleFactor:1,mobile:false});
  const actualShell=productShell.get(viewport.name);
  // The current window is centered over a transparent host canvas. The older
  // standalone prototype remains a screenshot reference for its six page bodies.
  assert.ok(Math.abs(actualShell.x+actualShell.width/2-viewport.width/2)<=1,`${viewport.name}: window is horizontally centered`);
  assert.ok(Math.abs(actualShell.y+actualShell.height/2-viewport.height/2)<=1,`${viewport.name}: window is vertically centered`);
  assert.ok(actualShell.x>=0&&actualShell.y>=0&&actualShell.x+actualShell.width<=viewport.width&&actualShell.y+actualShell.height<=viewport.height,`${viewport.name}: window fits the viewport`);
  assert.equal(actualShell.background,'rgba(0, 0, 0, 0)',`${viewport.name}: host remains visible outside the window`);
  for(const route of ['lab','vault','care','connect','log','settings']){
   await ev(`document.querySelector('[data-go="${route}"]').click()`);
   await wait(`document.querySelector('[data-page="${route}"]').classList.contains('is-active')`);
   if(['vault','connect','log'].includes(route)){
    const details={vault:['resp','wl','scopes'],connect:['emb','mig','srv'],log:['a','b','c']}[route];
    for(const [index,detail] of details.entries()){
     await ev(`document.querySelector('.page.is-active [data-subtab="${detail}"]').click()`);
     await wait(`document.querySelector('.page.is-active [data-subtab="${detail}"]').getAttribute('aria-selected')==='true'`);
     if(index===0) await snap(`${viewport.name}-mockup-${route}`);
     else if(viewport.name==='desktop') await snap(`${viewport.name}-mockup-${route}-${detail}`);
    }
   } else await snap(`${viewport.name}-mockup-${route}`);
  }
 }
 console.log('PASS real Chromium: six product routes and original mockup reference at seven viewport widths; synthetic host/storage fixture; screenshots '+out);
 await call('Browser.close');
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(async()=>{clearTimeout(watchdog);ws?.close();child.kill();referenceServer?.close();await pause(200);fs.rmSync(profile,{recursive:true,force:true,maxRetries:20,retryDelay:100});fs.rmSync(socketTmp,{recursive:true,force:true,maxRetries:20,retryDelay:100});});

'use strict';
// Real plugin UI and Chromium pointer/keyboard events. The RisuAI host is local;
// no model or external service is used during inspection and rule preview.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {spawn}=require('node:child_process'),http=require('node:http');
const {resolveChromeExecutable}=require('../fixtures/browser_resolver.cjs');
const {artifact}=require('../fixtures/libra_unified_runtime_fixture.cjs');
const libraInput=require('../fixtures/unified_vertical_source.json');
const {createValidPacket,hiddenPacketMessage}=require('../fixtures/hayaku_runtime_harness.cjs');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const out=process.env.REANALYSIS_BROWSER_OUTPUT||path.join(os.tmpdir(),'reanalysis-review-browser');fs.mkdirSync(out,{recursive:true});
const profile=fs.mkdtempSync(path.join(os.tmpdir(),'reanalysis-chrome-'));
const chrome=spawn(resolveChromeExecutable(),['--headless=new','--disable-background-networking','--disable-component-update','--disable-sync','--no-sandbox','--disable-dev-shm-usage','--no-first-run','--remote-debugging-pipe','--user-data-dir='+profile,'about:blank'],{env:{...process.env,XDG_CONFIG_HOME:path.join(profile,'config'),XDG_CACHE_HOME:path.join(profile,'cache'),TMPDIR:os.tmpdir()},stdio:['ignore','ignore','pipe','pipe','pipe']});
chrome.stderr.on('data',data=>fs.appendFileSync(path.join(out,'chromium.stderr.log'),data));
let sequence=0,buffer='',sessionId;const pending=new Map(),errors=[];
chrome.stdio[4].on('data',chunk=>{buffer+=chunk.toString();let index;while((index=buffer.indexOf('\0'))>=0){const message=JSON.parse(buffer.slice(0,index));buffer=buffer.slice(index+1);if(message.method==='Runtime.exceptionThrown')errors.push(message.params.exceptionDetails);const task=pending.get(message.id);if(task){pending.delete(message.id);message.error?task.reject(Error(JSON.stringify(message.error))):task.resolve(message.result);}}});
chrome.stdio[3].on('error',error=>{for(const task of pending.values())task.reject(error);pending.clear();});
chrome.stdio[4].on('error',error=>{for(const task of pending.values())task.reject(error);pending.clear();});
chrome.on('error',error=>{for(const task of pending.values())task.reject(error);pending.clear();});
const call=(method,params={},session=sessionId)=>new Promise((resolve,reject)=>{const id=++sequence;pending.set(id,{resolve,reject});chrome.stdio[3].write(JSON.stringify({id,method,params,...(session?{sessionId:session}:{})})+'\0');});
const ev=async expression=>{const result=await call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(result.exceptionDetails)throw Error(JSON.stringify(result.exceptionDetails));return result.result.value;};
const wait=async expression=>{for(let i=0;i<150;i++){if(await ev(expression))return;await pause(25);}throw Error('Browser condition timed out: '+expression);};
const click=async selector=>{
  const point=await ev(`(()=>{const node=document.querySelector(${JSON.stringify(selector)});if(!node)throw Error('Missing '+${JSON.stringify(selector)});node.scrollIntoView({block:'center'});const r=node.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;if(!node.contains(document.elementFromPoint(x,y)))throw Error('Unreachable '+${JSON.stringify(selector)});return {x,y}})()`);
  await call('Input.dispatchMouseEvent',{type:'mousePressed',...point,button:'left',clickCount:1});await call('Input.dispatchMouseEvent',{type:'mouseReleased',...point,button:'left',clickCount:1});
};
let originServer;
const watchdog=setTimeout(()=>{chrome.kill('SIGKILL');process.exit(1);},90000);
(async()=>{
  originServer=http.createServer((_request,response)=>{response.setHeader('Content-Type','text/html; charset=utf-8');response.end('<!doctype html><html lang="ko"><meta name="viewport" content="width=device-width,initial-scale=1"><body></body></html>');});
  await new Promise(resolve=>originServer.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+originServer.address().port;
  const results=[];
  for(const [owner,file,api]of [['flashback','Flashback_Memory.js','__FlashbackMemory'],['hayaku','HAYAKU_Locator_Continuity.js','HAYAKU'],['libra','LIBRA.js','__LIBRA__']]){
    const {targetId}=await call('Target.createTarget',{url:origin+'/'},null);({sessionId}=await call('Target.attachToTarget',{targetId,flatten:true},null));await call('Runtime.enable');await wait('location.origin==='+JSON.stringify(origin)+'&&document.readyState==="complete"');
    await ev("document.documentElement.lang='ko';document.body.style.margin='0';window.__replacers=new Map();");
    await ev(fs.readFileSync(path.join(__dirname,'hayaku_browser_host.js'),'utf8'));
    await ev("window.__reanalysisWriteKeys=[];for(const store of [risuai.pluginStorage,risuai.safeLocalStorage]){const original=store.setItem.bind(store);store.setItem=async(key,value)=>{__reanalysisWriteKeys.push(String(key));return original(key,value);};}");
    await ev("risuai.addRisuReplacer=async(kind,handler)=>{__replacers.set(kind,handler);return true;};");
    const visible='Alice signed the agreement. <drop>Do not remember this.</drop>';
    const assistant=owner==='hayaku'?hiddenPacketMessage(visible,createValidPacket({turn:1,subject:'Alice',scene:'office',summary:'Alice signed the agreement.'})):visible;
    await ev(`__chat.message=[{role:'user',id:'u1',chatId:'u1',data:'What does Alice do?'},{role:'assistant',id:'a1',chatId:'a1',data:${JSON.stringify(assistant)}}];__chat.messages=__chat.message;`);
    if(owner==='libra'){
      await ev("risuai.pluginStorage.setItem('libra.firstSetupSeen.v1','1')");
      const rows=libraInput.sourceRows.map(row=>({role:row.role,chatId:row.ref,id:row.ref,data:row.text}));rows[1].data+=' <drop>Do not remember this.</drop>';
      await ev(`__chat.message=${JSON.stringify(rows)};__chat.messages=__chat.message;`);
      await ev(`args.set('enable_character_ito',false);args.set('enable_world_ito',false);args.set('enable_plot_ito',false);risuai.runLLMModel=async options=>{
        __hostCalls.llm++;const system=options.messages?.[0]?.content||'';
        if(system.includes('MICRO SOURCE CONTRACT')){
          const input=JSON.parse(options.messages.find(row=>row.role==='user').content),quote=input.assistant.text.slice(0,24);
          return {type:'success',result:JSON.stringify({schema:'libra.micro_producer_envelope.v1',personCandidates:{spans:[],relations:[]},micro:{schema:'libra.micro_memory.v1',...input.binding,claims:[{changeKind:'event',text:'도서관과 서재에 관한 대화를 기억한다.',actor:'',target:'',temporalRole:'current',certainty:'confirmed',epistemicStatus:'observed',stateChangeType:'none',evidence:{role:'assistant',messageId:input.assistant.messageId,startOffset:0,endOffset:quote.length,exactQuote:quote}}]}})};
        }
        if(system.includes('[LIBRA LENS ANALYZER'))return {type:'success',result:JSON.stringify({items:[{label:'세계 설정',text:'도서관 안의 서재와 공연실을 기록했다.',refs:['t1-a'],quote:${JSON.stringify(libraInput.sourceRows.find(row=>row.ref==='t1-a').text.slice(0,24))}}]})};
        return {type:'success',result:${JSON.stringify(JSON.stringify(artifact()))}};
      };`);
    }
    let pluginSource=fs.readFileSync(path.join(__dirname,'../../plugins',file),'utf8');
    if(owner==='libra')pluginSource=pluginSource.replace('  const buildBookMemoryModelSummary = () => {','  globalThis.__openLibraReview=()=>showCanonicalRangeDrawer(\'source_edit\');globalThis.__libraReanalysisUiState=()=>({canonicalPending:Gui.canonicalJobLaunchPending});globalThis.__libraReviewHydrated=()=>Gui.openPerf?.hydratedAt>0;globalThis.__libraReviewDiagnostics=async()=>({scope:(await LibraMemoryCore.resolveContext()).scope,receipt:LibraMemoryCore.state.lastSourceReceiptReconcile});\n  const buildBookMemoryModelSummary = () => {');
    await ev(pluginSource);await wait('!!window.'+api);await ev('window.product=window.'+api);
    if(owner==='flashback'){
      await ev("(async()=>{await product.saveSettings({...await product.loadSettings(),embeddingProvider:'hash',embeddingModel:'hash-v1',embeddingEnabled:true,autoEpisodeIndex:false});await product.ingestLiveChatColdStart({scope:'current',canonical:true});})()");
    }else if(owner==='libra'){
      await wait("__replacers.has('beforeRequest')&&__replacers.has('afterRequest')");
      const seeded=await ev("(async()=>{const settings=await product.getLibraMemorySettings();await product.saveLibraMemorySettings({...settings,memoryEngine:'unified'});const job=await product.runManualColdStart();await product.retryPendingUnifiedVectors();return {job,diagnostics:await __libraReviewDiagnostics(),inventory:await product.listReanalysisRanges()};})()");assert.equal(seeded.inventory.ranges.length,5,JSON.stringify(seeded));
      const additional=await ev("(async()=>{const inventory=await product.listReanalysisRanges({kind:'micro'});const micro=await product.reanalyzeSelectedRanges({...inventory,ranges:[inventory.ranges[0]]});const lens=await product.createLens({name:'세계 설정과 사건',instruction:{goal:'대화에 나온 세계 설정과 사건을 기록한다.'},evidenceMode:'strict'});const run=await product.runLensForRange({lensId:lens.lensId,startTurn:1,endTurn:2});return {micro,run};})()");assert.equal(additional.micro.ok,true,JSON.stringify(additional));assert.equal(additional.run.ok,true,JSON.stringify(additional));
      // Let the real startup cleanup finish before measuring write-free inspection.
      await wait("__reanalysisWriteKeys.includes('libra:v1:migration:remove-world-additional:v1')");
    }else{
      await wait("__replacers.has('beforeRequest')&&__replacers.has('afterRequest')");
      await ev("(async()=>{await __replacers.get('beforeRequest')([{role:'user',content:'Recall.'}],'model');await __replacers.get('afterRequest')('','model');})()");
    }
    if(owner==='libra'){await ev('product.openSettingsGui()');await wait('__libraReviewHydrated()');}
    await ev(owner==='libra'?'__openLibraReview()':'product.showUi()');await wait("!!document.querySelector('.app')");
    if(owner==='flashback')await click('.tabbar [data-go="care"]');
    else if(owner==='hayaku'){await click('.tabbar [data-go="recovery"]');await click('[data-recovery-view="reanalysis"]');}
    const ranges=owner==='flashback'?'#fbReanalysisRanges':'[data-reanalysis-ranges]',review=owner==='flashback'?'#fbReanalysisReview':'[data-reanalysis-review]',run=owner==='flashback'?'#fbReanalysisRun':'[data-reanalysis-run]';
    await wait(`document.querySelector(${JSON.stringify(ranges+' input')})`);
    assert.equal(await ev("document.querySelector('[data-reanalysis-fold]').open"),false);
    const before=await ev('({...__hostCalls,writeKeys:__reanalysisWriteKeys.length,chat:JSON.stringify(__chat)})');
    await click('[data-reanalysis-fold]>summary');
    if(owner==='libra'){
      assert.deepEqual(await ev("[...document.querySelectorAll('[data-reanalysis-kind]')].map(node=>node.textContent)"),['정본','미크로','렌즈']);
      await click('[data-reanalysis-select-all]');
      assert.equal(await ev("document.querySelectorAll('[data-reanalysis-ranges] input:checked').length"),1);
      assert.equal(await ev("document.querySelector('[data-reanalysis-review]').hidden"),false);
      assert.match(await ev("document.querySelector('#range-calls').textContent"),/^1회/);
      const capturePage=async kind=>{
        await call('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false});
        await ev("document.querySelector('[data-canonical-range-drawer] .dialog').scrollTop=0");
        const shot=await call('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,'libra-reanalysis-'+kind+'.png'),Buffer.from(shot.data,'base64'));
        for(const width of [390,320]){
          await call('Emulation.setDeviceMetricsOverride',{width,height:844,deviceScaleFactor:1,mobile:false});
          const overflow=await ev("(()=>{const page=document.querySelector('[data-reanalysis-page]'),tabs=document.querySelector('[data-reanalysis-pages]');return {page:page.scrollWidth-page.clientWidth,tabs:tabs.scrollWidth-tabs.clientWidth}})()");assert.ok(overflow.page<=1&&overflow.tabs<=1,kind+' fits '+width+': '+JSON.stringify(overflow));
        }
        await call('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false});
      };
      await capturePage('canonical');
      await click('[data-reanalysis-kind=micro]');await wait("document.querySelector('[data-reanalysis-ranges]')?.textContent.includes('미크로 ·')");
      assert.equal(await ev("document.querySelector('[data-reanalysis-fold]').open"),true);await click('[data-reanalysis-select-all]');
      assert.match(await ev("document.querySelector('#range-calls').textContent"),/^5회/);assert.equal(await ev("document.querySelector('[data-reanalysis-review]').hidden"),true);await capturePage('micro');
      await click('[data-reanalysis-kind=lens]');await wait("document.querySelector('[data-reanalysis-ranges]')?.textContent.includes('세계 설정과 사건')");
      assert.equal(await ev("document.querySelectorAll('[data-reanalysis-ranges] input').length"),2);await click('[data-reanalysis-ranges] input[value="1-2"]');
      assert.equal(await ev("document.querySelector('[data-reanalysis-review]').hidden"),true);await capturePage('lens');
      await click('[data-reanalysis-kind=canonical]');await wait("document.querySelector('[data-reanalysis-ranges] input[value=\"1-5\"]')");
      await click('[data-reanalysis-clear-selection]');
      assert.equal(await ev("document.querySelectorAll('[data-reanalysis-ranges] input:checked').length"),0);
      assert.equal(await ev("document.querySelector('[data-reanalysis-run]').disabled"),true);
    }
    await click(ranges+' input');
    assert.equal(await ev(`document.querySelector(${JSON.stringify(review)}).hidden`),false);assert.equal(await ev(`document.querySelector(${JSON.stringify(run)}).disabled`),false);
    await click(review);await wait("document.querySelector('[data-review-apply]')?.disabled===false");
    const layout=[];
    for(const [width,height]of [[1280,900],[390,844],[320,640]]){
      await call('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});
      const state=await ev("(()=>{const box=document.querySelector('[data-source-reanalysis-review]'),r=box.getBoundingClientRect();return {width:r.width,overflow:box.scrollWidth-box.clientWidth,textareaReadonly:[...box.querySelectorAll('textarea')].every(n=>n.readOnly),overflowElements:[...box.querySelectorAll('*')].filter(n=>n.getBoundingClientRect().right>r.right+1).map(n=>({tag:n.tagName,cls:n.className,width:n.getBoundingClientRect().width,text:n.tagName==='INPUT'?n.value:n.textContent.slice(0,35)})).slice(0,12)}})()");
      assert.ok(state.overflow<=1,owner+' review fits '+width+': '+JSON.stringify(state));assert.equal(state.textareaReadonly,true);layout.push({viewportWidth:width,viewportHeight:height,...state});
    }
    await click('[data-review-source="assistant"]');
    await call('Input.dispatchKeyEvent',{type:'keyDown',key:'a',code:'KeyA',modifiers:2,windowsVirtualKeyCode:65});await call('Input.dispatchKeyEvent',{type:'keyUp',key:'a',code:'KeyA',modifiers:2,windowsVirtualKeyCode:65});
    await click('[data-review-extract]');await wait("[...document.querySelectorAll('[data-review-rule] input')].some(n=>n.value==='<drop>')");
    await click('[data-review-apply]');await wait("document.querySelector('[data-review-run]')?.disabled===false");
    assert.equal(await ev("document.querySelector('[data-review-output=assistant]').textContent.trim()"),owner==='libra'?libraInput.sourceRows.find(row=>row.ref==='t1-a').text:'Alice signed the agreement.');
    const after=await ev('({...__hostCalls,writeKeys:__reanalysisWriteKeys,chat:JSON.stringify(__chat)})');assert.equal(after.llm,before.llm);assert.equal(after.network,before.network);assert.equal(after.writes,before.writes,JSON.stringify(after.writeKeys.slice(before.writeKeys)));assert.equal(after.chat,before.chat);
    await ev("document.querySelector('[data-review-candidates] [data-review-rule]').scrollIntoView({block:'center'})");
    const screenshot=await call('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,owner+'-review-mobile.png'),Buffer.from(screenshot.data,'base64'));
    if(owner==='libra'){
      await click('[data-canonical-range-drawer] .dialog__actions button');
      for(const kind of ['micro','lens']){
        await ev('__openLibraReview()');await click('[data-reanalysis-kind='+kind+']');await wait("!document.querySelector('[data-reanalysis-status]').textContent.includes('읽는 중')");await click('[data-reanalysis-fold]>summary');
        const value=kind==='micro'?'2':'1-2';await click('[data-reanalysis-ranges] input[value="'+value+'"]');const calls=await ev('__hostCalls.llm');
        await click('[data-reanalysis-run]');await wait("!document.querySelector('[data-canonical-range-drawer]')");assert.equal(await ev('__hostCalls.llm'),calls+1);assert.equal(await ev('__libraReanalysisUiState().canonicalPending'),false);
        if(kind==='micro')assert.equal(await ev('(async()=>{const active=await product.debugReadActiveMicroMemory(2);return active.status;})()'),'verified');
      }
    }
    results.push({owner,layout,noModelCalls:true,noWritesDuringPreview:true});await ev('__dispose()');await call('Target.closeTarget',{targetId},null);sessionId=null;
  }
  assert.deepEqual(errors,[]);fs.writeFileSync(path.join(out,'results.json'),JSON.stringify(results,null,2));console.log('PASS real Chromium: collapsed UI, single-turn actions, XML selection, preview, desktop/mobile layout; '+out);
})().catch(async error=>{console.error(error);try{console.error(await ev("({statuses:[...document.querySelectorAll('[data-reanalysis-status]')].map(n=>n.textContent),drawer:!!document.querySelector('[data-canonical-range-drawer]'),lastText:document.body.innerText.slice(-800)})"));}catch{}process.exitCode=1;}).finally(async()=>{clearTimeout(watchdog);originServer?.close();chrome.kill();await pause(150);fs.rmSync(profile,{recursive:true,force:true,maxRetries:10,retryDelay:100});});

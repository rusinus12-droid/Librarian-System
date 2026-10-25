'use strict';
// Real plugin UI and Chromium pointer/keyboard events. The RisuAI host is local;
// no model or external service is used during inspection and rule preview.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {spawn}=require('node:child_process');
const {resolveChromeExecutable}=require('../fixtures/browser_resolver.cjs');
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
const watchdog=setTimeout(()=>{chrome.kill('SIGKILL');process.exit(1);},60000);
(async()=>{
  const results=[];
  for(const [owner,file,api]of [['flashback','Flashback_Memory.js','__FlashbackMemory'],['hayaku','HAYAKU_Locator_Continuity.js','HAYAKU']]){
    const {targetId}=await call('Target.createTarget',{url:'about:blank'},null);({sessionId}=await call('Target.attachToTarget',{targetId,flatten:true},null));await call('Runtime.enable');
    await ev("document.documentElement.lang='ko';document.body.style.margin='0';window.__replacers=new Map();");
    await ev(fs.readFileSync(path.join(__dirname,'hayaku_browser_host.js'),'utf8'));
    await ev("risuai.addRisuReplacer=async(kind,handler)=>{__replacers.set(kind,handler);return true;};");
    const visible='Alice signed the agreement. <drop>Do not remember this.</drop>';
    const assistant=owner==='hayaku'?hiddenPacketMessage(visible,createValidPacket({turn:1,subject:'Alice',scene:'office',summary:'Alice signed the agreement.'})):visible;
    await ev(`__chat.message=[{role:'user',id:'u1',chatId:'u1',data:'What does Alice do?'},{role:'assistant',id:'a1',chatId:'a1',data:${JSON.stringify(assistant)}}];__chat.messages=__chat.message;`);
    await ev(fs.readFileSync(path.join(__dirname,'../../plugins',file),'utf8'));await wait('!!window.'+api);await ev('window.product=window.'+api);
    if(owner==='flashback'){
      await ev("(async()=>{await product.saveSettings({...await product.loadSettings(),embeddingProvider:'hash',embeddingModel:'hash-v1',embeddingEnabled:true,autoEpisodeIndex:false});await product.ingestLiveChatColdStart({scope:'current',canonical:true});})()");
    }else{
      await wait("__replacers.has('beforeRequest')&&__replacers.has('afterRequest')");
      await ev("(async()=>{await __replacers.get('beforeRequest')([{role:'user',content:'Recall.'}],'model');await __replacers.get('afterRequest')('','model');})()");
    }
    await ev('product.showUi()');await wait("!!document.querySelector('.app')");
    if(owner==='flashback')await click('.tabbar [data-go="care"]');
    else{await click('.tabbar [data-go="recovery"]');await click('[data-recovery-view="reanalysis"]');}
    const ranges=owner==='flashback'?'#fbReanalysisRanges':'[data-reanalysis-ranges]',review=owner==='flashback'?'#fbReanalysisReview':'[data-reanalysis-review]',run=owner==='flashback'?'#fbReanalysisRun':'[data-reanalysis-run]';
    await wait(`document.querySelector(${JSON.stringify(ranges+' input')})`);
    assert.equal(await ev("document.querySelector('[data-reanalysis-fold]').open"),false);
    const before=await ev('({...__hostCalls,chat:JSON.stringify(__chat)})');
    await click('[data-reanalysis-fold]>summary');await click(ranges+' input');
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
    assert.equal(await ev("document.querySelector('[data-review-output=assistant]').textContent.trim()"),'Alice signed the agreement.');
    const after=await ev('({...__hostCalls,chat:JSON.stringify(__chat)})');assert.equal(after.llm,before.llm);assert.equal(after.network,before.network);assert.equal(after.writes,before.writes);assert.equal(after.chat,before.chat);
    await ev("document.querySelector('[data-review-candidates] [data-review-rule]').scrollIntoView({block:'center'})");
    const screenshot=await call('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,owner+'-review-mobile.png'),Buffer.from(screenshot.data,'base64'));
    results.push({owner,layout,noModelCalls:true,noWritesDuringPreview:true});await ev('__dispose()');await call('Target.closeTarget',{targetId},null);sessionId=null;
  }
  assert.deepEqual(errors,[]);fs.writeFileSync(path.join(out,'results.json'),JSON.stringify(results,null,2));console.log('PASS real Chromium: collapsed UI, single-turn actions, XML selection, preview, desktop/mobile layout; '+out);
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{clearTimeout(watchdog);chrome.kill();await pause(150);fs.rmSync(profile,{recursive:true,force:true,maxRetries:10,retryDelay:100});});

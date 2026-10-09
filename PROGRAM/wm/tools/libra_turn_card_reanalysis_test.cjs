'use strict';
// Exercise the emitted plugin, native host callbacks, and actual memory-card click handlers.
// Provider transport is mocked; external fetches and host publication are not permitted.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Module = require('node:module');
// Reuse the native host/DOM fixture without loading the detached-factory prototype.
// The only emitted-code instrumentation exposes its already-built lexical API.
const productionArtifact=path.resolve(process.env.LIBRA_GUI_TEST_DIST||path.join(__dirname,'../dist/LIBRA World Manager Full.js'));
const productionCode=fs.readFileSync(productionArtifact,'utf8');
const fixturePath = path.join(__dirname, 'libra_management_gui_integration_test.cjs');
let fixtureSource = fs.readFileSync(fixturePath, 'utf8');
fixtureSource=fixtureSource.replace('async setCharacter(value){control.char=', 'async setCharacter(value){calls.hostWrites.push(clone(value));control.char=');
const instrumentationStart = fixtureSource.indexOf(' let code=fs.readFileSync(');
const instrumentationEnd = fixtureSource.indexOf(' await w.eval(code);', instrumentationStart);
assert(instrumentationStart >= 0 && instrumentationEnd > instrumentationStart, 'fixture instrumentation boundaries');
fixtureSource = fixtureSource.slice(0, instrumentationStart) + `
 let code=module.__artifactSource;
 w.__WM_BASELINE_WRITES__=[];
 const observeAnchor="if (owner.scopeKey !== scopeKey || !((token === owner.token && owner.state === 'capturing') || (token === owner.publicationTicket && owner.state === 'publishing'))) {";
 assert.equal(code.split(observeAnchor).length,2,'unique actual baseline writer guard');
 code=code.replace(observeAnchor,"globalThis.__WM_BASELINE_WRITES__.push({scopeMatch:owner.scopeKey===scopeKey,tokenMatch:token===owner.token,state:owner.state,priorMatch:priorRaw===(owner.postRaw??owner.beforeRaw),stack:new Error('baseline-write-observation').stack});"+observeAnchor);
 const fullBoundary=code.lastIndexOf('\\n})();');
 const boundary=fullBoundary>=0?fullBoundary:Math.max(code.lastIndexOf('}();'),code.lastIndexOf('})();')); 
 assert(boundary>=0,'actual emitted production IIFE boundary exists');
 code=code.slice(0,boundary)+';globalThis.__WM_GUI_TEST__=runtimeApi;globalThis.__WM_BASELINE_INSPECT__=LatestTurnBaselineOwner.inspect;'+code.slice(boundary);
` + fixtureSource.slice(instrumentationEnd);
const fixtureModule=new Module(fixturePath,module);
fixtureModule.filename=fixturePath;fixtureModule.paths=Module._nodeModulePaths(__dirname);
fixtureModule.__artifactSource=productionCode;
fixtureModule._compile(fixtureSource,fixturePath);
const {loadGui}=fixtureModule.exports;
const { readLedgerReceipts } = require('./libra_generation_capture_receipt_fixture.cjs');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function settlesWithin(promise,label,ms=8000) {
  let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(typeof label==='function'?label():label)),ms);})]);}finally{clearTimeout(timer);}
}
async function holdUntilReleasedOrAborted(gate,signal) {
  if(!signal)return gate;
  if(signal.aborted)throw signal.reason||new Error('mock_transport_aborted');
  let abort;
  try {await Promise.race([gate,new Promise((_,reject)=>{abort=()=>reject(signal.reason||new Error('mock_transport_aborted'));signal.addEventListener('abort',abort,{once:true});})]);}
  finally {if(abort)signal.removeEventListener('abort',abort);}
}
async function waitFor(predicate, label) {
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) { if (predicate()) return; await sleep(20); }
  assert.fail(label);
}
function packetFor(response, turn = 1) {
  return {schema:'libra.canonical_packet.v3',version:3,meta:{turn,sourceMessageIds:[`assistant-${turn}`]},
    memory:{events:[],facts:[],open_threads:[]},entity:{characters:[{operation:'add',name:'Mira',identity:{role:'Reader'},evidenceRefs:[{turn,messageId:`assistant-${turn}`,snippet:response,sourceKind:'assistant'}],quality:{confidence:0.9}}],relations:[]},
    world:{state:{scene:response}},narrative:{scene_phase:'development'},guards:{},importance:{overall:0.7}};
}
async function ordinaryFixture(options={}) {
  const provider = { calls: 0, turn: 1, response: 'Mira opens the blue notebook.', gate: null, fault: null, signals: [] }; 
  const f = await loadGui({nativeInitialization:true,store:new Map(),nativeFetch:async(url,init)=>{
    assert.equal(new URL(url).hostname,'mock-only.invalid','provider remains mock-only');
    provider.calls++;
    provider.signals.push(init?.signal);
    if (provider.calls > 1 && provider.gate) await holdUntilReleasedOrAborted(provider.gate,init?.signal);
    if (provider.calls > 1 && provider.fault) throw new Error(provider.fault);
    return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({canonicalPacket:packetFor(provider.response,provider.turn),maintenance:{narrativeBrief:provider.response,correction:null}})},finish_reason:'stop'}],usage:{prompt_tokens:100,completion_tokens:100}}),{status:200,headers:{'content-type':'application/json'}});
  }});
  f.provider = provider;
  try {
    Object.assign(f.api.MemoryEngine.CONFIG,{useLLM:true,afterRequestParallelAnalysis:false,backgroundMaintenanceDelayMs:0});
    const profile={...f.api.MemoryEngine.CONFIG.llm,provider:'openai',url:'https://mock-only.invalid',key:'mock-only',model:'mock',stream:false};
    f.api.MemoryEngine.CONFIG.llmPresets={fixture:profile};f.api.MemoryEngine.CONFIG.llmDefaultPreset='fixture';f.api.MemoryEngine.CONFIG.llm=profile;
    const earlier=options.earlierNativePair?[{role:'user',data:'Earlier user source.',chatId:'user-0'},{role:'char',data:'Earlier assistant source.',chatId:'assistant-0'}]:[];
    f.control.chat.message=f.control.chat.msgs=[...earlier,{role:'user',data:'Mira, open the blue notebook.',chatId:'user-1'}];
    await f.callbacks.beforeRequest([{role:'user',content:'Mira, open the blue notebook.'}],'model');
    await f.callbacks.afterRequest(provider.response,'model');
    f.control.chat.message.push({role:'char',data:provider.response,chatId:'assistant-1'});
    f.control.chat.msgs=f.control.chat.message;
    await waitFor(()=>readLedgerReceipts(f.store).some(receipt=>receipt.status==='committed') && !f.api.MemoryState.pendingTurnCommits.size && [...f.api.MemoryState.turnMaintenanceSchedulesByChatId.values()].every(x=>!x.running&&!x.queued&&!x.timer&&!x.pendingRecords?.length),'ordinary native capture and analysis finish');
    assert.equal(provider.calls,1,'ordinary capture used the selected synthetic preset through the real provider gateway');
    await f.callbacks.setting();
    f.overlay=f.w.document.querySelector('#lmai-overlay');
    // The fixture's original click closes over the previous overlay, so use live DOM here.
    f.click=async selector=>{const element=typeof selector==='string'?f.overlay.querySelector(selector):selector;assert(element,`registered GUI control exists: ${selector}`);element.click();await Promise.allSettled(f.pending.splice(0));};
    await f.click('[data-tab="memory"]');
    await f.click('[data-mem-view="turn"]');
    await f.click('#mem-nsrc-toggle');
    assert(f.overlay.querySelector('#ml .card.mem'),'ordinary captured memory is rendered as a real card');
    f.canonicalWrites=()=>f.calls.writes.filter(write=>write.key===f.key);
    f.button=()=>f.overlay.querySelector('#ml .act-reanalyze-turn:not([disabled])')||f.overlay.querySelector('#ml .act-reanalyze-turn');
    f.status=()=>f.overlay.querySelector('#ml .turn-reanalysis-status');
    f.editSource=()=>{provider.response='Mira closes the blue notebook.';f.control.chat.message.at(-1).data=provider.response;f.control.chat.msgs=f.control.chat.message;};
    f.holdProvider=()=>{let release;provider.gate=new Promise(resolve=>{release=resolve;});return release;};
    f.flush=async()=>{while(f.pending.length)await settlesWithin(Promise.allSettled(f.pending.splice(0)),()=>'card handler did not settle after released/aborted provider; aborted='+provider.signals.at(-1)?.aborted+'; overlayConnected='+f.overlay.isConnected);};
    f.calls.writes.length=0;f.calls.hostWrites.length=0;
    return f;
  } catch (error) { console.error(JSON.stringify({ordinaryFixtureFailure:{providerCalls:provider.calls,receipts:readLedgerReceipts(f.store).map(r=>({status:r.status,analysisStatus:r.analysisStatus,deferredReason:r.deferredReason})),cardReason:f.overlay?.querySelector('.act-reanalyze-turn')?.title}}));f.close(); throw error; }
}
const checks=[];
async function test(name,fn,options={}) {
  if(process.env.LIBRA_TURN_CARD_TEST_FILTER&&!new RegExp(process.env.LIBRA_TURN_CARD_TEST_FILTER).test(name))return;
  process.stderr.write('[turn-card] START '+name+'\n');
  let f;try{f=await ordinaryFixture(options);await fn(f);checks.push({name,ok:true});process.stderr.write('[turn-card] PASS '+name+'\n');}catch(error){checks.push({name,ok:false,error:error.stack||String(error),diagnostics:f?{providerCalls:f.provider?.calls,providerAborted:f.provider?.signals?.at(-1)?.aborted,canonicalWrites:f.canonicalWrites?.().length,hostWrites:f.calls?.hostWrites?.length,overlayConnected:f.overlay?.isConnected}:undefined});process.stderr.write('[turn-card] FAIL '+name+': '+error.message+'\n');process.exitCode=1;}finally{f?.close();}
}
async function main() {
  await test('ordinary latest native turn exposes its canonical reanalysis action on the real memory card',async f=>{
    const card=f.overlay.querySelector('#ml .card.mem');
    const button=card.querySelector('.act-reanalyze-turn');
    assert(button,'ordinary latest memory card exposes .act-reanalyze-turn');
    assert.equal(f.w.__WM_BASELINE_INSPECT__().state,'ready','ordinary extension saves retain the captured owner until verified completion');
    assert(f.w.__WM_BASELINE_WRITES__.every(row=>row.scopeMatch&&row.tokenMatch&&row.priorMatch),'all ordinary extension writes carry the exact captured token and verified prior root');
    assert.equal(f.canonicalPayload().entries.some(row=>row.comment==='lmai_user_dlc'),false,'ordinary no-DLC capture must not manufacture an empty user-DLC owner');
    assert.equal(button.disabled,false,'eligible latest turn action is enabled: '+button.title+' / '+JSON.stringify({owner:f.w.__WM_BASELINE_INSPECT__(),writes:f.w.__WM_BASELINE_WRITES__}));
    const memory=f.canonicalPayload().entries.find(row=>row.comment==='lmai_memory');
    const meta=JSON.parse(memory.content.slice(6,memory.content.indexOf(']\n')));
    assert.equal(button.dataset.memoryId,meta.canonicalMemoryId,'DOM carries canonical memory ID instead of only a positional index');
    assert(card.querySelector('.turn-reanalysis-status[role="status"]'),'card has accessible persistent result status');
  });

  await test('one real card click analyzes all domains and publishes one canonical root without host writes',async f=>{
    const raw=f.store.get(f.key),originalId=f.button()?.dataset.memoryId;
    const originalAux=[...f.store].filter(([key])=>key!==f.key&&!key.startsWith('libra:v1:hme-derived:'));
    f.editSource();await f.click('.act-reanalyze-turn');
    assert.equal(f.provider.calls,2,'one ordinary analysis plus one explicit reanalysis');
    assert.equal(f.canonicalWrites().length,1,'the whole turn is one physical canonical publication');
    assert.equal(f.calls.hostWrites.length,0,'no native chat save');
    const root=f.canonicalPayload();
    assert.notEqual(f.store.get(f.key),raw,'verified new root replaces the old root');
    assert.equal(root.reanalysisRevision.canonicalMemoryId,originalId);
    assert.equal(root.reanalysisRevision.domainLedger.complete,true);
    assert.equal(root.reanalysisRevision.domainLedger.domains.length,16);
    assert(f.store.get(f.key).includes('Mira closes the blue notebook.'));
    assert(!f.store.get(f.key).includes('Mira opens the blue notebook.'));
    assert.deepEqual([...f.store].filter(([key])=>key!==f.key&&!key.startsWith('libra:v1:hme-derived:')),originalAux,'native worldline and capture receipts are not rewritten');
    assert.equal(f.status()?.dataset.state,'committed');
    assert(f.status().textContent.trim(),'verified completion is visible on card');
    assert(f.button().disabled,'same turn cannot be reanalyzed repeatedly');
    assert(f.button().title.trim(),'disabled repeat has an explanation');
  });
  await test('duplicate clicks and same-view rerender keep one global analysis and one publication',async f=>{
    const release=f.holdProvider();f.editSource();const button=f.button();assert(button,'reanalysis button');
    button.click();button.click();
    try {
      await waitFor(()=>f.provider.calls===2,'explicit provider starts');
      assert.equal(f.status()?.dataset.state,'preparing');
      f.overlay.querySelector('[data-mem-view="kind"]').click();
      const rerendered=f.button();assert(rerendered?.disabled,'in-flight latch disables recreated card control');
      rerendered.click();assert.equal(f.provider.calls,2);
    } finally {release();await f.flush();}
    assert.equal(f.provider.calls,2);assert.equal(f.canonicalWrites().length,1);assert.equal(f.calls.hostWrites.length,0);
    assert.equal(f.status()?.dataset.state,'committed');
  });
  for(const transition of ['close','tab-navigation','scope-navigation','unload'])await test(`${transition} while provider is pending prevents canonical publication`,async f=>{
    const raw=f.store.get(f.key),release=f.holdProvider();f.editSource();assert(f.button(),'reanalysis button');f.button().click();
    try {
      await waitFor(()=>f.provider.calls===2,'explicit provider starts');
      if(transition==='close')f.overlay.querySelector('#xbtn').click();
      if(transition==='tab-navigation')f.overlay.querySelector('.side-link[data-tab="world"]').click();
      if(transition==='scope-navigation'){
        f.control.chat={id:'destination',bindedPersona:'persona-a',localLore:[],message:[]};
        f.control.char={id:'other-character',chatPage:0,chats:[f.control.chat]};
        f.api.MemoryState._activeScopeKey='destination';f.api.TimeEngine.resetState({notes:'destination sentinel'});
      }
      if(transition==='close'||transition==='tab-navigation'){
        await sleep(0);assert(f.provider.signals.at(-1)?.aborted,'leaving the origin view aborts the detached provider');
      }
      if(transition==='unload'){
        assert(f.callbacks.unload?.length,'actual native unload callbacks registered');
        for(const callback of f.callbacks.unload)await callback();
        assert(f.provider.signals.at(-1)?.aborted,'unload aborts the signal forwarded to the detached provider');
      }
    } finally {release();await f.flush();}
    assert.equal(f.store.get(f.key),raw,'original canonical bytes preserved');
    assert.equal(f.canonicalWrites().length,0,'no root publication after origin view became invalid');
    assert.equal(f.calls.hostWrites.length,0);
    if(transition==='scope-navigation')assert.equal(f.api.TimeEngine.getState().notes,'destination sentinel');
  });
  await test('provider failure exposes a reason and leaves canonical bytes unchanged',async f=>{
    const raw=f.store.get(f.key);f.editSource();f.provider.fault='fixture_provider_failed';
    await f.click('.act-reanalyze-turn');
    assert.equal(f.store.get(f.key),raw);assert.equal(f.canonicalWrites().length,0);assert.equal(f.calls.hostWrites.length,0);
    assert.equal(f.status()?.dataset.state,'rejected');assert(f.status().textContent.trim(),'failure reason is visible');
  });
  await test('unreadable postwrite outcome is explicitly uncertain and never retried',async f=>{
    f.editSource();f.control.afterSet=async()=>{f.control.failReads=true;};
    await f.click('.act-reanalyze-turn');
    assert.equal(f.canonicalWrites().length,1,'only one physical write despite uncertain readback');
    assert.equal(f.provider.calls,2);assert.equal(f.calls.hostWrites.length,0);
    assert.equal(f.status()?.dataset.state,'uncertain');
    assert.match(f.status().textContent,/불확실|확인.*불가|확인할 수 없|uncertain/i,'visible outcome distinguishes uncertainty from success');
    assert(f.button().disabled,'uncertain outcome cannot be repeated');
    f.button().click();await f.flush();assert.equal(f.canonicalWrites().length,1);
  });
  await test('runtime reload renders unsupported existing card disabled with a reason',async f=>{
    const fresh=await loadGui({nativeInitialization:true,store:f.store,character:f.control.char});
    try {
      await fresh.click('[data-tab="memory"]');await fresh.click('[data-mem-view="turn"]');await fresh.click('#mem-nsrc-toggle');
      const button=fresh.overlay.querySelector('#ml .act-reanalyze-turn');
      assert(button,'reloaded existing canonical card still exposes the supported action surface');
      assert(button.disabled,'volatile baseline is not inferred or rebuilt on reload');assert(button.title.trim(),'reload reason is visible');
      const before=fresh.store.get(fresh.key);button.click();await Promise.allSettled(fresh.pending.splice(0));
      assert.equal(fresh.store.get(fresh.key),before);assert.equal(fresh.calls.writes.filter(row=>row.key===fresh.key).length,0);
    } finally {fresh.close();}
  });
  await test('earlier ordinary turn card stays disabled when a newer ordinary turn owns the baseline',async f=>{
    f.provider.turn=2;f.provider.response='Mira reads the next page.';
    f.control.chat.message.push({role:'user',data:'Mira, read the next page.',chatId:'user-2'});f.control.chat.msgs=f.control.chat.message;
    await f.callbacks.beforeRequest([{role:'user',content:'Mira, read the next page.'}],'model');
    await f.callbacks.afterRequest(f.provider.response,'model');
    f.control.chat.message.push({role:'char',data:f.provider.response,chatId:'assistant-2'});f.control.chat.msgs=f.control.chat.message;
    await waitFor(()=>f.provider.calls===2&&f.canonicalPayload().entries.some(row=>row.comment==='lmai_memory'&&row.content.includes('assistant-2'))&&!f.api.MemoryState.pendingTurnCommits.size&&[...f.api.MemoryState.turnMaintenanceSchedulesByChatId.values()].every(x=>!x.running&&!x.queued&&!x.timer&&!x.pendingRecords?.length),'second ordinary native turn finishes');
    await f.callbacks.setting();f.overlay=f.w.document.querySelector('#lmai-overlay');
    await f.click('[data-tab="memory"]');await f.click('[data-mem-view="turn"]');await f.click('#mem-nsrc-toggle');
    const buttons=[...f.overlay.querySelectorAll('#ml .act-reanalyze-turn')];
    const first=buttons.find(button=>button.dataset.memoryId.includes('assistant-1'));
    const second=buttons.find(button=>button.dataset.memoryId.includes('assistant-2'));
    assert(first&&second,'both ordinary canonical turn cards are visible');
    assert(first.disabled,'older turn never inherits the latest-turn owner');assert(first.title.trim(),'old-turn reason is visible');
    assert.equal(second.disabled,false,'latest turn is still eligible');
    const before=f.store.get(f.key),writes=f.canonicalWrites().length;first.click();await f.flush();
    assert.equal(f.store.get(f.key),before);assert.equal(f.canonicalWrites().length,writes);
  });
  await test('editing an earlier native body while provider is pending rejects the latest-turn publication',async f=>{
    const raw=f.store.get(f.key),release=f.holdProvider();f.editSource();
    assert(f.button()&&!f.button().disabled,'latest ordinary card with earlier native history is eligible');f.button().click();
    try {
      await waitFor(()=>f.provider.calls===2,'explicit provider starts');
      f.control.chat.message[0].data='Earlier user source changed during analysis.';
      f.control.chat.msgs=f.control.chat.message;
    } finally {release();await f.flush();}
    assert(f.store.get(f.key)===raw,'earlier-body edit preserves the original canonical root');
    assert.equal(f.canonicalWrites().length,0);assert.equal(f.calls.hostWrites.length,0);
    assert.equal(f.status()?.dataset.state,'rejected');
  },{earlierNativePair:true});
  const report={passed:checks.filter(x=>x.ok).length,failed:checks.filter(x=>!x.ok).length,productionArtifact,sha256:crypto.createHash('sha256').update(productionCode).digest('hex'),mockOnly:true,checks};
  if(process.env.LIBRA_TURN_CARD_REPORT){fs.mkdirSync(path.dirname(process.env.LIBRA_TURN_CARD_REPORT),{recursive:true});fs.writeFileSync(process.env.LIBRA_TURN_CARD_REPORT,JSON.stringify(report,null,2)+'\n');}
  console.log(JSON.stringify(report,null,2));
}
if(require.main===module)main().catch(error=>{console.error(error);process.exitCode=1;});
module.exports={ordinaryFixture,packetFor,waitFor};

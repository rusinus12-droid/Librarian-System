'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {serverFixture}=require('./fixtures/libra_server_runtime_fixture.cjs');
const source=fs.readFileSync(path.join(__dirname,'../plugins/LIBRA.js'),'utf8');
const cases=[];
const test=(name,fn)=>cases.push({name,fn});
const flat=node=>[node,...(node.children||[]).flatMap(flat)];
const el=(tag,attrs={},children=[])=>({tag,...attrs,children:children.flat(Infinity).filter(Boolean)});
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function transformSource(code){
  const anchor='      debugReadActiveCompletedTurnReceipt: async turnValue => {';
  assert.ok(code.includes(anchor));
  code=code.replace(anchor,`      debugReceiptDeskFixture: async (action,turn=1) => {
    const context=await resolveContext(true),pair=buildPairs(context.chat,context.scope.scopeKey)[turn-1];
    if(action==='persist')return persistCompletedTurnReceipt(context,pair,'completed_pair_reconcile',{deferInventory:true});
    if(action==='markUnknown'){
      const identity=receiptRecoveryIdentity(context,pair),job=state.receiptRecoveryJobs.get('receipt_'+digest(identity));
      job.status='pending_write';job.reason='write_outcome_unknown';job.writeOutcome='unknown';
      await persistReceiptRecoveryLedger(job);return receiptRecoveryMetadata(job);
    }
    if(action==='suppressed'){
      const identity=receiptRecoveryIdentity(context,pair);
      return state.receiptRecoveryJobs.get('receipt_'+digest(identity))?.suppressMicroResume===true;
    }
    return {scope:context.scope,boundary:await captureReceiptRecoveryBoundary(context,pair),
      missingTurns:[receiptRecoveryIdentity(context,pair)]};
  },\n`+anchor);
  const root='    debugBuildPairs(chat = {}, cacheKey = \'\')';assert.ok(code.includes(root));
  return code.replace(root,"    async debugReceiptDeskFixture(action,turn) { return await LibraMemoryCore.debugReceiptDeskFixture(action,turn); },\n"+root);
}
test('status exposes separate receipt and Micro stages without writes or model calls',async()=>{
  for(const mode of ['plugin_only','mirror','server_only']){
    const x=await serverFixture({mode,transformSource});
    try{
      const before=x.local.size,batches=x.batches.length,set=x.backend.setItem;let writes=0;
      x.backend.setItem=async(k,v)=>{writes++;return set(k,v);};
      const status=await x.f.r.api.getReceiptRecoveryStatus();
      assert.ok(Array.isArray(status.receiptStages),'current-scope receipt stage projection absent');
      assert.equal(status.receiptStages[0]?.status,'missing');
      assert.equal(status.microJobs.length,0);
      assert.equal(x.local.size,before,'status read must not write');
      assert.equal(writes,0,'status read must not rewrite an existing key');
      assert.equal(x.batches.length,batches,'status read must not submit server storage mutations');
      assert.equal(x.f.control.calls.length,0,'status read must not analyze');
    }finally{await x.cleanup();}
  }
});
test('manual storage recheck has a distinct explicit API',async()=>{
  const x=await serverFixture({mode:'plugin_only',transformSource});
  try{assert.equal(typeof x.f.r.api.recheckReceiptRecovery,'function');}
  finally{await x.cleanup();}
});
test('exhausted known failures need an explicit new cycle and retain prior attempts',async()=>{
  const x=await serverFixture({mode:'plugin_only',transformSource});
  try{
    const api=x.f.r.api,input=await api.debugReceiptDeskFixture('input');
    const timer=x.f.r.context.setTimeout;
    x.f.r.context.setTimeout=(fn,ms,...args)=>timer(fn,ms===1000||ms===3000?0:ms,...args);
    const originalSet=x.backend.setItem;let block=true,sourceWrites=0;
    x.backend.setItem=async(k,v)=>{
      if(k.includes(':source-receipt:')){sourceWrites++;if(block)return false;}
      return originalSet(k,v);
    };
    const q=await api.queueReceiptRecovery({...input,deferRun:true});
    const first=await api.runReceiptRecoveryJob({jobId:q.jobId});
    assert.equal(first.status,'failed');
    let job=(await api.getReceiptRecoveryStatus()).receiptJobs[0];
    assert.equal(job.reason,'attempts_exhausted');assert.equal(job.attempts,3);
    const before=sourceWrites;
    await api.queueReceiptRecovery(input);
    await new Promise(resolve=>setTimeout(resolve,10));
    job=(await api.getReceiptRecoveryStatus()).receiptJobs[0];
    assert.equal(job.cycle,1,'duplicate automatic event cannot open a new cycle');
    assert.equal(job.attempts,3);assert.equal(sourceWrites,before);
    block=false;
    const done=await api.recheckReceiptRecovery({scope:input.scope,turn:1});
    assert.equal(done.status,'verified');
    job=(await api.getReceiptRecoveryStatus()).receiptJobs[0];
    assert.equal(job.cycle,2);assert.equal(job.cycleHistory[0].attempts,3);
    assert.equal(job.cycleHistory[0].status,'failed');
    assert.equal(job.attempts,1);assert.equal(x.f.control.calls.length,0,'storage recheck cannot call Micro');
    const resumed=await x.restart();
    const durable=(await resumed.r.api.getReceiptRecoveryStatus()).receiptJobs[0];
    assert.equal(durable.cycle,2);assert.equal(durable.cycleHistory[0].attempts,3,
      'previous cycle survives a new runtime');
    assert.equal(resumed.control.calls.length,0);
  }finally{await x.cleanup();}
});
test('manual recheck of unknown write only reads back and never blindly reissues',async()=>{
  const x=await serverFixture({mode:'plugin_only',transformSource});
  try{
    const api=x.f.r.api,input=await api.debugReceiptDeskFixture('input');
    await api.queueReceiptRecovery({...input,deferRun:true});
    await api.debugReceiptDeskFixture('markUnknown');
    const before=x.local.size,set=x.backend.setItem;let receiptWrites=0;
    x.backend.setItem=async(k,v)=>{if(k.includes(':source-receipt:'))receiptWrites++;return set(k,v);};
    const result=await api.recheckReceiptRecovery({scope:input.scope,turn:1});
    assert.equal(result.status,'pending_write');
    assert.equal(result.reason,'write_outcome_unknown');
    assert.equal(x.local.size,before);assert.equal(receiptWrites,0,'unknown cannot reissue raw receipt');
    assert.equal(x.f.control.calls.length,0);
  }finally{await x.cleanup();}
});
test('manual recheck joins an active receipt write without another mutation or Micro call',async()=>{
  const x=await serverFixture({mode:'plugin_only',transformSource});
  try{
    const api=x.f.r.api,input=await api.debugReceiptDeskFixture('input');
    let release,entered;const held=new Promise(r=>release=r),started=new Promise(r=>entered=r);
    const originalSet=x.backend.setItem;let writes=0;
    x.backend.setItem=async(k,v)=>{
      if(k.includes(':source-receipt:')){writes++;entered();await held;}
      return originalSet(k,v);
    };
    const q=await api.queueReceiptRecovery({...input,deferRun:true});
    const original=api.runReceiptRecoveryJob({jobId:q.jobId});
    await started;
    const joined=api.recheckReceiptRecovery({scope:input.scope,turn:1});
    let suppressed=false;
    for(let i=0;i<100;i++){
      suppressed=await api.debugReceiptDeskFixture('suppressed');
      if(suppressed)break;
      await new Promise(resolve=>setTimeout(resolve,5));
    }
    release();
    assert.equal(suppressed,true,'manual join suppresses the Micro launch before write completes');
    assert.equal((await original).status,'verified');
    assert.equal((await joined).status,'verified');
    assert.equal(writes,1);assert.equal(x.f.control.calls.length,0);
  }finally{await x.cleanup();}
});
test('lost original and receipt remain visible as unrecoverable in current-scope status',async()=>{
  const x=await serverFixture({mode:'plugin_only',transformSource});
  try{
    const api=x.f.r.api,input=await api.debugReceiptDeskFixture('input');
    const q=await api.queueReceiptRecovery({...input,deferRun:true});
    x.f.chat.message=[];x.f.chat.messages=x.f.chat.message;
    assert.equal((await api.runReceiptRecoveryJob({jobId:q.jobId})).status,'unrecoverable');
    const status=await api.getReceiptRecoveryStatus({scope:input.scope});
    assert.equal(status.receiptStages[0].status,'unrecoverable');
    assert.equal(status.receiptStages[0].reason,'original_and_receipt_missing');
    assert.equal(x.f.control.calls.length,0);
  }finally{await x.cleanup();}
});
// The six-product GUI desk (buildApprovedMockupDesk) mounts the receipt/Micro
// recovery section; its card buttons open the approved recovery dialog, which
// re-reads status and dispatches through runBookReceiptRecoveryAction.
const sourceBetween=(start,end)=>{
  const a=source.indexOf(start),b=source.indexOf(end,a+start.length);
  assert.ok(a>=0&&b>a,`missing ${start} .. ${end}`);
  return source.slice(a,b);
};
function deskContext(api={}){
  const deskSource=sourceBetween('const bookReceiptRecoveryScopeKey =','const BOOK_NATIVE_SETTINGS_SECTIONS =');
  const current={scope:{scopeKey:'scope-A',characterId:'char-A',chatId:'chat-A'}};
  const dialogs=[];
  const c=vm.createContext({guiEl:el,Gui:{visible:true,bookPage:'desk',receiptDesk:null},dialogs,
    openApprovedRecoveryDialog:async(kind,row)=>{dialogs.push({kind,row});return true;},
    LibraMemoryCore:{peekSnapshot:()=>current,state:{worldManagerRuntimeMetaGeneration:0},
      getReceiptRecoveryStatus:async()=>({scopeKey:current.scope.scopeKey,receiptStages:[],microJobs:[]}),...api},
    buildBookHostLineagePanel:()=>el('div'),buildBookMemoryProgressPanel:()=>el('div'),
    buildBookDeskReaderProjection:()=>el('div'),queueGuiNavigationRender:()=>{},
    setTimeout,clearTimeout,Promise,Map,Set,Number,String,Object,Date,console});
  vm.runInContext(deskSource+'\nObject.assign(this,{buildBookDeskPanel:buildBookReceiptRecoveryPanel,buildBookReceiptRecoveryPanel,loadBookReceiptRecoveryStatus,runBookReceiptRecoveryAction,bookReceiptRecoveryState});',c);
  return {c,current};
}
test('desk renders independent receipt and Micro cards',async()=>{
  assert.match(sourceBetween('const buildApprovedMockupDesk =','const buildApprovedMockupMemory ='),
    /buildBookMemoryProgressPanel\(\), buildBookReceiptRecoveryPanel\(\)/,'desk mounts the receipt recovery section');
  const {c}=deskContext();
  const tree=c.buildBookDeskPanel();
  assert.ok(flat(tree).some(n=>n.tag==='section'&&n.dataset?.receiptRecoveryScope==='scope-A'),'desk stage cards absent');
  await tick();
});
test('desk renders failure, unrecoverable, OFF, unavailable and unknown with cost copy',async()=>{
  let reads=0,mutations=0;
  const status={scopeKey:'scope-A',receiptStages:[
    {scopeKey:'scope-A',turn:1,status:'failed',reason:'attempts_exhausted'},
    {scopeKey:'scope-A',turn:2,status:'unrecoverable',reason:'original_and_receipt_missing'},
    {scopeKey:'scope-A',turn:3,status:'running',reason:'joining_admitted_write'}],microJobs:[
    {scopeKey:'scope-A',turn:1,status:'failed',receiptRef:'r1',revisionId:'v1',sourceDigest:'d1'},
    {scopeKey:'scope-A',turn:2,status:'unknown',receiptRef:'r2',revisionId:'v2',sourceDigest:'d2'},
    {scopeKey:'scope-A',turn:3,status:'OFF'},
    {scopeKey:'scope-A',turn:4,status:'unavailable'},
    {scopeKey:'scope-A',turn:5,status:'queued'}]};
  const {c}=deskContext({getReceiptRecoveryStatus:async()=>{reads++;return status;},
    recheckReceiptRecovery:()=>{mutations++;},retryMicroAnalysis:()=>{mutations++;}});
  await c.loadBookReceiptRecoveryStatus();
  const tree=c.buildBookDeskPanel(),nodes=flat(tree),copy=nodes.map(n=>n.text||'').join(' ');
  assert.equal(nodes.filter(n=>n.dataset?.receiptTurn).length,3);
  assert.equal(nodes.filter(n=>n.dataset?.microTurn).length,5);
  for(const phrase of ['저장 실패','원문과 영수증을 찾을 수 없음','Micro 꺼짐',
    '분석 상태 확인 불가','이전 분석 결과 불명확','모델 호출 비용이 발생할 수 있음',
    '중복 비용이 발생할 수 있음'])assert.ok(copy.includes(phrase),phrase);
  assert.equal(nodes.some(n=>n.tag==='button'&&n.text==='저장 다시 확인'),true);
  assert.equal(nodes.some(n=>n.tag==='button'&&n.text==='Micro 분석 다시 시도'),true);
  assert.equal(nodes.find(n=>n.tag==='button'&&n.text==='복구 진행 중')?.disabled,true);
  assert.equal(nodes.find(n=>n.tag==='button'&&n.text==='분석 진행 중')?.disabled,true);
  assert.equal(reads,1);assert.equal(mutations,0,'render and read cannot reserve recovery or AI');
});
test('result-ready publication repair card clicks a model-free action and joins while busy',async()=>{
  let release,repairs=0,retries=0;
  const pending=new Promise(resolve=>{release=resolve;});
  const row={scopeKey:'scope-A',turn:1,status:'publish_ready',receiptRef:'r1',revisionId:'v1',sourceDigest:'d1'};
  const {c}=deskContext({getReceiptRecoveryStatus:async()=>({scopeKey:'scope-A',receiptStages:[],microJobs:[row]}),
    repairMicroPublication:async()=>{repairs++;return pending;},retryMicroAnalysis:async()=>{retries++;}});
  await c.loadBookReceiptRecoveryStatus();
  const card=flat(c.buildBookDeskPanel()).find(n=>n.dataset?.microTurn);
  const button=flat(card).find(n=>n.tag==='button');
  assert.equal(button?.disabled,false,'settled publication repair is clickable');
  assert.equal(button?.text,'Micro 발행 다시 확인');
  assert.doesNotMatch(flat(card).map(n=>n.text||'').join(' '),/비용|중복 비용/,
    'publication repair has no model cost warning');
  button.onClick();await tick();
  assert.equal(c.dialogs.length,1,'card click opens the approved recovery dialog');
  assert.equal(c.dialogs[0].kind,'micro');assert.equal(c.dialogs[0].row,row);
  assert.equal(repairs+retries,0,'opening the dialog alone cannot dispatch recovery');
  const dialog=sourceBetween('const openApprovedRecoveryDialog =','const recoveryRowIdentity =');
  assert.match(dialog,/same\.status==='publish_ready'\?'micro_publish':'micro_retry'/,
    'dialog dispatches publish_ready rows to the model-free publication repair');
  assert.match(dialog,/await runBookReceiptRecoveryAction\(action,same\)/);
  void c.runBookReceiptRecoveryAction('micro_publish',row);await tick();
  assert.equal(repairs,1);assert.equal(retries,0,'click must not start model retry');
  const busyCard=flat(c.buildBookDeskPanel()).find(n=>n.dataset?.microTurn);
  const busy=flat(busyCard).find(n=>n.tag==='button');
  assert.equal(busy?.disabled,true,'second click is disabled while repair is active');
  release({status:'verified'});await tick();await tick();
});
test('open desk refreshes background status by read-only timer',async()=>{
  let reads=0,mutations=0,stage='queued';const timers=[];
  const {c}=deskContext({getReceiptRecoveryStatus:async()=>{
    reads++;return {scopeKey:'scope-A',receiptStages:[{scopeKey:'scope-A',turn:1,status:stage}],microJobs:[]};
  },recheckReceiptRecovery:()=>{mutations++;},retryMicroAnalysis:()=>{mutations++;}});
  c.setTimeout=(callback,delay)=>{const timer={callback,delay,unref(){}};timers.push(timer);return timer;};
  c.clearTimeout=()=>{};
  await c.loadBookReceiptRecoveryStatus();
  assert.equal(reads,1);assert.equal(timers[0].delay,10000);
  stage='failed';timers[0].callback();await tick();await tick();
  assert.equal(reads,2);
  assert.equal(c.Gui.receiptDesk.status.receiptStages[0].status,'failed');
  assert.equal(mutations,0);
});
test('desk polling resumes once after a closed timer expires and the same scope reopens',async()=>{
  let reads=0;const timers=[];
  const {c}=deskContext({getReceiptRecoveryStatus:async()=>{
    reads++;return {scopeKey:'scope-A',receiptStages:[],microJobs:[]};
  }});
  c.setTimeout=(callback,delay)=>{const timer={callback:()=>{timer.fired=true;callback();},delay,cancelled:false,fired:false,unref(){}};timers.push(timer);return timer;};
  c.clearTimeout=timer=>{timer.cancelled=true;};
  await c.loadBookReceiptRecoveryStatus();
  assert.equal(reads,1);assert.equal(timers.length,1);
  c.Gui.bookPage='memory';timers[0].callback();await tick();
  assert.equal(reads,1);
  c.Gui.bookPage='desk';c.buildBookDeskPanel();await tick();await tick();
  assert.equal(reads,2,'reopened desk must refresh the same scope');
  assert.equal(timers.filter(timer=>!timer.cancelled&&!timer.fired).length,1,'one active poll timer');
});
test('persistent status read failure waits for bounded timer instead of render retry loop',async()=>{
  let reads=0;const timers=[];
  const {c}=deskContext({getReceiptRecoveryStatus:async()=>{reads++;throw Error('storage unavailable');}});
  c.setTimeout=(callback,delay)=>{const timer={callback:()=>{timer.fired=true;callback();},delay,cancelled:false,fired:false,unref(){}};timers.push(timer);return timer;};
  c.clearTimeout=timer=>{timer.cancelled=true;};
  await c.loadBookReceiptRecoveryStatus();
  for(let i=0;i<5;i++){c.buildBookDeskPanel();await tick();}
  assert.equal(reads,1,'render after failure must not immediately retry');
  assert.equal(timers[0]?.delay,10000);
  timers[0].callback();await tick();await tick();
  assert.equal(reads,2,'one bounded automatic retry after ten seconds');
  assert.equal(timers.filter(timer=>!timer.cancelled&&!timer.fired).length,1);
});
test('double click joins one retry, disables its button, and rejects an old-scope click',async()=>{
  let resolve,calls=0;
  const wait=new Promise(r=>resolve=r),row={scopeKey:'scope-A',turn:1,status:'unknown',
    receiptRef:'r1',revisionId:'v1',sourceDigest:'d1'};
  const {c,current}=deskContext({getReceiptRecoveryStatus:async()=>({scopeKey:current.scope.scopeKey,
    receiptStages:[],microJobs:[row]}),retryMicroAnalysis:async()=>{calls++;return wait;}});
  await c.loadBookReceiptRecoveryStatus();
  const one=c.runBookReceiptRecoveryAction('micro_retry',row);
  const two=c.runBookReceiptRecoveryAction('micro_retry',row);
  assert.equal(one,two);assert.equal(calls,1);
  const button=flat(c.buildBookDeskPanel()).find(n=>n.text==='분석 진행 중');
  assert.equal(button?.disabled,true);
  resolve({status:'verified'});await one;
  current.scope={scopeKey:'scope-B',characterId:'char-B',chatId:'chat-B'};
  await c.runBookReceiptRecoveryAction('micro_retry',row);
  assert.equal(calls,1,'old scope card cannot submit in a new chat');
});
test('late status from an old scope is never adopted by the new desk',async()=>{
  let resolve;
  const wait=new Promise(r=>resolve=r);
  const {c,current}=deskContext({getReceiptRecoveryStatus:()=>wait});
  const loading=c.loadBookReceiptRecoveryStatus();
  current.scope={scopeKey:'scope-B',characterId:'char-B',chatId:'chat-B'};
  c.bookReceiptRecoveryState();
  resolve({scopeKey:'scope-A',receiptStages:[{scopeKey:'scope-A',turn:1,status:'failed'}],microJobs:[]});
  await loading;
  assert.equal(c.Gui.receiptDesk.scopeKey,'scope-B');
  assert.equal(c.Gui.receiptDesk.status,null);
});
test('late retry result from an old scope is not shown in the new desk',async()=>{
  let resolve,calls=0;
  const wait=new Promise(r=>resolve=r),row={scopeKey:'scope-A',turn:1,status:'failed',
    receiptRef:'r1',revisionId:'v1',sourceDigest:'d1'};
  const {c,current}=deskContext({getReceiptRecoveryStatus:async()=>({scopeKey:current.scope.scopeKey,
    receiptStages:[],microJobs:[row]}),retryMicroAnalysis:async()=>{calls++;return wait;}});
  await c.loadBookReceiptRecoveryStatus();
  const task=c.runBookReceiptRecoveryAction('micro_retry',row);
  current.scope={scopeKey:'scope-B',characterId:'char-B',chatId:'chat-B'};
  c.bookReceiptRecoveryState();resolve({status:'verified'});await task;
  assert.equal(calls,1);assert.equal(c.Gui.receiptDesk.scopeKey,'scope-B');
  assert.equal(c.Gui.receiptDesk.status,null);
});
(async()=>{let failed=0;for(const {name,fn} of cases){try{await fn();console.log('PASS '+name);}catch(error){failed++;console.error('FAIL '+name,error);}}
 console.log(`RESULT ${cases.length-failed}/${cases.length} passed`);if(failed)process.exitCode=1;})().catch(error=>{console.error(error);process.exitCode=1;});

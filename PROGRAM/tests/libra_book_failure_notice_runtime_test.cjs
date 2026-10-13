'use strict';
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
const source=fs.readFileSync(process.env.LIBRA_TEST_PLUGIN||path.join(__dirname,'../plugins/LIBRA.js'),'utf8');
const part=(a,b)=>{const i=source.indexOf(a),j=source.indexOf(b,i);assert(i>=0&&j>i);return source.slice(i,j)};
const el=(tag,attrs={},children=[])=>({tag,...attrs,children:children.filter(Boolean)});
const flat=n=>[n,...(n.children||[]).flatMap(flat)];
let snapshot,queues=0,queuedReason='';
const buildBookMemoryModelSummary=()=>el('div',{'aria-label':'저장된 모델 설정'});
const ctx=vm.createContext({Gui:{bookMemoryFailureNotices:new Map()},LibraMemoryCore:{peekSnapshot:()=>snapshot,state:{},refreshSnapshot:async()=>{}},guiAsArray:v=>Array.isArray(v)?v:[],guiEl:el,guiLazyDetails:(a,h,fn)=>el('details',a,[h,...fn()]),libraMemoryFailureDiagnostic:e=>({title:'분석 실패',message:'새 분석을 시작해 주세요.',raw:String(e)}),queueGuiRender:(_delay,reason)=>{queues++;queuedReason=reason;},guiSetStatus:()=>{},LIBRA_SNAPSHOT_PAGE_LIMITS:{}});
ctx.buildBookMemoryModelSummary=buildBookMemoryModelSummary;ctx.buildBookJobSummary=()=>el('section');
vm.runInContext(part('const bookMemoryFailureKey =','const closeCanonicalRangeDrawer =')+require('./helpers/libra_approved_gui_contract.cjs').extract(source,'buildBookMemoryProgressPanel')+';Object.assign(globalThis,{bookMemoryFailureNotice,dismissBookMemoryFailureNotice,buildBookMemoryProgressPanel,runCanonicalGuiCommand});',ctx);
const failed=(start,run,at='2026-09-08T00:00:00Z')=>({startTurn:start,endTurn:start+4,runId:run,failedAt:at,error:'canonical_provider_budget_already_exhausted:ariadne'});
const initial=()=>({scope:{scopeKey:'A'},pairs:Array(12).fill({}),manifest:{failedBatches:{1:failed(1,'old1'),6:failed(6,'old2')}}});
const tree=()=>ctx.buildBookMemoryProgressPanel(),notice=n=>flat(n).find(n=>n.dataset?.memoryFailureNotice),summary=n=>flat(n).find(n=>n.dataset?.memoryFailureSummary);
const rows=[];async function test(name,fn){await fn();rows.push(name)}
(async()=>{
 await test('dismiss survives rerender and scope round trip, records remain identical',()=>{
  snapshot=initial();const stored=JSON.stringify(snapshot);const n=tree();assert(notice(n));flat(n).find(x=>x['aria-label']==='기억 생성 실패 안내 닫기').onClick();
  // Use the actual region selection gate; rebuilding the panel directly hid this bug.
  const renderer=require('./helpers/libra_approved_gui_contract.cjs').extract(source,'renderSettingsGuiOnce');
  assert.equal(queuedReason,'body','dismiss explicitly invalidates the visible main body');
  assert.match(renderer,/current\.replaceChildren\(\)/,'approved renderer replaces the active body on the queued refresh');
  for(let i=0;i<5;i++){assert(!notice(tree()));assert(summary(tree()));}
  snapshot={...initial(),scope:{scopeKey:'B'}};assert(notice(tree()));snapshot=initial();assert(!notice(tree()));assert.equal(JSON.stringify(snapshot),stored);
 });
 await test('new run with same error reopens; removing an old range does not reopen',()=>{
  delete snapshot.manifest.failedBatches[6];assert(!notice(tree()));snapshot.manifest.failedBatches[1]=failed(1,'new','2026-09-08T00:02:00Z');assert(notice(tree()));
 });
 await test('new analysis hides old notice before command begins',async()=>{
  snapshot=initial();ctx.Gui.bookMemoryFailureNotices.clear();let finish;const pending=ctx.runCanonicalGuiCommand('분석 시작',()=>{assert(!notice(tree()));return new Promise(resolve=>finish=resolve)});assert(!notice(tree()));finish({ok:true});await pending;assert(!notice(tree()));
 });
 await test('API job start hides old failures including late snapshot; new failure appears after finish',()=>{
  snapshot=initial();ctx.Gui.bookMemoryFailureNotices.clear();const job={scopeKey:'A',jobId:'new-job',kind:'cold_start',state:'running',startedAt:'2026-09-08T00:01:00Z'};ctx.LibraMemoryCore.state.canonicalJob=job;
  snapshot.manifest.failedBatches={};assert(!notice(tree()));snapshot=initial();assert(!notice(tree()));snapshot.manifest.failedBatches[1]=failed(1,'new','2026-09-08T00:02:00Z');assert(!notice(tree()));job.state='failed';assert(notice(tree()));
  ctx.dismissBookMemoryFailureNotice();assert(!notice(tree()));
 });
 await test('cancel/success cannot revive prior failures; other-scope job cannot suppress',()=>{
  snapshot=initial();for(const state of ['cancelled','completed']){ctx.LibraMemoryCore.state.canonicalJob.state=state;assert(!notice(tree()));}
  ctx.Gui.bookMemoryFailureNotices.clear();ctx.LibraMemoryCore.state.canonicalJob.scopeKey='B';assert(notice(tree()));
 });
 await test('latest failure uses time, not range insertion order',()=>{
  snapshot=initial();snapshot.manifest.failedBatches[1]=failed(1,'latest','2026-09-08T00:03:00Z');assert.equal(ctx.bookMemoryFailureNotice().latest.runId,'latest');
 });
 await test('no failures or unavailable scope leaves no warning or unfinished badge',()=>{
  snapshot=initial();snapshot.manifest.failedBatches={};assert(!notice(tree()));assert(!summary(tree()));snapshot=initial();snapshot.error='scope_unavailable';assert(!notice(tree()));assert(!summary(tree()));
 });
 await test('partial memories remain saved and visibly differ from failed ranges',()=>{
  snapshot=initial();snapshot.manifest.failedBatches={};snapshot.manifest.memories={'1':{status:'committed',pipelineStatus:'partial',turnRange:{start:1,end:5}}};
  const panel=tree(),progress=flat(panel).find(n=>n.dataset?.memoryStateProgress==='true');assert.match(progress.text,/저장된 기억 1개 · 1개 구간 부분 저장/);assert(!notice(panel));
 });
 await test('actual refusal diagnosis names the uncreated range and preserves dismiss behavior',()=>{
  ctx.libraMemoryFailureDiagnostic=vm.runInNewContext(part('const libraMemoryFailureDiagnostic =','const normalizeDraftPatchComparisonText =')+';libraMemoryFailureDiagnostic');
  ctx.LibraMemoryCore.state.canonicalJob=null;ctx.Gui.bookMemoryFailureNotices.clear();snapshot=initial();snapshot.manifest.failedBatches={6:{...failed(6,'declined'),error:'MODEL_DECLINED:explicit_text_refusal'}};
  const n=tree();assert(flat(n).some(x=>x.text==='모델 응답 거절 · 6–10턴 미생성'));assert(flat(n).some(x=>x.tag==='p'&&/기존에 저장된 기억은 유지/.test(x.text)));flat(n).find(x=>x['aria-label']==='기억 생성 실패 안내 닫기').onClick();assert(!notice(tree()));assert(summary(tree()));
 });
 assert(queues>0);console.log(JSON.stringify({test:'libra_book_failure_notice_runtime',passed:rows.length,scenarios:rows,method:'production functions with DOM boundary substitutes; not live RisuAI'}));
})().catch(e=>{console.error(e);process.exitCode=1});

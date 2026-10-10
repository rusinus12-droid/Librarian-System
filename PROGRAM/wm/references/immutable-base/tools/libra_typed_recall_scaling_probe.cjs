'use strict';
// Structural performance probe only: synthetic memories/3D vectors, no network.
const fs=require('fs'),path=require('path'),{performance}=require('perf_hooks'),{spawn}=require('child_process');
const {session}=require('./libra_typed_recall_live_adapter.cjs'),{provider}=require('./libra_typed_recall_queue_test.cjs'),{policy:basePolicy}=require('./libra_typed_recall_rollout_test.cjs'),{memoryEntry}=require('./libra_recall_test_runtime.cjs');
const root=path.resolve(__dirname,'..'),out=path.resolve(process.env.RECALL_SCALING_ROOT||path.join(root,'test-output/typed-recall/task6-scaling'));fs.mkdirSync(out,{recursive:true});
const arg=n=>{const i=process.argv.indexOf('--'+n);return i<0?null:process.argv[i+1];};
async function child(n,mode){
 const phases=[],result={n,mode,realModelCalls:0,providerDimension:3,evidence:'synthetic structural local cost; no semantic quality claim',phases},file=path.join(out,mode+'-'+n+'.json');
 const save=()=>fs.writeFileSync(file,JSON.stringify(result,null,2));let gets=0,sets=0;
 const timed=async(name,fn)=>{result.running=name;save();const started=performance.now(),g=gets,s=sets,e=r.context.__ENUMERATION_COUNT__||0;const value=await fn();phases.push({name,ms:performance.now()-started,gets:gets-g,sets:sets-s,canonicalEnumerations:(r.context.__ENUMERATION_COUNT__||0)-e,memory:process.memoryUsage()});result.running=null;save();return value;};
 const policy=basePolicy(),s=await session({provider:provider(),policy,countEnumeration:true,budget:{maxCalls:4,maxInputBytes:32768,maxInputTokens:32768,concurrency:1},live:false,sender:async()=>({ok:true,status:200,text:async()=>JSON.stringify({embeddings:[[1,.25,-.5]]})})}),r=s.runtime;
 const get=r.storage.getItem,set=r.storage.setItem;r.storage.getItem=async(...a)=>{gets++;return get(...a);};r.storage.setItem=async(...a)=>{sets++;return set(...a);};
 r.chat.localLore=r.chat.localLore.filter(e=>e.comment!=='lmai_memory');for(let i=0;i<n;i++){const entry=memoryEntry(4,'A kept the red ferry permit. An inspection agreement is pending.',8);entry.key='lmai_memory::scale-'+i;r.chat.localLore.push(entry);}
 result.loreBytes=Buffer.byteLength(JSON.stringify(r.chat.localLore));save();
 if(mode==='before'){const v=await timed('registered_beforeRequest',()=>s.beforeRequest('red ferry permit inspection agreement',{mode:'dual'}));result.queryCalls=v.calls.length;result.semanticReason=v.trace?.retrieval?.trace?.lanes?.semantic?.reason;result.retrievalReason=v.trace?.retrieval?.reason||v.trace?.retrieval?.trace?.reason;result.consumer=v.trace?.consumer?.ok;result.selected=v.trace?.consumer?.trace?.blocks.filter(b=>b.kind==='recall').length;await s.close();result.completed=true;save();return;}
 const char=await timed('canonical_character_read',()=>r.host.getCharacterFromIndex(0)),chat=await timed('canonical_chat_read',()=>r.host.getChatFromIndex(0,0));
 const snap=await timed('capture',()=>r.corpus.capture(char,chat,{currentTurn:10,viewerId:'main_request'}));
 const all=await timed('enumerate_representation_hash',()=>r.corpus.enumerate(snap,policy));
 const units=await timed('eligibility',()=>all.filter(u=>r.corpus.adapters[u.family].eligibility(u,snap).eligible));result.enumerated=all.length;result.eligible=units.length;
 const h=await timed('current_policy_index_open',()=>r.index.open(snap,provider(),policy));result.currentIndex=r.index.read(h,units).readiness;
 const coordinated=await timed('current_policy_coordinator',()=>r.context.__QUEUE_TEST__.dual.retrieve('red ferry permit inspection agreement',snap,provider(),policy));result.currentCoordinator={reason:coordinated.reason||coordinated.trace.reason,union:coordinated.trace.union,lanes:coordinated.trace.lanes};
 // A separate explicit performance fixture fits 3D rows; it does NOT remove any
 // production cap or imply that 1000 4096D rows fit the real storage reservation.
 const probe={...policy,maxCorpusUnits:8192,storage:{maxRowBytes:4096,maxJobBytes:8388608,maxExpectedBytes:33554432,maxExpectedRows:8192}},p=provider();
 const handle=await timed('probe_cold_index_open_no_rows',()=>r.index.open(snap,p,probe));result.probeCold=r.index.read(handle,units).readiness;
 if(units.length<=8192){
  const rows=units.map(u=>({schema:r.index.ROW_SCHEMA,scopeKey:snap.scopeKey,branchId:snap.branchId,identity:u.identity,family:u.family,subtype:u.subtype,locator:u.locator,contentHash:u.persistentContentHash,dependencyHash:u.persistentDependencyHash,representationVersion:u.representationVersion,sourceHash:r.index.sourceHash(u.text),provider:r.index.providerDescriptor(p),mode:p.documentMode,dimension:p.dimension,viewerId:snap.viewerId,vector:[1,.25,-.5],vectorChecksum:r.index.vectorChecksum([1,.25,-.5])}));
  result.publish=await timed('fixture_seed_strict_rows',()=>r.index.publish(handle,rows,snap));
  const warm=await timed('probe_warm_index_open_valid_rows',()=>r.index.open(snap,p,probe)),loaded=await timed('index_read',()=>r.index.read(warm,units));result.probeValid=loaded.rows.length;
  const hits=await timed('isolated_actual_cosine_expression',()=>loaded.rows.map(row=>{const v=row.vector,q=[1,.25,-.5],norm=Math.hypot(...v)*Math.hypot(...q);return{identity:row.identity,score:v.reduce((sum,x,i)=>sum+x*q[i],0)/norm};}));
  await timed('isolated_rank_sort',()=>hits.sort((a,b)=>b.score-a.score||a.identity.localeCompare(b.identity)));result.vectorComparisons=hits.length;
 }
 const heuristic=await timed('actual_preMMR_heuristic',()=>r.context.__QUEUE_TEST__.dual.searchHeuristic('red ferry permit inspection agreement',units,snap,probe));result.heuristic={status:heuristic.status,reason:heuristic.reason,returned:heuristic.hits.length,scanned:heuristic.trace.scanned,memory:heuristic.trace.memory};
 const lane={hits:units.slice(0,32).map(u=>({identity:u.identity}))},fused=await timed('actual_RRF',()=>r.context.__QUEUE_TEST__.dual.fuseRrf(lane,lane,{k:60}));
 const byId=new Map(units.map(u=>[u.identity,u])),diverse=await timed('actual_MMR',()=>r.context.__QUEUE_TEST__.dual.selectDiverse(fused.map(x=>({...x,unit:byId.get(x.identity)})),probe));result.fusionCandidates=fused.length;result.mmrCandidates=fused.length;result.mmrSelected=diverse.items.length;result.fakeProviderCalls=s.capture.calls.length;result.completed=true;await s.close();save();
}
async function parent(){const exits=[];for(const n of [100,1000,10000])for(const mode of ['stages','before']){const log=fs.openSync(path.join(out,mode+'-'+n+'.log'),'w'),started=performance.now(),p=spawn(process.execPath,[__filename,'--child',String(n),'--kind',mode],{cwd:root,stdio:['ignore',log,log],windowsHide:true});let expired=false;const timer=setTimeout(()=>{expired=true;p.kill();},mode==='stages'?30000:12000);const exit=await new Promise(resolve=>p.once('exit',(code,signal)=>resolve({code,signal})));clearTimeout(timer);fs.closeSync(log);const row={n,mode,...exit,wallMs:performance.now()-started,wallLimitExceeded:expired,realModelCalls:0};exits.push(row);fs.writeFileSync(path.join(out,'exits.json'),JSON.stringify(exits,null,2));console.log(JSON.stringify(row));}return exits;}
if(require.main===module){const n=arg('child');(n?child(Number(n),arg('kind')):parent()).then(()=>process.exit(0)).catch(e=>{console.error(e.stack);process.exit(1)});}

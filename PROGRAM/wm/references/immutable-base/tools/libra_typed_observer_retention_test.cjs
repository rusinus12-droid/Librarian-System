'use strict';
let completed=false;
process.on('beforeExit',()=>{if(!completed){console.error('OBSERVER_TEST_INCOMPLETE: assertions did not complete');process.exitCode=1;}});
// Actual-artifact resource regression. The heap graph, not primitive ===, proves
// sharing of large equal strings in the retained private observer snapshot.
const fs=require('node:fs'),path=require('node:path'),v8=require('node:v8'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {runtime}=require('./libra_typed_recall_queue_test.cjs');
const root=path.resolve(__dirname,'..'),artifact=path.resolve(process.argv[2]||path.join(root,'dist/LIBRA World Manager Full.js'));
const out=path.resolve(process.argv[3]||path.join(root,'test-output/typed-observer-retention'));fs.mkdirSync(out,{recursive:true});
const allFrozen=v=>!v||typeof v!=='object'||Object.isFrozen(v)&&Object.values(v).every(allFrozen);
(async()=>{
 assert.equal(typeof global.gc,'function','run with --expose-gc');
 const rollback=process.env.WM_OBSERVER_ROLLBACK==='1';
 const transformCode=code=>{
   if(!rollback)return code;
   const full=/last\s*=\s*copyRetainedObserver\(/g;
   if([...code.matchAll(full)].length===1)return code.replace(full,'last=TypedSemanticRuntime.copy(');
   // Terser inlines this single-use helper; replace only its exact private
   // recordCleanup body, retaining the same JSON input and assignment.
   const min=/recordCleanup:cleanup=>\{last=\(value=>\{[\s\S]*?\}\)\(\{\.\.\.last\|\|\{\},projectionCleanup:cleanup\}\)\}/g;
   assert.equal([...code.matchAll(min)].length,1,'rollback must hit actual Full or inlined Min retention once');
   return code.replace(min,'recordCleanup:cleanup=>{last=TypedSemanticRuntime.copy({...last||{},projectionCleanup:cleanup})}');
 };
 const r=await runtime(null,{admittedHost:true,dist:artifact,transformCode}),roll=r.context.__QUEUE_TEST__.rollout;
 const marker='WM_OBSERVER_LARGE_STRING_RESOURCE_REGRESSION_';
 let content=marker+'교차검증'.repeat(32768),entry={content,comment:'lmai_world_state'},shared={turnLog:[{turn:1,text:'preserved'}]};
 let units=Array.from({length:32},(_,i)=>({identity:String(i),unit:{entry,parentRecord:shared,record:{turn:i},text:'turn '+i}}));
 let record={__heapSnapshotObserverRootTag:'WM_OBSERVER_RESOURCE_ROOT',mode:'dual',retrieval:{union:units,selection:units.slice(0,8),requestGuard:()=>true},consumer:{kept:'full'}};
 if(process.argv[4])record={...JSON.parse(fs.readFileSync(process.argv[4],'utf8')),__heapSnapshotObserverRootTag:'WM_OBSERVER_RESOURCE_ROOT'};
 let strings=new Set();(function visit(v){if(typeof v==='string'&&v.length>=1024)strings.add(v);else if(v&&typeof v==='object')Object.values(v).forEach(visit);})(record);
 const expectedStringCount=strings.size;strings=null;
 const expected=JSON.stringify({...record,projectionCleanup:{status:'preserved'}});
 roll.record(record);assert.equal(roll.recordCleanup({status:'preserved'}),undefined);
 (()=>{const observed=roll.inspect().last;assert.equal(JSON.stringify(observed),expected);assert.ok(allFrozen(observed));assert.notEqual(observed,record);assert.notEqual(observed.retrieval.union[0].unit.entry,record.retrieval.union[0].unit.entry);})();
 content=entry=shared=units=record=null;
 await new Promise(setImmediate);global.gc();
 const snapshot=v8.writeHeapSnapshot(path.join(out,'retained.heapsnapshot'));
 const h=JSON.parse(fs.readFileSync(snapshot,'utf8')),nf=h.snapshot.meta.node_fields,nw=nf.length,no=Object.fromEntries(nf.map((s,i)=>[s,i])),nt=h.snapshot.meta.node_types[no.type];
 const ef=h.snapshot.meta.edge_fields,ew=ef.length,eo=Object.fromEntries(ef.map((s,i)=>[s,i])),et=h.snapshot.meta.edge_types[eo.type],N=h.nodes.length/nw;
 const starts=new Uint32Array(N+1);let end=0,roots=[];
 for(let i=0;i<N;i++){starts[i]=end;end+=h.nodes[i*nw+no.edge_count]*ew;for(let p=starts[i];p<end;p+=ew)if(et[h.edges[p+eo.type]]==='property'&&h.strings[h.edges[p+eo.name_or_index]]==='__heapSnapshotObserverRootTag'&&h.strings[h.nodes[h.edges[p+eo.to_node]+no.name]]==='WM_OBSERVER_RESOURCE_ROOT')roots.push(i);}starts[N]=end;
 assert.equal(roots.length,1,'exactly one retained observer root must survive');
 const backing=[],seen=new Set(),queue=[roots[0]];
 while(queue.length){const i=queue.pop();if(seen.has(i))continue;seen.add(i);const p=i*nw;if(nt[h.nodes[p+no.type]]==='string'&&h.strings[h.nodes[p+no.name]].length>=1024)backing.push({id:h.nodes[p+no.id],bytes:h.nodes[p+no.self_size]});for(let e=starts[i];e<starts[i+1];e+=ew){const type=et[h.edges[e+eo.type]],name=h.strings[h.edges[e+eo.name_or_index]];if(type!=='weak'&&name!=='__proto__'&&name!=='map')queue.push(h.edges[e+eo.to_node]/nw);}}
 const result={artifact,rollback,sha256:crypto.createHash('sha256').update(fs.readFileSync(artifact)).digest('hex'),realObserver:!!process.argv[4],expectedStringCount,retainedRootIndex:roots[0],copies:backing.length,totalBackingBytes:backing.reduce((s,v)=>s+v.bytes,0),backing,observerParity:true,artifactOnlyExportInstrumented:true,blockedTransports:globalThis.__finalDeliveryTransportAttempts||null};
 fs.writeFileSync(path.join(out,'RESULT.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
 assert.ok(expectedStringCount>0,'positive string-retention control');assert.equal(backing.length,expectedStringCount,'one physical long-string allocation per exact value in retained observer');
 completed=true;
})().catch(e=>{console.error(e);process.exitCode=1});

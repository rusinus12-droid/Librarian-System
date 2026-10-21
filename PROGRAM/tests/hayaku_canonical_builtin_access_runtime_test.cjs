'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),cp=require('node:child_process'),vm=require('node:vm'),crypto=require('node:crypto');
const {createHayakuRuntime,createStore,createValidPacket,hiddenPacketMessage,waitFor}=require('./fixtures/hayaku_runtime_harness.cjs');
const PROGRAM=path.resolve(__dirname,'..'),clone=value=>JSON.parse(JSON.stringify(value));
const BASES=['9ae0719b0b34f6fa69d2d156cfc04614199f7a86','a7c6e8ac9f88e5a5a5a72dba3e6787e9e587796e'],BASE_SHA='55c57dbfcf0a5885b81cea7e995ed61d09aaa6c7c5671e13fabceedae2a5d617',REL='Librarian-System/PROGRAM/plugins/HAYAKU_Locator_Continuity.js';
function readBaselineSource(){
 // Support ordinary package-root clones as well as the original monorepo.
 // Only the original commit and exact source hash qualify as the control.
 const packageRoot=path.resolve(PROGRAM,'..');
 const repo=cp.spawnSync('git',['-C',packageRoot,'rev-parse','--show-toplevel'],{encoding:'utf8'});
 const repoRoot=repo.status===0?repo.stdout.trim():packageRoot;
 for(const base of BASES)for(const relative of [REL,'PROGRAM/plugins/HAYAKU_Locator_Continuity.js']){
  let source;try{source=cp.execFileSync('git',['-C',repoRoot,'show',base+':'+relative],{maxBuffer:8e6,stdio:['ignore','pipe','pipe']});}catch(_){continue;}
  assert.equal(crypto.createHash('sha256').update(source).digest('hex'),BASE_SHA,'pinned canonical baseline source changed: '+base);
  return source.toString('utf8');
 }
 // The control exists only in the original monorepo history. Checkouts without those commits (shallow or rewritten clones)
 // cannot run the baseline comparison; a hash mismatch above still fails.
 return null;
}
const skipNoBaseline=t=>{const note='SKIP: pinned canonical baseline commits unavailable in this checkout: '+BASES.join(', ')+'; required source SHA256='+BASE_SHA;console.log(note);t.skip(note);};
const facts={BENCH_A0:'Aurora vault contains amethyst calibration spindle BENCH_A0.',BENCH_A1:'Aurora vault contains silver calibration spindle BENCH_A1.',BENCH_B0:'Borealis shelf contains cobalt tuning prism BENCH_B0.',BENCH_C0:'Cirrus case contains jade alignment ring BENCH_C0.',BENCH_FA:'Aurora vault contains foreign quartz spindle BENCH_FA.',BENCH_FB:'Borealis shelf contains foreign ruby prism BENCH_FB.',BENCH_FC:'Cirrus case contains foreign onyx ring BENCH_FC.'};
const packet=(turn,marker)=>{const p=createValidPacket({turn,summary:facts[marker]||'Routine archive entry '+turn+' has been recorded.',subject:'Archivist',scene:'archive'});p.world.world_rules=[{id:'fact-'+turn,summary:p.meta.summary_memory.summary}];return p;};
function messages(foreign=false){return Array.from({length:10},(_,i)=>{const turn=i+1,marker=turn===1?(foreign?'BENCH_FA':'BENCH_A0'):turn===5?(foreign?'BENCH_FB':'BENCH_B0'):turn===9?(foreign?'BENCH_FC':'BENCH_C0'):null,p=packet(turn,marker);return [{role:'user',chatId:'u'+turn,data:'Archive completed entry '+turn+'.'},{role:'assistant',chatId:'a'+turn,data:hiddenPacketMessage('Entry '+turn+' completed: '+p.meta.summary_memory.summary,p)}];}).flat();}
function expose(source){
 const edits=[];for(const name of ['normalizeStructuredScalarFields','normalizeBoundaryIdentifierFields']){const re=new RegExp('^  const '+name+'\\s*=\\s*','m'),m=re.exec(source);assert(m);const start=m.index+m[0].length,end=source.indexOf('\n  };',start);edits.push([start,"globalThis.__canonicalCounts.wrap('"+name+"',"],[end+4,')']);}
 for(const [at,text]of edits.sort((a,b)=>b[0]-a[0]))source=source.slice(0,at)+text+source.slice(at);
 source=source.replace('    globalThis.HAYAKU = exposedApi;', '    globalThis.__canonicalProbe={scalar:normalizeStructuredScalarFields,boundary:normalizeBoundaryIdentifierFields,packet:canonicalizePacketSchemaV2};\n    globalThis.HAYAKU = exposedApi;');
 return "globalThis.__canonicalCounts={rows:{},wrap(name,fn){return function(...args){const rows=globalThis.__canonicalCounts.rows;rows[name]=(rows[name]||0)+1;return fn(...args);};}};\n"+source;
}
const fixtures=[];let baseline,current;
async function runtime(source){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hayaku-canonical-builtin-')),file=path.join(dir,'plugin.js');fs.writeFileSync(file,expose(source));fixtures.push({dir,file});const store=createStore();await store.setItem('hayaku.v2.settings.source-tracking.v1',JSON.stringify({mode:'off',epoch:0}));const rows=messages(),h=await createHayakuRuntime({pluginSourceFile:file,pluginStorage:store,messages:rows,chatId:'benchmark-main',autoRepair:false,afterRequestAutoRepair:false,backgroundAutoRepair:false,failedRecoveryAutomation:'off',arguments:{hayaku_packet_recovery:'false'},llmResponder:async()=>{throw Error('FORBIDDEN_MODEL');}});await waitFor(()=>h.host.unloadHandlers.length>0,'complete install');h.hayaku._test.stopWorldlineTopologyObserver();return {h,rows};}
async function getBaseline(){if(!baseline){const source=readBaselineSource();if(!source)return null;baseline=await runtime(source);}return baseline;}
test.before(async()=>{current=await runtime(fs.readFileSync(path.join(PROGRAM,'plugins/HAYAKU_Locator_Continuity.js'),'utf8'));});
test.after(async()=>{await baseline?.h.dispose();await current?.h.dispose();for(const f of fixtures){fs.unlinkSync(f.file);fs.rmdirSync(f.dir);}});
test('canonical scalar and boundary helpers retain own-property, null, array and default behavior against pinned baseline',async t=>{
 if(!await getBaseline())return skipNoBaseline(t);
 const inherited=Object.assign(Object.create({summary:'inherited summary',owner:'inherited owner',hiddenFrom:['forbidden-inherited']}),{title:'own title',ownerEntityId:'Archivist',visibleToEntityIds:['Reader','Reader'],count:0,empty:'',nil:null,hasOwnProperty:'shadowed'});
 const fields=['summary','title','count','empty','nil','hasOwnProperty','missing'];
 for(const input of [null,undefined,[],['owner'],42,'text',{},inherited]){
  for(const name of ['scalar','boundary']){
   const a=baseline.h.context.__canonicalProbe[name](input,fields),b=current.h.context.__canonicalProbe[name](input,fields);
   if(input==null||Array.isArray(input)||typeof input!=='object')assert.equal(b,input);else assert.deepEqual(clone(b),clone(a));
  }
 }
 const normalized=current.h.context.__canonicalProbe.scalar(inherited,fields);assert.equal(Object.hasOwn(normalized,'summary'),false);assert.equal(normalized.title,'own title');assert.equal(normalized.nil,null);
 const boundary=current.h.context.__canonicalProbe.boundary(inherited);assert.equal(Object.hasOwn(boundary,'owner'),false);assert.equal(Object.hasOwn(boundary,'hiddenFrom'),false);
 assert.deepEqual(clone(current.h.context.__canonicalProbe.scalar({title:'own title'})),{title:'own title'});
});
for(const name of ['scalar','boundary'])test(name+' checks every requested field without per-field VM Object lookup',()=>{
 const h=current.h,originalObject=vm.runInContext('Object',h.context),own=originalObject.prototype.hasOwnProperty;let reads=0,checks=0;
 Object.defineProperty(h.context,'Object',{configurable:true,get(){reads++;return originalObject;}});originalObject.prototype.hasOwnProperty=function(key){checks++;return own.call(this,key);};
 try{
  const fields=Array.from({length:96},(_,i)=>'absent-'+i),output=h.context.__canonicalProbe[name]({unrelated:'preserved'},fields);
  assert.deepEqual(clone(output),{unrelated:'preserved'});assert.equal(checks,name==='scalar'?96:27,'every declared own-field check still executes');
  assert.ok(reads<=2,'Object builtin lookup must be bounded per invocation; observed '+reads+' reads');
 }finally{originalObject.prototype.hasOwnProperty=own;Object.defineProperty(h.context,'Object',{configurable:true,writable:true,value:originalObject});}
});
test('all canonical packet fields match the fixed base including explicit visibility boundaries',async t=>{
 if(!await getBaseline())return skipNoBaseline(t);
 for(let turn=1;turn<=10;turn++){
  const p=packet(turn,turn===1?'BENCH_A0':turn===5?'BENCH_B0':turn===9?'BENCH_C0':null);
  p.world.world_rules[0].visibility={privacy:'private',ownerEntityId:'Archivist',visibleToEntityIds:['Reader'],hiddenFrom:['Outsider']};
  assert.deepEqual(clone(current.h.context.__canonicalProbe.packet(clone(p))),clone(baseline.h.context.__canonicalProbe.packet(clone(p))));
 }
});
async function collectRuntimePhases(x,currentContract=false){
  const results=[];
  for(const phase of ['cold','warm','edit','scope-change']){
   if(phase==='edit'){const p=packet(1,'BENCH_A1');x.rows[1]={role:'assistant',chatId:'a1',data:hiddenPacketMessage('Entry 1 completed: '+p.meta.summary_memory.summary,p)};x.h.setMessages(x.rows);}
   if(phase==='scope-change'){x.rows=messages(true);x.h.chat.id=x.h.chat.chatId='benchmark-other';x.h.setMessages(x.rows);}
   x.h.context.__canonicalCounts.rows={};const before=JSON.stringify(x.rows),output=await x.h.callBeforeRequest([{role:'user',content:'Which archive entries are established?'}],'model');
   const context=output.filter(row=>row.memo==='hayaku-runtime-context-v3').map(row=>String(row.content||'')).join('\n'),markers=Object.keys(facts).filter(marker=>context.includes(marker)).sort();
   const routing=x.h.hayaku.lastDebug().localRecallSourceIndex.routing;
   assert.equal(routing.validationRawReads,10);assert.equal(routing.validationSources,10);assert.equal(routing.validationPolicy,'accepted_raw_source_scan_without_host_revision_certificate');
   if(phase==='edit'){
    if(currentContract){assert(markers.includes('BENCH_A0'),'passive edit preserves approved canon');assert.equal(markers.includes('BENCH_A1'),false,'pasted replacement is not authority to adopt new canon');}
    else{assert(markers.includes('BENCH_A1'));assert.equal(markers.includes('BENCH_A0'),false,'changed raw cannot retain its old admitted fact');}
   }
   if(phase==='scope-change'){assert(markers.includes('BENCH_FA'));assert.equal(markers.includes('BENCH_A1'),false,'foreign scope cannot reuse main-scope fact');}
   assert.equal(JSON.stringify(x.rows),before);assert.equal(x.h.llmCalls.length,0);assert.equal(x.h.fetchCalls.length,0);
   const expected=phase==='scope-change'?['BENCH_FA','BENCH_FB','BENCH_FC']:phase==='edit'&&!currentContract?['BENCH_A1','BENCH_B0','BENCH_C0']:['BENCH_A0','BENCH_B0','BENCH_C0'];
   assert.deepEqual(markers,expected,'current phase admits the exact established fact set');
   results.push({phase,markers,visits:clone(x.h.context.__canonicalCounts.rows)});
  }
  return results;
}
test('current runtime admits exact facts and rejects passive replacement and foreign-scope reuse without transport or host mutation',async()=>{
 await collectRuntimePhases(current,true);
});
test('canonical helper visits and frozen facts retain exact historical equivalence',async t=>{
 const control=await getBaseline();if(!control)return skipNoBaseline(t);
 const comparison=await runtime(fs.readFileSync(path.join(PROGRAM,'plugins/HAYAKU_Locator_Continuity.js'),'utf8'));
 try{assert.deepEqual(await collectRuntimePhases(comparison),await collectRuntimePhases(control),'canonical helper visits and final frozen marker sets remain exact');}finally{await comparison.h.dispose();}
});
test('current scalar and boundary helpers preserve own fields, reject inherited fields and handle nonobjects',()=>{
 const probe=current.h.context.__canonicalProbe;
 for(const input of [null,undefined,[],['owner'],42,'text'])for(const name of ['scalar','boundary'])assert.equal(probe[name](input),input);
 const own=Object.assign(Object.create({summary:'inherited',owner:'inherited',hiddenFrom:['inherited']}),{title:' own title ',nil:null,empty:'',ownerEntityId:'Archivist',visibleToEntityIds:['Reader','Reader'],hasOwnProperty:'shadowed'});
 const scalar=probe.scalar(own,['title','nil','empty','summary','missing','hasOwnProperty']);
 assert.equal(scalar.title,'own title');assert.equal(scalar.nil,null);assert.equal(Object.hasOwn(scalar,'empty'),false);
 assert.equal(Object.hasOwn(scalar,'summary'),false);assert.equal(Object.hasOwn(scalar,'missing'),false);assert.equal(scalar.hasOwnProperty,'shadowed');
 const boundary=probe.boundary(own);assert.equal(Object.hasOwn(boundary,'owner'),false);assert.equal(Object.hasOwn(boundary,'hiddenFrom'),false);
 assert.equal(boundary.ownerEntityId,'Archivist');assert.deepEqual(clone(boundary.visibleToEntityIds),['Reader']);
 assert.deepEqual(clone(probe.scalar({title:'own title'})),{title:'own title'});
});

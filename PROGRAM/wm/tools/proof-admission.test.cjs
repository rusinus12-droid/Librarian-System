'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),path=require('node:path');
const acorn=require('acorn');
const {runtime}=require('./libra_typed_recall_queue_test.cjs');
const {instrument:checksumInstrument,plain}=require('./checksum-fixture.cjs');
const root=path.resolve(__dirname,'..'),dist=process.env.WM_CHECKSUM_DIST||root+'/dist/LIBRA World Manager Full.js';
function instrument(source){
 const code=checksumInstrument(source),nodes=[],pending=[acorn.parse(code,{ecmaVersion:'latest'})];
 while(pending.length){const n=pending.pop();if(!n||typeof n!=='object')continue;nodes.push(n);for(const v of Object.values(n))if(Array.isArray(v))pending.push(...v);else if(v&&typeof v==='object')pending.push(v);}
 const uid=nodes.filter(n=>n.type==='VariableDeclaration'&&n.declarations.some(d=>d.id?.name==='uid'&&d.init?.params?.map(p=>p.name).join(',')==='scope,family,subtype,id'));assert.equal(uid.length,1);
 const calls=nodes.filter(n=>n.type==='CallExpression'&&n.callee?.object?.name==='TypedChecksumWitness'&&n.callee?.property?.name==='capture');assert.equal(calls.length,1);
 const edits=[{at:calls[0].start,text:'(globalThis.__ADMISSION_CAPTURES__++, '},{at:calls[0].end,text:')'},
 {at:uid[0].start,text:`globalThis.__ADMISSION_TEST__={run(entries,snapshot,fn){const previous=readPass;readPass={snapshot,entries:new Set(entries),parsed:new WeakMap(),proofs:checksumPass()};try{return fn({parse,signed,proofs:readPass.proofs});}finally{readPass=previous;}}};\n`}];
 let out=code;for(const e of edits.sort((a,b)=>b.at-a.at))out=out.slice(0,e.at)+e.text+out.slice(e.at);
 return 'globalThis.__ADMISSION_CAPTURES__=0;\n'+out;
}

test('native parse admits only usable own integrity metadata without changing validation',async t=>{
 const r=await runtime(null,{dist,transformCode:instrument}),x=r.context.__ADMISSION_TEST__,manager=r.api.IntegrityMetaManager;
 const snapshot={...r.snap({currentTurn:100})},context={domain:'world',scopeKey:snapshot.scopeKey};
 const entry=record=>Object.freeze({comment:'lmai_world_states',key:'lmai_world_states::test',content:JSON.stringify(record)});
 const unsigned=()=>({checksumBatchFixture:true,payload:{value:'UNCHANGED'}});
 const signed=()=>r.signed(unsigned(),'world','test');
 const reset=()=>{r.context.__ADMISSION_CAPTURES__=0;r.context.__CHECKSUM_OPS__.calls=0;r.context.__CHECKSUM_OPS__.validations=0;};
 const count=()=>r.context.__CHECKSUM_OPS__.calls;
 const withEntry=(record,run)=>{const e=entry(record),raw=e.content;reset();return x.run([e],snapshot,({parse,signed:validate,proofs})=>{const p=parse(e);const out=run(p,proofs,()=>validate(p,'world',snapshot),parse,e);assert.equal(e.content,raw,'canonical source bytes must remain unchanged');assert.equal(r.state.calls.length,0,'offline fixtures must not call a model');return out;});};
 for(const [label,meta]of [['missing',undefined],['null',null],['primitive',4],['array',[]],['integrity-missing',{}],['integrity-null',{integrity:null}],['integrity-array',{integrity:[]}],['schema-missing',{integrity:{}}],['schema-empty',{integrity:{schema:''}}],['schema-unsupported',{integrity:{schema:'future'}}],['schema-object',{integrity:{schema:{toString:'never'}}}]]){
  await t.test('unused '+label+' metadata consumes zero proof budget',()=>{
   const record=unsigned();if(meta!==undefined)record.meta=meta;
   withEntry(record,(p,proofs,validate)=>{assert.equal(r.context.__ADMISSION_CAPTURES__,0,'unsupported/legacy roots must not call general capture');assert.deepEqual(plain(proofs.budget),{nodes:4096,properties:32768});assert.equal(proofs.witnesses.has(p),false);const direct=manager.validateIntegrityMeta(p,context);assert.deepEqual(plain(validate()),plain(direct),'ordinary validation decision must still run');});
  });
 }
 await t.test('large legacy root leaves shared budget available for the later signed root',()=>{
  const legacy=entry({...unsigned(),padding:Array.from({length:4096},(_,i)=>({i}))}),later=entry(signed());reset();
  x.run([legacy,later],snapshot,({parse,signed:validate,proofs})=>{
   const old=parse(legacy);assert.equal(proofs.witnesses.has(old),false);assert.deepEqual(plain(proofs.budget),{nodes:4096,properties:32768});
   const p=parse(later);assert.equal(r.context.__ADMISSION_CAPTURES__,1);assert.equal(proofs.witnesses.has(p),true);assert.ok(proofs.budget.nodes>0&&proofs.budget.nodes<4096);assert.equal(validate(p,'world',snapshot).ok,true);assert.equal(validate(p,'world',snapshot).ok,true);assert.equal(count(),1,'usable signed root still shares its checksum');
  });
 });
 await t.test('supported root stays mutable and actual-use mismatch permanently revokes reuse',()=>{
  withEntry(signed(),(p,proofs,validate)=>{assert.equal(proofs.witnesses.has(p),true);assert.equal(Object.isFrozen(p),false);assert.equal(validate().ok,true);assert.equal(validate().ok,true);assert.equal(count(),1);p.payload.value='MUTATED';assert.equal(validate().reason,'checksum_mismatch');assert.equal(count(),2);p.payload.value='UNCHANGED';assert.equal(validate().ok,true);assert.equal(validate().ok,true);assert.equal(count(),4);assert.equal(proofs.witnesses.has(p),false);});
 });
 for(const start of ['legacy','unsupported'])await t.test(start+' root gaining integrity after parse remains a fresh-checksum path',()=>{
  const record=unsigned();if(start==='unsupported')record.meta={integrity:{schema:'future'}};
  withEntry(record,(p,proofs,validate,parse,e)=>{assert.equal(proofs.witnesses.has(p),false);manager.applyIntegrityMeta(p,context);reset();assert.equal(parse(e),p);assert.equal(validate().ok,true);assert.equal(validate().ok,true);assert.equal(count(),2,'late metadata never gains a witness');p.payload.value='MUTATED';assert.equal(validate().reason,'checksum_mismatch');assert.equal(count(),3);assert.equal(proofs.witnesses.has(p),false);});
 });
 for(const kind of ['context','checksum'])await t.test('late-added integrity cannot bypass '+kind+' callback mutation',()=>{
  withEntry(unsigned(),(p,proofs,validate)=>{manager.applyIntegrityMeta(p,context);let reads=0;const scope=snapshot.scopeKey,descriptor=Object.getOwnPropertyDescriptor(snapshot,'scopeKey');
   if(kind==='context')Object.defineProperty(snapshot,'scopeKey',{configurable:true,enumerable:true,get(){reads++;p.payload.value='CALLBACK_MUTATED';return scope;}});
   else{const sum=p.meta.integrity.checksum;Object.defineProperty(p.meta.integrity,'checksum',{configurable:true,enumerable:true,get(){reads++;p.payload.value='CALLBACK_MUTATED';return sum;}});}
   try{reset();const result=validate();assert.equal(result.reason,'checksum_mismatch');assert.equal(count(),1);assert.ok(reads>0);assert.equal(proofs.witnesses.has(p),false);}
   finally{Object.defineProperty(snapshot,'scopeKey',descriptor);}
  });
 });
 for(const key of ['meta','integrity','schema'])for(const accessor of [false,true])await t.test('inherited '+key+(accessor?' getter':' data')+' is not inspected during native parse',()=>{
  const record=unsigned();if(key==='integrity')record.meta={};if(key==='schema')record.meta={integrity:{}};
  const e=entry(record),proto=vm.runInContext('Object.prototype',r.context);let effects=0;
  const value=key==='meta'?{integrity:{schema:'libra.integrity_meta.v1',checksum:'BAD'}}:key==='integrity'?{schema:'libra.integrity_meta.v1',checksum:'BAD'}:'libra.integrity_meta.v1';
  const previous=Object.getOwnPropertyDescriptor(proto,key);Object.defineProperty(proto,key,accessor?{configurable:true,get(){effects++;return value;}}:{configurable:true,writable:true,value});
  try{reset();x.run([e],snapshot,({parse,signed:validate,proofs})=>{const p=parse(e);assert.equal(effects,0,'admission must not invoke inherited metadata accessors');assert.equal(r.context.__ADMISSION_CAPTURES__,0);assert.equal(proofs.witnesses.has(p),false);const direct=manager.validateIntegrityMeta(p,context),directEffects=effects;effects=0;const actual=validate(p,'world',snapshot);assert.deepEqual(plain(actual),plain(direct));if(key!=='meta')assert.equal(effects,directEffects,'schema/integrity getter count parity');else assert.ok(effects>=directEffects,'scope preflight retains its existing meta reads');});}
  finally{if(previous)Object.defineProperty(proto,key,previous);else delete proto[key];}
 });
 for(const key of ['meta','integrity','schema'])await t.test('custom parser own '+key+' accessor is never captured and keeps validator effects',()=>{
  const p=signed(),json=vm.runInContext('JSON',r.context),original=json.parse;let effects=0;
  const owner=key==='meta'?p:key==='integrity'?p.meta:p.meta.integrity,value=owner[key];Object.defineProperty(owner,key,{enumerable:true,configurable:true,get(){effects++;return value;}});
  const e=entry(unsigned());json.parse=()=>p;
  try{reset();x.run([e],snapshot,({parse,signed:validate,proofs})=>{assert.equal(parse(e),p);assert.equal(effects,0);assert.equal(r.context.__ADMISSION_CAPTURES__,0);assert.equal(proofs.witnesses.has(p),false);const direct=manager.validateIntegrityMeta(p,context);assert.equal(direct.ok,true);effects=0;const actual=validate(p,'world',snapshot);assert.deepEqual(plain(actual),plain(direct));assert.ok(effects>0);p.payload.value='MUTATED';assert.equal(validate(p,'world',snapshot).reason,'checksum_mismatch');});}
  finally{json.parse=original;}
 });
 await t.test('custom validator receives the original mutable record and proper receiver for skipped roots',()=>{
  withEntry(unsigned(),(p,proofs,validate)=>{const original=manager.validateIntegrityMeta;let seen=0;manager.applyIntegrityMeta(p,context);reset();manager.validateIntegrityMeta=function(record,c){assert.equal(this,manager);assert.equal(record,p);assert.equal(Object.isFrozen(record),false);seen++;record.payload.value='CUSTOM_MUTATED';return original(record,c);};try{assert.equal(validate().reason,'checksum_mismatch');assert.equal(validate().reason,'checksum_mismatch');assert.equal(seen,2);assert.equal(count(),2);assert.equal(proofs.witnesses.has(p),false);}finally{manager.validateIntegrityMeta=original;}});
 });
 await t.test('public enumeration skips large legacy graph capture and admits its signed narrative sibling',()=>{
  const graph={nodes:Array.from({length:4},(_,i)=>['n'+i,{id:'n'+i,name:'World '+i,parent:null,rules:{custom:{rule:'RULE '+i}}}]),padding:Array.from({length:4096},(_,i)=>({i}))};
  const narrative=r.signed({checksumBatchFixture:true,storylines:Array.from({length:2},(_,i)=>({id:'s'+i,name:'Story '+i,turns:[i+1],currentContext:'PUBLIC '+i}))},'narrative','narrative');
  const lore=[r.entry('lmai_world_graph','lmai_world_graph::test',graph),r.entry('lmai_narrative','lmai_narrative::test',narrative)];r.chat.localLore=lore;const raw=JSON.stringify(lore),s=r.snap({currentTurn:100});reset();
  const units=r.corpus.enumerate(s);assert.equal(units.filter(u=>u.family==='world').length,4);assert.equal(units.filter(u=>u.family==='narrative').length,2);assert.equal(r.context.__ADMISSION_CAPTURES__,1,'only signed narrative is admitted');assert.equal(JSON.stringify(lore),raw);assert.equal(r.state.calls.length,0);
 });
 await t.test('captured descriptor intrinsics cannot be replaced after initialization',()=>{
  const object=vm.runInContext('Object',r.context),get=object.getOwnPropertyDescriptor;let calls=0;
  const e=entry(signed());object.getOwnPropertyDescriptor=()=>{calls++;throw Error('replacement reflection must not run at parse admission');};
  try{reset();x.run([e],snapshot,({parse,proofs})=>{const p=parse(e);assert.equal(proofs.witnesses.has(p),true);assert.equal(calls,0);});}finally{object.getOwnPropertyDescriptor=get;}
 });
});

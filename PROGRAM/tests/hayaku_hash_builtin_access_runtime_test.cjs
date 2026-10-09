'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {createHayakuRuntime,createStore,createValidPacket,hiddenPacketMessage,waitFor}=require('./fixtures/hayaku_runtime_harness.cjs');
const sourceFile=path.resolve(__dirname,'../plugins/HAYAKU_Locator_Continuity.js');
function hashRuntime(){
 const source=fs.readFileSync(sourceFile,'utf8'),parts=[];
 for(const name of ['stableHash64Fallback','stableHash64']){
  const start=source.indexOf('  const '+name+' = '),end=source.indexOf('\n  };',start)+6;
  assert(start>=0&&end>start);parts.push(source.slice(start,end));
 }
 let mathReads=0;const context=vm.createContext({text:value=>String(value??''),BigInt});
 const builtin=vm.runInContext('Math',context);Object.defineProperty(context,'Math',{get(){mathReads++;return builtin;}});
 vm.runInContext(parts.join('\n')+'\nglobalThis.hash=stableHash64;',context);
 return {hash:context.hash,reads:()=>mathReads};
}
function fnvOracle(value){let hash=BigInt('14695981039346656037');for(let index=0;index<value.length;index++){hash^=BigInt(value.charCodeAt(index));hash=BigInt.asUintN(64,hash*BigInt('1099511628211'));}return 'h64'+hash.toString(36);}
test('HAY own hash retains exact UTF-16 identities for persisted proofs and changed raw bytes',()=>{
 const h=hashRuntime(),samples=['','archive','한글 Ω 中','🙂','\ud800','\udfff','a\u0000b'];let state=7321;
 for(let row=0;row<80;row++){let value='';for(let index=0;index<row*7;index++){state=(Math.imul(state,1664525)+1013904223)>>>0;value+=String.fromCharCode(state&0xffff);}samples.push(value);}
 for(const value of samples)assert.equal(h.hash(value),fnvOracle(value));
 const raw='Long immutable source observation. '.repeat(1600);
 assert.equal(h.hash(raw),fnvOracle(raw));assert.equal(h.hash(raw+'X'),fnvOracle(raw+'X'));assert.notEqual(h.hash(raw),h.hash(raw+'X'));
});
test('long raw hashing does not repeat VM builtin lookup for every validated character',()=>{
 const h=hashRuntime(),raw='Complete raw evidence remains fully validated. '.repeat(1200);
 assert.equal(h.hash(raw),fnvOracle(raw));
 assert.ok(h.reads()<=4,'per-call builtin lookup must remain bounded; observed '+h.reads()+' lookups for '+raw.length+' validated UTF-16 characters');
});
test('actual registered cold and warm hooks retain complete raw-source authority without a host revision',async()=>{
 const n=12,store=createStore();await store.setItem('hayaku.v2.settings.source-tracking.v1',JSON.stringify({mode:'off',epoch:0}));
 const messages=Array.from({length:n},(_,index)=>{const turn=index+1,p=createValidPacket({turn,summary:'Archive observation '+turn+' records an immutable distinct source.',subject:'Archivist',scene:'archive'});return [{role:'user',chatId:'u'+turn,data:'Archive entry '+turn+'.'},{role:'assistant',chatId:'a'+turn,data:hiddenPacketMessage('Completed archive entry '+turn+'.',p)}];}).flat();
 const h=await createHayakuRuntime({pluginSourceFile:sourceFile,pluginStorage:store,messages,autoRepair:false,afterRequestAutoRepair:false,backgroundAutoRepair:false,failedRecoveryAutomation:'off',arguments:{hayaku_packet_recovery:'false'},llmResponder:async()=>{throw Error('FORBIDDEN_MODEL');}});
 try{
  await waitFor(()=>h.replacers.has('beforeRequest'),'registered beforeRequest');h.hayaku._test.stopWorldlineTopologyObserver();
  const before=JSON.stringify(messages);
  for(const phase of ['cold','warm']){
   await h.callBeforeRequest([{role:'user',content:'Which archive observations are established?'}],'model');
   const routing=h.hayaku.lastDebug().localRecallSourceIndex.routing;
   assert.equal(routing.validationRawReads,n,phase+' validates every accepted raw source');assert.equal(routing.validationSources,n);
   assert.equal(routing.validationPolicy,'accepted_raw_source_scan_without_host_revision_certificate');assert.ok(routing.validationChars>n);
   assert.equal(JSON.stringify(messages),before);assert.equal(h.llmCalls.length,0);assert.equal(h.fetchCalls.length,0);
  }
 }finally{await h.dispose();}
});

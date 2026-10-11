'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {fixture}=require('./fixtures/libra_unified_runtime_fixture.cjs');
const {waitFor}=require('./fixtures/libra_vm_harness.cjs');
const {JSDOM}=require('jsdom');
const {observeNativeCleanup,settleNativeCleanup}=require('./fixtures/portable_native_cleanup_readiness.cjs');
const expose=source=>{
 source=observeNativeCleanup(source);
 const anchor='      getUnifiedStorageStatus,';assert.equal(source.split(anchor).length,2);
 source=source.replace(anchor,'      portableQueueProbe: () => ({canonical:state.queues.size,receipt:state.receiptQueues.size,micro:state.microQueues.size}),\n'+anchor);
 const api='    async getUnifiedStorageStatus() {';assert.equal(source.split(api).length,2);
 return source.replace(api,'    portableQueueProbe: () => LibraMemoryCore.portableQueueProbe(),\n'+api);
};
const hash=values=>crypto.createHash('sha256').update(JSON.stringify([...values].sort(([a],[b])=>a.localeCompare(b)))).digest('hex');
// The exact empty startup completion marker is global metadata, excluded from
// both the archive and dependency set. No other host mutation is permitted.
const emptyMarkerKey='libra:v1:local-vector-migration:48b4e542';
const withoutEmptyMarker=values=>new Map([...values].filter(([key])=>key!==emptyMarkerKey));
const assertEmptyMarker=value=>{
 if(value===undefined)return;
 const parsed=typeof value==='string'?JSON.parse(value):value;
 const {startedAt,finishedAt,...body}=JSON.parse(JSON.stringify(parsed));
 assert.deepEqual(body,{schema:'libra.embedding_vector_migration_marker.v1',pluginVersion:'2.3.149',targetSignature:'ec2917fe:1349',providerProfileId:'mep_a4ccc727f9674d23',reason:'embedding_startup_probe',scanned:0,candidates:0,migrated:0,alreadyCurrent:0,missingPayload:0,incompatibleSpace:0,failures:0,bytesPromoted:0,complete:true,errors:[],interrupted:false});
 assert(Number.isFinite(Date.parse(startedAt)));assert(Number.isFinite(Date.parse(finishedAt)));
};

test('portable export rejects an actual held Micro transaction, then exports its settled source without losing bytes',async()=>{
 let listener,release,started=false,input,dom;const f=await fixture({transformSource:expose,host:{addRisuChatListener:async(_kind,handler)=>{listener=handler;return true;}}});
 try{
  await settleNativeCleanup(f);
  assert.equal((await f.run()).completed,1);
  f.chat.message.push({role:'user',chatId:'t6-u',data:'정문을 확인한다.'},{role:'assistant',chatId:'t6-a',data:'도서관 정문이 열렸다.'});
  f.control.onCall=async args=>{input=JSON.parse(args[0].messages[1].content);started=true;await new Promise(r=>{release=r;});return{type:'success',result:JSON.stringify({schema:'libra.micro_producer_envelope.v1',personCandidates:{spans:[],relations:[]},micro:{schema:'libra.micro_memory.v1',...input.binding,claims:[]}})};};
  listener({char:f.character,chat:f.chat,characterIndex:0,chatIndex:0,messageIndex:11});
  await waitFor(()=>started,15000);assert(f.r.api.portableQueueProbe().micro>0,'the real producer is queued and held');
  const before=hash(f.r.values),portable=f.r.context.__LIBRAPortableMemoryBackup;
  await assert.rejects(portable.exportCurrentScope(),error=>error.code==='LIBRA_WORLD_MANAGER_BUSY');
  assert.equal(hash(f.r.values),before,'refused export performs no storage mutation');
  dom=new JSDOM('<div id="sga-rp-gui-root"><section class="sga-app" data-response-family="libra"><div data-portable-backup-host="libra"></div></section></div>');
  f.r.context.document=dom.window.document;
  const controls=portable.mountUi(dom.window.document.querySelector('[data-portable-backup-host]'));assert(controls);
  assert([...controls.querySelectorAll('button')].every(button=>button.disabled),'actual mounted portable controls explain and block the pending transaction');
  assert.match(controls.querySelector('[data-portable-status]').textContent,/기억.*작업/);
  release();release=null;
  await waitFor(()=>Object.values(f.r.api.portableQueueProbe()).every(n=>n===0),15000);
  portable.syncUi('');assert([...controls.querySelectorAll('button')].every(button=>!button.disabled),'settled transaction releases portable controls');
  const source=await f.r.api.debugReadActiveCompletedTurnReceipt(6);assert.equal(source.status,'verified');
  const settledValues=new Map(f.r.values),settledBytes=hash(withoutEmptyMarker(settledValues));
  assertEmptyMarker(settledValues.get(emptyMarkerKey));
  const envelope=await portable.exportCurrentScope();assert(envelope.records.length>0);
  assert(envelope.records.some(row=>row.key===source.receiptKey),'settled export includes the physically verified completed source');
  assertEmptyMarker(f.r.values.get(emptyMarkerKey));
  if(settledValues.has(emptyMarkerKey))assert(f.r.values.has(emptyMarkerKey),'completion marker cannot disappear');
  assert(!envelope.records.some(row=>row.key===emptyMarkerKey),'the permitted empty marker is not archived');
  assert(!envelope.inventory.dependencyKeys.includes(emptyMarkerKey),'the permitted empty marker is not an archive dependency');
  assert.equal(hash(withoutEmptyMarker(f.r.values)),settledBytes,'export preserves all settled source and canonical bytes and every other host key');
  const expectedPayload=new Map(envelope.records.map(row=>[row.key,settledValues.get(row.key)]));
  const actualPayload=new Map(envelope.records.map(row=>[row.key,row.value]));
  assert.equal(hash(actualPayload),hash(expectedPayload),'every exact exported payload value matches its settled source snapshot');
 }finally{release?.();await f.r.cleanup();dom?.window.close();}
});

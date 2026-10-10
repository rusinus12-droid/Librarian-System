'use strict';
// FEATURE-FIRST: basic supported-path smoke. Fault/race/all-writer qualification deferred.
const test=require('node:test'),assert=require('node:assert/strict'),{fixture}=require('./wm-writer-fixture.cjs');
test('wm_routed_bundle_basic_canonical_raw_cold_lineage',async t=>{const f=await fixture(t),r=f.runtime,source=await r.read('scope-a');assert.equal(source.ok,true);
const raw=await r.appendObserved({version:2,kind:'libra_raw_turn',scopeKey:'scope-a',canonicalScope:'scope-a',recordId:'record-a',recordKey:'record-key-a',requestId:'request-a',characterId:'char-a',chatId:'chat-a',resetGeneration:0,userText:'이야기 속 secret',assistantText:'🌍 원문',responseHash:'legacy-response',rawHash:'legacy-raw',userBytes:20,assistantBytes:12,captureSource:'fixture',observedAt:1,sourceCapture:{private:'kept in process only'},analysisStatus:'pending',status:'observed'});assert.equal(raw.ok,true);
const cold=await r.descriptor('cold','wm.cold-shard.v1','scope-a',JSON.stringify({schema:'wm.cold-shard.v1',scope:'scope-a',logicalId:'cold-content',raw:'전체 원문 🌍'}));assert.equal((await r.stageForScope('scope-a',[cold],source.sourceToken)).ok,true);
const canonical=JSON.stringify({version:1,scopeKey:'scope-a',entries:[],resetGeneration:0});const committed=await r.commit('scope-a',source.sourceToken,canonical,'normal');assert.equal(committed.ok,true);
const read=await r.read('scope-a');assert.equal(read.raw,canonical);
const coldRead=await r.readText('scope-a',cold.item.logicalId);assert.equal(coldRead.ok,true);assert.match(coldRead.raw,/전체 원문/);
const history=await r.markStatus(raw,{analysisStatus:'done',status:'committed',analysisFinishedAt:2});assert.equal(history.ok,true);
const lineage=await r.putWorldline('scope-a',{version:'libra_turn_worldline_v1',scopeKey:'scope-a',revision:1,nodes:[]},{expectedSource:r.latestSource('scope-a')});assert.equal(lineage.ok,true);
const after=await r.read('scope-a'),worldline=await r.findCompanion('scope-a','libra_turn_worldline_v1');assert.equal(worldline.ok,true);assert.equal(JSON.parse(worldline.raw).revision,1);assert.equal(after.raw,canonical);assert.deepEqual(f.nativeWrites,[]);
const scan=f.service.openInventory({routeGeneration:'route-1'}),page=f.service.readInventoryPage({snapshotId:scan.snapshotId,cursor:null,maxItems:128,maxBytes:262144});const all=[];for(const item of page.items){if(item.domain!=='canonical')all.push(f.service.readInventoryChunk({snapshotId:scan.snapshotId,logicalId:item.logicalId,offset:0,maxBytes:262144}).bytes.toString());}assert.equal(all.join('').includes('kept in process only'),false);f.service.closeInventory(scan.snapshotId);
});

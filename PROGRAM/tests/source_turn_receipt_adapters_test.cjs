'use strict';
const assert=require('node:assert/strict'), fs=require('node:fs'), path=require('node:path'),vm=require('node:vm');
const {test}=require('node:test');
const root=path.resolve(__dirname,'..');
const pure=fs.readFileSync(path.join(root,'sdk/MemorySuiteSourceTurnAccounting.source.js'),'utf8');
function adapter(file,name,next){const source=fs.readFileSync(path.join(root,'plugins',file),'utf8');const start=source.indexOf('const '+name+' =');const end=source.indexOf('const '+next+' =',start);assert.ok(start>=0&&end>start,name+' production seam exists');return vm.runInNewContext(pure+'\n'+source.slice(start,end)+'\n'+name);}
const fb=adapter('Flashback_Memory.js','flashbackFinalSourceTurnAccounting','publishFlashbackRecallDelivery');
const hay=adapter('HAYAKU_Locator_Continuity.js','hayakuFinalSourceTurnAccounting','publishHayakuRecallDelivery');
const plain=x=>JSON.parse(JSON.stringify(x));
function fbPlan(records){let text='';const fragments=[],choices=[];records.forEach((record,i)=>{const id='r'+i,start=text.length;const value=record.text||'evidence';text+=value;fragments.push({id,outputStart:start,outputEnd:text.length,state:record.state===true});choices.push({unit:{id,state:record.state===true,item:{record}},fragment:{text:value}});});return{text,fragments,choices};}
const response={sourceType:'response',scopeKey:'scope',logicalTurnId:'turn',turnNodeId:'node',variantId:'variant',lifecycleStatus:'active',text:'hello'};
test('Flashback deduplicates active response chunks; record, episode, inherited and state units stay separate and partial',()=>{
 let p=fbPlan([response,{...response,id:'other'}]);let result=plain(fb({},p,p.text));assert.equal(result.completeUniqueOriginalTurns,1);
 p=fbPlan([response,{...response,sourceType:'episode_index'}, {...response,turnNodeId:''}, {...response,state:true}]);result=plain(fb({},p,p.text));assert.equal(result.knownUniqueOriginalTurns,1);assert.equal(result.completeUniqueOriginalTurns,null);assert.equal(result.unresolvedUnits,3);
 assert.equal(result.identities[0].originalTurnId,JSON.stringify(['turn','node','variant']));
});
test('Flashback exact final ranges exclude stale and missing returned fragments',()=>{
 for(const record of [{...response,lifecycleStatus:'inactive_variant'},{...response,variantId:''},{...response,scopeKey:''}]){const p=fbPlan([record]);assert.equal(fb({},p,p.text).completeUniqueOriginalTurns,null);}
 const p=fbPlan([response]);assert.equal(fb({},p,'other').knownUniqueOriginalTurns,0);p.fragments[0].outputEnd+=1;assert.equal(fb({},p,p.text).knownUniqueOriginalTurns,0);
 const q=fbPlan([response]);q.choices[0].fragment.text='changed';assert.equal(fb({},q,q.text).knownUniqueOriginalTurns,0);
 assert.equal(fb({},null,'').completeUniqueOriginalTurns,0);
});
test('HAY packet ordinals and merged field sources remain unresolved without changing legacy quota',()=>{
 const result={text:'hello',fragments:[{id:'u',start:0,end:5}],plan:{units:[{id:'u',lane:'latest_state',origins:[{row:{locator:{worldlineOrdinal:4},projectionSources:{fields:{a:{packetHash:'p'}}}}}]}],temporalQuota:{delivered:{short:1}}}};
 const before=JSON.stringify(result);const receipt=plain(hay(result));assert.equal(receipt.completeUniqueOriginalTurns,null);assert.equal(receipt.knownUniqueOriginalTurns,0);assert.equal(receipt.lanes[0].lane,'core');assert.equal(JSON.stringify(result),before);
});
test('LIBRA common-engine source-turn accounting does not claim unresolved canonical ranges are original turns',async()=>{
 const {fixture}=require('./fixtures/libra_unified_runtime_fixture.cjs');const f=await fixture();try{await f.run();await f.control.hooks.beforeRequest([{role:'user',content:'은빛 열쇠'}],'model');const meta=f.r.api.getRuntime().lastMemoryInjectionMeta;assert.equal(meta.servedEngine,'unified');assert.equal(meta.sourceTurnAccounting.completeUniqueOriginalTurns,null);assert.equal(meta.finalVerification.status,'verified');}finally{await f.r.cleanup();}
});
test('confirmed empty HAY budget plan is complete zero; unavailable nonempty output cannot masquerade as empty',()=>{
 assert.equal(hay({text:'',renderedEntries:0}).completeUniqueOriginalTurns,0);
 assert.equal(hay({text:'nonempty'}).completeUniqueOriginalTurns,null);
 assert.equal(fb({},null,'nonempty').completeUniqueOriginalTurns,null);
});

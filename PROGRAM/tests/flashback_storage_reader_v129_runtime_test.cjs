'use strict';
const assert = require('node:assert/strict');
const {createFixture} = require('./fixtures/flashback_native_runtime_fixture.cjs');
(async()=>{const f=await createFixture();let passed=0;const ok=(value,label)=>{assert.ok(value,label);passed++;};try{
 const t=f.api._test, scope=await f.api.resolveCurrentScope();
 const cfg=t.normalizeSettings({embeddingProvider:'hash',hashDimensions:8,shardSize:50});
 const make=(i,extra={})=>({id:'raw-'+i,scopeKey:scope.scopeKey,sourceType:'response',sourceId:'turn:'+i,text:`User:\n질문 ${i}\n\n---\n\nAssistant:\n${'응답 원문 '.repeat(100)}본문 끝 토큰 ${i}`,title:'Turn '+i,pairIndex:i,turnIndex:i,vector:[1,0,0,0,0,0,0,0],dim:8,provider:'hash',model:'hash-8',createdAt:'2026-09-05T12:00:00Z',lifecycleStatus:'active',...extra});
 const snapshot=()=>JSON.stringify([...f.pluginStorage.values]);
 for(const state of ['active','provisional','quarantined','inactive_variant','detached_branch','orphaned','private']){
  const extra=state==='provisional'?{metadata:{captureAuthority:{provisional:true,liveConfirmed:false}}}:state==='private'?{privacyRestricted:true}:{lifecycleStatus:state};
  await t.saveAllRecords(Array.from({length:7},(_,i)=>make(i+1,extra)),cfg,scope);
  const manifest=await t.loadScopeManifest(scope.scopeKey), before=snapshot();
  const result=await f.api.listManualEditorRecords({scope,force:true});
  ok(result.total===7&&result.records.length===7,`${state}: seven stored originals are visible`);
  ok(result.issues.length===0&&!result.countMismatch,`${state}: no invented storage fault`);
  const original=await t.getManualEditorRecordText(result,result.records[0].key);
  ok(original===make(7).text,`${state}: full original beyond preview preserved`);
  ok(snapshot()===before,`${state}: inspection never writes storage`);
  if(state!=='active'){ok(manifest.shardSummaries.every(s=>!s.sourceTypes.includes('response')),`${state}: recall exclusion remains unchanged`);ok(result.records.every(r=>r.status.tone==='warning'),`${state}: visible excluded state`);}
 }
 await t.saveAllRecords(Array.from({length:171},(_,i)=>make(i+1)),cfg,scope);
 let result=await f.api.listManualEditorRecords({scope,force:true,limit:80});
 ok(result.records.length===80&&result.total===171&&result.hasMore,'bounded first page 80/171');
 result=await f.api.listManualEditorRecords({scope,force:true,limit:160});ok(result.records.length===160&&result.hasMore,'second page');
 result=await f.api.listManualEditorRecords({scope,force:true,limit:240});ok(result.records.length===171&&!result.hasMore,'last page ends');
 result=await f.api.listManualEditorRecords({scope,force:true,sort:'oldest'});ok(result.records[0].turnIndex===1,'oldest order');
 result=await f.api.listManualEditorRecords({scope,force:true,search:'본문 끝 토큰 171'});ok(result.total===1&&result.records[0].turnIndex===171,'search reads original beyond preview');
 result=await f.api.listManualEditorRecords({scope,force:true,search:'없는 문자열xyz'});ok(result.total===0&&!result.hasMore,'empty search is not storage failure');
 await t.saveAllRecords([make(1),make(2,{text:make(2).text+'길다'.repeat(100)})],cfg,scope);
 result=await f.api.listManualEditorRecords({scope,force:true,sort:'longest'});ok(result.records[0].turnIndex===2,'longest order');
 const stale=result;await t.saveAllRecords([make(3)],cfg,scope);
 await assert.rejects(()=>t.getManualEditorRecordText(stale,stale.records[0].key),/바뀌었습니다/);passed++;
 const manifest=await t.loadScopeManifest(scope.scopeKey);
 const shardKey=[...f.pluginStorage.values].find(([k,v])=>{try{const p=JSON.parse(v);return p.commitId===manifest.commitId&&Array.isArray(p.records);}catch(_){return false;}})?.[0];ok(!!shardKey,'real owner shard located');
 const raw=f.pluginStorage.values.get(shardKey);f.pluginStorage.values.delete(shardKey);
 result=await f.api.listManualEditorRecords({scope,force:true});ok(result.issues.length===1&&result.countMismatch&&!result.hasMore,'missing shard reported, no endless 0/N button');
 ok(t.renderManualEditorPanelHtml(result).includes('원문 목록 확인 필요'),'missing record visible warning');
 f.pluginStorage.values.set(shardKey,raw.slice(0,30));result=await f.api.listManualEditorRecords({scope,force:true});ok(result.issues[0].reason.includes('손상'),'corrupt shard explicit');
 f.pluginStorage.values.set(shardKey,raw);result=await f.api.listManualEditorRecords({scope,force:true});ok(result.records.length===1,'retry reads repaired storage, no empty-result cache');
 const injection='<img src=x onerror="globalThis.__rawExecuted=true">\n원문 끝';await t.saveAllRecords([make(4,{text:injection})],cfg,scope);
 result=await f.api.listManualEditorRecords({scope,force:true});ok(t.renderManualEditorPanelHtml(result).includes('&lt;img')&&!t.renderManualEditorPanelHtml(result).includes('<img src=x'),'preview HTML escaped');
 ok(await t.getManualEditorRecordText(result,result.records[0].key)===injection,'full text exact, rendered via textContent by UI');
 console.log(JSON.stringify({test:'flashback_storage_reader_v129_runtime',passed}));
}finally{await f.dispose();}})().catch(e=>{console.error(e);process.exitCode=1;});

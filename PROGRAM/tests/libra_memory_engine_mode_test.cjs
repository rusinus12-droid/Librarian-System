'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const policy=require('../tools/libra_memory_engine_mode.cjs');
const source=fs.readFileSync(path.join(__dirname,'../plugins/LIBRA.js'),'utf8');
test('unified is the only serving engine and unknown settings cannot select another engine',()=>{
 assert.deepEqual([...policy.MEMORY_ENGINE_MODES],['unified']);assert.equal(policy.DEFAULT_MEMORY_ENGINE_MODE,'unified');
 const d=policy.resolveMemoryEngineMode({});assert.equal(d.mode,'unified');assert.equal(d.source,'default');assert.equal(d.defaultApplied,true);
 assert.equal(d.qualification,'unqualified_until_E3_E4');assert.equal(d.retiredSelection,null);
 for(const v of ['fast','Unified','UNIFIED',1])assert.throws(()=>policy.resolveMemoryEngineMode({requestValue:v}),e=>e.code==='LIBRA_MEMORY_ENGINE_MODE_INVALID');
});
test('legacy and shadow inputs migrate with provenance and never reopen an old route',()=>{
 for(const old of ['legacy','shadow'])for(const source of ['requestValue','settingValue']){
  const d=policy.resolveMemoryEngineMode({[source]:old});assert.equal(d.mode,'unified');assert.equal(d.retiredSelection,old);
  assert.equal(d.source,source==='requestValue'?'request':'setting');
 }
 assert.equal(policy.resolveMemoryEngineMode({requestValue:'unified',settingValue:'legacy'}).retiredSelection,null);
 assert.equal(policy.normalizeMemoryEngineMode('',{fallback:'legacy'}),'unified');assert.equal(policy.normalizeMemoryEngineMode(' legacy '),'unified');
});
test('engine decision stamping preserves other diagnostics without claiming installation qualification',()=>{
 const result={diagnostics:{candidates:3}},decision=policy.resolveMemoryEngineMode({settingValue:'legacy'});
 assert.equal(policy.stampMemoryEngineDecision(result,decision),result);assert.equal(result.diagnostics.candidates,3);
 assert.equal(result.diagnostics.memoryEngine.mode,'unified');assert.equal(result.diagnostics.memoryEngine.retiredSelection,'legacy');
 assert.equal(policy.stampMemoryEngineDecision(null,decision),null);
});
test('embedded policy matches its module; changing the default fails the parity check',()=>{
 const block=s=>{const m=/\/\* LIBRA_MEMORY_ENGINE_MODE_POLICY:START \*\/([\s\S]*?)\/\* LIBRA_MEMORY_ENGINE_MODE_POLICY:END \*\//.exec(s);assert.ok(m);return m[1].split('\n').map(l=>l.trim()).filter(Boolean).join('\n');};
 const module=fs.readFileSync(path.join(__dirname,'../tools/libra_memory_engine_mode.cjs'),'utf8');
 assert.equal(block(source),block(module));assert.notEqual(block(source),block(module.replace("DEFAULT_MEMORY_ENGINE_MODE = 'unified'","DEFAULT_MEMORY_ENGINE_MODE = 'legacy'")));
});
test('production has no legacy ranker, catalog preparation or old final-delivery branch',()=>{
 for(const name of ['reciprocalRankFusion','scoreRankedRecallRows','loadOrRefreshRecallCatalog','scheduleRecallCatalogUpgrade','refreshMemoryNetworkIndex','gradiaRankedOwnerProfile','runLibraRecallBm25fLocal','validateLibraRecallBm25fResult','scheduleEvidenceLinkIndexUpgrade']){
  assert.equal(new RegExp('const\\s+'+name+'\\s*=').test(source),false,name);
 }
 for(const name of ['recallCatalogCache','recallCatalogBlockCache','microRecallHeadCache','memoryNetworkIndexes','recallCatalogUpgradeInFlight'])assert.equal(new RegExp(name+': new Map').test(source),false,name);
 const recall=source.slice(source.indexOf('const recall = async'),source.indexOf('const recallSectionLayer ='));
 assert.ok(recall.includes('executeMemoryGraphUnifiedQuery'));assert.ok(recall.includes('stampMemoryEngineDecision(unifiedResult'));
 assert.equal(recall.includes("if (unifiedEngineMode === 'unified')"),false);
 assert.equal(source.includes('block = renderClassicBlock('),false);
});

'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),test=require('node:test');
const source=fs.readFileSync(path.join(__dirname,'../src/parts/10a-recall-scoring-selection.js'),'utf8');
const end=source.indexOf('        // Recall Scoring V2 parity layer.');
assert(end>0);
const lane=new Function('TokenizerEngine','getSafeKey',source.slice(0,end)+';return buildHeuristicPreMmrLane;')(
 {tokenize:text=>String(text).toLowerCase().split(/\s+/).filter(Boolean)},entry=>entry.key);
const scored=(key,text,finalScore=1)=>({entry:{key},text,finalScore,accepted:true,similarity:.5,detail:{},exactAnchorHits:0,recallBucket:'event'});
const publicRows=[scored('public-a','orbit alpha',1.05),scored('public-b','orbit beta',1)];
const publicAdmission=hit=>({ok:hit.entry.key.startsWith('public-'),reason:'typed_admission'});
const view=result=>result.hits.map(x=>({key:x.entry.key,score:x.rawScore,rank:x.rank,distinctiveness:x.evidence.sourceDistinctiveness}));
for(const rejectedKind of ['hidden','exclusion','foreign','below-threshold'])test(`admission-rejected ${rejectedKind} candidates cannot change admitted scores/order`,()=>{
 const baseline=lane(publicRows,32,{},publicAdmission);
 const rejected=Array.from({length:40},(_,i)=>scored(rejectedKind+'-'+i,'orbit alpha',.1));
 const mixed=lane([...publicRows,...rejected],32,{},publicAdmission);
 assert.deepEqual(view(mixed),view(baseline));
 assert.equal(mixed.trace.typedRejected.length,rejected.length);
 assert.equal(mixed.trace.typedAdmittedCount,publicRows.length);
});
test('permuting rejected rows leaves admitted statistics unchanged',()=>{
 const rejected=Array.from({length:40},(_,i)=>scored('rejected-'+i,i%2?'orbit alpha':'orbit gamma',.1));
 assert.deepEqual(view(lane([...rejected,...publicRows],32,{},publicAdmission)),view(lane(publicRows,32,{},publicAdmission)));
});
test('all typed-rejected inputs produce no token work and no admitted lane',()=>{
 let tokenCalls=0;
 const isolated=new Function('TokenizerEngine','getSafeKey',source.slice(0,end)+';return buildHeuristicPreMmrLane;')(
  {tokenize:text=>{tokenCalls++;return String(text).split(/\s+/)}},entry=>entry.key);
 const result=isolated([scored('rejected','private unique marker')],32,{},()=>({ok:false,reason:'private'}));
 assert.equal(result.hits.length,0);assert.equal(result.trace.typedRejected.length,1);assert.equal(tokenCalls,0);
});

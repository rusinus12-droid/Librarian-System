'use strict';
const assert=require('node:assert/strict');const {createFixture}=require('./fixtures/flashback_native_runtime_fixture.cjs');
(async()=>{const f=await createFixture();try{const t=f.api._test,queries=['happy harbor','quiet harbor','remember the harbor','describe the harbor','현재 위치','기분과 장면','archive_2981'];
const types=queries.map(q=>t.classifyRecallQuery(q));assert.equal(new Set(types).size,1,'story vocabulary changes retrieval policy');
const settings=await f.api.loadSettings(),items=[{record:{id:'a',sourceType:'response',text:'The vessel remained at the harbor.',turnIndex:1},score:.8,components:{}}];
for(const q of queries){const selected=t.selectRecallByLanes(items,{...settings,topK:4},{currentUser:q,queryType:t.classifyRecallQuery(q)});assert.equal(selected.length,1,'candidate disappeared');assert.equal(selected[0].record.id,'a');}
console.log(JSON.stringify({cases:queries.length,queryPolicyIndependentOfStoryWords:true,evidenceRetained:true}));
}finally{await f.dispose();}})().catch(e=>{console.error(e.stack);process.exitCode=1;});

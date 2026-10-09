'use strict';
const assert=require('node:assert/strict');const {createFixture}=require('./fixtures/flashback_native_runtime_fixture.cjs');
(async()=>{const f=await createFixture();try{const t=f.api._test;let count=0;
for(const sourceType of ['response'])for(const stateUpdate of [undefined,false,true]){
const body='Orin: observatory.',record={id:'record',sourceType,scopeKey:'fixture',text:body,turnIndex:1,stateUpdate,structuredStateFacts:[{entity:'Orin',property:'location',value:'observatory',turn:1,evidenceText:body,evidenceStart:0,evidenceEnd:body.length}]};
const copy=JSON.parse(JSON.stringify(record)),state=t.buildLatestStateByEntity([copy]);
if(sourceType==='response'){assert.equal(state.size,1,'stored fact lost without a cue word');assert.equal([...state.values()][0].fact.value,'observatory');count++;}
}
const metadata={id:'metadata',sourceType:'response',turnIndex:2,text:'Orin: hall.',metadata:{}};
assert.equal(t.buildLatestStateByEntity([metadata]).size,0,'empty facts must not create state');
const k=f.api._selectionTest;for(const text of ['now changing','현재 수정','ordinary narrative'])assert.equal(k.extractRecallAnchors(text).stateUpdate,false,'query words do not establish a state update');
console.log(JSON.stringify({factCases:count,storedFactsPreserved:true,queryWordsDoNotCreateUpdate:true}));
}finally{await f.dispose();}})().catch(e=>{console.error(e.stack);process.exitCode=1;});


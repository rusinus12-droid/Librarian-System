'use strict';
const assert=require('node:assert/strict');const {createFixture}=require('./fixtures/flashback_native_runtime_fixture.cjs');
(async()=>{const f=await createFixture();try{const t=f.api._test;
const cases=['Where is Orin now?','Orin steht im observatorium','Orin’s emotional state','Orin 的位置是什么','Tell me about Orin'];
for(const q of cases)assert.equal(t.extractQueryStateProperties(q).size,0,'natural language must not select a property');
const unknown=[...t.extractQueryStateProperties('Orin: lokacija?')];assert.equal(unknown.length,0,'unknown language must not be misclassified');
console.log(JSON.stringify({cases:cases.length,naturalLanguageUnclassified:true,unknownLanguageUnclassified:true}));
}finally{await f.dispose();}})().catch(e=>{console.error(e.stack);process.exitCode=1;});

'use strict';
// Historical root retained; active contract is the embedded owner input policy.
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const code=fs.readFileSync(path.join(__dirname,'../sdk/MemorySuiteSourceInput.libra.source.js'),'utf8');
const plain=value=>JSON.parse(JSON.stringify(value));
function fixture({owner='libra',initial=null,writeReject=false,readbackBad=false}={}){
 const context=vm.createContext({setTimeout,clearTimeout,console});vm.runInContext(code,context);
 let stored=initial,busy=false,reads=0,writes=0;
 const api=context.createMemorySuiteSourceInputPolicy({owner,read:async()=>{reads++;return readbackBad&&writes?'{}':stored},write:async body=>{writes++;if(writeReject)return false;stored=body;return true},busy:()=>busy});
 return{api,context,busy:v=>busy=v,get stored(){return stored},counts:()=>({reads,writes}),project:text=>context.memorySuiteCanonicalSource(text,owner)};
}
const rules={version:1,ignoredTags:['decoration'],unwrapTags:['wrapper'],sourceTags:['original'],controls:[]};


test('concurrent explicit saves serialize through busy refusal and durable readback',async()=>{let bytes=null,release,entered;const gate=new Promise(r=>release=r),started=new Promise(r=>entered=r);const c=vm.createContext({});vm.runInContext(code,c);const api=c.createMemorySuiteSourceInputPolicy({owner:'libra',read:async()=>bytes,write:async body=>{entered();await gate;bytes=body;return true}});try{const first=api.setSourceRules(rules);await started;await assert.rejects(api.setSourceRules({ignoredTags:[]}),/BUSY/);release();await first;assert.deepEqual(plain(api.sourceRules()),rules);assert.deepEqual(JSON.parse(bytes).sourceRules,rules)}finally{release();api.dispose()}});
test('owner becomes busy while preferences load: no write and no partial policy',async()=>{let busy=false,writes=0,release;const gate=new Promise(r=>release=r),c=vm.createContext({});vm.runInContext(code,c);const api=c.createMemorySuiteSourceInputPolicy({owner:'hayaku',read:async()=>{await gate;return null},write:async()=>{writes++;return true},busy:()=>busy});try{const pending=api.setSourceRules(rules);busy=true;release();await assert.rejects(pending,/BUSY/);assert.equal(writes,0);assert.equal(c.memorySuiteCanonicalSource('raw','hayaku'),null)}finally{release();api.dispose()}});
test('disposed input cannot publish a policy after an awaited read',async()=>{let release,writes=0;const gate=new Promise(r=>release=r),c=vm.createContext({});vm.runInContext(code,c);const api=c.createMemorySuiteSourceInputPolicy({owner:'flashback',read:async()=>{await gate;return null},write:async()=>{writes++;return true}});const pending=api.setSourceRules(rules);api.dispose();release();await assert.rejects(pending,/SOURCE_INPUT_DISPOSED/);assert.equal(writes,0)});
for(const failure of ['writeReject','readbackBad'])test('failed '+failure+' keeps the prior effective rules',async()=>{const f=fixture({initial:JSON.stringify({sourceRules:rules}),[failure]:true});try{await f.api.ready();await assert.rejects(f.api.setSourceRules({ignoredTags:[]}),/SOURCE_INPUT_/);assert.equal(f.project('<original><wrapper>Alice waited.</wrapper></original>'),'Alice waited.')}finally{f.api.dispose()}});

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


for(const owner of ['libra','hayaku','flashback'])test(owner+' source policy retains owner and unknown metadata without transferred consent',async()=>{const initial=JSON.stringify({mode:'auto',epoch:2,ownerLabel:owner,custom:{sealed:'retained'},sourceRuleEpoch:4}),f=fixture({owner,initial});try{await f.api.ready();assert.equal(f.stored,initial);assert.equal('review' in f.api,false);assert.equal('applySelected' in f.api,false);await f.api.setSourceRules(rules);assert.equal(f.project('<original>Alice waited.</original>'),'Alice waited.');const saved=JSON.parse(f.stored);assert.equal(saved.ownerLabel,owner);assert.deepEqual(saved.custom,{sealed:'retained'});assert.equal(saved.sourceRuleEpoch,4);assert.equal(saved.epoch,2);assert.equal('tasks' in saved,false);assert.equal('events' in saved,false)}finally{f.api.dispose()}});

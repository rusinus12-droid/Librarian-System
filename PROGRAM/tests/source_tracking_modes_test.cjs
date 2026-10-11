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


for(const mode of ['auto','notify','silent','off','explicit_only'])test('historical '+mode+' is descriptive, no tracking controls or writes',async()=>{const original=JSON.stringify({mode,epoch:9,custom:'retained'}),f=fixture({initial:original});try{await f.api.ready();assert.equal(f.stored,original);assert.equal(f.counts().writes,0);assert.equal('setMode' in f.api,false);await f.api.setSourceRules(rules);const saved=JSON.parse(f.stored);assert.equal(saved.mode,mode);assert.equal(saved.custom,'retained');assert.equal(saved.epoch,9)}finally{f.api.dispose()}});
test('loading an old off setting cannot disable explicit input rules',async()=>{const f=fixture({initial:JSON.stringify({mode:'off'})});try{await f.api.setSourceRules(rules);assert.equal(f.project('<original>Alice waited.</original>'),'Alice waited.');assert.equal(JSON.parse(f.stored).mode,'off')}finally{f.api.dispose()}});

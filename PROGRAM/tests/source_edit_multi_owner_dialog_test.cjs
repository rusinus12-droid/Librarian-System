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


test('parallel owner input policies save independently without host consent',async()=>{const c=vm.createContext({});vm.runInContext(code,c);const stores=new Map(),make=owner=>c.createMemorySuiteSourceInputPolicy({owner,read:async()=>stores.get(owner),write:async body=>{stores.set(owner,body);return true}}),a=make('libra'),b=make('hayaku');try{await Promise.all([a.setSourceRules({ignoredTags:['decoration']}),b.setSourceRules({ignoredTags:['wrapper']})]);assert.equal(stores.size,2);assert.equal(c.memorySuiteCanonicalSource('A<decoration>B</decoration><wrapper>C</wrapper>','libra'),'A<wrapper>C</wrapper>');assert.equal(c.memorySuiteCanonicalSource('A<decoration>B</decoration><wrapper>C</wrapper>','hayaku'),'A<decoration>B</decoration>');assert.equal('review' in a,false);assert.equal('execute' in a,false);assert.equal('review' in b,false);assert.equal('execute' in b,false)}finally{a.dispose();b.dispose()}});

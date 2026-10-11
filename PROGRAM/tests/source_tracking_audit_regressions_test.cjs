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


test('warm projection uses new explicitly stored rules without source rewrites',async()=>{const f=fixture(),raw='Alice<decoration>UI</decoration>';try{await f.api.setSourceRules({ignoredTags:['decoration']});assert.equal(f.project(raw),'Alice');await f.api.setSourceRules({ignoredTags:[]});assert.equal(f.project(raw),raw);assert.equal(f.stored.includes('Alice'),false);assert.equal('inspect' in f.api,false);assert.equal('canWrite' in f.api,false,'input preferences are not an owner write permit')}finally{f.api.dispose()}});
test('unselected owner settings cannot change another owner projection',async()=>{const c=vm.createContext({});vm.runInContext(code,c);const db=new Map(),make=owner=>c.createMemorySuiteSourceInputPolicy({owner,read:async()=>db.get(owner),write:async body=>{db.set(owner,body);return true}}),a=make('libra'),b=make('hayaku');try{await a.setSourceRules({ignoredTags:['decoration']});await b.setSourceRules({ignoredTags:[]});const before=db.get('libra');await b.setSourceRules({ignoredTags:['wrapper']});assert.equal(db.get('libra'),before);assert.equal(c.memorySuiteCanonicalSource('A<decoration>B</decoration>','libra'),'A');assert.equal(c.memorySuiteCanonicalSource('A<decoration>B</decoration>','hayaku'),'A<decoration>B</decoration>')}finally{a.dispose();b.dispose()}});

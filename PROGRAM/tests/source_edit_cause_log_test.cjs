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

// Cause-history journals were retired. Current comparison uses exact projected
// input and reports malformed source selection without fabricated old excerpts.
for(const raw of ['<original></original>','<original>partial','<original>one</original><original>two</original>'])test('malformed source selection preserves original '+raw,async()=>{const f=fixture();try{await f.api.setSourceRules(rules);const result=f.context.memorySuiteProjectSourceRules(raw,f.api.sourceRules());assert.equal(result.text,raw);assert.ok(result.warnings.length);assert.equal(f.project(raw),raw);assert.equal(f.stored.includes(raw),false,'sample text is never written to preferences')}finally{f.api.dispose()}});
test('Unicode source retains full evidence without truncation or stored excerpts',async()=>{const f=fixture(),raw='한🧠'.repeat(140);try{await f.api.setSourceRules(rules);assert.equal(f.project('<original>'+raw+'</original>'),raw);assert.equal(f.stored.includes(raw),false);assert.equal(f.stored.includes('beforeExcerpt'),false);assert.equal(f.stored.includes('afterExcerpt'),false)}finally{f.api.dispose()}});
test('simultaneous policy and raw change projects only the current source',async()=>{const f=fixture();try{await f.api.setSourceRules(rules);const old='<original>Alice signed.</original>',edited='<original>Alice did not sign.<draft>outside</draft></original>';assert.equal(f.project(old),'Alice signed.');await f.api.setSourceRules({...rules,ignoredTags:['draft']});assert.equal(f.project(edited),'Alice did not sign.');assert.equal(f.stored.includes('Alice'),false)}finally{f.api.dispose()}});
test('cleared external policy preserves unknown narrative markup and strips only owned protocol',async()=>{const f=fixture();try{await f.api.setSourceRules({ignoredTags:[],unwrapTags:[],sourceTags:[],controls:[]});const raw='Alice <draft>signed</draft>.<hayaku_packet_contract>internal</hayaku_packet_contract>';assert.equal(f.project(raw),'Alice <draft>signed</draft>.');assert.equal(raw.includes('internal'),true)}finally{f.api.dispose()}});
test('different owner policy cannot authorize or overwrite another owner source',async()=>{const c=vm.createContext({});vm.runInContext(code,c);const stores=new Map(),make=owner=>c.createMemorySuiteSourceInputPolicy({owner,read:async()=>stores.get(owner),write:async body=>{stores.set(owner,body);return true}}),a=make('libra'),b=make('hayaku');try{await a.setSourceRules({ignoredTags:['draft']});await b.setSourceRules({ignoredTags:[]});assert.equal(c.memorySuiteCanonicalSource('A<draft>B</draft>','libra'),'A');assert.equal(c.memorySuiteCanonicalSource('A<draft>B</draft>','hayaku'),'A<draft>B</draft>');assert.equal(stores.size,2)}finally{a.dispose();b.dispose()}});

'use strict';
const assert=require('node:assert/strict'),{test}=require('node:test'),path=require('node:path');
const {load,memoryEntry}=require('./libra_recall_test_runtime.cjs');
const plain=x=>JSON.parse(JSON.stringify(x));let clones=[];
async function fixture(){return load({globals:{__entityClone198:entry=>clones.push(entry?.comment)},transformCode(code){
 const clone="const cloneData = (entry) => (entry && typeof entry === 'object') ? { ...entry } : entry;";assert.equal(code.split(clone).length,2);code=code.replace(clone,"const cloneData = (entry) => (globalThis.__entityClone198(entry),(entry && typeof entry === 'object') ? {...entry} : entry);");
 const seam="        const getShadow = (scopeKey = '') => {";assert.equal(code.split(seam).length,2);code=code.replace(seam,"        globalThis.__entityShadow198={seed(scope,rows,hydrated=true){shadow.set(scope,rows.map(entry=>({...entry})));if(hydrated)hydratedScopes.add(scope);else hydratedScopes.delete(scope);setActiveScope(scope);},snapshot(){return JSON.stringify([...shadow]);}};\n"+seam);
 const end=code.lastIndexOf('})();');return code.slice(0,end)+'\n;globalThis.__entityApi198={LibraLoreConsolidator,EntityManager};\n'+code.slice(end);
 }});}
const entity=(key,name,aliases=[],extra={})=>({key,comment:'lmai_entity',content:JSON.stringify({name,meta:{aliases,...extra}})});
test('entity fallback projects only shadow clones and preserves fresh lookup semantics',async()=>{
 const r=await fixture(),storeBefore=JSON.stringify([...r.store]);try{const P=r.context.__entityShadow198,{LibraLoreConsolidator:C,EntityManager:M}=r.context.__entityApi198;
 const memory=Array.from({length:2000},(_,i)=>memoryEntry(i+1,'ordinary memory '+i));
 const a=entity('a','Alice Finch',['Ali']),b=entity('b','Bob River',['Bobby']),malformed={key:'bad',comment:'lmai_entity',content:'{broken'},applied=entity('retired','Old Name',['Old'],{absorption:{status:'applied'}});
 const parity=(lore,options={})=>{const expected=plain(C.unpack(lore,options).filter(e=>e?.comment==='lmai_entity'));clones=[];const actual=C.unpack(lore,{...options,shadowEntryComment:'lmai_entity'});assert.deepEqual(plain(actual.filter(e=>e?.comment==='lmai_entity')),expected);assert.equal(clones.some(c=>c!=='lmai_entity'),false,'unselected shadow memories must not be cloned');return actual;};
 P.seed('projection-a',memory);const before=P.snapshot();parity([]);assert.equal(P.snapshot(),before);
 P.seed('projection-a',[...memory,a,b,malformed,applied,a]);parity([]);assert.equal(M.resolveCanonicalName('Ali'),'Alice Finch');
 // All local keys, including non-entity keys, suppress same-key shadow rows.
 parity([{key:'a',comment:'lmai_memory',content:'local owner masks entity'}]);
 const container={key:'LIBRA_DATA_fixture',comment:'lmai_entity_relations',memo:'LIBRA_CONTAINER',content:JSON.stringify({version:1,category:'lmai_entity_relations',entries:[entity('b','Local Bob',['Bobby']),memory[0],entity('dup','Local Dup'),entity('dup','Local Dup')]})};parity([container]);
 clones=[];C.withRawManagementRead(()=>parity([container]));assert.equal(clones.length,0);parity([container],{raw:true});assert.equal(clones.length,0);
 // A same-key shadow replacement and scope/hydration changes stay immediately visible.
 P.seed('projection-a',[...memory,entity('a','Alicia Current',['Ali'])]);assert.equal(M.resolveCanonicalName('Ali'),'Alicia Current');parity([]);
 P.seed('projection-b',[entity('a','Another Alice',['Ali'])]);assert.equal(M.resolveCanonicalName('Ali'),'Another Alice');parity([]);
 P.seed('projection-b',[a],false);assert.equal(M.resolveCanonicalName('Ali'),'Ali');parity([]);
 P.seed('projection-a',[...memory,a]);const projected=parity([]);projected[0].content='consumer mutation';assert.equal(M.resolveCanonicalName('Ali'),'Alice Finch','projected entry fields stay isolated');
 const invalid={...container,content:JSON.stringify({version:1,category:'lmai_entity_relations',entries:[null]})};assert.throws(()=>C.withRawManagementRead(()=>M.resolveCanonicalName('Somebody', [invalid])),error=>error?.name==='TypeError','malformed raw-container refusal is not silently repaired by the shadow projection');
 assert.equal(JSON.stringify([...r.store]),storeBefore,'projection test publishes no canonical storage');
 }finally{await r.close();}
});

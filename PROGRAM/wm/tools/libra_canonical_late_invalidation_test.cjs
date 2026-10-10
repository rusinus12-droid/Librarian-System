'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {runtime,flush}=require('./libra_typed_recall_queue_test.cjs');
const clone=x=>JSON.parse(JSON.stringify(x));
async function prepared(){const r=await runtime(null,{admittedHost:true}),ds=r.api.LibraDataStorage,scope=ds.scopeKeyFor(r.char,r.chat),key=ds.storageKeyFor(scope);
 const entries=clone((await ds.readVerified(scope)).entries);assert.equal((await ds.save(r.char,r.chat,entries)).ok,true);
 r.chat.localLore=clone(entries);r.storage.removeItem=async k=>{r.store.delete(k);return true;};
 let enter,release,written=false,held=false;const entered=new Promise(resolve=>enter=resolve),gate=new Promise(resolve=>release=resolve),get=r.storage.getItem,set=r.storage.setItem;
 r.storage.setItem=async(k,v)=>{const result=await set(k,v);if(k===key)written=true;return result;};
 r.storage.getItem=async k=>{const value=await get(k);if(k===key&&written&&!held){held=true;enter();await gate;}return value;};
 const changed=clone(entries);changed[0].content+=' changed during delayed readback';
 return {r,ds,scope,key,entries,changed,entered,release};
}
test('ordinary save cannot promote a captured readback after remove was requested',async()=>{
 const f=await prepared(),host=JSON.stringify(f.r.chat.localLore);const saving=f.ds.save(f.r.char,f.r.chat,f.changed);await f.entered;
 const removing=f.ds.remove(f.r.char,f.r.chat);await flush();f.release();
 const saved=await saving;assert.equal(saved.ok,false);assert.equal(await removing,true);
 assert.equal(f.r.store.has(f.key),false);assert.equal(f.ds.getShadowEntries(f.scope).length,0);assert.equal(JSON.stringify(f.r.chat.localLore),host);
 assert.equal(f.r.state.calls.length,0);
});
test('ordinary save cannot republish a runtime view invalidated during readback',async()=>{
 const f=await prepared(),host=JSON.stringify(f.r.chat.localLore);const saving=f.ds.save(f.r.char,f.r.chat,f.changed);await f.entered;
 f.ds.invalidateRuntimeView(f.scope);f.release();assert.equal((await saving).ok,false);
 assert.equal(f.ds.getShadowEntries(f.scope).length,0);assert.equal(JSON.stringify(f.r.chat.localLore),host);assert.equal(f.r.state.calls.length,0);
});
test('a genuinely refreshed reset proof during delayed readback prevents old shadow promotion',async()=>{
 const f=await prepared(),host=JSON.stringify(f.r.chat.localLore);const saving=f.ds.save(f.r.char,f.r.chat,f.changed);await f.entered;
 const heldPayload=f.r.store.get(f.key);
 const other=await runtime({store:f.r.store,cache:f.r.cache,lore:[]},{admittedHost:true});
 // This is a second runtime's real reset API; it does not grant cross-runtime CAS.
 // Its fixture initialization overwrites the initial legacy envelope, so restore
 // the held writer's actual current bytes before performing the reset.
 f.r.store.set(f.key,heldPayload);
 assert.equal((await other.api.LibraDataStorage.resetVerified(f.scope,{expectedGeneration:0,isCurrent:async()=>true})).ok,true);
 const admission=await f.ds.preparePersonaContext(f.r.char,f.r.chat);assert.equal(admission.ok,true);assert.equal(admission.resetGeneration,1);
 assert.equal(f.ds.publishVerifiedView(f.r.char,f.r.chat,f.scope,admission.entries).ok,true);
 f.release();const saved=await saving;assert.equal(saved.ok,false);assert.equal(saved.reason,'reset_generation_changed');
 assert.equal(f.ds.getShadowEntries(f.scope).length,0);assert.equal(JSON.stringify(f.r.chat.localLore),host);assert.equal(JSON.parse(f.r.store.get(f.key)).resetGeneration,1);
 assert.equal(f.r.state.calls.length+other.state.calls.length,0);
});

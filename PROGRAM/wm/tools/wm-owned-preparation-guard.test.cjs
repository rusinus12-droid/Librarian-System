'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {fixture,seed,SIZE}=require('./wm-chunk-storage-fixture.cjs');
// Removing the real wrapper's optional currentness checks must fail these
// controls. The synthetic host only determines when ownership changes.
const unchanged=f=>JSON.stringify([...f.values]);
const refused=(promise,issued)=>assert.rejects(promise,error=>error.message==='storage_write_invalidated'&&error.storageWriteUnverified===issued);
for(const guard of [false,undefined,null,()=>false,()=>({then(){}}),()=>{throw Error('stale');}]) test('explicit invalid guard refuses without physical I/O: '+String(guard),async()=>{
 const f=await fixture();seed(f);const before=unchanged(f);f.operations.length=0;
 await refused(f.api.setItem('target','new',{strict:true,isCurrent:guard}),false);
 assert.equal(unchanged(f),before);assert.deepEqual(f.operations,[]);
});
for(const size of [10,SIZE+100]) test('ownership loss during previous root read prevents writes '+size,async()=>{
 const f=await fixture();seed(f);const before=unchanged(f),get=f.raw.getItem;let current=true;
 f.raw.getItem=async key=>{const value=await get(key);current=false;return value;};
 await refused(f.api.setItem('target','n'.repeat(size),{strict:true,isCurrent:()=>current}),false);
 assert.equal(unchanged(f),before);assert(!f.operations.some(([op])=>op!=='get'));
});
for(const phase of ['ack','readback']) test('staging '+phase+' invalidation cleans only this attempt before root issue',async()=>{
 const f=await fixture(),old=seed(f);f.values.set('other','KEEP');const before=unchanged(f),get=f.raw.getItem,set=f.raw.setItem;let current=true;
 f.raw.setItem=async(key,value)=>{const result=await set(key,value);if(phase==='ack'&&key.includes('::chunk:')&&!old.chunks.includes(key))current=false;return result;};
 f.raw.getItem=async key=>{const value=await get(key);if(phase==='readback'&&key.includes('::chunk:')&&!old.chunks.includes(key))current=false;return value;};
 await refused(f.api.setItem('target','n'.repeat(SIZE*2+100),{strict:true,isCurrent:()=>current}),false);
 assert.equal(unchanged(f),before);assert(!f.operations.some(([op,key])=>op==='set'&&key==='target'));
 assert.equal(f.operations.filter(([op])=>op==='remove').length,1,'only staged key from this attempt is removed');
});
for(const size of [10,SIZE+100])for(const phase of ['ack','readback'])test('issued root '+phase+' invalidation preserves old and possibly referenced chunks '+size,async()=>{
 const f=await fixture(),old=seed(f),get=f.raw.getItem,set=f.raw.setItem;let current=true,issued=false;
 f.raw.setItem=async(key,value)=>{const result=await set(key,value);if(key==='target'){issued=true;if(phase==='ack')current=false;}return result;};
 f.raw.getItem=async key=>{const value=await get(key);if(phase==='readback'&&issued&&key==='target')current=false;return value;};
 const next='n'.repeat(size);await refused(f.api.setItem('target',next,{strict:true,isCurrent:()=>current}),true);
 assert(old.chunks.every(key=>f.values.has(key)),'prior chunks are not cleaned after ownership loss');
 assert(!f.operations.some(([op])=>op==='remove'));
 assert.equal(await f.api.getItem('target',{strict:true}),next,'all chunks referenced by an issued root survive');
});
test('current and omitted guards retain ordinary verified write behavior',async()=>{
 const f=await fixture();seed(f);assert.equal(await f.api.setItem('target','current',{strict:true,isCurrent:()=>true}),true);
 assert.equal(await f.api.getItem('target',{strict:true}),'current');
 assert.equal(await f.api.setItem('target','ordinary',{strict:true}),true);assert.equal(await f.api.getItem('target',{strict:true}),'ordinary');
});
for(const phase of ['cleanup_root_read','cleanup_remove_ack'])test('ownership loss during prior-generation cleanup stops further removals '+phase,async()=>{
 const f=await fixture(),old=seed(f),get=f.raw.getItem,remove=f.raw.removeItem;let current=true,rootReads=0;
 f.raw.getItem=async key=>{const value=await get(key);if(key==='target'&&++rootReads===3&&phase==='cleanup_root_read')current=false;return value;};
 f.raw.removeItem=async key=>{const value=await remove(key);if(phase==='cleanup_remove_ack'&&key===old.chunks[0])current=false;return value;};
 await refused(f.api.setItem('target','new',{strict:true,isCurrent:()=>current}),true);
 assert.equal(f.values.get('target'),'new');assert(f.values.has(old.chunks[1]));
 assert.equal(f.operations.filter(([op])=>op==='remove').length,phase==='cleanup_root_read'?0:1);
});
for(const kind of ['false','throw'])test('one-shot cleanup invalidation remains terminal '+kind,async()=>{
 const f=await fixture(),old=seed(f),get=f.raw.getItem;let rootReads=0,refuseOnce=false;
 f.raw.getItem=async key=>{const value=await get(key);if(key==='target'&&++rootReads===3)refuseOnce=true;return value;};
 const isCurrent=()=>{if(!refuseOnce)return true;refuseOnce=false;if(kind==='throw')throw Error('one-shot ownership loss');return false;};
 await refused(f.api.setItem('target','new',{strict:true,isCurrent}),true);
 assert.equal(f.values.get('target'),'new');assert(old.chunks.every(key=>f.values.has(key)));assert(!f.operations.some(([op])=>op==='remove'));
});

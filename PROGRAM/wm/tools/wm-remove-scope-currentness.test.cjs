'use strict';
const assert=require('node:assert/strict'),{test}=require('node:test'),path=require('node:path');
const {fixture,SIZE}=require('./wm-chunk-storage-fixture.cjs');
for(const phase of ['queued','admission'])test('remove refuses identity change during '+phase+' without deleting captured scope',async()=>{
 const f=await fixture(),s=f.r.api.LibraDataStorage,scope=s.scopeKeyFor(f.r.char,f.r.chat),key=s.storageKeyFor(scope),old=JSON.stringify({version:'1.0',scopeKey:scope,resetGeneration:0,entries:[{key:'keep',comment:'lmai_fixture',content:'keep captured scope'}]});f.values.set(key,old);
 let result;
 if(phase==='queued'){
  let release,entered;const barrier=new Promise(r=>release=r),staged=new Promise(r=>entered=r),set=f.raw.setItem;let first=true;
  f.raw.setItem=async(k,v)=>{if(first&&k.startsWith(key+'::chunk:')){first=false;entered();await barrier;}return set(k,v);};
  const rows=[{key:'held',comment:'lmai_fixture',content:'a'.repeat(SIZE+99)}],write=s.saveVerified(scope,rows,{isCurrent:()=>true,expectedGeneration:0});await staged;
  const remove=s.remove(f.r.char,f.r.chat);f.r.chat.id='different-chat';release();assert.equal((await write).ok,true);result=await remove;
 }else{
  const get=f.raw.getItem;let changed=false;f.raw.getItem=async k=>{if(!changed&&k==='WMManual::route::v1'){changed=true;f.r.chat.id='different-chat';}return get(k);};result=await s.remove(f.r.char,f.r.chat);assert.equal(changed,true,'actual admission storage seam reached');
 }
 console.log(JSON.stringify({phase,result,rootPresent:f.values.has(key),removals:f.operations.filter(x=>x[0]==='remove'&&x[1]===key).length}));
 assert.equal(result?.ok,false,'stale removal is refused');assert.equal(result.reason,'stale_identity');assert(f.values.has(key),'captured scope remains');assert.equal(f.operations.filter(x=>x[0]==='remove'&&x[1]===key).length,0);
 await f.r.close();
});

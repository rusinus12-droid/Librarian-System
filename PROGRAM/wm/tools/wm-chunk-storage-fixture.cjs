'use strict';
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict'),crypto=require('node:crypto'),path=require('node:path');
const SIZE=524288,SENTINEL='__libraChunkedStorageV1';
async function fixture(){
 const values=new Map(),operations=[];
 const raw={async getItem(k){operations.push(['get',k]);return values.get(k)??null;},async setItem(k,v){operations.push(['set',k]);values.set(k,v);return true;},async removeItem(k){operations.push(['remove',k]);values.delete(k);return true;}};
 let api,r;
 if(process.env.WM_CHUNK_DIST){
  const {runtime}=require('./libra_typed_recall_queue_test.cjs');
  r=await runtime(null,{dist:process.env.WM_CHUNK_DIST});
  Object.assign(r.storage,raw);
  // Preserve exact object identity used by the real wrapper's runtime selector.
  for(const [k,v]of r.store)values.set(k,v);r.store=values;
  api=r.context.__QUEUE_TEST__.compat.pluginStorage;
  return {api,raw:r.storage,values,operations,r,diagnostics:()=>r.context.__QUEUE_TEST__.compat.getDiagnostics()};
 }
 const file=process.env.WM_CHUNK_SOURCE||path.resolve(__dirname,'../src/parts/01-core-runtime-compat-state-debug.js'),source=fs.readFileSync(file,'utf8');
 const a=source.indexOf('        const COMPAT_CHUNK_SENTINEL ='),b=source.indexOf('        const safeLocalStorage =',a);assert(a>=0&&b>a,'real wrapper extraction bounds');
 const exposed=vm.runInNewContext(source.slice(a,b)+'\n;({api:pluginStorage,diagnostics:()=>compatDiagnostics});',{crypto,storageHost:()=>({pluginStorage:raw}),host:()=>({}),console});
 return {api:exposed.api,raw,values,operations,diagnostics:exposed.diagnostics};
}
function seed(f,key='target',text='x'.repeat(SIZE+99),stamp='legacy-time_abcdef'){
 const chunks=[];for(let i=0;i<Math.ceil(text.length/SIZE);i++){const k=`${key}::chunk:v1:${stamp}:${String(i).padStart(4,'0')}`;chunks.push(k);f.values.set(k,text.slice(i*SIZE,(i+1)*SIZE));}
 const manifest={[SENTINEL]:true,schemaVersion:1,key,chunks,length:text.length,updatedAt:1};f.values.set(key,JSON.stringify(manifest));return manifest;
}
module.exports={fixture,seed,SIZE,SENTINEL};

'use strict';
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
const text=fs.readFileSync(path.join(__dirname,'build-libra-runtime-factory.cjs'),'utf8');
const start=text.indexOf('        async nativeFetch(url, init) {'),end=text.indexOf('        async getLocalPluginStorage()',start);
(async()=>{
 for(const by of ['caller','context']){
  let signal;const caller=new AbortController(),contextAbort=new AbortController();
  const host=vm.runInNewContext('({'+text.slice(start,end)+'})',{assertRuntimeActive(){},runtimeUnitSealed:false,contextAbort,AbortController,detachedProvider:async(_url,init)=>{signal=init.signal;return new Promise(resolve=>signal.addEventListener('abort',()=>resolve('aborted'),{once:true}))}});
  const result=host.nativeFetch('https://mock.invalid',{signal:caller.signal});
  (by==='caller'?caller:contextAbort).abort(new Error('fixture abort'));
  assert.equal(signal.aborted,true,by+' cancellation must reach actual provider');await result;
 }
 console.log(JSON.stringify({passed:2,failed:0}));
})().catch(e=>{console.error(e);process.exitCode=1});

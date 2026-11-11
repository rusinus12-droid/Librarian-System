'use strict';
const assert=require('node:assert/strict');
const {JSDOM}=require('jsdom');
const {fixture, installedSdkVariants:variants}=require('./storage_global_allchat_job_test.cjs');
const until=async predicate=>{for(let i=0;i<300;i++){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,10));}throw Error('fixture progress timeout');};
(async()=>{for(const variant of variants){
 let entered=false,release,deny=true;
 const gate=new Promise(resolve=>{release=resolve;});
 const f=await fixture(variant,{transportFactory:base=>async(url,init={})=>{
  const body=init.body?JSON.parse(init.body):{};
  if(deny&&String(url).endsWith('/v1/kv/batch'))
   return new Response(JSON.stringify({ok:false,error:'synthetic_batch_refused'}),{status:413});
  if(deny&&String(url).endsWith('/v1/kv/set')&&body.key===variant[0]+'.A'){
   entered=true;await gate;
   return new Response(JSON.stringify({ok:false,error:'synthetic_value_limit'}),{status:413});
  }
  return await base(url,init);
 }});
 const dom=new JSDOM('<main></main>'),doc=dom.window.document;
 f.context.document=doc;
 let clipboardCalls=0,legacyCalls=0,copied='';
 f.context.navigator={clipboard:{writeText:async()=>{clipboardCalls++;throw Error('Clipboard API blocked by permissions policy');}}};
 let running;
 try{
  await f.bridge.mountConnectionPanel(doc.querySelector('main'));
  const box=doc.querySelector('[data-job-diagnostics]'),button=doc.querySelector('[data-job-copy]'),status=doc.querySelector('[data-status]');
  running=f.bridge.setGlobalMode('server_only').then(value=>({value}),error=>({error}));
  await until(()=>entered);
  let diagnostics=JSON.parse(box.value);
  assert.equal(diagnostics.status,'running');assert.equal(diagnostics.phase,'copy');
  assert(!box.value.includes('A_SOURCE'));assert(!box.value.includes('globalPlan'));assert(!box.value.includes('serverPins'));
  const requestCount=f.calls.length;
  doc.execCommand=command=>{legacyCalls++;assert.equal(command,'copy');assert.equal(doc.activeElement,box);assert.equal(box.style.display,'block');assert.equal(box.selectionEnd,box.value.length);copied=box.value;return true;};
  await button.onclick();assert.equal(clipboardCalls,1);assert.equal(legacyCalls,1);assert.equal(JSON.parse(copied).status,'running');assert.match(status.textContent,/복사했습니다/);
  assert.equal(f.calls.length,requestCount,'copying diagnostics does not start server requests');
  doc.execCommand=()=>false;
  await button.onclick();assert.match(status.textContent,/Ctrl\+C.*⌘C/);assert.equal(doc.activeElement,box);assert.equal(box.selectionStart,0);assert.equal(box.selectionEnd,box.value.length);
  const selected=box.value;release();
  const outcome=await running;assert.equal(outcome.error?.code,'MEMORY_SUITE_TRANSFER_INCOMPLETE');
  assert.equal(f.bridge.getSyncJob().status,'failed');
  assert.equal((await f.bridge.getGlobalMode()).mode,'plugin_only');
  assert.equal(box.value,selected,'progress cannot replace text while the user is selecting it');
  box.blur();await button.onclick();diagnostics=JSON.parse(box.value);
  assert.equal(diagnostics.status,'failed');assert.equal(diagnostics.phase,'failed');
  assert.equal(diagnostics.error,'MEMORY_SUITE_TRANSFER_INCOMPLETE');
  assert.ok(diagnostics.failures.some(row=>row.key===variant[0]+'.A'&&row.error));
  const saved=JSON.parse(f.values.get('__memory_suite_internal_sync_job_v1__:'+variant[0]));
  assert.equal(saved.failureDetails[0].key,variant[0]+'.A');
  await until(()=>doc.querySelector('[data-job-result]').textContent.includes('MEMORY_SUITE_TRANSFER_INCOMPLETE'));
  assert.equal(f.bridge.getCachedDiagnostics().syncJob.error,diagnostics.error,'ordinary debug export retains the failed job');
  f.context.navigator={clipboard:{writeText:async text=>{copied=text;}}};doc.execCommand=()=>{throw Error('must not run after Clipboard success');};
  await button.onclick();assert.equal(JSON.parse(copied).error,diagnostics.error);assert.match(status.textContent,/복사했습니다/);
  f.context.navigator={};doc.execCommand=()=>{throw Error('legacy copy denied');};
  await button.onclick();assert.match(status.textContent,/Ctrl\+C.*⌘C/);
  deny=false;box.blur();await f.bridge.setGlobalMode('server_only');
  await button.onclick();diagnostics=JSON.parse(box.value);assert.equal(diagnostics.status,'completed');assert.equal(diagnostics.error,'');assert.equal(diagnostics.failures.length,0);
  console.log('PASS '+variant[0]+' running/failed diagnostics, denied clipboard fallback, manual selection, failure evidence and reapply');
 }finally{release();await running;dom.window.close();await f.close();}
}})().catch(error=>{console.error(error);process.exitCode=1;});

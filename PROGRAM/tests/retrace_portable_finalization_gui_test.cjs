'use strict';
// Exercise real RE:TRACE clicks and the portable client against the real server.
// The audit seam only reads state; only the host file writer and response timing
// are controlled. No production action, validator, or bridge is replaced.
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {create,until,META}=require('./fixtures/libra_gui_memory_dom_host.cjs');
const {createHandlerFixture}=require('./fixtures/shared_reanalysis_handler_fixture.cjs');
META.RETRACE=['RETRACE.js','__RETRACE'];
const deferred=()=>{let resolve;return {promise:new Promise(r=>{resolve=r;}),resolve:()=>resolve()};};
const source=fs.readFileSync(process.env.RETRACE_SOURCE_FILE||path.join(__dirname,'../plugins/RETRACE.js'),'utf8');
const marker='  const RetraceApi = Object.freeze({';
assert.equal(source.split(marker).length,2,'unique read-only audit boundary');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'retrace-portable-gui-')),pluginPath=path.join(temp,'RETRACE.js');
fs.writeFileSync(pluginPath,source.replace(marker,'  globalThis.__portableAudit={state:()=>({busy:Runtime.busy,finished:Runtime.activeJobFinished,readback:Runtime.activeJobReadback,progress:Runtime.portableTransfer?.progress})};\n'+marker));
(async()=>{
 const keepAlive=setInterval(()=>{},1000),handler=createHandlerFixture(),closeGate=deferred(),historyGate=deferred();let f,holdHistory=false,historyEntered=false;
 try{
  f=await create('RETRACE','Full',{pluginPath,args:{memory_suite_server_url:handler.url},nativeFetch:async(...args)=>{
   const response=await handler.nativeFetch(...args);
   if(holdHistory&&new URL(args[0]).pathname==='/v1/manager/control/history'){historyEntered=true;await historyGate.promise;}
   return response;
  }});
  const state=()=>f.context.__portableAudit.state();
  await f.open();
  const brand=f.doc.querySelector('.brand__ver');
  assert.equal(brand.textContent,'인계소 · v'+f.api.version);assert.equal(brand.title,brand.textContent);assert.doesNotMatch(brand.textContent,/시안|1\.9\.87/);
  f.doc.querySelector('[data-tab="serverdata"]').click();
  f.doc.querySelector('[data-server-page="backups"]').click();
  const exportButton=f.doc.querySelector('[data-portable-action="export"]');
  await until(()=>exportButton&&!exportButton.disabled,'export control enabled');
  let aborted=0,closeEntered=false,received=0;
  f.context.showSaveFilePicker=async()=>({createWritable:async()=>({write:async bytes=>{received+=bytes.length;},close:async()=>{closeEntered=true;await closeGate.promise;},abort:async()=>{aborted++;}})});
  exportButton.click();
  await until(()=>closeEntered,'real export reaches pending file close',20000);
  assert.ok(received>0,'actual ZIP bytes reach the file writer');
  assert.match(f.doc.querySelector('#job-backup [data-job-msg]').textContent,/파일 저장 마무리/);
  assert.equal(state().progress.phase,'saving');
  const cancel=f.doc.querySelector('#job-backup [data-job-cancel]');
  assert.equal(cancel.hidden,false);assert.equal(cancel.disabled,false);cancel.click();
  await until(()=>!state().busy,'cancel releases the GUI while file close is pending');
  assert.ok(aborted>0);assert.equal(state().readback?.verified===true,false);
  assert.match(f.doc.querySelector('#portableTransferStatus').textContent,/중단 요청을 처리/);
  assert.equal(f.doc.querySelectorAll('#job-backup .step.is-done').length,0,'cancellation never certifies completion');
  closeGate.resolve();f.doc.querySelector('#job-backup [data-job-hide]').click();
  // The second export saves successfully, but its unrelated dashboard refresh
  // remains pending. That response must not hold the job open.
  f.context.showSaveFilePicker=async()=>({createWritable:async()=>({write:async()=>{},close:async()=>{holdHistory=true;},abort:async()=>{}})});
  exportButton.click();
  await until(()=>historyEntered,'post-save history refresh held',20000);
  await until(()=>!state().busy&&state().finished,'saved file completes without history refresh');
  assert.equal(state().readback.verified,true);
  assert.match(f.doc.querySelector('#portableTransferStatus').textContent,/ZIP 파일 저장을 완료.*\n크기:.*\n서버 SHA-256:/);
  assert.equal(state().progress.phase,'complete');
  assert.equal(f.doc.querySelectorAll('#job-backup .step.is-done').length,3);
  historyGate.resolve();holdHistory=false;
  const debug=await f.api.debugSnapshot();
  assert.equal(debug.runtime.portableTransfer.progress.phase,'complete');
  assert.equal(debug.runtime.activeJob.verified,true);
  assert.equal(JSON.stringify(debug.runtime).includes('transferToken'),false,'runtime diagnostics contain no transfer credentials');
  assert.deepEqual(f.errors,[]);
  console.log('RE:TRACE portable GUI: PASS (real export, cancel pending save, nonblocking refresh, version header, safe phase diagnostics)');
 }finally{closeGate.resolve();historyGate.resolve();holdHistory=false;if(f)await f.close();await handler.close();fs.rmSync(temp,{recursive:true,force:true});clearInterval(keepAlive);}
})().catch(error=>{console.error(error);process.exitCode=1;});

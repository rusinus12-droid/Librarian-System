'use strict';
// 2026-10-31 live failure: one server read-session request failed before any
// evidence was accepted and the whole input writer stopped with a bare
// LIB_READ_UNAVAILABLE dialog. Optional memory that never arrived must not cost
// the user the native-context choices, and the failing boundary must be named.
const {test}=require('node:test'),assert=require('node:assert/strict');
const {fixture}=require('./fixtures/gradia_input_writer_unified_fixture.cjs');

test('a server read failure before evidence falls back to native choices and records its transport cause',{timeout:30000},async t=>{
 const f=await fixture(t);
 f.controls.denied=true;
 const {pending}=await f.start();await f.choices();
 assert.equal(f.queries(),0,'no owner evidence was read');
 assert.equal(f.prompts.length,1,'the writer still asked the model with native context');
 assert(!JSON.stringify(f.prompts[0]).includes('WRITER_OWNER_EVIDENCE'));
 const memory=f.host.plugin.getInputAssistSendStatus().memory;
 assert.equal(memory.status,'unavailable');assert.equal(memory.reason,'LIB_READ_UNAVAILABLE');
 assert(f.document.body.textContent.includes('기억 참고 생략: 기억 서버 읽기 실패'));
 const diagnostic=f.host.plugin.getRuntime().lastInputWriterReadDiagnostic;
 assert.equal(diagnostic.code,'LIB_READ_UNAVAILABLE');
 assert.equal(diagnostic.transportCause?.status,403,'the refused HTTP status is kept for the debug log');
 f.controls.denied=false;
 await f.select();
 assert.equal(await f.done(pending),true);assert.equal(f.copied.length,1);
});

// 2026-10-31 live: the plugin iframe refused every programmatic copy, and the
// final review offered no way forward. A blocked copy must leave a verified
// manual path that still re-checks memory before the draft is exported.
test('a blocked clipboard leaves a verified manual-copy continuation',{timeout:30000},async t=>{
 const f=await fixture(t),{pending}=await f.start();await f.select();
 f.controls.clipboardError=Object.assign(new Error('blocked by permissions policy'),{name:'NotAllowedError'});
 f.button('복사 후 직접 전송').click();
 await f.wait(()=>f.button('직접 복사 후 계속'),'manual copy continuation');
 assert.match(f.document.body.textContent,/Ctrl\/Cmd\+C로 복사한 뒤/);
 assert.equal(f.copied.length,0);
 f.button('직접 복사 후 계속').click();
 assert.equal(await pending,true,'verified manual copy completes the writer');
 assert.equal(f.sent.length,0);
});

test('a manual continuation is still refused when memory changed after the copy was offered',{timeout:30000},async t=>{
 const f=await fixture(t),{pending}=await f.start();await f.select();
 f.controls.clipboardError=Object.assign(new Error('blocked'),{name:'NotAllowedError'});
 f.button('복사 후 직접 전송').click();
 await f.wait(()=>f.button('직접 복사 후 계속'),'manual copy continuation');
 const editor = f.document.querySelector('textarea[data-input-delivery-editor]');
 if (editor) editor.value += ' (수정)';
 f.controls.current=false;
 f.button('직접 복사 후 계속').click();
 // When content changed, first click updates dataset with '인풋이 바뀌었습니다'
 if (editor) {
   await f.wait(()=>f.document.body.textContent.includes('인풋이 바뀌었습니다'),'content changed notice');
   f.button('직접 복사 후 계속').click();
 }
 await f.wait(()=>f.document.body.textContent.includes('붙여넣지 마세요'),'stale manual copy rejection');
 await f.host.plugin.cancelInputAssistSend();assert.equal(await pending,false);
});

test('a superseded memory read before evidence falls back safely to native choices',{timeout:30000},async t=>{
 const f=await fixture(t);
 f.controls.onQuery=async()=>{
  throw Object.assign(new Error('session superseded'),{code:'LIB_READ_SUPERSEDED'});
 };
 const {pending}=await f.start();await f.choices();
 assert.equal(f.queries(),1,'attempted query');
 assert.equal(f.prompts.length,1,'the writer fell back and asked the model with native context');
 assert(!JSON.stringify(f.prompts[0]).includes('WRITER_OWNER_EVIDENCE'));
 const memory=f.host.plugin.getInputAssistSendStatus().memory;
 assert.equal(memory.status,'unavailable');
 assert.equal(memory.reason,'LIB_READ_SUPERSEDED');
 await f.select();
 assert.equal(await f.done(pending),true);
 assert.equal(f.copied.length,1);
});

test('a memory currentness failure before model dispatch falls back safely to native choices',{timeout:30000},async t=>{
 const f=await fixture(t);
 f.controls.onCurrent=async()=>{
  throw Object.assign(new Error('currentness lost'),{code:'LIB_READ_CURRENTNESS_LOST'});
 };
 const {pending}=await f.start();await f.choices();
 assert.equal(f.queries(),1,'attempted query');
 assert.equal(f.prompts.length,1,'the writer fell back and asked the model with native context');
 assert(!JSON.stringify(f.prompts[0]).includes('WRITER_OWNER_EVIDENCE'));
 const memory=f.host.plugin.getInputAssistSendStatus().memory;
 assert.equal(memory.status,'unavailable');
 assert.equal(memory.reason,'LIB_READ_CURRENTNESS_LOST');
 await f.select();
 assert.equal(await f.done(pending),true);
 assert.equal(f.copied.length,1);
});

test('native revalidation failure during optional memory fallback fails closed when native context changed',{timeout:30000},async t=>{
 const f=await fixture(t);
 f.controls.onQuery=async()=>{
  f.chat.message.push({role:'user',chatId:'u-changed',data:'중간에 변경된 네이티브 메시지'});
  throw Object.assign(new Error('memory unavailable'),{code:'LIB_READ_UNAVAILABLE'});
 };
 const {pending}=await f.start();
 await assert.rejects(()=>f.choices(),/WRITER_FAILED/);
 assert.equal(f.prompts.length,0,'must not dispatch model when native context changed during fallback');
 const diagnostic=f.host.plugin.getRuntime().lastInputWriterReadDiagnostic;
 assert.equal(diagnostic.status,'failed');
 assert.equal(diagnostic.stage,'native_revalidation');
 assert.equal(diagnostic.code,'LIB_READ_NATIVE_CHANGED');
 await f.host.plugin.cancelInputAssistSend();
 assert.equal(await pending,false);
});

test('native revalidation failure during optional memory fallback fails closed when host API throws',{timeout:30000},async t=>{
 const f=await fixture(t);
 let failHost=false;
 f.controls.onNativeRead=async()=>{
  if(failHost)throw new Error('host_api_boom');
 };
 f.controls.onQuery=async()=>{
  failHost=true;
  throw Object.assign(new Error('memory unavailable'),{code:'LIB_READ_UNAVAILABLE'});
 };
 const {pending}=await f.start();
 await assert.rejects(()=>f.choices(),/WRITER_FAILED/);
 assert.equal(f.prompts.length,0,'must not dispatch model when native revalidation cannot verify host context');
 const diagnostic=f.host.plugin.getRuntime().lastInputWriterReadDiagnostic;
 assert.equal(diagnostic.status,'failed');
 assert.equal(diagnostic.stage,'native_revalidation');
 assert.equal(diagnostic.code,'LIB_READ_NATIVE_UNAVAILABLE');
 await f.host.plugin.cancelInputAssistSend();
 assert.equal(await pending,false);
});

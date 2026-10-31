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

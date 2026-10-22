'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {fixture}=require('./fixtures/gradia_input_writer_unified_fixture.cjs');
const writerSystem=body=>body.messages.filter(m=>m.role==='system').map(m=>m.content).join('\n');
async function setNsfw(f,mode,enabled=true){
 await f.host.plugin.saveRuntimeSettings({...await f.host.plugin.getRuntimeSettings(),nsfw_mode:mode,nsfw_guidance_enabled:String(enabled)});
}
for(const writingMode of ['novel','rp'])for(const unified of [false,true])test(writingMode+' writer applies NSFW selection with '+(unified?'bound memory':'native context')+' without exporting guidance with the chosen input',async t=>{
 const f=await fixture(t,{writingMode,unified});
 for(const [mode,enabled] of [['off',true],['soft',true],['direct',true],['explicit',true],['explicit',false]]){
  await setNsfw(f,mode,enabled);const before=f.prompts.length,{pending}=await f.start();await f.select();
  assert.equal(f.prompts.length,before+1,'one choice-generation call');const system=writerSystem(f.prompts[before]);
  if(mode==='off'||!enabled)assert.doesNotMatch(system,/NSFW GUIDANCE —/);
  else{
   assert.equal((system.match(/NSFW GUIDANCE —/g)||[]).length,1);
   assert.ok(system.includes('NSFW GUIDANCE — '+mode.toUpperCase()+':'));
   assert.match(system,/proposed USER input choices/);assert.match(system,/unsubmitted candidates/);
   if(writingMode==='novel'){
    assert.match(system,/NOVEL AUTHOR INPUTS/);assert.match(system,/NPC initiative and reactions/);assert.match(system,/offscreen world movement/);
    assert.doesNotMatch(system,/keep every candidate strictly on the user\/player side|never script the NPC response/i);
   }else{
    assert.match(system,/PLAYER-CONTROLLED RP INPUTS/);assert.match(system,/never script the NPC response/);
    assert.doesNotMatch(system,/NOVEL AUTHOR INPUTS/);
   }
  }
  assert.equal(await f.done(pending),true);assert.match(f.sent.at(-1),/^WRITER_CHOICE_/);
  assert.doesNotMatch(f.sent.at(-1),/NSFW GUIDANCE|proposed USER input choices/);
 }
});
test('real explicit Novel writer queries once, binds edited output and delivers without retaining evidence',async t=>{
 const f=await fixture(t),{pending}=await f.start();await f.select();
 const editor=f.document.querySelector('textarea');editor.value='EDITED_WRITER_OUTPUT 은빛 열쇠를 찾는 장면으로 잇는다.';editor.dispatchEvent(new f.dom.window.Event('input',{bubbles:true}));
 assert.equal(await f.done(pending),true);assert.deepEqual(f.sent,['EDITED_WRITER_OUTPUT 은빛 열쇠를 찾는 장면으로 잇는다.']);
 assert.equal(f.prompts.length,1);assert.equal(f.queries(),1);
 assert.ok(JSON.stringify(f.prompts[0]).includes('WRITER_OWNER_EVIDENCE'));assert.ok(!JSON.stringify(f.prompts).includes('LEGACY_AUTHORIZATION_ONLY'));
 const request=f.bus.messages.find(m=>m.body.action==='capture').body.payload;
 assert.equal(request.proposal.factAdopted,false);assert.equal(request.proposal.purpose,'input_writer_proposal');assert.match(request.proposal.proposalDigest,/^[a-f0-9]{64}$/);
 const runtime=JSON.stringify(f.host.plugin.getRuntime());assert.ok(!runtime.includes('WRITER_OWNER_EVIDENCE'));assert.ok(!runtime.includes('WRITER_CHOICE_'));assert.ok(!runtime.includes('EDITED_WRITER_OUTPUT'));
 assert.ok(!JSON.stringify([...f.values,...f.local]).includes('WRITER_CHOICE_'));
});
test('RP choices and translation share one read, copy exact edited text, and redact generic status',async t=>{
 const f=await fixture(t,{writingMode:'rp'});await setNsfw(f,'direct');const {pending}=await f.start();const cards=await f.choices();
 assert.equal(f.host.plugin.getRuntime().externalEvidence,true);
 assert.ok(!JSON.stringify(f.host.plugin.getInputAssistConfirmationStatus()).includes('WRITER_CHOICE_'));
 cards[0].querySelector('[data-input-choice-translate="english"]').click();
 await f.wait(()=>cards[0].querySelector('textarea').value.startsWith('TRANSLATED_WRITER_CHOICE'),'translation');
 await f.select();const editor=f.document.querySelector('textarea');editor.value='COPIED_WRITER_OUTPUT 은빛 열쇠의 위치를 묻는다.';editor.dispatchEvent(new f.dom.window.Event('input',{bubbles:true}));
 assert.ok(!JSON.stringify(f.host.plugin.getInputAssistSendStatus()).includes('TRANSLATED_WRITER_CHOICE'));
 assert.equal(await f.done(pending,'복사 후 직접 전송'),true);assert.deepEqual(f.copied,['COPIED_WRITER_OUTPUT 은빛 열쇠의 위치를 묻는다.']);assert.equal(f.sent.length,0);
 assert.equal(f.prompts.length,2);assert.equal(f.queries(),1);assert.ok(f.prompts.every(p=>JSON.stringify(p).includes('WRITER_OWNER_EVIDENCE')));
 assert.match(writerSystem(f.prompts[0]),/NSFW GUIDANCE — DIRECT/);
 assert.doesNotMatch(writerSystem(f.prompts[1]),/NSFW GUIDANCE —/,'translation stays faithful to the selected text');
});
test('regeneration releases the old receipt and opens a distinct proposal operation',async t=>{
 const f=await fixture(t);await setNsfw(f,'soft');const {pending}=await f.start();await f.choices();f.button('3가지 선택지 다시 제안').click();
 await f.wait(()=>f.queries()===2&&f.document.querySelector('[data-input-choice-editor]')?.disabled===false,'regeneration');
 const requests=f.bus.messages.filter(m=>m.body.action==='capture').map(m=>m.body.payload.proposal);
 assert.notEqual(requests[0].operationId,requests[1].operationId);assert.equal(requests[0].proposalDigest,requests[1].proposalDigest);
 assert.ok(f.bus.messages.some(m=>m.body.action==='release'));await f.select();assert.equal(await f.done(pending),true);assert.equal(f.prompts.length,2);
 for(const body of f.prompts)assert.equal((writerSystem(body).match(/NSFW GUIDANCE — SOFT/g)||[]).length,1);
});
test('failed regeneration cannot export the previous choices under a fresh or absent lease',async t=>{
 const f=await fixture(t),{pending}=await f.start();const cards=await f.choices();
 f.controls.onQuery=async()=>{throw Object.assign(Error('refused'),{code:'LIB_READ_UNIFIED_UNAVAILABLE'});};
 f.button('3가지 선택지 다시 제안').click();await f.wait(()=>f.document.body.textContent.includes('재생성 실패'),'failed regeneration');
 cards[0].querySelector('.btn--primary').click();await f.wait(()=>f.document.body.textContent.includes('선택 검증 실패'),'old-choice rejection');
 assert.equal(f.sent.length+f.copied.length,0);await f.host.plugin.cancelInputAssistSend();assert.equal(await pending,false);
});
for(const change of ['owner','native','scope','permission','disconnect','settings'])test(change+' changing during final review blocks copy and draft export',async t=>{
 const f=await fixture(t),{pending}=await f.start();await f.select();
 if(change==='owner')f.controls.current=false;
 if(change==='native')f.chat.message[1].data+=' EDITED_NATIVE';
 if(change==='scope')f.chat.id='another-chat';
 if(change==='permission')f.controls.denied=true;
 if(change==='disconnect')await f.host.plugin.unbindLibReadOnlyClient();
 if(change==='settings')await f.host.plugin.saveRuntimeSettings({input_assist_target_chars:1000});
 f.button('복사 후 직접 전송').click();await f.wait(()=>f.document.body.textContent.includes('복사 검증 실패'),'stale copy rejection');
 assert.equal(f.copied.length+f.sent.length,0);await f.host.plugin.cancelInputAssistSend();assert.equal(await pending,false);
});
test('permission-dialog await cannot hide a native change before sendChat',async t=>{
 const f=await fixture(t),{pending}=await f.start();await f.select();f.controls.onPermission=async()=>{f.chat.message[1].data+=' changed during permission';};
 assert.equal(await f.done(pending),false);assert.equal(f.sent.length,0);
});
test('editing a delivery while its currentness check waits cannot replace the sealed output',async t=>{
 const f=await fixture(t),{pending}=await f.start();await f.select();let release,entered;const ready=new Promise(r=>entered=r);
 f.controls.onCurrent=async()=>{f.controls.onCurrent=null;entered();await new Promise(r=>release=r);};
 f.button('바로 전송').click();await ready;const editor=f.document.querySelector('textarea');editor.value='LATE_REPLACEMENT';release();
 await f.wait(()=>f.document.body.textContent.includes('전달 검증 실패'),'changed exact output');assert.equal(f.sent.length,0);
 await f.host.plugin.cancelInputAssistSend();assert.equal(await pending,false);
});
test('canceling a held model settles the writer and rejects late choices',async t=>{
 const f=await fixture(t);let release;f.controls.onModel=async()=>{await new Promise(r=>release=r);};
 const {pending}=await f.start();await f.wait(()=>f.prompts.length===1,'model started');
 await f.host.plugin.cancelInputAssistSend();assert.equal(await pending,false);release();await new Promise(r=>setTimeout(r,20));
 assert.equal(f.sent.length+f.copied.length,0);assert.ok(!JSON.stringify(f.host.plugin.getRuntime()).includes('WRITER_CHOICE_'));
});
test('an unbound writer retains its native flow and never requests a memory read',async t=>{
 const f=await fixture(t,{unified:false}),{pending}=await f.start();await f.select();assert.equal(await f.done(pending),true);
 assert.equal(f.queries(),0);assert.ok(!JSON.stringify(f.prompts).includes('WRITER_OWNER_EVIDENCE'));
});
for(const writingMode of ['novel','rp'])test(writingMode+' writer uses native context when the optional provider is unavailable before capture',async t=>{
 const f=await fixture(t,{writingMode});f.controls.onQuery=async()=>{throw Object.assign(Error('LIB_READ_UNIFIED_UNAVAILABLE'),{code:'LIB_READ_UNIFIED_UNAVAILABLE'});};
 const {pending}=await f.start();await f.select();assert.equal(await f.done(pending,'복사 후 직접 전송'),true);
 assert.equal(f.copied.length,1);assert.equal(f.prompts.length,1);assert.equal(f.queries(),1);
 assert.ok(!JSON.stringify(f.prompts).includes('WRITER_OWNER_EVIDENCE'));
});

test('empty continuation is still an unsubmitted query bound to the exact empty proposal',async t=>{
 const f=await fixture(t);
 // A real stored boundary closes the preceding assistant; the proposal is empty.
 f.chat.message.push({role:'user',chatId:'native-boundary',data:'기존 대화의 다음 입력'});
 const {pending}=await f.start('');await f.select();assert.equal(await f.done(pending),true);
 const request=f.bus.messages.find(m=>m.body.action==='capture').body.payload;
 assert.equal(request.proposal.proposalDigest,require('node:crypto').createHash('sha256').update('').digest('hex'));
 assert.equal(request.proposal.factAdopted,false);assert.ok(request.queryText.includes('은빛 열쇠'));assert.equal(f.queries(),1);
});
test('empty continuation uses the settled visible terminal reply, never a streaming one, as query context',async t=>{
 // The writer runs on a settled screen: a visible reply without this session's output
 // receipt (after a reload or an edit) is still the live scene.
 const f=await fixture(t);f.chat.message[1].data='SETTLED_TERMINAL_SENTINEL';
 const {pending}=await f.start('');await f.select();assert.equal(await f.done(pending),true);
 const request=f.bus.messages.find(m=>m.body.action==='capture').body.payload;
 assert.ok(request.queryText.includes('SETTLED_TERMINAL_SENTINEL'));assert.equal(request.proposal.factAdopted,false);
 assert.ok(JSON.stringify(f.prompts[0]).includes('SETTLED_TERMINAL_SENTINEL'));
 const g=await fixture(t);g.chat.message[1].data='STREAMING_TERMINAL_SENTINEL';g.chat.isStreaming=true;
 const streaming=await g.start('');await g.select();assert.equal(await g.done(streaming.pending),true);
 const streamingRequest=g.bus.messages.find(m=>m.body.action==='capture').body.payload;
 assert.ok(!streamingRequest.queryText.includes('STREAMING_TERMINAL_SENTINEL'));assert.ok(!JSON.stringify(g.prompts[0]).includes('STREAMING_TERMINAL_SENTINEL'));
});

test('malformed or truncated writer JSON is not retried and cannot persist its derived content',async t=>{
 for(const content of ['{"schema":','{"schema":"wrong","choices":[]}']){
  const f=await fixture(t);f.controls.output=content;const {pending}=await f.start();assert.equal(await pending,false);
  assert.equal(f.prompts.length,1);assert.equal(f.sent.length+f.copied.length,0);
  assert.ok(!JSON.stringify(f.host.plugin.getRuntime()).includes('WRITER_OWNER_EVIDENCE'));
 }
});
test('a configured stage model can read evidence without the retired GPT4o-mini model pin',async t=>{
 const f=await fixture(t);await f.host.plugin.saveProviderPreset('writer',{provider:'openai',url:'https://api.openai.com/v1/chat/completions',key:'synthetic-only',model:'gpt-5.6',request_format:'chat_completions',context_window:262144,max_tokens:4096,reasoning_preset:'off',stream:false});
 const {pending}=await f.start();await f.select();assert.equal(await f.done(pending),true);assert.equal(f.prompts.length,1);assert.equal(f.prompts[0].model,'gpt-5.6');
});
test('missing stage context metadata blocks writer evidence before dispatch',async t=>{
 const f=await fixture(t);await f.host.plugin.saveProviderPreset('writer',{provider:'openai',url:'https://api.openai.com/v1/chat/completions',key:'synthetic-only',model:'unregistered-fixture-model',request_format:'chat_completions',context_window:0,max_tokens:4096,stream:false});
 const {pending}=await f.start();assert.equal(await pending,false);assert.equal(f.prompts.length,0);assert.equal(f.sent.length+f.copied.length,0);
});
test('canceling a stalled native context recheck closes the picker without a late export',async t=>{
 const f=await fixture(t),{pending}=await f.start();await f.select();let release,entered;const ready=new Promise(r=>entered=r);
 f.controls.onNativeRead=async()=>{f.controls.onNativeRead=null;entered();await new Promise(r=>release=r);};
 f.button('복사 후 직접 전송').click();await ready;await f.host.plugin.cancelInputAssistSend();assert.equal(await pending,false);
 release();await new Promise(r=>setTimeout(r,20));assert.equal(f.copied.length+f.sent.length,0);
});

for(const change of ['cancel','disconnect'])test(change+' during initial native preparation cannot query or dispatch later',async t=>{
 const f=await fixture(t);let release,entered;const ready=new Promise(r=>entered=r);
 const {pending}=await f.start('아직 보내지 않은 제안',()=>{f.controls.onNativeRead=async()=>{f.controls.onNativeRead=null;entered();await new Promise(r=>release=r);};});
 await ready;
 if(change==='cancel')await f.host.plugin.cancelInputAssistSend();else await f.host.plugin.unbindLibReadOnlyClient();
 assert.equal(await pending,false);assert.equal(f.queries(),0);assert.equal(f.prompts.length,0);
 release();await new Promise(r=>setTimeout(r,20));assert.equal(f.queries(),0);assert.equal(f.prompts.length,0);assert.equal(f.sent.length+f.copied.length,0);
});

const writerUser=body=>body.messages.filter(m=>m.role==='user').map(m=>m.content).join('\n');
test('the writer continues from the latest visible reply with its previous user input and short-reply backfill',async t=>{
 for(const writingMode of ['novel','rp']){
  // No output receipt exists for the latest reply, as after a reload.
  const chat={id:'h',message:[{role:'user',chatId:'u1',data:'EARLY_USER 민아는 서고에 들어선다.'},
   {role:'assistant',chatId:'a1',data:'EARLIER_REPLY_HEAD '+'준호가 오래된 장부를 넘겼다. '.repeat(200)+'EARLIER_REPLY_TAIL'},
   {role:'user',chatId:'u2',data:'PREVIOUS_USER_ACTION 민아는 은빛 열쇠를 내민다.'},
   {role:'assistant',chatId:'a2',data:'LATEST_SHORT_REPLY 준호가 열쇠를 받아 들었다.'}]};
  const f=await fixture(t,{writingMode,unified:false,chat,character:{chaId:'c',name:'민아',chats:[chat],chatPage:0,lorebook:[]}});
  const {pending}=await f.start('');await f.choices();
  const user=writerUser(f.prompts[0]);
  assert.ok(user.includes('LATEST_SHORT_REPLY'),writingMode+': latest reply is the terminal passage');
  assert.ok(user.indexOf('PREVIOUS_USER_ACTION')<user.indexOf('LATEST_SHORT_REPLY'),writingMode+': previous user input precedes it');
  assert.ok(user.includes('EARLIER_REPLY_TAIL')&&!user.includes('EARLIER_REPLY_HEAD'),writingMode+': short reply backfilled with the earlier tail only');
  assert.ok(!user.includes('EARLY_USER'),writingMode+': older turns stay out');
  assert.equal(f.host.plugin.getRuntime().lastInputAssistContext.terminalProof,'settled_visible_reply');
  f.host.plugin.cancelInputAssistSend?.();await Promise.race([pending,new Promise(r=>setTimeout(r,1500))]).catch(()=>{});
 }
});
test('an edited latest reply and a long reply stay the only terminal passage',async t=>{
 const chat={id:'h',message:[{role:'user',chatId:'u1',data:'민아는 문을 연다.'},{role:'assistant',chatId:'a1',data:'OLDER_REPLY 준호가 기다렸다.'},
  {role:'user',chatId:'u2',data:'민아는 열쇠를 찾는다.'},{role:'assistant',chatId:'a2',data:'EDITED_LONG_REPLY '+'등불이 서가를 비췄다. '.repeat(120)}]};
 const f=await fixture(t,{unified:false,chat,character:{chaId:'c',name:'민아',chats:[chat],chatPage:0,lorebook:[]}});
 const {pending}=await f.start('');await f.choices();const user=writerUser(f.prompts[0]);
 assert.ok(user.includes('등불이 서가를 비췄다'));assert.ok(!user.includes('OLDER_REPLY'),'no backfill behind a long reply');
 f.host.plugin.cancelInputAssistSend?.();await Promise.race([pending,new Promise(r=>setTimeout(r,1500))]).catch(()=>{});
});
test('the writer lore block keeps whole entries',async t=>{
 const chat={id:'h',message:[{role:'user',chatId:'u1',data:'민아는 서고에 들어선다.'},{role:'assistant',chatId:'a1',data:'준호가 은빛 열쇠와 푸른 문 이야기를 꺼냈다.'}]};
 const globalLore=Array.from({length:40},(_,i)=>({key:i%2?'은빛 열쇠':'푸른 문',comment:'L'+i,mode:'normal',insertorder:100,content:`ENTRY_${i}_START `+'오래된 서고의 규칙을 지키는 문지기. '.repeat(12)+` ENTRY_${i}_END`}));
 const f=await fixture(t,{unified:false,chat,character:{chaId:'c',name:'민아',chats:[chat],chatPage:0,globalLore}});
 const {pending}=await f.start('');await f.choices();const user=writerUser(f.prompts[0]);
 const starts=[...user.matchAll(/ENTRY_(\d+)_START/g)].map(m=>m[1]),ends=new Set([...user.matchAll(/ENTRY_(\d+)_END/g)].map(m=>m[1]));
 assert.ok(starts.length>0);for(const id of starts)assert.ok(ends.has(id),'entry '+id+' was cut');assert.ok(!user.includes('…[truncated]'));
 f.host.plugin.cancelInputAssistSend?.();await Promise.race([pending,new Promise(r=>setTimeout(r,1500))]).catch(()=>{});
});

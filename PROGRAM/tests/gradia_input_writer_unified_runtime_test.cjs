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
  assert.equal(await f.done(pending),true);assert.match(f.copied.at(-1),/^WRITER_CHOICE_/);assert.equal(f.sent.length,0);
  assert.doesNotMatch(f.copied.at(-1),/NSFW GUIDANCE|proposed USER input choices/);
 }
});
for(const unified of [false,true])test('writer offers copy without direct send or sendChat support and '+(unified?'bound memory':'native context'),async t=>{
 const f=await fixture(t,{unified,sendAvailable:false}),{pending}=await f.start();await f.select();
 const chosen=f.document.querySelector('textarea').value;
 assert.equal(f.button('바로 전송'),undefined);assert.ok(f.button('복사 후 직접 전송').classList.contains('btn--primary'));
 assert.equal(await f.done(pending),true);assert.deepEqual(f.copied,[chosen]);assert.equal(f.sent.length,0);
 assert.equal(f.prompts.length,1);assert.ok(f.permissions.every(p=>['fetchLogs','db','mainDom','replacer'].includes(p)));
 assert.equal(f.host.plugin.getInputAssistSendStatus().phase,'copied');
});
test('losing the final review GUI cancels without sending or copying',async t=>{
 const f=await fixture(t,{unified:false}),{pending}=await f.start();const cards=await f.choices();
 f.document.body.remove();cards[0].querySelector('.btn--primary').click();
 assert.equal(await pending,false);assert.equal(f.sent.length+f.copied.length,0);
});
test('blocked clipboard leaves a manual selection without sending or regenerating',async t=>{
 const f=await fixture(t,{unified:false}),{pending}=await f.start();await f.select();f.controls.clipboardError=Error('fixture_clipboard_denied');
 f.button('복사 후 직접 전송').click();await f.wait(()=>f.document.body.textContent.includes('자동 복사가 차단'),'manual clipboard fallback');
 const editor=f.document.querySelector('textarea');assert.equal(editor.selectionStart,0);assert.equal(editor.selectionEnd,editor.value.length);
 assert.equal(f.sent.length+f.copied.length,0);assert.equal(f.prompts.length,1);assert.equal(f.button('바로 전송'),undefined);
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
test('malformed or truncated writer JSON never delivers',async t=>{
 for(const content of ['{"schema":','{"schema":"wrong","choices":[]}']){
  const f=await fixture(t);f.controls.output=content;const {pending}=await f.start();assert.equal(await pending,false);
  assert.equal(f.sent.length+f.copied.length,0);
 }
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
const ownerReads=f=>f.bus.messages.filter(m=>m.body.kind==='request'&&['capture','select'].includes(m.body.action)).length;
test('a connected writer drafts from its own context and never reads LIB memory',async t=>{
 const f=await fixture(t),before=ownerReads(f),{pending}=await f.start();await f.select();
 const editor=f.document.querySelector('textarea');editor.value='EDITED_WRITER_OUTPUT 은빛 열쇠를 찾는 장면으로 잇는다.';editor.dispatchEvent(new f.dom.window.Event('input',{bubbles:true}));
 assert.equal(await f.done(pending),true);assert.deepEqual(f.copied,['EDITED_WRITER_OUTPUT 은빛 열쇠를 찾는 장면으로 잇는다.']);assert.equal(f.sent.length,0);
 assert.equal(f.prompts.length,1);assert.equal(f.queries(),0);assert.equal(ownerReads(f),before);
 assert.ok(!JSON.stringify(f.prompts[0]).includes('WRITER_OWNER_EVIDENCE'));assert.ok(!JSON.stringify(f.prompts[0]).includes('EXTERNAL MEMORY EVIDENCE'));
});
test('RP choices and translation copy exact edited text without any memory read',async t=>{
 const f=await fixture(t,{writingMode:'rp'});await setNsfw(f,'direct');const {pending}=await f.start();const cards=await f.choices();
 cards[0].querySelector('[data-input-choice-translate="english"]').click();
 await f.wait(()=>cards[0].querySelector('textarea').value.startsWith('TRANSLATED_WRITER_CHOICE'),'translation');
 await f.select();const editor=f.document.querySelector('textarea');editor.value='COPIED_WRITER_OUTPUT 은빛 열쇠의 위치를 묻는다.';editor.dispatchEvent(new f.dom.window.Event('input',{bubbles:true}));
 assert.equal(await f.done(pending,'복사 후 직접 전송'),true);assert.deepEqual(f.copied,['COPIED_WRITER_OUTPUT 은빛 열쇠의 위치를 묻는다.']);assert.equal(f.sent.length,0);
 assert.equal(f.prompts.length,2);assert.equal(f.queries(),0);assert.ok(f.prompts.every(p=>!JSON.stringify(p).includes('WRITER_OWNER_EVIDENCE')));
 assert.match(writerSystem(f.prompts[0]),/NSFW GUIDANCE — DIRECT/);
 assert.doesNotMatch(writerSystem(f.prompts[1]),/NSFW GUIDANCE —/,'translation stays faithful to the selected text');
});
test('regeneration asks the model again and a failed one sends nothing',async t=>{
 const f=await fixture(t),{pending}=await f.start();await f.choices();assert.equal(f.prompts.length,1);
 f.button('3가지 선택지 다시 제안').click();await f.wait(()=>f.prompts.length===2,'regeneration');await f.choices();
 f.controls.output='{"schema":';f.button('3가지 선택지 다시 제안').click();await f.wait(()=>f.document.body.textContent.includes('재생성 실패'),'failed regeneration');
 assert.equal(f.sent.length+f.copied.length,0);await f.host.plugin.cancelInputAssistSend();assert.equal(await pending,false);
});
const userPrompt=body=>body.messages.filter(m=>m.role==='user').map(m=>m.content).join('\n');
test('Novel writer rebuilds the input instead of repeating it and continuing',async t=>{
 const f=await fixture(t),{pending}=await f.start('민아에게 열쇠를 건넨다.');await f.choices();
 const system=writerSystem(f.prompts[0]);
 assert.match(system,/reconstruct and expand CURRENT USER INPUT/);assert.match(system,/never begin a candidate with the input verbatim/);assert.match(system,/rather than appended after a copy/);
 assert.match(userPrompt(f.prompts[0]),/RECONSTRUCT AND EXPAND THIS[^\n]*\n민아에게 열쇠를 건넨다\./);
 await f.host.plugin.cancelInputAssistSend();await pending;
});
test('RP writer builds every option from the written input',async t=>{
 const f=await fixture(t,{writingMode:'rp'}),{pending}=await f.start('민아에게 열쇠를 건넨다.');await f.choices();
 const system=writerSystem(f.prompts[0]),user=userPrompt(f.prompts[0]);
 assert.match(system,/Reconstruct and expand CURRENT USER INPUT/);assert.match(system,/Do not replace it with a different action, and do not ignore it to describe the situation/);
 assert.doesNotMatch(system,/AI proposals are alternatives/);assert.doesNotMatch(user,/Do not preserve a concrete original action/);
 assert.match(user,/RECONSTRUCT AND EXPAND THIS IN EVERY OPTION\]\n민아에게 열쇠를 건넨다\./);
 await f.host.plugin.cancelInputAssistSend();await pending;
});
test('with no written input the RP writer proposes from the scene',async t=>{
 const f=await fixture(t,{writingMode:'rp'}),{pending}=await f.start('');await f.choices();
 const system=writerSystem(f.prompts[0]);
 assert.doesNotMatch(system,/Reconstruct and expand CURRENT USER INPUT/);assert.match(system,/grounded in the terminal scene/);
 await f.host.plugin.cancelInputAssistSend();await pending;
});
for(const writingMode of ['novel','rp'])test(writingMode+' writer keeps the persona as the protagonist',async t=>{
 const f=await fixture(t,{writingMode}),{pending}=await f.start();await f.choices();
 const system=writerSystem(f.prompts[0]);
 assert.match(system,/the protagonist is ALWAYS the user persona/);assert.match(system,/Central and supporting characters are ALWAYS people other than the persona/);
 assert.match(system,/even when the character card, chat title, or current scene centers on them/);
 await f.host.plugin.cancelInputAssistSend();await pending;
});
test('the RP detail mode is saved and defaults to persona only',async t=>{
 const f=await fixture(t,{writingMode:'rp'});
 assert.equal(f.host.plugin.getRuntime().settings?.rpImpersonationScope??'persona','persona');
 await f.host.plugin.saveRuntimeSettings({...await f.host.plugin.getRuntimeSettings(),rp_impersonation_scope:'all'});
 assert.equal((await f.host.plugin.getRuntimeSettings()).rp_impersonation_scope,'all');
});

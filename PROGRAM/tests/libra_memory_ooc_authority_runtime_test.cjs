'use strict';
const assert=require('node:assert/strict');
const {createOocGui}=require('./fixtures/libra_memory_ooc_gui_fixture.cjs');
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};
const cases=[];
const selected=process.env.OOC_CASE||'';
async function run(name,test){if(selected&&name!==selected)return;const h=await createOocGui();try{await h.open();await h.memory();await h.expandOoc();await test(h);cases.push(name);}finally{await h.cleanup();}}
async function send(h,reply){h.modelQueue.push(reply);const text=h.ooc().querySelector('textarea');text.value='Keep source evidence.';await text.emit('input');return h.button('OOC 보내기',h.ooc()).emit('click');}
async function preview(h){await send(h,{type:'success',result:'Agreed evidence-only behavior.'});h.modelQueue.push({type:'success',result:JSON.stringify({title:'Safe preview',append_text:'AUTHORITY_APPEND_SENTINEL'})});await h.button('지침 미리보기 만들기',h.ooc()).emit('click');assert(h.ooc().textContent.includes('AUTHORITY_APPEND_SENTINEL'));}
(async()=>{
 await run('close_reopen_pending_dialogue',async h=>{
  const old=deferred();const pending=send(h,()=>old.promise);await h.waitFor(()=>h.modelCalls.length===1);
  await h.api.closeSettingsGui();await h.open();await h.memory();await h.expandOoc();
  const enabled=!h.button('OOC 보내기',h.ooc()).disabled;
  old.resolve({type:'success',result:'STALE_DIALOGUE_MUST_NOT_PUBLISH'});await pending;await h.pause(50);
  assert(enabled,'reopening releases the previous operation busy state before its reply arrives');
  assert(!h.ooc().textContent.includes('STALE_DIALOGUE_MUST_NOT_PUBLISH'),'late reply cannot publish into a reopened editor');
  assert.equal(h.promptWrites().length,0);
 });
 await run('scope_changed_pending_dialogue',async h=>{
  const old=deferred();const pending=send(h,()=>old.promise);await h.waitFor(()=>h.modelCalls.length===1);
  await h.changeChat();old.resolve({type:'success',result:'STALE_SCOPE_REPLY'});await pending;await h.pause(30);
  assert(!h.ooc().textContent.includes('STALE_SCOPE_REPLY'),'late reply is rejected after the host chat/scope changes');assert.equal(h.promptWrites().length,0);
 });
 await run('durable_profile_changed_pending_compile',async h=>{
  await send(h,{type:'success',result:'Agreed evidence-only behavior.'});
  const old=deferred();h.modelQueue.push(()=>old.promise);const pending=h.button('지침 미리보기 만들기',h.ooc()).emit('click');await h.waitFor(()=>h.modelCalls.length===2);
  const stored=(await h.api.debugReadPromptOverrides()).prompts;
  await h.api.debugWritePromptOverrides({...stored,activeMemoryProfile:'External',memoryProfiles:{...stored.memoryProfiles,External:{name:'External',version:1,stages:{librarian:{sections:{custom_addendum:{mode:'append',text:'EXTERNAL_APPEND'}}}}}}});
  const writes=h.promptWrites().length;old.resolve({type:'success',result:JSON.stringify({append_text:'STALE_PROFILE_PREVIEW'})});await pending;await h.pause(20);
  assert(!h.ooc().textContent.includes('STALE_PROFILE_PREVIEW'),'compile cannot publish a preview from an outdated active profile');assert.equal(h.promptWrites().length,writes);
 });
 await run('save_closed_during_first_read',async h=>{
  await preview(h);const storage=h.context.risuai.pluginStorage,read=storage.getItem.bind(storage),gate=deferred();let captured=false;
  storage.getItem=async key=>{if(key==='libra:v1:prompt-overrides'&&!captured){captured=true;await gate.promise;}return read(key);};
  const before=h.promptWrites().length,pending=h.button('이 구역의 추가 지침으로 저장',h.ooc()).emit('click');await h.waitFor(()=>captured);await h.api.closeSettingsGui();gate.resolve();await pending;
  assert.equal(h.promptWrites().length,before,'closing before persistence read resolves cancels save with zero writes');
 });
 await run('save_closed_during_cas_read',async h=>{
  await preview(h);const storage=h.context.risuai.pluginStorage,read=storage.getItem.bind(storage),gate=deferred();let reads=0,captured=false;
  storage.getItem=async key=>{if(key==='libra:v1:prompt-overrides'&&++reads===2){captured=true;await gate.promise;}return read(key);};
  const before=h.promptWrites().length,pending=h.button('이 구역의 추가 지침으로 저장',h.ooc()).emit('click');await h.waitFor(()=>captured);await h.api.closeSettingsGui();gate.resolve();await pending;
  assert.equal(h.promptWrites().length,before,'closing during final CAS read cancels without write or rollback write');
 });
 await run('dirty_edit_during_save',async h=>{
  await preview(h);const storage=h.context.risuai.pluginStorage,read=storage.getItem.bind(storage),gate=deferred();let captured=false;
  storage.getItem=async key=>{if(key==='libra:v1:prompt-overrides'&&!captured){captured=true;await gate.promise;}return read(key);};
  const pending=h.button('이 구역의 추가 지침으로 저장',h.ooc()).emit('click');await h.waitFor(()=>captured);
  const input=h.document.querySelectorAll('textarea').find(n=>n.getAttribute('placeholder')==='예: 관계가 변하면 이전 상태와 변화 계기를 함께 남겨 줘.');input.value='UNSAVED_DIRECT_DRAFT';await input.emit('input');assert.equal(h.api.debugGuiSettingsState().dirty,true);
  gate.resolve();await pending;
  assert.equal(h.api.debugGuiSettingsState().dirty,true,'OOC completion preserves a newer dirty edit');
  assert.equal(h.document.querySelectorAll('textarea').find(n=>n.getAttribute('placeholder')===input.getAttribute('placeholder')).value,'UNSAVED_DIRECT_DRAFT');
 });
 await run('save_advances_own_settings_basis',async h=>{
  await preview(h);await h.button('이 구역의 추가 지침으로 저장',h.ooc()).emit('click');
  const state=h.api.debugGuiSettingsState();const basis=await h.api.debugReadSettingsPersistenceBasis();assert.equal(state.basisHash,basis.semanticHash,'OOC-only transaction advances the matching GUI durable basis');
 });
 await run('stale_failure_cannot_release_new_request',async h=>{
  const old=deferred();const pending=send(h,()=>old.promise);await h.waitFor(()=>h.modelCalls.length===1);
  await h.api.closeSettingsGui();await h.open();await h.memory();await h.expandOoc();
  const next=deferred();const newer=send(h,()=>next.promise);
  old.resolve({type:'fail',result:'STALE_FAILURE_MUST_NOT_PUBLISH'});await pending;await h.waitFor(()=>h.modelCalls.length===2);
  assert(h.button('OOC 보내기',h.ooc()).disabled,'old finally must not release the newer request busy flag');
  assert(!h.document.body.textContent.includes('STALE_FAILURE_MUST_NOT_PUBLISH'));
  next.resolve({type:'success',result:'CURRENT_REPLY'});await newer;assert(h.ooc().textContent.includes('CURRENT_REPLY'));
 });
 await run('detached_handlers_do_not_submit',async h=>{
  const oldSend=h.button('OOC 보내기',h.ooc()),oldInput=h.ooc().querySelector('textarea');
  await h.button('대화 시작',h.ooc()).emit('click');assert.equal(oldSend.isConnected,false);
  oldInput.value='DETACHED_DRAFT';await oldInput.emit('input');await oldSend.emit('click');
  assert.equal(h.modelCalls.length,0);assert.equal(h.ooc().querySelector('textarea').value,'');
 });
 await run('scope_change_before_model_submission',async h=>{
  const storage=h.context.risuai.pluginStorage,read=storage.getItem.bind(storage),gate=deferred();let captured=false;
  storage.getItem=async key=>{if(key==='libra:v1:prompt-overrides'&&!captured){captured=true;await gate.promise;}return read(key);};
  const input=h.ooc().querySelector('textarea');input.value='No stale submission';await input.emit('input');
  const pending=h.button('OOC 보내기',h.ooc()).emit('click');await h.waitFor(()=>captured);await h.changeChat();gate.resolve();await pending;
  assert.equal(h.modelCalls.length,0,'changing scope while admission reads are pending must prevent any submission');assert.equal(h.promptWrites().length,0);
 });
 await run('save_committed_then_closed',async h=>{
  await preview(h);const storage=h.context.risuai.pluginStorage,write=storage.setItem.bind(storage),gate=deferred();let captured=false;
  storage.setItem=async(key,value)=>{const result=await write(key,value);if(key==='libra:v1:prompt-overrides'&&!captured){captured=true;await gate.promise;}return result;};
  const pending=h.button('이 구역의 추가 지침으로 저장',h.ooc()).emit('click');await h.waitFor(()=>captured);await h.api.closeSettingsGui();gate.resolve();await pending;
  const stored=await h.api.debugReadPromptOverrides();assert.equal(stored.prompts.memoryProfiles[stored.prompts.activeMemoryProfile].stages.librarian.sections.custom_addendum.text,'AUTHORITY_APPEND_SENTINEL');
  assert.equal(h.promptWrites().length,1,'a submitted transaction finishes readback, without a close-only rollback');
 });
 await run('external_setting_change_blocks_basis_rebase',async h=>{
  await preview(h);const basisBefore=h.api.debugGuiSettingsState().basisHash;
  await h.api.debugWriteStoredSettings({enable_gui:true,maxMessages:41});
  await h.button('이 구역의 추가 지침으로 저장',h.ooc()).emit('click');
  assert.equal(h.api.debugGuiSettingsState().basisHash,basisBefore,'OOC must not bless unrelated concurrent durable settings');
  assert.notEqual((await h.api.debugReadSettingsPersistenceBasis()).semanticHash,basisBefore);
 });
 await run('selected_target_does_not_share_preview',async h=>{
  await preview(h);let select=h.ooc().querySelector('select');const initial=select.value,next=select.querySelectorAll('option').find(n=>n.value!==initial).value;
  select.value=next;await select.emit('change');assert(!h.ooc().textContent.includes('AUTHORITY_APPEND_SENTINEL'));
  assert(!h.button('이 구역의 추가 지침으로 저장',h.ooc()),'another target cannot save the old target preview');
  select=h.ooc().querySelector('select');select.value=initial;await select.emit('change');assert(h.ooc().textContent.includes('AUTHORITY_APPEND_SENTINEL'));
  assert.equal(h.promptWrites().length,0);
 });
 await run('failed_provider_never_saves',async h=>{
  h.context.risuai.runLLMModel=undefined;h.context.risuai.llm=undefined;
  const input=h.ooc().querySelector('textarea');input.value='Tell me how to preserve evidence';await input.emit('input');await h.button('OOC 보내기',h.ooc()).emit('click');
  assert.equal(h.modelCalls.length,0);assert.equal(h.promptWrites().length,0);assert(h.ooc().textContent.includes('OOC 실패'));assert(!h.button('이 구역의 추가 지침으로 저장',h.ooc()));
 });
 await run('save_readback_failure_rolls_back',async h=>{
  await preview(h);const storage=h.context.risuai.pluginStorage,write=storage.setItem.bind(storage);const raw=h.values.get('libra:v1:prompt-overrides');let corrupt=true;
  storage.setItem=async(key,value)=>write(key,key==='libra:v1:prompt-overrides'&&corrupt?(corrupt=false,'{"schema":"corrupt"}'):value);
  await h.button('이 구역의 추가 지침으로 저장',h.ooc()).emit('click');
  assert.equal(h.values.get('libra:v1:prompt-overrides'),raw,'failed readback restores the exact previous prompt record');assert(!h.button('저장 완료',h.ooc()));assert(h.ooc().textContent.includes('저장 실패'));
 });
 await run('unrelated_settings_save_after_ooc',async h=>{
  await preview(h);await h.button('이 구역의 추가 지침으로 저장',h.ooc()).emit('click');
  const label=h.document.querySelectorAll('label').find(n=>n.textContent==='최대 대기 시간(초)');assert(label);const input=label.parentNode.querySelector('input');input.value='91';await input.emit('input');assert(h.api.debugGuiSettingsState().dirty);
  await h.document.querySelectorAll('button').filter(n=>n.textContent==='설정 저장').at(-1).emit('click');await h.waitFor(()=>h.api.debugGuiSettingsState().dirty===false);
  const current=await h.api.debugCompileMemoryPrompt('librarian');assert(current.body.includes('AUTHORITY_APPEND_SENTINEL'));assert.equal(h.api.debugGuiSettingsState().lastError,'');
 });
 await run('interrupted_save_reopen_preserves_dirty_draft',async h=>{
  const input=h.document.querySelectorAll('textarea').find(n=>n.getAttribute('placeholder')==='예: 관계가 변하면 이전 상태와 변화 계기를 함께 남겨 줘.');input.value='PRESERVE_UNSAVED_AFTER_CLOSE';await input.emit('input');
  await preview(h);const storage=h.context.risuai.pluginStorage,write=storage.setItem.bind(storage);let release,held=false;const gate=new Promise(r=>release=r);
  storage.setItem=async(key,value)=>{const result=await write(key,value);if(key==='libra:v1:prompt-overrides'&&!held){held=true;await gate;}return result;};
  const pending=h.button('이 구역의 추가 지침으로 저장',h.ooc()).emit('click');await h.waitFor(()=>held);await h.api.closeSettingsGui();release();await pending;
  await h.open();await h.memory();await h.expandOoc();
  assert(!h.button('이 구역의 추가 지침으로 저장',h.ooc()),'an interrupted save must not leave a stale enabled preview retry');
  assert(h.ooc().textContent.includes('결과 확인이 필요합니다'),'uncertain close outcome is disclosed with reload guidance');
  assert(h.api.debugGuiSettingsState().dirty);assert(h.document.querySelectorAll('textarea').some(n=>n.value==='PRESERVE_UNSAVED_AFTER_CLOSE'));
  assert((await h.api.debugCompileMemoryPrompt('librarian')).body.includes('AUTHORITY_APPEND_SENTINEL'));assert.equal(h.promptWrites().length,1);
 });
 console.log(JSON.stringify({status:'PASS',cases,boundary:'registered production GUI; deferred local host/storage promises; no real model/server'}));
})().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1);});

'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {JSDOM}=require('jsdom');
const {load}=require('./host.cjs');
const prefix='serial_gradation_agents_for_rp:';
const wait=async fn=>{const start=Date.now();while(Date.now()-start<20000){const result=fn();if(result)return result;await new Promise(r=>setTimeout(r,10));}throw Error('GUI action did not settle');};
async function gui(t,provider={}){
 const dom=new JSDOM('<!doctype html><html><body></body></html>',{pretendToBeVisual:true,url:'https://offline.invalid/'}),store=new Map(),writes=[],unloads=[];
 let failPrompt=false,hidden=false,clipboard=null;
 const storage={getItem:async k=>store.get(k)??null,setItem:async(k,v)=>{writes.push(k);if(failPrompt&&k===prefix+'prompt_overrides:v2'){failPrompt=false;throw Error('SIMULATED_SETTINGS_WRITE_FAILURE');}store.set(k,v);},removeItem:async k=>{writes.push(k);store.delete(k);}};
 const host=await load({api:{pluginStorage:storage,onUnload:async fn=>unloads.push(fn),hideContainer:async()=>{hidden=true;},showContainer:async()=>{hidden=false;}},testGlobals:{window:dom.window,Element:dom.window.Element,navigator:{clipboard:{writeText:async value=>{clipboard=value;}}},document:dom.window.document,getComputedStyle:dom.window.getComputedStyle.bind(dom.window),MutationObserver:dom.window.MutationObserver,requestAnimationFrame:dom.window.requestAnimationFrame.bind(dom.window),cancelAnimationFrame:dom.window.cancelAnimationFrame.bind(dom.window)}});
 t.after(async()=>{await host.plugin.closeSettingsGui();for(const fn of unloads)await fn();dom.window.close();});
 await host.plugin.saveProviderPreset('default',{provider:'openai',url:'https://api.openai.com/v1/chat/completions',model:'test-offline',key:'CREDENTIAL_SENTINEL',extra_headers_json:'{"Authorization":"Bearer HEADER_SECRET","HTTP-Referer":"https://example.test"}',...provider});
 await host.plugin.saveProviderPreset('my-secret-model',{provider:'custom',url:'https://offline.invalid/v1/chat/completions',model:'named-provider',key:'NAMED_SECRET_SENTINEL'});
 await host.plugin.savePromptOverrides({before:{shadow_act:{mode:'replace',customPrompt:'Plain prompt: preserve the word token.\nKeep "quoted text".',extraPrompt:''}}});
 await host.plugin.openSettingsGui();await host.plugin.debugNavigateGui('transfer','flow');
 const doc=dom.window.document;
 const button=text=>{const found=[...doc.querySelectorAll('button')].find(b=>b.textContent.trim()===text);assert.ok(found,text);return found;};
 const input=payload=>{const box=doc.querySelector('#mockup-import-text');assert.ok(box);box.value=typeof payload==='string'?payload:JSON.stringify(payload);box.dispatchEvent(new dom.window.Event('input',{bubbles:true}));};
 const exportPayload=async(scope='all')=>{clipboard=null;doc.querySelector(`[data-export-scope="${scope}"]`).click();doc.querySelector('[data-manage-action="export-copy"]').click();return await wait(()=>clipboard&&JSON.parse(clipboard));};
 const exportAll=()=>exportPayload('all');
 const importPayload=async()=>{doc.querySelector('[data-manage-action="import-replace"]').click();const confirm=doc.querySelector('.overlay.is-open .dialog button.btn--primary');if(confirm){confirm.click();await new Promise(r=>setTimeout(r,80));}};

 return {...host,store,writes,doc,button,input,exportAll,exportPayload,importPayload,isHidden:()=>hidden,failPromptOnce:()=>{failPrompt=true;}};
}
for(const scope of ['all','flow'])test(`${scope} backup restores draft budget selection, output cap and length after saving`,async t=>{
 const h=await gui(t,{provider:'ollama',url:'http://127.0.0.1:11434',model:'deepseek-v4.1-flash:1017-cloud',max_tokens:4096,reasoning_preset:'off'});
 const save=async()=>{await wait(()=>!h.doc.querySelector('#savebar [data-save]').disabled);h.doc.querySelector('#savebar [data-save]').click();await wait(()=>!h.plugin.debugGuiStateInfo().dirty);};
 const selectBudget=async id=>{
  await h.plugin.debugNavigateGui('quick','flow');
  const control=h.doc.querySelector('[data-work-scale-field="draftBudgetPreset"]');assert.ok(control);
  control.value=id;control.dispatchEvent(new h.doc.defaultView.Event('change',{bubbles:true}));
  await save();await h.plugin.debugNavigateGui('transfer','flow');
 };
 await selectBudget('maximum');
 const payload=await h.exportPayload(scope);
 assert.equal(payload.runtime.draftBudgetPreset,'maximum');
 let manualPayload;
 for(const previous of ['manual','minimum']){
  await selectBudget(previous);
  if(previous==='manual')manualPayload=await h.exportPayload(scope);
  h.input(payload);await h.importPayload();await save();
  const stored=await h.plugin.getRuntimeSettings(),restored=await h.exportPayload(scope);
  assert.equal(stored.draft_budget_preset,'maximum',`replaces previous ${previous}`);
  assert.equal(restored.runtime.draftBudgetPreset,'maximum');
  assert.equal(Number(stored.target_draft_min_chars),8000);assert.equal(Number(stored.target_draft_max_chars),12000);
  assert.equal(Number(stored.max_previous_stage_chars),30000);assert.equal(Number(stored.max_injection_chars),30000);
  const stage=h.plugin.debugInspectWorkScale().stages.find(stage=>stage.id==='shadow_act');
  assert.equal(stage.maxTokens,24576);assert.equal(stage.draftBudgetApplied,true);
 }
 h.input(manualPayload);await h.importPayload();await save();
 assert.equal((await h.plugin.getRuntimeSettings()).draft_budget_preset,'manual');
 const stage=h.plugin.debugInspectWorkScale().stages.find(stage=>stage.id==='shadow_act');
 assert.equal(stage.maxTokens,4096);assert.equal(stage.draftBudgetApplied,false);
 assert.equal((await h.plugin.listProviderPresets()).default.max_tokens,4096);
 assert.equal(h.getCalls(),0);
});
test('safe full settings backup includes plain custom prompts but no credential fields or secret headers',async t=>{
 const h=await gui(t),payload=await h.exportAll(),text=JSON.stringify(payload);
 assert.equal(payload.includesSecrets,false);assert.ok(payload.promptOverrides.before.shadow_act.customPrompt.includes('word token'));
 assert.equal(payload.providerPresets['my-secret-model']?.model,'named-provider','preset names are labels, not credential field names');
 assert.doesNotMatch(text,/CREDENTIAL_SENTINEL|HEADER_SECRET|NAMED_SECRET_SENTINEL/);
 assert.equal([...h.doc.querySelectorAll('label')].some(n=>n.textContent.includes('API 키 / 토큰 / Vertex JSON 포함')),false);
 assert.equal(h.getCalls(),0);
});
test('full settings backup and import preserve manual skills and final NSFW forwarding preference',async t=>{
 const h=await gui(t),payload=await h.exportAll();
 const raw='---\nname: manual-backup\ndescription: A stored user procedure\n---\nEXACT_BACKUP_SKILL';
 payload.runtime.skill_stage_selections={shadow_act:['manual-backup'],aide_world:['physical-conflict']};
 payload.runtime.skill_stage_references={shadow_act:{'manual-backup':['child']}};
 payload.runtime.skill_custom_library={'manual-backup':{id:'manual-backup',raw,references:[{id:'child',title:'Reference',body:'EXACT_BACKUP_REFERENCE'}]}};
 payload.runtime.nsfw_inject_final_request='true';
 h.input(payload);await h.importPayload();h.doc.querySelector('#savebar [data-save]').click();await wait(()=>!h.plugin.debugGuiStateInfo().dirty);
 const restored=await h.exportAll();
 assert.deepEqual(restored.runtime.skillStageSelections.shadow_act,['manual-backup']);
 assert.deepEqual(restored.runtime.skillStageSelections.aide_world,['physical-conflict']);
 assert.deepEqual(restored.runtime.skillStageReferences.shadow_act['manual-backup'],['child']);
 assert.equal(restored.runtime.nsfwInjectFinalRequest,true);
 assert.equal((await h.plugin.getRuntimeSettings()).nsfw_inject_final_request,'true');
 assert.equal(restored.runtime.skillCustomLibrary['manual-backup'].raw,raw);assert.equal(h.getCalls(),0);
});
test('invalid JSON, invalid version and late invalid provider payload leave the GUI draft and stored config unchanged',async t=>{
 const h=await gui(t),before=await h.exportAll(),persisted=JSON.stringify([...h.store]);
 for(const payload of ['{', {...before,version:999}, {...before,providerPresets:{},runtime:{mode:'lite'}}]){
  h.input(payload);await h.importPayload();
  assert.equal(JSON.stringify([...h.store]),persisted);
  const after=await h.exportAll();delete after.exportedAt;const expected={...before};delete expected.exportedAt;
  assert.deepEqual(after,expected,'rejected import must not partially change the editor');
 }
});
test('one explicit save restores imported custom prompts and leaves existing credentials untouched',async t=>{
 const h=await gui(t),payload=await h.exportAll();
 payload.promptOverrides.before.shadow_act.customPrompt='Imported plain prompt.\nPreserve "token" as ordinary prose.';
 const credentials=[...h.store].filter(([k])=>/secret|token/.test(k));
 h.input(payload);await h.importPayload();
 assert.notEqual((await h.plugin.getPromptOverrides()).before.shadow_act.customPrompt,payload.promptOverrides.before.shadow_act.customPrompt,'import is only a draft before Save');
 const start=h.writes.length;h.doc.querySelector('#savebar [data-save]').click();
 await wait(()=>!h.plugin.debugGuiStateInfo().dirty);
 assert.equal((await h.plugin.getPromptOverrides()).before.shadow_act.customPrompt,payload.promptOverrides.before.shadow_act.customPrompt);
 assert.equal((await h.plugin.listProviderPresets())['my-secret-model'].model,'named-provider');
 assert.deepEqual([...h.store].filter(([k])=>/secret|token/.test(k)),credentials);
 assert.ok(!h.writes.slice(start).some(k=>/secret|token|writer_designs|draft_checkpoints|retrace_handoff/.test(k)));
 assert.equal(h.getCalls(),0);
});
test('failed imported-setting write restores the exact previous persistent config',async t=>{
 const h=await gui(t),payload=await h.exportAll();payload.runtime.mode='lite';payload.promptOverrides.before.shadow_act.customPrompt='MUST_NOT_COMMIT';
 h.input(payload);await h.importPayload();
 const before=JSON.stringify([...h.store].sort(([a],[b])=>a.localeCompare(b)));h.failPromptOnce();
 h.doc.querySelector('#savebar [data-save]').click();
 await wait(()=>!h.doc.body.textContent.includes('설정을 저장하고 있습니다')&&/저장하지 못|되돌렸|실패/.test(h.doc.body.textContent));
 assert.equal(JSON.stringify([...h.store].sort(([a],[b])=>a.localeCompare(b))),before);
 assert.notEqual((await h.plugin.getPromptOverrides()).before.shadow_act.customPrompt,'MUST_NOT_COMMIT');assert.equal(h.getCalls(),0);
});
test('discarding an imported draft does not change how later ordinary connection edits are saved',async t=>{
 const h=await gui(t),payload=await h.exportAll();payload.runtime.mode='lite';
 h.input(payload);await h.importPayload();
 h.doc.querySelector('[data-open="dlg-close"]').click();await wait(()=>[...h.doc.querySelectorAll('button')].some(b=>b.textContent.trim()==='변경 버리고 닫기'));
 h.button('변경 버리고 닫기').click();
 await wait(h.isHidden);
 await h.plugin.openSettingsGui();await h.plugin.debugNavigateGui('providers','providers');
 const key=await wait(()=>h.doc.querySelector('input[type="password"]'));key.value='NEW_SYNTHETIC_KEY';key.dispatchEvent(new h.doc.defaultView.Event('change',{bubbles:true}));
 h.doc.querySelector('#savebar [data-save]').click();await wait(()=>!h.plugin.debugGuiStateInfo().dirty);
 assert.equal((await h.plugin.listProviderPresets()).default.key,'NEW_SYNTHETIC_KEY');assert.equal(h.getCalls(),0);
});

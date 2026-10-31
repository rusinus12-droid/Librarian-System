'use strict';
// 2026-10-31: the main card had no "NSFW 지침 주입" switch and raw lowercase mode
// labels, and the SHADOW prompt preview showed only the system prompt, so NSFW
// guidance (sent in the user prompt) looked ignored by SHADOW ACT.
const {test}=require('node:test'),assert=require('node:assert/strict');
const {gradia,wait}=require('./fixtures/companion_gui_fixture.cjs');
test('NSFW guidance switch is synchronized everywhere and the SHADOW preview shows what is sent',async()=>{
 const f=await gradia();
 const modeSelect=()=>f.doc.querySelector('[data-detail="main"] select[data-existing-response-field="nsfwMode"]');
 const toggles=()=>[...f.doc.querySelectorAll('input[data-existing-response-field="nsfwGuidanceEnabled"]')];
 const preview=async()=>{
  [...f.doc.querySelectorAll('[data-action="prompt-preview"]')].find(button=>button.closest('[data-detail="shadow"]')).click();
  await wait(()=>[...f.doc.querySelectorAll('pre.json')].some(pre=>pre.textContent.includes('NSFW GUIDANCE')),'preview');
  const text=[...f.doc.querySelectorAll('pre.json')].at(-1).textContent;
  f.doc.querySelector('.dialog__actions .btn, [role="dialog"] .btn')?.click();
  return text;
 };
 try{
  await f.plugin.openSettingsGui();
  assert.deepEqual([...modeSelect().options].map(option=>option.textContent),['OFF','SOFT','DIRECT','EXPLICIT']);
  assert.ok(toggles().some(toggle=>toggle.closest('[data-detail="main"]')),'the main card has the guidance switch');
  assert.ok(toggles().length>=2);
  modeSelect().value='direct';modeSelect().dispatchEvent(new f.w.Event('change',{bubbles:true}));
  await wait(()=>toggles().every(toggle=>toggle.checked),'guidance on everywhere');
  assert.match(await preview(),/\[USER PROMPT · NSFW GUIDANCE · writing\]\s+NSFW GUIDANCE — DIRECT/);
  toggles().find(toggle=>toggle.closest('[data-detail="main"]')).click();
  await wait(()=>toggles().every(toggle=>!toggle.checked),'guidance off everywhere');
  assert.match(await preview(),/\[USER PROMPT · NSFW GUIDANCE · writing\]\s+\(전달 안 함: NSFW 지침 주입 꺼짐\)/);
  assert.deepEqual(f.errors,[]);
 }finally{await f.close();}
});

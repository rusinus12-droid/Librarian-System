'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {gradia,wait,sleep}=require('./fixtures/companion_gui_fixture.cjs');
const KEY='serial_gradation_agents_for_rp:runtime_settings:v2';
const settings=f=>JSON.parse(f.store.get(KEY)).settings;
async function save(f){f.doc.querySelector('#savebar [data-save]').click();await wait(()=>!f.plugin.debugGuiStateInfo().dirty,'manual skill save');}
async function stage(f,id){const select=f.doc.querySelector('#skill-stage-filter');select.value=id;select.dispatchEvent(new f.w.Event('change',{bubbles:true}));await sleep(15);}
test('manual stage selections save, reopen and cancel independently while legacy preferences remain archived',async()=>{
 const f=await gradia({storage:{[KEY]:JSON.stringify({version:3,settings:{skill_router_enabled:'true',skill_router_top_k:3,skill_priority_overrides:{shadow_act:{'physical-conflict':200}}}})}});
 try{
  await f.plugin.openSettingsGui();await f.plugin.debugNavigateGui('skills','flow');
  assert.equal(f.doc.querySelectorAll('[data-skill-priority],[data-skill-router-top-k]').length,0);
  assert.match(f.doc.querySelector('[data-base-quality]').textContent,/기본 품질 규칙/);
  assert.equal(f.doc.querySelector('[data-skill-selected="physical-conflict"]').checked,false);
  f.doc.querySelector('[data-skill-selected="physical-conflict"]').click();await save(f);
  assert.deepEqual(settings(f).skill_stage_selections.shadow_act,['physical-conflict']);
  assert.equal(settings(f).skill_router_legacy_archive.skill_router_top_k,3);
  await stage(f,'aide_world');assert.equal(f.doc.querySelector('[data-skill-selected="physical-conflict"]').checked,false);
  f.doc.querySelector('[data-skill-selected="physical-conflict"]').click();
  f.doc.querySelector('#savebar [data-revert]').click();await wait(()=>!f.plugin.debugGuiStateInfo().dirty,'selection cancel');
  assert.deepEqual(settings(f).skill_stage_selections.aide_world,[]);
  await f.plugin.closeSettingsGui();await f.plugin.openSettingsGui();await f.plugin.debugNavigateGui('skills','flow');await stage(f,'shadow_act');
  assert.equal(f.doc.querySelector('[data-skill-selected="physical-conflict"]').checked,true);assert.equal(f.getCalls(),0);assert.deepEqual(f.errors,[]);
 }finally{await f.close();}
});
test('genre recommendations apply explicit choices and references as a cancellable draft, and oversized combinations stay unchanged',async()=>{
 const f=await gradia();
 try{
  await f.plugin.openSettingsGui();await f.plugin.debugNavigateGui('skills','flow');
  assert.equal(f.doc.querySelectorAll('[data-skill-genre-card]').length,9);
  const storedBefore=JSON.stringify([...f.store]);
  f.doc.querySelector('[data-skill-genre-details="mystery"]').click();
  const dialog=f.doc.querySelector('.skill-preset-dialog'),library=f.plugin.getSkillLibrary();
  assert.equal(dialog.querySelector('h2').textContent,'미스터리 · 추리');
  const items=[...dialog.querySelectorAll('[data-genre-detail-skill]')];assert.equal(items.length,5);
  for(const item of items)assert.equal(item.querySelector('p').textContent,library[item.dataset.genreDetailSkill].koDescription);
  assert.match(dialog.textContent,/단서와 증언/);assert.match(dialog.textContent,/단서에서 추리로/);
  assert.equal(f.plugin.debugGuiStateInfo().dirty,false);assert.equal(JSON.stringify([...f.store]),storedBefore);
  [...dialog.querySelectorAll('button')].find(b=>b.textContent==='닫기').click();
  assert.equal(f.doc.querySelector('[data-skill-selected="genre-lens"]').checked,false);
  f.doc.querySelector('[data-skill-genre-card="mystery"] [data-skill-genre-apply="all"]').click();await save(f);
  const saved=settings(f);assert.deepEqual(saved.skill_stage_selections.shadow_act,['genre-lens','information-exchange']);
  assert.deepEqual(saved.skill_stage_references.shadow_act['genre-lens'],['mystery-deduction-lens']);
  assert.deepEqual(saved.skill_stage_selections.aide_world,['institutional-procedure']);
  assert.equal(f.doc.querySelector('[data-skill-genre-card="mystery"]').classList.contains('is-selected'),true);
  f.doc.querySelector('[data-skill-genre-details="action"]').click();
  f.doc.querySelector('.skill-preset-dialog [data-skill-genre-apply="stage"]').click();
  f.doc.querySelector('[data-skill-selected="quiet-interior-beat"]').click();
  f.doc.querySelector('[data-skill-selected="consequential-decision"]').click();
  assert.equal(f.doc.querySelector('[data-skill-selected="consequential-decision"]').checked,true);
  f.doc.querySelector('[data-skill-selected="information-exchange"]').click();
  assert.equal(f.doc.querySelector('[data-skill-selected="information-exchange"]').checked,false,'four long procedures cannot displace core material');
  assert.match(f.doc.querySelector('[data-skill-budget]').textContent,/24,000자/);
  f.doc.querySelector('#savebar [data-revert]').click();await wait(()=>!f.plugin.debugGuiStateInfo().dirty,'genre cancel');
  assert.deepEqual(settings(f).skill_stage_selections.shadow_act,['genre-lens','information-exchange']);assert.equal(f.getCalls(),0);
 }finally{await f.close();}
});
test('prompt preview includes unsaved manual stage selections and independent basic quality rules',async()=>{
 const f=await gradia();
 try{
  await f.plugin.openSettingsGui();await f.plugin.debugNavigateGui('skills','flow');
  f.doc.querySelector('[data-skill-selected="physical-conflict"]').click();
  f.doc.querySelector('[data-detail="shadow"] [data-action="prompt-preview"]').click();
  const dialog=f.doc.querySelector('.overlay.is-open'),text=dialog.querySelector('pre').textContent;
  assert.match(text,/BASE QUALITY FLOOR/);assert.match(text,/\[COMPILED SKILL — physical-conflict\]/);assert.ok(!text.includes('[COMPILED SKILL — quiet-interior-beat]'));
  assert.equal(f.getCalls(),0);
 }finally{await f.close();}
});
test('new custom skills start unselected and deleting one removes only its explicit stage links',async()=>{
 const f=await gradia();
 try{
  await f.plugin.openSettingsGui();await f.plugin.debugNavigateGui('skills','flow');
  f.doc.querySelector('[data-open="dlg-skill"]').click();
  const dialog=f.doc.querySelector('.overlay.is-open'),area=dialog.querySelector('textarea');
  const raw='---\nname: manual-custom\ndescription: Exact custom writing procedure\n---\n# Manual custom\nCUSTOM_PRESERVED_SOURCE';
  area.value=raw;area.dispatchEvent(new f.w.Event('input',{bubbles:true}));
  assert.equal(dialog.querySelector('select').value,'inactive');[...dialog.querySelectorAll('button')].find(b=>b.textContent==='추가').click();await sleep(50);
  assert.equal(f.doc.querySelector('[data-skill-selected="manual-custom"]').checked,false);
  f.doc.querySelector('[data-skill-selected="manual-custom"]').click();f.doc.querySelector('[data-skill-selected="physical-conflict"]').click();await save(f);
  assert.equal(JSON.parse(settings(f).skill_custom_library)['manual-custom'].raw,raw);
  f.doc.querySelector('[data-skill-del="manual-custom"]').click();[...f.doc.querySelectorAll('.overlay.is-open button')].find(b=>b.textContent==='삭제').click();await sleep(40);await save(f);
  assert.deepEqual(settings(f).skill_stage_selections.shadow_act,['physical-conflict']);assert.equal(f.getCalls(),0);
 }finally{await f.close();}
});

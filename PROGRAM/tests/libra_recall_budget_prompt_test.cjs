'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {fixture}=require('./fixtures/libra_unified_runtime_fixture.cjs');
const source=fs.readFileSync(path.join(__dirname,'../plugins/LIBRA.js'),'utf8');
const options={queryText:'은빛 열쇠 약속',consumerPolicy:{maxCharacters:16000,maxUnits:64}};

test('all recall presets apply a shared lens cap; custom caps persist until a preset is selected',async t=>{
 const f=await fixture();t.after(()=>f.r.cleanup());
 const fresh=await f.r.api.getLibraMemorySettings();
 assert.equal(fresh.recallMaxChars,6000);assert.equal(fresh.stateMaxItems,24);assert.equal(fresh.recallLensMaxChars,6000);
 assert.equal(f.r.core.normalizeMemorySettings({...fresh,recallMaxChars:5000}).recallMaxChars,5000,'existing total budgets are preserved');
 for(const preset of f.r.api.getRecallBudgetPresets()){
  const values=f.r.api.getRecallBudgetPresetValues(preset.id);
  const saved=await f.r.api.saveLibraMemorySettings({...await f.r.api.getLibraMemorySettings(),...values,recallLensSharePercent:40});
  assert.equal(saved.recallMaxChars,preset.chars);assert.equal(saved.stateMaxItems,preset.units);
  assert.equal(saved.recallLensMaxChars,preset.chars);assert.equal(saved.recallLensBudgetMode,'shared');
  assert.ok(Math.floor(saved.recallMaxChars*.4)<=saved.recallLensMaxChars);
 }
 let saved=await f.r.api.saveLibraMemorySettings({...await f.r.api.getLibraMemorySettings(),recallLensBudgetMode:'custom',recallLensMaxChars:1800});
 assert.equal(saved.recallLensMaxChars,1800);
 saved=await f.r.api.saveLibraMemorySettings({...saved,recallMaxChars:10000});assert.equal(saved.recallLensMaxChars,1800);
 const restarted=await fixture({snapshot:{chat:f.chat,values:[...f.r.values]}});t.after(()=>restarted.r.cleanup());
 assert.equal((await restarted.r.api.getLibraMemorySettings()).recallLensMaxChars,1800);
 saved=await restarted.r.api.saveLibraMemorySettings({...await restarted.r.api.getLibraMemorySettings(),...restarted.r.api.getRecallBudgetPresetValues('standard')});
 assert.equal(saved.recallLensBudgetMode,'shared');assert.equal(saved.recallLensMaxChars,6000);
 const resized=restarted.r.core.normalizeMemorySettings({...saved,recallMaxChars:8000});assert.equal(resized.recallLensMaxChars,8000);
 assert.equal(restarted.r.core.normalizeMemorySettings({...saved,recallLensBudgetMode:'custom',recallLensMaxChars:20000}).recallLensMaxChars,6000);
});

test('maximum recall is not clipped by an old hidden 4000-character lens setting; custom caps still work',async t=>{
 const {lensFixture}=require('./fixtures/libra_lens_handoff_fixture.cjs');const f=await lensFixture();t.after(()=>f.close());
 for(const view of ['기대','불안']){
  f.setReply({items:Array.from({length:8},(_,n)=>({label:view+' 관점 '+n,text:`은빛 열쇠의 반환 약속을 바라보는 ${view} 관점 ${n}. `+'이 약속을 계속 마음에 두었다. '.repeat(23),refs:['t2-a'],basis:'반환 약속에 대한 해석'}))});
  await f.add('열쇠 '+view,'active',{recall:{enabled:true,mode:'relevant',share:50,maxItems:8}});
 }
 await f.api.saveLensRegistry({...await f.api.getLensRegistry(),recallMaxChars:4000});
 await f.api.saveLibraMemorySettings({...await f.api.getLibraMemorySettings(),...f.api.getRecallBudgetPresetValues('maximum')});
 const wide=await f.api.executeStateMemoryQuery(options);
 assert.equal(wide.lensRecall.budgetChars,16000);
 assert.ok(wide.lensRecall.usedChars>4000,JSON.stringify({chars:wide.lensRecall.usedChars,count:wide.lensRecall.injectedItems.length}));
 assert.ok(wide.packet.characterLength<=16000);assert.equal(wide.bundle.budget.familyAllocation.lens.weight,40);
 await f.api.saveLibraMemorySettings({...await f.api.getLibraMemorySettings(),recallLensBudgetMode:'custom',recallLensMaxChars:1800});
 const narrow=await f.api.executeStateMemoryQuery(options);
 assert.equal(narrow.lensRecall.budgetChars,1800);assert.ok(narrow.lensRecall.usedChars<=1800);
});

test('Classic uses the current line contract and readable State fields without losing source checks',async t=>{
 const f=await fixture();t.after(()=>f.r.cleanup());await f.run();
 const messages=await f.control.hooks.beforeRequest([{role:'user',content:'은빛 열쇠는 누가 보관해?'}],'model');
 const block=messages.find(row=>row.role==='system'&&row.content.includes('<LIBRA_CLASSIC_RECALL>'))?.content;
 assert.ok(block);assert.match(block,/selection order, not chronological order/);
 assert.doesNotMatch(block,/@T<n>|RELEVANT HISTORY|SCENE DETAILS|object_state|lifecycleId|holderRef|participants: \[\]/);
 assert.match(block,/은빛 열쇠 — 소지자: 민아/);
 assert.match(block,/\[세계 · state · T5\]/);
 assert.equal(f.r.api.getRuntime().lastMemoryInjectionMeta.finalVerification.status,'verified');
});

test('visible budget controls execute the production preset handler and show lens targets beside total budget',async t=>{
 const {JSDOM}=require('jsdom'),dom=new JSDOM('<body></body>');t.after(()=>dom.window.close());
 const f=await fixture();t.after(()=>f.r.cleanup());const document=dom.window.document;
 const el=(tag,props={},children=[])=>{
  const node=document.createElement(tag);
  for(const[key,value]of Object.entries(props)){if(key==='text')node.textContent=value;else if(key==='dataset')Object.assign(node.dataset,value);
   else if(key==='style')Object.assign(node.style,value);else if(key.startsWith('on'))node.addEventListener(key.slice(2).toLowerCase(),value);else if(value!=null)node[key]=value;}
  for(const child of children.flat(Infinity))if(child!=null)node.append(child);return node;
 };
 const context=vm.createContext({LibraMemoryCore:f.r.core,settings:await f.r.api.getLibraMemorySettings(),guiEl:el,field:(label,input)=>el('label',{},[label,input]),renderSettingsGui:async()=>{}});
 context.patch=values=>{context.settings=f.r.core.normalizeMemorySettings({...context.settings,...values});};
 const a=source.indexOf('      const budgetPresets ='),b=source.indexOf('      const advanced=',a);
 const panel=vm.runInContext('(function(){'+source.slice(a,b)+';return budgetPresetButtons;})()',context);document.body.append(panel);
 const buttons=[...panel.querySelectorAll('button')];assert.equal(buttons.length,4);
 assert.match(panel.querySelector('[data-recall-budget-summary]').textContent,/렌즈 목표 40%/);
 buttons.find(button=>button.textContent.includes('최대')).click();
 assert.equal(context.settings.recallMaxChars,16000);assert.equal(context.settings.recallLensMaxChars,16000);
 assert.equal(context.settings.recallLensBudgetMode,'shared');
 assert.match(buttons[3].title,/6,400자/);
 const layout=source.slice(b,source.indexOf("    if(groupId==='ai')",b));
 assert.ok(layout.includes("card('리콜 예산'"));assert.equal(layout.slice(0,layout.indexOf("return guiEl('div'")).includes('budgetPresetButtons,'),false);
 assert.equal(source.includes("lensField('렌즈 회상 최대 글자 수'"),false);
});

'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {JSDOM}=require('jsdom');
const source=fs.readFileSync(path.join(__dirname,'../sdk/MemorySuiteSourceInput.libra.source.js'),'utf8');
const tick=async()=>{for(let i=0;i<12;i++)await Promise.resolve();};
for(const owner of ['libra','hayaku','flashback'])test(owner+' shared editor preserves old settings and owns only its projection',async()=>{
 const context=vm.createContext({console:{log(){throw Error('preview logging forbidden')},warn(){throw Error('preview logging forbidden')}},setTimeout,clearTimeout});vm.runInContext(source,context);
 const dom=new JSDOM('<main></main>');let stored=JSON.stringify({mode:'off',epoch:7,sourceRuleEpoch:9,future:{keep:true},sourceRules:null,ignoredTags:[],externalRulesVersion:1}),writes=0,reads=0;
 const policy=context.createMemorySuiteSourceInputPolicy({owner,read:async()=>stored,write:async body=>{stored=body;writes++;return true},readSample:async()=>{reads++;return {text:'<source>kept</source><decoration>drop</decoration>',role:'assistant'}},projectLegacySample:sample=>'LEGACY '+sample.text});
 const root=dom.window.document.querySelector('main');policy.mountControls(root);await policy.ready();await tick();
 try{
  assert.equal(root.querySelector('[data-source-input-controls]').dataset.sourceInputControls,owner);assert.equal(root.querySelectorAll('[data-source-input-list]').length,1);assert.equal(writes,0);assert.equal(reads,0);
  await root.querySelector('[data-source-input-preview]').onclick();assert.match(root.querySelector('[data-source-input-output]').textContent,/^LEGACY /);assert.equal(reads,1);assert.equal(writes,0);
  const row=[...root.querySelectorAll('[data-source-input-row]')].at(-1),value=row.querySelector('[data-rule-value]');value.value='decoration';value.dispatchEvent(new dom.window.Event('input'));
  await root.querySelector('[data-source-input-apply]').onclick();await tick();assert.equal(writes,1);const saved=JSON.parse(stored);assert.deepEqual(saved.future,{keep:true});assert.equal(saved.epoch,7);assert.equal(saved.sourceRuleEpoch,9);assert.equal(saved.mode,'off');
  assert.equal(root.querySelector('[data-source-input-output]').textContent,'<source>kept</source>');assert.equal(stored.includes('kept'),false);
  for(const other of ['libra','hayaku','flashback'].filter(x=>x!==owner))assert.equal(context.memorySuiteSourceRules(other),null);
 }finally{policy.dispose();dom.window.close();}
});
test('shared input policy keeps absent defaults distinct from explicit empty rules',async()=>{
 for(const [stored,expected]of [[{},null],[{ignoredTags:[],sourceRules:{version:1,ignoredTags:[],unwrapTags:[],sourceTags:[],controls:[]}},'']]){
  const context=vm.createContext({});vm.runInContext(source,context);const p=context.createMemorySuiteSourceInputPolicy({owner:'flashback',read:async()=>JSON.stringify(stored),write:async()=>true});await p.ready();
  if(expected===null)assert.equal(context.memorySuiteSourceRules('flashback'),null);else assert.equal(context.memorySuiteCanonicalSource('','flashback'),'');p.dispose();
 }
});
// 2026-10-31 live: LIBRA died at startup with "Expected double-quoted property
// name in JSON" — its first startup step reads these preferences. A malformed
// stored value must fall back to defaults instead of stopping the plugin.
for(const owner of ['libra','hayaku','flashback'])test(owner+' malformed stored source preferences fall back to defaults without a write',async()=>{
 const context=vm.createContext({console:{log(){},warn(){}},setTimeout,clearTimeout});vm.runInContext(source,context);let writes=0;
 const policy=context.createMemorySuiteSourceInputPolicy({owner,read:async()=>'{"ignoredTags":[x,],}',write:async()=>{writes++;return true;}});
 try{
  const preferences=await policy.ready();
  assert.ok(preferences&&typeof preferences==='object','startup continues with default preferences');
  assert.equal(context.memorySuiteSourceRules(owner),null,'no custom rules are invented');
  assert.equal(context.__memorySuiteSourceInputPreferenceErrors?.[owner]?.reason,'SOURCE_INPUT_PREFERENCES_INVALID');
  assert.equal(writes,0,'the unreadable value is not overwritten until the user saves');
 }finally{policy.dispose();}
});
for(const name of ['LIBRA.js','HAYAKU_Locator_Continuity.js','Flashback_Memory.js'])test(name+' embeds the hardened preference reader',()=>{
 assert.ok(fs.readFileSync(path.join(__dirname,'../plugins',name),'utf8').includes("reason:'SOURCE_INPUT_PREFERENCES_INVALID'"));
});

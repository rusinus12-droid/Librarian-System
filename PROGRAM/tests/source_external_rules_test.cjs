'use strict';
const fs=require('fs'),vm=require('vm'),path=require('path'),assert=require('assert/strict');
const source=fs.readFileSync(path.join(__dirname,'../sdk/MemorySuiteSourceEditConsent.source.js'),'utf8');
const context=()=>{const c=vm.createContext({setTimeout,clearTimeout});vm.runInContext(source,c);return c;};
(async()=>{
 for(const owner of ['libra','hayaku','flashback']){
  let c=context();const defaults=c.memorySuiteDefaultSourceRules(owner);assert.ok(!defaults.ignoredTags.includes('dag_runtime_contract'));assert.ok(!defaults.ignoredTags.includes('hayaku_packet_contract'));assert.ok(!defaults.controls.includes('suite-blocks'));assert.ok(defaults.ignoredTags.includes('lb-xnai'));
  const custom={open:'[EXTERNAL START]',close:'[EXTERNAL END]'},old=JSON.stringify({mode:'silent',epoch:0,ignoredTags:['dag_runtime_contract','hayaku_packet_contract','my-decoration'],sourceRules:{version:1,ignoredTags:['dag_runtime_contract','hayaku_packet_contract','my-decoration',custom],unwrapTags:[],sourceTags:['original'],controls:['suite-blocks','lbdata']}}),store=new Map([['__source_tracking_preferences_v1__',old]]);
  const config={owner,requestBoundary:true,read:async k=>store.get(k),write:async(k,v)=>{store.set(k,v);return true;}};
  let api=c.createMemorySuiteSourceEditConsent(config);await api.ready();let rules=api.sourceRules();assert.deepEqual(JSON.parse(JSON.stringify(rules.ignoredTags)),['my-decoration',custom]);assert.deepEqual(Array.from(rules.controls),['lbdata']);const migrated=JSON.parse(store.get('__source_tracking_preferences_v1__'));assert.equal(migrated.mode,'auto','legacy notification mode migrates on read');assert.equal(migrated.epoch,0);assert.equal(migrated.sourceRuleEpoch,0);
  await api.setSourceRules(rules);api.dispose();c=context();api=c.createMemorySuiteSourceEditConsent(config);await api.ready();assert.equal(api.sourceRules().ignoredTags.length,2,'fresh instance preserves custom rules');
  await api.setSourceRules({ignoredTags:[],unwrapTags:[],sourceTags:[]});const p=x=>c.memorySuiteCanonicalSource(x,owner);
  assert.equal(p('A<hayaku_packet_contract>instructions</hayaku_packet_contract><!-- HAYAKU_STATE_PACKET_START {} HAYAKU_STATE_PACKET_END -->[FLASHBACK EVIDENCE]payload[/FLASHBACK EVIDENCE]'),'A');
  const external='A<dag_runtime_contract>unknown</dag_runtime_contract><lb-xnai>{{inlay::x}}</lb-xnai>[LBDATA START]external[LBDATA END]<!-- external -->';assert.equal(p(external),external,'external and unproven markers remain after clearing user rules');
  await assert.rejects(api.setSourceRules({ignoredTags:['hayaku_packet_contract']}),/SOURCE_RULES_INTERNAL/);api.dispose();console.log('PASS '+owner+': external defaults, legacy migration, custom preservation, internal stripping, empty external rules');
 }
})().catch(e=>{console.error(e);process.exitCode=1;});

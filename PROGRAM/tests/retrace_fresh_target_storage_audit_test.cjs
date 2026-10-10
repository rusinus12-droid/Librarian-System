'use strict';
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict'),path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../plugins/RETRACE.js'),'utf8');
async function run(mode){
 let actual='plugin_only',writes=0,prepared=0;
 const request=async(action,p)=>{
  assert.equal(action,'memory_suite_prepare_handoff_target');actual=p.mode;prepared++;
  return {schema:'memory-suite.target-storage-preparation.v1',verified:true,owner:'libra',...p};
 };
 const c={text:x=>String(x??''),clone:(x,f)=>x===undefined?f:JSON.parse(JSON.stringify(x)),memorySuiteModeLabel:x=>x,
  HANDOFF_STORAGE_MODES:['plugin_only','server_only'],HANDOFF_STORAGE_DESTINATIONS:['plugin_only','server_only','per_owner'],requestLibraIpc:request,requestFlashbackIpc:request,requestHayakuIpc:request,requestLiaIpc:request,
  inspectMemorySuiteOwnerStorageGate:async()=>({ready:true,commonMode:actual,participants:[{owner:'libra',mode:actual}],participantCount:1}),
  handoffStoragePolicyMatchesGate:(p,g)=>p.participants[0].mode===g.commonMode,handoffStoragePolicyFromGate:g=>g,
  persistNextSessionHandoffJournal:async()=>{writes++},HANDOFF_STORAGE_POLICY_SCHEMA:'fixture'};
 vm.createContext(c);
 vm.runInContext(source.slice(source.indexOf('  const ensurePendingHandoffStorageConfiguration ='),source.indexOf('  const performPendingNextSessionHandoff ='))+'this.run=ensurePendingHandoffStorageConfiguration;',c);
 const loaded={targetChatId:'new-target',bridge:{targetStorageMode:mode,targetStoragePolicy:{participants:[{owner:'libra',mode}]}},journal:{transferId:'fixture'}};
 if(mode==='mirror'){
  await assert.rejects(()=>c.run(loaded),e=>e.code==='RETRACE_HANDOFF_STORAGE_CONFIGURATION_PENDING');
  assert.equal(prepared,0);assert.equal(writes,0);assert.equal(actual,'plugin_only');
  console.log('PASS legacy mirror target waits for endpoint selection without owner or journal writes');
 }else{
  await c.run(loaded);assert.equal(actual,mode);assert.equal(prepared,1);assert.equal(writes,1);
  console.log('PASS prepare then gate '+mode);
 }
}
(async()=>{for(const mode of ['plugin_only','server_only','mirror'])await run(mode);})().catch(e=>{console.error(e);process.exitCode=1});

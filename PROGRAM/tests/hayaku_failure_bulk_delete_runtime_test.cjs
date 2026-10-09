'use strict';
// Execute the production GUI coordinator with controlled host/storage boundaries.
// Physical removal and rollback are covered by hayaku_failed_analysis_delete_runtime_test.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
const source=fs.readFileSync(path.join(__dirname,'../plugins/HAYAKU_Locator_Continuity.js'),'utf8');
const start=source.indexOf('  const viewerDeleteFailedRecovery = async'),end=source.indexOf('  const viewerConfirmFailedAnalysisAdoption',start);
assert(start>=0&&end>start);
function setup(){
 const viewer={root:{},failedDeleteScope:'A',failedDeleteSelection:new Set(['a','b']),busy:false};
 const state={scope:'A',confident:true,confirm:true,deleted:[],messages:[],fail:'',cases:[{failureId:'a',turn:1,revisions:[{failureId:'a-old'},{failureId:'a'}]},{failureId:'b',turn:2,revisions:[{failureId:'b'}]},{failureId:'c',turn:3,revisions:[{failureId:'c'}]}]};
 const c=vm.createContext({Memory:{ledgerViewer:viewer},ensureArray:x=>Array.isArray(x)?x:[],compact:(x,n)=>String(x).slice(0,n),
  RisuCompat:{currentChatScope:async()=>({key:state.scope,confident:state.confident})},
  listFailedAnalysisArtifacts:async()=>({cases:state.cases}),viewerUpdateFailureSelection(){},
  viewerConfirmFailedAnalysisDelete:async entry=>{state.confirmed=entry;await state.onConfirm?.();return state.confirm;},
  deleteFailedAnalysisArtifact:async(scope,id)=>{assert.equal(scope,'A');if(id===state.fail)return{ok:true,durable:false,reason:'readback_unconfirmed'};state.deleted.push(id);return{ok:true,durable:true};},
  viewerRenderFailedRecovery:async()=>{},refreshLedgerViewer:async()=>{},viewerFailureDeleteMessage:msg=>state.messages.push(msg)});
 vm.runInContext(source.slice(start,end)+'\nglobalThis.run=viewerDeleteFailedRecovery;',c);return{viewer,state,run:c.run};
}
(async()=>{
 let x=setup();let r=await x.run(['a','a','b']);assert.equal(r.ok,true);assert.equal(r.deletedCases,2);assert.equal(r.deletedRevisions,3);assert.deepEqual(x.state.deleted,['a-old','a','b']);assert.equal(x.state.confirmed.caseCount,2);assert.equal(x.state.confirmed.revisionCount,3);
 x=setup();x.state.confirm=false;r=await x.run(['a','b']);assert.equal(r.cancelled,true);assert.deepEqual(x.state.deleted,[]);assert.equal(x.viewer.failedDeleteSelection.size,2);assert.equal(x.viewer.busy,false);
 x=setup();x.state.scope='B';r=await x.run(['a','b']);assert.equal(r.reason,'scope_changed');assert.deepEqual(x.state.deleted,[]);assert.equal(x.state.confirmed,undefined);
 x=setup();x.state.onConfirm=()=>{x.state.scope='B';};r=await x.run(['a','b']);assert.equal(r.reason,'scope_changed');assert.deepEqual(x.state.deleted,[]);
 x=setup();x.state.onConfirm=()=>{x.state.confident=false;};r=await x.run(['a']);assert.equal(r.reason,'scope_changed');assert.deepEqual(x.state.deleted,[]);
 x=setup();x.state.fail='b';r=await x.run(['a','b','c']);assert.equal(r.ok,false);assert.equal(r.deletedCases,1);assert.equal(r.deletedRevisions,2);assert.deepEqual(x.state.deleted,['a-old','a']);assert(!x.viewer.failedDeleteSelection.has('a'));assert(x.viewer.failedDeleteSelection.has('b'));assert.match(x.state.messages.at(-1),/삭제 중단/);
 x=setup();let release;const gate=new Promise(resolve=>release=resolve);x.state.onConfirm=()=>gate;const first=x.run(['a']);r=await x.run(['b']);assert.equal(r.reason,'viewer_busy_or_no_selection');release();assert.equal((await first).ok,true);assert.deepEqual(x.state.deleted,['a-old','a']);
 x=setup();x.state.onConfirm=()=>{x.viewer.root={};};r=await x.run(['a']);assert.equal(r.reason,'scope_changed');assert.deepEqual(x.state.deleted,[]);
 console.log('PASS hayaku_failure_bulk_delete_runtime_test (8 cases: revisions, cancel, stale scope, changed scope, uncertain scope, partial readback failure, duplicate action, replaced viewer)');
})().catch(error=>{console.error(error);process.exitCode=1;});

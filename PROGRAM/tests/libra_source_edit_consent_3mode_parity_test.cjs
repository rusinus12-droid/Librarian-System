'use strict';
// Explicit source replacement parity in all three storage modes: model-free
// request observation, immutable previous evidence, and durable owner job routing.
const assert=require('node:assert/strict');
const {serverFixture}=require('./fixtures/libra_server_runtime_fixture.cjs');
const {createRootBoundary}=require('./fixtures/source_edit_root_boundary.cjs');
const MODES=['plugin_only','mirror','server_only'];
const {classifyCall}=require('./fixtures/libra_provider_call_kinds.cjs');
const parse=value=>{if(value===null||value===undefined)return null;if(typeof value!=='string')return value;try{return JSON.parse(value);}catch(_){return null;}};
const manifestValue=(snapshot,mode)=>mode==='plugin_only'
 ?parse(snapshot.local.get([...snapshot.local.keys()].find(k=>/:manifest$/.test(k))))
 :snapshot.getManifest();
const storedValue=(snapshot,mode,key)=>mode==='plugin_only'?parse(snapshot.local.get(key)):snapshot.storedRows().find(row=>row.key===key)?.value;
const localJobRows=(snapshot,jobId)=>[...snapshot.local.entries()].filter(([,raw])=>{const value=parse(raw);return value?.schema==='libra.canonical_job.v1'&&value.jobId===jobId;});
const serverJobRows=(snapshot,jobId)=>snapshot.storedRows().filter(row=>row.value?.schema==='libra.canonical_job.v1'&&row.value.jobId===jobId);
async function runMode(mode){
 const root=createRootBoundary();
 const snapshot=await serverFixture({mode,host:{getRootDocument:async()=>root.root}});
 try{
  const api=snapshot.f.r.api,initial=await api.runManualColdStart({});
  assert.equal(initial.completed,1,mode+': initial canonical must commit');
  const before=manifestValue(snapshot,mode)?.memories?.['1'];
  assert.ok(before,mode+': initial canonical ref exists');
  const oldBody=mode==='plugin_only'?parse(snapshot.local.get(before.key)):snapshot.getMemory(1);
  const oldBytes=mode==='plugin_only'?snapshot.local.get(before.key):snapshot.storedRows().find(row=>row.key===before.key)?.raw;
  const callsBefore=snapshot.f.control.calls.length;
  snapshot.f.chat.message[1].data+=' automatic source edit';
  await snapshot.f.r.sourceEditBoundary();
  assert.equal(await root.ready(),false,mode+': no manual source-edit dialog is shown');
  assert.equal(snapshot.f.control.calls.length,callsBefore,mode+': observing source adds no analysis');
  assert.equal(manifestValue(snapshot,mode)?.memories?.['1'].key,before.key,mode+': approved source remains until explicit selection');
  const selection=await api.listCanonicalBatchRanges();
  const ranges=selection.ranges.filter(row=>row.startTurn===1);assert.equal(ranges.length,1);assert.equal(ranges[0].status,'saved');
  const result=await api.startSelectedCanonicalBatches({scopeKey:selection.scopeKey,mode:'source_edit',ranges});
  assert.equal(result.ok,true,JSON.stringify(result));assert.equal(result.job.completed,1);
  const after=manifestValue(snapshot,mode)?.memories?.['1'];
  const replacement=mode==='plugin_only'?parse(snapshot.local.get(after.key)):snapshot.getMemory(1);
  const retained=mode==='plugin_only'?snapshot.local.get(before.key):snapshot.storedRows().find(row=>row.key===before.key)?.raw;
  const localJournals=localJobRows(snapshot,result.job.jobId),serverJournals=serverJobRows(snapshot,result.job.jobId);
  assert.equal(after.status,'committed',mode+': successful selected replacement is canonical');
  assert.ok(after.revision>before.revision,mode+': successful replacement advances revision');
  assert.notEqual(after.sourceDigest,before.sourceDigest,mode+': projected source digest changes');
  const oldEvidence=storedValue(snapshot,mode,oldBody.sourceEvidenceRef.key),newEvidence=storedValue(snapshot,mode,replacement.sourceEvidenceRef.key);
  assert.doesNotMatch(oldEvidence.rows[0].assistantText,/automatic source edit/,mode+': old evidence remains immutable');
  assert.match(newEvidence.rows[0].assistantText,/automatic source edit/,mode+': replacement evidence stores the edited source');
  assert.ok(JSON.stringify(snapshot.f.control.calls.at(-1)).includes('automatic source edit'),mode+': explicit replacement provider input includes the edit');
  assert.equal(retained,oldBytes,mode+': previous body remains byte-identical');
  assert.deepEqual(snapshot.f.control.calls.slice(callsBefore).map(classifyCall),['canonical'],
   mode+': source edit spends only the expected Canonical call, with no historical Micro replay');
  assert.equal(snapshot.f.control.calls.length,callsBefore+1,mode+': explicit selection runs exactly one analysis');
  assert.ok(localJournals.length+serverJournals.length>0,mode+': explicit source job has a durable owner record');
  return {mode,revisionBefore:before.revision,revisionAfter:after.revision,localJournals:localJournals.length,serverJournals:serverJournals.length};
 }finally{await snapshot.cleanup();}
}

(async()=>{
 const results=[];for(const mode of MODES)results.push(await runMode(mode));
 const pluginOnly=results.find(row=>row.mode==='plugin_only'),mirror=results.find(row=>row.mode==='mirror'),serverOnly=results.find(row=>row.mode==='server_only');
 assert.ok(pluginOnly.localJournals>0&&pluginOnly.serverJournals===0,'plugin_only source job remains local');
 assert.ok(mirror.localJournals>0&&mirror.serverJournals>0,'mirror source job has verified local and server copies');
 assert.ok(serverOnly.serverJournals>0&&serverOnly.localJournals===0,'server_only source job remains server-owned');
 process.stdout.write(JSON.stringify({test:'libra_source_edit_consent_3mode_parity',passed:results.length,results})+'\n');
})().catch(error=>{process.stderr.write(String(error.stack||error)+'\n');process.exitCode=1;});

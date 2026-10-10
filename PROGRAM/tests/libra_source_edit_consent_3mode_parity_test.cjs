'use strict';
// LIBRA beforeRequest automatic source-replacement parity in all three storage
// modes. This keeps the former consent-parity coverage while asserting automatic
// processing: no popup, immutable previous canonical, and owner journal routing.
const assert=require('node:assert/strict');
const {serverFixture}=require('./fixtures/libra_server_runtime_fixture.cjs');
const {createRootBoundary}=require('./fixtures/source_edit_root_boundary.cjs');
const MODES=['plugin_only','mirror','server_only'];
const CONSENT_KEY=/:source-edit-consent:v1$/;
const parse=value=>{if(value===null||value===undefined)return null;if(typeof value!=='string')return value;try{return JSON.parse(value);}catch(_){return null;}};
const manifestValue=(snapshot,mode)=>mode==='plugin_only'
 ?parse(snapshot.local.get([...snapshot.local.keys()].find(k=>/:manifest$/.test(k))))
 :snapshot.getManifest();
const storedValue=(snapshot,mode,key)=>mode==='plugin_only'?parse(snapshot.local.get(key)):snapshot.storedRows().find(row=>row.key===key)?.value;
const localJournalRows=snapshot=>[...snapshot.local.entries()].filter(([key])=>CONSENT_KEY.test(key));
const serverJournalRows=snapshot=>snapshot.storedRows().filter(row=>CONSENT_KEY.test(row.key));
const callKind=args=>{const source=JSON.stringify(args);
 return source.includes('[LIBRA MICRO SOURCE CONTRACT]')?'micro_memory'
  :source.includes('LIBRA LONG-TERM MEMORY EXTRACTION')?'canonical_memory':'other';};

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
  const after=manifestValue(snapshot,mode)?.memories?.['1'];
  const replacement=mode==='plugin_only'?parse(snapshot.local.get(after.key)):snapshot.getMemory(1);
  const retained=mode==='plugin_only'?snapshot.local.get(before.key):snapshot.storedRows().find(row=>row.key===before.key)?.raw;
  const localJournals=localJournalRows(snapshot),serverJournals=serverJournalRows(snapshot);
  assert.equal(after.status,'committed',mode+': successful automatic replacement is canonical');
  assert.ok(after.revision>before.revision,mode+': successful replacement advances revision');
  assert.notEqual(after.sourceDigest,before.sourceDigest,mode+': projected source digest changes');
  const oldEvidence=storedValue(snapshot,mode,oldBody.sourceEvidenceRef.key),newEvidence=storedValue(snapshot,mode,replacement.sourceEvidenceRef.key);
  assert.doesNotMatch(oldEvidence.rows[0].assistantText,/automatic source edit/,mode+': old evidence remains immutable');
  assert.match(newEvidence.rows[0].assistantText,/automatic source edit/,mode+': replacement evidence stores the edited source');
  assert.ok(JSON.stringify(snapshot.f.control.calls.at(-1)).includes('automatic source edit'),mode+': beforeRequest provider input includes the edit');
  assert.equal(retained,oldBytes,mode+': previous body remains byte-identical');
  assert.deepEqual(snapshot.f.control.calls.slice(callsBefore).map(callKind),['canonical_memory'],
   mode+': source edit spends only the expected Canonical call, with no historical Micro replay');
  assert.equal(snapshot.f.control.calls.length,callsBefore+1,mode+': beforeRequest runs exactly one analysis');
  assert.ok(localJournals.length+serverJournals.length>0,mode+': automatic source history has an owner journal');
  return {mode,revisionBefore:before.revision,revisionAfter:after.revision,localJournals:localJournals.length,serverJournals:serverJournals.length};
 }finally{await snapshot.cleanup();}
}

(async()=>{
 const results=[];for(const mode of MODES)results.push(await runMode(mode));
 const pluginOnly=results.find(row=>row.mode==='plugin_only'),mirror=results.find(row=>row.mode==='mirror'),serverOnly=results.find(row=>row.mode==='server_only');
 assert.ok(pluginOnly.localJournals>0&&pluginOnly.serverJournals===0,'plugin_only journal remains local');
 assert.ok(mirror.localJournals>0&&mirror.serverJournals>0,'mirror journal has verified local and server copies');
 assert.ok(serverOnly.serverJournals>0&&serverOnly.localJournals===0,'server_only journal remains server-owned');
 process.stdout.write(JSON.stringify({test:'libra_source_edit_consent_3mode_parity',passed:results.length,results})+'\n');
})().catch(error=>{process.stderr.write(String(error.stack||error)+'\n');process.exitCode=1;});

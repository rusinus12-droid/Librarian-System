'use strict';
const assert = require('node:assert/strict');
const { actualClassicPacket, deliveredClosureRows, assertHealthyEmpty, assertOriginalOrdinarySelection, assertNoForbiddenClosure } = require('./libra_actual_classic_request.cjs');
const clone = value => JSON.parse(JSON.stringify(value));
const query = 'OLD wording appears only in the user query';
const fact = { closure: true, text: 'accepted later fact', memoryId: 'memory', revision: 2,
  scopeKey: 'scope', memoryKey: 'memory-key', sourceDigest: 'source', artifactDigest: 'artifact' };
function specimen(empty = false) {
  const rows = empty ? [] : [{ ...fact, selectedText: fact.text, classicUsed: true, injected: true }];
  const context = { requestId: 'new', route: 'classic', scopeKey: 'scope', contextDigest: 'seal',
    canonicalRefs: [{key:fact.memoryKey,memoryId:fact.memoryId,revision:fact.revision,sourceDigest:fact.sourceDigest,artifactDigest:fact.artifactDigest}],
    values: { currentInput: query, canonicalLayers: { memory: empty ? [] : [clone(fact)] } } };
  const viewer = { scopeKey: 'scope', queryText: query, responseContextRequestId: 'new',
    responseContextDigest: 'seal', rows, liveTailInjected: false, selectedMemories: 0,
    sourceTurnAccounting: {status:'complete',completeUniqueOriginalTurns:0,emittedUnits:0} };
  let invoked = 0; let published = false;
  const messages = [{ role: 'user', content: query }];
  if (!empty) messages.push({ role: 'system', content: '[LIBRA CLASSIC RECALL]\n' + fact.text });
  const control = { calls: [], hooks: { beforeRequest: async () => {
    invoked++; published = true; return messages;
  } } };
  const api = { getLastResponseContext: () => published ? context : { requestId: 'old' },
    getLastMemoryRecallViewer: () => viewer,
    validateResponseContext: async value => ({ ok: value === context, current: value === context }) };
  return { f: { control, r: { api } }, context, viewer, messages, invoked: () => invoked };
}
(async () => {
  const positive = specimen();
  const observed = await actualClassicPacket(positive.f, query, 'scope');
  assert.equal(positive.invoked(), 1);
  assert.deepEqual(deliveredClosureRows(observed), [fact]);
  const empty = specimen(true);
  const noEvidence = await actualClassicPacket(empty.f, query, 'scope', { allowEmpty: true });
  assert.equal(empty.invoked(), 1);
  assert.equal(noEvidence.actualClassic.block, '');
  assert.equal(noEvidence.actualClassic.block.includes('OLD wording'), false,
    'the original user query is not mistaken for recalled evidence');
  assertHealthyEmpty(noEvidence);
  const unknownEmpty=clone(noEvidence);unknownEmpty.actualClassic.viewer.sourceTurnAccounting={status:'unknown',completeUniqueOriginalTurns:null,emittedUnits:0};
  assert.throws(()=>assertHealthyEmpty(unknownEmpty),assert.AssertionError);
  const falseWitnesses = [
    sample => { sample.context.requestId = 'old'; },
    sample => { sample.context.scopeKey = 'other'; },
    sample => { sample.viewer.responseContextDigest = 'other'; },
    sample => { sample.viewer.rows[0].injected = false; },
    sample => { sample.messages[1].content = '[LIBRA CLASSIC RECALL]'; },
    sample => { sample.f.r.api.validateResponseContext = async () => ({ ok: false, current: false }); }
  ];
  for (const mutate of falseWitnesses) {
    const sample = specimen(); mutate(sample);
    await assert.rejects(actualClassicPacket(sample.f, query, 'scope'), assert.AssertionError);
  }
  const failedEmpty = specimen(true);
  failedEmpty.f.r.api.getLastResponseContext = () => ({ requestId: 'old' });
  await assert.rejects(actualClassicPacket(failedEmpty.f, query, 'scope', { allowEmpty: true }), assert.AssertionError,
    'empty mode still refuses stale or missing current context');
  const falseClosures = [
    row => { row.closure = false; row.closureFacts = 0; },
    row => { row.memoryId = 'other'; }, row => { row.revision = 3; },
    row => { row.scopeKey = 'other'; }, row => { row.memoryKey = 'other'; },
    row => { row.sourceDigest = 'other'; }, row => { row.artifactDigest = 'other'; },
    row => { row.selectedText = 'partial'; }
  ];
  for (const mutate of falseClosures) {
    const packet = clone(observed); mutate(packet.actualClassic.deliveredRows[0]);
    assert.deepEqual(deliveredClosureRows(packet), []);
  }
  const original = {kind:'canonical', memoryId:'original',revision:1,scopeKey:'scope',memoryKey:'original-key',
    sourceDigest:'original-source',artifactDigest:'original-artifact',turnRange:{start:1,end:5},sessionEpoch:0,inherited:false};
  const selected = clone(observed);selected.actualClassic.viewer.rows=[{...original,selectedText:'OLD',injected:true,classicUsed:true}];
  selected.actualClassic.viewer.selectedMemories=1;
  selected.actualClassic.viewer.rows[0].memoryKey='';
  selected.actualClassic.context.canonicalRefs=[{key:original.memoryKey,memoryId:original.memoryId,revision:original.revision,sourceDigest:original.sourceDigest,artifactDigest:original.artifactDigest,turnRange:{start:1,end:5},sessionEpoch:0,inherited:false}];
  assertOriginalOrdinarySelection(selected,original);
  const selectionMutations=[
    p=>p.actualClassic.viewer.rows.push({...original,memoryId:'successor',injected:false,classicUsed:false}),
    p=>{p.actualClassic.viewer.selectedMemories=2;},
    ...['memoryId','revision','scopeKey','memoryKey','sourceDigest','artifactDigest'].map(field=>p=>{p.actualClassic.viewer.rows[0][field]=field==='revision'?3:'wrong';})
  ];
  for(const mutate of selectionMutations){const p=clone(selected);mutate(p);assert.throws(()=>assertOriginalOrdinarySelection(p,original),assert.AssertionError);}
  const physicalLocator=clone(selected);physicalLocator.actualClassic.viewer.rows[0].memoryKey=original.memoryKey;
  assertOriginalOrdinarySelection(physicalLocator,original);
  const falseRefs=[
    p=>{p.actualClassic.context.canonicalRefs=[];},
    p=>{p.actualClassic.context.canonicalRefs.push(clone(p.actualClassic.context.canonicalRefs[0]));},
    ...['key','memoryId','revision','sourceDigest','artifactDigest'].map(field=>p=>{p.actualClassic.context.canonicalRefs[0][field]=field==='revision'?99:'wrong';}),
    p=>{p.actualClassic.context.scopeKey='foreign';},
    p=>{p.actualClassic.context.canonicalRefs[0].turnRange.end=10;},
    p=>{p.actualClassic.context.canonicalRefs[0].sessionEpoch=1;},
    p=>{p.actualClassic.context.canonicalRefs[0].inherited=true;}
  ];
  for(const mutate of falseRefs){const p=clone(selected);mutate(p);assert.throws(()=>assertOriginalOrdinarySelection(p,original),assert.AssertionError);}
  const dedup=clone(observed);dedup.actualClassic.deliveredRows[0].memoryKey='';dedup.actualClassic.deliveredRows[0].closure=false;dedup.actualClassic.deliveredRows[0].closureFacts=1;
  assert.deepEqual(deliveredClosureRows(dedup),[fact]);
  const missingPhysical=clone(dedup);missingPhysical.actualClassic.context.canonicalRefs=[];assert.deepEqual(deliveredClosureRows(missingPhysical),[]);
  const duplicatePhysical=clone(dedup);duplicatePhysical.actualClassic.context.canonicalRefs.push(clone(duplicatePhysical.actualClassic.context.canonicalRefs[0]));assert.deepEqual(deliveredClosureRows(duplicatePhysical),[]);
  const historical=clone(noEvidence);historical.actualClassic.deliveredRows=[{selectedText:'forbidden historical',classicUsed:true,injected:true}];
  historical.actualClassic.block='[LIBRA CLASSIC RECALL]\n[HISTORICAL CANONICAL EVIDENCE · T1]\nforbidden historical';
  assertNoForbiddenClosure(historical,['forbidden historical']);
  const closureMutations=[
    p=>{p.actualClassic.deliveredRows[0].closure=true;},
    p=>{p.actualClassic.deliveredRows[0].classicEvidenceRole='continuity_closure';},
    p=>{p.actualClassic.block=p.actualClassic.block.replace('HISTORICAL CANONICAL EVIDENCE','LATER CANONICAL CONTINUITY EVIDENCE');},
    p=>{p.actualClassic.block='[LIBRA CLASSIC RECALL]\n[LATER CANONICAL CONTINUITY EVIDENCE · T9]\nforbidden historical\n[HISTORICAL CANONICAL EVIDENCE · T1]\nordinary';}
  ];
  for(const mutate of closureMutations){const p=clone(historical);mutate(p);assert.throws(()=>assertNoForbiddenClosure(p,['forbidden historical']),assert.AssertionError);}
  const laterThenHistory=clone(historical);laterThenHistory.actualClassic.block='[LIBRA CLASSIC RECALL]\n[LATER CANONICAL CONTINUITY EVIDENCE · T9]\nallowed closure\n[HISTORICAL CANONICAL EVIDENCE · T1]\nforbidden historical';
  assertNoForbiddenClosure(laterThenHistory,['forbidden historical']);
  historical.actualClassic.deliveredRows[0].closureFacts=1;
  assertNoForbiddenClosure(historical,['forbidden historical']);
  for(const header of ['CURRENT SESSION · TURN 1~5','PREVIOUS SESSION 1 · TURN 1~5']) {
    const p=clone(laterThenHistory);p.actualClassic.block=p.actualClassic.block.replace('HISTORICAL CANONICAL EVIDENCE · T1',header);
    assertNoForbiddenClosure(p,['forbidden historical']);
  }
  console.log(JSON.stringify({ status: 'PASS' , kind: 'actual-classic-request-helper-controls',
    positive: 10, falseDedupRefsRejected:2, falseSealedRefsRejected:falseRefs.length, unavailableEmptyRejected:1, falseSelectionsRejected:selectionMutations.length, forbiddenClosureRolesRejected:closureMutations.length, falseRequestWitnessesRejected: falseWitnesses.length + 1,
    falseClosureWitnessesRejected: falseClosures.length, productExecuted: false }));
})().catch(error => { console.error(error); process.exitCode = 1; });

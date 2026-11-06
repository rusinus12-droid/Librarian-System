'use strict';
// A rejected fact holds back only what is older than the turn it claimed. It does not freeze the field,
// and it never stops the domain from being ready.
const assert = require('node:assert/strict');
const { fixture } = require('./fixtures/libra_unified_runtime_fixture.cjs');

const test = async (name, body) => { const f = await fixture(); try { await body(f); console.log('ok', name); } finally { await f.r.cleanup?.(); } };
const fact = (f, id) => f.control.artifact.facts.find(row => row.tempFactId === id);
const addRejected = (f, id, base, ref) => { const copy = JSON.parse(JSON.stringify(fact(f, base))); copy.tempFactId = id; copy.evidenceSpans = [{ ref, quote: '원문에 없는 문장입니다' }]; f.control.artifact.facts.push(copy); };

(async () => {
  await test('a rejected fact from an earlier turn does not hold back a later verified value', async f => {
    addRejected(f, 'bad', 'f11', 't2-a');
    await f.run();
    const head = f.getHead(), mina = head.characters.find(row => row.name === '민아');
    assert.equal(head.world.find(row => row.name === '은빛 열쇠').state.holderRef, mina.id, 'the verified later holder stands');
    assert.equal((head.unifiedApplied.pending || []).filter(row => row.reason === 'quarantined_field_update').length, 0);
    assert.equal(head.domainStatus.world.status, 'ready');
    assert.ok((head.unifiedApplied.pending || []).some(row => row.fact === 'bad' && row.reason === 'memory_record_quarantined'), 'the rejection stays listed');
  });
  await test('a rejected later change keeps an older value from reading as current', async f => {
    fact(f, 'f11').evidenceSpans[0].quote = '원문에 없는 문장입니다';
    await f.run();
    const head = f.getHead();
    assert.equal(head.world.find(row => row.name === '은빛 열쇠').state.holderRef, undefined);
    assert.equal(head.domainStatus.world.status, 'ready', 'one held field does not stop the domain');
    const view = await f.r.api.debugLoadContinuityStateForResponse();
    const key = view.head.world.find(row => row.name === '은빛 열쇠');
    const proof = key.fieldEvidence?.holderRef;
    if (proof) { assert.equal(proof.meaning?.conditional, true, 'automatic use marks what it fills'); assert.match(proof.meaning.restsOn[0], /더 늦은 변경/); }
    const rows = JSON.parse(JSON.stringify(await f.r.api.listMemoryReviews())).rows;
    assert.ok(rows.length >= 1, 'it can still be reviewed');
    assert.ok(rows.every(row => row.stateOutcome !== 'blocked'), 'and no longer fails as blocked: ' + rows.map(row => row.stateOutcome + ':' + row.stateBlockReason).join());
  });
  await test('a story thread may be written about a person', async f => {
    const thread = fact(f, 'f13');
    thread.subjectTempRef = 'mina';
    await f.run();
    const memory = f.getMemory();
    assert.ok(memory.canonicalArtifact.facts.some(row => row.tempFactId === 'f13'), 'the thread is kept');
    assert.ok(!(memory.artifactValidation?.admission?.rejected || []).some(row => row.reason === 'UNIFIED_WORLD_REQUIRED'));
    assert.ok((f.getHead().narrative.threads || []).some(row => /공연 허가자/.test(row.summary)));
  });
  await test('a past fact or an unlinked thread does not mark the domain stale', async f => {
    fact(f, 'f5').temporalRole = 'historical';
    await f.run();
    const head = f.getHead();
    assert.ok((head.unifiedApplied.pending || []).some(row => row.reason === 'not_direct_current_fact'));
    assert.equal(head.domainStatus.characters.status, 'ready', 'the rest of the people stay current');
    assert.ok(head.characters.find(row => row.name === '민아').state.knowledge?.length, 'and their other facts apply');
  });
  console.log('PASS rejected facts hold back only what is older');
})().catch(error => { console.error(error); process.exitCode = 1; });

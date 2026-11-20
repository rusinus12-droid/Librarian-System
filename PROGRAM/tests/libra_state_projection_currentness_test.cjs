'use strict';
// "Is the current State current?" has one answer, and the World Manager card is where a user reads it.
// A field-level hold (a rejected fact, a non-direct fact) keeps its own field last-known; it must not
// demote the whole Head, or every reader answers `last_known` while all four domains are ready.
// The card's turn is also the State's basis (oldest domain turn), never the Micro frontier: Micro
// projected to T33 while the canonical Head is T30 was reported as "마지막 반영 · T33".
const assert = require('node:assert/strict');
const { fixture } = require('./fixtures/libra_unified_runtime_fixture.cjs');

const exposeInternals = source => source
  .replace('    const unifiedReplayReceipt = (context,memory,head,registry) => {',
    '    globalThis.__fixtureFinalizePending = finalizeUnifiedPendingState;\n    const unifiedReplayReceipt = (context,memory,head,registry) => {')
  .replace('    const loadContinuityStateForResponse = async (scope, manifest = null, options = {}) => {',
    '    globalThis.__fixtureResponseAuthority = responseStateAuthorityForHead;\n    const loadContinuityStateForResponse = async (scope, manifest = null, options = {}) => {')
  .replace('    // Read-only answer to "what ran, what is waiting and what failed" for the current chat.',
    '    globalThis.__fixtureStateBasisTurn = stateProjectionBasisTurn;\n    globalThis.__fixtureStateNotes = stateProjectionNotes;\n    // Read-only answer to "what ran, what is waiting and what failed" for the current chat.');

const cloneJson = value => JSON.parse(JSON.stringify(value));
const domainStatus = () => ({
  characters: { status: 'ready', throughTurn: 30 }, relationships: { status: 'ready', throughTurn: 30 },
  world: { status: 'ready', throughTurn: 30 }, narrative: { status: 'ready', throughTurn: 30 }
});
const headWith = (pending, extra = {}) => ({ status: 'ready', throughTurn: 30, domainStatus: domainStatus(), unifiedApplied: { pending }, ...extra });

(async () => {
  const f = await fixture({ transformSource: exposeInternals });
  try {
    const finalize = f.r.context.__fixtureFinalizePending;
    const basis = f.r.context.__fixtureStateBasisTurn;
    assert.equal(typeof finalize, 'function', 'finalizeUnifiedPendingState exposed');
    assert.equal(typeof basis, 'function', 'stateProjectionBasisTurn exposed');

    // 1. A field-level hold does not make the Head stale, and still fences its own domain state.
    const fieldLevel = headWith([{ reason: 'memory_record_quarantined', domain: 'world' }, { reason: 'not_direct_current_fact', domain: 'character' }]);
    const fieldLevelHead = finalize(fieldLevel);
    assert.equal(fieldLevelHead.status, 'ready', 'two rejected fields do not keep the Head stale');
    assert.equal(fieldLevelHead.domainStatus.world.status, 'ready', 'the rejected field still does not hold its domain');
    assert.equal(fieldLevelHead.unifiedApplied.pending.length, 2, 'the rejections stay listed');

    // 2. A thread whose link is unresolved still holds the narrative domain and the Head.
    const linkPending = headWith([{ reason: 'thread_link_pending:participant_mismatch', domain: 'narrative' }]);
    const linkPendingHead = finalize(linkPending);
    assert.equal(linkPendingHead.status, 'partial', 'a whole-collection hold keeps the Head partial');
    assert.equal(linkPendingHead.domainStatus.narrative.status, 'not_updated');
    assert.equal(linkPendingHead.domainStatus.narrative.reason, 'unified_bindings_pending');

    // 3. Legacy coverage keeps its own meaning.
    assert.equal(finalize(headWith([], { unifiedCoverage: { legacyCount: 1 } })).status, 'partial');
    assert.equal(finalize(headWith([])).status, 'ready');

    // 4. The card's basis is the oldest domain turn; Micro running ahead is not the basis.
    assert.equal(basis({ throughTurn: 33, domainStatus: { ...domainStatus(), narrative: { throughTurn: 25 } } }), 25, 'the oldest domain turn wins');
    assert.equal(basis({ throughTurn: 33, domainStatus: domainStatus() }), 30, 'Micro ahead of every domain does not become the basis');
    assert.equal(basis({ throughTurn: 12 }), 12, 'a Head without domain rows falls back to its own turn');
    assert.equal(basis(null), 0, 'no Head has no basis');
    // 5. An existing Head written by the old replay rule (status partial, only rejected fields
    //    pending) still reads as current; a domain-holding pending and legacy history do not.
    const authorityFor = f.r.context.__fixtureResponseAuthority;
    assert.equal(typeof authorityFor, 'function', 'responseStateAuthorityForHead exposed');
    const readyDomains = () => ({ characters: { status: 'ready', throughTurn: 5 }, relationships: { status: 'ready', throughTurn: 5 }, world: { status: 'ready', throughTurn: 5 }, narrative: { status: 'ready', throughTurn: 5 } });
    const staleFlagHead = { status: 'partial', throughTurn: 5, domainStatus: readyDomains(), characters: [{ id: 'p1', name: '민아' }], unifiedApplied: { pending: [{ reason: 'memory_record_quarantined', domain: 'world' }] } };
    assert.equal(authorityFor(cloneJson(staleFlagHead), [], { exactBasis: true }).authority.current, true, 'the old status flag does not keep the State last-known');
    const holdingHead = cloneJson(staleFlagHead);
    holdingHead.domainStatus.narrative = { status: 'not_updated', throughTurn: 5 };
    holdingHead.unifiedApplied.pending = [{ reason: 'thread_link_pending:participant_mismatch', domain: 'narrative' }];
    const holdingAuthority = authorityFor(holdingHead, [], { exactBasis: true }).authority;
    assert.equal(holdingAuthority.current, false, 'an unresolved thread link keeps the State last-known');
    assert.equal((holdingAuthority.pendingDomains || []).join(','), 'narrative');
    const legacyHead = cloneJson(staleFlagHead);
    legacyHead.unifiedCoverage = { legacyCount: 1 };
    assert.equal(authorityFor(legacyHead, [], { exactBasis: true }).authority.current, false, 'unreconstructed legacy history is not current');

    // 6. The card names why it waits. Micro claims that could not bind their value to the source
    //    are counted and pointed at the review screen; they must not be reported as "미크로 T33까지".
    const notes = f.r.context.__fixtureStateNotes;
    assert.equal(typeof notes, 'function', 'stateProjectionNotes exposed');
    assert.equal(notes({ authority: { pendingDomains: [], pending: false }, basis: 30, through: 33 }).join(' | '), '미크로 T33까지 반영');
    assert.equal(notes({ authority: { pendingDomains: ['narrative'], pending: true }, basis: 25, through: 30 }).join(' | '), '대기 영역: narrative | 미크로 T30까지 반영');
    assert.equal(notes({ authority: { pendingDomains: [], pending: true }, basis: 30, through: 33 }).join(' | '), '현재 원문과 상태의 일치 여부를 확인 중입니다. | 미크로 T33까지 반영');
    const unbound = reason => ({ turn: 32, claimIndex: 6, reason });
    const held = notes({ authority: { pendingDomains: [], pending: true, microProjection: { pendingClaims: [{ ...unbound('state_value_not_source_bound'), turn: 32, claimIndex: 6 }, { ...unbound('state_value_not_source_bound'), claimIndex: 12 }, { ...unbound('state_value_not_source_bound'), turn: 33, claimIndex: 19 }] } }, basis: 30, through: 33 });
    assert.equal(held.join(' | '), '미크로 보류 3건 · T32–T33 · 값 이름이 인용문에 없음', 'an uncited value is named as the cause, not as a re-analysis request');
    const other = notes({ authority: { pendingDomains: [], pending: true, microProjection: { pendingClaims: [{ turn: 35, claimIndex: 1, reason: 'read_failed' }] } }, basis: 30, through: 35 });
    assert.equal(other.join(' | '), '미크로 보류 1건 · T35', 'an unreported cause stays a bare count');
  } finally { await f.r.cleanup?.(); }

  // 7. End to end: one rejected fact, every domain ready -> the card reports the State as current.
  //    The replay path is the one that used to demote the Head, so replay again before reading it.
  const g = await fixture();
  try {
    const base = g.control.artifact.facts.find(row => row.tempFactId === 'f11');
    const rejected = JSON.parse(JSON.stringify(base));
    rejected.tempFactId = 'bad';
    rejected.evidenceSpans = [{ ref: 't2-a', quote: '원문에 없는 문장입니다' }];
    g.control.artifact.facts.push(rejected);
    await g.run();
    const replayed = await g.r.core.rebuildCurrentStateForWorldline({ reason: 'state_projection_currentness' });
    assert.equal(replayed.ok, true, 'the replay completes');
    const head = g.getHead();
    assert.equal(head.status, 'ready', 'a rejected fact does not demote the Head, before or after a replay');
    assert.ok((head.unifiedApplied.pending || []).some(row => row.reason === 'memory_record_quarantined'), 'the rejection stays listed');
    assert.ok((head.domainStatus.characters.status === 'ready') && (head.domainStatus.world.status === 'ready') && (head.domainStatus.narrative.status === 'ready'), 'every domain is ready');
    const view = await g.r.api.debugLoadContinuityStateForResponse();
    assert.equal(view.authority.current, true, 'response readers may treat the State as current');
    assert.equal((view.authority.pendingDomains || []).length, 0, 'no domain is waiting');
    const overview = await g.r.api.getRecentWorkOverview();
    const job = (overview.jobs || []).find(row => row.id === 'state');
    assert.equal(job.status, 'ok', 'the State projection card is not waiting');
    assert.equal(job.headline, '현재 상태 반영 · T5까지', 'the card reports the State basis turn');
    assert.equal(job.note, '', 'no pending explanation is left behind');
  } finally { await g.r.cleanup?.(); }

  console.log('ok state projection currentness');
})().catch(error => { console.error(error && error.stack || error); process.exit(1); });

'use strict';
// HAYAKU packet safety net:
//  - a missing packet whose afterRequest repair never ran is repaired in the
//    background without a confirmation dialog when afterRequest auto repair is on;
//    turns that already used or failed their repair keep the existing flow, so no
//    turn is charged twice;
//  - the session authoring history explains repeated causes with actionable advice.
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), assert = require('node:assert/strict');
const { test } = require('node:test');
const H = fs.readFileSync(path.join(__dirname, '../plugins/HAYAKU_Locator_Continuity.js'), 'utf8');
const slice = (a, b) => { const i = H.indexOf(a), j = H.indexOf(b, i + a.length); assert(i >= 0 && j > i, `${a}/${b}`); return H.slice(i, j); };
const context = (settings = {}) => {
  const c = vm.createContext({ Memory: { settings: { afterRequestAutoRepair: true, ...settings } }, text: value => String(value ?? ''),
    ensureArray: value => Array.isArray(value) ? value : value == null ? [] : [value], viewerEscapeHtml: value => String(value ?? ''),
    viewerScopeFields: rows => rows.map(([label, value]) => `${label}=${value}`).join(';') });
  vm.runInContext(slice('  const recoveryJournalAutoApproved =', '  const requestRecoveryJournalBackgroundConfirmationOnce =')
    + slice('  // Session-only rolling history of main-model packet authoring', '  const viewerRenderOverview =')
    + slice('  const viewerPacketAuthoringHistoryHtml =', '  // Session-only rolling history of main-model packet authoring')
    + '\nObject.assign(globalThis,{recoveryJournalAutoApproved,recordPacketAuthoringHistory,recordPacketRepairHistory,packetAuthoringSummary,packetAuthoringAdvice,viewerPacketAuthoringHistoryHtml});', c);
  return c;
};

test('skipped afterRequest repairs are auto-approved; attempted or failed ones are not', () => {
  const c = context();
  for (const outcome of ['not_observed', 'auxiliary_probe_in_progress', 'evidence_unavailable', 'lineage_unavailable'])
    assert.equal(c.recoveryJournalAutoApproved({ afterRequestRepair: { attempted: false, outcome } }), true, outcome);
  assert.equal(c.recoveryJournalAutoApproved({ afterRequestRepair: null }), true, 'no observation at all');
  assert.equal(c.recoveryJournalAutoApproved(null), false, 'absent current record is not consent');
  assert.equal(c.recoveryJournalAutoApproved({ afterRequestRepair: { attempted: true, outcome: 'failed_journal_required' } }), false);
  assert.equal(c.recoveryJournalAutoApproved({ afterRequestRepair: { attempted: false, outcome: 'failed_journal_required' } }), false);
  assert.equal(c.recoveryJournalAutoApproved({ failedAnalysisId: 'f1', afterRequestRepair: null }), false, 'a failure record goes to Failed Recovery automation');
  assert.equal(c.recoveryJournalAutoApproved({ afterRequestRepair: { attempted: false, outcome: 'disabled_journal_only' } }), false);
  assert.equal(c.recoveryJournalAutoApproved({ afterRequestRepair: { attempted: false, outcome: 'candidate_not_committed_journal_required' } }), false);
  const off = context({ afterRequestAutoRepair: false });
  assert.equal(off.recoveryJournalAutoApproved({ afterRequestRepair: { attempted: false, outcome: 'not_observed' } }), false, 'without afterRequest consent the dialog stays');
});

test('authoring history summarizes causes per chat and gives advice', () => {
  const c = context();
  const turns = [
    ['n1', 'valid_packet_awaiting_binding', 'packet_already_usable'],
    ['n2', 'marker_incomplete', 'candidate_returned_pending_commit'],
    ['n3', 'marker_incomplete', 'failed_journal_required'],
    ['n4', 'markers_missing', 'auxiliary_probe_in_progress'],
    ['n5', 'markers_missing', 'candidate_returned_pending_commit'],
    ['n6', 'json_or_schema_invalid', 'candidate_returned_pending_commit']
  ];
  for (const [nonce, result, outcome] of turns) {
    c.recordPacketAuthoringHistory({ at: 1, scopeKey: 'chat-a', requestNonce: nonce, result });
    c.recordPacketRepairHistory({ scopeKey: 'chat-a', requestNonce: nonce, outcome, errorCode: '' });
  }
  c.recordPacketAuthoringHistory({ at: 1, scopeKey: 'chat-b', requestNonce: 'x', result: 'markers_missing' });
  const summary = c.packetAuthoringSummary('chat-a');
  assert.deepEqual(JSON.parse(JSON.stringify(summary)), { total: 6, mainOk: 1, missing: 2, truncated: 2, invalid: 1, repairCandidates: 3, repairFailed: 1, repairSkipped: 1, skipReasons: ['auxiliary_probe_in_progress'] });
  const html = c.viewerPacketAuthoringHistoryHtml('chat-a');
  assert.match(html, /보조 모델 후보 작성=3턴 · 저장 완료 여부는 별도 확인/);
  assert.doesNotMatch(html, /보조 모델 복구 성공/);
  assert.equal(summary.repaired, undefined, 'no durable commit has been observed by this authoring-only history');
  const advice = Array.from(c.packetAuthoringAdvice(summary)).join('\n');
  assert.match(advice, /응답 최대 토큰/);
  assert.match(advice, /자주 생략/);
  assert.match(advice, /Other Ax/);
  assert.equal(c.packetAuthoringSummary('chat-b').total, 1, 'history is per chat');
  for (let i = 0; i < 80; i += 1) c.recordPacketAuthoringHistory({ at: 2, scopeKey: 'chat-a', requestNonce: 'm' + i, result: 'valid_packet_awaiting_binding' });
  assert.ok(c.Memory.packetAuthoringHistory.length <= 60, 'history stays bounded');
});

'use strict';
const assert = require('node:assert/strict');
const {serverFixture} = require('./fixtures/libra_server_runtime_fixture.cjs');

const assistantText = '지호는 열쇠를 서랍에 넣었고, 민아에게 보관 중이라고 말했다.';
const exactQuote = '지호는 열쇠를 서랍에 넣었고';
const receipt = {
  schema: 'libra.completed_turn_receipt.v1', scopeKey: 'micro-contract-scope',
  worldlineId: 'main', sessionEpoch: 0, turn: 1, revisionId: 'source-revision-1',
  sourceDigest: 'source-digest-1', receiptKey: 'receipt-1',
  user: {role: 'user', chatId: 'user-1', text: '민아는 은빛 열쇠를 지호에게 맡겼다.'},
  assistant: {role: 'assistant', chatId: 'assistant-1', text: assistantText}
};
const valid = () => ({
  schema: 'libra.micro_memory.v1', scopeKey: receipt.scopeKey,
  worldlineId: receipt.worldlineId, sessionEpoch: receipt.sessionEpoch,
  turn: receipt.turn, sourceRevisionId: receipt.revisionId,
  sourceDigest: receipt.sourceDigest,
  claims: [{
    changeKind: 'world', text: '열쇠의 보관 위치가 서랍으로 바뀌었다.',
    actor: '지호', target: '열쇠', temporalRole: 'current', certainty: 'confirmed',
    epistemicStatus: 'observed', stateChangeType: 'set',
    evidence: {role: 'assistant', messageId: 'assistant-1', startOffset: 0,
      endOffset: exactQuote.length, exactQuote}
  }]
});

(async () => {
  const fixture = await serverFixture({mode: 'plugin_only'});
  try {
    const validate = fixture.f.r.api.debugValidateMicroCandidate;
    assert.equal(typeof validate, 'function', 'Micro candidate validation is exposed for contract tests');
    const accepted = validate(valid(), receipt);
    assert.equal(accepted.status, 'source_bound_candidate');
    assert.equal(accepted.claims.length, 1);
    assert.equal(accepted.claims[0].evidence.exactQuote,
      receipt.assistant.text.slice(accepted.claims[0].evidence.startOffset, accepted.claims[0].evidence.endOffset));
    assert.equal(accepted.authority, 'candidate_only', 'source binding alone does not admit State authority');
    assert.equal(accepted.claims[0].stateIntent, undefined,
      'a stateChangeType hint without a typed intent cannot identify a State field');

    const typed = valid();
    typed.claims[0].stateIntent = {domain: 'world', target: {entityName: '열쇠'},
      field: 'location', operation: 'set', value: '서랍'};
    const typedResult = validate(typed, receipt);
    assert.equal(typedResult.status, 'source_bound_candidate');
    assert.deepEqual(JSON.parse(JSON.stringify(typedResult.claims[0].stateIntent)), typed.claims[0].stateIntent,
      'a grounded structured intent survives for separate State admission');
    assert.equal(typedResult.authority, 'candidate_only',
      'a typed intent alone does not approve a State mutation');

    for (const [label, mutate] of [
      ['unbound target', intent => { intent.target.entityName = '준호'; }],
      ['forbidden field', intent => { intent.field = '__proto__'; }],
      ['case-variant forbidden field', intent => { intent.field = 'History'; }],
      ['operation mismatch', intent => { intent.operation = 'clear'; }],
      ['missing set value', intent => { delete intent.value; }],
      ['unknown domain', intent => { intent.domain = 'inventory'; }]
    ]) {
      const candidate = valid();
      candidate.claims[0].stateIntent = structuredClone(typed.claims[0].stateIntent);
      mutate(candidate.claims[0].stateIntent);
      const invalid = validate(candidate, receipt);
      assert.equal(invalid.claims.length, 0, `${label}: malformed intent cannot be retained`);
      assert.equal(invalid.rejected.length, 1, `${label}: rejection is diagnosed`);
    }

    for (const [label, mutate] of [
      ['scope', candidate => { candidate.scopeKey = 'other-scope'; }],
      ['worldline', candidate => { candidate.worldlineId = 'other-worldline'; }],
      ['source revision', candidate => { candidate.sourceRevisionId = 'old-revision'; }],
      ['five-turn recap', candidate => { candidate.turnRange = {start: 1, end: 5}; }],
      ['wrong role', candidate => { candidate.claims[0].evidence.role = 'user'; }],
      ['wrong span', candidate => { candidate.claims[0].evidence.startOffset = 1; }],
      ['wrong message', candidate => { candidate.claims[0].evidence.messageId = 'other-message'; }],
      ['unsupported actor', candidate => { candidate.claims[0].actor = '준호'; }],
      ['reported state inference', candidate => { candidate.claims[0].epistemicStatus = 'reported'; }],
      ['past state inference', candidate => { candidate.claims[0].temporalRole = 'historical'; }]
    ]) {
      const candidate = valid();
      mutate(candidate);
      assert.equal(validate(candidate, receipt).status, 'rejected', `${label} must not be admitted`);
    }
    const mixed = valid();
    mixed.claims.push({...valid().claims[0], actor: '준호'});
    const partial = validate(mixed, receipt);
    assert.equal(partial.status, 'source_bound_candidate', 'one invalid claim does not erase a grounded claim');
    assert.equal(partial.claims.length, 1);
    assert.equal(partial.rejected.length, 1);
    assert.equal(fixture.f.control.calls.length, 0, 'contract validation does not call a model');
    console.log('PASS one-turn Micro candidates require exact source and provisional authority');
  } finally { await fixture.cleanup(); }
})().catch(error => { console.error(error); process.exitCode = 1; });

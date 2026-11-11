'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const { fixture } = require('./fixtures/libra_unified_runtime_fixture.cjs');
const { waitFor } = require('./fixtures/libra_vm_harness.cjs');

test('recall projects approved Micro State, preserves source-only details, and binds admission currentness', async t => {
  let listener;
  const f = await fixture({
    host: { addRisuChatListener: async (_kind, handler) => { listener = handler; return true; } },
    // Expose only the private authority map to test the deployed final verifier.
    transformSource: source => {
      const marker = 'const memoryEvidenceAuthority = new WeakMap();';
      assert.ok(source.includes(marker));
      return source.replace(marker, 'const memoryEvidenceAuthority = globalThis.__testStateAuthorities = new WeakMap();');
    }
  });
  t.after(() => f.r.cleanup());
  await f.run();
  await waitFor(() => f.r.api.getCaptureBackendState().lastMicroPublication?.turn === 5, 15000);
  const storedHead = JSON.parse(JSON.stringify(f.getHead()));
  const original = '민아가 은빛 열쇠를 준호에게 건넸다. 준호는 “해 지기 전에 돌려줄게”라고 말했다.';
  f.chat.message.push({ role: 'user', chatId: 't6-u', data: '열쇠를 건네며 약속을 확인했다.' },
    { role: 'assistant', chatId: 't6-a', data: original });
  f.chat.messages = f.chat.message;
  const first = '민아가 은빛 열쇠를 준호에게 건넸다.';
  const promise = '준호는 “해 지기 전에 돌려줄게”라고 말했다.';
  f.control.onCall = async args => {
    const input = JSON.parse(args[0].messages[1].content);
    const evidence = quote => ({ role: 'assistant', messageId: input.assistant.messageId,
      startOffset: original.indexOf(quote), endOffset: original.indexOf(quote) + quote.length, exactQuote: quote });
    const common = { temporalRole: 'current', certainty: 'confirmed', epistemicStatus: 'observed' };
    return { type: 'success', result: JSON.stringify({ schema: 'libra.micro_producer_envelope.v1',
      personCandidates: { spans: [], relations: [] }, micro: { schema: 'libra.micro_memory.v1', ...input.binding, claims: [
        { ...common, changeKind: 'world', text: first, actor: '민아', target: '은빛 열쇠', stateChangeType: 'set',
          stateIntent: { domain: 'world', target: { entityName: '은빛 열쇠' }, field: 'holderRef', operation: 'set', value: '준호' }, evidence: evidence(first) },
        { ...common, changeKind: 'event', text: promise, actor: '준호', target: '', stateChangeType: 'none', evidence: evidence(promise) },
        { ...common, changeKind: 'thread', text: promise, actor: '준호', target: '', stateChangeType: 'set',
          stateIntent: { domain: 'narrative', target: { scope: 'current_narrative' }, field: 'threads', operation: 'set',
            value: { title: '열쇠 반환', summary: promise, status: 'open' } }, evidence: evidence(promise) }
      ] } }) };
  };
  listener({ char: f.character, chat: f.chat, characterIndex: 0, chatIndex: 0, messageIndex: 11 });
  await waitFor(() => f.r.api.getCaptureBackendState().lastMicroPublication?.turn === 6, 15000);
  const options = queryText => ({ queryText, consumerPolicy: { maxCharacters: 8000, maxUnits: 24 } });
  const execution = await f.r.core.executeStateMemoryQuery(options('지금 은빛 열쇠 보유자는 누구야?'));
  const authority = f.r.context.__testStateAuthorities.get(execution);
  t.after(() => authority.release());
  const stateRows = execution.bundle.items.filter(row => row.family === 'state');
  assert.ok(stateRows.some(row => row.text.includes('소지자: 준호') && row.turn === 6));
  assert.equal(stateRows.some(row => row.text.includes('소지자: 민아')), false);
  assert.equal(stateRows.some(row => row.text.includes(promise)), false, 'a source-only promise never becomes approved State');
  assert.equal(execution.diagnostics.stateAsOfTurn, 6);
  assert.equal(execution.diagnostics.headFreshness, 'partial', 'the unapproved narrative candidate remains disclosed');
  assert.ok(execution.packet.renderedText.includes('last_known'));
  assert.equal(execution.diagnostics.allocationPlan.intent, 'current');
  assert.ok(execution.diagnostics.suppressedEvidenceDuplicates > 0);
  assert.deepEqual(JSON.parse(JSON.stringify(f.getHead())), storedHead, 'retrieval must never persist its projected Head');
  const detail = await f.r.api.executeStateMemoryQuery(options('정확히 뭐라고 반환을 약속했지?'));
  assert.equal(detail.diagnostics.allocationPlan.intent, 'detail');
  assert.ok(detail.bundle.items.some(row => row.family === 'micro' && row.text === promise));
  const history = await f.r.api.executeStateMemoryQuery(options('은빛 열쇠가 전달된 과거 경위'));
  assert.ok(history.bundle.items.some(row => row.family === 'canonical' && row.text.includes('지호가 민아의 은빛 열쇠를 빌렸다')));
  const past = await f.r.api.executeStateMemoryQuery({ ...options('정확한 과거 발언'), queryInput: { queryText: '정확한 과거 발언', asOfTurn: 5 } });
  assert.equal(past.bundle.items.some(row => row.turn > 5), false, 'an earlier query cannot leak projected T6 facts');
  const messages = await f.control.hooks.beforeRequest([{ role: 'user', content: '지금 은빛 열쇠 보유자는 누구야?' }], 'model');
  assert.ok(messages.some(row => row.role === 'system' && row.content.includes('소지자: 준호')));
  assert.equal(f.r.api.getRuntime().lastMemoryInjectionMeta.finalVerification.status, 'verified');
  const decision = await f.r.api.debugReadCurrentMicroStateAdmission(6, 0);
  const saved = f.r.values.get(decision.decisionKey);
  assert.ok(saved);
  f.r.values.delete(decision.decisionKey);
  await assert.rejects(() => authority.validatePacket(execution.packet), /CONSUMER|STATE_SOURCE_CHANGED/,
    'an approved Micro State claim cannot survive removal of its admission proof');
  f.r.values.set(decision.decisionKey, saved);
});

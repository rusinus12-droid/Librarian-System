'use strict';
// One Micro State claim that cannot be applied must not discard the whole projection: the other
// claims of the turn are still reflected and only the failed one is held as pending
// (micro_projection_apply_failed). Before, any exception while applying one claim threw out of
// projectActiveMicroStateForResponse and every Micro change fell back to the Canonical Head.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const assert = require('node:assert/strict');
const {create, until, pause} = require('./fixtures/libra_gui_memory_dom_host.cjs');
const {artifact} = require('./fixtures/libra_unified_runtime_fixture.cjs');
const input = require('./fixtures/unified_vertical_source.json');

const SEAM = '          retainMicroLocationReference(head, registryView, item.domain, item.field, item.value, fieldEvidence);';

(async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'libra-state-partial-test-'));
  const pluginPath = path.join(temporary, 'LIBRA.js');
  const source = fs.readFileSync(path.join(__dirname, '../plugins/LIBRA.js'), 'utf8');
  assert.equal(source.split(SEAM).length, 2, 'the post-canonical apply seam exists once');
  fs.writeFileSync(pluginPath, source.replace(SEAM,
    "          (globalThis.__seamHits = globalThis.__seamHits || []).push(item.field);\n          if (globalThis.__failStateField === item.field) throw new Error('injected_projection_failure');\n" + SEAM));
  let fixture, listener;
  const canonical = artifact();
  try {
    fixture = await create('LIBRA', 'Full', {pluginPath,
      initialChat: input.sourceRows.map(row => ({role: row.role, chatId: row.ref, data: row.text})),
      host: {addRisuChatListener: async (_kind, handler) => { listener = handler; return true; },
        runLLMModel: async () => {
          const active = await fixture.api.debugReadActiveCompletedTurnReceipt(6);
          if (active.status !== 'verified') return {type: 'success', result: JSON.stringify(canonical)};
          const receipt = active.receipt, quote = receipt.assistant.text, at = quote.indexOf('도서관');
          return {type: 'success', result: JSON.stringify({schema: 'libra.micro_producer_envelope.v1',
            personCandidates: {spans: [], relations: []}, micro: {schema: 'libra.micro_memory.v1',
              scopeKey: receipt.scopeKey, worldlineId: receipt.worldlineId, sessionEpoch: 0, turn: 6,
              sourceRevisionId: receipt.revisionId, sourceDigest: receipt.sourceDigest,
              claims: [{changeKind: 'person', text: quote, actor: '민아', target: '', temporalRole: 'current',
                certainty: 'confirmed', epistemicStatus: 'observed', stateChangeType: 'set',
                stateIntent: {domain: 'character', target: {entityName: '민아'}, field: 'condition', operation: 'set', value: '기절했다'},
                evidence: {role: 'assistant', messageId: 't6-a', startOffset: 0, endOffset: quote.length, exactQuote: quote}},
              {changeKind: 'world', text: '도서관 문이 열렸다.', actor: '', target: '도서관', temporalRole: 'current',
                certainty: 'confirmed', epistemicStatus: 'observed', stateChangeType: 'set',
                stateIntent: {domain: 'world', target: {entityName: '도서관'}, field: 'doorStatus', operation: 'set', value: '열렸다'},
                evidence: {role: 'assistant', messageId: 't6-a', startOffset: at, endOffset: quote.length, exactQuote: quote.slice(at)}}]}})};
        }}});
    const {api, context, host} = fixture;
    await fixture.open();
    assert.equal((await api.runManualColdStart()).completed, 1);
    await pause(300);
    context.__failStateField = 'doorStatus';
    const character = await host.getCharacter();
    const live = character.chats[character.chatPage || 0];
    live.message.push({role: 'user', chatId: 't6-u', data: '민아의 상태가 어떻게 변했어?'},
      {role: 'assistant', chatId: 't6-a', data: '민아가 기절했다. 도서관 문이 열렸다.'});
    live.messages = live.message;
    listener({char: character, chat: live, characterIndex: 0, chatIndex: 0, messageIndex: 11});
    const condition = head => asArray(head?.characters).find(row => row?.name === '민아')?.state?.condition;
    const asArray = value => Array.isArray(value) ? value : [];
    await until(() => condition(api.getCurrentStateHead()) === '기절했다',
      'the claim that applies is reflected although another claim of the same turn fails', 15000);
    const head = api.getCurrentStateHead();
    const hits = asArray(context.__seamHits);
    assert.ok(hits.lastIndexOf('doorStatus') < hits.lastIndexOf('condition'),
      'the doorStatus claim failed and the turn was applied again without it: ' + JSON.stringify(hits));
    assert.equal(head.throughTurn, 6, 'the projection advances to the turn instead of falling back to Canonical');
    assert.notEqual(head.responseAuthority?.microProjection?.reason, 'micro_projection_read_failed',
      'the Micro projection as a whole is kept');
    const transitions = asArray(head.microProjection?.transitions);
    assert.ok(transitions.some(row => row.turn === 6 && row.claimIndex === 0 && row.decisionKey && row.disposition === 'still_current'),
      'the claim that applies is projected directly: ' + JSON.stringify(transitions));
    // The held claim is then picked up independently by the memory review layer, which applies
    // each review row in its own try: whatever can be applied is applied.
    assert.ok(transitions.some(row => row.turn === 6 && row.claimIndex === 1 && row.reviewId),
      'the held claim is applied by the review layer, not lost: ' + JSON.stringify(transitions));
    assert.equal(asArray(head.world).find(row => row?.name === '도서관')?.state?.doorStatus, '열렸다');
    console.log('libra_state_projection_partial_failure_test: ok');
  } finally {
    await fixture?.close?.();
    fs.rmSync(temporary, {recursive: true, force: true});
  }
})().catch(error => { console.error(error); process.exit(1); });

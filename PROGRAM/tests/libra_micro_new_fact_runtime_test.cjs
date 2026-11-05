'use strict';
// What Micro verifies in the source reaches State, even when no record holds that place or person yet,
// and a miscounted quote position no longer loses the claim.
const assert = require('node:assert/strict');
const { create, until, pause } = require('./fixtures/libra_gui_memory_dom_host.cjs');
const { artifact } = require('./fixtures/libra_unified_runtime_fixture.cjs');
const input = require('./fixtures/unified_vertical_source.json');

const claim = (text, quote, intent, extra = {}) => ({ changeKind: 'person', text, actor: '', target: '', temporalRole: 'current', certainty: 'confirmed', epistemicStatus: 'observed', stateChangeType: intent ? 'set' : 'none', ...(intent ? { stateIntent: intent } : {}), evidence: { role: 'assistant', messageId: 'wrong', startOffset: 9999, endOffset: 10000, exactQuote: quote }, ...extra });
const run = async (body, claims, check) => {
  let f, listener;
  try {
    f = await create('LIBRA', 'Full', { initialChat: input.sourceRows.map(r => ({ role: r.role, chatId: r.ref, data: r.text })), host: {
      addRisuChatListener: async (_kind, fn) => { listener = fn; return true; },
      runLLMModel: async () => {
        const active = await f.api.debugReadActiveCompletedTurnReceipt(6);
        if (active.status !== 'verified') return { type: 'success', result: JSON.stringify(artifact()) };
        const r = active.receipt;
        return { type: 'success', result: JSON.stringify({ schema: 'libra.micro_producer_envelope.v1', personCandidates: { spans: [], relations: [] }, micro: { schema: 'libra.micro_memory.v1', scopeKey: r.scopeKey, worldlineId: r.worldlineId, sessionEpoch: 0, turn: 6, sourceRevisionId: r.revisionId, sourceDigest: r.sourceDigest, claims } }) };
      }
    } });
    await f.open();
    assert.equal((await f.api.runManualColdStart()).completed, 1);
    const character = await f.host.getCharacter(), chat = character.chats[0];
    chat.message.push({ role: 'user', chatId: 't6-u', data: '이제 어떻게 됐어?' }, { role: 'assistant', chatId: 't6-a', data: body });
    chat.messages = chat.message;
    listener({ char: character, chat, characterIndex: 0, chatIndex: 0, messageIndex: chat.message.length - 1 });
    await until(() => f.api.getCaptureBackendState().lastMicroPublication?.turn === 6, 'Micro publication', 15000);
    await pause(200);
    await check(f, f.api.getCaptureBackendState().lastMicroPublication);
    assert.deepEqual(f.errors, []);
  } finally { await f?.close(); }
};

(async () => {
  const body = '창밖에는 비가 내렸다. 민아는 다락방으로 올라갔다. 낯선 사람 영호가 웃고 있었다.';
  await run(body, [
    claim('민아가 다락방으로 올라갔다.', '민아는 다락방으로 올라갔다.', { domain: 'character', target: { entityName: '민아' }, field: 'locationRef', operation: 'set', value: '다락방' }),
    claim('영호가 웃고 있었다.', '영호가 웃고 있었다.', { domain: 'character', target: { entityName: '영호' }, field: 'condition', operation: 'set', value: '웃고 있었다' })
  ], async (f, publication) => {
    assert.equal(publication.analysisStatus, 'verified', 'wrong offsets are repaired from the quote');
    assert.equal(publication.stateAdmission.admitted, 2, 'a new place and a new person are admitted');
    const { head } = await f.api.debugLoadContinuityStateForResponse();
    const mina = head.characters.find(row => row.name === '민아'), attic = head.world.find(row => row.name === '다락방');
    assert.ok(attic, 'the new place has a row');
    assert.equal(attic.kind, 'location');
    assert.equal(mina.state.locationRef, attic.id, 'and the person stands in it');
    assert.equal(head.characters.find(row => row.name === '영호').state.condition, '웃고 있었다', 'a new person has a row too');
  });
  await run('민아는 서재에 머물렀다.', [
    claim('지어낸 주장', '원문에 전혀 없는 문장입니다', null),
    claim('민아가 서재에 머물렀다.', '민아는 서재에 머물렀다.', null, { actor: '없는사람' })
  ], async (f, publication) => {
    assert.equal(publication.analysisStatus, 'verified');
    const keys = [...f.values.keys()].filter(k => k.includes(':micro-memory:') && !k.includes('-head'));
    const record = JSON.parse(f.values.get(keys.at(-1)));
    assert.equal(record.claims.length, 1, 'a quote not in the turn is still refused');
    assert.equal(record.rejected[0].reason, 'evidence_span_invalid');
    assert.equal(record.claims[0].actor, '', 'a name the quote lacks is dropped, the claim kept');
  });
  console.log('PASS Micro reports new facts and survives miscounted positions');
})().catch(error => { console.error(error); process.exitCode = 1; });

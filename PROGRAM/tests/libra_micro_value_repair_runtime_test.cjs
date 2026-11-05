'use strict';
// A field that changes twice in a turn ends on the last value, a place left is not a location,
// a clause fragment is not a state, and Micro is told the condition it may have to end.
const assert = require('node:assert/strict');
const { create, until, pause } = require('./fixtures/libra_gui_memory_dom_host.cjs');
const { artifact } = require('./fixtures/libra_unified_runtime_fixture.cjs');
const input = require('./fixtures/unified_vertical_source.json');

const location = (quote, value) => ({ changeKind: 'person', text: quote, actor: '', target: '', temporalRole: 'current', certainty: 'confirmed', epistemicStatus: 'observed', stateChangeType: 'set', stateIntent: { domain: 'character', target: { entityName: '민아' }, field: 'locationRef', operation: 'set', value }, evidence: { role: 'assistant', messageId: 'x', startOffset: 0, endOffset: 1, exactQuote: quote } });
const door = (quote, value) => ({ changeKind: 'world', text: quote, actor: '', target: '', temporalRole: 'current', certainty: 'confirmed', epistemicStatus: 'observed', stateChangeType: 'set', stateIntent: { domain: 'world', target: { entityName: '서재' }, field: 'doorStatus', operation: 'set', value }, evidence: { role: 'assistant', messageId: 'x', startOffset: 0, endOffset: 1, exactQuote: quote } });
const run = async (body, claims, check, before = null) => {
  let f, listener, prompt = null;
  try {
    f = await create('LIBRA', 'Full', { initialChat: input.sourceRows.map(r => ({ role: r.role, chatId: r.ref, data: r.text })), host: {
      addRisuChatListener: async (_kind, fn) => { listener = fn; return true; },
      runLLMModel: async request => {
        const active = await f.api.debugReadActiveCompletedTurnReceipt(6);
        if (active.status !== 'verified') return { type: 'success', result: JSON.stringify(artifact()) };
        const r = active.receipt; prompt = JSON.parse(request.messages[1].content);
        return { type: 'success', result: JSON.stringify({ schema: 'libra.micro_producer_envelope.v1', personCandidates: { spans: [], relations: [] }, micro: { schema: 'libra.micro_memory.v1', scopeKey: r.scopeKey, worldlineId: r.worldlineId, sessionEpoch: 0, turn: 6, sourceRevisionId: r.revisionId, sourceDigest: r.sourceDigest, claims } }) };
      }
    } });
    await f.open();
    assert.equal((await f.api.runManualColdStart()).completed, 1);
    await before?.(f);
    const character = await f.host.getCharacter(), chat = character.chats[0];
    chat.message.push({ role: 'user', chatId: 't6-u', data: '이제 어떻게 됐어?' }, { role: 'assistant', chatId: 't6-a', data: body });
    chat.messages = chat.message;
    listener({ char: character, chat, characterIndex: 0, chatIndex: 0, messageIndex: chat.message.length - 1 });
    await until(() => f.api.getCaptureBackendState().lastMicroPublication?.turn === 6, 'Micro publication', 15000);
    await pause(200);
    const { head, authority } = await f.api.debugLoadContinuityStateForResponse();
    const keys = [...f.values.keys()].filter(k => k.includes(':micro-memory:') && !k.includes('-head'));
    await check({ head, pending: authority.microProjection?.pendingClaims || [], record: JSON.parse(f.values.get(keys.at(-1))), prompt, publication: f.api.getCaptureBackendState().lastMicroPublication });
    assert.deepEqual(f.errors, []);
  } finally { await f?.close(); }
};
const nameOf = (head, id) => head.world.find(row => row.id === id)?.name;

(async () => {
  // Written out of order on purpose: the source decides what came last, not the claim list.
  await run('민아는 부두에 도착했다. 민아는 창고 안으로 들어갔다.', [
    location('민아는 창고 안으로 들어갔다.', '창고'),
    location('민아는 부두에 도착했다.', '부두')
  ], async ({ head, pending, record, publication }) => {
    assert.equal(publication.stateAdmission.pending, 0, 'moving twice is no conflict');
    assert.equal(pending.length, 0, 'and nothing is left to review');
    assert.equal(nameOf(head, head.characters.find(row => row.name === '민아').state.locationRef), '창고', 'the last place in the source wins');
    assert.equal(record.claims.length, 2, 'the earlier move is still a memory');
    assert.equal(record.claims.filter(claim => claim.stateIntent).length, 1);
  });
  await run('민아는 다락방을 나왔다.', [location('민아는 다락방을 나왔다.', '다락방')], async ({ head, record }) => {
    const mina = head.characters.find(row => row.name === '민아');
    assert.equal(record.claims[0].stateChangeType, 'clear', 'a place left is not where she is');
    assert.equal(nameOf(head, mina.state.locationRef), undefined, 'and State keeps no such location');
    assert.equal(head.world.some(row => row.name === '다락방'), false, 'nor a new place only because she left it');
  });
  await run('민아는 다락방을 나와 부두로 갔다.', [
    location('민아는 다락방을 나와 부두로 갔다.', '다락방'),
    location('민아는 다락방을 나와 부두로 갔다.', '부두')
  ], async ({ head, pending }) => {
    assert.equal(pending.length, 0, 'leaving one place for another is no conflict');
    assert.equal(nameOf(head, head.characters.find(row => row.name === '민아').state.locationRef), '부두');
  });
  await run('민아가 서재 문을 열자 먼지가 날렸다.', [door('민아가 서재 문을 열자 먼지가 날렸다.', '열자')], async ({ head, record }) => {
    assert.equal(record.claims.length, 1, 'the event stays a memory');
    assert.equal(record.claims[0].stateIntent, undefined, 'a clause fragment is no state');
    assert.equal(head.world.find(row => row.name === '서재')?.state?.doorStatus, undefined);
  });
  await run('민아는 상자를 가방에 넣었다.', [{ ...door('민아는 상자를 가방에 넣었다.', '가방'), stateIntent: { domain: 'world', target: { entityName: '상자' }, field: 'containerRef', operation: 'set', value: '가방' } }], async ({ head }) => {
    const box = head.world.find(row => row.name === '상자'), bag = head.world.find(row => row.name === '가방');
    assert.ok(bag, 'a new thing another record points at has a row, so it can be named');
    assert.equal(box.state.containerRef, bag.id);
  });
  await run('비가 내렸다. 민아는 다락방으로 올라갔다.', [location('민아', '다락방')], async ({ head, record, publication }) => {
    assert.equal(record.claims[0].evidence.exactQuote, '민아는 다락방으로 올라갔다.', 'a bare name is widened to the sentence that says it');
    assert.equal(publication.stateAdmission.admitted, 1);
    assert.equal(nameOf(head, head.characters.find(row => row.name === '민아').state.locationRef), '다락방');
  });
  await run('비가 내렸다. 민아가 웃었다.', [location('민아', '다락방'), { ...location('민아', ''), stateChangeType: 'clear', stateIntent: { domain: 'character', target: { entityName: '민아' }, field: 'condition', operation: 'clear' } }], async ({ record, publication }) => {
    assert.equal(publication.stateAdmission.admitted, 0, 'what the turn never says stays out, and a bare name ends nothing');
    assert.equal(record.claims.filter(claim => claim.stateChangeType === 'clear').length, 0);
  });
  const many = Array.from({ length: 18 }, (_, i) => ({ ...location('비가 내렸다.', ''), stateChangeType: 'none', stateIntent: undefined, text: `사건 ${i}` }));
  await run('비가 내렸다. 민아는 다락방으로 올라갔다.', [...many, location('민아는 다락방으로 올라갔다.', '다락방')], async ({ head, record, publication }) => {
    assert.equal(publication.analysisStatus, 'verified', 'too many claims no longer lose the whole turn');
    assert.equal(record.claims.length, 16);
    assert.equal(nameOf(head, head.characters.find(row => row.name === '민아').state.locationRef), '다락방', 'and the change is what stays');
  });
  const independent = Array.from({ length: 16 }, (_, i) => {
    const name = `검증인물${String(i + 1).padStart(2, '0')}`, quote = `${name}는 기절했다.`;
    return { ...location(quote, '기절했다'), stateIntent: { domain: 'character', target: { entityName: name }, field: 'condition', operation: 'set', value: '기절했다' } };
  });
  const lastMove = location('민아는 다락방으로 올라갔다.', '다락방');
  for (const ordered of [[...independent, lastMove], [lastMove, ...independent.slice().reverse()]]) {
    await run([...independent, lastMove].map(claim => claim.text).join(' '), ordered, async ({ head, record, publication }) => {
      assert.equal(publication.analysisStatus, 'verified');
      assert.equal(record.claims.length, 16);
      assert.equal(nameOf(head, head.characters.find(row => row.name === '민아').state.locationRef), '다락방', 'source recency wins even with more than sixteen State changes');
      assert.equal(record.claims.some(claim => claim.stateIntent?.target?.entityName === '검증인물01'), false);
      assert.deepEqual(record.rejected, [{ index: ordered.indexOf(independent[0]), reason: 'claim_limit_exceeded' }], 'omission remains diagnostic');
    });
  }
  const moves = Array.from({ length: 17 }, (_, i) => location(`민아는 검증방${i + 1}에 도착했다.`, `검증방${i + 1}`));
  await run(moves.map(claim => claim.text).join(' '), [...moves].reverse(), async ({ head, record }) => {
    assert.equal(record.claims.length, 16);
    assert.equal(nameOf(head, head.characters.find(row => row.name === '민아').state.locationRef), '검증방17', 'same-field reduction still precedes the count limit');
  });
  await run('민아는 다락방으로 올라갔다.', [{ ...location('민아는 다락방으로 올라갔다.', '다락방'), stateIntent: { domain: 'character', target: { entityName: '민아' }, field: 'locationRef', operation: 'set', value: '다락방' } }], async ({ head }) => {
    const before = head.characters.length;
    assert.equal(head.characters.filter(row => row.name === '김민아').length, 1, 'a given name is the person of that full name');
    assert.equal(head.characters.some(row => row.name === '민아'), false, 'not a second person');
    assert.equal(before, head.characters.length);
    assert.equal(nameOf(head, head.characters.find(row => row.name === '김민아').state.locationRef), '다락방');
  }, async f => {
    const rename = raw => raw.replaceAll('"민아"', '"김민아"');
    for (const [k, raw] of [...f.values]) if (typeof raw === 'string' && raw.includes('"민아"') && /continuity|registry/i.test(k)) f.values.set(k, rename(raw));
  });
  await run('서재 문이 열렸다 닫혔다.', [door('서재 문이 열렸다 닫혔다.', '열렸다'), door('서재 문이 열렸다 닫혔다.', '닫혔다')], async ({ record, publication }) => {
    assert.equal(record.claims.filter(claim => claim.stateIntent).length, 2, 'values in the same words cannot be ordered');
    assert.equal(publication.stateAdmission.admitted, 2, 'so the admission step still sees them both');
  });
  await run('민아가 서재에 머물렀다.', [], async ({ prompt }) => {
    assert.deepEqual(prompt.currentConditions, [{ name: '민아', condition: '잠들었다' }], 'Micro gets the condition of someone in this turn, and no one else');
  }, async f => {
    const entry = [...f.values].find(([, raw]) => { try { return JSON.parse(raw).schema === 'libra.continuity_state.v2'; } catch { return false; } });
    const head = JSON.parse(entry[1]);
    for (const row of head.characters) row.state = { ...row.state, condition: row.name === '민아' ? '잠들었다' : '다쳤다' };
    head.characters.push({ id: 'ce_person_other', name: '다른사람', kind: 'person', aliases: [], state: { condition: '다쳤다' } });
    f.values.set(entry[0], JSON.stringify(head));
  });
  console.log('PASS Micro ends a field on its last value and keeps fragments and departures out of State');
})().catch(error => { console.error(error); process.exitCode = 1; });

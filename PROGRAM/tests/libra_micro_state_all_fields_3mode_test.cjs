'use strict';
// Every fact-bearing State field reaches the response State from Micro: scalar values, list
// entries that add to Canonical, typed objects, the relationship domain and clear operations.
const assert = require('node:assert/strict');
const {serverFixture} = require('./fixtures/libra_server_runtime_fixture.cjs');
const {waitFor} = require('./fixtures/libra_vm_harness.cjs');

const QUOTES = {
  appearance: '민아는 은발이다', hobby: '민아는 뜨개질을 즐긴다', knowledge: '민아는 지호의 비밀을 안다',
  goal: '민아는 탈출을 원한다', emotion: '민아는 불안해졌다', preference: '민아는 홍차를 좋아한다',
  affiliation: '민아는 기록회의 회원이다', relationship: '민아는 지호를 신뢰한다',
  owner: '은빛 열쇠는 민아의 것이다', access: '지호는 도서관 출입이 허용된다', rule: '도서관에서는 정숙해야 한다',
  numeric: '민아는 지호를 90점으로 신뢰한다', name: '민아는 세아로 불린다'
};
const CLEAR_QUOTE = '민아는 이제 탈출을 포기했다';
const span = (text, quote, messageId) => ({role: 'assistant', messageId,
  startOffset: text.indexOf(quote), endOffset: text.indexOf(quote) + quote.length, exactQuote: quote});
const claimOf = (body, id, quote, intent, operation = 'set') => ({changeKind: 'person', text: `${quote}.`, actor: '', target: '',
  temporalRole: 'current', certainty: 'confirmed', epistemicStatus: 'observed', stateChangeType: operation,
  stateIntent: {...intent, operation}, evidence: span(body, quote, id)});
const envelope = (receipt, turn, claims) => ({type: 'success', result: JSON.stringify({
  schema: 'libra.micro_producer_envelope.v1', personCandidates: {spans: [], relations: []},
  micro: {schema: 'libra.micro_memory.v1', scopeKey: receipt.scopeKey, worldlineId: receipt.worldlineId,
    sessionEpoch: receipt.sessionEpoch, turn, sourceRevisionId: receipt.revisionId, sourceDigest: receipt.sourceDigest, claims}
})});

(async () => {
  for (const mode of ['plugin_only', 'mirror', 'server_only']) {
    let listener;
    const fixture = await serverFixture({mode, host: {
      addRisuChatListener: async (_kind, handler) => { listener = handler; return true; }
    }});
    try {
      const {f} = fixture;
      assert.equal((await f.run()).completed, 1, `${mode}: baseline commits`);
      await waitFor(() => f.r.api.getCaptureBackendState().lastMicroPublication?.turn === 5, 15000);
      const before = (await f.r.api.debugLoadContinuityStateForResponse()).head;
      const beforeKnowledge = before.characters.find(row => row.name === '민아').state.knowledge;
      assert.ok(beforeKnowledge?.length, `${mode}: Canonical knowledge exists to be preserved`);

      f.chat.message.push({role: 'user', chatId: 't6-u', data: '근황은?'},
        {role: 'assistant', chatId: 't6-a', data: `${Object.values(QUOTES).join('. ')}.`});
      f.chat.messages = f.chat.message;
      const person = {domain: 'character', target: {entityName: '민아'}};
      const object = {domain: 'world', target: {entityName: '은빛 열쇠'}};
      const library = {domain: 'world', target: {entityName: '도서관'}};
      const rows = [
        ['appearance', {...person, field: 'appearance', value: '은발'}],
        ['hobby', {...person, field: 'hobby', value: '뜨개질'}],
        ['knowledge', {...person, field: 'knowledge', value: '지호의 비밀'}],
        ['goal', {...person, field: 'goal', value: '탈출'}],
        ['emotion', {...person, field: 'emotion', value: '불안'}],
        ['preference', {...person, field: 'preference', value: {content: '홍차', topic: '홍차', kind: 'preference'}}],
        ['affiliation', {...person, field: 'affiliation', value: {organizationName: '기록회', role: '회원', status: 'member'}}],
        ['relationship', {domain: 'relationship', target: {subjectName: '민아', targetName: '지호', dimension: 'trust'}, field: 'value', value: '신뢰'}],
        ['owner', {...object, field: 'ownership', value: '민아'}],
        ['access', {...library, field: 'access', value: {personName: '지호', permission: '출입', status: 'granted'}}],
        ['rule', {...library, field: 'rule', value: '정숙'}],
        ['numeric', {domain: 'relationship', target: {subjectName: '민아', targetName: '지호', dimension: 'affection'}, field: 'value', value: '90'}],
        ['name', {...person, field: 'name', value: '세아'}]
      ];
      f.control.onCall = async () => {
        const {receipt} = await f.r.api.debugReadActiveCompletedTurnReceipt(6);
        return envelope(receipt, 6, rows.map(([name, intent]) => claimOf(receipt.assistant.text, receipt.assistant.chatId, QUOTES[name], intent)));
      };
      listener({char: f.character, chat: f.chat, characterIndex: 0, chatIndex: 0, messageIndex: 11});
      await waitFor(() => f.r.api.getCaptureBackendState().lastMicroPublication?.turn === 6, 15000);

      for (let index = 0; index < rows.length - 1; index += 1) {
        const decision = await f.r.api.debugAdmitActiveMicroStateClaim(6, index);
        if (rows[index][0] === 'numeric') {
          assert.equal(decision.reason, 'relationship_quantitative_state_forbidden', `${mode}: a score stays out of State`);
          continue;
        }
        assert.equal(decision.status, 'admitted', `${mode}: ${rows[index][0]}: ${decision.reason}`);
      }
      assert.equal((await f.r.api.debugAdmitActiveMicroStateClaim(6, rows.length - 1)).reason, 'state_field_names_record',
        `${mode}: the record's own name is not a Micro fact`);

      const {head} = await f.r.api.debugLoadContinuityStateForResponse();
      const mina = head.characters.find(row => row.name === '민아').state;
      assert.deepEqual(Array.from(mina.appearance), ['은발']);
      assert.deepEqual(Array.from(mina.habits), ['뜨개질'], `${mode}: a hobby alias lands on habits`);
      assert.deepEqual(Array.from(mina.knowledge), [...beforeKnowledge, '지호의 비밀'], `${mode}: a list entry adds to Canonical`);
      assert.equal(mina.goal, '탈출');
      assert.equal(mina.emotion, '불안');
      assert.equal(mina.preferences[0].topic, '홍차');
      assert.equal(mina.affiliations.at(-1).status, 'member');
      const trust = head.relationships.find(row => row.subjectName === '민아' && row.targetName === '지호' && row.dimension === 'trust');
      assert.equal(trust?.state?.value, '신뢰', `${mode}: the relationship reaches response State`);
      const key = head.world.find(row => row.name === '은빛 열쇠').state;
      assert.match(String(key.ownerRef), /^ce_/, `${mode}: an owner stores the Registry id`);
      const rooms = head.world.find(row => row.name === '도서관').state;
      assert.equal(rooms.access.at(-1).permission, '출입');
      assert.equal(rooms.rule.text, '정숙');

      f.chat.message.push({role: 'user', chatId: 't7-u', data: '이제는?'},
        {role: 'assistant', chatId: 't7-a', data: `${CLEAR_QUOTE}.`});
      f.chat.messages = f.chat.message;
      f.control.onCall = async () => {
        const {receipt} = await f.r.api.debugReadActiveCompletedTurnReceipt(7);
        return envelope(receipt, 7, [claimOf(receipt.assistant.text, receipt.assistant.chatId, CLEAR_QUOTE,
          {domain: 'character', target: {entityName: '민아'}, field: 'goal'}, 'clear')]);
      };
      listener({char: f.character, chat: f.chat, characterIndex: 0, chatIndex: 0, messageIndex: 13});
      await waitFor(() => f.r.api.getCaptureBackendState().lastMicroPublication?.turn === 7, 15000);
      assert.equal((await f.r.api.debugAdmitActiveMicroStateClaim(7, 0)).status, 'admitted', `${mode}: a clear is admitted`);
      const cleared = (await f.r.api.debugLoadContinuityStateForResponse()).head.characters.find(row => row.name === '민아').state;
      assert.equal(Object.hasOwn(cleared, 'goal'), false, `${mode}: a later clear removes the value`);
      assert.deepEqual(Array.from(cleared.appearance), ['은발'], `${mode}: other fields survive the clear`);
      console.log(`PASS micro state all fields in ${mode}`);
    } finally { await fixture.cleanup(); }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });

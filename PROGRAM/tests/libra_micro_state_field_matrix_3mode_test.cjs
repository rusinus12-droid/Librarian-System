'use strict';
// Execute the deployed producer/admission/read projection against isolated stores.
// Every model response is supplied here; this test never calls a provider.
const assert = require('node:assert/strict');
const {serverFixture} = require('./fixtures/libra_server_runtime_fixture.cjs');
const {waitFor} = require('./fixtures/libra_vm_harness.cjs');
const plain = value => JSON.parse(JSON.stringify(value));
const cases = [];
const add = (domain, field, value, quote, name = '민아') => cases.push({domain, field, value, quote,
  target: domain === 'narrative' ? {scope: 'current_narrative'}
    : domain === 'relationship' ? {subjectName: '민아', targetName: '지호', dimension: 'trust'} : {entityName: name}});
for (const [field, value] of Object.entries({appearance: '갈색 눈', background: '해안 마을에서 자랐다', personality: '신중하다',
  speech: '존댓말을 쓴다', habits: '매일 일기를 쓴다', abilities: '항로를 계산할 수 있다', knowledge: '등대의 암호',
  condition: '쉬고 있다', emotion: '안도했다', goal: '등대로 간다'})) add('character', field, value, `민아는 ${value}.`);
add('character', 'preferences', {content: '쓴 커피를 좋아한다', topic: '쓴 커피', kind: 'preference'}, '민아는 쓴 커피를 좋아한다.');
add('character', 'boundaries', {content: '내 일기를 읽지 마', topic: '일기', kind: 'boundary',
  scope: {targetName: '지호', act: '', when: ''}}, '민아는 지호에게 내 일기를 읽지 마라고 말했다.');
add('character', 'locationRef', '서재', '민아는 서재에 있다.');
add('character', 'affiliations', {organizationName: '항해회', role: '회원', status: 'member'}, '민아는 항해회의 회원이다.');
add('world', 'description', '오래된 석조 건물', '도서관은 오래된 석조 건물이다.', '도서관');
add('world', 'sceneTime', '2026-11-06 12:00', '도서관의 시각은 2026-11-06 12:00이다.', '도서관');
add('world', 'parentRef', '도서관', '공연실은 도서관 안에 있다.', '공연실');
add('world', 'containerRef', '서재', '은빛 열쇠는 서재에 있다.', '은빛 열쇠');
add('world', 'ownerRef', '민아', '민아 소유의 은빛 열쇠다.', '은빛 열쇠');
add('world', 'holderRef', '지호', '지호가 은빛 열쇠를 들고 있다.', '은빛 열쇠');
add('world', 'managerRef', '기록회', '기록회가 도서관을 관리한다.', '도서관');
add('world', 'access', {personName: '라온', permission: '열람', status: 'granted'}, '도서관은 라온에게 열람을 허가했다.', '도서관');
add('world', 'rule', {text: '정숙 구역', scopeName: '도서관', exceptions: [{locationName: '새강당', condition: '허가된 공연 중', effect: '소음을 허용한다'}]},
  '도서관은 정숙 구역이다. 새강당은 허가된 공연 중 소음을 허용한다.', '도서관');
add('world', 'condition', '문이 열렸다', '도서관 문이 열렸다.', '도서관');
add('relationship', 'value', '신뢰한다', '민아는 지호를 신뢰한다.');
add('narrative', 'locks', {title: '열쇠의 소유', summary: '열쇠는 민아 소유다', status: 'active'}, '열쇠는 민아 소유다.');
add('narrative', 'momentum', '열쇠를 찾아야 한다', '열쇠를 찾아야 한다.');
add('narrative', 'summary', '민아가 도서관에서 쉬고 있다', '민아가 도서관에서 쉬고 있다.');
for (const [name, kind, value] of [['작은 방', 'location', '창문이 높다'], ['청동 컵', 'object', '손잡이가 둥글다'], ['안개터', null, '빛이 희미하다']]) {
  add('world', 'description', value, `${name}은 ${value}.`, name);
  if (kind) cases.at(-1).target.entityKind = kind;
}
add('world', 'parentRef', '도서관', '새 방은 도서관 안에 있다.', '새 방');
cases.at(-1).target.entityKind = 'location';
const admittedCount = cases.length;
for (const field of ['threads', 'arcs', 'resolvedArcs', 'turningPoints', 'motifs', 'closedThreads', 'events', 'primaryArcId']) {
  add('narrative', field, '검증 없는 구조 변경', '검증 없는 구조 변경을 제안했다.');
  cases.at(-1).pending = field === 'threads' ? 'narrative_thread_canonical_only'
    : field === 'primaryArcId' ? 'state_field_names_record' : 'narrative_field_canonical_only';
  // All narrative proposals survive as Micro candidates; admission, not source
  // storage, owns the restriction on directly replacing Canonical structure.
  cases.at(-1).producerRejected = false;
}
add('world', 'rule', {text: '정숙 구역', scopeName: '도서관', exceptions: [{locationName: '새강당', condition: '없는 조건', effect: '없는 허가'}]},
  '도서관은 정숙 구역이다. 새강당은 닫혀 있다.', '도서관');
cases.at(-1).pending = 'state_value_not_source_bound';
add('world', 'parentRef', '도서관', '그릇은 도서관 안에 있다.', '그릇');
cases.at(-1).pending = 'registry_containment_subject_unconfirmed';
add('world', 'description', '오래된 석조 건물', '도서관은 오래된 석조 건물이다.', '도서관');
cases.at(-1).target.entityKind = 'object';
cases.at(-1).pending = 'registry_entity_kind_conflict';
add('character', 'boundaries', {content: '내 일기를 읽지 마', topic: '일기', kind: 'boundary', scope: {targetName: '라온'}},
  '민아는 지호에게 내 일기를 읽지 마라고 말했다.');
cases.at(-1).pending = 'state_value_not_source_bound';

(async () => {
  for (const mode of ['plugin_only', 'mirror', 'server_only']) {
    let listener;
    const sf = await serverFixture({mode, host: {addRisuChatListener: async (_kind, fn) => {listener = fn; return true;}}});
    try {
      const {f} = sf;
      assert.equal((await f.run()).completed, 1);
      await waitFor(() => f.r.api.getCaptureBackendState().lastMicroPublication?.turn === 5, 15000);
      const storedHead = () => mode === 'plugin_only' ? [...sf.local.values()].flatMap(raw => {
        try { const v = JSON.parse(raw); return v?.schema === 'libra.continuity_state.v2' ? [v] : []; } catch {return [];}
      })[0] : sf.getHead();
      const persistedBefore = JSON.stringify(storedHead());
      for (let offset = 0; offset < cases.length; offset += 12) {
        const batch = cases.slice(offset, offset + 12), turn = 6 + offset / 12, body = batch.map(c => c.quote).join('\n');
        f.chat.message.push({role: 'user', chatId: `t${turn}-u`, data: '확인된 기록을 확인한다.'},
          {role: 'assistant', chatId: `t${turn}-a`, data: body});
        f.chat.messages = f.chat.message;
        f.control.onCall = async () => {
          const {receipt: r} = await f.r.api.debugReadActiveCompletedTurnReceipt(turn);
          return {type: 'success', result: JSON.stringify({schema: 'libra.micro_producer_envelope.v1', personCandidates: {spans: [], relations: []},
            micro: {schema: 'libra.micro_memory.v1', scopeKey: r.scopeKey, worldlineId: r.worldlineId,
              sessionEpoch: 0, turn, sourceRevisionId: r.revisionId, sourceDigest: r.sourceDigest,
              claims: batch.map(c => ({changeKind: c.domain === 'relationship' ? 'relation' : c.domain === 'character' ? 'person' : c.domain === 'world' ? 'world' : 'thread',
                text: c.quote, actor: c.domain === 'relationship' ? '민아' : '', target: c.domain === 'relationship' ? '지호' : '',
                temporalRole: 'current', certainty: 'confirmed', epistemicStatus: 'observed', stateChangeType: 'set',
                stateIntent: {domain: c.domain, target: c.target, field: c.field, operation: 'set', value: c.value},
                evidence: {role: 'assistant', messageId: r.assistant.chatId, startOffset: body.indexOf(c.quote),
                  endOffset: body.indexOf(c.quote) + c.quote.length, exactQuote: c.quote}}))}})};
        };
        listener({char: f.character, chat: f.chat, characterIndex: 0, chatIndex: 0, messageIndex: turn * 2 - 1});
        await waitFor(() => f.r.api.getCaptureBackendState().lastMicroPublication?.turn === turn, 15000);
        const micro = await f.r.api.debugReadActiveMicroMemory(turn);
        const retained = batch.filter(c => !c.producerRejected);
        assert.equal(micro.record.claims.length, retained.length, `${mode} T${turn}: supported fields survive validation ${JSON.stringify(micro.record.rejected)}`);
        assert.deepEqual(Array.from(micro.record.rejected, r => r.index), batch.flatMap((c, i) => c.producerRejected ? [i] : []));
        const admissions = await f.r.api.readMicroStateAdmissionForTurn(turn);
        assert.equal(admissions.status, 'verified');
        assert.deepEqual(Array.from(admissions.decisions, row => row.status), retained.map(c => c.pending ? 'pending' : 'admitted'),
          `${mode} T${turn}: ${JSON.stringify(admissions.decisions)}`);
        for (const [i, c] of retained.entries()) if (c.pending) assert.equal(admissions.decisions[i].reason, c.pending);
      }
      const {head} = await f.r.api.debugLoadContinuityStateForResponse();
      const mina = head.characters.find(r => r.name === '민아'), library = head.world.find(r => r.name === '도서관');
      for (const c of cases.filter(c => c.domain === 'character' && !c.pending)) {
        assert.ok(mina.fieldEvidence[c.field], `${mode}: ${c.field} has source evidence`);
        if (typeof c.value === 'string' && c.field !== 'locationRef') {
          assert.ok(JSON.stringify(mina.state[c.field]).includes(c.value), `${mode}: ${c.field}`);
        }
      }
      for (const c of cases.filter(c => c.domain === 'world' && !c.pending)) {
        const row = head.world.find(r => r.name === c.target.entityName);
        assert.ok(row.fieldEvidence[c.field], `${mode}: world ${c.field} has source evidence`);
      }
      const newOrg = head.world.find(r => r.name === '항해회'), newPerson = head.characters.find(r => r.name === '라온');
      assert.equal(newOrg?.kind, 'organization', 'new affiliation keeps the organization identity and name');
      assert.equal(mina.state.affiliations[0].organizationRef, newOrg.id);
      assert.ok(mina.state.boundaries.every(item => item.scope.targetRef !== newPerson?.id), 'automatic review must not apply an uncited boundary target');
      assert.equal(library.state.access[0].personRef, newPerson?.id, 'new access person has a readable identity');
      const hall = head.world.find(r => r.name === '새강당');
      assert.ok(!head.world.some(r => r.name === '그릇'), 'a containment field cannot classify an unknown object as a location');
      assert.equal(hall?.kind, 'location');
      assert.equal(head.world.find(r => r.name === '작은 방')?.kind, 'location');
      assert.equal(head.world.find(r => r.name === '새 방')?.kind, 'location', 'explicit place classification allows a new contained place');
      assert.equal(head.world.find(r => r.name === '청동 컵')?.kind, 'object');
      assert.equal(head.world.find(r => r.name === '안개터')?.kind, 'other', 'unknown kind is not silently classified as an object');
      assert.equal(library.kind, 'location', 'a conflicting Micro kind cannot reclassify a known place');
      assert.deepEqual(plain(library.state.rule), {text: '정숙 구역', scopeRef: library.id,
        exceptions: [{locationRef: hall.id, condition: '허가된 공연 중', effect: '소음을 허용한다'}]});
      assert.ok(head.relationships.some(r => r.state?.value === '신뢰한다'));
      assert.ok(head.narrative.locks.some(r => r.title === '열쇠의 소유'));
      assert.equal(head.narrative.momentum, '열쇠를 찾아야 한다');
      assert.equal(head.narrative.summary, '민아가 도서관에서 쉬고 있다');
      assert.equal(JSON.stringify(storedHead()), persistedBefore, 'response projection does not rewrite the canonical Head');
      console.log(`PASS ${mode}: ${admittedCount} admitted Micro fields, ${cases.length - admittedCount} blocked proposals, nested references, evidence and canonical immutability`);
    } finally {await sf.cleanup();}
  }
})().catch(error => {console.error(error); process.exitCode = 1;});

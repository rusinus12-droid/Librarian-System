'use strict';
const assert = require('node:assert/strict');
const {fixture} = require('./fixtures/libra_unified_runtime_fixture.cjs');
const {fiveMore} = require('./fixtures/libra_server_runtime_fixture.cjs');

(async () => {
  const f = await fixture();
  try {
    const sample = {
      schema: 'libra.completed_turn_receipt.v1', scopeKey: 'sample', worldlineId: 'wl_sample',
      sessionEpoch: 0, turn: 1, revisionId: 'sample-revision', sourceDigest: 'sample-source',
      user: {role: 'user', chatId: 'u1', text: '도현욱은 기다리고 도현은 떠났다. Alice는 남았다. Aliceville은 장소다.'},
      assistant: {role: 'assistant', chatId: 'a1', text: '도현이 돌아왔고 Alice가 인사했다. アリス。라는 이름도 언급했다.'}
    };
    const registry = {entities: [
      {id: 'person-dohyun', type: 'person', name: '도현', aliases: [], validated: true},
      {id: 'person-alice-1', type: 'person', name: 'Alice', aliases: ['アリス'], validated: true},
      {id: 'person-alice-2', type: 'person', name: 'Alice', aliases: [], validated: true}
    ]};
    const inventory = f.r.api.debugBuildKnownPersonSpanInventory(sample, registry);
    assert.equal(inventory.schema, 'libra.person_span_inventory.v1');
    assert.equal(inventory.status, 'known_mentions_only');
    const dohyun = inventory.spans.filter(span => span.name === '도현');
    assert.equal(dohyun.length, 2, 'Korean particle admits full name while longer name does not');
    for (const span of inventory.spans) {
      const row = sample[span.role];
      assert.equal(row.text.slice(span.startOffset, span.endOffset), span.exactQuote, 'span binds exact stored source');
      assert.equal(span.messageId, row.chatId);
    }
    const alice = inventory.spans.filter(span => span.alias === 'Alice');
    assert.equal(alice.length, 2);
    assert(alice.every(span => span.resolution === 'ambiguous_identity' && span.candidateEntityIds.length === 2),
      'same-name people remain unresolved candidates');
    assert(inventory.spans.some(span => span.alias === 'アリス' && span.exactQuote === 'アリス'), 'multilingual alias binds its own exact span');
    assert.equal(inventory.relations.length, 0, 'co-mention never invents a relation');
    assert(inventory.spans.every(span => span.mentionRole === 'mentioned'), 'a quoted mention does not prove scene presence');

    assert.equal(typeof f.r.api.debugResolvePersonSpanInventory, 'function',
      'novel person candidates must pass a source-bound inventory validator');
    const novelReceipt = {
      ...sample, revisionId: 'novel-revision', sourceDigest: 'novel-source',
      user: {...sample.user, text: '서윤은 도현욱을 만났다. 경영학은 전공이다. 그림자가 있었다.'},
      assistant: {...sample.assistant, text: '서윤이 Alice에게 열쇠를 건넸다.'}
    };
    const span = (role, name, from = 0, personType = 'person') => {
      const at = novelReceipt[role].text.indexOf(name, from);
      assert(at >= 0);
      return {role, startOffset: at, endOffset: at + name.length, exactQuote: name, name, personType};
    };
    const modelCandidates = {
      spans: [
        span('user', '서윤'),
        span('assistant', '서윤'),
        span('assistant', 'Alice'),
        span('user', '도현'),
        span('user', '경영학', 0, 'nonperson'),
        span('user', '그림자', 0, 'uncertain'),
        {...span('user', '서윤'), exactQuote: '없는 이름'}
      ],
      relations: [
        {subjectCandidateIndex: 1, targetCandidateIndex: 2, evidence: {
          role: 'assistant', startOffset: 0, endOffset: novelReceipt.assistant.text.length,
          exactQuote: novelReceipt.assistant.text
        }},
        {subjectCandidateIndex: 1, targetCandidateIndex: 99, evidence: {
          role: 'assistant', startOffset: 0, endOffset: novelReceipt.assistant.text.length,
          exactQuote: novelReceipt.assistant.text
        }},
        {subjectCandidateIndex: 5, targetCandidateIndex: 2, evidence: {
          role: 'assistant', startOffset: 0, endOffset: novelReceipt.assistant.text.length,
          exactQuote: novelReceipt.assistant.text
        }}
      ]
    };
    const discovered = f.r.api.debugResolvePersonSpanInventory(novelReceipt, registry, modelCandidates);
    assert.equal(discovered.status, 'classified_candidates');
    assert.equal(discovered.spans.filter(row => row.name === '서윤').length, 2, 'novel name binds both source rows');
    assert.equal(discovered.spans.filter(row => row.name === 'Alice').length, 1, 'known alias and model candidate coalesce');
    assert(!discovered.spans.some(row => row.name === '도현'), 'short name cannot bind inside 도현욱');
    assert(!discovered.spans.some(row => row.name === '경영학'), 'nonperson classification is not admitted as a person');
    assert(discovered.spans.some(row => row.name === '그림자' && row.uncertainty === 'personhood_uncertain'
      && row.candidateEntityIds.length === 0), 'uncertain personhood stays unresolved without Registry mutation');
    assert.equal(discovered.relations.length, 1, 'invalid relation endpoint is not admitted');
    const relation = discovered.relations[0];
    assert.equal(discovered.spans[relation.subjectSpanIndex].name, '서윤');
    assert.equal(discovered.spans[relation.targetSpanIndex].name, 'Alice');
    assert.equal(relation.evidence.exactQuote, novelReceipt.assistant.text);
    assert(discovered.rejected.some(row => row.reason === 'name_boundary_invalid'));
    assert(discovered.rejected.some(row => row.reason === 'classified_nonperson'));
    assert(discovered.rejected.some(row => row.reason === 'source_span_invalid'));
    assert(discovered.rejected.some(row => row.reason === 'relation_endpoint_invalid'));
    assert(discovered.spans.every(row => novelReceipt[row.role].text.slice(row.startOffset, row.endOffset) === row.exactQuote));

    const first = await f.run();
    assert.equal(first.completed, 1, JSON.stringify(first));
    fiveMore(f);
    const second = await f.run();
    assert.equal(second.completed, 1, JSON.stringify(second));
    const canonicalCalls = f.control.calls.filter(args => !JSON.stringify(args).includes('LIBRA MICRO SOURCE CONTRACT'));
    assert.equal(canonicalCalls.length, 2, 'T5 and T10 each have one Canonical model job');
    const prompt = JSON.stringify(canonicalCalls[1]);
    assert.match(prompt, /SOURCE-BOUND PERSON CANDIDATES/, 'T10 Canonical reads the shared receipt-backed inventory');
    assert.match(prompt, /startOffset/);
    assert.match(prompt, /민아/);
    console.log('PASS shared exact person spans feed the production Canonical prompt');
  } finally { await f.r.cleanup(); }

  const missing = await fixture();
  try {
    assert.equal((await missing.run()).completed, 1);
    fiveMore(missing);
    const backend = missing.r.context.risuai.pluginStorage;
    const originalSet = backend.setItem;
    backend.setItem = async (key, value) => {
      if (String(key).includes(':person-span-inventory:')) throw new Error('injected inventory persistence failure');
      return await originalSet(key, value);
    };
    assert.equal((await missing.run()).completed, 1, 'Canonical remains independent from person inventory persistence');
    const canonicalCalls = missing.control.calls.filter(args => !JSON.stringify(args).includes('LIBRA MICRO SOURCE CONTRACT'));
    assert.equal(canonicalCalls.length, 2);
    const prompt = JSON.stringify(canonicalCalls[1]);
    assert.doesNotMatch(prompt, /SOURCE-BOUND PERSON CANDIDATES/,
      'production Canonical prompt must not present an unverified inventory as verified candidates');
    console.log('PASS Canonical omits optional unverified person inventory');
  } finally { await missing.r.cleanup(); }
})().catch(error => { console.error(error); process.exitCode = 1; });

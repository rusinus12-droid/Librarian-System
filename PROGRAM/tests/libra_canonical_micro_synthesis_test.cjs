'use strict';
// Controlled producer + Canonical responses through deployed plugin and isolated
// KV/HTTP SQLite. No external provider, real chat or production database access.
const assert = require('node:assert/strict');
const {serverFixture} = require('./fixtures/libra_server_runtime_fixture.cjs');
const QUOTE = '민아는 갈색 눈이다. 도서관은 오래된 건물이다. 민아는 지호를 신뢰한다. 민아가 열쇠를 받았다. 민아는 약속이 끝났다고 말했다. 민아는 처음에 앉아 있었다. 민아는 나중에 일어섰다.';
const marker = '[VERIFIED MICRO INPUTS — REVIEW WITH THE ORIGINAL TURNS]';
const readInputs = args => {
  const user = args[0].messages.find(m => m.role === 'user').content;
  assert.ok(user.includes(marker), 'Canonical reads Micro in addition to the raw source');
  const start = user.indexOf('{"schema":"libra.canonical_micro_inputs.v1"', user.indexOf(marker));
  const end = user.indexOf('\n\n[VERIFIED ORIGINAL PACKET REFS]', start);
  assert.ok(start > 0 && end > start);
  return JSON.parse(user.slice(start, end));
};
const microResponse = (args, staleCondition = false) => {
  const input = JSON.parse(args[0].messages.find(m => m.role === 'user').content);
  const text = input.assistant.text, startOffset = text.indexOf(QUOTE);
  const plans = [
    {domain: 'character', target: {entityName: '민아'}, field: 'appearance', value: '갈색 눈'},
    {domain: 'world', target: {entityName: '도서관'}, field: 'description', value: '오래된 건물'},
    {domain: 'relationship', target: {subjectName: '민아', targetName: '지호', dimension: 'trust'}, field: 'value', value: '신뢰한다'},
    ...['arcs', 'turningPoints', 'motifs', 'closedThreads', 'events'].map(field => ({domain: 'narrative', target: {scope: 'current_narrative'}, field, value: {title: `후보 ${field}`, summary: '민아가 열쇠를 받았다'}})),
    // A second motif in the same turn is an independent candidate, not a scalar replacement.
    {domain: 'narrative', target: {scope: 'current_narrative'}, field: 'motifs', value: {title: '별도 후보', summary: '민아는 약속이 끝났다고 말했다'}}
  ];
  if (staleCondition) plans.push({domain: 'character', target: {entityName: '민아'}, field: 'condition', value: '앉아 있었다'});
  return {type: 'success', result: JSON.stringify({schema: 'libra.micro_producer_envelope.v1', personCandidates: {spans: [], relations: []},
    micro: {schema: 'libra.micro_memory.v1', ...input.binding, claims: [...plans.map(p => {
      const quote = p.field === 'motifs' ? p.value.summary + '.' : QUOTE, offset = text.indexOf(quote);
      return {changeKind: 'event', text: '검토할 Micro 관측', actor: '', target: '',
      temporalRole: 'current', certainty: 'confirmed', epistemicStatus: 'observed', stateChangeType: 'set',
      stateIntent: {...p, operation: 'set'}, evidence: {role: 'assistant', messageId: input.assistant.messageId,
        startOffset: offset, endOffset: offset + quote.length, exactQuote: quote}};
    }),
      {changeKind: 'event', text: '아직 확정하지 않은 관측', actor: '', target: '', temporalRole: 'uncertain', certainty: 'uncertain',
        epistemicStatus: 'uncertain', stateChangeType: 'none', evidence: {role: 'assistant', messageId: input.assistant.messageId,
          startOffset, endOffset: startOffset + QUOTE.length, exactQuote: QUOTE}}]}})};
};

async function run(mode, scenario = 'normal') {
  const sf = await serverFixture({mode});
  try {
    const {f} = sf;
    const rows = () => mode === 'plugin_only' ? [...sf.local].flatMap(([key, raw]) => {
      try {return [{key, value: JSON.parse(raw)}];} catch {return [];}
    }) : sf.storedRows();
    const getMemory = () => {
      const manifest = rows().find(r => r.key.endsWith(':manifest'))?.value;
      return rows().find(r => r.key === manifest?.memories?.['1']?.key)?.value || null;
    };
    const getHead = () => rows().find(r => r.value?.schema === 'libra.continuity_state.v2')?.value;
    for (let i = 1; i < f.chat.message.length; i += 2) f.chat.message[i].data += ' ' + QUOTE;
    f.control.onCall = args => microResponse(args, scenario === 'canonical-priority');
    const inventory = await f.r.api.listReanalysisRanges({kind: 'micro'});
    const produced = await f.r.api.reanalyzeSelectedRanges(inventory);
    assert.equal(produced.ok, true, JSON.stringify(produced));
    const records = [];
    for (let turn = 1; turn <= 5; turn++) {
      const active = await f.r.api.debugReadActiveMicroMemory(turn);
      assert.equal(active.status, 'verified');
      assert.equal(active.record.claims.length, scenario === 'canonical-priority' ? 11 : 10, 'all domains, both motif candidates and uncertain observations survive');
      assert.equal(active.record.claims.filter(c => c.stateIntent?.field === 'motifs').length, 2, 'later independent motifs must not replace earlier candidates');
      records.push(active);
    }
    assert.equal(getMemory(), null, 'Micro covers turns before any Canonical memory exists');
    if (scenario === 'edited-source') f.chat.message[1].data += ' 원문이 수정되었다.';
    let seen = 0;
    f.control.onCall = args => {
      if (args[0].messages[0].content.includes('[LIBRA MICRO SOURCE CONTRACT]')) return microResponse(args);
      const input = readInputs(args), claims = input.turns.flatMap(row => row.claims || []);
      seen++;
      assert.equal(claims.length, scenario === 'edited-source' ? 40 : scenario === 'canonical-priority' ? 55 : 50);
      assert.ok(claims.some(c => c.stateIntent?.domain === 'character'));
      assert.ok(claims.some(c => c.stateIntent?.domain === 'world'));
      assert.ok(claims.some(c => c.stateIntent?.domain === 'relationship'));
      assert.ok(claims.some(c => c.stateIntent?.field === 'turningPoints'));
      assert.ok(claims.some(c => c.stateIntent?.field === 'events'));
      assert.ok(claims.some(c => c.certainty === 'uncertain'), 'uncertain Micro observations are reviewed too');
      if (scenario === 'edited-source') assert.ok(!input.turns.find(row => row.turn === 1)?.claims?.length, 'old-source Micro is not recycled');
      if (scenario === 'changed-record') {
        const r = records[0], changed = JSON.parse(sf.local.get(r.recordKey));
        changed.claims[0].text = '저장 중 바뀐 관측';
        sf.local.set(r.recordKey, JSON.stringify(changed));
      }
      const artifact = f.clone(f.control.artifact);
      artifact.facts.push({tempFactId: 'from_micro_review', domain: 'character', subjectTempRef: 'mina', claimKind: 'character_appearance',
        values: {appearance: ['갈색 눈']}, text: '민아는 갈색 눈이다.', temporalRole: 'current_sequence', certainty: 'confirmed',
        evidenceSpans: [{ref: 't2-a', quote: '민아는 갈색 눈이다.'}]});
      if (scenario === 'canonical-priority') artifact.facts.push({tempFactId: 'final_condition', domain: 'character', subjectTempRef: 'mina', claimKind: 'character_state',
        values: {condition: '일어섰다'}, text: '민아는 나중에 일어섰다.', temporalRole: 'current_sequence', certainty: 'confirmed',
        evidenceSpans: [{ref: 't5-a', quote: '민아는 나중에 일어섰다.'}]});
      return {type: 'success', result: JSON.stringify(artifact)};
    };
    const result = await f.run();
    assert.ok(seen > 0, JSON.stringify(result));
    if (scenario === 'changed-record') {
      assert.equal(result.completed, 0, JSON.stringify(result));
      assert.equal(getMemory(), null, 'a changed consumed record cannot commit a Canonical memory');
      assert.match(JSON.stringify(result), /CANONICAL_MICRO_INPUT_CHANGED/);
    } else {
      assert.equal(result.completed, 1, JSON.stringify(result));
      const memory = getMemory(), provenance = Object.values(memory.promptProvenance.stages).find(s => s?.microInputs)?.microInputs;
      assert.equal(provenance?.claimCount, scenario === 'edited-source' ? 40 : scenario === 'canonical-priority' ? 55 : 50);
      assert.equal(provenance.refs.length, scenario === 'edited-source' ? 4 : 5);
      assert.ok(provenance.refs.every(ref => ref.recordDigest && ref.analysisRevisionId));
      assert.ok(getHead().characters.find(c => c.name === '민아').state.appearance.includes('갈색 눈'));
      assert.ok(!memory.canonicalArtifact.facts.some(fact => fact.text === '검토할 Micro 관측'), 'Micro candidates are not blindly promoted');
      for (const record of records) assert.deepEqual(rows().find(row => row.key === record.recordKey)?.value, JSON.parse(JSON.stringify(record.record)),
        'Canonical synthesis retains the consumed Micro record for provenance');
      if (scenario === 'canonical-priority') {
        assert.equal(getHead().characters.find(c => c.name === '민아').state.condition, '일어섰다');
        const view = await f.r.api.debugLoadContinuityStateForResponse();
        assert.equal(view.head.characters.find(c => c.name === '민아').state.condition, '일어섰다', 'automatic review must not replace the final Canonical value with an older Micro value');
      }
    }
    console.log(`PASS ${mode}/${scenario}: all-domain Micro inputs, original-source validation and Canonical synthesis`);
  } finally {await sf.cleanup();}
}
(async () => {
  for (const mode of ['plugin_only', 'mirror', 'server_only']) await run(mode);
  await run('plugin_only', 'edited-source');
  await run('plugin_only', 'changed-record');
  await run('plugin_only', 'canonical-priority');
})().catch(error => {console.error(error); process.exitCode = 1;});

'use strict';
// Synthetic public-path corpus from the graph-section-only audit. Ten batches
// saturate the direct shortlist (8); batch 2 is reachable through shared entities
// and earns dense relevance from its detail section, outside that shortlist.
const assert = require('node:assert/strict');
const { fixture, artifact } = require('./libra_unified_runtime_fixture.cjs');
const { shiftRefs } = require('./libra_evidence_link_index_fixture.cjs');
const source = require('./unified_vertical_source.json');
const REQUEST = '예전 은빛 열쇠';
const GRAPH_FACT = '예비 출입문은 안전 점검 중이다.';
const docs = [
  { base: true }, { text: GRAPH_FACT, subset: true },
  { text: '크산티움 장치는 서재에 보관되어 있다.' },
  { text: '민아는 "달빛은 종이 위에서 잠든다"라고 말했다.' },
  { text: '공연실 보관함 번호는 7319다.' },
  { text: '도서관의 장치는 실내의 수분을 제거한다.' },
  { text: '공연실 경보는 켜져 있다.', state: 'hall' },
  { text: '공연실 경보는 꺼져 있다.', state: 'hall' },
  { text: '서재 문은 닫혀 있다.', state: 'study' },
  { text: '서재 문은 열려 있다.', state: 'study' }
];
const vector = weights => {
  const value = Array(256).fill(0);
  for (const [index, weight] of weights) value[index] = weight;
  value[255] = Math.sqrt(1 - value.reduce((sum, weight) => sum + weight * weight, 0));
  return value;
};
const documentVector = text => {
  const index = docs.findIndex(doc => doc.text && text.includes(doc.text));
  return vector([[index === 1 && /^\[TURN /u.test(text) ? 101 : Math.max(0, index), 1]]);
};
const embeddingHost = counts => ({ nativeFetch: async (url, init) => {
  assert.match(url, /^https:\/\/synthetic\.invalid\//);
  const body = JSON.parse(init.body), inputs = Array.isArray(body.input) ? body.input : [body.input];
  const query = body.input_type === 'query' || inputs.some(text => String(text).includes(REQUEST));
  counts[query ? 'query' : 'document'] += 1;
  return new Response(JSON.stringify({ data: inputs.map((text, index) => ({
    index, embedding: query ? vector([[0, .58], [101, .77]]) : documentVector(String(text))
  })) }), { status: 200 });
} });
const settings = async f => {
  const current=await f.r.api.getLibraMemorySettings();
  const patch={ performancePreset:'custom', candidateLimit:8, recallMaxMemories:12,
    recallMaxChars:12000, recallQueryMessages:1, forceCurrentScene:true };
  // This fixture configures scalar fields on normalized getter settings. Saving
  // a no-op would invoke refreshSnapshot and hydrate the entire test corpus.
  if(Object.entries(patch).every(([key,value])=>current[key]===value))return current;
  return await f.r.api.saveLibraMemorySettings({...current,...patch});
};
async function seedSnapshot() {
  const counts = { query: 0, document: 0 };
  const f = await fixture({ host: embeddingHost(counts) });
  try {
    await f.r.api.saveEmbeddingSettings({ enabled: true, provider: 'openai',
      url: 'https://synthetic.invalid/v1/embeddings', model: 'text-embedding-3-small',
      key: 'synthetic-only-not-real', dimensions: 256, maxRetries: 0 });
    await settings(f);
    for (const [index, doc] of docs.entries()) {
      const offset = index * 5;
      if (index) {
        f.chat.message.push(...source.sourceRows.map(row => ({ role: row.role,
          chatId: row.ref.replace(/^t(\d+)/, (_, turn) => `t${Number(turn) + offset}`), data: row.text })));
        f.chat.message[offset * 2 + 9].data += ` ${doc.text}`;
      }
      const next = shiftRefs(artifact(), offset);
      if (!doc.base) {
        next.facts = doc.subset ? next.facts.slice(0, 4) : [];
        next.stateBindings = [];
        next.facts.push({ tempFactId: `proof_${index}`, domain: doc.state ? 'world' : 'event',
          subjectTempRef: doc.state || 'library', claimKind: doc.state ? 'world_state' : 'event',
          values: doc.state ? { condition: doc.text } : { detail: doc.text }, text: doc.text,
          temporalRole: 'current_sequence', certainty: 'confirmed',
          evidenceSpans: [{ ref: `t${offset + 5}-a`, quote: doc.text }] });
        if (doc.state) next.stateBindings.push({ factTempId: `proof_${index}`, typedValueField: 'condition',
          stateDomain: 'world', stateField: 'condition' });
      }
      f.control.artifact = next;
      const result = await f.run();
      assert.equal(result.completed, 1, JSON.stringify(result));
      await f.r.api.retryPendingUnifiedVectors();
    }
    return { chat: f.clone(f.chat), values: [...f.r.values] };
  } finally { await f.r.cleanup(); }
}
async function finalProofFixture(snapshot, graph = true, options = {}) {
  const counts = { query: 0, document: 0 };
  const f = await fixture({ snapshot, transformSource: options.transformSource,
    args: { evidence_link_index_enabled: String(graph), associative_recall_enabled: String(graph),
      lore_link_index_enabled: 'false' }, host: embeddingHost(counts) });
  await settings(f);
  return { ...f, counts, graphRef: f.getManifest().memories['6'] };
}
module.exports = { seedSnapshot, finalProofFixture, REQUEST, GRAPH_FACT };

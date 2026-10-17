'use strict';
// HAYAKU recallAliases with a real model: does the alias instruction make paraphrased
// questions findable by the lexical localRecallRank?
//
// For every fixture turn the model writes meta.summary_memory {summary, recallAliases}
// under one of two alias instructions:
//   current     the shipped rule (other languages: en and the user's language if different)
//   samelang    the shipped rule plus same-language paraphrase keywords
// The summary and all alias values are admitted as HAYAKU search text and every question
// is ranked with the real localRecallRank (top K). Results are cached per instruction.
//   RAG_EVAL_LLM_URL (…/v1) / RAG_EVAL_LLM_KEY / RAG_EVAL_LLM_MODEL
// Usage: node tools/rag_eval/hayaku_alias_llm_eval.cjs [fixture.json] [--k N] [--cache file]
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const argv = process.argv.slice(2);
const option = name => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const fixturePath = argv.find(value => value.endsWith('.json') && argv[argv.indexOf(value) - 1] !== '--cache')
  || path.join(__dirname, '../../tests/fixtures/rag_eval_ko_v1.json');
const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
const K = Number(option('--k') || 5);
const cachePath = option('--cache') || '';
const cache = cachePath && fs.existsSync(cachePath) ? JSON.parse(fs.readFileSync(cachePath, 'utf8')) : {};
const llmUrl = String(process.env.RAG_EVAL_LLM_URL || '').replace(/\/+$/, '');

const source = fs.readFileSync(path.join(__dirname, '../../plugins/HAYAKU_Locator_Continuity.js'), 'utf8');
const start = source.indexOf('  const LOCAL_RECALL_VERSION'), end = source.indexOf('  const localRecallFairMerge', start);
const context = vm.createContext({ Memory: {}, hayakuRecallRequests: { active: null }, now: () => Date.now(),
  ensureArray: value => Array.isArray(value) ? value : value == null ? [] : [value], admittedRecallAliasProofs: new WeakSet(), Symbol, Map, Set, WeakMap, Math, Number, String, Object, Array, JSON });
vm.runInContext(source.slice(start, end) + '\nObject.assign(globalThis,{localRecallRank});', context);

const currentRule = 'Populate meta.summary_memory.recallAliases as an object using these language keys: ko, en, ja, zh. Always include en and the language of the latest user input whenever it differs from the summary language, so the memory stays findable across languages. Each alias must paraphrase the same established fact and add no detail.';
const sameLanguageRule = currentRule + ' Also add, under the summary language key, 2-4 short same-language paraphrases using the everyday words a reader would later use to ask about this fact (synonyms, the general category of a named thing, the purpose or result of the action), still adding no new detail.';
const instructions = { current: currentRule, samelang: sameLanguageRule };

const ask = async (rule, turn) => {
  const key = `${rule}\u0000${turn}`;
  if (cache[key]) return cache[key];
  const [user, assistant] = fixture.turns[turn - 1];
  const messages = [
    { role: 'system', content: 'You write the meta.summary_memory object of a HAYAKU continuity packet for one roleplay turn. Return JSON only: {"summary":string,"recallAliases":object}. The summary is one sentence in the language of the turn. Preserve original names. ' + instructions[rule] },
    { role: 'user', content: JSON.stringify({ user, assistant }) }
  ];
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(llmUrl + '/chat/completions', { method: 'POST',
        headers: { Authorization: `Bearer ${process.env.RAG_EVAL_LLM_KEY || ''}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: process.env.RAG_EVAL_LLM_MODEL, messages, temperature: 0, stream: false }) });
      if (!response.ok) throw new Error(String(response.status));
      const text = String((await response.json()).choices?.[0]?.message?.content || '');
      const value = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
      cache[key] = value;
      if (cachePath) fs.writeFileSync(cachePath, JSON.stringify(cache));
      return value;
    } catch (error) { if (attempt === 2) throw error; await new Promise(resolve => setTimeout(resolve, 3000)); }
  }
};
const aliasValues = aliases => Object.values(aliases && typeof aliases === 'object' ? aliases : {})
  .flatMap(value => Array.isArray(value) ? value : [value]).map(String).filter(Boolean);

const evaluate = packets => {
  const rows = packets.map((packet, index) => {
    const turn = index + 1, pointer = '/meta/summary_memory', locator = { sourceHash: `p${turn}`, sourceRevision: 'rev1', originalPointer: pointer };
    const row = { id: `r${turn}`, turn, publicText: String(packet.summary || ''), packetHash: `p${turn}`, axis: 'narrative', category: 'summary_memory', recordKey: `s${turn}`, locator };
    const proof = Object.freeze({ version: 1, recordKey: row.recordKey, sourceHash: row.packetHash, sourceRevision: 'rev1', originalPointer: pointer,
      values: Object.freeze(aliasValues(packet.recallAliases)) });
    context.admittedRecallAliasProofs.add(proof);
    row._recallSearchAliases = proof;
    return row;
  });
  const results = fixture.questions.map(question => {
    const ranked = Array.from(context.localRecallRank(rows, [question.q])).slice(0, K);
    return { id: question.id, family: question.family, hit: ranked.some(row => question.gold.includes(row.turn)) };
  });
  return { hitRate: +(results.filter(r => r.hit).length / results.length).toFixed(3), misses: results.filter(r => !r.hit).map(r => r.id) };
};

(async () => {
  const report = { schema: 'memory-suite.rag-eval-report.v1', plugin: 'HAYAKU recallAliases (real model)', model: process.env.RAG_EVAL_LLM_MODEL, topK: K, rules: {} };
  for (const rule of Object.keys(instructions)) {
    const packets = [];
    for (let offset = 0; offset < fixture.turns.length; offset += 6) {
      packets.push(...await Promise.all(fixture.turns.slice(offset, offset + 6).map((_, i) => ask(rule, offset + i + 1))));
    }
    report.rules[rule] = { ...evaluate(packets), sampleAliases: packets.slice(10, 12).map(packet => packet.recallAliases) };
  }
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
})().catch(error => { console.error(error); process.exit(1); });

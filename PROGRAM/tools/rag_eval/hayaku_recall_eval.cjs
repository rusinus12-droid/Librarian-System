'use strict';
// HAYAKU local recall ranking, same-language and cross-language.
//
// Runs the real localRecallRank (BM25 over words + character bigrams) extracted from
// plugins/HAYAKU_Locator_Continuity.js. Each fixture turn becomes one memory row in
// the memory language (ko, or the English translation that keeps Hangul names, as
// HAYAKU packets are instructed to). Questions are asked in ko or en. A question hits
// when a gold turn is in the top K. Optional dense rescoring uses the synthetic
// embedder (or a real provider) to show what a semantic channel adds.
// Usage: node tools/rag_eval/hayaku_recall_eval.cjs [fixture.json] [--k N]
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const argv = process.argv.slice(2);
const fixturePath = argv.find(value => value.endsWith('.json')) || path.join(__dirname, '../../tests/fixtures/rag_eval_ko_v1.json');
const kIndex = argv.indexOf('--k');
const K = kIndex >= 0 ? Number(argv[kIndex + 1]) : 5;
const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
const en = fixture.translations?.en;
if (!en) throw new Error('fixture has no English translation');
const source = fs.readFileSync(path.join(__dirname, '../../plugins/HAYAKU_Locator_Continuity.js'), 'utf8');
const start = source.indexOf('  const LOCAL_RECALL_VERSION'), end = source.indexOf('  const localRecallFairMerge', start);
if (start < 0 || end < 0) throw new Error('HAYAKU local recall block not found');
const context = vm.createContext({ Memory: {}, hayakuRecallRequests: { active: null }, now: () => Date.now(),
  ensureArray: value => Array.isArray(value) ? value : value == null ? [] : [value], admittedRecallAliasProofs: new WeakSet(), Symbol, Map, Set, WeakMap, Math, Number, String, Object, Array, JSON });
vm.runInContext(source.slice(start, end) + '\nObject.assign(globalThis,{localRecallRank});', context);

const memories = {
  ko: fixture.turns.map(([, assistant]) => assistant),
  en: en.turnsAssistant
};
const questions = {
  ko: fixture.questions.map(q => ({ id: q.id, family: q.family, q: q.q, gold: q.gold })),
  en: fixture.questions.map(q => ({ id: q.id, family: q.family, q: en.questions[q.id].q, gold: q.gold }))
};
// aliasLanguage: the packet's summary_memory carries recallAliases in that language
// (a same-fact paraphrase), admitted through HAYAKU's own alias proof shape so the
// real localRecallSearchBody path uses them as search-only text.
const rowsFor = (language, aliasLanguage = null) => memories[language].map((text, index) => {
  const turn = index + 1, pointer = '/meta/summary_memory', locator = { sourceHash: `p${turn}`, sourceRevision: 'rev1', originalPointer: pointer };
  const row = { id: `r${turn}`, turn, publicText: text, packetHash: `p${turn}`, axis: 'narrative', category: 'summary_memory', recordKey: `s${turn}`, locator };
  if (aliasLanguage) {
    const proof = Object.freeze({ version: 1, recordKey: row.recordKey, sourceHash: row.packetHash, sourceRevision: 'rev1', originalPointer: pointer,
      values: Object.freeze([memories[aliasLanguage][index]]) });
    context.admittedRecallAliasProofs.add(proof);
    row._recallSearchAliases = proof;
  }
  return row;
});

const run = (memoryLanguage, questionLanguage, aliasLanguage = null) => {
  const rows = rowsFor(memoryLanguage, aliasLanguage);
  const results = questions[questionLanguage].map(question => {
    const ranked = Array.from(context.localRecallRank(rows, [question.q])).slice(0, K);
    return { id: question.id, family: question.family, hit: ranked.some(row => question.gold.includes(row.turn)), retrieved: ranked.length };
  });
  const families = {};
  for (const row of results) { const f = families[row.family] ||= { q: 0, h: 0 }; f.q += 1; f.h += row.hit ? 1 : 0; }
  return { hitRate: +(results.filter(r => r.hit).length / results.length).toFixed(3),
    families: Object.fromEntries(Object.entries(families).map(([k, v]) => [k, +(v.h / v.q).toFixed(3)])),
    emptyResults: results.filter(r => !r.retrieved).length, misses: results.filter(r => !r.hit).map(r => r.id) };
};

process.stdout.write(JSON.stringify({ schema: 'memory-suite.rag-eval-report.v1', plugin: 'HAYAKU local recall (lexical)', fixture: path.basename(fixturePath), topK: K,
  scenarios: {
    'memory ko / question ko': run('ko', 'ko'),
    'memory en / question en': run('en', 'en'),
    'memory en / question ko': run('en', 'ko'),
    'memory ko / question en': run('ko', 'en'),
    'memory en + ko aliases / question ko': run('en', 'ko', 'ko'),
    'memory ko + en aliases / question en': run('ko', 'en', 'en'),
    'memory ko + en aliases / question ko': run('ko', 'ko', 'en')
  } }, null, 2) + '\n');

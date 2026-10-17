'use strict';
// LIBRA unified-engine retrieval on the shared Korean RAG fixture.
//
// Runs the real query kernel / compiler / rollout through
// tools/evaluate_libra_unified_memory.cjs. The 30 fixture turns become six
// five-turn canonical chapters (LIBRA's canonical unit). Three modes:
//   lexical      the engine with semantic seeds disabled (vectorless)
//   global       one chapter vector (current production representation)
//   sections     chapter vector plus per-turn `sectionVectors` on the representation.
//                The current kernel ignores sectionVectors, so this equals `global`; the
//                mode stays to measure a kernel that uses them. A max-over-sections and
//                a global/section average were measured on 2026-10-15 and did not help
//                (docs/RAG_EVAL_HYBRID_FALLBACK_20261015.md).
// Embeddings come from the offline synthetic embedder (not a provider quality claim), or
// from a real provider when RAG_EVAL_EMBED_URL is set (tools/rag_eval/real_embedder.cjs).
// Usage: node tools/rag_eval/libra_kernel_eval.cjs [fixture.json] [--units N]
const fs = require('node:fs');
const path = require('node:path');
const synthetic = require('./synthetic_embedder.cjs');
const real = require('./real_embedder.cjs');
const { evaluateScenario, createEngineSuite } = require('../evaluate_libra_unified_memory.cjs');

const argv = process.argv.slice(2);
const fixturePath = argv.find(value => value.endsWith('.json')) || path.join(__dirname, '../../tests/fixtures/rag_eval_ko_v1.json');
const unitsIndex = argv.indexOf('--units');
const maxUnits = unitsIndex >= 0 ? Number(argv[unitsIndex + 1]) : 2;
const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
const CHAPTER = 5;
const chapters = [];
for (let start = 0; start < fixture.turns.length; start += CHAPTER) {
  const turns = fixture.turns.slice(start, start + CHAPTER);
  chapters.push({ nodeId: `c_${start / CHAPTER + 1}`, recordKey: `rec_c_${start / CHAPTER + 1}`, turn: start + turns.length,
    text: turns.map(([user, assistant]) => `${user} ${assistant}`).join(' '), sections: turns.map(([user, assistant]) => `${user} ${assistant}`) });
}
const vectors = new Map();
const embed = text => real.enabled ? vectors.get(text) : synthetic.embed(text);
let space = { spaceId: 'rag-eval-synthetic', provider: 'synthetic', model: synthetic.name, dimension: synthetic.DIM, metric: 'cosine' };

const caseFor = (question, mode) => {
  const goldChapters = [...new Set(question.gold.map(turn => `c_${Math.ceil(turn / CHAPTER)}`))];
  const documentRepresentations = mode === 'lexical' ? {} : Object.fromEntries(chapters.map(chapter => [chapter.nodeId, {
    spaceId: space.spaceId, provider: space.provider, model: space.model, dimension: space.dimension, metric: space.metric,
    vector: embed(chapter.text), temporalEndTurn: chapter.turn,
    ...(mode === 'sections' ? { sectionVectors: chapter.sections.map(text => embed(text)) } : {}) }]));
  return {
    id: `rag-${question.id}-${mode}`, label: question.q, category: question.family,
    corpus: { scopeKey: 'rag-eval', canonical: chapters.map(({ nodeId, recordKey, turn, text }) => ({ nodeId, recordKey, turn, text })) },
    query: { queryText: question.q, asOfTurn: fixture.turns.length, viewerId: 'owner_reader', worldlineId: 'main',
      consumerPolicy: { consumer: 'classic', maxCharacters: 8192, maxUnits },
      ...(mode === 'lexical' ? { vectorlessMode: true } : { semanticSpace: space, queryEmbedding: embed(question.q), documentRepresentations }) },
    expected: { goldNodeIds: goldChapters }, passCriteria: { minGoldRecall: 1 }
  };
};

(async () => {
  if (real.enabled) {
    const texts = [...chapters.flatMap(chapter => [chapter.text, ...chapter.sections]), ...fixture.questions.map(question => question.q)];
    const rows = await real.embedMany(texts);
    texts.forEach((text, index) => vectors.set(text, rows[index]));
    space = { spaceId: 'rag-eval-real', provider: 'openai_compat', model: real.model, dimension: rows[0].length, metric: 'cosine' };
  }
  const suite = createEngineSuite();
  const report = { schema: 'memory-suite.rag-eval-report.v1', plugin: 'LIBRA unified engine', fixture: path.basename(fixturePath),
    corpus: { chapters: chapters.length, maxUnits }, embedder: real.enabled ? real.model : synthetic.name, modes: {} };
  for (const mode of ['lexical', 'global', 'sections']) {
    const rows = [];
    for (const question of fixture.questions) {
      const result = await evaluateScenario(caseFor(question, mode), suite);
      rows.push({ id: question.id, family: question.family, hit: result.checks.goldRecall });
    }
    const families = {};
    for (const row of rows) { const f = families[row.family] ||= { q: 0, h: 0 }; f.q += 1; f.h += row.hit ? 1 : 0; }
    report.modes[mode] = { hitRate: +(rows.filter(row => row.hit).length / rows.length).toFixed(3),
      families: Object.fromEntries(Object.entries(families).map(([k, v]) => [k, +(v.h / v.q).toFixed(3)])),
      misses: rows.filter(row => !row.hit).map(row => row.id) };
  }
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
})().catch(error => { console.error(error); process.exit(1); });

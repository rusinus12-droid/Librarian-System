'use strict';
// GRADIA multi-owner evidence selection: quality and packing cost.
//
// Extracts the real ordering/packing functions from plugins/GRADIA.js and compares
// the current order (recent per owner, BM25 to the current input, then newest-first)
// with the previous newest-first round robin on the shared RAG fixture. The owner
// corpora are built from the fixture turns: Flashback-style raw U+A turns, HAYAKU-style
// per-turn assistant records and LIBRA-style five-turn chapters.
// Usage: node tools/rag_eval/gradia_evidence_eval.cjs [fixture.json] [--chars N]
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { performance } = require('node:perf_hooks');

const argv = process.argv.slice(2);
const fixturePath = argv.find(value => value.endsWith('.json')) || path.join(__dirname, '../../tests/fixtures/rag_eval_ko_v1.json');
const charsIndex = argv.indexOf('--chars');
const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
const source = fs.readFileSync(path.join(__dirname, '../../plugins/GRADIA.js'), 'utf8');
const between = (start, end) => { const i = source.indexOf(start), j = source.indexOf(end, i); if (i < 0 || j < 0) throw new Error('GRADIA source marker missing: ' + start); return source.slice(i, j); };
const context = vm.createContext({ TextEncoder, REFERENCE_BUDGET_CUSTOM_MAX_CHARS: 240000, LIB_EVIDENCE_MAX_BYTES: 4 * 1024 * 1024,
  libEvidenceError: code => Object.assign(new Error(code), { code }) });
vm.runInContext(between('  const escapeLibEvidenceJson =', '  const libNativePromptView =')
  + '\nObject.assign(globalThis,{renderLibEvidence,createLibEvidencePacker,orderLibEvidenceCandidates});', context);
const { renderLibEvidence, createLibEvidencePacker, orderLibEvidenceCandidates } = context;

const owners = ['libra', 'hayaku', 'flashback'];
const corpus = [];
fixture.turns.forEach(([user, assistant], index) => {
  const turn = index + 1;
  corpus.push({ owner: 'flashback', turns: [turn], content: `User: ${user}\nAssistant: ${assistant}` });
  corpus.push({ owner: 'hayaku', turns: [turn], content: `T${turn} 기록: ${assistant}` });
  if (turn % 5 === 0) corpus.push({ owner: 'libra', turns: [turn - 4, turn - 3, turn - 2, turn - 1, turn],
    content: `T${turn - 4}-T${turn} 정본: ` + fixture.turns.slice(turn - 5, turn).map(pair => pair[1]).join(' ') });
});
const items = corpus.map((item, index) => ({ ...item, id: `${item.owner}:${index}`, key: `k${index}`, source: { turnIds: item.turns } }));
const queues = () => new Map(owners.map(owner => [owner, items.filter(item => item.owner === owner)]));
const previousOrder = () => {
  const pending = queues(), out = [];
  while ([...pending.values()].some(queue => queue.length)) for (const owner of owners) { const item = pending.get(owner).pop(); if (item) out.push(item); }
  return out;
};
const pack = (candidates, maxChars) => {
  const packer = createLibEvidencePacker('gradia.lib-server-evidence.v1', 'rev', { maxChars, maxBytes: 4 * 1024 * 1024 });
  return candidates.filter(item => packer.tryAdd(item));
};
// Default budget: roughly a quarter of the corpus fits, a long chat in a small context.
const fullChars = renderLibEvidence({ schema: 'gradia.lib-server-evidence.v1', evidenceRevision: 'rev', items }).length;
const maxChars = charsIndex >= 0 ? Number(argv[charsIndex + 1]) : Math.round(fullChars / 4);

const evaluate = order => {
  const rows = fixture.questions.map(question => {
    const selected = pack(order(question), maxChars);
    const text = selected.map(item => item.content).join('\n');
    const found = question.expect.filter(needle => text.includes(needle)).length;
    return { id: question.id, family: question.family, hit: found === question.expect.length, selected: selected.length };
  });
  const families = {};
  for (const row of rows) { const f = families[row.family] ||= { questions: 0, hits: 0 }; f.questions += 1; f.hits += row.hit ? 1 : 0; }
  return { hitRate: +(rows.filter(row => row.hit).length / rows.length).toFixed(3),
    families: Object.fromEntries(Object.entries(families).map(([k, v]) => [k, +(v.hits / v.questions).toFixed(3)])),
    avgSelectedItems: +(rows.reduce((sum, row) => sum + row.selected, 0) / rows.length).toFixed(1), misses: rows.filter(row => !row.hit).map(row => row.id) };
};

// Packing cost on a large synthetic corpus: rendering the whole packet per candidate
// (previous) versus measuring each item once (current). Same accept decisions.
const big = Array.from({ length: 4096 }, (_, index) => ({ id: `x:${index}`, owner: owners[index % 3], key: `k${index}`, source: { turnIds: [index] },
  content: `기록 ${index}: ` + '항구 마을의 오래된 이야기와 등장인물의 대화 '.repeat(4) }));
const bigBudget = 200000;
let started = performance.now();
const quadratic = [];
for (const item of big) {
  try { renderLibEvidence({ schema: 'gradia.lib-server-evidence.v1', evidenceRevision: 'rev', items: [...quadratic, item] }, { maxChars: bigBudget, maxBytes: 4 * 1024 * 1024 }); quadratic.push(item); }
  catch (error) { if (error.code !== 'LIB_READ_PROMPT_BUDGET_EXCEEDED') throw error; }
}
const quadraticMs = performance.now() - started;
started = performance.now();
const linear = pack(big, bigBudget);
const linearMs = performance.now() - started;
if (linear.length !== quadratic.length || linear.some((item, index) => item !== quadratic[index])) throw new Error('packer decisions differ from full rendering');

process.stdout.write(JSON.stringify({
  schema: 'memory-suite.rag-eval-report.v1', plugin: 'GRADIA multi-owner evidence', fixture: path.basename(fixturePath),
  corpus: { items: items.length, renderedChars: fullChars, budgetChars: maxChars },
  previous_newest_first: evaluate(() => previousOrder()),
  current_relevance: evaluate(question => orderLibEvidenceCandidates(queues(), owners, question.q)),
  packing4096: { selected: linear.length, previousMs: Math.round(quadraticMs), currentMs: Math.round(linearMs), identicalDecisions: true }
}, null, 2) + '\n');

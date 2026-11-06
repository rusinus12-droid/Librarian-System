'use strict';
// LIA: choosing a density generates the prompt it needs, and retired image data is removed without touching anything else.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createFixture } = require('./fixtures/lia_native_runtime_fixture.cjs');

const expose = source => {
  const seam = `const content = await callIndependentProvider(\n      "You are LIA's Persona Prompt compiler.`;
  assert.ok(source.includes(seam), 'compile provider seam');
  return source.replace('if (typeof document === "undefined") return null;', 'if (typeof document === "undefined") return parseLLMResult(preservedLLMResultText || "");').replace(seam, `globalThis.__compileCalls = (globalThis.__compileCalls || 0) + 1;\n    const content = globalThis.__compileResult ? JSON.stringify(globalThis.__compileResult) : await callIndependentProvider(\n      "You are LIA's Persona Prompt compiler.`)
    .replace('      getScopePersonaCatalog:', `      auditSetDraft: raw => { preservedLLMResultText = String(raw || ''); },
      auditDraft: () => preservedLLMResultText,
      auditDensity: profile => selectPersonaPromptDensity(profile),
      auditRerank: ctx => renderLoreRerankerPanel(ctx),
      auditPurge: () => purgeRetiredLiaImageData(),
      getScopePersonaCatalog:`);
};

const spec = { name: 'Mina', role: 'Archivist', personality: 'Careful and curious.' };
const quietDocument = f => { f.context.document = { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], createElement: () => ({ style: {}, classList: { add() {}, remove() {}, toggle() {} }, setAttribute() {}, append() {} }), body: { append() {} } }; };
const draft = (extra = {}) => JSON.stringify({ personaName: 'Mina', personaPrompt: 'FULL PROMPT', personaSpec: spec, personaVariants: { full: 'FULL PROMPT', standard: '', compact: '' }, ...extra });

test('choosing Standard generates it once and reuses it afterwards', async t => {
  const f = await createFixture('official', { transformSource: expose }); t.after(() => f.dispose());
  quietDocument(f);
  f.context.__compileResult = { standard: 'STANDARD PROMPT', compact: 'COMPACT PROMPT' };
  f.runtime.auditSetDraft(draft());
  const first = await f.runtime.auditDensity('standard');
  assert.equal(first.personaPrompt, 'STANDARD PROMPT');
  assert.equal(f.context.__compileCalls, 1);
  assert.equal((await f.runtime.auditDensity('compact')).personaPrompt, 'COMPACT PROMPT');
  assert.equal((await f.runtime.auditDensity('full')).personaPrompt, 'FULL PROMPT');
  assert.equal(f.context.__compileCalls, 1, 'an already generated density calls no model');
});

test('a failed generation leaves the draft as it was and can be retried', async t => {
  const f = await createFixture('official', { transformSource: expose }); t.after(() => f.dispose());
  quietDocument(f);
  f.context.__compileResult = { standard: '', compact: '' };
  const before = draft(); f.runtime.auditSetDraft(before);
  await assert.rejects(f.runtime.auditDensity('compact'), /컴파일 결과/);
  assert.equal(f.runtime.auditDraft(), before);
  f.context.__compileResult = { standard: 'S', compact: 'C' };
  assert.equal((await f.runtime.auditDensity('compact')).personaPrompt, 'C');
});

test('the lore selection panel shows what was chosen and escapes lore text', async t => {
  const f = await createFixture('official', { transformSource: expose }); t.after(() => f.dispose());
  const html = f.runtime.auditRerank({ loreCandidates: [1, 2], worldLoreRerank: { selectedCount: 1, protectedCount: 0, selected: [{ label: '<b>항구</b>', rerankDecision: 'selected', rerankScore: 0.5, rerankReasons: ['직접 언급'] }], rejected: [] }, personaLoreRerank: { selected: [], rejected: [] } });
  assert.match(html, /후보 2개/); assert.match(html, /채택 · 50/); assert.match(html, /직접 언급/);
  assert.doesNotMatch(html, /<b>항구<\/b>/); assert.match(html, /평가할 로어가 없습니다/);
});

test('image data is removed once and nothing else is touched', async t => {
  const f = await createFixture('official', { transformSource: expose }); t.after(() => f.dispose());
  const keep = { dynamicPersonaLorebookGeneratorResultVault: '{"version":1,"items":[{"id":"keep"}]}', liaPersonaLinkerWorldBlueprintVaultV1: '{"version":1,"items":[]}', liaPersonaRequestProofV1: '{"proofs":{}}', dynamicPersonaLorebookGeneratorLLMConfig: '{"model":"m"}', liaPersonaLoreCharLimitV1: '2300', 'hayaku.v2.ledger.a': '{}' };
  f.values.delete('liaRetiredImageDataPurgedV1');
  for (const [key, value] of Object.entries(keep)) f.values.set(key, value);
  const seed = () => { f.values.set('liaPersonaVisualAssetStoreV1', '{"sets":{}}'); f.values.set('liaPersonaVisualAssetPresetStoreV1', '{"items":[]}'); f.values.set('liaPersonaIllustrationConfigV1', '{"key":"x"}'); f.values.set('liaPersonaVisualAssetBlobV1::a::manifest', '{}'); f.values.set('liaPersonaVisualAssetBlobV1::a::chunk::0', 'AAAA'); };
  seed();
  const personas = JSON.stringify(f.db.personas);
  assert.equal(await f.runtime.auditPurge(), true);
  assert.deepEqual([...f.values.keys()].filter(key => /VisualAsset|Illustration/.test(key)), []);
  for (const [key, value] of Object.entries(keep)) assert.equal(f.values.get(key), value, key);
  assert.equal(JSON.stringify(f.db.personas), personas, 'personas are untouched');
  seed();
  assert.equal(await f.runtime.auditPurge(), false, 'runs once');
  assert.ok(f.values.has('liaPersonaVisualAssetStoreV1'));
});

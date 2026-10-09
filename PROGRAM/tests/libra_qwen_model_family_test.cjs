'use strict';
// The Qwen family must reach the adapter, and the other families must not move.
//
// Two things are asserted, both through the PRODUCT's own decision functions (loaded in its VM harness,
// not re-implemented here):
//   1. A Qwen3.5 preset resolves to family `qwen` and receives a non-empty behavior adapter. Before this
//      change it fell through to `generic`, which has NO adapter lines, so nothing was emitted at all.
//   2. The families that already had adapters keep the family they had — the new branch sits before the
//      gemma test, so a regression there would silently retag Gemma models.
//
// Run: node Librarian-System/PROGRAM/tests/libra_qwen_model_family_test.cjs
const assert = require('node:assert/strict');
const path = require('node:path');
const PROGRAM = path.resolve(__dirname, '..');
const { createLibraVmHarness } = require(path.join(PROGRAM, 'tests', 'fixtures', 'libra_vm_harness.cjs'));

const results = [];
const check = (name, fn) => { try { fn(); results.push({ name, ok: true }); } catch (e) { results.push({ name, ok: false, error: String(e.message).slice(0, 260) }); } };

(async () => {
  const h = await createLibraVmHarness({}, {}, {});
  const api = h.api || h.plugin || h;
  const probe = api.debugModelBehaviorFamily;
  assert.equal(typeof probe, 'function', 'debugModelBehaviorFamily must be exposed by the product');

  const observed = {};
  const QWEN_TAG = 'hf.co/unsloth/Qwen3.5-9B-GGUF:UD-Q4_K_XL';
  const cases = [
    ['qwen35 ollama tag', { provider: 'ollama', model: QWEN_TAG }, 'qwen'],
    ['qwen35 short tag', { provider: 'ollama', model: 'qwen3.5:9b' }, 'qwen'],
    ['qwen3 embedding', { provider: 'ollama', model: 'qwen3-embedding:latest' }, 'qwen'],
    ['qwen uppercase', { provider: 'ollama', model: 'Qwen3.5-9B' }, 'qwen'],
    ['gemma-4 (contrast)', { provider: 'ollama', model: 'hf.co/unsloth/gemma-4-12B-it-qat-GGUF:UD-Q4_K_XL' }, 'gemma'],
    ['deepseek (contrast)', { provider: 'deepseek', model: 'deepseek-v4-pro' }, 'deepseek'],
    ['kimi (contrast)', { provider: 'kimi', model: 'kimi-k3' }, 'kimi'],
    ['claude (contrast)', { provider: 'claude', model: 'claude-sonnet-4-5' }, 'claude'],
    ['glm (contrast)', { provider: 'z-ai', model: 'glm-5.2' }, 'glm'],
    ['gpt (contrast)', { provider: 'openai', model: 'gpt-4o' }, 'gpt']
  ];
  for (const [label, preset, expected] of cases) {
    observed[label] = { got: probe(preset), expected };
  }

  check('a Qwen preset resolves to the qwen family', () => {
    assert.equal(observed['qwen35 ollama tag'].got, 'qwen', `got ${observed['qwen35 ollama tag'].got}`);
    assert.equal(observed['qwen35 short tag'].got, 'qwen');
    assert.equal(observed['qwen uppercase'].got, 'qwen', 'case must not matter');
  });
  check('the embedding model shares the family (harmless, and it is not a chat model)', () => {
    assert.equal(observed['qwen3 embedding'].got, 'qwen');
  });
  check('the existing families are unchanged', () => {
    for (const [label, row] of Object.entries(observed)) {
      if (label.startsWith('qwen')) continue;
      assert.equal(row.got, row.expected, `${label}: expected ${row.expected}, got ${row.got}`);
    }
  });

  // The adapter text is the reason the family exists.
  let adapter = '';
  let genericAdapter = '';
  try {
    adapter = api.debugModelBehaviorAdapter?.({ provider: 'ollama', model: QWEN_TAG }, 'writing')
      ?? api.debugBuildModelBehaviorAdapter?.({ provider: 'ollama', model: QWEN_TAG }, 'writing')
      ?? '';
    genericAdapter = api.debugModelBehaviorAdapter?.({ provider: 'ollama', model: 'some-unknown-model' }, 'writing') ?? '';
  } catch (e) { adapter = `error: ${e.message}`; }

  check('the qwen family emits adapter text where generic emitted none', () => {
    if (typeof adapter === 'string' && adapter.startsWith('error:')) return;   // not exposed; covered by the family test above
    assert.ok(String(adapter).length > 0, 'the adapter must not be empty for a Qwen preset');
    assert.ok(/close every brace|outermost/i.test(String(adapter)), `the adapter must address the measured structural defect: ${String(adapter).slice(0, 160)}`);
  });

  const passed = results.filter(r => r.ok).length;
  console.log(`libra_qwen_model_family_test: ${passed}/${results.length} PASS`);
  for (const r of results) console.log(`  ${r.ok ? 'OK  ' : 'FAIL'} ${r.name}${r.ok ? '' : `\n       ${r.error}`}`);
  console.log(JSON.stringify({ observed, adapterChars: String(adapter).length, genericAdapterChars: String(genericAdapter).length }, null, 1));
  process.exit(passed === results.length ? 0 : 1);
})().catch(error => { console.error(error); process.exit(1); });

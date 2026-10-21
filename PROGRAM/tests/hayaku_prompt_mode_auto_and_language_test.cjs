'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHayakuRuntime } = require('./fixtures/hayaku_runtime_harness.cjs');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'plugins', 'HAYAKU_Locator_Continuity.js'), 'utf8');

const version=source.match(/^\/\/@version (\d+\.\d+\.\d+)\s*$/m)?.[1];
assert.ok(version, 'plugin must declare a semantic version');
assert.ok(source.includes(`const PLUGIN_VERSION = '${version}';`), 'header and runtime versions must agree');
assert.match(source, /\/\/@arg hayaku_memory_language string ko\|en\|ja\|zh\|source; blank uses source/);
// The approved mockup Settings page (5e1db38) replaced the old long-form option
// copy with short descriptions plus a friendly value-label map; the Auto policy
// itself is verified at runtime below.
assert.match(source, /hayaku_prompt_mode: \{ auto: '자동', balanced: '균형 · 핵심 지시', full: '전체 · 상세 지시' \}/);
assert.match(source, /<span class="argtag">hayaku_prompt_mode<\/span><\/div><select class="select"[^>]*><option>auto<\/option><option>balanced<\/option><option>full<\/option><\/select>/);
assert.match(source, /hayaku_memory_language: \{ source: '대화 원문 언어', ko: '한국어', en: '영어', ja: '일본어', zh: '중국어' \}/);
assert.match(source, /대화 원문 언어를 고르면 완료된 대화의 언어를 따릅니다\.<\/div><span class="argtag">hayaku_memory_language<\/span><\/div><select class="select"[^>]*><option>source<\/option>/);
assert.match(source, /<b>비용 안내<\/b> · 자동 복구는 Other Ax를 호출해 Provider 비용이 발생할 수 있습니다\./);
assert.match(source, /hayaku_cold_start_batch_turns: \{ 1: '1턴씩', 5: '5턴씩', 10: '10턴씩' \}/);

(async () => {
  const runtime = await createHayakuRuntime({ autoRepair: false });
  try {
    const test = runtime.hayaku._test;
    assert.equal(runtime.hayaku.settings().memoryLanguage, 'source', 'blank memory language must default to source');
    assert.equal(runtime.hayaku.settingsControl.defaults().hayaku_memory_language, 'source');

    const deepWithRoom = test.resolveInjectionMode('auto', [{ role: 'user', data: 'short prompt' }], null, {
      effectiveMode: 'deep'
    });
    assert.equal(deepWithRoom.mode, 'full');
    assert.equal(deepWithRoom.reason, 'auto_deep_with_headroom');

    const highPressure = test.resolveInjectionMode('auto', [{ role: 'user', data: 'x'.repeat(110000) }], null, {
      effectiveMode: 'deep'
    });
    assert.equal(highPressure.mode, 'balanced');
    assert.equal(highPressure.reason, 'auto_high_pressure_balanced');

    const ordinary = test.resolveInjectionMode('auto', [{ role: 'user', data: 'ordinary prompt' }], null, {
      effectiveMode: 'balanced'
    });
    assert.equal(ordinary.mode, 'balanced');
    assert.equal(ordinary.reason, 'auto_default_balanced');

    const constrainedHost = test.resolveInjectionMode('auto', [{ role: 'user', data: 'short prompt' }], {
      maxContext: 4096,
      maxResponse: 1024
    }, {
      effectiveMode: 'deep'
    });
    assert.equal(constrainedHost.mode, 'balanced');
    assert.equal(constrainedHost.reason, 'auto_insufficient_full_headroom_balanced');

    const explicitFull = test.resolveInjectionMode('full', [{ role: 'user', data: 'x'.repeat(110000) }], null, {
      effectiveMode: 'balanced'
    });
    assert.equal(explicitFull.mode, 'full', 'explicit Full remains a user override');
    assert.equal(explicitFull.automatic, false);

    const sourceInstruction = test.packetMemoryLanguageInstruction({ memoryLanguage: 'source' });
    assert.match(sourceInstruction, /language of the completed text and established story facts/);
    const koreanInstruction = test.packetMemoryLanguageInstruction({ memoryLanguage: 'ko' });
    assert.match(koreanInstruction, /Write summaries and descriptions in Korean/);
    assert.match(koreanInstruction, /quotes verbatim in their source language/);

    for (const phrase of ['열쇠', 'key', '鍵', '钥匙']) {
      assert.equal(test.crossLingualTokensForText(phrase).length, 0, 'ordinary words must not acquire dictionary-defined meaning');
    }
    assert.ok(test.crossLingualTokensForText('object:key').includes('object:key'), 'explicit legacy anchors remain readable');

    process.stdout.write('hayaku_prompt_mode_auto_and_language_test: PASS\n');
  } finally {
    await runtime.dispose();
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

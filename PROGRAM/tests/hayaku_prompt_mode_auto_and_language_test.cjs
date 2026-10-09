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
assert.match(source, /Auto는 Deep·정밀 복구 신호와 충분한 컨텍스트 여유가 함께 있을 때 Full, 그 외에는 Balanced/);
assert.match(source, /대화 원문 자동 · 다국어 권장/);
assert.match(source, /Other Ax 호출 시 RisuAI에 설정된 Provider 비용이 발생할 수 있습니다/);
assert.match(source, /5턴 · 속도 권장/);

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

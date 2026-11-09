'use strict';
// 디버그 export 는 "NSFW 지침/비앙카 투입이 실제로 프롬프트에 들어갔는지" 를 답할 수 있어야 한다.
// 2026-11-09 로그에는 설정도 프롬프트 블록 자수도 없어서 판정이 불가능했다.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { gradia } = require('../fixtures/companion_gui_fixture.cjs');

const expose = source => source.replace(
  "    async debugNavigateGui(section = 'overview', tab = 'flow') {",
  "    __testRuntime: Runtime,\n    __testDraftBlocks: settings => defaultFullDraftCreativeInstructions('shadow_act', null, null, settings, null, ''),\n    async debugNavigateGui(section = 'overview', tab = 'flow') {");

test('the export records which prompt blocks were included', async () => {
  const f = await gradia({ transformSource: expose });
  try {
    const runtime = f.plugin.__testRuntime;
    const on = f.plugin.__testDraftBlocks({ nsfwMode: 'explicit', nsfwGuidanceEnabled: true, biancaInject: true });
    assert.ok(on.includes('NSFW GUIDANCE — EXPLICIT'), '본문에 지침이 들어간다');
    const record = runtime.promptBlocks.shadow_act;
    assert.equal(record.nsfwMode, 'explicit');
    assert.equal(record.biancaInject, true);
    assert.ok(record.chars.nsfwGuidance > 1000, `NSFW 지침 자수: ${record.chars.nsfwGuidance}`);
    assert.ok(record.chars.biancaInjection > 10000, `비앙카 자수: ${record.chars.biancaInjection}`);

    f.plugin.__testDraftBlocks({ nsfwMode: 'off', biancaInject: false });
    const off = runtime.promptBlocks.shadow_act;
    assert.equal(off.nsfwMode, 'off');
    assert.equal(off.biancaInject, false);
    assert.equal(off.chars.nsfwGuidance, 0);
    assert.equal(off.chars.biancaInjection, 0);
    assert.ok(off.chars.stylePack > 0, '켜진 다른 블록은 그대로 남는다');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

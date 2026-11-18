'use strict';
// RisuAI 작가의 노트는 SHADOW ACT만이 아니라 모든 초안 단계(AIDE 포함)와 인풋 관리자에
// 유저 입력 다음 권위로 직접 적용된다. SHADOW 참조 설정의 작가의 노트 스위치가 전체 스위치다.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { gradia } = require('../fixtures/companion_gui_fixture.cjs');

const expose = source => source.replace(
  "    async debugNavigateGui(section = 'overview', tab = 'flow') {",
  [
    '    __testDraftBlocks: (stage, recent, settings) => defaultFullDraftCreativeInstructions(stage, recent, null, settings, null, \'\'),',
    '    __testRouted: (stage, refs, settings) => authorNoteRoutedToStage(stage, refs, settings),',
    '    __testInputAssistBlock: note => buildInputAssistAuthorNoteBlock(note, {}),',
    "    async debugNavigateGui(section = 'overview', tab = 'flow') {"
  ].join('\n'));

const NOTE = '필수: 비가 내린다. 금지: 세라는 울지 않는다.';

test('every draft stage receives the Author Note as second authority', async () => {
  const f = await gradia({ transformSource: expose });
  try {
    for (const stage of ['shadow_act', 'aide_character', 'aide_world', 'aide_plot']) {
      const routed = f.plugin.debugAuthorNoteStageRouting(NOTE, stage, true);
      assert.equal(routed.meta.routedToStage, stage);
      assert.ok(routed.block.includes(NOTE), `${stage} 블록에 노트가 들어간다`);
      const prompt = f.plugin.__testDraftBlocks(stage, { authorNote: NOTE }, {});
      assert.ok(prompt.includes(`applies_to="${stage}"`), `${stage} 작성 프롬프트에 노트 권위 블록`);
      assert.ok(prompt.includes(NOTE));
    }
    const aide = f.plugin.__testDraftBlocks('aide_plot', { authorNote: NOTE }, {});
    assert.ok(aide.includes('repair that violation'), 'AIDE는 노트 위반을 복구한다');
    const off = f.plugin.debugAuthorNoteStageRouting(NOTE, 'aide_plot', false);
    assert.equal(off.block, '');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('the SHADOW switch gates every stage and non-draft stages never receive it', async () => {
  const f = await gradia({ transformSource: expose });
  try {
    assert.equal(f.plugin.__testRouted('aide_world', { authorNote: false }, {}), true, 'AIDE 자체 참조값과 무관');
    const shadowOff = { stageOptions: { shadow_act: { risu_refs: { authorNote: false } } } };
    assert.equal(f.plugin.__testRouted('aide_world', {}, shadowOff), false);
    assert.equal(f.plugin.__testRouted('shadow_act', { authorNote: false }, {}), false);
    assert.equal(f.plugin.__testRouted('arc_director', { authorNote: true }, {}), false);
    const block = f.plugin.__testInputAssistBlock(NOTE);
    assert.ok(block.includes('applies_to="input_assist"') && block.includes(NOTE));
    assert.equal(f.plugin.__testInputAssistBlock('   '), '');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

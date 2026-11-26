'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture, wait } = require('../fixtures/gradia_input_writer_unified_fixture.cjs');

const asReq = rows => rows.map(row => ({
  role: row.role === 'char' ? 'assistant' : row.role,
  content: row.data,
  chatId: row.chatId,
  messageId: row.chatId
}));

const setupShadowPipeline = async (f, getSeq) => {
  await f.host.plugin.saveRuntimeSettings({
    ...await f.host.plugin.getRuntimeSettings(),
    mode: 'normal',
    writing_mode: 'rp',
    multi_pipeline_mode: 'lightweight',
    enable_shadow_act: true,
    enable_character_aide: false,
    enable_world_aide: false,
    enable_plot_aide: false,
    failure_mode: 'hard',
    lore_activation_mode: 'off'
  });

  f.controls.evidenceText = 'EVIDENCE_SENTINEL 준호가 은빛 열쇠를 보관한다.';
  f.controls.onModel = (_idx, body) => {
    const sys = body.messages?.filter(m => m.role === 'system').map(m => m.content).join('\n') || '';
    const user = body.messages?.find(m => m.role === 'user')?.content || '';
    if (sys.includes('serial_gradation_agents_for_rp_analysis_') || sys.includes('Run shadow_act analysis now')) {
      const stage = (sys.match(/Run (\w+) analysis now/) || user.match(/STAGE: (\w+)/) || [])[1] || 'shadow_act';
      f.controls.output = JSON.stringify({
        schema: 'serial_gradation_agents_for_rp_analysis_v4',
        stage,
        ok: true,
        analysis: { summary: 'Preserve current scene', constraints: [], risks: [] },
        domain: {},
        rewrite_directives: ['Continue current scene.']
      });
    } else if (sys.includes('serial_gradation_agents_for_rp_draft_patch_v1')) {
      f.controls.output = JSON.stringify({
        schema: 'serial_gradation_agents_for_rp_draft_patch_v1',
        stage: 'shadow_act',
        ok: true,
        analysis: { summary: 'No changes', constraints: [], risks: [] },
        domain: {},
        edits: []
      });
    } else {
      f.controls.output = `DERIVED_DRAFT_SENTINEL 민아가 조용히 창밖을 바라보았다. (초안 #${getSeq()})`;
    }
  };
};

const clickModalDecision = async (document, decision) => {
  const dialog = await wait(() => document.querySelector('[data-draft-checkpoint-dialog]'), `draft checkpoint modal (${decision})`);
  const btn = dialog.querySelector(`[data-draft-checkpoint-decision="${decision}"]`);
  assert.ok(btn, `decision button ${decision} exists`);
  const text = dialog.textContent || '';
  btn.click();
  return text;
};

test('1) LIB-enabled reroll & rollback prompt user via session-only checkpoint without leaking evidence/draft', async t => {
  const f = await fixture(t, { writingMode: 'rp', unified: true });
  let draftSeq = 1;
  await setupShadowPipeline(f, () => draftSeq);

  // Turn 1
  f.chat.message = [{ role: 'user', chatId: 'u1', data: '민아의 손을 잡는다.' }];
  const out1 = await f.host.hooks.beforeRequest(asReq(f.chat.message), 'model');
  const inj1 = out1.map(m => String(m.content || '')).join('\n');
  assert.ok(inj1.includes('GRADIA_LIB_EVIDENCE_NO_REUSE_V1'), 'external evidence handoff delivered');
  assert.ok(inj1.includes('초안 #1'), 'initial draft #1 included in injection');

  // Strict non-persistence & redaction checks
  assert.equal(f.values.get('serial_gradation_agents_for_rp:draft_checkpoints:v1'), undefined, 'disk checkpoint store untouched');
  assert.doesNotMatch(JSON.stringify([...f.values]), /EVIDENCE_SENTINEL|DERIVED_DRAFT_SENTINEL/);
  assert.doesNotMatch(JSON.stringify(f.host.plugin.getRuntime()), /EVIDENCE_SENTINEL|DERIVED_DRAFT_SENTINEL/);
  assert.equal(f.host.plugin.getRuntime().draftCheckpoint?.sessionOnly, true);
  assert.equal(f.host.plugin.getRuntime().draftCheckpoint?.stores, 1);

  await f.host.hooks.afterRequest('민아가 조용히 고개를 끄덕였다.', 'model');

  // Reroll Turn 1 -> prompt opens -> click "예" (reuse)
  const promptsBeforeReroll = f.prompts.length;
  const [outReroll, modalTextReroll] = await Promise.all([
    f.host.hooks.beforeRequest(asReq(f.chat.message), 'model'),
    clickModalDecision(f.document, 'reuse')
  ]);
  assert.match(modalTextReroll, /세션 메모리 보관 \(LIB 기억 반영\)/, 'modal shows session-only LIB cue');
  assert.match(modalTextReroll, /초안 #1/, 'modal shows draft #1 preview');
  assert.equal(f.prompts.length, promptsBeforeReroll, 'reuse runs 0 additional model calls');
  const injReroll = outReroll.map(m => String(m.content || '')).join('\n');
  assert.ok(injReroll.includes('GRADIA_LIB_EVIDENCE_NO_REUSE_V1'), 'reused handoff retains no-reuse marker');
  assert.ok(injReroll.includes('초안 #1'), 'reused handoff delivers draft #1');
  assert.equal(f.host.plugin.getRuntime().last?.reason, 'draft_checkpoint_reused');
  assert.equal(f.host.plugin.getRuntime().last?.externalEvidence, true);
  assert.doesNotMatch(JSON.stringify([...f.values]), /EVIDENCE_SENTINEL|DERIVED_DRAFT_SENTINEL/);
  assert.doesNotMatch(JSON.stringify(f.host.plugin.getRuntime()), /EVIDENCE_SENTINEL|DERIVED_DRAFT_SENTINEL/);

  // Complete Turn 1 and advance to Turn 2
  await f.host.hooks.afterRequest('민아가 손을 마주 잡았다.', 'model');
  f.chat.message.push(
    { role: 'char', chatId: 'a1', data: '민아가 손을 마주 잡았다.' },
    { role: 'user', chatId: 'u2', data: '창밖을 바라본다.' }
  );
  await f.host.hooks.beforeRequest(asReq(f.chat.message), 'model');
  await f.host.hooks.afterRequest('창밖에는 비가 내렸다.', 'model');

  // Roll back to Turn 1 (even with changed system/lore block & new chatId) -> prompt opens -> "예"
  f.chat.message = [{ role: 'user', chatId: 'u1-rollback', data: '민아의 손을 잡는다.' }];
  const reqWithChangedSystem = [{ role: 'system', content: '동적으로 변경된 로어/시스템 블록' }, ...asReq(f.chat.message)];
  const promptsBeforeRollback = f.prompts.length;
  const [outRollback, modalTextRollback] = await Promise.all([
    f.host.hooks.beforeRequest(reqWithChangedSystem, 'model'),
    clickModalDecision(f.document, 'reuse')
  ]);
  assert.match(modalTextRollback, /세션 메모리 보관 \(LIB 기억 반영\)/);
  assert.equal(f.prompts.length, promptsBeforeRollback, 'rollback reuse runs 0 additional model calls');
  assert.equal(f.host.plugin.getRuntime().draftCheckpoint?.matchKind, 'stable_turn');
  assert.ok(outRollback.map(m => String(m.content || '')).join('\n').includes('초안 #1'));

  // Host retry protection remains strict for already-injected messages
  await assert.rejects(
    () => f.host.hooks.beforeRequest(outRollback, 'model'),
    e => e.code === 'LIB_READ_RETRY_DISABLED'
  );

  // Reroll -> click "아니오" (regenerate) -> generates draft #2 -> subsequent reroll prompts with draft #2
  await f.host.hooks.afterRequest('민아가 다시 웃었다.', 'model');
  draftSeq = 2;
  const promptsBeforeRegen = f.prompts.length;
  const [outRegen, modalTextRegen] = await Promise.all([
    f.host.hooks.beforeRequest(asReq(f.chat.message), 'model'),
    clickModalDecision(f.document, 'regenerate')
  ]);
  assert.match(modalTextRegen, /초안 #1/);
  assert.ok(f.prompts.length > promptsBeforeRegen, 'regenerate runs pipeline for a new draft');
  assert.ok(outRegen.map(m => String(m.content || '')).join('\n').includes('초안 #2'));

  await f.host.hooks.afterRequest('민아가 고개를 숙였다.', 'model');
  const promptsBeforeSecondReuse = f.prompts.length;
  const [outSecondReuse, modalTextSecond] = await Promise.all([
    f.host.hooks.beforeRequest(asReq(f.chat.message), 'model'),
    clickModalDecision(f.document, 'reuse')
  ]);
  assert.match(modalTextSecond, /초안 #2/, 'subsequent prompt offers newly generated draft #2');
  assert.equal(f.prompts.length, promptsBeforeSecondReuse);
  assert.ok(outSecondReuse.map(m => String(m.content || '')).join('\n').includes('초안 #2'));
  assert.doesNotMatch(JSON.stringify([...f.values]), /EVIDENCE_SENTINEL|DERIVED_DRAFT_SENTINEL/);
  assert.doesNotMatch(JSON.stringify(f.host.plugin.getRuntime()), /EVIDENCE_SENTINEL|DERIVED_DRAFT_SENTINEL/);
});

test('2) clearDraftCheckpoints() and LIB disconnect purge session evidence checkpoints', async t => {
  const f = await fixture(t, { writingMode: 'rp', unified: true });
  let draftSeq = 1;
  await setupShadowPipeline(f, () => draftSeq);

  f.chat.message = [{ role: 'user', chatId: 'u1', data: '민아의 손을 잡는다.' }];
  await f.host.hooks.beforeRequest(asReq(f.chat.message), 'model');
  await f.host.hooks.afterRequest('응답 1', 'model');

  // clearDraftCheckpoints wipes session evidence checkpoint too
  await f.host.plugin.clearDraftCheckpoints();
  draftSeq = 2;
  const promptsBeforeClearReroll = f.prompts.length;
  const outAfterClear = await f.host.hooks.beforeRequest(asReq(f.chat.message), 'model');
  assert.ok(f.prompts.length > promptsBeforeClearReroll, 'no prompt after clearDraftCheckpoints(); regenerates fresh');
  assert.ok(outAfterClear.map(m => String(m.content || '')).join('\n').includes('초안 #2'));
  await f.host.hooks.afterRequest('응답 2', 'model');

  // Disconnecting LIB purges session evidence checkpoints even if reconnected later
  const url = f.host.plugin.getLibReadOnlyStatus().connection.url;
  await f.host.plugin.unbindLibReadOnlyClient();
  await f.host.plugin.connectLibReadOnly(url);
  draftSeq = 3;
  const promptsBeforeReconnectReroll = f.prompts.length;
  const outAfterReconnect = await f.host.hooks.beforeRequest(asReq(f.chat.message), 'model');
  assert.ok(f.prompts.length > promptsBeforeReconnectReroll, 'session checkpoint stayed cleared across LIB disconnect/reconnect');
  assert.ok(outAfterReconnect.map(m => String(m.content || '')).join('\n').includes('초안 #3'));
});

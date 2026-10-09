'use strict';

// A denied or partial RisuAI database read must never masquerade as an empty Persona list.
const assert = require('node:assert/strict');
const { createFixture } = require('./fixtures/lia_native_runtime_fixture.cjs');

const expose = source => source.replace(
  '      getLiveSyncCaptureState:',
  `      auditGetContext: async () => await getContext(),
      auditRenderPersonaSidePanel: ctx => renderPersonaSidePanel(ctx),
      auditRenderPersonaSelect: ctx => renderPersonaSelect(ctx),
      auditRenderLivePersonaOptions: ctx => renderLivePersonaOptions(ctx),
      auditRenderPreview: ctx => renderPreview(ctx, {skipCapture:true}),
      getLiveSyncCaptureState:`
);

const FAILURE_COPY = 'RisuAI Persona 목록을 읽지 못했습니다.';
const RETRY_COPY = 'Database 접근 권한 동의를 확인한 뒤 ↻ 새로고침으로 다시 시도하세요.';

(async () => {
  const fixture = await createFixture('official', { transformSource: expose });
  try {
    const readAndRender = async result => {
      fixture.api.getDatabase = async () => {
        if (result instanceof Error) throw result;
        return result;
      };
      const ctx = await fixture.runtime.auditGetContext();
      return {
        ctx,
        panel: fixture.runtime.auditRenderPersonaSidePanel(ctx),
        personaSelect: fixture.runtime.auditRenderPersonaSelect(ctx),
        livePersonaSelect: fixture.runtime.auditRenderLivePersonaOptions(ctx),
        preview: fixture.runtime.auditRenderPreview(ctx),
      };
    };

    // RisuAI returns null when database access has not been granted.
    const denied = await readAndRender(null);
    assert.match(denied.panel, new RegExp(FAILURE_COPY));
    assert.match(denied.panel, new RegExp(RETRY_COPY));
    assert.doesNotMatch(denied.panel, /RisuAI에 저장된 Persona가 없습니다\./);
    assert.match(denied.personaSelect, new RegExp(FAILURE_COPY));
    assert.match(denied.personaSelect, new RegExp(RETRY_COPY));
    assert.match(denied.personaSelect, /disabled/);
    assert.match(denied.livePersonaSelect, new RegExp(FAILURE_COPY));
    assert.match(denied.livePersonaSelect, new RegExp(RETRY_COPY));
    assert.match(denied.preview, /<select id="dpg-source-persona" disabled>/);
    assert.match(denied.preview, /id="dpg-live-persona-select" disabled/);
    assert.match(denied.preview, new RegExp(FAILURE_COPY));
    assert.equal(denied.ctx.personaDatabaseReadStatus?.available, false);
    assert.doesNotMatch(denied.panel, /저장 가능한 personaPrompt 없음/);

    // A complete, genuinely empty host database keeps the existing empty-list UI.
    const empty = await readAndRender({ personas: [], selectedPersona: '' });
    assert.equal(empty.ctx.personaDatabaseReadStatus?.available, true);
    assert.match(empty.panel, /RisuAI에 저장된 Persona가 없습니다\./);
    assert.doesNotMatch(empty.panel, new RegExp(FAILURE_COPY));
    assert.match(empty.livePersonaSelect, /사용 가능한 Persona 없음/);
    assert.match(empty.personaSelect, /Auto - /);
    assert.doesNotMatch(empty.personaSelect, new RegExp(FAILURE_COPY));

    const emptyMinusOne = await readAndRender({ personas: [], selectedPersona: -1 });
    assert.equal(emptyMinusOne.ctx.personaDatabaseReadStatus?.available, true);
    assert.match(emptyMinusOne.panel, /RisuAI에 저장된 Persona가 없습니다\./);
    assert.doesNotMatch(emptyMinusOne.panel, new RegExp(FAILURE_COPY));

    // The fixture-only empty-string sentinel is valid only for a verified empty list.
    const nonemptyEmptySelection = await readAndRender({
      personas: [{ id: 'existing-persona', name: 'Existing Persona', personaPrompt: 'must remain protected' }],
      selectedPersona: '',
    });
    assert.equal(nonemptyEmptySelection.ctx.personaDatabaseReadStatus?.available, false);
    assert.match(nonemptyEmptySelection.panel, new RegExp(FAILURE_COPY));
    assert.doesNotMatch(nonemptyEmptySelection.panel, /Existing Persona/);

    // Missing one of the requested fields is a partial read, not verified emptiness.
    const partial = await readAndRender({ personas: [] });
    assert.equal(partial.ctx.personaDatabaseReadStatus?.available, false);
    assert.match(partial.panel, new RegExp(FAILURE_COPY));
    assert.doesNotMatch(partial.panel, /RisuAI에 저장된 Persona가 없습니다\./);

    const nullSelectedIndex = await readAndRender({ personas: [], selectedPersona: null });
    assert.equal(nullSelectedIndex.ctx.personaDatabaseReadStatus?.available, false);
    assert.match(nullSelectedIndex.panel, new RegExp(FAILURE_COPY));

    // Wrong field types and rejected host reads are shown as the same safe access failure.
    const malformed = await readAndRender({ personas: 'not-an-array', selectedPersona: 0 });
    assert.equal(malformed.ctx.personaDatabaseReadStatus?.available, false);
    assert.match(malformed.panel, new RegExp(FAILURE_COPY));

    const rejected = await readAndRender(new Error('private host detail'));
    assert.equal(rejected.ctx.personaDatabaseReadStatus?.available, false);
    assert.match(rejected.panel, new RegExp(FAILURE_COPY));
    assert.match(rejected.panel, new RegExp(RETRY_COPY));
    assert.doesNotMatch(rejected.panel, /private host detail/);

    console.log('lia_persona_database_read_ui_test: PASS (verified-empty and failed-read UI states)');
  } finally {
    await fixture.dispose();
  }
})().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});

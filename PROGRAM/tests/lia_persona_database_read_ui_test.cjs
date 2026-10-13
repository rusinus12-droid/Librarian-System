'use strict';

// A denied or partial RisuAI database read must never masquerade as an empty Persona list.
const assert = require('node:assert/strict');
const { createFixture } = require('./fixtures/lia_native_runtime_fixture.cjs');

const expose = source => source.replace(
  '      getLiveSyncCaptureState:',
  `      auditGetContext: async () => await getContext(),
      auditRenderMine: ctx => {
        const slots = new Map(['#pocket','#upd-badge','#upd-dots','#upd-hint','#mine-list','#live-persona-state','.scope span:last-child','.brand__ver'].map(key => [key,{setAttribute(){}}]));
        const app = { querySelector: key => slots.get(key) || null };
        const state = renderMockupMine(ctx, app);
        return { state, list:slots.get('#mine-list').innerHTML, pocket:slots.get('#pocket').innerHTML };
      },
      auditRenderPersonaSelect: ctx => renderPersonaSelect(ctx),
      auditRenderLivePersonaOptions: ctx => renderLivePersonaOptions(ctx),
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
        mine: fixture.runtime.auditRenderMine(ctx),
        personaSelect: fixture.runtime.auditRenderPersonaSelect(ctx),
        livePersonaSelect: fixture.runtime.auditRenderLivePersonaOptions(ctx),
      };
    };

    const denied = await readAndRender(null);
    assert.match(denied.mine.list, new RegExp(FAILURE_COPY));
    assert.match(denied.mine.list, new RegExp(RETRY_COPY));
    assert.doesNotMatch(denied.mine.list, /Persona가 없습니다/);
    assert.match(denied.personaSelect, new RegExp(FAILURE_COPY));
    assert.match(denied.personaSelect, new RegExp(RETRY_COPY));
    assert.match(denied.personaSelect, /disabled/);
    assert.match(denied.livePersonaSelect, new RegExp(FAILURE_COPY));
    assert.match(denied.livePersonaSelect, new RegExp(RETRY_COPY));
    assert.equal(denied.ctx.personaDatabaseReadStatus?.available, false);

    const empty = await readAndRender({ personas: [], selectedPersona: '' });
    assert.equal(empty.ctx.personaDatabaseReadStatus?.available, true);
    assert.match(empty.mine.list, /Persona가 없습니다/);
    assert.doesNotMatch(empty.mine.list, new RegExp(FAILURE_COPY));
    assert.match(empty.livePersonaSelect, /사용 가능한 Persona 없음/);
    assert.match(empty.personaSelect, /Auto - /);
    assert.doesNotMatch(empty.personaSelect, new RegExp(FAILURE_COPY));

    const emptyMinusOne = await readAndRender({ personas: [], selectedPersona: -1 });
    assert.equal(emptyMinusOne.ctx.personaDatabaseReadStatus?.available, true);
    assert.match(emptyMinusOne.mine.list, /Persona가 없습니다/);

    const nonemptyEmptySelection = await readAndRender({
      personas: [{ id: 'existing-persona', name: 'Existing Persona', personaPrompt: 'must remain protected' }],
      selectedPersona: '',
    });
    assert.equal(nonemptyEmptySelection.ctx.personaDatabaseReadStatus?.available, false);
    assert.match(nonemptyEmptySelection.mine.list, new RegExp(FAILURE_COPY));
    assert.doesNotMatch(nonemptyEmptySelection.mine.list, /Existing Persona/);

    const partial = await readAndRender({ personas: [] });
    assert.equal(partial.ctx.personaDatabaseReadStatus?.available, false);
    assert.match(partial.mine.list, new RegExp(FAILURE_COPY));
    assert.doesNotMatch(partial.mine.list, /Persona가 없습니다/);

    const nullSelectedIndex = await readAndRender({ personas: [], selectedPersona: null });
    assert.equal(nullSelectedIndex.ctx.personaDatabaseReadStatus?.available, false);
    assert.match(nullSelectedIndex.mine.list, new RegExp(FAILURE_COPY));

    const malformed = await readAndRender({ personas: 'not-an-array', selectedPersona: 0 });
    assert.equal(malformed.ctx.personaDatabaseReadStatus?.available, false);
    assert.match(malformed.mine.list, new RegExp(FAILURE_COPY));

    const rejected = await readAndRender(new Error('private host detail'));
    assert.equal(rejected.ctx.personaDatabaseReadStatus?.available, false);
    assert.match(rejected.mine.list, new RegExp(FAILURE_COPY));
    assert.match(rejected.mine.list, new RegExp(RETRY_COPY));
    assert.doesNotMatch(rejected.mine.list, /private host detail/);

    console.log('lia_persona_database_read_ui_test: PASS (mockup mine route, verified-empty and failed-read states)');
  } finally {
    await fixture.dispose();
  }
})().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});

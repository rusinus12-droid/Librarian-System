'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { gradia, wait, sleep } = require('./fixtures/companion_gui_fixture.cjs');
const AGENTS = 'serial_gradation_agents_for_rp:agent_slots:v2';
const RUNTIME = 'serial_gradation_agents_for_rp:runtime_settings:v2';

test('GRADIA speed preset preserves stage exclusion and timeout while changing context budget', async () => {
  const f = await gradia({ storage: { [AGENTS]: JSON.stringify({ version: 3, slots: { shadow_act: { enabled: false, timeoutMs: 51000, turnWindow: 8, maxChars: 24000 } } }) } });
  try {
    await f.plugin.openSettingsGui(); await f.plugin.debugNavigateGui('quick', 'flow');
    const before = JSON.parse(f.store.get(AGENTS));
    const fast = [...f.doc.querySelectorAll('#q-quality .choice')].find(n => n.textContent.includes('빠르게'));
    assert(fast); fast.click(); await sleep(80);
    f.doc.querySelector('#savebar [data-save]').click(); await wait(() => !f.plugin.debugGuiStateInfo().dirty, 'preset save');
    const after = JSON.parse(f.store.get(AGENTS));
    assert.equal(after.slots.shadow_act.enabled, before.slots.shadow_act.enabled, 'speed choice cannot re-enable a stage');
    assert.equal(after.slots.shadow_act.timeout_ms, 51000, 'speed choice cannot reset timeout');
    assert.equal(after.slots.shadow_act.turn_window, 4); assert.equal(after.slots.shadow_act.max_chars, 48000);
    assert.equal(JSON.parse(f.store.get(RUNTIME)).settings.quick_profile, 'fast', 'independent fields must not change the selected profile to custom');
    assert.equal(f.getCalls(), 0);
  } finally { await f.close(); }
});

test('GRADIA recommendation preview names exact values, Cancel is inert, and Apply remains draft-only', async () => {
  const f = await gradia();
  try {
    await f.plugin.openSettingsGui(); await f.plugin.debugNavigateGui('skills', 'flow');
    const maximum = f.doc.querySelector('[data-skill-router-top-k]');
    assert(maximum); maximum.value = '3'; maximum.dispatchEvent(new f.w.Event('input', { bubbles: true })); maximum.dispatchEvent(new f.w.Event('change', { bubbles: true }));
    await sleep(80); f.doc.querySelector('#savebar [data-save]').click(); await wait(() => !f.plugin.debugGuiStateInfo().dirty, 'skill save');
    await f.plugin.debugNavigateGui('quick', 'flow');
    const open = () => f.doc.querySelector('[data-open="dlg-reco"]').click();
    const stored = JSON.stringify([...f.store]); open();
    const rows = [...f.doc.querySelectorAll('[data-setting-path]')];
    assert(rows.every(n => f.w.getComputedStyle(n.querySelector('strong')).display !== 'none'), 'recommendation prior values remain visible under the adopted dialog style');
    assert(rows.some(n => /Skill/.test(n.textContent) && /3/.test(n.textContent) && /2/.test(n.textContent)), 'preview discloses Skill maximum 3 to 2');
    assert(!rows.some(n => /現在|현재 값추천값/.test(n.textContent)), 'not placeholder headings');
    const layer = f.doc.querySelector('.overlay.is-open');
    [...layer.querySelectorAll('button')].find(n => n.textContent === '취소').click();
    assert.equal(JSON.stringify([...f.store]), stored); assert.equal(f.plugin.debugGuiStateInfo().dirty, false);
    open(); [...layer.querySelectorAll('button')].find(n => n.textContent === '추천값 적용').click(); await sleep(80);
    assert.equal(JSON.stringify([...f.store]), stored, 'applying preview is not a persistent write');
    assert.equal(f.plugin.debugGuiStateInfo().dirty, true);
    f.doc.querySelector('#savebar [data-revert]').click(); await wait(() => !f.plugin.debugGuiStateInfo().dirty, 'revert');
    assert.equal(JSON.stringify([...f.store]), stored); assert.equal(f.getCalls(), 0);
  } finally { await f.close(); }
});


test('GRADIA every speed/depth preset owns only context budgets and the profile marker', async () => {
  const f = await gradia();
  try {
    const beforeStages = ['shadow_act', 'aide_character', 'aide_world', 'aide_plot'];
    const runtime = { quickProfile: 'custom', multiPipelineMode: 'heavyweight', outputMode: 'risu_engine', customFlag: 'retain' };
    const agents = Object.fromEntries([...beforeStages, 'input_assist', 'arc_director'].map((id, index) => [id, {
      enabled: index % 2 === 1, timeoutMs: 51000 + index, turnWindow: 7, maxChars: 26000,
      presetName: 'custom-model-' + index, risuRefs: { authorNote: false, persona: true },
      executionMode: 'legacy-camel', execution_mode: 'legacy-snake', customOption: { keep: true }
    }]));
    for (const [id, profile] of Object.entries(f.plugin.getQuickProfiles()).filter(([id]) => id !== 'custom')) {
      const expected = structuredClone({ runtime, agents }); expected.runtime.quickProfile = id;
      for (const stage of beforeStages) { expected.agents[stage].turnWindow = profile.turnWindow; expected.agents[stage].maxChars = profile.maxChars; }
      assert.deepEqual(JSON.parse(JSON.stringify(f.plugin.debugApplyQuickProfileState(id, runtime, agents))), expected, id + ' must preserve all independent fields');
    }
    assert.equal(f.getCalls(), 0);
  } finally { await f.close(); }
});

test('GRADIA speed/depth matching ignores disabled stages and independent timeout choices', async () => {
  const f = await gradia();
  try {
    const profile = f.plugin.getQuickProfiles().fast;
    const agents = Object.fromEntries(['shadow_act', 'aide_character', 'aide_world', 'aide_plot'].map(id => [id, {
      enabled: false, timeoutMs: 51000, turnWindow: profile.turnWindow, maxChars: profile.maxChars
    }]));
    assert.equal(f.plugin.debugQuickProfileMatches('fast', { multiPipelineMode: 'heavyweight' }, agents), true);
    agents.aide_world.maxChars += 1;
    assert.equal(f.plugin.debugQuickProfileMatches('fast', {}, agents), false, 'genuinely custom context budget does not match');
    assert.equal(f.getCalls(), 0);
  } finally { await f.close(); }
});

test('GRADIA recommendation review includes exact stage inclusion and timeout changes before explicit Save', async () => {
  const f = await gradia({ storage: {
    [AGENTS]: JSON.stringify({ version: 3, slots: {
      input_assist: { enabled: true, timeoutMs: 51550, maxChars: 24000, risuRefs: { authorNote: false } },
      shadow_act: { enabled: false, timeoutMs: 51000, turnWindow: 4, maxChars: 48000 }
    } }),
    [RUNTIME]: JSON.stringify({ skill_router_top_k: 3, quick_profile: 'fast', input_assist_mode: 'user_focus', novel_input_assist_mode: 'user_focus' })
  } });
  try {
    await f.plugin.openSettingsGui(); await f.plugin.debugNavigateGui('quick', 'flow');
    const stored = JSON.stringify([...f.store]);
    f.doc.querySelector('[data-open="dlg-reco"]').click();
    const rows = [...f.doc.querySelectorAll('[data-setting-path]')];
    const row = path => rows.find(n => n.dataset.settingPath === path);
    assert(row('agents.input_assist.enabled'), 'stage inclusion has its own row');
    assert.match(row('agents.input_assist.enabled').textContent, /인풋 관리자.*켜짐.*꺼짐/);
    assert(row('agents.input_assist.timeoutMs'), 'stage timeout has its own row');
    assert.match(row('agents.input_assist.timeoutMs').textContent, /대기.*51[,.]?550.*300[,.]?000/);
    assert(!row('agents.shadow_act.enabled'), 'unchanged disabled SHADOW is not listed');
    assert(!row('agents.shadow_act.timeoutMs'), 'unchanged SHADOW timeout is not listed');
    assert.equal(JSON.stringify([...f.store]), stored, 'review cannot write settings');
    const layer = f.doc.querySelector('.overlay.is-open');
    [...layer.querySelectorAll('button')].find(n => n.textContent === '추천값 적용').click(); await sleep(80);
    assert.equal(JSON.stringify([...f.store]), stored, 'apply remains a draft');
    f.doc.querySelector('#savebar [data-save]').click(); await wait(() => !f.plugin.debugGuiStateInfo().dirty, 'recommendation save');
    const after = JSON.parse(f.store.get(AGENTS));
    assert.equal(after.slots.input_assist.enabled, false); assert.equal(after.slots.input_assist.timeout_ms, 300000);
    assert.equal(after.slots.shadow_act.enabled, false); assert.equal(after.slots.shadow_act.timeout_ms, 51000);
    assert.equal(JSON.parse(f.store.get(RUNTIME)).settings.skill_router_top_k, '2');
    f.doc.querySelector('[data-open="dlg-reco"]').click();
    assert.equal(f.doc.querySelectorAll('[data-setting-path]').length, 0, 'saved recommendations produce no spurious diff');
    assert([...f.doc.querySelector('.overlay.is-open').querySelectorAll('button')].find(n => n.textContent === '추천값 적용').disabled);
    assert.equal(f.getCalls(), 0);
  } finally { await f.close(); }
});


test('GRADIA source-injected recommendation rows safely show fallback paths and redact changed authentication values', async () => {
  const f = await gradia({ transformSource(source) {
    // Exercise future recommendation changes through the real renderer without production test hooks.
    source = source.replace('const current = guiStateSnapshot(Gui.state);', `const current = guiStateSnapshot(Gui.state);
      current.runtime.futureSettings = { 'custom.with.dot': '<b>old</b>', privateKey: 'PRIVATE_BEFORE' };
      current.runtime.backendHosting.token = 'TOKEN_BEFORE';
      current.providers.default.key = 'KEY_BEFORE';
      current.providers.default.extra_headers_json = '{"Authorization":"HEADER_BEFORE"}';`);
    return source.replace("applyQuickProfileValues('balanced', runtime, agents);\n    return state;", `applyQuickProfileValues('balanced', runtime, agents);
      runtime.futureSettings = { 'custom.with.dot': '<b>new</b>', privateKey: 'PRIVATE_AFTER' };
      runtime.backendHosting.token = 'TOKEN_AFTER';
      state.providers.default.key = 'KEY_AFTER';
      state.providers.default.extra_headers_json = '{"Authorization":"HEADER_AFTER"}';
      agents.shadow_act.presetName = 'custom-recommended-model';
      return state;`);
  } });
  try {
    await f.plugin.openSettingsGui(); await f.plugin.debugNavigateGui('quick', 'flow');
    f.doc.querySelector('[data-open="dlg-reco"]').click();
    const layer = f.doc.querySelector('.overlay.is-open');
    const rows = [...layer.querySelectorAll('[data-setting-path]')];
    const fallback = rows.find(n => n.dataset.settingPath === 'runtime.futureSettings.custom.with.dot');
    assert(fallback, 'unmapped fields retain an identifiable fallback path');
    assert.equal(fallback.children[0].textContent, 'runtime.futureSettings.custom.with.dot');
    assert.equal(fallback.children[1].textContent, '<b>old</b>');
    assert.equal(fallback.children[2].textContent, '<b>new</b>');
    assert.equal(fallback.children[1].children.length, 0, 'values are text rather than markup');
    assert.match(rows.find(n => n.dataset.settingPath === 'agents.shadow_act.presetName').textContent, /AI 프리셋.*custom-recommended-model/);
    assert.doesNotMatch(layer.innerHTML, /(?:PRIVATE|TOKEN|KEY|HEADER)_(?:BEFORE|AFTER)/);
    assert.equal(rows.filter(n => n.children[1].textContent === '비공개' && n.children[2].textContent === '비공개').length, 4);
    assert.equal(f.getCalls(), 0);
  } finally { await f.close(); }
});

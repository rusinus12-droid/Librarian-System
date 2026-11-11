'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./host.cjs');
const { fixture } = require('./evidence-bridge.test.cjs');
const { gradia, sleep } = require('../fixtures/companion_gui_fixture.cjs');

test('aidePatchOutputTokenBudget allocates reasoning headroom for reasoning models', async () => {
  const host = await load();
  const plugin = host.plugin;

  // Non-reasoning preset
  const plainPreset = { provider: 'custom', model: 'gpt-4o', max_tokens: 32000 };
  const plainBudget = plugin.debugAidePatchOutputTokenBudget({}, 'A'.repeat(3000), 32000, plainPreset);

  // Reasoning preset (e.g. DeepSeek reasoning or reasoning_effort set)
  const reasoningPreset = {
    provider: 'ollama_cloud',
    model: 'deepseek-v4.1-flash:1017-cloud',
    reasoning_effort: 'medium',
    max_tokens: 32000
  };
  const reasoningBudget = plugin.debugAidePatchOutputTokenBudget({}, 'A'.repeat(3000), 32000, reasoningPreset);

  assert.ok(plainBudget > 1800, `plain budget should fit draft: ${plainBudget}`);
  assert.ok(reasoningBudget > plainBudget, `reasoning budget (${reasoningBudget}) should exceed plain budget (${plainBudget})`);
  assert.ok(reasoningBudget >= plainBudget + 2048, `reasoning budget should include at least 2048 headroom`);
});

test('a provider length stop with empty content (reasoning token exhaustion) is retried with expanded budget', async () => {
  // Call 2 is the first AIDE patch in lightweight mode.
  // Model exhausted tokens on thinking: returns empty content with finishReason: 'length'.
  const f = await fixture({
    modelContent: (n, body, content) => n === 2 ? '' : content,
    finish: n => n === 2 ? 'length' : 'stop'
  });
  const r = await f.run();
  assert.equal(r.ok, true, `Pipeline should succeed despite initial empty length stop: ${r.reason}`);
  // Should have retried call 2 once (prompts length becomes 5 instead of 4)
  assert.equal(f.prompts.length, 5);
  const budget = b => b.max_tokens ?? b.max_completion_tokens;
  assert.ok(budget(f.prompts[2]) > budget(f.prompts[1]), 'Retry should have expanded output tokens');
  r.closeEvidence();
});

test('stage tabs in execution results display fallback badge when stage fell back', async () => {
  const expose = source => source.replace(
    "    async debugNavigateGui(section = 'overview', tab = 'flow') {",
    "    __testRuntime: Runtime,\n    async debugNavigateGui(section = 'overview', tab = 'flow') {"
  );
  const f = await gradia({ transformSource: expose });
  try {
    const runtime = f.plugin.__testRuntime;
    runtime.stageTrace = [
      { stage: 'shadow_act', ok: true, fallback: false, elapsedMs: 6200 },
      { stage: 'aide_character', ok: false, fallback: true, reason: 'aide_patch_request_failed:evidence_model_incomplete', elapsedMs: 5000 },
      { stage: 'aide_world', ok: false, fallback: true, reason: 'aide_patch_request_failed:evidence_model_incomplete', elapsedMs: 4800 },
      { stage: 'aide_plot', ok: true, fallback: false, elapsedMs: 7000 }
    ];

    await f.plugin.openSettingsGui();
    await f.plugin.debugNavigateGui('results', 'c');
    await sleep(30);

    const results = f.doc.querySelector('[data-page="results"]');
    assert.ok(results, 'results page renders');

    const shadowBadge = results.querySelector('[data-subtab="s"] .count');
    const charBadge = results.querySelector('[data-subtab="c"] .count');
    const worldBadge = results.querySelector('[data-subtab="w"] .count');
    const plotBadge = results.querySelector('[data-subtab="p"] .count');

    assert.ok(charBadge, 'character tab has badge');
    assert.equal(charBadge.hidden, false, 'character tab badge is visible');
    assert.equal(charBadge.textContent, '폴백', 'character tab badge text is 폴백');

    assert.ok(worldBadge, 'world tab has badge');
    assert.equal(worldBadge.hidden, false, 'world tab badge is visible');
    assert.equal(worldBadge.textContent, '폴백', 'world tab badge text is 폴백');

    if (shadowBadge) {
      assert.equal(shadowBadge.hidden, true, 'shadow act tab badge is hidden on success');
    }
    if (plotBadge) {
      assert.equal(plotBadge.hidden, true, 'plot tab badge is hidden on success');
    }
  } finally {
    await f.close();
  }
});

test('stage-detail pages for character, world, and plot AIDE show descriptions and fallback banners when fallen back', async () => {
  const expose = source => source.replace(
    "    async debugNavigateGui(section = 'overview', tab = 'flow') {",
    "    __testRuntime: Runtime,\n    async debugNavigateGui(section = 'overview', tab = 'flow') {"
  );
  const f = await gradia({ transformSource: expose });
  try {
    const runtime = f.plugin.__testRuntime;
    runtime.stageTrace = [
      { stage: 'shadow_act', ok: true, fallback: false, elapsedMs: 6200 },
      { stage: 'aide_character', ok: false, fallback: true, reason: 'aide_patch_request_failed:evidence_model_incomplete', elapsedMs: 5000 },
      { stage: 'aide_world', ok: false, fallback: true, reason: 'aide_patch_request_failed:evidence_model_incomplete', elapsedMs: 4800 },
      { stage: 'aide_plot', ok: false, fallback: true, reason: 'aide_patch_request_failed:evidence_model_incomplete', elapsedMs: 4500 }
    ];

    await f.plugin.openSettingsGui();
    await f.plugin.debugNavigateGui('pipeline', 'char');
    await sleep(30);

    const charDetail = f.doc.querySelector('.stage-detail[data-detail="char"]');
    assert.ok(charDetail, 'character stage detail renders');
    const charDesc = charDetail.querySelector('p.muted');
    assert.ok(charDesc, 'character stage has description');
    assert.ok(charDesc.textContent.includes('인물 정의·심리·관계'), 'character stage description text');
    const charBanner = charDetail.querySelector('.banner');
    assert.ok(charBanner, 'character stage has banner element');
    assert.equal(charBanner.hidden, false, 'character banner is visible when fallen back');
    assert.equal(charBanner.querySelector('b')?.textContent, '폴백', 'character banner title is 폴백');
    assert.equal(charBanner.querySelector('div:not(.banner__icon)>span')?.textContent, 'aide_patch_request_failed:evidence_model_incomplete', 'character banner reason');

    const worldDetail = f.doc.querySelector('.stage-detail[data-detail="world"]');
    assert.ok(worldDetail, 'world stage detail renders');
    const worldDesc = worldDetail.querySelector('p.muted');
    assert.ok(worldDesc, 'world stage has description');
    assert.ok(worldDesc.textContent.includes('장소·시간·사회적 맥락·물리 제약·세계 규칙과 연속성'), 'world stage description text');
    const worldBanner = worldDetail.querySelector('.banner');
    assert.ok(worldBanner, 'world stage has banner element');
    assert.equal(worldBanner.hidden, false, 'world banner is visible when fallen back');
    assert.equal(worldBanner.querySelector('b')?.textContent, '폴백', 'world banner title is 폴백');
    assert.equal(worldBanner.querySelector('div:not(.banner__icon)>span')?.textContent, 'aide_patch_request_failed:evidence_model_incomplete', 'world banner reason');

    const plotDetail = f.doc.querySelector('.stage-detail[data-detail="plot"]');
    assert.ok(plotDetail, 'plot stage detail renders');
    const plotDesc = plotDetail.querySelector('p.muted');
    assert.ok(plotDesc, 'plot stage has description');
    assert.ok(plotDesc.textContent.includes('현재 플롯·긴장·속도·복선·다음 턴 개방성'), 'plot stage description text');
    const plotBanner = plotDetail.querySelector('.banner');
    assert.ok(plotBanner, 'plot stage has banner element');
    assert.equal(plotBanner.hidden, false, 'plot banner is visible when fallen back');
    assert.equal(plotBanner.querySelector('b')?.textContent, '폴백', 'plot banner title is 폴백');
    assert.equal(plotBanner.querySelector('div:not(.banner__icon)>span')?.textContent, 'aide_patch_request_failed:evidence_model_incomplete', 'plot banner reason');
  } finally {
    await f.close();
  }
});

test('results page places input assist next to plot, and defaults to SHADOW ACT as first screen', async () => {
  const f = await gradia();
  try {
    await f.plugin.openSettingsGui();
    await f.plugin.debugNavigateGui('results');
    await sleep(30);

    const results = f.doc.querySelector('[data-page="results"]');
    assert.ok(results, 'results page renders');

    const tabs = [...results.querySelectorAll('[data-subtabs="rs"] [data-subtab]')];
    assert.equal(tabs.length, 5, 'five tabs in results');

    // Tab order should be: s (SHADOW ACT), c (인물), w (세계관), p (플롯), i (입력 도우미)
    const tabKeys = tabs.map(t => t.dataset.subtab);
    assert.deepEqual(tabKeys, ['s', 'c', 'w', 'p', 'i'], 'tab order: SHADOW ACT, 인물, 세계관, 플롯, 입력 도우미');

    // SHADOW ACT tab should be active by default
    assert.equal(tabs[0].getAttribute('aria-selected'), 'true', 'SHADOW ACT is selected by default');
    assert.equal(tabs[4].getAttribute('aria-selected'), 'false', '입력 도우미 is not selected by default');

    // SHADOW ACT panel should be active
    const shadowPanel = results.querySelector('[data-subpanel="s"]');
    const inputPanel = results.querySelector('[data-subpanel="i"]');
    assert.ok(shadowPanel?.classList.contains('is-active'), 'SHADOW ACT panel is active by default');
    assert.equal(inputPanel?.classList.contains('is-active'), false, '입력 도우미 panel is not active by default');

    // Clicking 입력 도우미 tab activates it
    tabs[4].click();
    await sleep(20);
    assert.equal(tabs[4].getAttribute('aria-selected'), 'true', '입력 도우미 is selected after click');
    assert.equal(tabs[0].getAttribute('aria-selected'), 'false', 'SHADOW ACT is deselected after click');
    assert.equal(inputPanel?.classList.contains('is-active'), true, '입력 도우미 panel is active after click');
    assert.equal(shadowPanel?.classList.contains('is-active'), false, 'SHADOW ACT panel is inactive after click');
  } finally {
    await f.close();
  }
});

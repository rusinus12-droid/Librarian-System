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
    assert.equal(tabs.length, 9, 'nine tabs in results');

    // Tab order follows the run: each sub-AIDE sits right after the core AIDE whose call runs it
    // (상태·정사 → 인물, 세계 동역학 → 세계관, 억결 → 플롯), then 입력 도우미.
    const tabKeys = tabs.map(t => t.dataset.subtab);
    assert.deepEqual(tabKeys, ['s', 'c', 'b', 'x', 'w', 'd', 'p', 'f', 'i'], 'tab order: SHADOW ACT, 인물, 상태, 정사, 세계관, 세계 동역학, 플롯, 억결, 입력 도우미');
    const inputTab = tabs[tabKeys.indexOf('i')];

    // SHADOW ACT tab should be active by default
    assert.equal(tabs[0].getAttribute('aria-selected'), 'true', 'SHADOW ACT is selected by default');
    assert.equal(inputTab.getAttribute('aria-selected'), 'false', '입력 도우미 is not selected by default');

    // SHADOW ACT panel should be active
    const shadowPanel = results.querySelector('[data-subpanel="s"]');
    const inputPanel = results.querySelector('[data-subpanel="i"]');
    assert.ok(shadowPanel?.classList.contains('is-active'), 'SHADOW ACT panel is active by default');
    assert.equal(inputPanel?.classList.contains('is-active'), false, '입력 도우미 panel is not active by default');

    // Clicking 입력 도우미 tab activates it
    inputTab.click();
    await sleep(20);
    assert.equal(inputTab.getAttribute('aria-selected'), 'true', '입력 도우미 is selected after click');
    assert.equal(tabs[0].getAttribute('aria-selected'), 'false', 'SHADOW ACT is deselected after click');
    assert.equal(inputPanel?.classList.contains('is-active'), true, '입력 도우미 panel is active after click');
    assert.equal(shadowPanel?.classList.contains('is-active'), false, 'SHADOW ACT panel is inactive after click');
  } finally {
    await f.close();
  }
});

test('copilot token exchange sends User-Agent, non-GPT copilot preset sends reasoning_effort, and 400 unsupported retry strips it', async () => {
  const { instrument, messages } = require('./evidence-bridge.test.cjs');
  const tokenRequests = [];
  const chatRequests = [];
  const host = await load({
    transformSource: source => instrument(source, {}),
    api: {
      nativeFetch: async (url, init) => {
        if (url === 'https://api.github.com/copilot_internal/v2/token') {
          tokenRequests.push({ url, headers: init?.headers || {} });
          return {
            ok: true,
            status: 200,
            json: async () => ({ token: 'copilot-session-token-1', expires_at: Math.floor(Date.now() / 1000) + 1800 }),
            text: async () => JSON.stringify({ token: 'copilot-session-token-1', expires_at: Math.floor(Date.now() / 1000) + 1800 })
          };
        }
        const body = JSON.parse(init.body);
        chatRequests.push({ url, headers: init?.headers || {}, body });
        const system = body.messages?.filter(m => m.role === 'system').map(m => m.content).join('\n') || '';
        const stageMatch = system.match(/Return the compact (aide_\w+) patch JSON/);
        if (stageMatch && stageMatch[1] === 'aide_character' && !chatRequests.some(r => r.rejected)) {
          chatRequests[chatRequests.length - 1].rejected = true;
          return {
            ok: false,
            status: 400,
            json: async () => ({ error: { message: 'Unsupported parameter: reasoning_effort is not supported for this model' } }),
            text: async () => JSON.stringify({ error: { message: 'Unsupported parameter: reasoning_effort is not supported for this model' } })
          };
        }
        const content = stageMatch
          ? JSON.stringify({ schema: 'serial_gradation_agents_for_rp_draft_patch_v1', stage: stageMatch[1], ok: true, domain: {}, analysis: { summary: 'Keep scene', constraints: [], risks: [] }, edits: [] })
          : 'SHADOW_DRAFT The archivist waited quietly inside the library.';
        return {
          ok: true,
          status: 200,
          json: async () => ({ choices: [{ message: { content }, finish_reason: 'stop' }] }),
          text: async () => JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }] })
        };
      }
    }
  });
  await host.hooks.beforeRequest(messages(), 'model');
  const settings = {
    ...host.plugin.getRuntime().settings,
    inputAssistMode: 'off',
    enableShadowAct: true,
    enableCharacterAide: true,
    enableWorldAide: false,
    enablePlotAide: false,
    multiPipelineMode: 'lightweight',
    mode: 'normal',
    failureMode: 'hard',
    loreActivationMode: 'off',
    stagePresetNames: {},
    defaultPresetName: 'cop',
    presets: {
      cop: {
        provider: 'copilot',
        url: 'https://api.githubcopilot.com/chat/completions',
        key: 'ghu_test_oauth_key',
        model: 'gemini-4-carbon',
        request_format: 'chat_completions',
        context_window: 128000,
        max_tokens: 16384,
        reasoning_preset: 'auto',
        timeout_ms: 5000,
        stream: false
      }
    },
    skillRouterEnabled: false
  };
  const r = await host.pipeline(messages(), 'model', settings);
  assert.equal(r.ok, true);
  assert.ok(tokenRequests.length >= 1, 'copilot token exchange must be called');
  assert.equal(tokenRequests[0].headers['User-Agent'], 'GitHubCopilotChat/0.22.0');
  assert.equal(chatRequests[0].headers.Authorization, 'Bearer copilot-session-token-1');
  assert.ok(chatRequests[0].body.reasoning_effort, 'non-GPT copilot preset must send reasoning_effort');
  const rejectedIdx = chatRequests.findIndex(entry => entry.rejected);
  assert.ok(rejectedIdx >= 0, 'rejected request observed');
  assert.ok(chatRequests[rejectedIdx].body.reasoning_effort, 'initial rejected call had reasoning_effort');
  assert.equal(chatRequests[rejectedIdx + 1].body.reasoning_effort, undefined, 'thinkingUnsupportedRetry omits reasoning_effort');
});

test('reasoning-starved partial-content length stop retries with low effort and concise nudge in native and evidence runs', async () => {
  const { instrument, messages } = require('./evidence-bridge.test.cjs');
  const crypto = require('node:crypto');
  const sha = v => crypto.createHash('sha256').update(v).digest('hex');
  const canonical = value => JSON.stringify(value, (_k, v) => v && typeof v === 'object' && !Array.isArray(v)
    ? Object.keys(v).sort().reduce((o, k) => (o[k] = v[k], o), {}) : v);

  for (const withEvidence of [false, true]) {
    const prompts = [];
    const boundary = {
      mode: 'server_only',
      modeGeneration: 7,
      scope: { characterId: 'c1', chatId: 'chat1', branchId: 'b1', personaId: 'p1', worldlineRevision: 'w1' },
      data: { instanceId: 'DATA-fixture', resetEpoch: 'reset-4' },
      nativeRevision: 'native-18',
      currentInputHash: sha('Continue the scene.'),
      recentTurnDigest: '0'.repeat(64)
    };
    const issued = new Map();
    const deps = withEvidence ? {
      digest: async v => sha(v),
      getBoundary: async () => JSON.parse(JSON.stringify(boundary)),
      assertCurrent: async packet => canonical(issued.get(packet.requestId)) === canonical(packet),
      recall: async req => {
        const content = 'EVIDENCE_LINE: The clock struck five.';
        const receipt = {
          schema: 'gradia.lib-read-receipt.v1',
          requestId: req.requestId,
          boundary: JSON.parse(JSON.stringify(boundary)),
          evidenceRevision: 'rev-1',
          completeness: 'complete',
          truncated: false,
          items: [{ id: 'libra:1', owner: 'libra', content, contentHash: sha(content), authority: 'owner_memory', eligibility: 'eligible', source: { scope: JSON.parse(JSON.stringify(boundary.scope)), sourceRevision: 'sr-1', turnIds: ['turn-u-101', 'turn-a-102'], variantId: 'generation-a-2', handle: 'h1' } }]
        };
        issued.set(req.requestId, JSON.parse(JSON.stringify(receipt)));
        return receipt;
      }
    } : undefined;

    let worldAttempts = 0;
    const host = await load({
      transformSource: source => instrument(source, {}),
      testGlobals: { crypto: crypto.webcrypto, __testDependencies: deps },
      api: {
        nativeFetch: async (url, init) => {
          if (url === 'https://api.github.com/copilot_internal/v2/token') {
            return {
              ok: true,
              status: 200,
              json: async () => ({ token: 'tok', expires_at: Math.floor(Date.now() / 1000) + 1800 }),
              text: async () => JSON.stringify({ token: 'tok', expires_at: Math.floor(Date.now() / 1000) + 1800 })
            };
          }
          const body = JSON.parse(init.body);
          prompts.push(body);
          const system = body.messages?.filter(m => m.role === 'system').map(m => m.content).join('\n') || '';
          const stageMatch = system.match(/Return the compact (aide_\w+) patch JSON/);
          if (stageMatch && stageMatch[1] === 'aide_world') {
            worldAttempts += 1;
            if (worldAttempts === 1) {
              const partial = '{"schema":"serial_gradation_agents_for_rp_draft_patch_v1","stage":"aide_world","ok":true,"scene_purpose":"' + 'x'.repeat(210);
              const payload = {
                choices: [{ message: { content: partial }, finish_reason: 'length' }],
                usage: { completion_tokens: 16384, reasoning_tokens: 16218 }
              };
              return { ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload) };
            }
          }
          const content = stageMatch
            ? JSON.stringify({ schema: 'serial_gradation_agents_for_rp_draft_patch_v1', stage: stageMatch[1], ok: true, domain: {}, analysis: { summary: 'Keep scene', constraints: [], risks: [] }, edits: [] })
            : 'SHADOW_DRAFT The archivist waited quietly inside the library.';
          const payload = { choices: [{ message: { content }, finish_reason: 'stop' }] };
          return { ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload) };
        }
      }
    });
    await host.hooks.beforeRequest(messages(), 'model');
    const settings = {
      ...host.plugin.getRuntime().settings,
      inputAssistMode: 'off',
      enableShadowAct: true,
      enableCharacterAide: false,
      enableWorldAide: true,
      enablePlotAide: false,
      multiPipelineMode: 'lightweight',
      mode: 'normal',
      failureMode: 'soft',
      loreActivationMode: 'off',
      stagePresetNames: {},
      defaultPresetName: 'cop',
      presets: {
        cop: {
          provider: 'copilot',
          url: 'https://api.githubcopilot.com/chat/completions',
          key: 'tok',
          model: 'gemini-4-carbon',
          request_format: 'chat_completions',
          context_window: 128000,
          max_tokens: 16384,
          reasoning_preset: 'auto',
          timeout_ms: 5000,
          stream: false
        }
      },
      skillRouterEnabled: false
    };
    if (withEvidence) {
      const stages = ['shadow_act', 'aide_world'];
      const input = messages();
      const selections = stages.map(stage => {
        const recent = host.buildRecent(input, { ...settings, turnWindow: settings.stageOptions?.[stage]?.turn_window || settings.turnWindow });
        const view = {
          ...Object.fromEntries(['latestUser','latestAssistantRaw','latestAssistant','terminalVisibleScene','previousTurnUser','previousTurnAssistant','previousTurnText','earlierTurnsText','completeTurnsText','sceneAnchor','previousResponseEvidence','text','visibleText'].map(k => [k, recent[k] || ''])),
          visibleMessages: recent.visibleMessages.map(m => ({ role: m.role, content: m.content }))
        };
        return { stage, turns: recent.turnEligibility.selected, viewSHA256: sha(canonical(view)) };
      });
      const refs = [...new Map(selections.flatMap(s => s.turns.flatMap(t => [t.user, ...t.assistants, t.boundary])).map(r => [JSON.stringify(r), r])).values()];
      const current = input.at(-1);
      let hash = 2166136261;
      for (let i = 0; i < current.content.length; i++) { hash ^= current.content.charCodeAt(i); hash = Math.imul(hash, 16777619); }
      hash ^= 31; hash = Math.imul(hash, 16777619);
      const currentInputRef = { messageId: current.messageId, generationId: null, speakerId: null, speakerName: null, contentHash: (hash >>> 0).toString(16).padStart(8, '0') + ':' + (current.content.length + 1) };
      const nativeReadSet = {
        schema: 'gradia.native-read-set.v1',
        currentInputRef,
        selections,
        turns: refs.map(ref => ({ ...ref, role: input.find(m => m.messageId === ref.messageId).role, contentSHA256: sha(input.find(m => m.messageId === ref.messageId).content) }))
      };
      boundary.recentTurnDigest = sha(canonical(nativeReadSet));
      boundary.currentInputHash = sha(input.at(-1).content);
    }

    const r = await host.pipeline(messages(), 'model', settings);
    try {
      assert.equal(r.ok, true, `mode withEvidence=${withEvidence} failed: ${r.reason}`);
      assert.equal(worldAttempts, 2, `withEvidence=${withEvidence}: aide_world must retry once`);
      assert.ok(r.stages.every(s => s.ok && !s.fallback), `withEvidence=${withEvidence}: no stage fallback allowed: ${JSON.stringify(r.stages)}`);
      const worldRetry = prompts.at(-1);
      assert.equal(worldRetry.reasoning_effort, 'low', `withEvidence=${withEvidence}: retry must lower reasoning_effort to low`);
      const retrySys = worldRetry.messages.filter(m => m.role === 'system').map(m => m.content).join('\n');
      assert.match(retrySys, /Keep internal reasoning very brief/, `withEvidence=${withEvidence}: retry must include concise reasoning nudge`);
    } finally {
      r.closeEvidence?.();
    }
  }
});

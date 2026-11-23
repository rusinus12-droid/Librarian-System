'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createFixture } = require('./fixtures/lia_native_runtime_fixture.cjs');
const { createColdStartGuiDocument } = require('./fixtures/hayaku_cold_start_gui_dom_fixture.cjs');
const { until } = require('./fixtures/libra_gui_memory_dom_host.cjs');
const { withReferences } = require('./fixtures/libra_retained_contract_probe.cjs');

function injectAuditBridge(source) {
  const marker = '      getScopePersonaCatalog: readLiaScopePersonaCatalog,';
  assert.equal(source.split(marker).length, 2, 'one runtime singleton bridge anchor');
  return source.replace(marker, `      debugAudit: {
        callIndependentProvider,
        parseSsePayload,
        runLLMRewrite,
        renderPersonaSpecLocally,
        createBlankPersonaDraft,
        loadRisuPersonaIntoDraft,
        exportCurrentPersonaJson,
        importPersonaJsonText,
        saveEditedResultToCurrentPersona,
        saveCurrentResultToVault,
        loadVaultResult,
        adoptPersonaFromPane,
        buildPersonaPanelState,
        resolvePersona,
        getLLMResultOverride,
        setGeneratedOutputText,
        setTranslationText,
        getTranslationText,
        getTranslationLanguage,
        getLastFailedRawOutput: () => lastFailedRawOutput,
        getPreservedAdoptionMode: () => preservedAdoptionMode,
        getUnsavedProviderDraft: () => liaUnsavedProviderDraft,
        getContext,
        writeStoredLLMConfig,
        readStoredLLMConfig,
        normalizeLLMConfig,
        setLastFailedRawOutput: (v) => { lastFailedRawOutput = String(v || ''); },
      },
${marker}`);
}

async function createGuiSetup(t, options = {}) {
  let openUi = null;
  let dbRef = null;
  let liveChatRef = null;
  let characterRef = null;
  const runLLMCalls = [];
  const f = await createFixture('official', {
    transformSource: injectAuditBridge,
    configureApi(api, state) {
      dbRef = state.db;
      liveChatRef = state.liveChat;
      api.registerSetting = async (_name, fn) => { openUi = fn; return { id: 'lia-setting' }; };
      const origGetChar = api.getCharacterFromIndex.bind(api);
      api.getCharacterFromIndex = async idx => {
        const ch = await origGetChar(idx);
        characterRef = ch;
        return ch;
      };
      api.runLLMModel = async req => {
        runLLMCalls.push(req);
        if (options.onRunLLMModel) return await options.onRunLLMModel(req);
        return { type: 'success', result: 'OK' };
      };
      if (options.configureApi) options.configureApi(api, state);
    },
  });
  const gui = createColdStartGuiDocument();
  Object.assign(f.context, {
    document: gui.document,
    window: gui.dom.window,
    Event: gui.dom.window.Event,
    HTMLInputElement: gui.dom.window.HTMLInputElement,
    HTMLTextAreaElement: gui.dom.window.HTMLTextAreaElement,
    HTMLSelectElement: gui.dom.window.HTMLSelectElement,
  });
  t.after(async () => {
    await f.dispose();
    gui.dom.window.close();
  });
  await openUi();
  return { f, gui, db: dbRef, liveChat: liveChatRef, getCharacter: () => characterRef, runLLMCalls, audit: f.runtime.debugAudit };
}

test('RisuAI otherAx auxiliary provider delegates cleanly, decodes ReadableStream, rejects fail, and validates blank model', async t => {
  let mode = 'text';
  const x = await createGuiSetup(t, {
    onRunLLMModel: async () => {
      if (mode === 'fail') return { type: 'fail', result: 'aux execution blocked' };
      if (mode === 'stream') {
        const bytes = new TextEncoder().encode('STREAMED AUX OK');
        return {
          type: 'streaming',
          result: new ReadableStream({
            start(controller) {
              controller.enqueue(bytes.slice(0, 8));
              controller.enqueue(bytes.slice(8));
              controller.close();
            },
          }),
        };
      }
      return { type: 'success', result: 'AUX OK' };
    },
  });

  const auxCfg = { provider: 'risuai', model: '' };
  const textOut = await x.audit.callIndependentProvider('sys', 'usr', auxCfg, { jsonMode: false });
  assert.equal(textOut, 'AUX OK');
  assert.equal(x.runLLMCalls[0].type, 'generate');
  assert.equal(x.runLLMCalls[0].mode, 'otherAx');

  mode = 'stream';
  const streamOut = await x.audit.callIndependentProvider('sys', 'usr', auxCfg, { jsonMode: false });
  assert.equal(streamOut, 'STREAMED AUX OK');

  mode = 'fail';
  await assert.rejects(
    x.audit.callIndependentProvider('sys', 'usr', auxCfg, { jsonMode: false }),
    /aux execution blocked/,
  );

  await assert.rejects(
    x.audit.callIndependentProvider('sys', 'usr', { provider: 'custom', endpoint: 'https://example.invalid/v1/chat/completions', model: '', apiKey: 'k' }, { jsonMode: false }),
    /Model ID/,
  );

  // Settings dropdown exposes RisuAI otherAx at top and preserves unsaved draft across refreshPreview
  x.gui.document.querySelector('.sidebar [data-go="settings"]').click();
  const providerSel = x.gui.document.querySelector('#lia-provider');
  assert.ok(providerSel);
  assert.equal(providerSel.options[0].value, 'risuai');
  providerSel.value = 'risuai';
  providerSel.dispatchEvent(new x.gui.dom.window.Event('change', { bubbles: true }));
  assert.equal(x.audit.getUnsavedProviderDraft()?.provider, 'risuai');
  x.gui.document.querySelector('[data-lia-refresh]').click();
  await until(() => x.gui.document.querySelector('#lia-provider')?.value === 'risuai', 'unsaved risuai provider preserved across refresh');
  assert.equal(x.gui.document.querySelector('#lia-provider').value, 'risuai');
});

test('AI transport hardens SSE dedup, draft preservation, cancel abort, empty personas, and repaired prompt priority', async t => {
  let scenario = 'fail_invalid';
  let repairAttempt = 0;
  let releasePending = null;
  let capturedSignal = null;
  const x = await createGuiSetup(t, {
    onRunLLMModel: async req => {
      const promptText = req.chat.map(m => m.content).join('\n');
      if (promptText.includes('World Blueprint analyst') || String(req.chat[0]?.content || '').includes('World Blueprint analyst')) {
        return { type: 'success', result: JSON.stringify({ summary: 'Synthetic kingdom', hardConstraints: ['No guns'], safeCreativeSpace: ['Archivist'], evidenceNotes: ['Archive note'] }) };
      }
      if (scenario === 'fail_invalid') {
        return { type: 'success', result: 'NOT JSON AT ALL NO PERSONA PROMPT' };
      }
      if (scenario === 'repair_primary_weak') {
        repairAttempt += 1;
        if (repairAttempt > 1) {
          return {
            type: 'success',
            result: JSON.stringify({
              personaName: 'Repaired Elena',
              personaSpec: { name: 'Repaired Elena', role: 'Archivist', personality: 'Calm and observant' },
              personaPrompt: 'Repaired canonical prompt wins over broken primary output.',
            }),
          };
        }
        return {
          type: 'success',
          result: JSON.stringify({
            personaName: 'Broken',
            personaPrompt: 'Half broken prompt without spec',
          }),
        };
      }
      if (scenario === 'hang_for_cancel') {
        return await new Promise(resolve => {
          releasePending = () => resolve({ type: 'success', result: 'too late' });
        });
      }
      return { type: 'success', result: 'OK' };
    },
    configureApi(api) {
      api.nativeFetch = async (_url, opts) => {
        capturedSignal = opts?.signal || null;
        return await new Promise((resolve, reject) => {
          const onAbort = () => reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
          if (capturedSignal?.aborted) return onAbort();
          capturedSignal?.addEventListener('abort', onAbort, { once: true });
          releasePending = () => resolve({ ok: true, status: 200, data: JSON.stringify({ choices: [{ message: { content: 'late' }, finish_reason: 'stop' }] }) });
        });
      };
    },
  });

  // 1. OpenAI Responses SSE does not duplicate delta + completed text
  const sseRaw = [
    'data: {"type":"response.output_text.delta","delta":"Hello "}',
    'data: {"type":"response.output_text.delta","delta":"World"}',
    'data: {"type":"response.completed","response":{"output_text":"Hello World","status":"completed"}}',
    'data: [DONE]',
  ].join('\n');
  const sseParsed = x.audit.parseSsePayload(sseRaw, 'openai');
  assert.equal(sseParsed.content, 'Hello World');

  // Use RisuAI aux for fast in-process runLLMRewrite tests
  await x.audit.writeStoredLLMConfig({ provider: 'risuai', model: 'otherAx' });
  x.gui.document.querySelector('[data-lia-refresh]').click();
  await until(() => x.gui.document.querySelector('#lia-provider')?.value === 'risuai', 'risuai provider hydrated into mounted settings');
  const initialDraft = {
    personaName: 'Existing Draft',
    personaSpec: { name: 'Existing Draft', role: 'Scholar', personality: 'Patient' },
    personaPrompt: 'Existing careful prompt must survive AI failures.',
  };
  x.audit.setGeneratedOutputText(JSON.stringify(initialDraft));

  // 2. Failed runLLMRewrite preserves existing draft and stores lastFailedRawOutput
  scenario = 'fail_invalid';
  await assert.rejects(x.audit.runLLMRewrite({ skipBlueprintSave: false }), /personaPrompt/);
  assert.equal(x.audit.getLLMResultOverride().personaPrompt, initialDraft.personaPrompt);
  assert.match(x.audit.getLastFailedRawOutput(), /NOT JSON AT ALL/);

  // 3. Schema repair prefers repairedParsed.personaPrompt over incomplete primary output
  scenario = 'repair_primary_weak';
  const repairedRes = await x.audit.runLLMRewrite();
  assert.equal(repairedRes.personaName, 'Repaired Elena');
  assert.equal(x.audit.getLLMResultOverride().personaPrompt, 'Repaired canonical prompt wins over broken primary output.');

  // 4. Empty db.personas still opens #job-gen without pid block, and [data-job-cancel] aborts active request
  x.db.personas = [];
  x.liveChat.bindedPersona = '';
  await x.audit.writeStoredLLMConfig({ provider: 'custom', endpoint: 'https://example.invalid/v1/chat/completions', model: 'gpt-test', apiKey: 'sk-test' });
  x.audit.setGeneratedOutputText(JSON.stringify(initialDraft));
  x.gui.document.querySelector('[data-lia-refresh]').click();
  await until(() => x.gui.document.querySelector('#lia-provider')?.value === 'custom' && x.gui.document.querySelector('#mk-classic'), 'refresh settled');

  x.gui.document.querySelector('.sidebar [data-go="make"]').click();
  const mkClassic = x.gui.document.querySelector('#mk-classic');
  mkClassic.click();
  await until(() => x.gui.document.querySelector('#job-gen.is-open'), '#job-gen opens even with db.personas = []');
  const cancelBtn = x.gui.document.querySelector('#job-gen [data-job-cancel]');
  assert.equal(cancelBtn.disabled, false);
  await until(() => Boolean(capturedSignal), 'in-flight request started');
  cancelBtn.click();
  await until(() => capturedSignal.aborted === true, 'AbortController aborted in-flight request');
  if (releasePending) releasePending();
  await until(() => !x.gui.document.querySelector('#job-gen.is-open'), 'job dialog closed after cancel');
  assert.equal(x.audit.getLLMResultOverride().personaPrompt, initialDraft.personaPrompt, 'cancelled request leaves draft untouched');
});

test('Manual authoring tool supports blank draft, loading Persona, non-destructive edits, array/multiline fields, browser rename, and JSON+Vault translations', async t => {
  const x = await createGuiSetup(t);
  const doc = x.gui.document;

  // 1. Blank manual draft without AI + array splitting + worldFitNotes
  const blankBtn = doc.querySelector('[data-lia-new-blank-draft]');
  assert.ok(blankBtn);
  blankBtn.click();
  await until(() => (
    x.audit.getLLMResultOverride()?.draftAllowPartial === true
    && doc.querySelector('.page[data-page="edit"].is-active')
    && doc.querySelector('[data-subpanel="all"].is-active')
  ), 'blank draft created and edit/all tab active');

  const skillsInput = doc.querySelector('#edit-root [data-key="skills"]');
  assert.ok(skillsInput, 'skills input present');
  skillsInput.value = '검술, 고문서 해독';
  skillsInput.dispatchEvent(new x.gui.dom.window.Event('input', { bubbles: true }));

  const worldFitInput = doc.querySelector('#edit-root [data-key="worldFitNotes"]');
  assert.ok(worldFitInput, 'worldFitNotes field rendered in editor');
  worldFitInput.value = '북부 도서관 소속, 귀족 예법 익숙';
  worldFitInput.dispatchEvent(new x.gui.dom.window.Event('input', { bubbles: true }));

  let cur = x.audit.getLLMResultOverride();
  assert.deepEqual([...cur.personaSpec.skills], ['검술', '고문서 해독']);
  assert.deepEqual([...cur.personaSpec.worldFitNotes], ['북부 도서관 소속', '귀족 예법 익숙']);
  assert.match(cur.personaPrompt, /### World Fit Notes[\s\S]*- 북부 도서관 소속/);
  assert.equal(doc.querySelector('#dpg-persona-preview').value, cur.personaPrompt);

  // 2. Loading active RisuAI Persona & non-destructive [data-key] editing
  doc.querySelector('[data-lia-load-active-persona]').click();
  await until(() => (
    x.audit.getLLMResultOverride()?.personaName === 'Bound Persona'
    && doc.querySelector('#dpg-persona-preview')?.value === 'Bound persona prompt'
    && doc.querySelector('#lia-spec-sync-hint')?.textContent.includes('AI 원문 보존 모드')
  ), 'active RisuAI Persona loaded into editor');
  cur = x.audit.getLLMResultOverride();
  assert.equal(cur.personaPrompt, 'Bound persona prompt');

  const roleInput = doc.querySelector('#edit-root [data-key="role"]');
  roleInput.value = '왕실 기록관';
  roleInput.dispatchEvent(new x.gui.dom.window.Event('input', { bubbles: true }));
  cur = x.audit.getLLMResultOverride();
  assert.equal(cur.personaPrompt, 'Bound persona prompt', 'existing rich/loaded personaPrompt is preserved');
  assert.equal(cur.specOutOfSyncWithPrompt, true);

  // Explicit local re-render updates prompt from PersonaSpec and includes role + worldFitNotes
  const renderLocalBtn = doc.querySelector('[data-lia-render-spec-local]');
  assert.equal(renderLocalBtn.disabled, false);
  renderLocalBtn.click();
  await until(() => (
    x.audit.getLLMResultOverride()?.specOutOfSyncWithPrompt !== true
    && /Role: 왕실 기록관/.test(doc.querySelector('#dpg-persona-preview')?.value || '')
  ), 'local spec re-render applied');
  assert.match(x.audit.getLLMResultOverride().personaPrompt, /Role: 왕실 기록관/);

  // 3. Browser-DOM rename via saveEditedResultToCurrentPersona persists updated name
  const nameInput = doc.querySelector('#edit-root [data-key="name"]');
  nameInput.value = '세라 하운 개명';
  nameInput.dispatchEvent(new x.gui.dom.window.Event('input', { bubbles: true }));
  const saveRes = await x.audit.saveEditedResultToCurrentPersona();
  assert.equal(saveRes.action, 'updated');
  assert.equal(x.db.personas[1].name, '세라 하운 개명');
  assert.equal(x.db.selectedPersona, 0, 'native RisuAI selectedPersona remains untouched');

  // 4. Export/Import Persona JSON + Vault save/load preserves translations
  x.audit.setTranslationText('한국어 번역 페르소나 본문', 'ko');
  const exportedJson = x.audit.exportCurrentPersonaJson();
  x.audit.setTranslationText('', 'ko');
  x.audit.createBlankPersonaDraft();
  assert.equal(x.audit.getTranslationText(), '');

  x.audit.importPersonaJsonText(exportedJson);
  assert.equal(x.audit.getLLMResultOverride().personaName, '세라 하운 개명');
  assert.equal(x.audit.getTranslationText(), '한국어 번역 페르소나 본문');
  assert.equal(x.audit.getTranslationLanguage(), 'ko');

  await x.audit.saveCurrentResultToVault();
  x.audit.setTranslationText('', 'ko');
  x.audit.createBlankPersonaDraft();
  await x.audit.loadVaultResult();
  assert.equal(x.audit.getTranslationText(), '한국어 번역 페르소나 본문');
  assert.equal(x.audit.getTranslationLanguage(), 'ko');
});

test('Binding hardening handles dangling chat.bindedPersona, #ad-mode scoped vs new, and [Persona] lore guard', async t => {
  const x = await createGuiSetup(t, {
    configureApi(api) {
      api.confirm = () => true;
    },
  });
  x.f.context.confirm = () => true;
  const doc = x.gui.document;

  // 1. Dangling chat.bindedPersona warning badge + unbind works cleanly
  x.liveChat.bindedPersona = 'missing-deleted-id';
  doc.querySelector('[data-lia-refresh]').click();
  await until(() => doc.querySelector('#pocket .bind--warn'), 'dangling binding badge rendered');
  assert.match(doc.querySelector('#pocket').textContent, /끊어진 연결/);
  const unbindBtn = doc.querySelector('#pocket [data-lia-persona-unbind]');
  assert.ok(unbindBtn);
  unbindBtn.click();
  await until(() => !x.liveChat.bindedPersona, 'dangling bindedPersona cleared');
  assert.equal(x.liveChat.bindedPersona, undefined);

  // 2. #ad-mode "scoped" vs "new" adoption
  x.audit.setGeneratedOutputText(JSON.stringify({
    personaName: 'Adelina',
    personaSpec: { name: 'Adelina', role: 'Mage', personality: 'Focused' },
    personaPrompt: 'Adelina canonical prompt',
  }));
  doc.querySelector('[data-lia-refresh]').click();
  await until(() => doc.querySelectorAll('#ad-mode .choice').length === 2, '#ad-mode hydrated');

  const scopedRes = await x.audit.adoptPersonaFromPane('original');
  assert.match(String(scopedRes.personaId || ''), /^lia-persona-generated::/);

  const adChoices = doc.querySelectorAll('#ad-mode .choice');
  adChoices[1].click();
  assert.equal(x.audit.getPreservedAdoptionMode(), 'new');
  const countBeforeNew = x.db.personas.length;
  const newRes = await x.audit.adoptPersonaFromPane('original');
  assert.equal(x.db.personas.length, countBeforeNew + 1);
  assert.match(String(newRes.personaId || ''), /^lia-adopted-persona::/);
  assert.equal(x.db.selectedPersona, 0, 'adoption preserves native selectedPersona');

  // 3. char.globalLore without [Persona] marker does NOT auto-override matching Persona name
  const ch = x.getCharacter();
  ch.globalLore = [{ comment: 'Source Persona', content: 'ORDINARY WORLD LORE CONTENT', mode: 'normal' }];
  const noHijack = x.audit.resolvePersona(x.db, ch, x.liveChat);
  assert.equal(noHijack.source, 'selected');
  assert.equal(noHijack.persona.personaPrompt, 'Base persona prompt');

  ch.globalLore = [{ comment: '[Persona] Source Persona', content: 'EXPLICIT PERSONA OVERRIDE', mode: 'normal' }];
  const explicitOverride = x.audit.resolvePersona(x.db, ch, x.liveChat);
  assert.equal(explicitOverride.source, 'selected_global_lore');
  assert.equal(explicitOverride.persona.personaPrompt, 'EXPLICIT PERSONA OVERRIDE');
});

test('LIBRA unifies fallback from empty chat.bindedPersona to non-empty db.selectedPersona', async () => {
  await withReferences(async (h, d) => {
    d.db.personas = [
      { id: 'p0', name: '수아', description: '첫 번째 페르소나', personaPrompt: '수아 프롬프트' },
      { id: 'p1', name: '하린', description: '두 번째 페르소나', personaPrompt: '하린 프롬프트' },
    ];
    d.chat.bindedPersona = '';
    d.chat.note = '{{user}}를 기억하라';

    // Numeric index 1 -> 하린
    d.db.selectedPersona = 1;
    let probe = await h.api.retainedContractProbe({ bootstrap_references: { personaCount: 1 } });
    assert.equal(probe.snapshot.persona?.name, '하린');
    assert.equal(probe.snapshot.authorNote.content.includes('하린'), true);
    assert.ok(probe.readSet.entries.some(x => x.kind === 'persona'));

    // String digit index '1' -> 하린
    d.db.selectedPersona = '1';
    probe = await h.api.retainedContractProbe({ bootstrap_references: { personaCount: 1 } });
    assert.equal(probe.snapshot.persona?.name, '하린');

    // String persona id 'p1' -> 하린
    d.db.selectedPersona = 'p1';
    probe = await h.api.retainedContractProbe({ bootstrap_references: { personaCount: 1 } });
    assert.equal(probe.snapshot.persona?.name, '하린');

    // Empty db.selectedPersona -> null (still does not fall back to personas[0] when explicitly empty!)
    d.db.selectedPersona = '';
    probe = await h.api.retainedContractProbe({ bootstrap_references: { personaCount: 1 } });
    assert.equal(probe.snapshot.persona, null);
  });
});

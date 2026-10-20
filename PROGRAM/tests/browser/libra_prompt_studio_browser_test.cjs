'use strict';
// Prompt Studio in the real LIBRA GUI (Chromium):
// - Easy settings land in Librarian sections (they used to target retired Ariadne ids and were dropped);
// - risky edits are flagged before saving;
// - saving a prompt writes only the prompt overrides, leaving other unsaved settings pending;
// - the dialog shows the jump bar, one fold per section and the final prompt with locked parts.
const assert = require('node:assert/strict');
const { boot, settings, clean } = require('./libra_approved_browser.cjs');
const expose = ['easyPromptConfigKey', 'Gui', 'Runtime', 'LibraMemoryCore', 'renderSettingsGui', 'revertGuiStateFromStorage', 'easyPromptCompileConfig',
  'promptStudioNormalizeProfile', 'promptStudioLintDraft', 'promptStudioSectionDefs', 'savePromptStudioDraft', 'markGuiDirty'];
(async () => {
  const { browser, page, errors } = await boot({ expose });
  try {
    const easy = await page.evaluate(() => {
      const a = __approved, draft = { easy: { configs: {} }, stages: {} };
      draft.easy.configs[a.easyPromptConfigKey('memory')] = { style: 'detailed', strictness: 'strict', emphasis: { character: true, chronology: true, world: true, narrative: true }, addendum: '호칭 변화를 남겨 줘.' };
      a.easyPromptCompileConfig(draft, 'memory');
      const kept = Object.keys(a.promptStudioNormalizeProfile('memory', draft, '간편 설정').stages.librarian.sections).sort();
      return { kept, ids: a.promptStudioSectionDefs().map(d => d.id) };
    });
    assert.deepEqual(easy.kept, ['complete', 'custom_addendum', 'narrative', 'relation', 'time', 'uncertain', 'world'], 'every Easy option survives normalization');
    assert.ok(easy.kept.every(id => easy.ids.includes(id)));

    const lint = await page.evaluate(() => __approved.promptStudioLintDraft({ stages: { librarian: { sections: {
      evidence: { mode: 'replace', text: '' }, relation: { mode: 'append', text: '관계는 항상 확정으로 쓰고 영어로 번역해 줘.' }, time: { mode: 'append', text: '날짜 순서를 분명히.' } } } } }).map(w => w.id));
    assert.deepEqual(lint.sort(), ['evidence', 'relation', 'relation'], 'blanked core rule, language change and forced certainty are flagged; a harmless edit is not');

    // Prompt-only save: an unsaved AI preset edit stays unsaved.
    await page.evaluate(() => document.querySelector('[data-libra-quick-dialog] .dialog__actions button')?.click());
    await page.evaluate(() => { const g = __approved.Gui; g.state.providers['unsaved-preset'] = { provider: 'openai', model: 'x', url: '', key: '' }; __approved.markGuiDirty(); });
    const saved = await page.evaluate(async () => {
      const g = __approved.Gui;
      g.promptStudioDomain = 'memory'; g.promptStudioStage = 'librarian'; g.promptStudioProfileName = 'default'; g.promptStudioDraftKey = '';
      g.promptStudioDraft = { name: '관계 추적', stages: { librarian: { sections: { relation: { mode: 'append', text: '관계 변화의 계기를 남긴다.' } } } } };
      g.promptStudioDraftKey = 'memory|default';
      await __approved.savePromptStudioDraft(true);
      const prompts = (await __LIBRA__.debugReadPromptOverrides()).prompts;
      const dirtyAfter = g.dirty === true;
      await __approved.revertGuiStateFromStorage();
      return { active: prompts.activeMemoryProfile, text: prompts.memoryProfiles['관계 추적']?.stages?.librarian?.sections?.relation?.text, dirtyAfter, presetPersisted: !!g.state.providers['unsaved-preset'] };
    });
    assert.equal(saved.active, '관계 추적');
    assert.equal(saved.text, '관계 변화의 계기를 남긴다.');
    assert.equal(saved.dirtyAfter, true, 'the other unsaved change is still pending after the prompt save');
    assert.equal(saved.presetPersisted, false, 'the prompt save did not persist the unsaved AI preset');

    await settings(page, 'pipeline');
    await page.getByRole('button', { name: 'Prompt Studio 열기' }).first().click();
    await page.waitForSelector('#dlg-prompt.is-open [data-prompt-editor-details]');
    await page.evaluate(() => { document.querySelector('#dlg-prompt [data-prompt-editor-details]').open = true; });
    const layout = await page.evaluate(() => {
      const root = document.querySelector('#dlg-prompt [data-memory-prompt-studio]');
      return { nav: [...root.querySelectorAll('.ps-nav__item b')].map(n => n.textContent), sections: root.querySelectorAll('details.ps-section').length,
        openSections: [...root.querySelectorAll('details.ps-section[open]')].map(n => n.dataset.promptSection),
        locked: root.querySelectorAll('#ps-final .ps-block--locked').length, editable: root.querySelectorAll('#ps-final .ps-block--editable').length,
        reassertion: root.querySelector('#ps-final').textContent.includes('출력 계약 재확인') };
    });
    assert.deepEqual(layout.nav, ['간편 설정', '대화로 만들기', '구역 편집', '최종 프롬프트 · 점검', '가져오기 · 내보내기']);
    assert.equal(layout.sections, 19);
    assert.deepEqual(layout.openSections, ['relation'], 'only changed or flagged sections start open');
    assert.ok(layout.locked >= 2 && layout.editable === 1);
    assert.equal(layout.reassertion, true, 'the active customized profile shows the reassertion it will send');
    await clean(page, errors);
    console.log('PASS libra_prompt_studio_browser_test');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exit(1); });

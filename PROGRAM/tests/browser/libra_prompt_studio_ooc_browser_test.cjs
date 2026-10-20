'use strict';
// Prompt Studio OOC end to end in Chromium: start the conversation, talk, build a preview, save it,
// and see the saved guidance in the final prompt that the Librarian request sends. A risky preview
// (a score request) is flagged before saving. Model replies are scripted; nothing leaves the page.
const assert = require('node:assert/strict');
const path = require('node:path');
const { boot, settings, clean } = require('./libra_approved_browser.cjs');
const out = process.env.LIBRA_OOC_SHOTS || '';
(async () => {
  const { browser, page, errors } = await boot();
  try {
    await page.evaluate(() => {
      window.__oocReplies = { compile: [] , calls: [] };
      window.risuai.runLLMModel = async arg => {
        const text = JSON.stringify(arg);
        window.__oocReplies.calls.push(text.slice(0, 4000));
        if (text.includes('You compile a LIBRA Prompt Studio custom append')) {
          const next = window.__oocReplies.compile.shift() || '관계가 바뀌면 그 계기와 이전 관계를 사실 문장에 함께 남긴다.';
          return JSON.stringify({ title: '관계 변화 추적', summary: '관계 변화의 계기를 남깁니다.', append_text: next, checks: ['관계 변화 기억에 계기가 함께 적혀 있다'], warnings: [] });
        }
        return '좋아요. 관계가 바뀔 때 무엇이 계기였는지와 이전 관계를 함께 남기면 될까요?';
      };
    });
    await settings(page, 'pipeline');
    await page.getByRole('button', { name: 'Prompt Studio 열기' }).first().click();
    await page.waitForSelector('#dlg-prompt.is-open [data-prompt-editor-details]');
    await page.evaluate(() => { document.querySelector('#dlg-prompt [data-prompt-editor-details]').open = true; });
    await page.evaluate(() => { const d = document.querySelector('#libra-memory-ooc-editor'); d.open = true; d.dispatchEvent(new Event('toggle')); });
    await page.waitForFunction(() => document.querySelectorAll('#prompt-studio-ooc-builder select option').length > 0, null, { timeout: 15000 });
    const targets = await page.evaluate(() => [...document.querySelectorAll('#prompt-studio-ooc-builder select option')].map(o => o.textContent));
    assert.equal(targets.length, 19, 'each Librarian section is offered once');
    const ooc = page.locator('#prompt-studio-ooc-builder');
    await ooc.getByRole('button', { name: '대화 시작' }).click();
    await ooc.locator('textarea').fill('관계가 바뀌면 왜 바뀌었는지도 기억해 줬으면 좋겠어.');
    await ooc.getByRole('button', { name: 'OOC 보내기' }).click();
    await page.waitForFunction(() => document.querySelector('#prompt-studio-ooc-builder')?.textContent.includes('이전 관계를 함께 남기면'), null, { timeout: 15000 });
    const dialogue = await page.evaluate(() => window.__oocReplies.calls.at(-1));
    assert.ok(dialogue.includes('Librarian memory analyzer') && dialogue.includes('closest existing kind'), 'the conversation knows what the analyzer guidance may change');
    await page.locator('#prompt-studio-ooc-builder').getByRole('button', { name: '지침 미리보기 만들기' }).click();
    await page.waitForFunction(() => document.querySelector('#prompt-studio-ooc-builder')?.textContent.includes('관계 변화 추적'), null, { timeout: 15000 });
    assert.equal(await page.locator('[data-ooc-preview-risk]').count(), 0, 'a safe preview has no warning');
    if (out) await page.locator('#prompt-studio-ooc-builder').screenshot({ path: path.join(out, 'ooc_preview.png') });
    await page.locator('#prompt-studio-ooc-builder').getByRole('button', { name: '이 구역의 추가 지침으로 저장' }).click();
    await page.waitForFunction(() => document.querySelector('#prompt-studio-ooc-builder')?.textContent.includes('최종 프롬프트에서 확인'), null, { timeout: 15000 });
    const stored = await page.evaluate(async () => (await __LIBRA__.debugReadPromptOverrides()).prompts);
    const active = stored.memoryProfiles[stored.activeMemoryProfile];
    const appended = JSON.stringify(active?.stages?.librarian?.sections || {});
    assert.ok(appended.includes('그 계기와 이전 관계'), 'the agreed guidance is saved into the active profile');
    const sent = await page.evaluate(async () => __LIBRA__.debugComposeLibrarianSystemPrompt());
    assert.ok(sent.includes('그 계기와 이전 관계') && sent.includes('OUTPUT CONTRACT REASSERTION'), 'the next Librarian request carries the guidance and the reassertion');
    await page.locator('#prompt-studio-ooc-builder').getByRole('button', { name: '최종 프롬프트에서 확인' }).click();
    const finalText = await page.evaluate(() => document.querySelector('#ps-final')?.textContent || '');
    assert.ok(finalText.includes('그 계기와 이전 관계'), 'the final prompt view shows the saved guidance');

    // A risky agreement is flagged in the preview.
    await page.evaluate(() => { window.__oocReplies.compile.push('호감도를 0~100 점수로 기록하고 태그를 붙인다.'); });
    const builder = page.locator('#prompt-studio-ooc-builder');
    await builder.locator('textarea').fill('호감도도 점수로 남겨 줘.');
    await builder.getByRole('button', { name: 'OOC 보내기' }).click();
    await page.waitForTimeout(400);
    await page.locator('#prompt-studio-ooc-builder').getByRole('button', { name: '지침 미리보기 만들기' }).click();
    await page.waitForSelector('[data-ooc-preview-risk]', { timeout: 15000 });
    if (out) await page.locator('#prompt-studio-ooc-builder').screenshot({ path: path.join(out, 'ooc_risky_preview.png') });
    await clean(page, errors).catch(error => { if (!/model request/.test(String(error.message))) throw error; });
    console.log('PASS libra_prompt_studio_ooc_browser_test');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exit(1); });

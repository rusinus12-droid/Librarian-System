'use strict';
// People on lens notes in Chromium: one people-tracking lens shows whose note it is, unknown people
// plainly, person chips built from the notes that filter the list, the name turn highlighted in the
// provenance fold, and the studio chip and editor switch. Model replies are scripted.
const assert = require('node:assert/strict');
const { boot } = require('./libra_approved_browser.cjs');

const touching = (page, scope) => page.evaluate(sel => {
  const out = [];
  const buttons = [...document.querySelectorAll(sel + ' button')].filter(button => button.getClientRects().length && button.offsetParent && !button.closest('.lens-nav'));
  for (let i = 0; i < buttons.length; i += 1) for (let j = i + 1; j < buttons.length; j += 1) {
    if (buttons[i].closest('.seg') && buttons[i].closest('.seg') === buttons[j].closest('.seg')) continue;
    const a = buttons[i].getBoundingClientRect(), b = buttons[j].getBoundingClientRect();
    if (Math.max(b.left - a.right, a.left - b.right) < 4 && Math.max(b.top - a.bottom, a.top - b.bottom) < 4) out.push([buttons[i].textContent.trim(), buttons[j].textContent.trim()]);
  }
  return out;
}, scope);

(async () => {
  for (const width of [1280, 390]) {
    const { browser, page, errors } = await boot({ expose: ['Gui', 'LibraMemoryCore', 'bookNavigate', 'openApprovedPromptDialog', 'selectBookMemoryKind'], page: { viewport: { width, height: width < 600 ? 844 : 900 } } });
    page.setDefaultTimeout(15000);
    try {
      const lensId = await page.evaluate(async () => {
        const chat = __writerHost.chat;
        chat.message = [];
        const lines = [['나 오늘 머리가 너무 아파.', '지호는 열이 38도까지 올랐다. 민아는 지호의 이마를 짚었다.'], ['민아는 아침부터 기침을 했다.', '그녀는 창밖을 보며 한숨을 쉬었다.'],
          ['모두 잠들었다.', '창밖으로 비가 내렸다.']];
        lines.forEach(([u, a], i) => { chat.message.push({ role: 'user', data: u, chatId: 'u' + i }); chat.message.push({ role: 'char', data: a, chatId: 'a' + i }); });
        chat.messages = chat.message;
        risuai.runLLMModel = async args => JSON.stringify(args).includes('LIBRA LENS ANALYZER')
          ? { type: 'success', result: JSON.stringify({ items: [
            { label: '증상', text: '두통을 호소했다.', refs: ['t1-u'], quote: '머리가 너무 아파', who: ['user'] },
            { label: '증상', text: '열이 38도까지 올랐다.', refs: ['t1-a'], quote: '열이 38도까지 올랐다', who: ['지호'], whoRef: 't1-a' },
            { label: '증상', text: '아침부터 기침을 했다.', refs: ['t2-u'], quote: '아침부터 기침을 했다', who: ['민아'] },
            { label: '기분', text: '한숨을 쉬었다.', refs: ['t2-a'], quote: '한숨을 쉬었다', who: ['그녀'] }
          ] }) }
          : { type: 'success', result: '{}' };
        const lens = await __approved.LibraMemoryCore.createLens({ name: '생체 추적', instruction: { goal: '인물별 몸 상태를 기록하라.' }, trackSubject: true });
        const run = await __approved.LibraMemoryCore.runLensForRange({ lensId: lens.lensId, startTurn: 1, endTurn: 3 });
        if (run?.ok === false || !/succeeded/.test(JSON.stringify(run))) throw new Error('lens run failed: ' + JSON.stringify(run));
        return lens.lensId;
      });

      await page.evaluate(() => { __approved.selectBookMemoryKind('lens'); __approved.bookNavigate('memory'); });
      await page.waitForSelector('[data-lens-reader] .lens-item');
      const reader = page.locator('[data-lens-reader]');
      assert.equal(await reader.locator('.lens-item').count(), 4);
      const fever = reader.locator('.lens-item').filter({ hasText: '38도' });
      assert.equal(await fever.locator('[data-lens-who="named"] .lens-who__names').innerText(), '지호');
      assert.match(await reader.locator('.lens-item').filter({ hasText: '두통' }).locator('[data-lens-who]').innerText(), /사용자[\s\S]*사용자 1인칭/);
      assert.match(await reader.locator('.lens-item').filter({ hasText: '한숨' }).locator('[data-lens-who="unknown"]').innerText(), /인물 불명[\s\S]*원문에서 확인되지 않아 제외/, 'a pronoun is not a person');

      const chips = reader.locator('[data-lens-people] [data-lens-person]');
      assert.deepEqual((await chips.allInnerTexts()).map(value => value.replace(/\s+/g, ' ').trim()), ['모든 인물 4', '민아 1', '사용자 1', '지호 1', '인물 불명 1'], 'chips come from the notes; unknown last');
      await reader.locator('[data-lens-person^="name:"]', { hasText: '지호' }).click();
      await page.waitForFunction(() => document.querySelectorAll('[data-lens-reader] .lens-item').length === 1);
      assert.match(await reader.locator('.lens-item').innerText(), /38도/, 'a chip filters to that person');
      if (process.env.LIBRA_LENS_BROWSER_OUTPUT) await page.screenshot({ path: `${process.env.LIBRA_LENS_BROWSER_OUTPUT}/story-people-${width}.png`, fullPage: true });
      await reader.locator('[data-lens-person="unknown"]').click();
      await page.waitForFunction(() => document.querySelectorAll('[data-lens-reader] .lens-item').length === 1 && /한숨/.test(document.querySelector('[data-lens-reader] .lens-item').textContent));
      await reader.locator('[data-lens-person="all"]').click();
      await page.waitForFunction(() => document.querySelectorAll('[data-lens-reader] .lens-item').length === 4);

      const feverCard = reader.locator('.lens-item').filter({ hasText: '38도' });
      await feverCard.locator('.lens-prov summary').click();
      await feverCard.locator('.lens-prov [data-lens-name-turn] mark').first().waitFor();
      assert.match(await feverCard.locator('.lens-prov').innerText(), /이름이 적힌 턴 \(지호\)/);
      assert.match((await feverCard.locator('.lens-prov [data-lens-name-turn] mark').allInnerTexts()).join('|'), /지호/, 'the name is highlighted in its turn');
      assert.deepEqual(await touching(page, '[data-lens-reader]'), []);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), 0);

      await page.evaluate(() => __approved.openApprovedPromptDialog());
      const card = page.locator(`#dlg-prompt [data-lens-card="${lensId}"]`);
      await card.waitFor();
      assert.match(await card.innerText(), /인물 구분/, 'the card shows the people chip');
      await card.locator('button', { hasText: '편집' }).click();
      const toggle = page.locator('#dlg-prompt [data-lens-editor] .lens-toggle', { hasText: '등장인물별로 구분해 기록' });
      assert.equal(await toggle.locator('input').isChecked(), true);
      assert.match(await toggle.innerText(), /인물 불명으로 둡니다/);
      assert.deepEqual(await touching(page, '#dlg-prompt'), []);
      assert.equal(await page.evaluate(() => { const d = document.querySelector('#dlg-prompt .dialog'); return d.scrollWidth - d.clientWidth; }), 0);
      assert.deepEqual(errors, []);
      console.log(JSON.stringify({ test: 'libra_lens_story_people_browser', width, ok: true }));
    } finally {
      await browser.close();
    }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });

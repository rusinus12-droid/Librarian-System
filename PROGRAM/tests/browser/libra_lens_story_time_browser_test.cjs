'use strict';
// Story time in Chromium: a time-tracking lens shows the source's own time on each note, marks a
// missing or unverified time as unknown, highlights the time-bearing turn in the provenance fold,
// and the studio shows the chip and the editor switch. Model replies are scripted.
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
        const lines = [['3월 2일 아침, 민아는 병원에 갔다.', '의사는 다음 달에 다시 오라고 했다.'], ['민아는 머리가 아프다고 했다.', '지호가 약을 건넸다.'],
          ['민아는 잠들었다.', '창밖으로 비가 내렸다.']];
        lines.forEach(([u, a], i) => { chat.message.push({ role: 'user', data: u, chatId: 'u' + i }); chat.message.push({ role: 'char', data: a, chatId: 'a' + i }); });
        chat.messages = chat.message;
        risuai.runLLMModel = async args => JSON.stringify(args).includes('LIBRA LENS ANALYZER')
          ? { type: 'success', result: JSON.stringify({ items: [
            { label: '진료', text: '민아가 병원에서 재방문 안내를 받았다.', refs: ['t1-a'], quote: '다음 달에 다시 오라고 했다', when: '3월  2일 아침', whenRef: 't1-u' },
            { label: '증상', text: '민아가 두통을 호소했다.', refs: ['t2-u'], quote: '머리가 아프다고 했다', when: '' },
            { label: '복약', text: '지호가 약을 건넸다.', refs: ['t2-a'], quote: '지호가 약을 건넸다', when: '4월 1일 저녁' }
          ] }) }
          : { type: 'success', result: '{}' };
        const lens = await __approved.LibraMemoryCore.createLens({ name: '건강 기록', instruction: { goal: '증상과 진료를 기록하라.' }, trackTime: true });
        const run = await __approved.LibraMemoryCore.runLensForRange({ lensId: lens.lensId, startTurn: 1, endTurn: 3 });
        if (run?.ok === false || !/succeeded/.test(JSON.stringify(run))) throw new Error('lens run failed: ' + JSON.stringify(run));
        return lens.lensId;
      });

      await page.evaluate(() => { __approved.selectBookMemoryKind('lens'); __approved.bookNavigate('memory'); });
      await page.waitForSelector('[data-lens-reader] .lens-item');
      const items = page.locator('[data-lens-reader] .lens-item');
      assert.equal(await items.count(), 3);
      const stated = items.filter({ hasText: '재방문' });
      assert.equal(await stated.locator('[data-lens-when="stated"] b').innerText(), '3월 2일 아침', 'the stored time is the source wording');
      assert.match(await stated.locator('.lens-when').innerText(), /원문 명시/);
      assert.match(await items.filter({ hasText: '두통' }).locator('[data-lens-when="unknown"]').innerText(), /시점 불명[\s\S]*확인된 시점 없음/);
      assert.match(await items.filter({ hasText: '약을 건넸다' }).locator('[data-lens-when="unknown"]').innerText(), /시점 불명[\s\S]*원문에서 확인되지 않아 제외/, 'an invented time is shown as dropped, not as the time');
      assert.equal(await page.locator('[data-lens-reader]').getByText('4월 1일').count(), 0, 'the dropped time never appears');

      await stated.locator('.lens-prov summary').click();
      const timeTurn = stated.locator('.lens-prov .lens-source', { hasText: '3월 2일 아침' });
      await timeTurn.locator('mark').first().waitFor();
      assert.match(await stated.locator('.lens-prov').innerText(), /T1-U · 시점이 적힌 턴/);
      assert.match(await timeTurn.locator('mark').allInnerTexts().then(list => list.join('|')), /3월 2일 아침/, 'the time is highlighted in its own turn');
      if (process.env.LIBRA_LENS_BROWSER_OUTPUT) await page.screenshot({ path: `${process.env.LIBRA_LENS_BROWSER_OUTPUT}/story-time-${width}.png`, fullPage: true });
      assert.deepEqual(await touching(page, '[data-lens-reader]'), []);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), 0);

      await page.evaluate(() => __approved.openApprovedPromptDialog());
      const card = page.locator(`#dlg-prompt [data-lens-card="${lensId}"]`);
      await card.waitFor();
      assert.match(await card.innerText(), /시점 기록/, 'the card shows the time chip');
      await card.locator('button', { hasText: '편집' }).click();
      const toggle = page.locator('#dlg-prompt [data-lens-editor] .lens-toggle', { hasText: '원문에 적힌 시점을 함께 기록' });
      assert.equal(await toggle.locator('input').isChecked(), true);
      assert.match(await toggle.innerText(), /추측하지 않고 시점 불명/);
      assert.deepEqual(await touching(page, '#dlg-prompt'), []);
      assert.equal(await page.evaluate(() => { const d = document.querySelector('#dlg-prompt .dialog'); return d.scrollWidth - d.clientWidth; }), 0);
      assert.deepEqual(errors, []);
      console.log(JSON.stringify({ test: 'libra_lens_story_time_browser', width, ok: true }));
    } finally {
      await browser.close();
    }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });

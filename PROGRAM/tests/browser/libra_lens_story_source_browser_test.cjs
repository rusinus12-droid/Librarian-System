'use strict';
// Exact Full/Min bytes with owner-produced immutable archives and an empty successor.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { chromium } = require('playwright');
const { lensFixture } = require('../fixtures/libra_lens_handoff_fixture.cjs');
(async () => {
  const f = await lensFixture({ beforeRun: f => { f.chat.message[0].data += ' ' + '배경 설명. '.repeat(700) + ' Ｍｉｎａは３月４日に到着した。 I helped her.'; } });
  let seed;
  try {
    f.setReply({ items: [
      { label: '도착', text: 'Mina가 도착했다.', refs: ['t1-u'], quote: '３月４日に到着した', when: '3月4日', who: ['Mina'] },
      { label: '도움', text: '도움을 받았다.', refs: ['t1-u'], quote: 'I helped her', who: ['her'] }
    ] });
    await f.add('시점·인물 원문', 'active', { trackTime: true, trackSubject: true });
    await f.api.prepareSessionHandoff({ transferId: 'browser-source-identity' });
    const chat = f.target();
    assert.equal((await f.api.adoptSessionHandoff({ transferId: 'browser-source-identity', targetChatId: chat.id })).verified, true);
    seed = { values: [...f.r.values], chat, character: f.character, index: f.character.chatPage };
  } finally { await f.close(); }
  const out = process.env.LIBRA_LENS_BROWSER_OUTPUT || path.join(os.tmpdir(), 'libra-lens-story-source-browser');
  fs.mkdirSync(out, { recursive: true });
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  try {
    for (const width of [1280, 390]) {
      const page = await browser.newPage({ viewport: { width, height: width < 600 ? 844 : 900 } }), errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.setContent('<html lang="ko"><meta name="viewport" content="width=device-width,initial-scale=1"><body></body></html>');
      await page.addScriptTag({ path: path.join(__dirname, 'libra_writer_host.js') });
      await page.evaluate(data => {
        for (const [key, value] of data.values) __writerHost.values.set(key, value);
        Object.assign(__writerHost.chat, data.chat); Object.assign(__writerHost.character, data.character);
        risuai.getCurrentChatIndex = async () => data.index;
        risuai.getChatFromIndex = async (_character, index) => structuredClone(__writerHost.character.chats[index]);
        risuai.runLLMModel = async () => { throw Error('Reading archived provenance must not call a model'); };
      }, seed);
      await page.addScriptTag({ path: process.env.LIBRA_TEST_PLUGIN || path.join(__dirname, '../../plugins/LIBRA.js') });
      await page.waitForFunction(() => !!window.__LIBRA__);
      await page.evaluate(() => __LIBRA__.openSettingsGui());
      await page.locator('.app[data-response-family="libra"]').waitFor();
      await page.locator('[data-go="memory"]:visible').first().click();
      await page.locator('[data-memory-reader-kind="lens"]').click();
      const group = page.locator('[data-lens-inherited-group]');
      const card = group.locator('.lens-item').filter({ hasText: 'Mina가 도착했다.' });
      await card.waitFor();
      assert.equal(await card.locator('[data-lens-when="stated"] b').innerText(), '３月４日');
      assert.match(await card.locator('[data-lens-who="named"]').innerText(), /Ｍｉｎａ/);
      const unknown = group.locator('.lens-item').filter({ hasText: '도움을 받았다.' });
      assert.match(await unknown.locator('[data-lens-who="unknown"]').innerText(), /인물 불명[\s\S]*원문에서 확인되지 않아 제외/);
      await card.locator('.lens-prov summary').click();
      await card.locator('.lens-source mark').first().waitFor();
      const marks = (await card.locator('.lens-source mark').allInnerTexts()).join('|');
      assert.match(marks, /３月４日/); assert.match(marks, /Ｍｉｎａ/);
      assert.equal(await card.getByText(/보관된 발췌에서 시점 문구/).count(), 0);
      assert.equal(await card.getByRole('button', { name: /항목 삭제/ }).count(), 0);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      assert.deepEqual(errors, []);
      await page.screenshot({ path: path.join(out, `source-identity-${width}.png`), fullPage: true });
      await page.evaluate(async () => { for (const dispose of __writerHost.unload.slice().reverse()) await dispose(); });
      await page.close();
      console.log(JSON.stringify({ test: 'libra_lens_story_source_browser', width, originalWording: true, archivedHighlights: true, pageErrors: errors }));
    }
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });

'use strict';
// Lens Studio in Chromium: create by conversation (with a trial run), add a template, run, edit
// (new instruction revision), raw response, trash/restore, the read-only canonical prompt, and the
// memory lens tab with provenance. Model replies are scripted; no button pair may touch.
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
    const { browser, page, errors } = await boot({ expose: ['Gui', 'Runtime', 'LibraMemoryCore', 'bookNavigate', 'renderSettingsGui', 'openApprovedPromptDialog', 'selectBookMemoryKind'], page: { viewport: { width, height: width < 600 ? 844 : 900 } } });
    page.setDefaultTimeout(15000);
    try {
      await page.evaluate(() => {
        const chat = __writerHost.chat;
        chat.message = [];
        const lines = [['민아는 서재 문을 두드렸다.', '지호가 문을 열며 말했다. "오늘 밤 시계탑에서 만나자고 약속했잖아. 푸른 열쇠를 꼭 챙겨 와."'],
          ['민아는 고개를 끄덕였다.', '지호는 낡은 지도를 꺼내 보였다. 지도 한 귀퉁이가 찢겨 있었다.'], ['찢긴 부분은 어디 있어?', '"그건 아직 말할 수 없어." 지호가 시선을 피했다.'],
          ['민아는 지도를 받아 들었다.', '창밖으로 빗소리가 굵어졌다.'], ['비가 와도 갈 거야.', '"그래, 열두 시에 시계탑 아래에서." 지호가 작게 웃었다.']];
        lines.forEach(([u, a], i) => { chat.message.push({ role: 'user', data: u, chatId: 'u' + i }); chat.message.push({ role: 'char', data: a, chatId: 'a' + i }); });
        chat.messages = chat.message;
        globalThis.__lensModelCalls = 0;
        risuai.runLLMModel = async args => {
          const body = JSON.stringify(args);
          __lensModelCalls += 1;
          if (body.includes('design one')) return { type: 'success', result: JSON.stringify({ reply: '선물과 반응을 모으는 렌즈를 제안합니다.', lens: { name: '선물과 반응', description: '주고받은 물건과 반응', labels: ['선물', '반응'], evidenceMode: 'strict', instruction: { goal: '인물들이 주고받은 물건과 반응을 기록하라.' } } }) };
          if (body.includes('LIBRA LENS ANALYZER')) return { type: 'success', result: JSON.stringify({ items: [
            { label: '약속', text: '지호가 시계탑 약속을 상기시켰다.', refs: ['t1-a'], quote: '오늘 밤 시계탑에서 만나자고 약속했잖아', holder: '지호' },
            { label: '떡밥', text: '찢긴 지도의 행방을 숨긴다.', refs: ['t3-a'], basis: '질문에 시선을 피함' },
            { label: '단서', text: '범위 밖', refs: ['t9-a'], quote: '없음' }
          ] }) };
          return { type: 'success', result: '{}' };
        };
      });
      await page.evaluate(() => __approved.openApprovedPromptDialog());
      await page.waitForSelector('#dlg-prompt.is-open [data-lens-studio="list"]');
      assert.equal(await page.locator('#dlg-prompt .ps-nav').count(), 0, 'the old canonical prompt editor is gone');

      await page.locator('#dlg-prompt [data-lens-studio-view="create"]').click();
      const templates=page.locator('#dlg-prompt [data-lens-starter-template]');
      assert.equal(await templates.count(),13,'all thirteen presets are reachable at this viewport');
      const ids=await templates.evaluateAll(nodes=>nodes.map(node=>node.dataset.lensStarterTemplate));
      assert.equal(new Set(ids).size,13,'preset buttons have unique identities');
      for(const id of ['starter_body_condition','starter_promises_schedule','starter_relationship_shift','starter_belongings','starter_secrets_knowledge','starter_world_rules','starter_speech_habits','starter_conflict_arc'])
        assert.ok(ids.includes(id),'new preset is available: '+id);
      assert.deepEqual(await touching(page,'#dlg-prompt'),[],'preset buttons remain separated');

      await page.locator('#dlg-prompt [data-lens-starter-template="starter_unresolved_promises"] button.btn--primary').click();
      await page.waitForFunction(() => __approved.Gui.lensStudio?.registry?.lenses?.length === 1 && !__approved.Gui.lensStudio.busy);
      await page.locator('#dlg-prompt [data-lens-chat-input]').fill('주고받은 선물과 반응을 모아 줘');
      await page.locator('#dlg-prompt .lens-chat__compose button').click();
      await page.waitForSelector('#dlg-prompt .lens-draft');
      await page.locator('#dlg-prompt .lens-draft button', { hasText: '시험 실행' }).click();
      await page.waitForSelector('#dlg-prompt .lens-trial');
      const trialRegistry = await page.evaluate(async () => (await __approved.LibraMemoryCore.inspectScopeLenses()).memories.length);
      assert.equal(trialRegistry, 0, 'a trial run stores nothing');
      assert.deepEqual(await touching(page, '#dlg-prompt'), []);
      await page.locator('#dlg-prompt .lens-draft button', { hasText: '이 렌즈 만들기' }).click();
      await page.waitForFunction(() => __approved.Gui.lensStudio?.registry?.lenses?.length === 2 && __approved.Gui.lensStudio.view === 'list' && !__approved.Gui.lensStudio.busy);

      await page.locator('#dlg-prompt [data-lens-card="starter_unresolved_promises"] button', { hasText: '최근 5턴 분석' }).click();
      await page.waitForFunction(() => !__approved.Gui.lensStudio.busy && /저장 2개/.test(__approved.Gui.lensStudio.notice?.text || ''));
      assert.deepEqual(await touching(page, '#dlg-prompt'), []);
      assert.equal(await page.evaluate(() => { const d = document.querySelector('#dlg-prompt .dialog'); return d.scrollWidth - d.clientWidth; }), 0);

      await page.locator('#dlg-prompt [data-lens-card="starter_unresolved_promises"] button', { hasText: '일시정지' }).click();
      await page.waitForFunction(() => !__approved.Gui.lensStudio.busy && __approved.Gui.lensStudio.registry.lenses[0].status === 'paused');
      await page.locator('#dlg-prompt [data-lens-card="starter_unresolved_promises"] button', { hasText: '다시 켜기' }).click();
      await page.waitForFunction(() => !__approved.Gui.lensStudio.busy && __approved.Gui.lensStudio.registry.lenses[0].status === 'active');

      const before = await page.evaluate(() => __approved.Gui.lensStudio.registry.lenses[0].instructionRevision);
      await page.locator('#dlg-prompt [data-lens-card="starter_unresolved_promises"] button', { hasText: '편집' }).click();
      await page.locator('#dlg-prompt [data-lens-editor] textarea').first().fill('지도와 열쇠에 관한 단서와 약속만 기록하라.');
      await page.locator('#dlg-prompt .lens-editbar button', { hasText: '저장' }).click();
      await page.waitForFunction(() => !__approved.Gui.lensStudio.busy && /새 지침 버전/.test(__approved.Gui.lensStudio.notice?.text || ''));
      const saved = await page.evaluate(() => __approved.Gui.lensStudio.registry.lenses[0]);
      assert.notEqual(saved.instructionRevision, before);
      assert.equal(saved.revisionHistory.length, 2);
      await page.locator('#dlg-prompt .lens-run summary').first().click();
      await page.locator('#dlg-prompt .lens-run button', { hasText: '모델 원문 응답 보기' }).first().click();
      await page.waitForSelector('#dlg-prompt .lens-run[open] .lens-raw');

      await page.locator('#dlg-prompt [data-lens-studio-view="canonical"]').click();
      await page.waitForFunction(() => /LIBRA/.test(__approved.Gui.lensStudio.canonicalPrompt || ''));
      assert.equal(await page.locator('#dlg-prompt [data-lens-studio="canonical"] textarea, #dlg-prompt [data-lens-studio="canonical"] input').count(), 0, 'the canonical prompt is read-only');

      await page.locator('#dlg-prompt [data-lens-studio-view="list"]').click();
      await page.locator('#dlg-prompt [data-lens-card] button', { hasText: '휴지통으로' }).last().click();
      await page.waitForFunction(() => __approved.Gui.lensStudio.registry.trash.length === 1 && !__approved.Gui.lensStudio.busy);
      await page.locator('#dlg-prompt [data-lens-studio-view="trash"]').click();
      await page.locator('#dlg-prompt [data-lens-trash] button', { hasText: '복원' }).click();
      await page.waitForFunction(() => __approved.Gui.lensStudio.registry.trash.length === 0 && !__approved.Gui.lensStudio.busy);
      assert.equal(await page.evaluate(() => __approved.Gui.lensStudio.registry.lenses[1].status), 'paused', 'a restored lens comes back paused');

      await page.locator('#dlg-prompt .dialog__actions button').click();
      await page.evaluate(() => { __approved.selectBookMemoryKind('lens'); __approved.bookNavigate('memory'); });
      await page.waitForSelector('[data-lens-reader] .lens-item');
      assert.equal(await page.locator('[data-lens-reader] .lens-item').count(), 2);
      assert.equal(await page.locator('[data-lens-reader] .lens-item').filter({ hasText: '이전 지침으로 생성' }).count(), 2, 'records from the old instruction are marked');
      assert.match(await page.locator('[data-lens-reader] .lens-extra__pair').first().innerText(), /^당사자 지호$/, 'a known extra key is shown with its Korean label');
      await page.locator('[data-lens-reader] .lens-prov summary').first().click();
      await page.waitForSelector('[data-lens-reader] .lens-prov .lens-source mark');
      await page.waitForSelector('[data-lens-reader] .lens-prov .lens-diff');
      assert.deepEqual(await touching(page, '[data-lens-reader]'), []);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), 0);
      assert.deepEqual(errors, []);
      console.log(JSON.stringify({ test: 'libra_lens_studio_browser', width, ok: true }));
    } finally {
      await browser.close();
    }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });

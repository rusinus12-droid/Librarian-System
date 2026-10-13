'use strict';
const assert = require('node:assert/strict');
let JSDOM;
({ JSDOM } = require('jsdom'));
const { createFixture } = require('./fixtures/lia_native_runtime_fixture.cjs');
const expose = source => source.replace('      getLiveSyncCaptureState:', `
      manualUi: async () => renderPreview(await getContext(), {skipCapture:true}),
      getLiveSyncCaptureState:`);

(async () => {
  const f = await createFixture('official', { transformSource: expose });
  const dom = new JSDOM('<!doctype html><html><body><div id="dpg-preview-root"></div></body></html>', { pretendToBeVisual: true });
  f.context.document = dom.window.document;
  f.context.HTMLElement = dom.window.HTMLElement;
  f.context.HTMLInputElement = dom.window.HTMLInputElement;
  f.context.HTMLTextAreaElement = dom.window.HTMLTextAreaElement;
  f.context.HTMLSelectElement = dom.window.HTMLSelectElement;
  try {
    const originalPersona = JSON.stringify(f.db.personas);
    const originalChatBinding = f.liveChat.bindedPersona;
    const html = await f.runtime.manualUi();
    assert.match(html, /data-page="update"/, 'the approved update route is rendered');
    assert.match(html, /id="upd-go"/, 'the explicit five-pair action is mounted');
    assert.match(html, /완결된 User\+Assistant 5쌍/, 'the route explains the bounded pair contract');
    assert.doesNotMatch(html, /다음 실제 모델 요청 직전에 발송 Prompt까지 검증|요청 직전 실제 적용 여부를 증명/, 'manual UI does not promise retired automatic proof tracking');
    assert.match(html, /id="job-update"[\s\S]*?data-job-cancel/, 'the update job exposes its supported cancellation action');
    assert.doesNotMatch(html, /실시간 동기화 켜기|실시간 동기화 다시 켜기|5턴마다 상태를 갱신해요|role="switch"[^>]*aria-label="Live Sync"/, 'the retired automatic controls are absent');
    assert.match(html, /data-page="recover"/, 'the adopted Recovery route remains reachable; its mounted data panel is verified in Chromium');
    assert.match(html, /data-subpanel="full"/, 'the full-chat review subpage remains separate from five-pair updates');
    assert.equal(JSON.stringify(f.db.personas), originalPersona, 'opening the UI does not mutate Personas');
    assert.equal(f.liveChat.bindedPersona, originalChatBinding, 'opening the UI does not replace bindings');
    f.liveChat.message.splice(6);
    const short = await f.runtime.manualUi();
    assert.match(short, /완결된 다음 3쌍/, 'insufficient complete pairs are counted');
    assert.match(short, /2쌍이 더 완결되어야 합니다/, 'the missing-pair reason is visible');
    const ids = [...short.matchAll(/\bid="([^"]+)"/g)].map(row => row[1]);
    assert.equal(new Set(ids).size, ids.length, 'manual controls retain unique IDs');
    console.log('PASS LiA manual analysis UI: bounded range, short-batch explanation, cancel, backend and Evolution retained');
  } finally { await f.dispose(); dom.window.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });

'use strict';
const assert = require('node:assert/strict');
const { createFixture } = require('./fixtures/lia_native_runtime_fixture.cjs');
const expose = source => source.replace('      getLiveSyncCaptureState:', `
      manualUi: async () => { activeWorkspaceTab = 'realtime'; preservedLLMResultText = JSON.stringify({personaName:'Draft', personaPrompt:'Draft body', personaSpec:{name:'Draft',role:'Traveler',personality:'Careful'}}); return renderPreview(await getContext(), {skipCapture:true}); },
      getLiveSyncCaptureState:`).replace('  function getLLMResultOverride() {\n    if (typeof document === "undefined") return null;', '  function getLLMResultOverride() {\n    if (typeof document === "undefined") return parseLLMResult(preservedLLMResultText);');

(async () => {
  const f = await createFixture('official', { transformSource: expose });
  try {
    const originalPersona = JSON.stringify(f.db.personas);
    const originalChatBinding = f.liveChat.bindedPersona;
    const html = await f.runtime.manualUi();
    assert.match(html, /Persona 수동 갱신/, 'the existing state engine is presented as manual updates');
    assert.match(html, /TURN 1~5/, 'the next update range is visible before clicking');
    assert.match(html, /다음 5턴 분석·갱신/, 'the explicit action states its bounded work');
    assert.doesNotMatch(html, /다음 실제 모델 요청 직전에 발송 Prompt까지 검증|요청 직전 실제 적용 여부를 증명/, 'manual UI does not promise retired automatic proof tracking');
    assert.match(html, /id="dpg-live-cancel"/, 'manual analysis has a cancellation control');
    assert.doesNotMatch(html, /실시간 동기화 켜기|실시간 동기화 다시 켜기|5턴마다 상태를 갱신해요|role="switch"[^>]*aria-label="Live Sync"/, 'the retired automatic controls are absent');
    assert.match(html, /liaMemorySuiteServerConnectionPanel/, 'server configuration remains');
    assert.match(html, /dpg-run-persona-evolution/, 'separate manual Evolution remains');
    assert.equal(JSON.stringify(f.db.personas), originalPersona, 'opening the UI does not mutate Personas');
    assert.equal(f.liveChat.bindedPersona, originalChatBinding, 'opening the UI does not replace bindings');
    f.liveChat.message.splice(6);
    const short = await f.runtime.manualUi();
    assert.match(short, /3\/5|3 \/ 5/, 'insufficient turns are counted');
    assert.match(short, /2턴.*필요|2턴.*더/, 'the missing-turn reason is visible');
    const ids = [...short.matchAll(/\bid="([^"]+)"/g)].map(row => row[1]);
    assert.equal(new Set(ids).size, ids.length, 'manual controls retain unique IDs');
    console.log('PASS LiA manual analysis UI: bounded range, short-batch explanation, cancel, backend and Evolution retained');
  } finally { await f.dispose(); }
})().catch(error => { console.error(error); process.exitCode = 1; });

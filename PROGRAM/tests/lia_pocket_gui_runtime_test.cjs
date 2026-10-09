'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {createFixture} = require('./fixtures/lia_native_runtime_fixture.cjs');
const source = fs.readFileSync(path.join(__dirname,'../plugins/LIA_Persona_Linker.js'),'utf8');
(async () => {
  const fixture = await createFixture('official', {transformSource: s => s.replace('      getLiveSyncCaptureState:', `      pocketRender: async tab => { activeWorkspaceTab = tab; return renderPreview(await getContext(), {skipCapture:true}); },
      pocketDraft: () => { preservedLLMResultText = JSON.stringify({personaName:'Draft',personaPrompt:'Preserved draft body'}); },
      pocketHeader: () => renderPocketHeader(),
      pocketToggle: async () => togglePocketLiveSync(await getContext()),
      pocketServer: async () => {
        let markup=''; const stop = new Error('markup captured');
        const container={get innerHTML(){return markup},set innerHTML(value){markup=value},querySelector(){throw stop}};
        try { await MemorySuiteStorageBridge.mountConnectionPanel(container,{title:'저장과 서버',description:'이 채팅의 기억을 어디에 보관할까요?',computeBridge:MemorySuiteLiaComputeBridge}); } catch(error) { if(error!==stop) throw error; }
        return markup;
      },
      pocketPreview: async () => {
        activeWorkspaceTab = 'home';
        const ctx = await getContext();
        ctx.db.personas = ctx.db.personas.map(p => ({...p, name:'서윤',note:'조용한 호기심을 가진 기록가'}));
        ctx.chat = {...ctx.chat,name:'서재의 밤'};
        ctx.livePersonaBinding = {...ctx.livePersonaBinding, lastProcessedPairCount:2,liveState:[{category:'역할',value:'기록회에서 고문서 정리를 맡고 있어요.'},{category:'현재 목표',value:'등대에 지도를 전달하려고 해요.'}]};
        ctx.savedResultVault = ['서윤','하린','도윤','유하'].map((name,i)=>({id:'preview-'+i,title:name,personaName:name,personaPrompt:'기록을 사랑하는 여행자',generationMode:'classic',personaSpec:{name,role:'기록가',personality:'차분하고 호기심이 많아요.'}}));
        preservedLLMResultText = JSON.stringify({personaName:'서윤',personaPrompt:'차분한 호기심으로 낯선 세계를 기록한다. 대화 상대의 이야기를 귀 기울여 듣고 스스로 판단한다.',personaSpec:{name:'서윤',role:'기록가',personality:'차분하고 호기심이 많다.',appearance:'짙은 머리와 담담한 눈빛.',background:'기록회에서 고문서를 정리하며 지도를 모은다.'}});
        return renderPreview(ctx,{skipCapture:true});
      },
      pocketHome: (ctx,tab) => renderPocketHome(ctx,tab),
      getLiveSyncCaptureState:`).replace('  function getLLMResultOverride() {\n    if (typeof document === "undefined") return null;', '  function getLLMResultOverride() {\n    if (typeof document === "undefined") return parseLLMResult(preservedLLMResultText);')});
  try {
    const pages = {};
    for (const tab of ['home','generate','edit','realtime','assets','vault','settings','server']) {
      const html = await fixture.runtime.pocketRender(tab);
      assert(html.includes(`data-page="${tab}"`));
      const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(x=>x[1]);
      assert.equal(new Set(ids).size,ids.length,`no duplicate IDs: ${tab}`);
      const nav = html.match(/<nav class="lia-pocket-nav"[\s\S]*?<\/nav>/)[0];
      assert.equal((nav.match(/<button /g)||[]).length,4);
      for(const id of ['dpg-live-enable','dpg-live-cancel','dpg-live-restore','dpg-live-run-now','dpg-vault-load','liaMemorySuiteServerConnectionPanel']) assert(ids.includes(id),id);
      pages[tab]=html;
    }
    fixture.runtime.pocketDraft();
    for (const tab of ['edit','home','settings','edit']) {
      const html = await fixture.runtime.pocketRender(tab);
      assert(html.includes('Preserved draft body'), 'draft preserved across routes');
      assert(html.includes('id="dpg-save-current-persona"'), 'editor retains actual save action');
    }
    assert(pages.home.includes('Fixture Chat'));
    const malicious = fixture.runtime.pocketHome({db:{personas:[]},char:{name:'<script>bad</script>'},chat:{name:'<img src=x onerror=bad>'}},'home');
    assert(!malicious.includes('<script>bad'));
    assert(malicious.includes('&lt;img'));
    if(process.env.LIA_POCKET_PREVIEW) {
      const start=source.indexOf('      <style>',source.indexOf('  async function openUI()'));
      const end=source.indexOf('      </style>',start)+14;
      const activate=source.slice(source.indexOf('  function activateTab(name)'),source.indexOf('  function bindAction(id'));
      const primary=source.slice(source.indexOf('  function pocketPrimaryTab(tab)'),source.indexOf('  function renderPocketHome('));
      const serverMarkup = await fixture.runtime.pocketServer();
      const script=`let activeWorkspaceTab='home',preservedWorldDrawerOpen=false; const keepActiveMobileSidebarTabVisible=()=>{},mountLiaServerConnectionPanel=()=>{},hydrateVisualAssetThumbnails=async()=>{};${primary}${activate}
      document.querySelectorAll('[data-pocket-tab],[data-workspace-tab]').forEach(b=>b.onclick=()=>activateTab(b.dataset.pocketTab||b.dataset.workspaceTab));
      document.querySelectorAll('[data-pocket-personas]').forEach(b=>b.onclick=()=>{document.querySelector('.lia-app-layout').classList.add('persona-panel-open');syncPocketPersonaDialog(true);});
      document.getElementById('dpg-persona-panel-toggle').onclick=()=>document.querySelector('.lia-app-layout').classList.toggle('persona-panel-open');
      document.getElementById('dpg-persona-panel-close').onclick=()=>{document.querySelector('.lia-app-layout').classList.remove('persona-panel-open');syncPocketPersonaDialog(false);};
      document.getElementById('dpg-world-drawer-open').onclick=()=>document.querySelector('.lia-app-layout').classList.add('world-drawer-open');
      document.getElementById('dpg-world-drawer-close').onclick=()=>document.querySelector('.lia-app-layout').classList.remove('world-drawer-open');
      document.querySelectorAll('[data-editor-section]').forEach(b=>{if(b.tagName==='BUTTON')b.onclick=()=>document.querySelector('.lia-result-card').dataset.editorSection=b.dataset.editorSection});
      document.querySelectorAll('[data-vault-card-id]').forEach(b=>b.onclick=()=>{document.querySelectorAll('[data-vault-card-id]').forEach(c=>c.classList.toggle('active',c===b));document.querySelector('.lia-vault-tools').open=true;});
      document.getElementById('lia-pocket-sync-toggle').onclick=()=>{const el=document.getElementById('dpg-status');el.removeAttribute('data-idle');el.textContent='격리 미리보기에서는 저장 및 AI 호출을 하지 않습니다.';};
      document.getElementById('dpg-pocket-width').onclick=()=>document.querySelector('.lia-shell').classList.toggle('pocket-wide');`;
      const preview = (await fixture.runtime.pocketPreview()).replace('<div id="liaMemorySuiteServerConnectionPanel"><section class="lia-panel"><strong>저장 및 연산 설정을 불러오는 중…</strong></section></div>',`<div id="liaMemorySuiteServerConnectionPanel">${serverMarkup}</div>`);
      fs.writeFileSync(process.env.LIA_POCKET_PREVIEW,`<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>LIA 실제 GUI · 테스트 데이터</title>${source.slice(start,end)}<main class="lia-shell">${fixture.runtime.pocketHeader()}<div id="dpg-status" data-idle="true">격리 GUI 미리보기</div><div id="dpg-preview-root">${preview}</div></main><script>${script}</script></html>`);
    }
    const originalBound=fixture.liveChat.bindedPersona;
    const before=JSON.stringify([...fixture.values].filter(([key])=>key.startsWith('liaPersonaLinkerLivePersona')));
    assert.equal((await fixture.runtime.pocketToggle()).needsSetup,true,'home opens the manual review page');
    assert.equal((await fixture.runtime.pocketToggle()).needsSetup,true,'repeated home actions never toggle persisted metadata');
    assert.equal(JSON.stringify([...fixture.values].filter(([key])=>key.startsWith('liaPersonaLinkerLivePersona'))),before,'home action leaves stored state untouched');
    assert.equal(fixture.liveChat.bindedPersona,originalBound,'home action preserves existing persona');
    console.log('PASS LIA Pocket GUI: 8 actual render routes, unique IDs, retained action controls, escaped host text');
  } finally {await fixture.dispose();}
})().catch(e=>{console.error(e);process.exitCode=1;});

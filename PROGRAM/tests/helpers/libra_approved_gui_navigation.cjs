'use strict';
// Explicit destinations/labels from the approved Settings navigation, not aliases
// injected into the product DOM. Every step clicks a real current control.
const assert=require('node:assert/strict');
const {pause,until}=require('../fixtures/libra_gui_memory_dom_host.cjs');
const groups={ai:'ai',embedding:'ai',memory:'mem',pipeline:'mem',logs:'mem',references:'ref',source_edits:'ref',server:'store',recovery:'store',transfer:'store',state:'adv',general:'adv'};
const labels={ai:'AI 연결',embedding:'임베딩 연결',memory:'성능 프리셋',pipeline:'기억 분석',logs:'기록 보관소',references:'참고 자료',source_edits:'분석할 내용',server:'서버 · 저장',recovery:'백업 · 복구',transfer:'데이터 이동',state:'현재 상태 적용',general:'일반 · 진단'};
async function goSettings(s,section='memory'){
 if(section==='performance')section='memory';assert.ok(groups[section],`approved setting ${section}`);
 await s.click('.sidebar [data-go="settings"]');await s.click(`.setnav [data-subtab="${groups[section]}"]`);
 if(s.doc.querySelector('[data-product-settings-section]')?.dataset.productSettingsSection!==section){const button=[...s.doc.querySelectorAll('[data-product-settings-section] > nav.tabs > button')].find(node=>node.textContent===labels[section]);assert.ok(button,`visible current setting tab ${labels[section]}`);button.click();await until(()=>s.doc.querySelector('[data-product-settings-section]')?.dataset.productSettingsSection===section,'setting route '+section);await pause(40);}
 if(section==='memory'){const originalFold=s.doc.querySelector('[data-settings-category="mem"] details.fold');if(originalFold){originalFold.open=true;originalFold.dispatchEvent(new s.dom.window.Event('toggle'));}const maintenance=s.doc.querySelector('[data-memory-maintenance]');if(maintenance){maintenance.open=true;maintenance.dispatchEvent(new s.dom.window.Event('toggle'));}await pause(40);}
}
function field(s,label){return [...s.doc.querySelectorAll('.page[data-page="settings"] .field,.page[data-page="settings"] .setting')].find(node=>node.querySelector('label')?.textContent===label||node.querySelector('.setting__name')?.textContent===label)?.querySelector('input,select,textarea');}
module.exports={goSettings,field};

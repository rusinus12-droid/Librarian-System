'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {loadGui}=require('./libra_management_gui_integration_test.cjs');
test('log navigation warns about the preserved manual-view cancellation guard before entry',async()=>{const f=await loadGui({nativeInitialization:true,store:new Map()});try{const nav=f.overlay.querySelector('[data-tab="logs"]');assert(nav);assert.match(nav.title,/수동 재분석.*중단/);assert.match(nav.getAttribute('aria-label'),/수동 재분석.*중단/);nav.click();const hint=f.overlay.querySelector('#oplog-navigation-note');assert(hint);assert(hint.textContent.includes('화면에 연결된 수동 재분석은 로그 탭으로 이동하면 중단됩니다.'));assert(hint.textContent.includes('조회·검색·필터·표시 비우기는 작업이나 저장 데이터를 바꾸지 않습니다.'));}finally{f.close();}});

'use strict';
// The GUI names each stored response by its turn and capture path, not by the title fixed at
// capture time ("RisuAI 커밋 응답 리비전 <host-locale date>", "채팅 응답: <chat> #n"), shows the
// "User: … --- Assistant: …" body as two labelled lines, and keeps unpriced costs and lineage
// reason codes readable. Found by the real-data GUI check (docs/FLASHBACK_GUI_REAL_DATA_CHECK_20261018.md).
const assert=require('node:assert/strict');const {createFixture}=require('./fixtures/flashback_native_runtime_fixture.cjs');
(async()=>{const f=await createFixture();try{const t=f.api._test;
const imported={sourceType:'response',title:'채팅 응답: 항구 마을 이야기 #3',sourceId:'live_chat:nzyzrk:4-5:1csnwhv',origin:'live_chat:getChatFromIndex',turnIndex:3};
const live={sourceType:'response',title:'RisuAI 커밋 응답 리비전 10/18/2026, 2:21:16 PM',sourceId:'risu_chat_output_revision:13r1hut',origin:'risu_chat_output',turnIndex:7};
const finalized={...live,sourceId:'finalized_response:abc',turnIndex:8};
const inherited={...imported,inheritedFromScopeKey:'char:a|chat:old',turnIndex:2};
const episode={sourceType:'episode_index',title:'Episode 1 · turn 1-9',turnRange:{start:1,end:9}};
assert.deepEqual([imported,live,finalized,inherited].map(t.memoryRecordDisplayTitle),['T3 · 기존 대화 가져오기','T7 · 실시간 캡처','T8 · 실시간 캡처','T2 · 이전 채팅']);
assert.match(t.memoryRecordDisplayTitle(episode),/^.+ · T1–T9$/,'an episode index shows the turns it covers');
assert.equal(t.turnPairDisplayText('User: 묵을 곳은? --- Assistant: 등대 여관입니다.'),'사용자 · 묵을 곳은?\n응답 · 등대 여관입니다.');
assert.equal(t.turnPairDisplayText('plain memory text'),'plain memory text','non-turn text is unchanged');
assert.equal(t.formatCostSummary({tokens:96,estimatedUsd:null,unsupportedGroups:1}),'단가 미설정','an unpriced model is not "$0 known" or "N/A"');
assert.equal(t.formatCostSummary({tokens:96,estimatedUsd:0.0123,unsupportedGroups:0}),'$0.012');
assert.equal(t.formatCostSummary({tokens:96,knownEstimatedUsd:0.5,unsupportedGroups:1}),'$0.500 + 단가 미설정분');
assert.match(t.formatGuiDateTime('2026-10-18T05:21:16.470Z'),/^2026\. 10\. 18\. (?:오전|오후) \d{2}:\d{2}$/,'dates use the Korean format');
assert.equal(t.formatGuiDateTime(''),'-');
assert.equal(t.flashbackLineageReasonLabel('no_native_branch_marker'),'독립 채팅 · RisuAI 분기 표식 없음 (no_native_branch_marker)');
assert.equal(t.flashbackLineageReasonLabel('future_reason'),'future_reason','an unknown code is shown as is');
console.log('PASS flashback_gui_record_display_test');
}finally{await f.dispose();}})().catch(e=>{console.error(e.stack);process.exitCode=1;});

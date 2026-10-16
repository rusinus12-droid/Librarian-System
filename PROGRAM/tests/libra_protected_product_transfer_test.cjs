'use strict';
// Whole-unit evidence now obeys the common compiler's envelope budget. There
// is no oversized-first-row bypass or separate Classic evidence renderer.
const {test}=require('node:test'),assert=require('node:assert/strict');
const {fixture}=require('./fixtures/libra_unified_runtime_fixture.cjs');
const {actualClassicPacket}=require('./fixtures/libra_actual_classic_request.cjs');
test('actual Classic delivers whole common-engine units and retains envelope admission',async t=>{
 const f=await fixture();t.after(()=>f.r.cleanup());await f.run();
 const tiny=await f.r.api.previewUnifiedMemoryRecall({queryText:'민아 은빛 열쇠',consumerPolicy:{consumer:'classic',maxCharacters:32}});
 assert.ok(tiny.packet.characterLength<=32);assert.equal(tiny.bundle.items.length,0);
 const packet=await actualClassicPacket(f,'민아 지호 신뢰 은빛 열쇠',f.getManifest().scopeKey);
 assert.ok(packet.actualClassic.block.length<=20000);
 for(const row of packet.actualClassic.deliveredRows)assert.ok(packet.actualClassic.block.includes(row.selectedText));
 assert.doesNotMatch(packet.actualClassic.block,/SGA_PRIVATE_ANALYSIS|LIBRA_CURRENT_TURN_PLANNER|CURRENT STATE HEAD/);
});

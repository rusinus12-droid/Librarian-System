'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {load}=require('./host.cjs');
const prefix='serial_gradation_agents_for_rp:';
const memory={
 [prefix+'story_arcs:v2']:'{"private":"LEGACY_ARC_SENTINEL"}',
 [prefix+'narrative_archives:v1']:'{"private":"LEGACY_ARCHIVE_SENTINEL"}',
 [prefix+'writer_designs:v1']:'{"designs":{"legacy":{"summary":"LEGACY_WRITER_SENTINEL"}}}',
 [prefix+'native_chat_copy_registry:v1']:'{"legacy":"COPY_PROOF_BYTES"}',
 [prefix+'retrace_handoff:package:old']:'{"legacy":"OLD_PACKAGE_BYTES"}'
};
test('startup and ordinary GUI state leave all removed-feature records byte unchanged',async()=>{
 const h=await load({storage:memory});
 for(const [key,value] of Object.entries(memory))assert.equal(h.store.get(key),value);
 assert.ok(!h.accesses.some(([op,key])=>op!=='read'&&Object.hasOwn(memory,key)));
 assert.ok(!h.plugin.getGuiPageRegistry().some(p=>['arc','embedding','narrative_archive'].includes(p.id)));
 assert.equal(h.plugin.getRuntime().writerControl,undefined);assert.equal(h.plugin.getRuntime().arcDirector,undefined);assert.equal(h.getCalls(),0);
});
test('legacy imported role flags and stage slots cannot restore removed features',async()=>{
 const h=await load();
 await h.plugin.saveRuntimeSettings({arc_director_enabled:true,writer_enabled:true,output_mode:'risu_engine',information_transfer_mode:'draft_and_analysis'});
 const settings=await h.plugin.getRuntimeSettings();assert.equal(settings.arc_director_enabled,undefined);assert.equal(settings.writer_enabled,undefined);
 assert.equal(settings.output_mode,'draft_guided');assert.equal(settings.information_transfer_mode,'draft_only');
 await h.plugin.saveAgentSlots({arc_director:{enabled:true},writer:{enabled:true},shadow_act:{enabled:true,turn_window:5}});
 const slots=await h.plugin.getAgentSlots();assert.equal(slots.arc_director,undefined);assert.equal(slots.writer,undefined);assert.equal(slots.shadow_act.turn_window,5);
});
test('explicit current-settings reset does not delete removed-feature user records',{skip:process.env.GRADIA_BUILD_FLAVOR==='Min'},async()=>{
 const h=await load({storage:memory,captureInternals:true});
 await h.internals.clearStructuredSettings(false);
 for(const [key,value] of Object.entries(memory))assert.equal(h.store.get(key),value);
 assert.equal(h.getCalls(),0);
});

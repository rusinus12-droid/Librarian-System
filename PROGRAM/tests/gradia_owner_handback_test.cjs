'use strict';
// When GRADIA reads no memory or stops, no owner store is read and GRADIA never sends attach/delivery control signals to owners.
const {test}=require('node:test'),assert=require('node:assert/strict');
const {fixture}=require('./fixtures/gradia_input_writer_unified_fixture.cjs');
const controlSignals=f=>f.bus.messages.filter(m=>m.body.kind==='request'&&['attach','delivered'].includes(m.body.action));
const reads=f=>f.bus.messages.filter(m=>m.body.kind==='request'&&['capture','select'].includes(m.body.action)).length;
const pipeline={mode:'lite',default_preset:'writer',input_assist_mode:'off',multi_pipeline_mode:'lightweight',enable_shadow_act:true,enable_character_aide:false,enable_world_aide:false,enable_plot_aide:false,failure_mode:'soft',lore_activation_mode:'off'};
const request=f=>{if(!f.chat.message.some(m=>m.chatId==='u9'))f.chat.message.push({role:'user',chatId:'u9',data:'민아에게 열쇠를 건넨다.'});return f.host.hooks.beforeRequest(f.chat.message.map(row=>({role:row.role,content:row.data,chatId:row.chatId,messageId:row.chatId})),'model');};
async function ready(t){const f=await fixture(t);f.controls.output='민아는 은빛 열쇠를 확인하고 문 앞에서 기다렸다. The grounded scene continued in the quiet room.';await f.host.plugin.saveRuntimeSettings({...await f.host.plugin.getRuntimeSettings(),...pipeline});return f;}
test('every owner turned off: no owner is read, no memory is injected, and owners keep their own recall',async t=>{
 const f=await ready(t);
 await f.host.plugin.openSettingsGui();f.document.querySelector('.sidebar [data-go="sources"]').click();
 for(const box of f.document.querySelectorAll('[data-lib-draft-owner]')){box.checked=false;box.dispatchEvent(new f.dom.window.Event('change',{bubbles:true}));}
 f.document.querySelector('#lib-connect').click();
 await f.wait(()=>f.host.plugin.getLibReadOnlyStatus().connection.draftReadOwners.length===0&&['connected','error'].includes(f.host.plugin.getLibReadOnlyStatus().connection.state),'owners off');
 await f.host.plugin.closeSettingsGui();
 f.bus.messages.length=0;f.prompts.length=0;const before=f.queries();
 const output=await request(f);
 assert.equal(reads(f),0,'no owner is asked');assert.equal(f.queries(),before,'no owner store is read');
 assert.ok(!output.some(row=>String(row.content||'').includes('<MEMORY_RECALL>')));
 assert.ok(f.prompts.length>=1,'GRADIA itself still runs');assert.ok(!JSON.stringify(f.prompts).includes('WRITER_OWNER_EVIDENCE'));
 assert.equal(controlSignals(f).length,0,'GRADIA sends no attach or delivery control signals');
});
test('while reading or turning GRADIA off, GRADIA only queries memory for drafting and never controls owner hooks',async t=>{
 const f=await ready(t);f.bus.messages.length=0;
 const output=await request(f);
 assert.ok(reads(f)>0,'GRADIA queries enabled owners for drafting');
 assert.ok(!output.some(row=>String(row.content||'').includes('<MEMORY_RECALL>')),'GRADIA does not re-inject memory into final response');
 assert.equal(controlSignals(f).length,0,'GRADIA never sends attach/delivered messages');
 await f.host.plugin.saveRuntimeSettings({mode:'off'});f.bus.messages.length=0;await request(f);
 assert.equal(reads(f),0,'turning GRADIA off stops reading owners');
 assert.equal(controlSignals(f).length,0);
});
test('unloading GRADIA disposes reader cleanly without sending attach control messages',async t=>{
 const f=await ready(t);await request(f);f.bus.messages.length=0;
 for(const unload of f.unloads.splice(0))await unload();
 assert.equal(controlSignals(f).length,0);
});

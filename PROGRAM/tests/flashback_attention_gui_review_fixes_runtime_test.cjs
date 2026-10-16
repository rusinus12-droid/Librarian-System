'use strict';
// Public entry points and real DOM events; works with both emitted Full and Min.
const assert=require('node:assert/strict');
const {test}=require('node:test');
const {create,until,pause}=require('./fixtures/libra_gui_memory_dom_host.cjs');
const kind=process.env.FLASHBACK_ATTENTION_PROFILE||'Full';
const history=()=>[{role:'user',chatId:'u1',data:'Where is the brass key?'},{role:'char',chatId:'a1',data:'The brass key is under the blue sundial.'}];
const id='vector-rag-memory-attention';
async function boot() {
  const f=await create('Flashback',kind,{initialChat:history()});
  const parts=new Map(f.regs.filter(p=>p.id===id).map(p=>[p.id,p]));
  const register=f.host.registerButton.bind(f.host),unregister=f.host.unregisterUIPart.bind(f.host);
  f.host.registerButton=async(spec,callback)=>{if(spec.id===id)parts.set(id,{...spec,callback});return await register(spec,callback);};
  f.host.unregisterUIPart=async key=>{parts.delete(key);return await unregister(key);};
  return {f,parts};
}
for(const previous of ['srv','mig'])test(`${kind}: embedding warning opens embedding panel after ${previous}`,async()=>{
  const {f,parts}=await boot();try{
    await f.open();
    await f.click('[data-go="connect"]');
    await f.click(`[data-subtab="${previous}"][data-group="c"]`);
    await f.api.closeUi();
    await f.api.ingestLiveChatColdStart({scope:'current',skipEpisodeRebuild:true,skipGuiRefresh:true});
    await until(()=>parts.get(id)?.name.includes('임베딩 제공자 설정 필요'),'provider attention');
    parts.get(id).callback();
    await until(()=>f.doc.querySelector('[data-subpanel="emb"][data-group="c"].is-active'),'embedding panel visible');
    assert.equal(f.doc.querySelector(`[data-subpanel="${previous}"][data-group="c"]`).classList.contains('is-active'),false);
    assert.equal(f.wire.length,0,'opening the warning never starts provider work');
    assert.equal(f.errors.length,0);
  }finally{await f.close();}
});
test(`${kind}: raw recovery removes the existing cold-start button automatically`,async()=>{
  const {f,parts}=await boot();try{
    await f.api.saveSettings({...await f.api.loadSettings(),embeddingEnabled:false});
    await until(()=>parts.get(id)?.name.includes('지난 1턴'),'cold-start warning');
    await f.api.ingestLiveChatColdStart({scope:'current',skipEpisodeRebuild:true,skipGuiRefresh:true});
    await until(()=>!parts.has(id),'resolved attention is unregistered');
    assert.equal(f.wire.length,0);assert.equal(f.errors.length,0);
  }finally{await f.close();}
});
test(`${kind}: public archive restore is healthy after logical inheritance`,async()=>{
  const {f,parts}=await boot();try{
    await f.api.saveSettings({...await f.api.loadSettings(),embeddingEnabled:false});
    await f.api.ingestLiveChatColdStart({scope:'current',skipEpisodeRebuild:true,skipGuiRefresh:true});
    const backup=await f.context.__FlashbackPortableMemoryBackup.exportCurrentScope();
    const chat=await f.host.getChat();chat.id='restored-copy';chat.chatId=chat.id;
    // A migration starts in an empty target. Restore its visible transcript only
    // afterwards, so the host's independent native-copy observer cannot prefill it.
    chat.message=[];chat.messages=chat.message;
    await f.api.resolveCurrentScope(true);
    assert.equal((await f.context.__FlashbackPortableMemoryBackup.restoreCurrentScope(backup,{mode:'chat_migration_archive'})).ok,true);
    chat.message=history();chat.messages=chat.message;
    await f.api.retireExternalSources(await f.api.resolveCurrentScope(true));
    // A public settings commit schedules a fresh inspection after restore too.
    await f.api.saveSettings(await f.api.loadSettings());
    await pause(450);
    assert.equal(parts.has(id),false,'inherited source is not offered for duplicate ingestion');
    assert.equal(f.wire.length,0);assert.equal(f.errors.length,0);
  }finally{await f.close();}
});

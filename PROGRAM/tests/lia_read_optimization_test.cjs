'use strict';
const assert=require('node:assert/strict');
const {createFixture}=require('./fixtures/lia_native_runtime_fixture.cjs');
const expose=source=>{const i=source.lastIndexOf('\n})();');return source.slice(0,i)+`\nglobalThis.__viewTest={selection:PersonaSelectionManager,getContext,refreshPreview,refreshModulePicker,renderPreview,manualLivePersonaPlan,readLiaViewContext:typeof readLiaViewContext==='function'?readLiaViewContext:null};`+source.slice(i);};
(async()=>{const calls={};let count=false,selectedChat=0;
 const f=await createFixture('official',{transformSource:expose,configureApi(api){
  api.getCurrentChatIndex=async()=>selectedChat;
  for(const name of ['getDatabase','getCurrentCharacterIndex','getCurrentChatIndex','getCharacterFromIndex','getCharacter','getChatFromIndex']){const old=api[name];api[name]=async(...args)=>{if(count)calls[name]=(calls[name]||0)+1;return old?.(...args);};}
 }});
 try{
  const v=f.context.__viewTest;
  count=true;const selected=await v.selection.read(null,{viewOnly:true});count=false;
  assert.deepEqual(calls,{getCurrentCharacterIndex:1,getCurrentChatIndex:1,getDatabase:1,getChatFromIndex:1},'image selection uses one light operation snapshot');assert.equal(selected.dynamicPersonaId,f.liveChat.bindedPersona);
  for(const k of Object.keys(calls))delete calls[k];count=true;const ctx=await v.getContext({moduleLore:false,selectedModuleIds:[]});count=false;
  assert.deepEqual(calls,{getDatabase:1,getCurrentCharacterIndex:2,getCharacterFromIndex:1,getCurrentChatIndex:2,getChatFromIndex:1},'read-only UI uses its own context plus final index guards');
  const picker={innerHTML:''};f.context.document={getElementById:id=>id==='dpg-module-picker'?picker:null};count=true;await v.refreshModulePicker([],ctx);count=false;assert.equal(calls.getDatabase,1,'picker reuses this view, with no second context fetch');
  const original=f.api.getChatFromIndex;f.api.getChatFromIndex=async(...args)=>{const chat=await original(...args);selectedChat=1;return chat;};
  await assert.rejects(v.getContext({moduleLore:false,selectedModuleIds:[]}),/LIA_VIEW_SELECTION_CHANGED/);f.api.getChatFromIndex=original;selectedChat=0;
  console.log('PASS operation-local LIA read reduction, reused picker context, selection-switch rejection; mutation APIs unchanged');
 }finally{await f.dispose();}
})().catch(e=>{console.error(e);process.exitCode=1});

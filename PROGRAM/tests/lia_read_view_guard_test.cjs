'use strict';
const assert=require('node:assert/strict');
const {createFixture}=require('./fixtures/lia_native_runtime_fixture.cjs');
const expose=source=>{const i=source.lastIndexOf('\n})();');return source.slice(0,i)+`\nglobalThis.__guardTest={refreshPreview,hook:handlePersonaEmotionAssetAfterRequest,setContextReader:fn=>{getContext=fn;},setRender:fn=>{renderPreview=fn;},setBinder:fn=>{bindPreviewTools=fn;},setPicker:fn=>{refreshModulePicker=fn;},setImageInsert:fn=>{insertRuntimeEmotionAssetsIntoScenes=fn;}};`+source.slice(i);};
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};};
(async()=>{let selectedChat=0;const f=await createFixture('official',{transformSource:expose,configureApi(api,{values,liveChat}){
 api.getCurrentChatIndex=async()=>selectedChat;
 values.set('liaPersonaIllustrationConfigV1',JSON.stringify({runtimeAttachEnabled:true}));
 values.set('liaPersonaVisualAssetStoreV1',JSON.stringify({version:1,sets:{fixture:{personaKey:'fixture',personaId:liveChat.bindedPersona,personaName:'Source Persona',images:{neutral:{emotion:'neutral',assetPath:'image.png',assetName:'persona_neutral'}}}}}));
}});try{
 const t=f.context.__guardTest;const root={innerHTML:''};f.context.document={getElementById:id=>id==='dpg-preview-root'?root:null,querySelectorAll:()=>[]};
 const a=deferred(),b=deferred();let call=0;t.setContextReader(()=>++call===1?a.promise:b.promise);
 t.setRender(ctx=>ctx.name);t.setBinder(()=>{});t.setPicker(async()=>{});
 const first=t.refreshPreview({skipCapture:true}),second=t.refreshPreview({skipCapture:true});
 b.resolve({name:'new',contextOptions:{},loreCandidates:[],personaLoreSignals:[]});await second;a.resolve({name:'old',contextOptions:{},loreCandidates:[],personaLoreSignals:[]});await first;assert.equal(root.innerHTML,'new','older async preview cannot overwrite a newer view');
 const held=deferred();let inserted=0;t.setImageInsert(async()=>{await held.promise;inserted++;return{content:'image attached',placements:[{}]};});
 const output=t.hook('Source Persona smiled softly.','model');await new Promise(r=>setTimeout(r,20));selectedChat=1;held.resolve();assert.equal(await output,'Source Persona smiled softly.','session switch during image work must keep original response');assert.equal(inserted,1);
 console.log('PASS LIA stale UI result and session-switch image response guards');
}finally{await f.dispose();}})().catch(e=>{console.error(e);process.exitCode=1});

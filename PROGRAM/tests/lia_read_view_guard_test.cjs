'use strict';
const assert=require('node:assert/strict');
const {createFixture}=require('./fixtures/lia_native_runtime_fixture.cjs');
const expose=source=>{const i=source.lastIndexOf('\n})();');return source.slice(0,i)+`\nglobalThis.__guardTest={refreshPreview,setContextReader:fn=>{getContext=fn;},setRender:fn=>{renderPreview=fn;},setBinder:fn=>{bindPreviewTools=fn;},setPicker:fn=>{refreshModulePicker=fn;}};`+source.slice(i);};
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
 assert.equal(typeof f.api.addRisuReplacer==='function',true);
 console.log('PASS LIA stale UI result guard; retired image response route absent');
}finally{await f.dispose();}})().catch(e=>{console.error(e);process.exitCode=1});

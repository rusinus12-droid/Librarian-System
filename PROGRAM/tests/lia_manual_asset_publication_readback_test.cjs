'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const p=path.resolve(__dirname,'..');
const {createFixture}=require(path.join(p,'tests/fixtures/lia_native_runtime_fixture.cjs'));
const {createMemorySuiteServer}=require(path.join(p,'server/server.cjs'));
const transport=require('./helpers/inprocess-review-transport.cjs');
const PNG=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=','base64');
const ASSETS='liaPersonaVisualAssetStoreV1';
const expose=s=>s.replace('      getLiveSyncCaptureState:',`      auditAssets:{importPersonaVisualAssetImage,readPersonaVisualAssetStore,writePersonaVisualAssetStore,writePersonaVisualAssetBackup,readPersonaVisualAssetBackup,ensurePersonaVisualAssetAvailable,bridge:MemorySuiteStorageBridge},\n      getLiveSyncCaptureState:`);
(async()=>{const results=[];
for(const mode of ['plugin_only','server_only','mirror'])for(const fault of ['false','dropped','mismatch','success']){
 const dir=fs.mkdtempSync(path.join(require('node:os').tmpdir(),'lia-store-')),app=createMemorySuiteServer({dataDir:dir,autoBackup:false,computeEnabled:false,port:47631});const calls=[],route=transport(app,calls);let f;
 try{
 let saves=0,reads=0,models=0;
 f=await createFixture('official',{transformSource:expose,configureApi(api){const local=new Map();api.safeLocalStorage={getItem:async k=>local.get(k)??null,setItem:async(k,v)=>{local.set(k,v);return true;},removeItem:async k=>local.delete(k),keys:async()=>[...local.keys()]};api.getLocalPluginStorage=async()=>api.safeLocalStorage;
 api.getArgument=async k=>({memory_suite_server_mode:mode,memory_suite_server_url:'http://127.0.0.1:47631',enable_gui:'false',mode:'off',live_sync_enabled:'false'}[k]??'');api.getArg=api.getArgument;api.nativeFetch=route;api.saveAsset=async()=>{saves++;return fault==='false'?false:'assets/not-saved.png';};api.readImage=async key=>{reads++;assert.equal(key,'not-saved.png');if(fault==='dropped')throw Error('synthetic_host_asset_missing');const bytes=new Uint8Array(PNG);if(fault==='mismatch')bytes[bytes.length-1]^=1;return bytes;};for(const n of ['llm','runLLMModel','requestModel','generateImage','embed'])api[n]=async()=>{models++;throw Error('FORBIDDEN_PROVIDER_CALL');};}});
 f.context.document={getElementById:()=>null};const a=f.runtime.auditAssets,target={personaKey:'persona:test',personaId:'test',personaName:'Test',assetPrefix:'Test',sourceType:'persona'};
 await a.writePersonaVisualAssetBackup('old-backup',new Uint8Array(PNG));await a.writePersonaVisualAssetStore({sets:{'persona:test':{...target,images:{neutral:{emotion:'neutral',assetPath:'assets/old.png',backupId:'old-backup',backupBytes:PNG.length}}}}});
 const before=(await a.readPersonaVisualAssetStore()).sets['persona:test'].images.neutral;let error='',result;
 try{result=await a.importPersonaVisualAssetImage(target,'neutral',new Blob([PNG],{type:'image/png'}));}catch(e){error=String(e.message);}
 const after=(await a.readPersonaVisualAssetStore()).sets['persona:test'].images.neutral;
 assert.equal(models,0);assert(before.assetPath==='assets/old.png');
 if(fault==='success'){assert.equal(error,'');assert.equal(after.assetPath,'assets/not-saved.png');assert.equal(reads,1);}else{assert(error,'unverified host save must reject');assert.deepEqual(after,before);assert.equal(reads,fault==='false'?0:1);}
 const remote=app.repositories.lia.database.prepare('SELECT value_json FROM kv WHERE key=? AND deleted=0').get(ASSETS);
 const oldBackup=await a.readPersonaVisualAssetBackup('old-backup');assert.deepEqual(Buffer.from(oldBackup.bytes),PNG);
 results.push({mode,fault,error,returnedSuccess:!!result,returnedAssetPath:result?.entry?.assetPath,previousAssetPath:before.assetPath,durableAssetPath:after?.assetPath??null,durableEmotionPresent:!!after,nativeReadbackCalls:reads,nativeSaveCalls:saves,oldBackupPreserved:true,actualModels:models,serverRowPresent:!!remote,serverRouteCalls:calls.length});
 }finally{await f?.dispose();app.server.emit('close');}
}
const result={node:process.version,method:'Whole LIA plugin + unchanged producer, backup writer, storage bridge + actual server handler/SQLite; native asset seam returns false or nonexistent key',sourceSha256:crypto.createHash('sha256').update(fs.readFileSync(path.join(p,'plugins/LIA_Persona_Linker.js'))).digest('hex'),sockets:0,results};console.log(JSON.stringify(result,null,2));
})().catch(e=>{console.error(e);process.exitCode=1;});

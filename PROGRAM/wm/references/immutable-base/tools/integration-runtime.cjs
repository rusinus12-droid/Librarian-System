'use strict';
const fs=require('fs'),Module=require('module'),path=require('path'),crypto=require('crypto');
const root=path.resolve(__dirname,'..'),base=JSON.parse(fs.readFileSync(root+'/BASE-PINS.json')).base;
const file=base+'/tools/libra_typed_recall_queue_test.cjs';const source=fs.readFileSync(file,'utf8').replace('globals:{Risuai:host,risuai:host}','globals:{...measurement.globals,Risuai:host,risuai:host}');
const mod=new Module(file,module);mod.filename=file;mod.paths=Module._nodeModulePaths(path.dirname(file));mod._compile(source,file);
async function runtime(provider,{dist=process.env.WM_VERSIONED_DIST||base+'/dist/LIBRA World Manager Full.js',...options}={}){
 const r=await mod.exports.runtime(null,{...options,dist,admittedHost:true,globals:{__SNAPSHOT_PROVIDER__:provider,crypto:crypto.webcrypto,Date:class extends Date{constructor(...args){super(...(args.length?args:[1900000000000]));}static now(){return 1900000000000;}},performance:{now:()=>100}},transformCode(code){
  const matches=code.match(/mode:\s*['"]live['"],\s*global:\s*globalThis/g)||[];if(matches.length!==1)throw Error('factory injection seam missing');code=code.replace(matches[0],matches[0]+', snapshotAuthority: globalThis.__SNAPSHOT_PROVIDER__');
  const close=code.lastIndexOf('})();');code=code.slice(0,close)+'\n;globalThis.__WM_SNAPSHOT_TEST__={bridge:typeof VersionedCanonicalBridge!=="undefined"?VersionedCanonicalBridge:null,cold:ColdStartManager,transition:TransitionManager,migration:EntityCanonicalNameMigration,secret:SecretKnowledgeCore,knowledge:EntityKnowledgeVaultCore,context:resolveActiveChatContext};\n'+code.slice(close);return options.transformCode?options.transformCode(code):code;
 }});r.chat.localLore=[];return r;
}
const request=()=>({messages:[{role:'system',content:'Host scenario: A enters the city.'},{role:'user',content:'A asks about the pendant promise, the city oath and what happened.'}],maxContextTokens:128000,maxResponseTokens:4096});
module.exports={runtime,request,base,root};

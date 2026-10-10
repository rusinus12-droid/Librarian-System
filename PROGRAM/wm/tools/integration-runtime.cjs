'use strict';
const fs=require('fs'),Module=require('module'),path=require('path'),crypto=require('crypto');
const root=path.resolve(__dirname,'..'),base=require('./wm-historical-fixture-paths.cjs').immutableBaseRoot({wmRoot:root});
const file=base+'/tools/libra_typed_recall_queue_test.cjs';const source=fs.readFileSync(file,'utf8').replace('globals:{Risuai:host,risuai:host}','globals:{...measurement.globals,Risuai:host,risuai:host}');
const mod=new Module(file,module);mod.filename=file;mod.paths=Module._nodeModulePaths(path.dirname(file));mod._compile(source,file);
async function runtime(provider,{dist=process.env.WM_VERSIONED_DIST||base+'/dist/LIBRA World Manager Full.js',observeStartupCompletion=false,...options}={}){
 const startup=[];
 const observedTimeout=(schedule,fn,delay,...args)=>{
  if(typeof schedule!=='function'||typeof fn!=='function'||delay!==2000)throw Error('actual cold-start timer registration mismatch');
  let resolve,reject;const completion=new Promise((a,b)=>{resolve=a;reject=b}),entry={completion,completed:false};startup.push(entry);
  return schedule((...values)=>{try{Promise.resolve(fn(...values)).then(value=>{entry.completed=true;resolve(value);},reject);}catch(error){reject(error);}},delay,...args);
 };
 const r=await mod.exports.runtime(null,{...options,dist,admittedHost:true,globals:{...(observeStartupCompletion?{__OBSERVE_ACTUAL_COLD_START__:observedTimeout}:{}),__SNAPSHOT_PROVIDER__:provider,crypto:crypto.webcrypto,Date:class extends Date{constructor(...args){super(...(args.length?args:[1900000000000]));}static now(){return 1900000000000;}},performance:{now:()=>100}},transformCode(code){
  if(observeStartupCompletion){const startupCall=/setTimeout\((async\s*\(\)\s*=>\s*\{\s*await ColdStartManager\.check\(\);\s*\}),\s*2000\);/g;if((code.match(startupCall)||[]).length!==1)throw Error('actual cold-start call seam missing');code=code.replace(startupCall,'globalThis.__OBSERVE_ACTUAL_COLD_START__(setTimeout,$1,2000);');}
  const matches=code.match(/mode:\s*['"]live['"],\s*global:\s*globalThis/g)||[];if(matches.length!==1)throw Error('factory injection seam missing');code=code.replace(matches[0],matches[0]+', snapshotAuthority: globalThis.__SNAPSHOT_PROVIDER__');
  const close=code.lastIndexOf('})();');code=code.slice(0,close)+'\n;globalThis.__WM_SNAPSHOT_TEST__={bridge:typeof VersionedCanonicalBridge!=="undefined"?VersionedCanonicalBridge:null,cold:ColdStartManager,transition:TransitionManager,migration:EntityCanonicalNameMigration,secret:SecretKnowledgeCore,knowledge:EntityKnowledgeVaultCore,context:resolveActiveChatContext};\n'+code.slice(close);return options.transformCode?options.transformCode(code):code;
 }});r.chat.localLore=[];
 if(observeStartupCompletion)r.waitForStartupCompletion=async()=>{
  if(startup.length!==1)throw Error('expected exactly one actual cold-start callback');
  let deadline;try{await Promise.race([Promise.all(startup.map(x=>x.completion)),new Promise((_,reject)=>{deadline=setTimeout(()=>reject(Error('actual cold-start callback did not settle')),10000);})]);}
  finally{clearTimeout(deadline);}
  if(startup.some(x=>!x.completed))throw Error('cold-start callback completion unproved');
  return {scheduled:startup.length,completed:startup.filter(x=>x.completed).length};
 };
 return r;
}
const request=()=>({messages:[{role:'system',content:'Host scenario: A enters the city.'},{role:'user',content:'A asks about the pendant promise, the city oath and what happened.'}],maxContextTokens:128000,maxResponseTokens:4096});
module.exports={runtime,request,base,root};

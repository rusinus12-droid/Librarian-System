const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'); const vm=require('node:vm');
const file=process.env.GRADIA_FILE||require('node:path').join(__dirname,'../../plugins/GRADIA.js');
async function load(options={}){
 const hooks={};const logs=[];const store=new Map(Object.entries(options.storage||{}));const accesses=[];let calls=0;
 const api={getArgument:async()=>undefined, setArgument:async()=>{},
 pluginStorage:{getItem:async k=>{accesses.push(['read',k]);return store.get(k)},setItem:async(k,v)=>{accesses.push(['write',k]);return store.set(k,v)},removeItem:async k=>{accesses.push(['remove',k]);return store.delete(k)}},
 addRisuReplacer:async(k,v)=>hooks[k]=v,addRisuScriptHandler:async(k,v)=>hooks[k]=v,
 requestPluginPermission:async()=>true,onUnload:async()=>{},
 getCharacter:async()=>null,getDatabase:async()=>({characters:[]}),getChatFromIndex:async()=>null,
 getCurrentCharacterIndex:async()=>-1,getCurrentChatIndex:async()=>-1,
 fetch:async()=>{calls++;throw Error('NETWORK FORBIDDEN')}};
 api.nativeFetch=api.fetch;Object.assign(api,options.api||{});
 const context=vm.createContext({risuai:api,console:{log(...v){logs.push(v)},warn(...v){logs.push(v)}},setTimeout,clearTimeout,setInterval,clearInterval,TextEncoder,TextDecoder,URL,AbortController,structuredClone,fetch:api.fetch,...(options.testGlobals||{})});
 let source=fs.readFileSync(options.sourceFile||file,'utf8');
 if(options.captureInternals) source=source.replace('  const publicApi = Object.freeze({', '  globalThis.__testInternals = { clearStructuredSettings, fullDraftStagePrompt, Runtime };\n  const publicApi = Object.freeze({');
 if(options.transformSource) source=options.transformSource(source);
 await vm.runInContext(source,context,{timeout:2000});
 const plugin=context.__SerialGradationAgentsForRP;assert.ok(plugin,'real plugin initialized');
 return {plugin,hooks,store,accesses,logs,pipeline:context.__testPipeline,buildRecent:context.__testBuildRecent,internals:context.__testInternals,gatewayRegistry:context.__testGatewayRegistry,createLibReadConsumer:context.__testCreateLibReadConsumer,getCalls:()=>calls};
}

module.exports={load};

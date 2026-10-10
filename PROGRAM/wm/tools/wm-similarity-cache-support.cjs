'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),acorn=require('acorn'),Module=require('node:module');
const {fixture,plain,tick}=require('./wm-native-cache-support.cjs');
const cfg=(patch={})=>({enabled:true,provider:'ollama',url:'http://127.0.0.1:9999/api/embed',key:'',model:'tiny-3',timeout:120000,...patch});
function transform(code){
 const nodes=[],stack=[acorn.parse(code,{ecmaVersion:'latest'})];
 while(stack.length){const n=stack.pop();if(!n||typeof n!=='object')continue;nodes.push(n);for(const v of Object.values(n))if(Array.isArray(v))stack.push(...v);else if(v&&typeof v==='object')stack.push(v);}
 const engine=nodes.find(n=>n.type==='VariableDeclarator'&&n.id?.name==='MemoryEngine');assert(engine);
 const scope=engine.init.callee.body;assert.equal(scope.type,'BlockStatement');
 const bindings=scope.body.filter(n=>n.type==='VariableDeclaration').flatMap(n=>n.declarations);
 const detailed=bindings.find(n=>n.id?.name==='calcSimilarityDetailed');assert(detailed);
 const exports=scope.body.filter(n=>n.type==='ReturnStatement'&&n.argument?.type==='ObjectExpression'&&['CONFIG','getSafeKey','getCachedMeta'].every(name=>n.argument.properties.some(p=>p.key?.name===name&&p.value?.name===name)));assert.equal(exports.length,1);
 const locator=bindings.find(n=>n.id?.name==='getSimilarityCacheKey')||bindings.find(n=>n.id?.name==='calcSimilarity');assert(locator);
 const edits=[{start:detailed.init.body.start+1,end:detailed.init.body.start+1,text:'globalThis.__SIM_OBS__.details++;'}];
 const notifier=nodes.find(n=>n.type==='Property'&&n.key?.name==='noteConfigurationPublished');assert(notifier);
 edits.push({start:notifier.value.body.end-1,end:notifier.value.body.end-1,text:';globalThis.__SIM_OBS__.publications.push({word:CONFIG.scoringWeights?.word,anchor:CONFIG.recallAnchorBonus});'});
 for(const n of nodes)if(n.type==='CallExpression'&&n.callee.type==='MemberExpression'&&n.callee.object?.name==='TokenizerEngine'&&n.callee.property?.name==='simpleHash'&&n.start>=locator.start&&n.end<=locator.end){edits.push({start:n.start,end:n.end,text:'globalThis.__SIM_OBS__.hash('+code.slice(n.start,n.end)+')'});}
 edits.push({start:exports[0].argument.start+1,end:exports[0].argument.start+1,text:'__similarityTest:{calcSimilarity,calcSimilarityDetailed,getSimCache,scoreDuplicateCandidateFast,capture:()=>typeof captureSimilarityConfiguration==="function"?captureSimilarityConfiguration():null},'});
 for(const e of edits.sort((a,b)=>b.start-a.start))code=code.slice(0,e.start)+e.text+code.slice(e.end);
 const call=/await calcSimilarity\(existingContent,\s*content\)/g;assert.equal([...code.matchAll(call)].length,1);
 code=code.replace(call,'globalThis.__SIM_OBS__.heavy(await calcSimilarity(existingContent,content))');
 return 'globalThis.__SIM_OBS__={details:0,scores:[],publications:[],hash:v=>v,heavy(v){this.scores.push(v);return v;}};\n'+code;
}
async function fresh(){const f=await fixture({transform});f.m=f.r.api.MemoryEngine;f.s=f.r.api.MemoryState;f.a=f.m.__similarityTest;f.obs=f.r.context.__SIM_OBS__;f.m.clearDerivedCaches();f.m.CONFIG.embed=cfg({enabled:false});return f;}
function publish(f,patch){f.m.CONFIG.embed={...f.m.CONFIG.embed,...patch};f.m.EmbeddingEngine.noteConfigurationPublished();}
async function settle(f){for(let i=0;i<100&&!f.r.state.pending.length;i++)await tick();assert(f.r.state.pending.length,'actual legacy adapter is pending');}
function release(f){f.r.state.blockDoc=false;f.r.state.pending.splice(0).forEach(fn=>fn());}
async function pub(f,a,b){f.obs.scores.length=0;const result=await f.m.checkDuplication(b,[{key:'lmai_memory::similarity',comment:'lmai_memory',content:a}]);return {result,heavyScores:Array.from(f.obs.scores)};}
async function loadGui(options={}){
 const filename=path.join(__dirname,'wm-cache-currentness-gui-support.cjs');
 const source=fs.readFileSync(filename,'utf8');assert(source.includes('await w.eval(code);'));
 const local=new Module(filename,module);local.filename=filename;local.paths=module.paths;
 local._compile(source.replace('await w.eval(code);','await w.eval(options.transform ? options.transform(code) : code);'),filename);
 const f=await local.exports.loadGui({...options,transform});f.m=f.api.MemoryEngine;f.s=f.api.MemoryState;f.a=f.m.__similarityTest;f.obs=f.w.__SIM_OBS__;return f;
}
module.exports={fresh,loadGui,transform,cfg,publish,settle,release,pub,plain,tick};

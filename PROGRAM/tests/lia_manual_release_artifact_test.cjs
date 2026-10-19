'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {JSDOM,VirtualConsole}=require('jsdom');
const {createFixture}=require('./fixtures/lia_native_runtime_fixture.cjs');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const wait=async(predicate,label)=>{for(let i=0;i<100;i++){if(predicate())return;await sleep(50);}throw Error('Timed out: '+label);};
(async()=>{
 const artifact=path.resolve(process.env.LIA_RELEASE_ARTIFACT||'');assert(process.env.LIA_RELEASE_ARTIFACT,'actual release artifact is required');
 const source=fs.readFileSync(artifact,'utf8');let openUI,requests=0,release,entered;
 let delta={summary:'Wrong model shape',liveState:{goals:['Must not be discarded']},coreCandidates:[],ignoredTransient:[]};
 const providerEntered=new Promise(resolve=>entered=resolve),pending=new Promise(resolve=>release=resolve);
 const hooks=new Map();
 const f=await createFixture('official',{transformSource:()=>source,configureApi(api,{values}){
  api.registerSetting=async(_name,handler)=>{openUI=handler;return true;};
  api.addRisuReplacer=async(type,handler)=>{hooks.set(type,handler);return true;};
  values.set('dynamicPersonaLorebookGeneratorLLMConfig',JSON.stringify({provider:'ollama',model:'mock-model',endpoint:'http://fixture.invalid/api/chat',stream:false,promptCacheMode:'off'}));
  api.nativeFetch=async(url,init)=>{
   assert.match(String(url),/^http:\/\/fixture\.invalid\//,'only an intercepted mock model route is allowed');
   requests++;assert.equal(init.method,'POST');entered();await pending;
   return {ok:true,text:async()=>JSON.stringify({message:{content:JSON.stringify(delta)}})};
  };
 }});
 const dom=new JSDOM('<!doctype html><html><body></body></html>',{url:'https://fixture.invalid/',pretendToBeVisual:true,virtualConsole:new VirtualConsole()});
 try{
  const w=dom.window;
  if(!w.CSS)w.CSS={};if(!w.CSS.escape)w.CSS.escape=value=>String(value).replace(/[^a-zA-Z0-9_-]/g,char=>'\\'+char);
  for(const name of ['document','window','navigator','location','HTMLElement','HTMLInputElement','HTMLTextAreaElement','HTMLSelectElement','HTMLButtonElement','Node','Element','Event','MouseEvent','KeyboardEvent','CustomEvent','MutationObserver','DOMParser','FileReader','Image','getComputedStyle','requestAnimationFrame','cancelAnimationFrame','CSS','SVGElement','DocumentFragment','HTMLTemplateElement']){
   if(w[name]!==undefined)f.context[name]=typeof w[name]==='function'&&/^[a-z]/.test(name)?w[name].bind(w):w[name];
  }
  f.context.fetch=async()=>{throw Error('Network forbidden');};
  dom.window.HTMLElement.prototype.scrollIntoView=function(){};
  assert.equal(f.registrations.chat,0);assert.equal(f.registrations.script,0);assert.equal(hooks.has('beforeRequest'),false);
  const sourcePersona=JSON.stringify(f.db.personas[0]),bound=f.liveChat.bindedPersona;
  assert.equal(typeof openUI,'function','use actual registered host UI entry');await openUI();
  const get=id=>dom.window.document.getElementById(id);
  // The old dpg-live-* selectors belonged to the retired GUI. Drive the
  // current product button and keep the original artifact/duplicate guards.
  assert.match(get('upd2-range').textContent,/TURN 1~5/);
  assert(dom.window.document.querySelector('[data-page="recover"]'),'local recovery route remains reachable');
  const ownerSnapshot=()=>JSON.stringify([...f.values].filter(([key])=>/liaPersonaLinkerLivePersona|liaPersonaLinkerPersonaProof/.test(key)).sort(([a],[b])=>a.localeCompare(b)));
  const beforeOwner=ownerSnapshot(),beforePersonas=JSON.stringify(f.db.personas),beforeChat=JSON.stringify(f.liveChat);
  assert.equal(get('upd-go').disabled,false);get('upd-go').click();
  await providerEntered;assert.equal(requests,1);assert.equal(get('upd-go').disabled,true);
  get('upd-go').dispatchEvent(new dom.window.Event('click'));await sleep(20);assert.equal(requests,1,'duplicate delivered event never starts another model request');
  release();await wait(()=>/기존 상태와 처리 범위는 변경하지 않았습니다/.test(get('dpg-status')?.textContent||''),'actual artifact rejects wrong-shaped output');
  assert.equal(ownerSnapshot(),beforeOwner);assert.equal(JSON.stringify(f.db.personas),beforePersonas);assert.equal(JSON.stringify(f.liveChat),beforeChat);
  assert.match(get('upd2-range').textContent,/TURN 1~5/);assert.equal(get('upd-go').disabled,false,'same range is retryable');
  delta={summary:'Artifact mock state',liveState:[{key:'artifact-goal',category:'goal',value:'Artifact updated state',durability:'persistent',confidence:95,evidence:['user']}],coreCandidates:[],ignoredTransient:[]};
  get('upd-go').click();await wait(()=>/분석·반영했습니다/.test(get('dpg-status')?.textContent||''),'actual artifact explicit retry completion');
  const index=JSON.parse(f.values.get('liaPersonaLinkerLivePersonaIndexV2'));
  const binding=JSON.parse(f.values.get(index.entries[f.scopeKey].storageKey));
  assert.equal(binding.lastProcessedPairCount,5);assert.match(f.db.personas[1].personaPrompt,/Artifact updated state/);
  assert.equal(JSON.stringify(f.db.personas[0]),sourcePersona);assert.equal(f.liveChat.bindedPersona,bound);
  assert.match(get('upd2-range').textContent,/완결된 다음 0쌍/);assert.equal(get('upd-go').disabled,true,'insufficient range is disabled');
  assert.match(get('live-persona-state').textContent,/Artifact updated state/,'committed state is rendered automatically');
  get('upd-go').click();await sleep(20);assert.equal(requests,2);
  console.log(JSON.stringify({test:'lia_manual_release_artifact',artifact,sha256:crypto.createHash('sha256').update(source).digest('hex'),actualArtifactBytes:true,registeredUi:true,providerBoundary:'nativeFetch intercepted',actualNetworkCalls:0,modelStubRequests:requests,wrongShapePreserved:true,explicitRetry:true,passed:18}));
 }finally{release?.();await f.dispose();dom.window.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});

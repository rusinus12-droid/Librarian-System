'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {JSDOM,VirtualConsole}=require('jsdom');
const {createFixture}=require('./fixtures/lia_native_runtime_fixture.cjs');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const wait=async(predicate,label)=>{for(let i=0;i<100;i++){if(predicate())return;await sleep(50);}throw Error('Timed out: '+label);};
(async()=>{
 const artifact=path.resolve(process.env.LIA_RELEASE_ARTIFACT||'');assert(process.env.LIA_RELEASE_ARTIFACT,'actual release artifact is required');
 const source=fs.readFileSync(artifact,'utf8');let openUI,requests=0,release,entered;
 const providerEntered=new Promise(resolve=>entered=resolve),pending=new Promise(resolve=>release=resolve);
 const hooks=new Map();
 const f=await createFixture('official',{transformSource:()=>source,configureApi(api,{values}){
  api.registerSetting=async(_name,handler)=>{openUI=handler;return true;};
  api.addRisuReplacer=async(type,handler)=>{hooks.set(type,handler);return true;};
  values.set('dynamicPersonaLorebookGeneratorLLMConfig',JSON.stringify({provider:'ollama',model:'mock-model',endpoint:'http://fixture.invalid/api/chat',stream:false,promptCacheMode:'off'}));
  api.nativeFetch=async(url,init)=>{
   assert.match(String(url),/^http:\/\/fixture\.invalid\//,'only an intercepted mock model route is allowed');
   requests++;assert.equal(init.method,'POST');entered();await pending;
   return {ok:true,text:async()=>JSON.stringify({message:{content:JSON.stringify({summary:'Artifact mock state',liveState:[{category:'goal',value:'Artifact updated state',durability:'persistent',confidence:95,evidence:['user']}],coreCandidates:[],ignoredTransient:[]})}})};
  };
 }});
 const dom=new JSDOM('<!doctype html><html><body></body></html>',{url:'https://fixture.invalid/',virtualConsole:new VirtualConsole()});
 try{
  f.context.document=dom.window.document;f.context.window=dom.window;f.context.HTMLElement=dom.window.HTMLElement;f.context.requestAnimationFrame=fn=>setTimeout(fn,0);f.context.fetch=async()=>{throw Error('Network forbidden');};
  dom.window.HTMLElement.prototype.scrollIntoView=function(){};
  assert.equal(f.registrations.chat,0);assert.equal(f.registrations.script,0);assert.equal(hooks.has('beforeRequest'),false);
  const sourcePersona=JSON.stringify(f.db.personas[0]),bound=f.liveChat.bindedPersona;
  assert.equal(typeof openUI,'function','use actual registered host UI entry');await openUI();
  const get=id=>dom.window.document.getElementById(id);
  assert.match(get('dpg-live-range').textContent,/TURN 1~5/);assert(get('liaMemorySuiteServerConnectionPanel'));
  assert.equal(get('dpg-live-run-now').disabled,false);get('dpg-live-run-now').click();
  await providerEntered;assert.equal(requests,1);assert.equal(get('dpg-live-run-now').disabled,true);
  get('dpg-live-run-now').dispatchEvent(new dom.window.Event('click'));await sleep(20);assert.equal(requests,1,'duplicate delivered event never starts another model request');
  release();await wait(()=>/갱신 완료/.test(get('dpg-status')?.textContent||''),'actual artifact UI completion');
  const index=JSON.parse(f.values.get('liaPersonaLinkerLivePersonaIndexV2'));
  const binding=JSON.parse(f.values.get(index.entries[f.scopeKey].storageKey));
  assert.equal(binding.lastProcessedPairCount,5);assert.match(f.db.personas[1].personaPrompt,/Artifact updated state/);
  assert.equal(JSON.stringify(f.db.personas[0]),sourcePersona);assert.equal(f.liveChat.bindedPersona,bound);
  assert.match(get('dpg-live-range').textContent,/0\/5턴/);get('dpg-live-run-now').click();
  await wait(()=>/더 필요/.test(get('dpg-status')?.textContent||''),'insufficient range UI reason');
  assert.equal(requests,1);
  console.log(JSON.stringify({test:'lia_manual_release_artifact',artifact,sha256:crypto.createHash('sha256').update(source).digest('hex'),actualArtifactBytes:true,registeredUi:true,providerBoundary:'nativeFetch intercepted',actualNetworkCalls:0,modelStubRequests:requests,passed:12}));
 }finally{release?.();await f.dispose();dom.window.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});

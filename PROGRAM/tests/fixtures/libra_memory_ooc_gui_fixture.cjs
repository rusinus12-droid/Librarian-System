'use strict';
// Synthetic DOM/host boundary only. Complete product bytes execute without hooks.
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { createLibraVmHarness, waitFor } = require('./libra_vm_harness.cjs');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function createLibraDocument() {
  const dom=new JSDOM('<!doctype html><html lang="ko"><head></head><body></body></html>',{url:'https://synthetic-ooc.invalid/',pretendToBeVisual:true});
  const d=dom.window.document,E=dom.window.Element.prototype,handlers=new WeakMap();
  const add=dom.window.EventTarget.prototype.addEventListener,remove=dom.window.EventTarget.prototype.removeEventListener;
  dom.window.EventTarget.prototype.addEventListener=function(type,handler,options){let map=handlers.get(this);if(!map)handlers.set(this,map=new Map());const rows=map.get(type)||[];rows.push(handler);map.set(type,rows);return add.call(this,type,handler,options);};
  dom.window.EventTarget.prototype.removeEventListener=function(type,handler,options){const map=handlers.get(this);if(map)map.set(type,(map.get(type)||[]).filter(row=>row!==handler));return remove.call(this,type,handler,options);};
  // Preserve the old fixture's Array query API for the maintained assertions,
  // while using a standards DOM for canonical HTML, SVG, templates and events.
  for(const proto of [dom.window.Document.prototype,E,dom.window.DocumentFragment.prototype]){const query=proto.querySelectorAll;proto.querySelectorAll=function(selector){return Array.from(query.call(this,selector));};}
  E.emit=async function(type,values={}){
    assert.equal(this.disabled===true,false,`${this.id||this.tagName}: action is enabled`);
    let stopped=false,count=0;const results=[];
    const event={type,target:this,preventDefault(){},stopPropagation(){stopped=true;},stopImmediatePropagation(){stopped=true;},...values};
    for(let node=this;node;node=node.parentNode){event.currentTarget=node;const actions=[...(handlers.get(node)?.get(type)||[])];if(typeof node['on'+type]==='function')actions.push(node['on'+type]);count+=actions.length;for(const action of actions)results.push(await action(event));if(stopped)break;}
    assert.ok(count>0,`${this.id||this.tagName}: production event handler is bound`);return results;
  };
  return d;
}
async function createOocGui(options={}) {
  const document=createLibraDocument(), registered=new Map(), modelCalls=[], networkCalls=[], modelQueue=[];
  let currentChatIndex=0;
  const chats=[0,1].map(i=>({id:'ooc-gui-chat-'+i,chatId:'ooc-gui-chat-'+i,name:'Synthetic OOC '+i,message:[],messages:[]}));
  const character={id:'ooc-gui-character',chaId:'ooc-gui-character',name:'Fixture Character',chats};
  const host={
    registerSetting:async(name,cb,icon,type,id)=>{registered.set(id,{name,cb,kind:'setting'});return{id};},
    registerButton:async(opts,cb)=>{registered.set(opts.id,{...opts,cb,kind:'button'});return{id:opts.id};},
    getCurrentCharacterIndex:async()=>0,getCurrentChatIndex:async()=>currentChatIndex,
    getCharacter:async()=>character,getCharacterFromIndex:async()=>character,
    getChat:async()=>chats[currentChatIndex],getCurrentChat:async()=>chats[currentChatIndex],getChatFromIndex:async()=>chats[currentChatIndex],
    getDatabase:async fields=>{const db={characters:[character],personas:[],selectedPersona:'',plugins:[]};return Array.isArray(fields)?Object.fromEntries(fields.map(k=>[k,db[k]??null])):db;},
    nativeFetch:async(...args)=>{networkCalls.push(args);throw Error('OFFLINE_NETWORK_FORBIDDEN');},
    runLLMModel:async args=>{modelCalls.push(structuredClone(args));assert(modelQueue.length,'only explicitly queued synthetic model replies may be used');const reply=modelQueue.shift();return typeof reply==='function'?await reply(args):reply;},
    llm:async()=>{throw Error('UNEXPECTED_MODEL_PATH');},showContainer:async()=>true,hideContainer:async()=>true,
    getColorScheme:async()=> 'dark',getRootContainer:async()=>null,getPluginRoot:async()=>null,
    ...(options.host||{})
  };
  const globals={document,Element:document.defaultView.Element,HTMLElement:document.defaultView.HTMLElement,Event:document.defaultView.Event,MouseEvent:document.defaultView.MouseEvent,MutationObserver:document.defaultView.MutationObserver,innerWidth:1400,innerHeight:1000,requestAnimationFrame:fn=>setTimeout(fn,0),cancelAnimationFrame:clearTimeout,getComputedStyle:()=>({display:'block',visibility:'visible',getPropertyValue:()=>''}),fetch:host.nativeFetch,addEventListener(){},removeEventListener(){},window:undefined};
  const h=await createLibraVmHarness({enable_gui:'true',...(options.args||{})},host,{contextGlobals:globals,initialValues:options.initialValues,transformSource:options.transformSource}); h.context.window=h.context;
  const button=(label,root=document)=>root.querySelectorAll('button').find(n=>n.textContent===label);
  const disclosure=label=>document.querySelectorAll('summary').find(n=>n.textContent===label)?.parentNode;
  const ooc=()=>document.getElementById('prompt-studio-ooc-builder');
  async function open(){await waitFor(()=>registered.get('libra-v1-settings-menu'));assert.equal(await registered.get('libra-v1-settings-menu').cb(),true);await waitFor(()=>document.getElementById('sga-rp-gui-root'));await waitFor(()=>document.querySelector('.sidebar [data-go="settings"]'));await pause(20);}
  async function memory(){
    const route=document.querySelector('.sidebar [data-go="settings"]');assert(route,'canonical Settings destination');await route.emit('click');
    await waitFor(()=>document.querySelector('.setnav [data-subtab="mem"]'));await document.querySelector('.setnav [data-subtab="mem"]').emit('click');
    await waitFor(()=>button('기억 분석'));await button('기억 분석').emit('click');
    await waitFor(()=>document.querySelector('[data-analyzer-field="timeoutMs"]'));
    await waitFor(()=>button('Prompt Studio 열기'));
    await button('Prompt Studio 열기').emit('click');
    await waitFor(()=>document.querySelector('#dlg-prompt.is-open [data-prompt-editor-details]'));
    document.querySelector('#dlg-prompt [data-prompt-editor-details]').open=true;
    await waitFor(()=>disclosure('고급 Prompt Studio · 구역별 직접 편집'));
  }
  async function expandOoc(){const node=disclosure('대화로 기억 지침 만들기 · OOC');assert(node,'shared Prompt Studio mounts the memory OOC disclosure');node.open=true;await waitFor(()=>ooc()?.querySelector('select')?.querySelectorAll('option').length>0);return ooc();}
  return {...h,document,registered,modelCalls,modelQueue,networkCalls,host,button,disclosure,ooc,open,memory,expandOoc,pause,waitFor,
    promptWrites:()=>h.storageWrites.filter(x=>x.key==='libra:v1:prompt-overrides'),
    changeChat:async()=>{currentChatIndex=currentChatIndex===0?1:0;await h.api.getCanonicalMemories();},
    cleanup:async()=>{await h.api.closeSettingsGui();await h.cleanup();document.defaultView.close();}
  };
}
module.exports={createOocGui,createLibraDocument,pause,waitFor};

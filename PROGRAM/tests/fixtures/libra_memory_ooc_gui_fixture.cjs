'use strict';
// Synthetic DOM/host boundary only. Complete product bytes execute without hooks.
const assert = require('node:assert/strict');
const { createDocument } = require('./retrace_gui_dom_fixture.cjs');
const { createLibraVmHarness, waitFor } = require('./libra_vm_harness.cjs');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function createLibraDocument() {
  const d = createDocument(), E = Object.getPrototypeOf(d.body);
  d.head = d.documentElement.appendChild(d.createElement('head')); d.readyState = 'complete';
  d.getElementById = id => d.querySelector('#' + id);
  d.createTextNode = text => { const n = d.createElement('#text'); n.textContent = text; return n; };
  d.createDocumentFragment = () => d.createElement('fragment'); d.contains = n => n.isConnected;
  if (!E.libraDomInstalled) {
    E.libraDomInstalled = true;
    const originalGet = E.getAttribute, originalQuery = E.querySelectorAll;
    E.getAttribute = function(k) { if (k.startsWith('data-')) { const key = k.slice(5).replace(/-([a-z])/g, (_,c) => c.toUpperCase()); if (Object.prototype.hasOwnProperty.call(this.dataset,key)) return String(this.dataset[key]); } return originalGet.call(this,k); };
    E.querySelectorAll = function(s) { if (s.startsWith(':scope > ')) return this.children.filter(n => n.matches(s.slice(9))); return originalQuery.call(this,s); };
    E.replaceWith = function(n) { const p = this.parentNode; if (!p) return; n.remove(); const i=p.children.indexOf(this); p.children[i]=n; n.parentNode=p; this.parentNode=null; };
    E.append = function(...nodes) { for (const n of nodes) this.appendChild(typeof n === 'string' ? this.ownerDocument.createTextNode(n) : n); };
    E.replaceChildren = function(...nodes) { for (const c of this.children) c.parentNode=null; this.children=[]; this._text=''; this.append(...nodes); };
    E.removeChild = function(n) { n.remove(); return n; };
    E.insertBefore = function(n,ref) { n.remove(); const i=this.children.indexOf(ref); if (i<0) return this.appendChild(n); n.parentNode=this; this.children.splice(i,0,n); return n; };
    E.contains = function(n) { return n===this || this.children.some(c => c.contains(n)); };
    E.getBoundingClientRect = () => ({ x:0,y:0,top:0,left:0,right:1200,bottom:900,width:1200,height:900 });
    E.scrollIntoView = function() {}; E.scrollTo = function() {};
    E.dispatchEvent = function(e) { e.target ??= this; e.currentTarget ??= this; for (const f of this.listeners.get(e.type)||[]) f(e); return true; };
    Object.defineProperties(E, {
      parentElement:{ configurable:true,get(){return this.parentNode;} },firstChild:{configurable:true,get(){return this.children[0]||null;}},
      childNodes:{configurable:true,get(){return this.children;}},offsetWidth:{configurable:true,get(){return 1200;}},offsetHeight:{configurable:true,get(){return 900;}},
      open:{configurable:true,get(){return this.attributes.has('open');},set(value){ const changed=this.open !== !!value; if(value)this.setAttribute('open','');else this.removeAttribute('open'); if(changed){clearTimeout(this.toggleTimer);this.toggleTimer=setTimeout(()=>this.dispatchEvent({type:'toggle'}),0);} }}
    });
  }
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
  const globals={document,innerWidth:1400,innerHeight:1000,requestAnimationFrame:fn=>setTimeout(fn,0),cancelAnimationFrame:clearTimeout,getComputedStyle:()=>({display:'block',visibility:'visible',getPropertyValue:()=>''}),fetch:host.nativeFetch,addEventListener(){},removeEventListener(){},window:undefined};
  const h=await createLibraVmHarness({enable_gui:'true',...(options.args||{})},host,{contextGlobals:globals,initialValues:options.initialValues,transformSource:options.transformSource}); h.context.window=h.context;
  const button=(label,root=document)=>root.querySelectorAll('button').find(n=>n.textContent===label);
  const disclosure=label=>document.querySelectorAll('summary').find(n=>n.textContent===label)?.parentNode;
  const ooc=()=>document.getElementById('prompt-studio-ooc-builder');
  async function open(){await waitFor(()=>registered.get('libra-v1-settings-menu'));assert.equal(await registered.get('libra-v1-settings-menu').cb(),true);await waitFor(()=>document.getElementById('sga-rp-gui-root'));await pause(100);}
  async function memory(){await document.querySelectorAll('button').find(n=>n.dataset.bookPage==='settings').emit('click');await waitFor(()=>document.querySelectorAll('button').find(n=>n.dataset.externalSettings==='memory_analysis'));await document.querySelectorAll('button').find(n=>n.dataset.externalSettings==='memory_analysis').emit('click');await waitFor(()=>disclosure('기억 분석 프롬프트'));disclosure('기억 분석 프롬프트').open=true;await waitFor(()=>disclosure('고급 Prompt Studio · 구역별 직접 편집'));}
  async function expandOoc(){const node=disclosure('대화로 기억 지침 만들기 · OOC');assert(node,'shared Prompt Studio mounts the memory OOC disclosure');node.open=true;await waitFor(()=>ooc()?.querySelector('select')?.querySelectorAll('option').length>0);return ooc();}
  return {...h,document,registered,modelCalls,modelQueue,networkCalls,host,button,disclosure,ooc,open,memory,expandOoc,pause,waitFor,
    promptWrites:()=>h.storageWrites.filter(x=>x.key==='libra:v1:prompt-overrides'),
    changeChat:async()=>{currentChatIndex=currentChatIndex===0?1:0;await h.api.getCanonicalMemories();},
    cleanup:async()=>{await h.api.closeSettingsGui();await h.cleanup();}
  };
}
module.exports={createOocGui,createLibraDocument,pause,waitFor};

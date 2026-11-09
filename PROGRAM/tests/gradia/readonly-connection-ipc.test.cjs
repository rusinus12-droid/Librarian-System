'use strict';
// 읽기 경로가 플러그인 IPC 하나로 줄었지만, "기억을 읽어도 된다"는 사용자 동의 계약은 그대로다.
// 서버 전송 테스트에만 있던 세 가지 계약(설정 가져오기가 동의를 가져오지 않음 / 동의 저장 중
// 채팅이 바뀌면 이전 연결이 노출되지 않음 / 언로드가 진행 중인 동의 쓰기를 기다림)을 IPC 경로로
// 옮겨 검증한다.
const {test}=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {JSDOM}=require('jsdom');const {load}=require('./host.cjs');
const PREF='serial_gradation_agents_for_rp:lib_read_connection:v1';
const OWNER_IDS={libra:'libra',hayaku:'hayaku_locator_continuity',flashback:'flashback_memory'};
const REQUEST='gradia_memory_read_request_v1',RESPONSE='gradia_memory_read_response_v1';
const wait=async(fn,ms=6000)=>{const start=Date.now();while(Date.now()-start<ms){const v=fn();if(v)return v;await new Promise(r=>setTimeout(r,10));}throw Error('Connection action did not settle');};

function ipcHost(t,{saved,delayPreference=false}={}){
  const local=new Map(),values=new Map(),unloads=[],locals=[],requests=[],channel=new Map();
  if(saved)local.set(PREF,JSON.stringify(saved));
  const asked=[];let releasePreference=null,current={id:'h',message:[]};const chatRows={0:current,1:{id:'other',message:[]}};let currentIndex=0;
  const scopes={libra:{scopeKey:'ipc-libra',characterId:'c',chatId:'h'},
    hayaku:{scopeKey:'ipc-hayaku',characterId:'c',chatId:'h'},
    flashback:{scopeKey:'ipc-flashback',characterId:'c',chatId:'h'}};
  const reply=(sender,message,result,error)=>setTimeout(()=>channel.get(RESPONSE)?.({schema:'memory-suite.gradia-plugin-read.v1',kind:'response',id:message.id,action:message.action,...(error?{error}:{result})},{sender}),0);
  const api={
    addPluginChannelListener:async(name,fn)=>{channel.set(name,fn);return true;},
    removePluginChannelListener:async name=>{channel.delete(name);},
    postPluginChannelMessage:async(target,name,message)=>{
      if(name!==REQUEST||message?.kind!=='request')return;
      const owner=Object.keys(OWNER_IDS).find(key=>OWNER_IDS[key]===target);if(!owner)return;
      asked.push(owner);
      const activeChat=chatRows[currentIndex];
      if(message.native&&(message.native.characterId!=='c'||message.native.chatId!==activeChat.id))return reply(target,message,null,'LIB_READ_NATIVE_SCOPE_CHANGED');
      if(message.action==='describe')return reply(target,message,{owner,source:'plugin_ipc',readOnly:true,scope:{...scopes[owner],chatId:activeChat.id}});
      if(message.action==='select')return reply(target,message,{owner,source:'plugin_ipc',readOnly:true,scope:{...scopes[owner],chatId:activeChat.id},content:owner+' memory:'+String(message.queryText||'').slice(0,20)});
      if(message.action==='release')return reply(target,message,{released:true});
      return reply(target,message,null,'LIB_READ_REQUEST_INVALID');
    },
    pluginStorage:{getItem:async k=>values.get(k)??null,setItem:async(k,v)=>{values.set(k,v);},removeItem:async k=>{values.delete(k);}},
    getLocalPluginStorage:async()=>({
      getItem:async k=>local.get(k)??null,
      setItem:async(k,v)=>{locals.push(k);if(delayPreference&&JSON.parse(v).explicit===true)await new Promise(r=>releasePreference=r);local.set(k,v);},
      removeItem:async k=>{locals.push(k);local.delete(k);}}),
    nativeFetch:async(target,init)=>{requests.push({url:String(target),headers:init?.headers});throw Error('IPC path must not use the server transport');},
    fetch:async()=>{throw Error('IPC path must not use the server transport');},
    onUnload:async fn=>unloads.push(fn),showContainer:async()=>{},hideContainer:async()=>{},
    getCurrentCharacterIndex:async()=>0,getCurrentChatIndex:async()=>currentIndex,
    getCharacterFromIndex:async()=>({chaId:'c',chats:Object.values(chatRows)}),
    getCharacter:async()=>({chaId:'c',chats:[current]}),
    getChatFromIndex:async(_c,index)=>chatRows[index],
    getChat:async()=>current,getCurrentChat:async()=>current
  };
  const dom=new JSDOM('<!doctype html><html><body></body></html>',{pretendToBeVisual:true,url:'https://offline.invalid/'});
  return (async()=>{
    const host=await load({api,testGlobals:{crypto:crypto.webcrypto,Response,window:dom.window,Element:dom.window.Element,document:dom.window.document,
      getComputedStyle:dom.window.getComputedStyle.bind(dom.window),MutationObserver:dom.window.MutationObserver,
      requestAnimationFrame:dom.window.requestAnimationFrame.bind(dom.window),cancelAnimationFrame:dom.window.cancelAnimationFrame.bind(dom.window)}});
    t.after(async()=>{await host.plugin.closeSettingsGui();for(const fn of unloads)await fn();dom.window.close();});
    await host.plugin.openSettingsGui();
    dom.window.document.querySelector('.sidebar [data-go="sources"]').click();
    const doc=dom.window.document,status=()=>host.plugin.getLibReadOnlyStatus();
    const click=action=>{const node=doc.querySelector(action==='inspect'?'#lib-check':`#lib-${action}`);assert.ok(node,action);node.click();};
    const connect=async()=>{click('connect');await wait(()=>['connected','error'].includes(status().connection?.state));return status();};
    return {host,doc,status,click,connect,local,locals,requests,values,asked,
      setChat:id=>{current=chatRows[currentIndex]={id,message:[]};},
      switchIndex:()=>{currentIndex=1;current=chatRows[1];},
      preferenceWaiting:()=>!!releasePreference,releasePreference:()=>releasePreference?.(),
      unload:async()=>{for(const fn of unloads)await fn();}};
  })();
}

test('IPC connect records explicit consent without touching the server transport',async t=>{
  const f=await ipcHost(t);
  const status=await f.connect();
  assert.equal(status.connection.state,'connected',JSON.stringify(status.connection));
  assert.equal(status.connection.readSource,'plugin_ipc');
  assert.deepEqual(f.requests,[],'the server transport is never used');
  const saved=JSON.parse(f.local.get(PREF));
  assert.equal(saved.explicit,true);
  assert.equal(saved.readSource,'plugin_ipc');
  assert.equal(status.status,'bound');
});

test('saved explicit IPC consent reconnects at startup without a new consent write',async t=>{
  const f=await ipcHost(t,{saved:{schema:'gradia.lib-read-connection.v2',url:'',explicit:true,readSource:'plugin_ipc',readOwners:['libra','hayaku','flashback']}});
  await wait(()=>f.status().connection?.state==='connected');
  assert.deepEqual(f.locals,[],'startup reuses consent instead of rewriting it');
  assert.equal(f.status().connection.readSource,'plugin_ipc');
});

test('settings import never imports or retains connection consent',async t=>{
  const f=await ipcHost(t);
  await f.connect();
  await f.host.plugin.debugNavigateGui('transfer','flow');
  const box=f.doc.querySelector('#mockup-import-text');assert.ok(box);
  box.value=JSON.stringify({runtime:{mode:'off',libReadConnection:{url:'',explicit:true}},
    providerPresets:{offline:{provider:'openai',model:'test-offline',url:'https://api.openai.com/v1/chat/completions'}}});
  box.dispatchEvent(new f.doc.defaultView.Event('input',{bubbles:true}));
  f.doc.querySelector('[data-manage-action="import-replace"]').click();
  const confirm=await wait(()=>f.doc.querySelector('.overlay.is-open .dialog button.btn--primary'));
  confirm.click();
  await wait(()=>f.local.get(PREF)&&JSON.parse(f.local.get(PREF)).explicit===false);
  assert.notEqual(f.status().status,'bound');
});

test('chat change during consent persistence never publishes the old binding',async t=>{
  const f=await ipcHost(t,{delayPreference:true});
  f.click('connect');
  await wait(f.preferenceWaiting);
  f.setChat('other');
  f.releasePreference();
  await wait(()=>f.status().connection.state!=='connecting');
  assert.notEqual(f.status().status,'bound');
  await wait(()=>JSON.parse(f.local.get(PREF)).explicit===false);
});

test('unload waits for the in-flight consent write and revokes it',async t=>{
  const f=await ipcHost(t,{delayPreference:true});
  f.click('connect');
  await wait(f.preferenceWaiting);
  let finished=false;
  const pending=f.unload().then(()=>{finished=true;});
  await new Promise(r=>setTimeout(r,25));
  assert.equal(finished,false,'unload must wait for the consent write');
  f.releasePreference();
  await pending;
  assert.equal(JSON.parse(f.local.get(PREF)).explicit,false);
});
test('saved consent reuses exactly the granted owner subset over IPC',async t=>{
  const f=await ipcHost(t,{saved:{schema:'gradia.lib-read-connection.v2',url:'',explicit:true,readSource:'plugin_ipc',readOwners:['libra','hayaku']}});
  await wait(()=>f.status().connection?.state==='connected');
  const owners=new Set(f.asked);
  assert.ok(owners.has('libra')&&owners.has('hayaku'),'granted owners are read');
  assert.ok(!owners.has('flashback'),'a newly available owner is never read without a grant');
  assert.deepEqual(Array.from(f.status().connection.readOwners),['libra','hayaku']);
});

test('malformed or unknown saved reader grants never establish a connection',async t=>{
  for(const readOwners of [[],['unknown-owner'],['hayaku','hayaku'],'hayaku']){
    const f=await ipcHost(t,{saved:{schema:'gradia.lib-read-connection.v2',url:'',explicit:true,readSource:'plugin_ipc',readOwners}});
    await new Promise(r=>setTimeout(r,200));
    assert.notEqual(f.status().connection.state,'connected',JSON.stringify(readOwners));
  }
});

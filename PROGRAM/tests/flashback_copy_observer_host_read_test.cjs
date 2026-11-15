'use strict';
// The native-copy observer polls for the whole life of the plugin. The host returns a full copy
// of whatever is asked for, and a character carries every one of its chats, so reading the
// character on every poll copied all chats every 1.8 seconds (Android out-of-memory reports).
// The observer now reads the open chat alone, keeps the character id for a short time, does not
// read the host while the page is hidden, and polls less often after a quiet stretch.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {createFixture}=require('./fixtures/flashback_native_runtime_fixture.cjs');
const source=fs.readFileSync(path.join(__dirname,'../plugins/Flashback_Memory.js'),'utf8')
  .replace('_test: { maintenanceResultText,','_test: { Runtime,lightweightNativeCopyObserverIdentity,startNativeCopyObserver,nativeCopyObserverPageHidden,maintenanceResultText,');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
(async()=>{
  const messages=[{role:'user',data:'Read the copper map.',chatId:'u1'},{role:'assistant',data:'The copper map shows the north gate.',chatId:'a1'}];
  const f=await createFixture({source,chat:{id:'open-chat',chatId:'open-chat',name:'Open chat',bindedPersona:'persona-1',message:messages,messages}});
  try{
    const t=f.api._test,o=t.Runtime.nativeCopyObserver;
    // Stop the running observer so only this test triggers reads.
    o.running=false;await pause(400);
    // Count only the observer's own reads; other background work reads the host as well.
    const reads={character:0,chat:0};
    const fromObserver=()=>String(new Error().stack||'').includes('lightweightNativeCopyObserverIdentity');
    for(const name of ['getCharacter','getChar','getCharacterFromIndex'])if(typeof f.host[name]==='function'){const real=f.host[name].bind(f.host);f.host[name]=async(...args)=>{if(fromObserver())reads.character++;return real(...args);};}
    const realChat=f.host.getChatFromIndex.bind(f.host);f.host.getChatFromIndex=async(...args)=>{if(fromObserver())reads.chat++;return realChat(...args);};
    const expected=`${f.character.chaId||f.character.id}:open-chat:persona-1`;

    o.characterId=null;
    assert.equal(await t.lightweightNativeCopyObserverIdentity(),expected);
    assert.deepEqual(reads,{character:1,chat:1},'the first check reads the character once for its id');
    for(let i=0;i<5;i++)assert.equal(await t.lightweightNativeCopyObserverIdentity(),expected);
    assert.deepEqual(reads,{character:1,chat:6},'later checks read the chat alone');

    // The kept id expires, and is never reused for another character index.
    o.characterId.at=0;
    await t.lightweightNativeCopyObserverIdentity();
    assert.equal(reads.character,2,'an expired id is read again');
    o.characterId.charIndex=7;
    await t.lightweightNativeCopyObserverIdentity();
    assert.equal(reads.character,3,'an id kept for another character index is not reused');

    // A different open chat changes the identity without a character read.
    f.currentChat.id='other-chat';f.currentChat.chatId='other-chat';
    assert.equal(await t.lightweightNativeCopyObserverIdentity(),`${f.character.chaId||f.character.id}:other-chat:persona-1`);
    assert.equal(reads.character,3);
    f.currentChat.id='open-chat';f.currentChat.chatId='open-chat';

    // Hidden page: the poll runs but asks the host nothing; visible again, it reads.
    const doc=f.context.document||(f.context.document={});
    const visibility=Object.getOwnPropertyDescriptor(doc,'visibilityState');
    let state='hidden';Object.defineProperty(doc,'visibilityState',{configurable:true,get:()=>state});
    assert.equal(t.nativeCopyObserverPageHidden(),true);
    const before={...reads},skipsBefore=o.hiddenSkips,checksBefore=o.checks;
    o.lastIdentity=expected;o.quietChecks=0;
    assert.equal(t.startNativeCopyObserver(),true);
    await pause(700);
    assert.ok(o.hiddenSkips>skipsBefore,'the hidden poll was counted');
    assert.equal(o.checks,checksBefore,'a hidden poll is not a check');
    assert.deepEqual(reads,before,'no host read while hidden');
    state='visible';
    assert.equal(t.nativeCopyObserverPageHidden(),false);
    await pause(2600);
    assert.ok(o.checks>checksBefore,'polling resumes once visible');
    assert.ok(reads.chat>before.chat,'and reads the chat again');
    assert.equal(reads.character,before.character,'still without a character read');
    assert.ok(o.quietChecks>=1,'an unchanged identity counts as a quiet check');
    o.running=false;
    if(visibility)Object.defineProperty(doc,'visibilityState',visibility);else delete doc.visibilityState;
    console.log('flashback_copy_observer_host_read_test: PASS');
  }finally{await f.dispose();}
})().catch(error=>{console.error(error);process.exitCode=1;});

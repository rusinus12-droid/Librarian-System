'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {createFixture}=require('./fixtures/flashback_native_runtime_fixture.cjs');
const {clone}=require('./fixtures/native_branch_fixture.cjs');

(async()=>{
  const source=fs.readFileSync(path.join(__dirname,'../plugins/Flashback_Memory.js'),'utf8')
    .replace('const RisuCompat = (() => {','globalThis.__fixtureRuntime = Runtime;\nconst RisuCompat = (() => {');
  const f=await createFixture({source,exposeStorageBridge:true});
  try {
    const bridge=f.context.__fixtureStorageBridge;
    const resolve=()=>f.api._test.resolveScopeFromSnapshot({character:clone(f.character),chat:clone(f.currentChat),
      db:{personas:[],selectedPersona:''},chatInfo:{characterIndex:0,chatIndex:0}});
    const parent=resolve();
    // Reproduce a host chat switch before the background owner runtime catches up.
    f.context.__fixtureRuntime.currentScope=parent;
    f.currentChat.id='forced-refresh-child';
    f.currentChat.chatId='forced-refresh-child';
    const child=resolve();
    assert.notEqual(child.scopeKey,parent.scopeKey);
    const refreshed=await bridge.getCurrentScope();
    assert.equal(refreshed.scopeId,child.scopeKey,'forced storage scope lookup must read the active host chat');
    assert.equal(refreshed.chatId,child.chatId);
    // Refreshing storage identity must not implicitly activate or clear the owner's runtime.
    assert.equal(f.context.__fixtureRuntime.currentScope.scopeKey,parent.scopeKey);
    console.log(JSON.stringify({test:'flashback_forced_scope_refresh',passed:4,liveRisuAI:'NOT_RUN'}));
  } finally {await f.dispose();}
})().catch(error=>{console.error(error);process.exitCode=1;});

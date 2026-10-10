'use strict';
const assert = require('node:assert/strict');
const { createFixture } = require('./fixtures/lia_native_runtime_fixture.cjs');
(async () => {
  const replacers = new Map();
  const f = await createFixture('official', { configureApi(api) {
    api.addRisuReplacer = async (type, handler) => { replacers.set(type, handler); return true; };
  } });
  try {
    assert.equal(f.registrations.chat, 0, 'legacy enabled bindings do not register automatic output tracking');
    assert.equal(f.registrations.script, 0, 'legacy fallback tracking is retired too');
    const personas = JSON.stringify(f.db.personas), chat = JSON.stringify(f.liveChat);
    const counters = { host: 0, reads: 0, writes: 0, model: 0 };
    for (const name of ['getDatabase','getCharacter','getCharacterFromIndex','getChatFromIndex']) {
      const original = f.api[name]; f.api[name] = async (...args) => { counters.host++; return original(...args); };
    }
    const get = f.api.pluginStorage.getItem, set = f.api.pluginStorage.setItem;
    f.api.pluginStorage.getItem = async (...args) => { counters.reads++; return get(...args); };
    f.api.pluginStorage.setItem = async (...args) => { counters.writes++; return set(...args); };
    f.api.nativeFetch = async () => { counters.model++; throw Error('network forbidden'); };
    const before = replacers.get('beforeRequest'), after = replacers.get('afterRequest');
    assert.equal(typeof after, 'function', 'independent emotion asset after hook is retained');
    await after('warm independent asset config', 'model');
    Object.keys(counters).forEach(key => { counters[key] = 0; });
    const input = [{role:'user',content:'ordinary'}];
    for (let index=0; index<10; index++) {
      if (before) assert.equal(await before(input,'model'),input);
      assert.equal(await after('ordinary response','model'),'ordinary response');
      assert.equal(f.runtime.debugProcessChatOutput({characterIndex:0,chatIndex:0,chat:f.liveChat,messageIndex:9}).reason,'manual_only');
      assert.equal(f.runtime.debugScheduleLiveSync({force:true}),false);
    }
    await new Promise(resolve => setTimeout(resolve,800));
    assert.deepEqual(counters,{host:0,reads:0,writes:0,model:0},'normal requests do no Live tracker/model/storage work');
    assert.equal(JSON.stringify(f.db.personas),personas);
    assert.equal(JSON.stringify(f.liveChat),chat);
    const state=f.runtime.getLiveSyncCaptureState();
    assert.equal(state.trackedTurnRevisions,0); assert.equal(state.scheduledScopes,0);
    assert.equal(state.requeueScopes.length,0);
    console.log('PASS LiA manual-only idle: legacy enabled state, 10 requests, zero tracker/host/storage/model work');
  } finally { await f.dispose(); }
})().catch(error=>{console.error(error);process.exitCode=1;});

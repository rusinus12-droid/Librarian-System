'use strict';
const assert = require('node:assert/strict');
const {createFixture} = require('./fixtures/flashback_native_runtime_fixture.cjs');
(async () => {
  const f = await createFixture();
  try {
    const t = f.api._test, s = f.api._selectionTest;
    for (const input of ['항구에 도착했다.', '가방을 버렸다.', '약속을 취소했다.', '항구에 도착했다고 쓰지 마.', 'The traveler arrived at a port.', '港に到着した。']) {
      const overlay = t.buildCurrentUserStateOverlay(input);
      assert.equal(overlay.facts.length, 0, 'query prose cannot assert a stored fact');
      assert.equal(overlay.suppressions.length, 0, 'query prose cannot suppress stored evidence');
    }
    const cfg = t.normalizeSettings({...await f.api.loadSettings(), embeddingProvider:'openai_compat', embeddingModel:'boundary',
      embeddingUrl:'https://fixture.invalid/v1', embeddingDimensions:3, embeddingMaxRetries:0, fallbackHashEmbedding:false,
      contextualRecall:true, embeddingEnabled:true, autoEpisodeIndex:false, episodeIndexEnabled:false, recallContextMessages:0});
    await t.saveEmbeddingKeyLocal('fixture-key'); await f.api.saveSettings(cfg);
    const inputs = [];
    f.host.nativeFetch = async (_url, init) => {
      const body = JSON.parse(init.body), list = Array.isArray(body.input) ? body.input : [body.input];
      inputs.push(...list);
      return new Response(JSON.stringify({data:list.map((_,index)=>({index,embedding:[1,0,0]}))}), {status:200});
    };
    f.currentChat.message = [{role:'user',chatId:'u',data:'Describe the archive.'},{role:'assistant',chatId:'a',data:'The archive contains the original travel journal.'}];
    f.currentChat.messages = f.currentChat.message;
    await f.api.ingestLiveChatColdStart({scope:'current',canonical:true});
    const scope = await f.api.resolveCurrentScope();
    const before = JSON.stringify((await t.loadScopeRecords(scope.scopeKey)).records);
    for (const temporal of ['past','current','compare']) {
      const query = {rawQuery:'항구에 도착했다고 쓰지 마.',intent:{temporal}};
      const result = await s.prepareFlashbackRecall(query,cfg,scope,{currentUser:query});
      assert.equal(result.temporalIntent,temporal,'semantic retrieval must preserve declared temporal intent');
      assert.equal(result.queryText,query.rawQuery,'embedding must receive prose without metadata serialization');
      assert.equal(result.overlay.facts.length,0);
      assert.equal(result.overlay.suppressions.length,0);
    }
    assert.equal(JSON.stringify((await t.loadScopeRecords(scope.scopeKey)).records),before);
    assert.ok(inputs.some(input=>input.includes('항구에 도착했다고 쓰지 마.')));
    assert.ok(inputs.every(input=>!input.includes('"temporal"')));
    console.log('PASS request prose preserved; no inferred state; declared intent reaches semantic recall; stored records unchanged');
  } finally { await f.dispose(); }
})().catch(e=>{console.error(e.stack);process.exitCode=1;});

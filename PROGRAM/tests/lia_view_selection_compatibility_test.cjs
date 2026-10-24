'use strict';
const assert = require('node:assert/strict');
const {createFixture} = require('./fixtures/lia_native_runtime_fixture.cjs');
(async () => {
 const f=await createFixture('official',{transformSource:s=>s.replace('      getLiveSyncCaptureState:', '      fullViewContext: getContext,\n      viewSelection: readLiaViewSelection,\n      verifyViewSelection: assertLiaViewSelectionCurrent,\n      getLiveSyncCaptureState:')});
 try {
  f.api.getCurrentCharacterIndex=async()=> '0';
  f.api.getCurrentChatIndex=async()=> '0';
  assert.equal(JSON.stringify(await f.runtime.viewSelection()),JSON.stringify({charIndex:0,chatIndex:0}));
  await f.runtime.verifyViewSelection({charIndex:0,chatIndex:0});
  assert.equal((await f.runtime.fullViewContext()).chatIndex,0);
  f.api.getCurrentChatIndex=async()=> '1';
  await assert.rejects(f.runtime.verifyViewSelection({charIndex:0,chatIndex:0}),/LIA_VIEW_SELECTION_CHANGED/);
  for(const bad of ['', ' ', false, -1, 0.5, 'no-index']) {
   f.api.getCurrentChatIndex=async()=>bad;
   await assert.rejects(f.runtime.viewSelection(),/LIA_VIEW_SELECTION_UNAVAILABLE/);
  }
  delete f.api.getCurrentChatIndex;
  assert.equal((await f.runtime.viewSelection()).chatIndex,0);
  f.api.getCurrentCharacterIndex=async()=>null;
  await assert.rejects(f.runtime.viewSelection(),/LIA_VIEW_SELECTION_UNAVAILABLE/);
  f.api.getCurrentCharacterIndex=async()=>0;
  let selectionReads=0;
  f.api.getCurrentChatIndex=async()=>selectionReads++ === 0 ? 0 : 1;
  await assert.rejects(f.runtime.fullViewContext(),/LIA_VIEW_SELECTION_CHANGED/);
  // When host selection cannot be verified, viewing context must not crash the product GUI.
  f.api.getCurrentCharacterIndex=async()=> -1;
  f.api.getCurrentChatIndex=async()=> -1;
  const unverifiedCtx = await f.runtime.fullViewContext();
  assert.equal(unverifiedCtx.chatIndex, 0);
  assert.equal(unverifiedCtx.viewSelectionVerified, false);
  console.log('PASS LIA view selection: serialized indices, legacy selection, invalid indices and changed chat');
 } finally {await f.dispose();}
})().catch(e=>{console.error(e);process.exitCode=1;});

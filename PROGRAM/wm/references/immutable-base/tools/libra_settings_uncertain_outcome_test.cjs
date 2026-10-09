'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {loadGui} = require('./libra_management_gui_integration_test.cjs');
const KEY = 'LMAI_Config';
const decodePhysical = store => {
  const root = JSON.parse(store.get(KEY));
  return root.__libraChunkedStorageV1 ? JSON.parse(root.chunks.map(key => store.get(key)).join('')) : root;
};
for (const size of [32, 600000]) for (const kind of ['false-before-write', 'false-after-write']) {
  test(`registered ${size > 32 ? 'chunked' : 'inline'} import ${kind} cannot be compensated by stale autosave`, async () => {
    const store = new Map([[KEY, JSON.stringify({directorEnabled:false, directorMode:'disabled', storyAuthorEnabled:false, storyAuthorMode:'disabled'})]]);
    const f = await loadGui({store, nativeInitialization:true});
    try {
      const beforeCanonical = store.get(f.key), storage = f.w.risuai.pluginStorage, set = storage.setItem.bind(storage);
      let invoked = 0;
      storage.setItem = async (key, value) => {
        if (key !== KEY) return set(key, value);
        invoked++;
        if (kind === 'false-after-write') await set(key, value);
        return false;
      };
      await f.overlay.querySelector('#settings-file-input').onchange({target:{files:[{name:'uncertain-settings.json',text:async()=>JSON.stringify({directorEnabled:true,directorMode:'light',storyAuthorEnabled:false,storyAuthorMode:'disabled',fixtureMarker:'x'.repeat(size)})}]}});
      assert.equal(invoked, 1, 'actual registered import reached physical root writer');
      assert.equal(f.api.MemoryEngine.CONFIG.directorMode, 'disabled', 'unverified import never publishes RAM');
      const expected = kind === 'false-after-write' ? 'light' : 'disabled';
      assert.equal(decodePhysical(store).directorMode, expected);
      assert(f.w.document.body.textContent.includes('저장 결과 미확인'));
      storage.setItem = set;
      const node = f.overlay.querySelector('#ssam'); node.value='supportive'; node.dispatchEvent(new f.w.Event('change',{bubbles:true}));
      const status=f.overlay.querySelector('#settings-auto-save-status'), deadline=Date.now()+6000;
      while (status.dataset.state === 'pending' || status.dataset.state === 'saving') {
        assert(Date.now()<deadline,'autosave settles'); await new Promise(resolve=>setTimeout(resolve,10));
      }
      assert.equal(decodePhysical(store).directorMode, expected, 'old UI cannot overwrite physically issued import');
      assert.equal(status.dataset.state,'failed','uncertain replacement fences a later old-view autosave');
      assert(status.textContent.includes('이전 화면'));
      assert(!f.w.document.body.textContent.includes('설정 파일 가져오기 완료'));
      assert.equal(store.get(f.key),beforeCanonical,'settings failure never cleans canonical source');
      const fresh=await loadGui({store,nativeInitialization:true});
      try{assert.equal(fresh.api.MemoryEngine.CONFIG.directorMode,expected,'native restart adopts actual physical value');}
      finally{fresh.close();}
    } finally {f.close();}
  });
}

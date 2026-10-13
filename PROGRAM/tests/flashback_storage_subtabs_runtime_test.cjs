'use strict';
const assert=require('node:assert/strict');
const {create,pause,until}=require('./fixtures/flashback_complete_gui_fixture.cjs');
(async()=>{const f=await create('Flashback','Source');try{
 await f.open();await f.click('.sidebar [data-go="vault"]');
 const active=id=>f.doc.querySelector('[data-subpanel="'+id+'"][data-group="v"]').classList.contains('is-active');
 const tab=id=>f.doc.querySelector('[data-subtab="'+id+'"][data-group="v"]');
 assert.equal(active('resp'),true,'vault starts on the response subtab');
 await f.click('[data-subtab="scopes"][data-group="v"]');
 assert.equal(active('resp'),false);assert.equal(active('scopes'),true);assert.equal(tab('scopes').getAttribute('aria-selected'),'true');assert.equal(tab('scopes').getAttribute('tabindex'),'0');
 await f.click('[data-subtab="resp"][data-group="v"]');
 assert.equal(active('resp'),true);assert.equal(active('scopes'),false);assert.equal(tab('scopes').getAttribute('tabindex'),'-1');
 assert.equal(f.api._test.normalizeFlashbackGuiTab('unknown'),'overview','unknown external navigation retains the canonical default route');
 await f.click('[data-subtab="scopes"][data-group="v"]');
 // The actual cross-screen source action must reveal the response editor.
 await f.click('[data-subtab="wl"][data-group="v"]');assert.equal(active('wl'),true);
 await f.click('#panel-worldline [data-open-manual-editor="response"]');assert.equal(active('resp'),true,'source button switches from worldline to response editor');assert.equal(active('wl'),false);
 const response=f.doc.querySelector('[data-subpanel="resp"][data-group="v"]'),scopes=f.doc.querySelector('[data-subpanel="scopes"][data-group="v"]');
 assert(response.querySelector('#manualEditorPanel'));assert(!response.querySelector('#storageRows'));assert(scopes.querySelector('#storageRows'));assert(!scopes.querySelector('#manualEditorPanel'));
 assert.deepEqual(f.errors,[]);assert.equal(f.wire.length,0);
 console.log('PASS storage subtabs: exclusive canonical visibility, ARIA, source entry routing and separated source/scope controls');
}finally{await f.close()}})().catch(e=>{console.error(e);process.exitCode=1});

'use strict';
const assert = require('node:assert/strict');
const {test} = require('node:test');
const {create, pause, until} = require('./fixtures/flashback_complete_gui_fixture.cjs');
const registryKey = 'vector_rag_memory:scope_registry:v2';
async function fixture(t, count = 3) {
  const f = await create('Flashback', 'Source');
  t.after(() => f.close());
  const current = (await f.api._test.resolveCurrentScopeIdentityBundle(false)).scope;
  for (let i = 0; i < count; i++) {
    const scope = i ? {...current, scopeKey:'viewer-scope-'+i, chatId:'viewer-scope-'+i, canonicalChatId:'viewer-scope-'+i, chatTitle:'Synthetic scope '+i} : current;
    await f.api._test.saveAllRecords([{id:'original-'+i, hash:'original-'+i, sourceType:'response', type:'response', text:'Stored original '+i, dim:4, vector:[1,0,0,0]}], null, scope);
  }
  return f;
}
async function openScopes(f) {
  await f.open();
  await f.click('.sidebar [data-go="vault"]');
  await f.click('[data-subtab="scopes"][data-group="v"]');
}
const countRows = f => f.doc.querySelectorAll('#storageRows tr[data-storage-scope-row]').length;
function counts(f, expected) {
  for (const id of ['tab-scope-n','nav-scope-n']) assert.equal(f.doc.getElementById(id).textContent, String(expected), id);
}
test('scope badges track enumeration and deletion, independent of search/view filters', async t => {
  const f = await fixture(t);
  await openScopes(f);
  await until(() => countRows(f) === 3, 'three scopes');
  counts(f, 3);
  await f.change('#storageScopeFilter', 'Synthetic scope 1');
  counts(f, 3);
  assert.equal(f.doc.querySelectorAll('#storageRows tr[data-storage-scope-row]:not([hidden])').length, 1);
  await f.change('#storageScopeFilter', '');
  await f.change('#storageManagementView', 'all');
  counts(f, 3);
  assert.equal((await f.api.deleteSelectedScopeStorages(['viewer-scope-1'])).deleted, 1);
  await f.click('#refreshStorageBtn');
  await until(() => countRows(f) === 2, 'deleted scope disappears');
  counts(f, 2);
  assert.equal(f.wire.length, 0);
});
test('failed forced refresh retains confirmed rows/counts, disables deletion, and recovers', async t => {
  const f = await fixture(t);
  await openScopes(f);
  await until(() => countRows(f) === 3, 'three scopes');
  const read = f.host.pluginStorage.getItem.bind(f.host.pluginStorage);
  let failures = 0;
  f.host.pluginStorage.getItem = async key => {
    if (String(key) === registryKey) { failures++; throw Error('SYNTHETIC_REGISTRY_UNAVAILABLE'); }
    return read(key);
  };
  await f.click('#refreshStorageBtn');
  const status = f.doc.querySelector('#storageScopeLoadStatus');
  await until(() => status && !status.hidden, 'visible read failure');
  assert(failures > 0);
  assert.match(status.textContent, /마지막 확인 목록/);
  assert.equal(countRows(f), 3);
  counts(f, 3);
  assert(!f.doc.querySelector('#storageRows').textContent.includes('저장된 스코프가 없습니다.'));
  assert([...f.doc.querySelectorAll('#storageRows button, #storageRows input, #deleteSelectedScopesBtn, #cleanupSelectedScopesBtn')].every(node => node.disabled));
  await f.change('#storageManagementView', 'all');
  assert.equal(countRows(f), 3, 'changing view retains the stale snapshot');
  counts(f, 3);
  assert(!status.hidden);
  f.host.pluginStorage.getItem = read;
  await f.click('#refreshStorageBtn');
  await until(() => status.hidden, 'successful retry clears error');
  assert.equal(countRows(f), 3);
  counts(f, 3);
  assert([...f.doc.querySelectorAll('#storageRows button[data-delete-scope]')].some(node => !node.disabled));
  assert.equal(f.wire.length, 0);
});
test('first-load failure is unknown, never an empty store or a fabricated zero', async t => {
  const f = await fixture(t, 1);
  const read = f.host.pluginStorage.getItem.bind(f.host.pluginStorage);
  f.host.pluginStorage.getItem = async key => {
    if (String(key) === registryKey) throw Error('SYNTHETIC_FIRST_READ_FAILURE');
    return read(key);
  };
  await openScopes(f);
  await until(() => f.doc.querySelector('#storageScopeLoadStatus')?.hidden === false, 'initial error');
  assert.match(f.doc.querySelector('#storageScopeLoadStatus').textContent, /비었다/);
  assert.match(f.doc.querySelector('#storageRows').textContent, /조회 실패/);
  assert(!f.doc.querySelector('#storageRows').textContent.includes('저장된 스코프가 없습니다.'));
  for (const id of ['tab-scope-n','nav-scope-n']) assert.equal(f.doc.getElementById(id).textContent, '—');
  await f.change('#storageManagementView', 'all');
  assert.match(f.doc.querySelector('#storageRows').textContent, /조회 실패/);
});
test('a successful empty enumeration legitimately shows zero', async t => {
  const f = await fixture(t, 0);
  await openScopes(f);
  await until(() => f.doc.querySelector('#storageRows')?.textContent.includes('저장된 스코프가 없습니다.'), 'verified empty listing');
  counts(f, 0);
  assert(f.doc.querySelector('#storageScopeLoadStatus').hidden);
});
test('a superseded failed refresh cannot overwrite a newer successful listing', async t => {
  const f = await fixture(t);
  await openScopes(f);
  const read = f.host.pluginStorage.getItem.bind(f.host.pluginStorage);
  let rejectOld, pending = false;
  f.host.pluginStorage.getItem = async key => {
    if (String(key) === registryKey && !pending) {
      pending = true;
      return new Promise((resolve, reject) => { rejectOld = reject; });
    }
    return read(key);
  };
  f.doc.querySelector('#refreshStorageBtn').click();
  await until(() => rejectOld, 'old pending registry read');
  await f.click('#refreshStorageBtn');
  await until(() => countRows(f) === 3, 'new successful listing');
  rejectOld(Error('SYNTHETIC_LATE_FAILURE'));
  await pause(180);
  counts(f, 3);
  assert(f.doc.querySelector('#storageScopeLoadStatus').hidden);
  assert.equal(countRows(f), 3);
});

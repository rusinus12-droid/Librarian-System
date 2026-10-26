'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { fixture, variants } = require('./storage_global_allchat_job_test.cjs');
const owners = variants.filter(row => row[0] !== 'flashback');

(async () => {
  for (const variant of owners) for (const localCopy of [false, true]) {
    const f = await fixture(variant, { bridgeOptions: { scopeManagement: true } }), ns = variant[0];
    try {
      await f.bridge.setGlobalMode('server_only');
      if (!localCopy) f.values.delete(ns + '.B');
      if (!localCopy) {
        const dom = new JSDOM('<!doctype html><div id="host"></div>');
        try {
          const container = dom.window.document.getElementById('host');
          await f.bridge.mountScopeManagementPanel(container);
          const checkbox = container.querySelector('[data-scope-select="B"]');
          assert.equal(checkbox.disabled, false);
          checkbox.click();
          container.querySelector('[data-scope-action="delete"]').click();
          assert.match(container.querySelector('[data-scope-confirm-text]').textContent, /로컬 복구는 하지 않으며/);
          assert.doesNotMatch(container.querySelector('[data-scope-confirm-text]').textContent, /로컬 복구를 검증|복구한 로컬/);
          container.querySelector('[data-scope-cancel]').click();
          for (let i = 0; i < 100 && container.querySelector('[data-scope-refresh]').disabled; i++) await new Promise(resolve => setTimeout(resolve, 1));
        } finally { dom.window.close(); }
      }
      const before = await f.bridge.inspectScopeCatalog(), row = before.rows.find(r => r.scopeId === 'B');
      assert.equal(row.canDelete, true);
      const localBefore = [...f.values];
      let localWrites = 0;
      f.store.setItem = f.store.removeItem = async () => { localWrites++; throw Error('LOCAL_STORAGE_WRITE_UNAVAILABLE'); };
      const result = await f.bridge.manageScope({ scopeId: 'B', action: 'delete', expectedFingerprint: row.fingerprint });
      assert.equal(result.serverOnly, true);
      assert.equal(result.localRestoreRequired, false);
      assert.ok(result.backupId);
      assert.ok(fs.existsSync(path.join(f.app.dataDir, 'backups', 'deleted-scopes', result.backupId, ns + '.sqlite')));
      assert.equal(f.app.repositories[ns].get('plugin', ns + '.B').exists, false);
      assert.deepEqual([...f.values], localBefore, 'local data and routing remain byte-for-byte unchanged');
      assert.equal(localWrites, 0, 'server deletion never depends on local writable storage');
      assert.equal(f.app.repositories[ns].get('plugin', ns + '.A').exists, true);
      assert.equal((await f.bridge.getScopeMode({ scopeId: 'B' })).mode, 'server_only');
      assert.ok(!f.calls.some(call => call.path === '/v1/manager/scope-delete/execute'), 'uses owner-scoped authority');
      console.log(ns + ': direct server deletion with ' + (localCopy ? 'retained' : 'absent') + ' local copy and unavailable local writes');
    } finally { await f.close(); }
  }

  for (const variant of owners) for (const scenario of ['pinned', 'referenced', 'navigation', 'backup', 'changed']) {
    const f = await fixture(variant, { bridgeOptions: { scopeManagement: true } }), ns = variant[0];
    try {
      await f.bridge.setGlobalMode('server_only');
      f.values.delete(ns + '.B');
      if (scenario === 'pinned' || scenario === 'referenced') {
        const call = f.host.nativeFetch, base = 'http://127.0.0.1:47631';
        const boot = await (await call(base + '/bootstrap', { headers: { 'X-Memory-Suite-Plugin': 'flashback_hayaku_bridge' } })).json();
        const headers = { Authorization: 'Bearer ' + boot.token, 'X-Memory-Suite-Plugin': 'flashback_hayaku_bridge', 'Content-Type': 'application/json' };
        const scopes = [{ scopeId: 'B', scopeKey: 'B', baseClassification: 'active', coverageComplete: true, members: [{ space: 'plugin', key: ns + '.B' }] }];
        if (scenario === 'referenced') scopes.push({ scopeId: 'A', scopeKey: 'A', baseClassification: 'active', coverageComplete: true, members: [], links: [{ targetRef: 'B', kind: 'predecessor' }] });
        let r = await call(base + '/v1/manager/scopes/index', { method: 'POST', headers, body: JSON.stringify({ namespace: ns, scopes }) });
        assert.equal(r.status, 200);
        if (scenario === 'pinned') {
          r = await call(base + '/v1/manager/scope-pin', { method: 'POST', headers, body: JSON.stringify({ namespace: ns, scopeId: 'B', pinned: true }) });
          assert.equal(r.status, 200);
        }
      } else if (scenario === 'backup') {
        f.app.repositories[ns].vacuumInto = () => { throw Error('SERVER_BACKUP_FAILED'); };
      } else {
        const fetch = f.host.nativeFetch;
        f.host.nativeFetch = async (u, i) => {
          const r = await fetch(u, i);
          if (u.endsWith('/scope-copy-delete/plan') && r.ok) {
            if (scenario === 'navigation') f.setCurrent('C');
            else f.app.repositories[ns].mutate({ kind: 'set', space: 'plugin', key: ns + '.B', value: 'B_CHANGED_AFTER_PLAN', operationId:'direct_delete_changed_fixture' });
          }
          return r;
        };
      }
      const c = await f.bridge.inspectScopeCatalog(), row = c.rows.find(r => r.scopeId === 'B');
      const localBefore = [...f.values];
      const expected = { pinned: /pinned/, referenced: /referenced_ancestor/, navigation: /context_changed/, backup: /SERVER_BACKUP_FAILED/, changed: /conditional|revision|digest|changed/i }[scenario];
      await assert.rejects(() => f.bridge.manageScope({ scopeId: 'B', action: 'delete', expectedFingerprint: row.fingerprint }), expected);
      assert.equal(f.app.repositories[ns].get('plugin', ns + '.B').exists, true);
      assert.deepEqual([...f.values], localBefore, 'failed deletion never restores data or changes storage mode');
      assert.equal((await f.bridge.getScopeMode({ scopeId: 'B' })).mode, 'server_only');
      console.log(ns + ': ' + scenario + ' blocks deletion without local mutations');
    } finally { await f.close(); }
  }
  for (const variant of owners) {
    const f = await fixture(variant, { bridgeOptions: { scopeManagement:true } }), ns = variant[0];
    try {
      await f.bridge.setGlobalMode('server_only');
      const call = f.host.nativeFetch, base = 'http://127.0.0.1:47631';
      const boot = await (await call(base + '/bootstrap', { headers:{'X-Memory-Suite-Plugin':variant[1]} })).json();
      const headers = {Authorization:'Bearer ' + boot.token,'X-Memory-Suite-Plugin':variant[1],
        'X-Memory-Suite-Scope-Id':'B','X-Memory-Suite-Storage-Mode':'server_only','Content-Type':'application/json'};
      const row = f.app.repositories[ns].get('plugin',ns + '.B');
      const body = {namespace:ns,scopeId:'B',scopeKey:'B',directServerDelete:true,
        mutations:[{kind:'remove',space:'plugin',key:ns + '.B',expectedRevision:row.revision,expectedDigest:row.digest,expectedExists:true,expectedTombstone:false}]};
      let response = await call(base + '/v1/owner/scope-copy-delete/plan', {method:'POST',headers,
        body:JSON.stringify({...body,namespace:ns === 'hayaku'?'libra':'hayaku'})});
      assert.equal(response.status,409,'owner cannot plan a deletion in another namespace');
      response = await call(base + '/v1/owner/scope-copy-delete/plan', {method:'POST',
        headers:{...headers,'X-Memory-Suite-Storage-Mode':'plugin_only'},body:JSON.stringify(body)});
      assert.equal(response.status,409,'direct deletion requires the server-only route');
      const managerBoot = await (await call(base + '/bootstrap', {headers:{'X-Memory-Suite-Plugin':'flashback_hayaku_bridge'}})).json();
      const managerHeaders = {...headers,Authorization:'Bearer ' + managerBoot.token,'X-Memory-Suite-Plugin':'flashback_hayaku_bridge'};
      response = await call(base + '/v1/manager/scopes/index', {method:'POST',headers:managerHeaders,
        body:JSON.stringify({namespace:ns,scopes:[{scopeId:'B',scopeKey:'B',baseClassification:'active',coverageComplete:true,members:[{space:'plugin',key:ns + '.B'}]}]})});
      assert.equal(response.status,200);
      response = await call(base + '/v1/manager/scope-delete/plan', {method:'POST',headers:managerHeaders,body:JSON.stringify(body)});
      assert.equal(response.status,409);
      assert.equal((await response.json()).error,'scope_delete_plugin_only_mode_proof_required','payload flag cannot bypass the existing manager protocol');
      assert.equal(f.app.repositories[ns].get('plugin',ns + '.B').exists,true);
      console.log(ns + ': owner namespace, storage mode and manager protocol boundaries hold');
    } finally { await f.close(); }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });

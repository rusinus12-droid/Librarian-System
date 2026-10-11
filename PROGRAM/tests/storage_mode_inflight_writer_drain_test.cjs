'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createMemorySuiteServer } = require('../server/server.cjs');
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

async function run() {
  const app = createMemorySuiteServer({ host:'127.0.0.1', port:0,
    dataDir:fs.mkdtempSync(path.join(os.tmpdir(), 'mode-writer-drain-')), autoBackup:false });
  const { port } = await app.listen();
  const url = `http://127.0.0.1:${port}`;
  const previous = globalThis.risuai;
  let passed = 0;
  try {
    for (const [namespace, pluginId] of [['flashback','flashback_memory'],
      ['hayaku','hayaku_locator_continuity'], ['libra','libra'],
      ['lia','lia_persona_linker'], ['retrace','flashback_hayaku_bridge']]) {
      const variant = namespace === 'libra' ? 'MemorySuiteStorageClient.libra.source.js'
        : 'MemorySuiteStorageClient.source.js';
      const program=path.join(__dirname,'..');
      const preservedFile=namespace==='lia'?'LIA_Persona_Linker.js':namespace==='retrace'?'RETRACE.js':null;
      const source=preservedFile ? require('../tools/lib/sdk_variants.cjs').expectedStorageSdk(program,preservedFile,fs.readFileSync(path.join(program,'plugins',preservedFile),'utf8')) : fs.readFileSync(path.join(program,'sdk',variant),'utf8');
      const create = new Function(source + '\nreturn createMemorySuiteStorageBridge')();
      const scope = { scopeId:namespace+'-drain', scopeKey:namespace+'-drain', chatId:namespace+'-drain' };
      const key = namespace === 'flashback' ? 'vector_rag_memory:scope:drain:accepted'
        : namespace+'.drain.memory';
      const values = new Map([[key, { n:1 }]]);
      const store = { getItem:async k => values.get(k) ?? null,
        setItem:async (k,v) => { values.set(k,v); return true; },
        removeItem:async k => { values.delete(k); return true; }, keys:async () => [...values.keys()] };
      globalThis.risuai = { pluginStorage:store, getArgument:async name => name.includes('url') ? url : 'plugin_only',
        setArgument:async () => true, nativeFetch:fetch };
      const options = { namespace, pluginId, pluginVersion:'writer-drain-test', defaultUrl:url,
        managementButton:false, startupDiagnostics:false, autoMigratePlugin:false, autoMigrateLocal:false,
        pluginPrefixes:[namespace+'.', 'vector_rag_memory:'], currentScopeProvider:async () => scope,
        resolveKeyScope:async () => ({ kind:'scope', scope }) };
      if(namespace==='lia'||namespace==='retrace') {
        // Retired owners no longer admit remote writer cutovers. Keep actual
        // accepted local/manager operations and prove refusal cannot lose them.
        const policy=namespace==='lia'?'local_only':'manager_only';
        const bridge=create({...options,storagePolicy:policy,...(namespace==='retrace'?{scopeRouting:false}:{})});
        const entered=deferred(),release=deferred();
        const beforeRemote=app.repositories[namespace].database.prepare('SELECT * FROM kv ORDER BY space,key').all();
        try {
          const read=store.getItem;store.getItem=async k=>{if(k===key){entered.resolve();await release.promise;}return read(k);};
          const proxy=namespace==='lia'?bridge.createPluginStorageProxy(store):null;
          const accepted=namespace==='lia'?proxy.getItem(key):bridge.readLegacyValue('plugin',key,scope);
          await entered.promise;
          if(namespace==='lia') await assert.rejects(()=>bridge.setMode('server_only'),e=>e.code==='MEMORY_SUITE_LOCAL_ONLY_OWNER_POLICY');
          else { assert.equal(typeof bridge.setMode,'undefined');assert.equal(typeof bridge.createPluginStorageProxy,'undefined'); }
          assert.deepEqual(values.get(key),{n:1});
          release.resolve();assert.deepEqual(await accepted,{n:1});
          if(proxy){await proxy.setItem(key,{n:2});assert.deepEqual(await proxy.getItem(key),{n:2});}
          assert.deepEqual(app.repositories[namespace].database.prepare('SELECT * FROM kv ORDER BY space,key').all(),beforeRemote);
          assert.equal(await bridge.getMode(),'plugin_only');passed++;
          console.log('PASS '+namespace+' accepted current operation survives remote writer refusal; no retired cutover supported');
        } finally {release.resolve();await bridge.dispose();}
        continue;
      }
      let bridge = create(options);
      const proxy = bridge.createPluginStorageProxy(store);
      const entered = deferred(), release = deferred(), lateEntered = deferred(), releaseLate = deferred();
      let changing = null;
      try {
        const finishAcceptedWork = async () => {
          entered.resolve();
          await release.promise;
          await proxy.getItem(key);
          await proxy.setItem(key, { n:2 });
          return true;
        };
        const accepted = (namespace === 'flashback'
          ? bridge.withFlashbackWriter(key, finishAcceptedWork)
          : bridge.get('plugin', key, finishAcceptedWork))
          .then(value => ({ ok:true, value }), error => ({ ok:false, code:error.code }));
        await entered.promise;
        let switched = false;
        changing = bridge.setMode('server_only').then(result => { switched = true; return result; });
        // Let the mode-setting preparation reach its wait while the accepted work remains held.
        await new Promise(done => setImmediate(done));
        assert.equal(switched, false, 'cutover must wait for the accepted owner operation');
        await assert.rejects(() => bridge.setServerUrl(url),
          error => error.code === 'MEMORY_SUITE_STORAGE_TRANSITION_IN_PROGRESS');
        await assert.rejects(() => bridge.ensureHandoffReady(),
          error => error.code === 'MEMORY_SUITE_STORAGE_TRANSITION_IN_PROGRESS');
        // A second operation can enter while preparation waits for the first.
        // It must also finish before the snapshot, even though it was not in the first wait set.
        const late = bridge.get('plugin', key, async () => {
          lateEntered.resolve();
          await releaseLate.promise;
          await proxy.setItem(key, { n:3 });
          return true;
        }).then(value => ({ ok:true, value }), error => ({ ok:false, code:error.code }));
        await Promise.race([lateEntered.promise, late]);
        release.resolve();
        const outcome = await accepted;
        await new Promise(done => setImmediate(done));
        assert.equal((await bridge.getScopeMode(scope)).transition?.phase, 'draining',
          namespace+': preparation must drain work admitted after the first wait set');
        releaseLate.resolve();
        const lateOutcome = await late;
        const result = await changing;
        assert.equal(outcome.ok, true, namespace+': accepted nested I/O must finish before cutover: '+outcome.code);
        assert.equal(lateOutcome.ok, true, namespace+': later admitted I/O must finish before cutover');
        assert.equal(result.to, 'server_only');
        assert.deepEqual(await proxy.getItem(key), { n:3 }, 'target must contain both accepted writes');
        assert.deepEqual(values.get(key), { n:3 }, 'retained local copy must contain both accepted writes');
        await bridge.dispose();
        bridge = create(options);
        const reopened = bridge.createPluginStorageProxy(store);
        assert.equal((await bridge.getScopeMode(scope)).mode, 'server_only');
        assert.deepEqual(await reopened.getItem(key), { n:3 }, 'fresh bridge must read the durable server value');
        passed++;
        console.log('PASS '+namespace+' accepted owner work drains before verified cutover');
      } finally {
        release.resolve();
        releaseLate.resolve();
        if (changing) await changing.catch(() => {});
        await bridge.dispose();
      }
    }
  } finally {
    globalThis.risuai = previous;
    await app.close();
  }
  console.log(JSON.stringify({ test:'storage_mode_inflight_writer_drain', passed, server:'real HTTP + SQLite', liveRisuAI:'NOT_RUN' }));
}
run().catch(error => { console.error(error); process.exitCode = 1; });

'use strict';
// Device-local derived corpus only. IndexedDB transactions serialize publication,
// reader pins and reclamation across tabs; host source records are never written.
module.exports = function createMemoryGraphLocalStore({ indexedDB, fingerprint, now = Date.now,
  databaseName = 'libra-derived-corpus-v1', leaseMs = 60000 } = {}) {
  if (!indexedDB?.open || typeof fingerprint !== 'function') throw new TypeError('LIBRA_LOCAL_CORPUS_ADAPTER_REQUIRED');
  const fail = reason => { throw new Error('LIBRA_LOCAL_CORPUS_' + reason); };
  const prefixFor = scope => {
    if (typeof scope !== 'string' || !/^[A-Za-z0-9_.:-]{1,700}$/.test(scope)) fail('SCOPE_INVALID');
    return 'libra:v1:scope:' + scope + ':memory-graph:v1:corpus:';
  };
  let opening = null, nonce = 0;
  const salt = String(now()) + ':' + Math.random();
  const open = () => opening || (opening = new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore('records', { keyPath: ['scope','key'] }).createIndex('scope','scope');
      request.result.createObjectStore('controls', { keyPath: 'scope' });
    };
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('LIBRA_LOCAL_CORPUS_OPEN_BLOCKED'));
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => { db.close(); opening = null; };
      resolve(db);
    };
  }).catch(error => { opening = null; throw error; }));
  const transaction = async (scope, body, onBegin = null) => {
    const db = await open();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(['records','controls'], 'readwrite');
      const records = tx.objectStore('records'), controls = tx.objectStore('controls');
      let result, failure;
      const abort = error => { failure = error; try { tx.abort(); } catch (_) {} };
      const run = fn => { try { fn(); } catch (error) { abort(error); } };
      const get = (store, key, callback) => {
        const request = store.get(store.name === 'records' ? [scope,key] : key);
        request.onsuccess = () => run(() => callback(request.result));
      };
      tx.oncomplete = () => resolve(result);
      tx.onabort = () => reject(failure || tx.error || new Error('LIBRA_LOCAL_CORPUS_TRANSACTION_ABORTED'));
      tx.onerror = () => {}; // onabort reports the transaction's error.
      if (onBegin) { try { onBegin(tx); } catch (error) { abort(error); return; } }
      get(controls, scope, saved => {
        const state = saved || { scope, schema: 'libra.local_corpus_control.v1', leases: [], roots: {} };
        if (state.schema !== 'libra.local_corpus_control.v1' || !Array.isArray(state.leases) || state.leases.length > 32
          || !state.roots || Object.keys(state.roots).length > 16
          || state.leases.some(lease => !['read','build'].includes(lease.kind) || !Number.isSafeInteger(lease.expiresAt)
            || !Array.isArray(lease.pins) || lease.pins.length > 32)) fail('CONTROL_CORRUPT');
        state.leases = state.leases.filter(lease => lease.expiresAt > now());
        body({ records, controls, state, get, run, finish: value => { result = value; } });
      });
    });
  };
  const requireLease = (state, token, kind = null) => {
    const lease = state.leases.find(row => row.token === token && row.expiresAt > now() && (!kind || row.kind === kind));
    if (!lease) fail('LEASE_EXPIRED');
    return lease;
  };
  const owned = (prefix, key) => { if (typeof key !== 'string' || !key.startsWith(prefix)) fail('KEY_UNOWNED'); };
  // Every callback stays inside its native transaction. Never await an IPC or a
  // promise while holding the storage transaction, or emulate it with a JS lock.
  const acquire = async (scope, kind, partition = 'owner') => {
    const prefix = prefixFor(scope);
    if (!['read','build'].includes(kind) || typeof partition !== 'string' || partition.length > 2048) fail('LEASE_INVALID');
    const token = fingerprint(salt + ':' + ++nonce);
    await transaction(scope, ({ controls, state, finish }) => {
      if (state.leases.length >= 32) fail('LEASE_LIMIT');
      state.leases.push({ token, kind, expiresAt: now() + leaseMs, pins: [] });
      controls.put(state); finish(true);
    });
    let closed = false, timer;
    const activeTransactions = new Set();
    const operate = async body => {
      if (closed) fail('LEASE_CLOSED');
      let physical;
      try {
        return await transaction(scope, context => {
          if (closed) fail('LEASE_CLOSED');
          body(context, requireLease(context.state, token));
        }, tx => { physical = tx; activeTransactions.add(tx); if (closed) fail('LEASE_CLOSED'); });
      } finally { if (physical) activeTransactions.delete(physical); }
    };
    const renew = async () => {
      try { await operate(({ controls, state, finish }, lease) => {
        lease.expiresAt = now() + leaseMs; controls.put(state); finish(true);
      }); } catch (_) { return; }
      timer = setTimeout(renew, Math.max(1, Math.floor(leaseMs / 3))); timer?.unref?.();
    };
    timer = setTimeout(renew, Math.max(1, Math.floor(leaseMs / 3))); timer?.unref?.();
    return Object.freeze({
      backend: 'indexeddb',
      assertCurrent: () => operate(({ finish }) => finish(true)),
      read: key => {
        owned(prefix,key);
        return operate(({ records, controls, state, get, finish }, lease) => get(records,key,row => {
          requireLease(state,token);
          if (row && key.startsWith(prefix + 'root:')) {
            if (row.raw.length > 4096) fail('ROOT_CORRUPT');
            const root = JSON.parse(row.raw);
            if (!lease.pins.some(pin => pin.key === key && pin.raw === row.raw)) {
              if (lease.pins.length >= 32) fail('PIN_LIMIT');
              lease.pins.push({ key, raw: row.raw }); controls.put(state);
            }
            if (root.schema !== 'libra.graph_corpus.v1') fail('ROOT_CORRUPT');
          }
          finish(row?.raw ?? null);
        }));
      },
      putImmutable: (key, raw) => {
        owned(prefix,key);
        if (typeof raw !== 'string' || raw.length > 8388608 || key.startsWith(prefix + 'root:')) fail('VALUE_INVALID');
        return operate(({ records, state, get, finish }, lease) => {
          if (lease.kind !== 'build') fail('BUILD_LEASE_REQUIRED');
          get(records,key,row => {
            requireLease(state,token,'build');
            if (row && row.raw !== raw) fail('IMMUTABLE_CONFLICT');
            if (!row) records.put({ scope, key, raw, updatedAt: now() });
            finish(true);
          });
        });
      },
      publish: ({ key, raw, previous, manifestKey, manifestRaw }) => {
        owned(prefix,key); owned(prefix,manifestKey);
        if (!key.startsWith(prefix + 'root:') || typeof raw !== 'string' || raw.length > 4096) fail('ROOT_INVALID');
        return operate(({ records, controls, state, get, finish }, lease) => {
          if (lease.kind !== 'build') fail('BUILD_LEASE_REQUIRED');
          get(records,key,current => get(records,manifestKey,manifest => {
            if ((current?.raw ?? null) !== previous || manifest?.raw !== manifestRaw) fail('ROOT_CONFLICT');
            const root = JSON.parse(raw);
            if (root.schema !== 'libra.graph_corpus.v1' || root.manifestKey !== manifestKey
              || fingerprint(manifestRaw) !== (root.digest || root.generation)) fail('ROOT_CORRUPT');
            const pending = [{ key: manifestKey, digest: root.digest || root.generation, type: 'manifest' }], seen = new Set();
            let checkedBytes = 0;
            const next = () => {
              const ref = pending.pop();
              if (!ref) {
                // Validation can span many asynchronous IDB reads. Expiration
                // at entry alone cannot authorize a later root mutation.
                requireLease(state,token,'build');
                records.put({ scope, key, raw, updatedAt: now() });
                // A changing cutoff/view must not keep every historical root alive.
                // Active readers pin their old root + manifest independently.
                state.roots[partition] = { key, publishedAt: now() };
                const partitions = Object.keys(state.roots).sort((a,b) => state.roots[b].publishedAt - state.roots[a].publishedAt);
                for (const old of partitions.slice(16)) delete state.roots[old];
                controls.put(state); finish(true); return;
              }
              owned(prefix,ref.key);
              if (!/^[a-f0-9]{64}$/.test(ref.digest)) fail('REFERENCE_CORRUPT');
              if (seen.has(ref.key)) { next(); return; } seen.add(ref.key);
              if (seen.size > 8192) fail('REFERENCE_BUDGET');
              get(records,ref.key,row => {
                if (!row) fail('REFERENCE_MISSING');
                checkedBytes += row.raw.length * 2 + 2048;
                if (checkedBytes > 33554432) fail('REFERENCE_BUDGET');
                if (fingerprint(row.raw) !== ref.digest) fail('REFERENCE_CORRUPT');
                if (ref.type) {
                  const item = JSON.parse(row.raw);
                  if (ref.type === 'manifest') {
                    if (item.schema !== 'libra.graph_corpus.v1' || !Array.isArray(item.refs)) fail('MANIFEST_CORRUPT');
                    pending.push(...item.refs);
                    if (item.sourceProofs) pending.push({key:item.sourceProofs.proofKey,digest:item.sourceProofs.proofDigest},
                      {key:item.sourceProofs.projectionKey,digest:item.sourceProofs.projectionDigest,type:'projection'});
                    if (item.semanticDirectory) pending.push({...item.semanticDirectory,type:'semantic'});
                  } else if (ref.type === 'semantic') {
                    if (item.schema !== 'libra.graph_semantic_directory.v1' || !Array.isArray(item.entries)) fail('SEMANTIC_DIRECTORY_CORRUPT');
                    for (const entry of item.entries) pending.push(...(entry.vectorPages || []));
                  } else if (item.schema === 'libra.graph_corpus_projection_build.v1') {
                    if (!Array.isArray(item.windows)) fail('PROJECTION_CORRUPT');
                    pending.push(...item.windows.map(child => ({...child,type:'projection'})));
                  } else if (['libra.graph_corpus_projection.v2','libra.graph_corpus_projection_window.v1'].includes(item.schema)) {
                    if (!item.parts || Object.keys(item.parts).sort().join(',') !== 'bases,canonicalRows,edges,nodes,units') fail('PROJECTION_CORRUPT');
                    for (const part of Object.values(item.parts)) {
                      if (!Array.isArray(part.refs)) fail('PROJECTION_CORRUPT');
                      pending.push(...part.refs);
                    }
                    if (item.schema === 'libra.graph_corpus_projection.v2') pending.push({...item.build,type:'projection'});
                  } else if (item.schema !== 'libra.graph_corpus_projection.v1') fail('PROJECTION_CORRUPT');
                }
                next();
              });
            };
            next();
          }));
        });
      },
      release: async () => {
        if (closed) return;
        closed = true; clearTimeout(timer);
        for (const tx of activeTransactions) { try { tx.abort(); } catch (_) {} }
        try {
          await transaction(scope, ({ controls, state, finish }) => {
            state.leases = state.leases.filter(lease => lease.token !== token); controls.put(state); finish(true);
          });
        } catch (_) { /* Closed locally; a failed durable release expires after 60s. */ }
      }
    });
  };
  const collectGarbage = async (scope, { dryRun = false, candidateKeys = null, resources = null } = {}) => {
    const prefix = prefixFor(scope);
    if (candidateKeys !== null && (!Array.isArray(candidateKeys) || candidateKeys.length > 8192 || candidateKeys.some(key => typeof key !== 'string'))) fail('CANDIDATES_INVALID');
    const selected = candidateKeys === null ? null : new Set(candidateKeys);
    return await transaction(scope, ({ records, state, get, run, finish }) => {
      const base = { schema: 'libra.graph_store_gc.v1', scopeKey: scope, dryRun: Boolean(dryRun),
        backend: 'indexeddb', corpusReclamation: 'local_transaction_reachability', candidateKeys: [], deletedKeys: [],
        legacyHostRecords: 'preserved_atomic_gc_unavailable' };
      if (state.leases.some(lease => lease.kind === 'build')) { finish({ ...base, status: 'blocked_active_builds' }); return; }
      const rows = new Map(); let bytes = 0;
      const cursor = records.index('scope').openCursor(scope);
      cursor.onsuccess = () => run(() => {
        resources?.check();
        const current = cursor.result;
        if (current) {
          const row = current.value;
          if (row.scope === scope) {
            owned(prefix,row.key);
            bytes += row.raw.length * 2 + 2048;
            if (rows.size >= 8192 || bytes > 33554432) fail('INVENTORY_BUDGET');
            resources?.reserveRetained(row.raw.length * 2 + 2048,'local_gc_inventory');
            rows.set(row.key,row);
          }
          current.continue(); return;
        }
        const retained = new Set(), visited = new Set();
        const keep = key => {
          owned(prefix,key);
          if (!rows.has(key)) fail('REFERENCE_MISSING');
          retained.add(key); return rows.get(key).raw;
        };
        const value = (key, digest = null) => {
          resources?.check();
          const raw = keep(key);
          if (digest && fingerprint(raw) !== digest) fail('REFERENCE_CORRUPT');
          const parsed = JSON.parse(raw);
          resources?.retain(parsed,'local_gc_metadata');
          return parsed;
        };
        const projection = ref => {
          if (!ref || ref.key !== prefix + 'projection:' + ref.digest) fail('REFERENCE_UNOWNED');
          const item = value(ref.key,ref.digest);
          if (visited.has(ref.key)) return; visited.add(ref.key);
          if (item.schema === 'libra.graph_corpus_projection.v1') return;
          if (item.schema === 'libra.graph_corpus_projection_build.v1') {
            if (!Array.isArray(item.windows)) fail('PROJECTION_CORRUPT');
            for (const child of item.windows) projection(child);
          } else if (['libra.graph_corpus_projection.v2','libra.graph_corpus_projection_window.v1'].includes(item.schema)) {
            if (!item.parts || Object.keys(item.parts).sort().join(',') !== 'bases,canonicalRows,edges,nodes,units') fail('PROJECTION_CORRUPT');
            for (const part of Object.values(item.parts)) {
              if (!Array.isArray(part.refs)) fail('PROJECTION_CORRUPT');
              for (const child of part.refs) { if (child.key !== prefix + 'projection:' + child.digest) fail('REFERENCE_UNOWNED'); keep(child.key); }
            }
            if (item.schema === 'libra.graph_corpus_projection.v2') projection(item.build);
          } else fail('PROJECTION_CORRUPT');
        };
        const root = (key, raw = null) => {
          const saved = keep(key);
          // The same mutable root key may already publish a newer manifest.
          // Retain the old reader's captured manifest as well as the live root.
          const item = JSON.parse(raw === null ? saved : raw);
          if (item.schema !== 'libra.graph_corpus.v1') fail('ROOT_CORRUPT');
          const manifest = value(item.manifestKey,item.digest || item.generation);
          if (!Array.isArray(manifest.refs)) fail('MANIFEST_CORRUPT');
          for (const ref of manifest.refs) keep(ref.key);
          if (manifest.sourceProofs) {
            keep(manifest.sourceProofs.proofKey);
            projection({ key: manifest.sourceProofs.projectionKey, digest: manifest.sourceProofs.projectionDigest });
          }
          if (manifest.semanticDirectory) {
            const directory = value(manifest.semanticDirectory.key,manifest.semanticDirectory.digest);
            if (directory.schema !== 'libra.graph_semantic_directory.v1' || !Array.isArray(directory.entries)) fail('SEMANTIC_DIRECTORY_CORRUPT');
            for (const entry of directory.entries) for (const page of entry.vectorPages || []) keep(page.key);
          }
        };
        for (const entry of Object.values(state.roots)) root(entry.key);
        for (const lease of state.leases) for (const pin of lease.pins) root(pin.key,pin.raw);
        for (const row of rows.values()) if (row.key.startsWith(prefix + 'checkpoint:') && now() - row.updatedAt < 86400000) retained.add(row.key);
        const candidates = [...rows.keys()].filter(key => !retained.has(key) && (!selected || selected.has(key)));
        // Inventory, reachability, pins and deletion share this single native
        // read/write transaction; a crashed tab cannot leave a partial sweep.
        if (!dryRun) for (const key of candidates) records.delete([scope,key]);
        finish({ ...base, status: 'completed', candidateKeys: candidates, deletedKeys: dryRun ? [] : candidates,
          retainedKeyCount: retained.size, protectedReaderCount: state.leases.filter(lease => lease.kind === 'read').length,
          inventoryBytes: bytes, inventoryRecords: rows.size });
      });
    });
  };
  const discardScope = async scope => {
    prefixFor(scope);
    return await transaction(scope, ({ records, controls, state, run, finish }) => {
      const cursor = records.index('scope').openCursor(scope); let deleted = 0;
      cursor.onsuccess = () => run(() => {
        const current = cursor.result;
        if (current) { if (current.value.scope === scope) { current.delete(); deleted++; } current.continue(); return; }
        // Revoke old readers/builders in the same transaction as the deletion.
        state.leases = []; state.roots = {}; controls.put(state); finish({deleted});
      });
    });
  };
  return Object.freeze({ ready: open, acquire, collectGarbage, discardScope, close: async () => {
    if (opening) { (await opening).close(); opening = null; }
  } });
};

'use strict';
// Device-local derived corpus only. IndexedDB transactions serialize publication,
// reader pins and reclamation across tabs; host source records are never written.
module.exports = function createMemoryGraphLocalStore({ indexedDB, fingerprint, now = Date.now,
  forestReferences = typeof libraForestReferences === 'function' ? libraForestReferences : require('./libra_memory_graph_forest_refs.cjs'),
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
            if (!['libra.graph_corpus.v1','libra.graph_corpus.v2'].includes(root.schema)) fail('ROOT_CORRUPT');
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
            if (!['libra.graph_corpus.v1','libra.graph_corpus.v2'].includes(root.schema) || root.manifestKey !== manifestKey
              || fingerprint(manifestRaw) !== (root.digest || root.generation)) fail('ROOT_CORRUPT');
            const pending = [{ key: manifestKey, digest: root.digest || root.generation, type: 'manifest' }], seen = new Set();
            const forestRoot=root.schema==='libra.graph_corpus.v2';
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
              if (seen.size > (forestRoot?100000:8192)) fail('REFERENCE_BUDGET');
              get(records,ref.key,row => {
                if (!row) fail('REFERENCE_MISSING');
                checkedBytes += row.raw.length * 2 + 2048;
                if ((!forestRoot&&checkedBytes > 33554432)||row.raw.length*2+2048>33554432) fail('REFERENCE_BUDGET');
                if (fingerprint(row.raw) !== ref.digest) fail('REFERENCE_CORRUPT');
                if (ref.type) {
                  const item = JSON.parse(row.raw);
                  if (ref.type === 'manifest') {
                    if (!['libra.graph_corpus.v1','libra.graph_corpus.v2'].includes(item.schema) || !Array.isArray(item.refs)) fail('MANIFEST_CORRUPT');
                    pending.push(...forestReferences(item,prefix));
                    pending.push(...item.refs);
                    if (item.sourceProofs) pending.push({key:item.sourceProofs.proofKey,digest:item.sourceProofs.proofDigest},
                      {key:item.sourceProofs.projectionKey,digest:item.sourceProofs.projectionDigest,type:'projection'});
                    if (item.semanticDirectory) pending.push({...item.semanticDirectory,type:'semantic'});
                  } else if (ref.type === 'forest') {
                    if(item.schema!=='libra.graph_corpus_forest_node.v1')fail('REFERENCE_CORRUPT');
                    pending.push(...forestReferences(item,prefix));
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
    const prefix=prefixFor(scope);
    if(candidateKeys!==null&&(!Array.isArray(candidateKeys)||candidateKeys.length>8192||candidateKeys.some(k=>typeof k!=='string')))fail('CANDIDATES_INVALID');
    const selected=candidateKeys===null?null:new Set(candidateKeys);
    return transaction(scope,({records,state,get,run,finish})=>{
      const base={schema:'libra.graph_store_gc.v1',scopeKey:scope,dryRun:Boolean(dryRun),backend:'indexeddb',corpusReclamation:'local_transaction_reachability',
        candidateKeys:[],deletedKeys:[],legacyHostRecords:'preserved_atomic_gc_unavailable'};
      if(state.leases.some(l=>l.kind==='build')){finish({...base,status:'blocked_active_builds'});return;}
      const retained=new Set(),seen=new Set(),pending=[];let inventoryRecords=0,inventoryBytes=0;
      const keep=key=>{
        owned(prefix,key);
        if(!retained.has(key)){if(retained.size>=100000)fail('REFERENCE_BUDGET');resources?.reserveRetained(key.length*2+96,'local_gc_reachability');retained.add(key);}
      };
      for(const entry of Object.values(state.roots))pending.push({key:entry.key,type:'root'});
      for(const lease of state.leases)for(const pin of lease.pins)pending.push({key:pin.key,type:'root',raw:pin.raw});
      const sweep=()=>{
        const candidates=[],deleted=[];let more=false;
        const cursor=records.index('scope').openCursor(scope);
        cursor.onsuccess=()=>run(()=>{
          resources?.check();const current=cursor.result;
          if(!current){finish({...base,status:'completed',candidateKeys:candidates,deletedKeys:deleted,hasMore:more,
            retainedKeyCount:retained.size,protectedReaderCount:state.leases.filter(l=>l.kind==='read').length,inventoryBytes,inventoryRecords});return;}
          const row=current.value;owned(prefix,row.key);
          if(!retained.has(row.key)&&(!selected||selected.has(row.key))){
            if(candidates.length<256){candidates.push(row.key);if(!dryRun){records.delete([scope,row.key]);deleted.push(row.key);}}
            else more=true;
          }
          current.continue();
        });
      };
      const mark=()=>{
        resources?.check();let ref,identity;
        do{ref=pending.pop();if(!ref){sweep();return;}owned(prefix,ref.key);identity=ref.key+(ref.raw===undefined?'':':'+fingerprint(ref.raw));}while(seen.has(identity));
        seen.add(identity);keep(ref.key);
        get(records,ref.key,row=>{
          if(!row)fail('REFERENCE_MISSING');const raw=ref.raw===undefined?row.raw:ref.raw;
          if(typeof raw!=='string'||raw.length*2+2048>33554432)fail('REFERENCE_BUDGET');
          if(ref.digest&&fingerprint(raw)!==ref.digest)fail('REFERENCE_CORRUPT');
          if(!ref.type){mark();return;}
          const held=resources?.retain(raw,'local_gc_record',2);
          try{
            const item=JSON.parse(raw);
            if(ref.type==='root'){
              if(!['libra.graph_corpus.v1','libra.graph_corpus.v2'].includes(item.schema))fail('ROOT_CORRUPT');
              if(item.manifestKey!==prefix+'manifest:'+(item.digest||item.generation))fail('REFERENCE_UNOWNED');
              pending.push({key:item.manifestKey,digest:item.digest||item.generation,type:'manifest'});
            }else if(ref.type==='manifest'){
              if(!['libra.graph_corpus.v1','libra.graph_corpus.v2'].includes(item.schema)||!Array.isArray(item.refs))fail('MANIFEST_CORRUPT');
              pending.push(...item.refs,...forestReferences(item,prefix));
              if(item.sourceProofs)pending.push({key:item.sourceProofs.proofKey,digest:item.sourceProofs.proofDigest},
                {key:item.sourceProofs.projectionKey,digest:item.sourceProofs.projectionDigest,type:'projection'});
              if(item.semanticDirectory)pending.push({...item.semanticDirectory,type:'semantic'});
            }else if(ref.type==='forest'||ref.type==='checkpoint'){
              if(ref.type==='forest'&&item.schema!=='libra.graph_corpus_forest_node.v1')fail('REFERENCE_CORRUPT');
              pending.push(...forestReferences(item,prefix));
            }else if(ref.type==='semantic'){
              if(item.schema!=='libra.graph_semantic_directory.v1'||!Array.isArray(item.entries))fail('SEMANTIC_DIRECTORY_CORRUPT');
              for(const entry of item.entries)pending.push(...(entry.vectorPages||[]));
            }else if(item.schema==='libra.graph_corpus_projection_build.v1'){
              if(!Array.isArray(item.windows))fail('PROJECTION_CORRUPT');pending.push(...item.windows.map(r=>({...r,type:'projection'})));
            }else if(['libra.graph_corpus_projection.v2','libra.graph_corpus_projection_window.v1'].includes(item.schema)){
              if(!item.parts||Object.keys(item.parts).sort().join(',')!=='bases,canonicalRows,edges,nodes,units')fail('PROJECTION_CORRUPT');
              for(const part of Object.values(item.parts)){if(!Array.isArray(part.refs))fail('PROJECTION_CORRUPT');pending.push(...part.refs);}
              if(item.schema==='libra.graph_corpus_projection.v2')pending.push({...item.build,type:'projection'});
            }else if(item.schema!=='libra.graph_corpus_projection.v1')fail('PROJECTION_CORRUPT');
          }finally{held?.release();}
          mark();
        });
      };
      // Inventory streams one native record at a time. Large chats no longer
      // require an in-memory Map of every historical page before collecting.
      const cursor=records.index('scope').openCursor(scope);
      cursor.onsuccess=()=>run(()=>{
        resources?.check();const current=cursor.result;if(!current){mark();return;}
        const row=current.value;owned(prefix,row.key);inventoryRecords++;inventoryBytes+=row.raw.length*2+2048;
        if(row.key.startsWith(prefix+'checkpoint:')&&now()-row.updatedAt<86400000)pending.push({key:row.key,type:'checkpoint'});
        current.continue();
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

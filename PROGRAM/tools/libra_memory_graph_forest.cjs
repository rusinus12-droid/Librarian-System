'use strict';
// Content-addressed radix directories. A leaf is bounded by bytes, not by the
// size of the chat. Roots are swapped only after every referenced shard exists.
module.exports = function createMemoryGraphForest({ pages, index, fingerprint: hash, legacy, location, merge, note = () => {} }) {
  // A new root schema makes old browser tabs fail closed before their legacy
  // collector can mistake an unknown forest for an empty v1 corpus.
  const schema = 'libra.graph_corpus.v2', nodeSchema = 'libra.graph_corpus_forest_node.v1';
  const fail = (reason,details={}) => { throw Object.assign(new Error('LIBRA_GRAPH_CORPUS_' + reason.toUpperCase()), { reason,...details }); };
  const equal = (a,b) => JSON.stringify(a) === JSON.stringify(b);
  const ordinalKey = n => n.toString(16).padStart(12,'0');
  const io = (owner, loc) => {
    const read = async (ref,scope=null) => {
      owner.check();
      if (!ref || !/^[a-f0-9]{64}$/.test(ref.digest) || ref.key !== loc.prefix + 'forest:' + ref.digest) fail('forest_reference_invalid');
      const raw = await owner.read(ref.key); owner.check();
      if (typeof raw !== 'string' || hash(raw) !== ref.digest || pages.encodedSize(raw).utf8Bytes > 32768) fail('page_corrupt');
      const value = owner.resources?await owner.resources.withValue(raw,()=>JSON.parse(raw)):JSON.parse(raw);
      scope?.retain(value,'forest_directory_node');
      if (value.schema !== nodeSchema || !['branch','leaf'].includes(value.kind)) fail('page_corrupt');
      return value;
    };
    const save = async value => {
      owner.check(); const raw = JSON.stringify(value), digest = hash(raw), key = loc.prefix + 'forest:' + digest;
      if (pages.encodedSize(raw).utf8Bytes > 32768) fail('forest_row_budget');
      const before = await owner.read(key);
      if (before === null) await owner.putImmutable(key,raw); else if (before !== raw) fail('immutable_collision');
      if (await owner.read(key) !== raw) fail('write_readback');
      return {key,digest};
    };
    const pack = async (rows, depth) => {
      const leaf = {schema:nodeSchema,kind:'leaf',rows};
      if (rows.length <= 32 && pages.encodedSize(JSON.stringify(leaf)).utf8Bytes <= 16384) return rows.length ? save(leaf) : null;
      if (depth >= 80) fail('forest_row_budget');
      const groups = new Map();
      for (const row of rows) { const digit = row.key[depth]; if (!digit) fail('forest_key_invalid'); if (!groups.has(digit)) groups.set(digit,[]); groups.get(digit).push(row); }
      const children = {};
      for (const digit of [...groups.keys()].sort()) children[digit] = await pack(groups.get(digit),depth+1);
      return save({schema:nodeSchema,kind:'branch',children});
    };
    const set = async (ref, key, value, depth = 0) => {
      const scope=owner.resources?.scope();try{
      const node = ref ? await read(ref,scope) : {kind:'leaf',rows:[]};
      if (node.kind === 'leaf') {
        const rows = node.rows.filter(row => row.key !== key);
        if (value !== null) rows.push({key,value});
        rows.sort((a,b)=>a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
        return await pack(rows,depth);
      }
      const children = {...node.children}, digit = key[depth];
      if (!digit) fail('forest_key_invalid');
      const child = await set(children[digit] || null,key,value,depth+1);
      if (child) children[digit] = child; else delete children[digit];
      return Object.keys(children).length ? await save({schema:nodeSchema,kind:'branch',children}) : null;
      }finally{scope?.close();}
    };
    const scan = async function* (ref, prefix = '', depth = 0) {
      if (!ref) return;
      const scope=owner.resources?.scope();try{
      const node = await read(ref,scope);
      if (node.kind === 'leaf') { for (const row of node.rows) if (row.key.startsWith(prefix)) yield row.value; return; }
      const digits = depth < prefix.length ? [prefix[depth]] : Object.keys(node.children).sort();
      for (const digit of digits) if (node.children[digit]) yield* scan(node.children[digit],prefix,depth+1);
      }finally{scope?.close();}
    };
    const update = async (ref, changes, depth=0) => {
      if(!changes.length)return ref;
      const scope=owner.resources?.scope();try{
      const node=ref?await read(ref,scope):{kind:'leaf',rows:[]};
      if(node.kind==='leaf'){
        const rows=new Map(node.rows.map(r=>[r.key,r.value]));
        for(const change of changes)if(change.value===null)rows.delete(change.key);else rows.set(change.key,change.value);
        return await pack([...rows].sort(([a],[b])=>a<b?-1:a>b?1:0).map(([key,value])=>({key,value})),depth);
      }
      const groups=new Map(),children={...node.children};
      for(const change of changes){const digit=change.key[depth];if(!groups.has(digit))groups.set(digit,[]);groups.get(digit).push(change);}
      for(const [digit,part]of groups){const child=await update(children[digit]||null,part,depth+1);if(child)children[digit]=child;else delete children[digit];}
      return Object.keys(children).length?await save({schema:nodeSchema,kind:'branch',children}):null;
      }finally{scope?.close();}
    };
    return {read,save,set,scan,update};
  };
  const manifest = async (owner, loc, rootRaw) => {
    if (rootRaw === null) return null;
    const root = JSON.parse(rootRaw);
    if (!['libra.graph_corpus.v1',schema].includes(root.schema) || root.manifestKey !== loc.prefix + 'manifest:' + root.digest) fail('root_invalid');
    const raw = await owner.read(root.manifestKey);
    if (typeof raw !== 'string' || hash(raw) !== root.digest) fail('page_corrupt');
    return JSON.parse(raw);
  };
  const childOwner = (owner, rootKey, root, scope) => ({
    ...owner, resources:scope || owner.resources,
    read: key => key === rootKey ? Promise.resolve(root.raw) : owner.read(key),
    publish: async value => { root.raw = value.raw; },
    // A shard's publication stays private until the forest root is published.
  });
  const build = async ({initialGraph, owner, snapshot, options = {}}) => {
    await owner.assertForestSupport?.();
    const loc = location(initialGraph), previous = await owner.read(loc.rootKey), old = await manifest(owner,loc,previous);
    const head = await owner.captureForestHead();
    const assertHead=async reason=>{const after=await owner.captureForestHead();if(!equal(head,after))fail(reason,{sourceHeadWitness:{before:head.witness,after:after.witness}});};
    const perShard = Math.min(options.shardWindows ?? 64,options.maxWindowsPerStep??64,options.maxWindows??64);
    if (!Number.isSafeInteger(perShard) || perShard < 1 || perShard > 64) fail('policy_invalid');
    const store = io(owner,loc), compatible = old?.forest?.shardWindows === perShard && old?.config?.limit === (options.limit || 20);
    let windowHint=options.incremental===false?perShard:Math.min(perShard,old?.forest?.windowHint||perShard);
    let checkpointBasis=null,sourceHeadChanged=false;
    let catalog = null, routes = null, windows = 0, count = 0, indexBytes = 0, graphBytes = 0, pageCount = 0, reused = 0,unitCount=0;
    const total = Math.max(1,Math.ceil(Math.max(head.canonicalTotal,head.microTurnTotal)/(options.limit || 20)));
    const stepLimit=options.maxShardsPerStep??(options.maxWindowsPerStep?1:4);
    if(!Number.isSafeInteger(stepLimit)||stepLimit<1||stepLimit>64)fail('policy_invalid');
    const checkpointIdentity=hash(JSON.stringify([initialGraph.readerFrame,previous,perShard,options.limit||20,options.incremental!==false]));
    const checkpointKey=n=>loc.prefix+'checkpoint:'+hash(JSON.stringify([checkpointIdentity,n]));
    let nextStart=0,checkpointOrdinal=0,latestCheckpoint=null;
    for(;;){
      const raw=await owner.read(checkpointKey(checkpointOrdinal));if(raw===null)break;
      const cp=JSON.parse(raw);
      if(cp.schema!=='libra.graph_corpus_forest_checkpoint.v1'||cp.identity!==checkpointIdentity||cp.previous!==previous||!cp.head
        ||!Number.isSafeInteger(cp.nextStart)||cp.nextStart<1||(!cp.restart&&latestCheckpoint&&equal(latestCheckpoint.head,cp.head)&&cp.nextStart<=latestCheckpoint.nextStart))fail('checkpoint_invalid');
      latestCheckpoint=cp;
      checkpointOrdinal++;
    }
    if(latestCheckpoint&&options.resume!==false){
      if(equal(latestCheckpoint.head,head)){
        if(latestCheckpoint.nextStart>total)fail('checkpoint_invalid');
        ({catalog,routes}=latestCheckpoint.forest);({windows,count,indexBytes,graphBytes,pageCount,reused,unitCount}=latestCheckpoint.counters);nextStart=latestCheckpoint.nextStart;
      }else{checkpointBasis=latestCheckpoint.forest;sourceHeadChanged=true;}
      windowHint=Math.min(windowHint,latestCheckpoint.forest.windowHint||windowHint);
    }
    let builtThisStep=0;
    for (let start = nextStart; start < total;) {
      owner.check(); note({phase:'enumerating',windowsDone:start,windowTotal:total,shardsDone:count,maxWindows:perShard});
      let oldShard = null;
      if(checkpointBasis)for await(const item of store.scan(checkpointBasis.catalog,ordinalKey(start))){oldShard=item;break;}
      if (!oldShard&&compatible) for await (const item of store.scan(old.forest.catalog,ordinalKey(start))) { oldShard = item; break; }
      const basis=checkpointBasis||old?.forest;
      const tailGrowing=oldShard&&oldShard.start+oldShard.windowCount===basis.windowCount&&total>basis.windowCount;
      let size = Math.min(tailGrowing?windowHint:oldShard?.windowCount || windowHint,total-start), result, root, child, routeKeys=null;
      let localHead=await owner.captureForestHead({start,count:size,limit:options.limit||20});
      // Reuse an entire published shard only under the same qualified owner head.
      if (oldShard && localHead.digest===oldShard.headDigest && oldShard.windowCount === size && options.incremental!==false) {
        result = oldShard.result; root = {raw:oldShard.root}; routeKeys=oldShard.routeKeys; reused += size;
      } else for (;;) {
        if(localHead.count!==size)localHead=await owner.captureForestHead({start,count:size,limit:options.limit||20});
        const context = owner.openForestShard ? await owner.openForestShard() : null;
        const shardScope = context ? null : owner.resources?.scope?.();
        const base = context?.owner || owner, snap = context?.snapshot || snapshot;
        root = {raw:oldShard?.root || null}; child = legacy();
        const wrapped = childOwner(base,loc.rootKey,root,shardScope);
        wrapped.onForestIndex=async(compiled,graph,collected)=>{
          const keys=new Set(['all']);
          for(const row of compiled.postings)keys.add(row.channel+':'+row.term);
          for(const node of graph.nodes)keys.add('node:'+node.id);
          for(const row of collected?.canonicalRows||[])keys.add('state-canonical:'+JSON.stringify([row.record.memoryId,row.record.revision]));
          for(const unit of graph.units)if(unit.family==='micro'&&Number.isSafeInteger(unit.turn))keys.add('state-micro:'+unit.turn);
          for(const row of compiled.adjacency)keys.add('anchor:'+row.anchorNodeId);
          if(graph.units.some(u=>u.family==='canonical'||u.family==='micro'))keys.add('semantic');
          if(start===0)keys.add('singleton');
          routeKeys=await store.update(null,[...keys].sort().map(term=>({key:hash(term),value:{term,start}})));
        };
        wrapped.onForestSemantic=async directory=>{if(directory)routeKeys=await store.set(routeKeys,hash('semantic'),{term:'semantic',start});};
        const config = {limit:20,...options,maxSerializedBytes:Math.min(options.maxSerializedBytes??4194304,1048576),
          maxWindows:size, windowStart:start, windowCount:size,historicalShard:start>0,
          skipCanonical:start*(options.limit||20)>=head.canonicalTotal,skipMicro:start*(options.limit||20)>=head.microTurnTotal,
          incremental:false,resume:false};
        delete config.shardWindows; delete config.maxShardsPerStep;delete config.maxWindowsPerStep;
        try {
          let first = true, seen = 0;
          const bounded = async request => {
            const req = first ? {...request, canonicalCursor:'',microCursor:'',
              canonicalOffset:Math.min(start*config.limit,head.canonicalTotal),
              microOffset:Math.min(start*config.limit,head.microTurnTotal)} : {...request};
            if((start+seen)*config.limit>=head.canonicalTotal){req.canonicalOffset=head.canonicalTotal;req.canonicalCursor='';}
            if((start+seen)*config.limit>=head.microTurnTotal){req.microOffset=head.microTurnTotal;req.microCursor='';}
            first = false;
            let value = await snap(req); seen++;
            note({phase:'enumerating',windowsDone:start+seen,windowTotal:total,shardsDone:count,shardWindows:size});
            if(start>0){
              const excluded=u=>['state','lore'].includes(u.family)||(u.family==='canonical'&&start*config.limit>=head.canonicalTotal)||(u.family==='micro'&&start*config.limit>=head.microTurnTotal);
              const units=value.graph.units.filter(u=>!excluded(u));
              const singletonNodes=new Set(value.graph.units.filter(excluded).map(u=>u.nodeId));
              const edges=value.graph.edges.filter(e=>!singletonNodes.has(e.from)&&!singletonNodes.has(e.to));
              const basisIds=new Set(edges.map(e=>e.basisId).filter(Boolean));
              value={...value,collected:{...value.collected,canonicalRows:start*config.limit>=head.canonicalTotal?[]:value.collected.canonicalRows},graph:{...value.graph,units,edges,bases:value.graph.bases.filter(b=>basisIds.has(b.id)),
                nodes:value.graph.nodes.filter(n=>!singletonNodes.has(n.id)),
                coverage:{...value.graph.coverage,families:Object.fromEntries(Object.entries(value.graph.coverage.families||{}).filter(([f])=>!['state','lore'].includes(f))),
                  sourceReadFailures:(value.graph.coverage.sourceReadFailures||[]).filter(r=>!['state','lore'].includes(r.family))}}};
            }
            if (seen === size) return {...value,graph:{...value.graph,coverage:{...value.graph.coverage,inventory:{...value.graph.coverage.inventory,canonicalNextCursor:'',microNextCursor:''}}}};
            return value;
          };
          result = await child.build({initialGraph,snapshot:bounded,owner:wrapped,options:config});
          if (result.status !== 'published') fail('forest_shard_incomplete');
          break;
        } catch (error) {
          if (size <= 1 || !['workspace_budget','index_budget','record_size','page_row_exceeds_page',
            'read_count_budget','retained_byte_budget','retained_value_budget','decode_value_budget','decode_workspace_budget','value_byte_budget'].includes(error.reason)) throw error;
          size = Math.max(1,Math.floor(size/2));windowHint=Math.min(windowHint,size); oldShard = null; routeKeys=null;
        } finally { shardScope?.close(); await context?.close(); }
      }
      const descriptor = {start,windowCount:size,root:root.raw,result,routeKeys,headDigest:localHead.digest};
      catalog = await store.set(catalog,ordinalKey(start),descriptor);
      // Routing keys are exact index keys, never summaries. They cannot exclude
      // a shard just because a summary omitted an old fact.
      const routeChanges=[];
      for await(const hit of store.scan(routeKeys)){
        let entry=null;for await(const oldEntry of store.scan(routes,hash(hit.term))){entry=oldEntry;break;}
        const shards=await store.set(entry?.shards||null,hash(ordinalKey(start)),hit);
        routeChanges.push({key:hash(hit.term),value:{term:hit.term,shards,count:(entry?.count||0)+1}});
      }
      routes=await store.update(routes,routeChanges);
      windows += size; count++; pageCount += result.pageCount; indexBytes += result.serializedIndexBytes; graphBytes += result.serializedGraphBytes;unitCount+=result.unitCount||0;
      start += size;
      builtThisStep++;
      const admission=owner.resources?.inspect();
      const directoryNearLimit=admission&&(admission.reads>admission.limits.maxReads*0.5||admission.durableBytes>admission.limits.maxDurableBytes*0.5);
      if(start<total&&(builtThisStep>=stepLimit||directoryNearLimit)){
        await assertHead('source_changed');
        const checkpoint={schema:'libra.graph_corpus_forest_checkpoint.v1',identity:checkpointIdentity,previous,head,nextStart:start,restart:options.resume===false||sourceHeadChanged,
          forest:{schema:'libra.graph_corpus_forest.v1',catalog,routes,shardCount:count,windowCount:windows,windowHint},counters:{windows,count,indexBytes,graphBytes,pageCount,reused,unitCount}};
        const raw=JSON.stringify(checkpoint),key=checkpointKey(checkpointOrdinal),saved=await owner.read(key);
        if(saved===null)await owner.putImmutable(key,raw);else if(saved!==raw)fail('checkpoint_conflict');
        if(await owner.read(key)!==raw)fail('write_readback');
        note({phase:'checkpointing',windowsDone:windows,shardsDone:count});
        return {schema,status:'checkpointed',buildMode:'sharded_checkpoint',completedWindows:windows,windowCount:windows,
          shardCount:count,remainingUnread:true,reusedWindowCount:reused,enumeratedWindowCount:windows-reused,checkpointKey:key,modelDispatchEligible:false};
      }
    }
    await assertHead('source_changed');
    const value = {schema,frame:initialGraph.readerFrame,refs:[],config:{limit:options.limit || 20},
      forest:{schema:'libra.graph_corpus_forest.v1',catalog,routes,head,shardWindows:perShard,shardCount:count,windowCount:windows,unitCount,windowHint},
      generation:hash(JSON.stringify([head,catalog,routes])),serializedGraphBytes:graphBytes,serializedIndexBytes:indexBytes};
    const raw = JSON.stringify(value), digest = hash(raw), key = loc.prefix+'manifest:'+digest;
    if (await owner.read(key) === null) await owner.putImmutable(key,raw);
    if (await owner.read(key) !== raw) fail('write_readback');
    note({phase:'publishing',windowsDone:windows,shardsDone:count});
    await owner.publish({key:loc.rootKey,previous,raw:JSON.stringify({schema,manifestKey:key,digest}),manifestKey:key,manifestRaw:raw});
    await assertHead('source_changed_after_publication');
    return {schema,status:'published',generation:value.generation,indexDigest:digest,buildMode:reused?'sharded_incremental':'sharded_full',
      windowCount:windows,shardCount:count,reusedWindowCount:reused,enumeratedWindowCount:windows-reused,pageCount,
      serializedGraphBytes:graphBytes,serializedIndexBytes:indexBytes,ownerAtomicity:false,inventoryComplete:false,byteBounded:false,modelDispatchEligible:false};
  };
  const read = async ({initialGraph,owner,snapshot,eager=false,queryInput={},selectionBudget={}}) => {
    const loc = location(initialGraph), rootRaw = await owner.read(loc.rootKey), m = await manifest(owner,loc,rootRaw);
    if (!m?.forest) return null;
    await owner.assertForestSupport?.();
    queryInput={...queryInput,semanticEnabled:queryInput.semanticEnabled!==false&&(owner.isForestSemanticEnabled?await owner.isForestSemanticEnabled():true)};
    const forest = m.forest;
    if (forest.schema !== 'libra.graph_corpus_forest.v1' || !equal(m.frame,initialGraph.readerFrame)) fail('manifest_invalid');
    if (!equal(forest.head,await owner.captureForestHead())) fail('stale_generation');
    const store = io(owner,loc), selected = new Set(), loaded = new Map(), graphs = [], children = [], canonical = new Map(), sourceKeys = new Set(), bodyDigests = {}, dependencies = {};
    const maxBytes = selectionBudget.maxGraphBytes ?? 4194304, maxShards = selectionBudget.maxShards ?? 32;
    if (!Number.isSafeInteger(maxBytes)||maxBytes<65536||maxBytes>8388608||!Number.isSafeInteger(maxShards)||maxShards<1||maxShards>128) fail('policy_invalid');
    let bytes = 0, partial = false, storagePages = 0;
    const routeCache=new Map();
    const lookup=async term=>{
      if(routeCache.has(term))return routeCache.get(term);
      let entry=null;for await(const value of store.scan(forest.routes,hash(term))){entry=value;break;}
      if(entry&&(entry.term!==term||!Number.isSafeInteger(entry.count)||entry.count<1||!entry.shards))fail('page_corrupt');
      routeCache.set(term,entry);return entry;
    };
    const select = async term => { const entry=await lookup(term);if(!entry)return;
      for await (const hit of store.scan(entry.shards)) {
      if (hit.term !== term) fail('page_corrupt');
      if (selected.size >= maxShards && !selected.has(hit.start)) { partial=true; break; } selected.add(hit.start);
    }};
    if (eager) await select('all'); else {
      await select('singleton');
      const lexical=[];for(const token of new Set(index.tokenize(queryInput.queryText||''))){const term='lexical:'+token,entry=await lookup(term);if(entry)lexical.push({term,count:entry.count});}
      for(const row of lexical.sort((a,b)=>a.count-b.count||a.term.localeCompare(b.term)))await select(row.term);
      for (const id of queryInput.entityIds || []) await select('entity:'+id);
      for (const pred of queryInput.predicates || []) await select('predicate:'+pred);
      for(const id of [...Object.keys(queryInput.queryVectors||{}),...Object.keys(queryInput.documentRepresentations||{}),...(queryInput.semanticReferences||[])])await select('node:'+id);
      // Native semantic queries conservatively visit every shard with a stored
      // representation; lexical routing must not drop semantic-only evidence.
      if (queryInput.semanticEnabled !== false) await select('semantic');
    }
    const load = async start => {
      if (loaded.has(start)) return;
      let descriptor; for await (const row of store.scan(forest.catalog,ordinalKey(start))) { descriptor=row; break; }
      if (!descriptor || descriptor.start !== start) fail('page_corrupt');
      if (bytes+descriptor.result.serializedGraphBytes>maxBytes) {partial=true;loaded.set(start,null);return;}
      const child = legacy(), root = {raw:descriptor.root}, scoped = childOwner(owner,loc.rootKey,root);
      const value = await child.read({initialGraph,owner:scoped,snapshot,eager:false});
      if (!value) fail('page_corrupt');
      bytes += descriptor.result.serializedGraphBytes; loaded.set(start,value); graphs.push(value.graph); children.push(value);
      storagePages += value.access.storage?.projection?.pagesRead || 0;
      for (const row of value.collected.canonicalRows || []) canonical.set(row.key,row);
      for (const key of value.collected.sourceKeys || []) sourceKeys.add(key);
      for (const [key,digest] of Object.entries(value.sourceProofs?.ownerProof?.sourceBodyDigests || {})) if(!bodyDigests[key])bodyDigests[key]=digest;
      Object.assign(dependencies,value.sourceProofs?.ownerProof?.recordDependencyKeys || {});
    };
    // Follow cross-shard node references before invoking the single existing
    // frontier/ranker. There is no independent per-shard top-k truncation.
    const tokens=new Set(index.tokenize(queryInput.queryText||'')),activeNodes=new Set(),routedNodes=new Set();
    const queryLower=String(queryInput.queryText||'').normalize('NFKC').toLowerCase();
    for (let hop=0;hop<=(queryInput.maxHops || 4);hop++) {
      const pending=[...selected].filter(n=>!loaded.has(n)); if (!pending.length&&![...activeNodes].some(id=>!routedNodes.has(id))) break;
      for (const start of pending) await load(start);
      for(const start of pending){const value=loaded.get(start);if(!value)continue;
        const entityNodes=value.graph.nodes.filter(n=>n.layer==='entity');
        for(const [i,entry]of (value.collected.entityRegistry||[]).entries()){
          const names=[entry.name,...(entry.aliases||[])].filter(Boolean).map(n=>String(n).normalize('NFKC').toLowerCase());
          if((queryInput.entityIds||[]).includes(entry.id)||names.some(n=>n.length>=2&&queryLower.includes(n))){
            await select('entity:'+entry.id);if(entityNodes[i]){activeNodes.add(entityNodes[i].id);await select('entity:'+entityNodes[i].id);}
          }
        }
        for(const unit of value.graph.units)if(unit.family==='state'&&unit.provenanceStatus==='recorded'&&unit.semanticRole!=='user_corrected'){
          const proof=unit.fieldEvidence||{};
          if(proof.memoryId&&proof.revision!==undefined)await select('state-canonical:'+JSON.stringify([proof.memoryId,proof.revision]));
          if(proof.schema==='libra.micro_state_field_evidence.v1'&&Number.isSafeInteger(proof.turn))await select('state-micro:'+proof.turn);
        }
        for(const unit of value.graph.units)if(index.tokenize(unit.text||'').some(t=>tokens.has(t))||queryInput.semanticEnabled!==false&&value.semanticDirectory?.entries?.length)activeNodes.add(unit.nodeId);
      }
      if (hop === (queryInput.maxHops || 4)) break;
      const nextNodes=new Set(activeNodes);
      for(const id of activeNodes)if(!routedNodes.has(id)){routedNodes.add(id);await select('anchor:'+id);await select('node:'+id);}
      for(const g of graphs)for(const edge of g.edges)if(activeNodes.has(edge.from)||activeNodes.has(edge.to)){
        nextNodes.add(edge.from);nextNodes.add(edge.to);
      }
      for(const id of nextNodes)activeNodes.add(id);
    }
    const graph = merge(initialGraph,graphs,{partial,windowCount:forest.windowCount,shardCount:forest.shardCount});
    // Reissue cross-shard State derivations through the native reader, using
    // only exact provenance pages whose evidence is already in this selection.
    let stateEvidenceReprojectionPages=0;
    if(owner.forestStateEvidenceRequests){
      const nodeMap=new Map(graph.nodes.map(n=>[n.id,n])),basisMap=new Map(graph.bases.map(b=>[b.id,b]));
      const edgeMap=new Map(graph.edges.map(e=>[e.id,e]));
      const stateIds=new Set(graph.units.filter(u=>u.family==='state').map(u=>u.nodeId));
      for(const request of await owner.forestStateEvidenceRequests(graph,[...canonical.values()])){
        const scope=owner.resources?.scope?.();
        try{
          const fresh=await snapshot(request),nativeNodes=new Map(fresh.graph.nodes.map(n=>[n.id,n]));stateEvidenceReprojectionPages++;
          for(const edge of fresh.graph.edges){
            if(edge.predicate!=='derived_from'||!stateIds.has(edge.from))continue;
            const basis=fresh.graph.bases.find(b=>b.id===edge.basisId);
            if(!basis||basisMap.get(basis.id)?.bindingId!==basis.bindingId)continue;
            if([edge.from,edge.to].every(id=>nodeMap.get(id)&&nodeMap.get(id).bindingId===nativeNodes.get(id)?.bindingId))edgeMap.set(edge.id,edge);
          }
        }finally{scope?.close();}
      }
      graph.edges=[...edgeMap.values()];
      const derived=new Set(graph.edges.filter(e=>e.predicate==='derived_from').map(e=>e.from));
      if(graph.units.filter(u=>u.family==='state'&&u.provenanceStatus==='recorded'&&u.semanticRole!=='user_corrected').every(u=>derived.has(u.nodeId))){
        const state=graph.coverage.families?.state;if(state)state.reasons=state.reasons.filter(r=>r!=='field_basis_outside_page_or_unresolved');
        graph.coverage.projectionComplete=!partial&&!(graph.coverage.sourceReadFailures||[]).length&&Object.values(graph.coverage.families||{}).every(f=>!f.reasons.length);
      }
    }
    graph.coverage.corpusUnitCount=forest.unitCount;
    owner.resources?.retain(graph,'forest_selected_graph');
    const generation=pages.generation(graph,{partition:loc.partition,restoreEpoch:graph.readerFrame.restoreEpoch,view:graph.readerFrame});
    const compiledIndex=index.compile(graph,{partition:loc.partition,generation,resources:owner.resources});
    const assertIndexCurrent=async()=>{owner.check();if(await owner.read(loc.rootKey)!==rootRaw)fail('root_changed');await owner.assertRoute?.();};
    const assertCurrent = async () => {
      owner.check(); if (await owner.read(loc.rootKey)!==rootRaw) fail('root_changed');
      if (!equal(forest.head,await owner.captureForestHead())) fail('stale_generation');
      for (const child of children) await child.currentGraph();
      if (await owner.read(loc.rootKey)!==rootRaw) fail('root_changed');
      return graph;
    };
    await assertIndexCurrent();
    return {graph,compiledIndex,config:m.config,collected:{entityRegistry:children[0]?.collected.entityRegistry || [],canonicalRows:[...canonical.values()],sourceKeys:[...sourceKeys]},
      sourceProofs:{proofVersion:'libra.source_proof_contract.v2',ownerProof:{sourceBodyDigests:bodyDigests,recordDependencyKeys:dependencies}},
      currentGraph:assertCurrent,assertIndexCurrent,
      access:{schema,mode:'durable_common_index',generation:m.generation,indexDigest:compiledIndex.indexDigest,windowCount:forest.windowCount,
        shardCount:forest.shardCount,selectedShardCount:graphs.length,selectionComplete:!partial,pageCount:graphs.reduce((n,g)=>n+g.nodes.length,0),
        storage:{storageAccess:'routed_durable_shards',projectionPagesRead:storagePages,selectedGraphBytes:bytes},selectedIndexCompilations:1,
        nativeReprojectionRequired:stateEvidenceReprojectionPages>0,stateEvidenceReprojectionPages,ownerAtomicity:false,inventoryComplete:false,byteBounded:false}};
  };
  return {build,read,manifest};
};

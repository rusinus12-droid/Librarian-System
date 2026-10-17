'use strict';
// Owner-supplied document representations enter the same query frontier. A
// projection vector is an access signal for its source, never a fact embedding.
module.exports = function createMemoryGraphSemantic({ digest, profileFor, projectionFor } = {}) {
  if (![digest, profileFor, projectionFor].every(fn => typeof fn === 'function')) throw new TypeError('LIBRA_GRAPH_SEMANTIC_ADAPTER_REQUIRED');
  const vectorValid = (vector, dimension) => {
    if (!Array.isArray(vector) || vector.length !== dimension || !vector.every(value => typeof value === 'number' && Number.isFinite(value))) return false;
    const squaredNorm = vector.reduce((sum, value) => sum + value * value, 0);
    return Number.isFinite(squaredNorm) && squaredNorm > 0;
  };
  const prepare = async ({ graph, canonicalRows = [], config, queryText = '', asOfTurn = null,
    readVector, embedQuery, check = () => {}, maxBytes = 262144, additionalRepresentations = [], collectOnly = false } = {}) => {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 4096 || maxBytes > 16777216) throw new TypeError('LIBRA_GRAPH_SEMANTIC_BUDGET_INVALID');
    const admittedFamilies = new Set();
    const diagnostics = { schema: 'libra.native_graph_semantic.v1', status: 'unavailable', representationScope: 'canonical_global_projection_source_access',
      queryRequestCount: 0, queryCacheHits: 0, coalesced: false, documentEmbeddingCalls: 0, backgroundEmbeddingStarted: false,
      admittedRepresentations: 0, representationBytes: 0, maxRepresentationBytes: maxBytes, rejected: [],
      vectorlessFamilies: ['micro','state','lore'], byteBounded: false };
    const empty = () => ({ queryInput: { semanticSpace: null, queryEmbedding: null, documentRepresentations: {}, queryVectors: {} }, dependencies: [], diagnostics });
    if (!config) { diagnostics.status = 'configuration_unavailable'; return empty(); }
    if (!config.enabled) { diagnostics.status = 'disabled'; return empty(); }
    if (!String(queryText).trim()) { diagnostics.status = 'empty_query'; return empty(); }
    const nodes = new Map((graph.nodes || []).map(node => [node.id, node]));
    const sourcesByKey = new Map();
    for (const unit of graph.units || []) {
      if (unit.family !== 'canonical' || !unit.recordKey) continue;
      const node = nodes.get(unit.nodeId), source = nodes.get(node?.sourceId);
      if (!source || source.layer !== 'source') continue;
      if (!sourcesByKey.has(unit.recordKey)) sourcesByKey.set(unit.recordKey, new Set());
      sourcesByKey.get(unit.recordKey).add(source.id);
    }
    const documents = [], dependencies = [];
    let bytes = 2048, dimension = null, expectedProfile = null;
    const reject = (key, reason) => diagnostics.rejected.push({ recordKey: key, reason });
    for (const row of canonicalRows) {
      check();
      const memory = row.record, sourceIds = sourcesByKey.get(row.key), embedding = memory?.embedding;
      if (!sourceIds || sourceIds.size !== 1 || embedding?.status !== 'ready' || !embedding.vectorKey) { reject(row.key, 'representation_missing'); continue; }
      // The global projection can contain future facts, even if the source has
      // other eligible child facts. Never use it as a past-view semantic proxy.
      if (asOfTurn !== null && (!Number.isSafeInteger(memory.turnRange?.end) || memory.turnRange.end > asOfTurn)) {
        reject(row.key, 'representation_outside_temporal_view'); continue;
      }
      let vectorRecord;
      try { vectorRecord = await readVector(embedding.vectorKey); } catch (_) { check(); reject(row.key, 'vector_read_unavailable'); continue; }
      check();
      if (!vectorRecord || vectorRecord.schema !== 'libra.embedding_projection.v2' || vectorRecord.scopeKey !== memory.scopeKey
        || vectorRecord.memoryId !== memory.memoryId || vectorRecord.revision !== memory.revision) { reject(row.key, 'vector_owner_binding_mismatch'); continue; }
      const d = vectorRecord.dimensions;
      if (!Number.isSafeInteger(d) || d < 1 || d > 65536 || !vectorValid(vectorRecord.entries?.global?.vector || vectorRecord.vector, d)) {
        reject(row.key, 'invalid_vector'); continue;
      }
      let profile, projection;
      try { profile = profileFor({ ...config, dimensions: d }); projection = projectionFor(memory); }
      catch (_) { reject(row.key, 'projection_or_profile_unavailable'); continue; }
      if (vectorRecord.provider !== profile.provider || vectorRecord.model !== profile.model
        || vectorRecord.profileId !== profile.profileId || embedding.profileId !== vectorRecord.profileId
        || digest(vectorRecord.embeddingDescriptor) !== digest(profile.descriptor)
        || dimension !== null && dimension !== d) { reject(row.key, 'embedding_space_mismatch'); continue; }
      const hash = projection.textHashes.global, entry = vectorRecord.entries?.global;
      if (vectorRecord.projectionVersion !== projection.version || vectorRecord.textHash !== hash
        || embedding.textHash !== hash || !embedding.vectorHash || vectorRecord.vectorHash !== embedding.vectorHash
        || entry && entry.textHash !== hash) { reject(row.key, 'projection_text_mismatch'); continue; }
      const additional = 1024 + d * 8 + (dimension === null ? d * 16 : 0);
      if (bytes + additional > maxBytes) { reject(row.key, 'representation_byte_budget'); continue; }
      const node = nodes.get([...sourceIds][0]);
      documents.push({ nodeId: node.id, bindingId: node.bindingId, vector: (entry?.vector || vectorRecord.vector).slice(),
        representationId: digest([embedding.vectorKey, vectorRecord.profileId, hash, vectorRecord.vectorHash]),
        projectionVersion: projection.version, textHash: hash, temporalEndTurn: memory.turnRange?.end ?? null });
      dependencies.push({ key: embedding.vectorKey, digest: digest(vectorRecord) });
      dimension = d; expectedProfile = profile; bytes += additional;
      admittedFamilies.add('canonical');
    }
    for (const extra of additionalRepresentations) {
      check();
      const fam = extra?.family || 'unknown';
      if (!extra?.nodeId || !extra?.recordKey || !extra?.vectorKey) { reject(extra?.recordKey || 'extra', 'representation_missing'); continue; }
      if (asOfTurn !== null && Number.isSafeInteger(extra.temporalEndTurn) && extra.temporalEndTurn > asOfTurn) {
        reject(extra.recordKey, 'representation_outside_temporal_view'); continue;
      }
      let vectorRecord = extra.vectorRecord;
      if (!vectorRecord && typeof readVector === 'function') {
        try { vectorRecord = await readVector(extra.vectorKey); } catch (_) { check(); reject(extra.recordKey, 'vector_read_unavailable'); continue; }
      }
      check();
      if (extra.selectionDigest && digest(vectorRecord) !== extra.selectionDigest) throw new Error('LIBRA_GRAPH_SEMANTIC_VECTOR_CHANGED');
      if (!vectorRecord || !vectorValid(vectorRecord.vector, vectorRecord.dimensions)) { reject(extra.recordKey, 'invalid_vector'); continue; }
      const d = vectorRecord.dimensions;
      let profile;
      try { profile = profileFor({ ...config, dimensions: d }); }
      catch (_) { reject(extra.recordKey, 'projection_or_profile_unavailable'); continue; }
      if (!Number.isSafeInteger(d) || d < 1 || d > 65536) { reject(extra.recordKey, 'invalid_vector'); continue; }
      if (!extra.vectorRecord && extra.family === 'micro'
        && (vectorRecord.schema !== 'libra.micro_vector.v1' || vectorRecord.scopeKey !== graph.scopeKey
          || vectorRecord.textHash !== extra.textHash || vectorRecord.spaceDigest !== extra.spaceDigest
          || vectorRecord.provider !== profile.provider || vectorRecord.model !== profile.model
          || vectorRecord.profileId !== profile.profileId)) { reject(extra.recordKey, 'vector_owner_binding_mismatch'); continue; }
      if (dimension !== null && dimension !== d) { reject(extra.recordKey, 'embedding_space_mismatch'); continue; }
      const additional = 1024 + d * 8 + (dimension === null ? d * 16 : 0);
      if (bytes + additional > maxBytes) { reject(extra.recordKey, 'representation_byte_budget'); continue; }
      const node = nodes.get(extra.nodeId);
      documents.push({ nodeId: extra.nodeId, bindingId: node?.bindingId || extra.nodeId, vector: vectorRecord.vector.slice(),
        representationId: digest([extra.vectorKey, vectorRecord.profileId || profile.profileId, extra.textHash || '', vectorRecord.vectorHash || '']),
        projectionVersion: 'projection_v1', textHash: extra.textHash || '', temporalEndTurn: extra.temporalEndTurn ?? null });
      // Persisted representations retain their real owner key and body dependency.
      // Ephemeral inline representations are used only by callers without a stored body.
      if (extra.vectorKey && !extra.vectorRecord) dependencies.push({ key: extra.vectorKey, digest: digest(vectorRecord) });
      dimension = d; expectedProfile = profile; bytes += additional;
      admittedFamilies.add(fam);
    }
    if (!documents.length) { diagnostics.status = 'no_compatible_representations'; return empty(); }
    if(collectOnly)return {documents,dependencies,profile:expectedProfile,diagnostics};
    let query;
    try { query = await embedQuery(String(queryText), config); }
    catch (error) { check(); diagnostics.status = 'query_embedding_unavailable'; diagnostics.reason = error.code || 'query_embedding_failed';
      diagnostics.queryRequestCount = Number(error.graphEmbeddingOperation?.embeddingRequests || 0); return empty(); }
    check();
    diagnostics.queryRequestCount = Number(query?.graphEmbeddingOperation?.embeddingRequests ?? query?.metadata?.requestCount ?? 0);
    diagnostics.queryCacheHits = Number(query?.metadata?.cacheHits || 0);
    diagnostics.coalesced = Boolean(query?.graphEmbeddingCoalesced);
    if (!query || query.provider !== expectedProfile.provider || query.model !== expectedProfile.model
      || query.dimensions !== dimension || query.metadata?.profileId !== expectedProfile.profileId
      || !vectorValid(query.vectors?.[0], dimension)) { diagnostics.status = 'query_space_mismatch'; return empty(); }
    const semanticSpace = { spaceId: expectedProfile.descriptor.spaceId, provider: expectedProfile.provider,
      model: expectedProfile.model, dimension, metric: 'cosine',
      taskPair: expectedProfile.queryTask + '/' + expectedProfile.documentTask, profileDigest: digest(expectedProfile.descriptor) };
    const documentRepresentations = Object.fromEntries(documents.map(document => [document.nodeId, {
      ...document, spaceId: semanticSpace.spaceId, provider: semanticSpace.provider, model: semanticSpace.model,
      dimension, metric: semanticSpace.metric, profileDigest: semanticSpace.profileDigest } ]));
    diagnostics.status = 'available'; diagnostics.admittedRepresentations = documents.length;
    diagnostics.representationBytes = bytes; diagnostics.spaceId = semanticSpace.spaceId;
    diagnostics.dimension = dimension; diagnostics.queryTask = expectedProfile.queryTask; diagnostics.documentTask = expectedProfile.documentTask;
    diagnostics.vectorlessFamilies = ['micro','state','lore'].filter(family => !admittedFamilies.has(family));
    diagnostics.admittedFamilies = [...admittedFamilies].sort();
    return { queryInput: { semanticSpace, queryEmbedding: query.vectors[0], documentRepresentations, queryVectors: {} }, dependencies, diagnostics };
  };
  // Rank all compatible Micro sources before spending the retained representation
  // allowance. The source-read ledger bounds this scan independently of the lane's
  // selected feature pages. Keep only eight scores/owner digests, never all vectors.
  const selectAdditionalRepresentations = async input => {
    const { graph, config, check = () => {}, resources } = input;
    const selected = [], diagnostics = { strategy: 'streaming_exact_cosine_top8', scanned: 0, compatible: 0, selected: 0 };
    let query = null, queryNorm = 0;
    const profiles = new Map(), sources = new Set((graph.nodes || []).filter(node => node.layer === 'source').map(node => node.id));
    for (const extra of input.additionalRepresentations || []) {
      check();
      if (extra.family !== 'micro' || !sources.has(extra.nodeId)
        || input.asOfTurn != null && Number.isSafeInteger(extra.temporalEndTurn) && extra.temporalEndTurn > input.asOfTurn) continue;
      const scope = resources?.scope();
      try {
        const record = await input.readVector(extra.vectorKey, { selectionScan: true });
        check(); diagnostics.scanned++;
        scope?.retain(record, 'micro_selection_workspace', 2);
        const dimension = record?.dimensions;
        if (!Number.isSafeInteger(dimension) || dimension < 1 || dimension > 65536
          || !vectorValid(record?.vector, dimension) || 3072 + dimension * 24 > (input.maxBytes ?? 262144)) continue;
        if (!profiles.has(dimension)) {
          try { profiles.set(dimension, profileFor({ ...config, dimensions: dimension })); }
          catch (_) { continue; }
        }
        const profile = profiles.get(dimension);
        if (record.schema !== 'libra.micro_vector.v1' || record.scopeKey !== graph.scopeKey
          || record.textHash !== extra.textHash || record.spaceDigest !== extra.spaceDigest
          || record.provider !== profile.provider || record.model !== profile.model || record.profileId !== profile.profileId) continue;
        if (!query) {
          try { query = await input.embedQuery(input.queryText, config); }
          catch (error) { check(); diagnostics.status = 'query_embedding_unavailable'; diagnostics.reason = error.code || 'query_embedding_failed'; return { references: [], diagnostics }; }
        }
        check();
        if (query?.provider !== profile.provider || query?.model !== profile.model
          || query?.metadata?.profileId !== profile.profileId || query?.dimensions !== dimension
          || !vectorValid(query?.vectors?.[0], dimension)) continue;
        const vector = record.vector, q = query.vectors[0];
        if (!queryNorm) queryNorm = Math.hypot(...q);
        let dot = 0, vNorm = 0;
        for (let i = 0; i < dimension; i++) { dot += q[i] * vector[i]; vNorm += vector[i] * vector[i]; }
        const similarity = dot / (queryNorm * Math.sqrt(vNorm));
        diagnostics.compatible++;
        const last = selected[selected.length - 1];
        if (selected.length === 8 && (similarity < last.similarity
          || similarity === last.similarity && extra.nodeId.localeCompare(last.nodeId) >= 0)) continue;
        selected.push({ ...extra, selectionDigest: digest(record), similarity });
        selected.sort((a, b) => b.similarity - a.similarity || a.nodeId.localeCompare(b.nodeId));
        if (selected.length > 8) selected.pop();
      } finally { scope?.close(); }
    }
    diagnostics.selected = selected.length;
    return { references: selected, diagnostics };
  };
  // Metadata-only directory: canonical corpus projections persist these owner
  // vector refs already. No vector body is read until Memory Lane executes it.
  const prepareLazy = async (input = {}) => {
    const {graph,canonicalRows=[],config,queryText='',asOfTurn=null,check=()=>{},pages,resources,evaluate}=input;
    if(!pages||typeof evaluate!=='function')throw new TypeError('LIBRA_GRAPH_SEMANTIC_LAZY_ADAPTER_REQUIRED');
    const maximum=input.maxBytes??262144;
    if(!Number.isSafeInteger(maximum)||maximum<4096||maximum>16777216)throw new TypeError('LIBRA_GRAPH_SEMANTIC_BUDGET_INVALID');
    const diagnostics={schema:'libra.native_graph_semantic.v1',status:!config?'configuration_unavailable':!config.enabled?'disabled':'no_compatible_representations',
      representationScope:'canonical_global_projection_source_access',access:'memory_lane_selective_vector_pages',durableVectorPagesRead:0,durableVectorBytesRead:0,ownerVectorRecordLoads:0,vectorCacheHits:0,queryRequestCount:0,queryCacheHits:0,coalesced:false,documentEmbeddingCalls:0,backgroundEmbeddingStarted:false,
      admittedRepresentations:0,representationBytes:0,maxRepresentationBytes:maximum,rejected:[],microRepresentations:[],vectorlessFamilies:['micro','state','lore'],byteBounded:false};
    const bySource=new Map();
    for(const unit of graph.units||[]){if(unit.family!=='canonical')continue;const source=(graph.nodes||[]).find(n=>n.id===unit.nodeId)?.sourceId;if(source)bySource.set(unit.recordKey,source);}
    const rows=new Map(),routingByNode=new Map((input.routingDirectory?.entries||[]).map(entry=>[entry.nodeId,entry]));
    // Non-canonical owner references use the same lazy lane as canonical vectors.
    const extras=new Map();
    if(config?.enabled&&String(queryText).trim())for(const extra of input.additionalRepresentations||[]){
      if(extra?.nodeId&&extra.vectorKey&&(graph.nodes||[]).some(node=>node.id===extra.nodeId&&node.layer==='source'))extras.set(extra.nodeId,extra);
    }
    if(config?.enabled&&String(queryText).trim())for(const row of canonicalRows){
      if(!bySource.has(row.key)||row.record?.embedding?.status!=='ready'||!row.record.embedding.vectorKey){diagnostics.rejected.push({recordKey:row.key,reason:'representation_missing'});continue;}
      if(asOfTurn!==null&&(!Number.isSafeInteger(row.record.turnRange?.end)||row.record.turnRange.end>asOfTurn)){diagnostics.rejected.push({recordKey:row.key,reason:'representation_outside_temporal_view'});continue;}
      const dimension=Number(row.record.embedding.dimensions||input.routingDirectory?.dimension||0);
      if(Number.isSafeInteger(dimension)&&dimension>0){let expected=null;try{expected=profileFor({...config,dimensions:dimension});}catch(_){}
        if(expected&&row.record.embedding.profileId!==expected.profileId){diagnostics.rejected.push({recordKey:row.key,reason:'embedding_space_mismatch'});continue;}}
      rows.set(bySource.get(row.key),row);
    }
    const dependencies=[];let used=0,queryPromise=null;
    const embedQuery=(...args)=>queryPromise||(queryPromise=Promise.resolve().then(()=>input.embedQuery(...args)));
    // Maintenance-published, source/profile-bound unit-vector coordinates allow
    // an exact upper bound. No lexical gate and no approximate top-k exclusion.
    const routing=input.routingDirectory;
    const references=[...rows.keys()];
    if(routing?.schema==='libra.graph_semantic_directory.v1'&&rows.size&&maximum>=4096){
      let profile=null;try{profile=profileFor({...config,dimensions:routing.dimension});}catch(_){}
      if(profile?.profileId===routing.profileId&&maximum>=3072+routing.dimension*24){
        let query;try{query=await embedQuery(queryText,config);}catch(error){diagnostics.status='query_embedding_unavailable';diagnostics.reason=error.code||'query_embedding_failed';diagnostics.queryRequestCount=Number(error.graphEmbeddingOperation?.embeddingRequests||0);rows.clear();}
        check();
        if(query){for(const key of ['queryRequestCount','queryCacheHits'])diagnostics[key]=key==='queryRequestCount'?Number(query.graphEmbeddingOperation?.embeddingRequests??query.metadata?.requestCount??0):Number(query.metadata?.cacheHits||0);}
        if(query&&query.metadata?.profileId===profile.profileId&&vectorValid(query.vectors?.[0],routing.dimension)){
          const vector=query.vectors[0],norm=Math.hypot(...vector),q=vector.map(x=>x/norm),bounds=new Map(),tails=new Map();
          for(const entry of routing.entries||[]){
            const row=rows.get(entry.nodeId);if(!row||entry.vectorKey!==row.record.embedding.vectorKey||entry.vectorHash!==row.record.embedding.vectorHash)continue;
            const count=entry.coordinates.length;let dot=0;
            for(let i=0;i<count;i++){dot+=q[i]*entry.coordinates[i];}
            if(!tails.has(count))tails.set(count,Math.hypot(...q.slice(count)));
            const tail=tails.get(count),upper=dot+tail*entry.tailNorm+1e-12;
            const nonPositive=(tail===0||entry.tailNorm===0)&&entry.coordinates.every((value,i)=>q[i]*value<=0);
            bounds.set(entry.nodeId,upper);
            if(upper<0||nonPositive){rows.delete(entry.nodeId);diagnostics.prunedByExactBound=(diagnostics.prunedByExactBound||0)+1;}
          }
          references.sort((a,b)=>(bounds.get(b)??1)-(bounds.get(a)??1)||a.localeCompare(b));
        }
      }
    }
    const readPage=async(spec,budget)=>{
      check();const extra=extras.get(spec.anchorNodeId);
      const row=extra?{key:extra.recordKey,record:{embedding:{dimensions:extra.vectorRecord?.dimensions||extra.dimensions}}}:rows.get(spec.anchorNodeId);
      if(!row)throw new Error('LIBRA_GRAPH_SEMANTIC_REFERENCE_INVALID');
      if(budget.pagesRead>=budget.maxPages)return {storageStopped:true,stopReason:'storage_page_count_budget',rows:[]};
      const required=routingByNode.get(spec.anchorNodeId)?.payloadBytes;
      if(Number.isSafeInteger(required)&&budget.bytesRead+required+512>budget.maxBytes)return {storageStopped:true,stopReason:'storage_byte_budget',rows:[]};
      const remaining=maximum-used;
      // Reserve the minimum retained feature before owner I/O. Once exhausted,
      // stop the scheduler; never continue hydrating the rest of the directory.
      const dimension=Number(routingByNode.get(spec.anchorNodeId)?routing?.dimension:row.record.embedding.dimensions||0);
      // Unknown-size owner records still need at least one feature envelope and
      // the vector's numeric coordinates; do not issue I/O for an impossible page.
      const storageFloor=512+(Number.isSafeInteger(dimension)&&dimension>0?dimension*2:0);
      if(budget.bytesRead+storageFloor>budget.maxBytes)return {storageStopped:true,stopReason:'storage_byte_budget',rows:[]};
      const minimum=used?1024+(diagnostics.dimension||0)*8:Number.isSafeInteger(dimension)&&dimension>0?3072+dimension*24:0;
      if(remaining<minimum){diagnostics.rejected.push({recordKey:row.key,reason:'representation_byte_budget'});return {storageStopped:true,stopReason:'storage_representation_byte_budget',rows:[]};}
      const entry=extra?null:routingByNode.get(spec.anchorNodeId);
      let savedRepresentation=null;
      if(Array.isArray(entry?.vectorPages)&&entry.vectorPages.length){
        const total=entry.vectorPages.reduce((n,ref)=>n+ref.bytes,0);
        if(budget.pagesRead+entry.vectorPages.length>budget.maxPages)return {storageStopped:true,stopReason:'storage_page_count_budget',rows:[]};
        if(budget.bytesRead+total>budget.maxBytes)return {storageStopped:true,stopReason:'storage_byte_budget',rows:[]};
        const parts=[],scope=resources?.scope();
        try{
          for(const ref of entry.vectorPages){
            check();const text=await input.readRepresentationPage(ref.key);check();
            if(typeof text!=='string'||input.fingerprint(text)!==ref.digest||pages.encodedSize(text).utf8Bytes!==ref.bytes)throw new Error('LIBRA_GRAPH_SEMANTIC_PAGE_CORRUPT');
            budget.pagesRead++;budget.bytesRead+=ref.bytes;diagnostics.durableVectorPagesRead++;diagnostics.durableVectorBytesRead+=ref.bytes;
            const handle=pages.open({partition:spec.partition,generation:spec.generation});let stage,lease;
            try{stage=pages.reserve(handle,pages.stageCost(pages.encodedSize(text)));lease=pages.install(handle,{pool:'units',codec:'json_array.v1',digest:ref.digest,rows:1},text,stage);const part=pages.decode(lease)[0];if(typeof part!=='string')throw new Error('LIBRA_GRAPH_SEMANTIC_PAGE_CORRUPT');scope?.retain(part,'semantic_page_fragments');parts.push(part);}
            finally{if(lease)pages.release(lease);if(stage)pages.releaseStage(stage);pages.close(handle);}
          }
          const joined=parts.join('');savedRepresentation=resources?await resources.withValue(joined,()=>JSON.parse(joined)):JSON.parse(joined);
          const source=graph.nodes.find(node=>node.id===spec.anchorNodeId);
          if(savedRepresentation.nodeId!==source?.id||savedRepresentation.bindingId!==source?.bindingId||savedRepresentation.profileDigest!==digest(profileFor({...config,dimensions:savedRepresentation.dimension}).descriptor))throw new Error('LIBRA_GRAPH_SEMANTIC_REPRESENTATION_BINDING_INVALID');
        }finally{scope?.close();}
      }
      const readVector=savedRepresentation?async()=>({schema:'libra.embedding_projection.v2',scopeKey:row.record.scopeKey,memoryId:row.record.memoryId,revision:row.record.revision,
        provider:savedRepresentation.provider,model:savedRepresentation.model,profileId:routing.profileId,dimensions:savedRepresentation.dimension,
        embeddingDescriptor:profileFor({...config,dimensions:savedRepresentation.dimension}).descriptor,projectionVersion:savedRepresentation.projectionVersion,
        textHash:savedRepresentation.textHash,vectorHash:row.record.embedding.vectorHash,entries:{global:{vector:savedRepresentation.vector,textHash:savedRepresentation.textHash}}}):async key=>{diagnostics.ownerVectorRecordLoads++;return await input.readVector(key);};
      const result=await prepare({...input,readVector,canonicalRows:extra?[]:[row],additionalRepresentations:extra?[extra]:[],maxBytes:Math.max(4096,remaining+(used?2048+(diagnostics.dimension||0)*16:0)),embedQuery});check();
      if(savedRepresentation)for(const dependency of result.dependencies)Object.assign(dependency,{ownerBodyDigest:entry.ownerBodyDigest,ownerRevision:entry.ownerRevision});

      diagnostics.rejected.push(...result.diagnostics.rejected);
      if(result.diagnostics.rejected.some(x=>x.reason==='representation_byte_budget'))return {storageStopped:true,stopReason:'storage_representation_byte_budget',rows:[]};
      if(result.diagnostics.status==='available'){
        const cost=result.diagnostics.representationBytes-(used?2048+result.diagnostics.dimension*16:0);
        if(cost>remaining){diagnostics.rejected.push({recordKey:row.key,reason:'representation_byte_budget'});return {storageStopped:true,stopReason:'storage_representation_byte_budget',rows:[]};}
        used+=result.diagnostics.representationBytes-(used?2048+result.diagnostics.dimension*16:0);dependencies.push(...result.dependencies);
        diagnostics.status='available';diagnostics.admittedRepresentations++;diagnostics.representationBytes=used;
        diagnostics.vectorlessFamilies=diagnostics.vectorlessFamilies.filter(family=>!result.diagnostics.admittedFamilies.includes(family));
        for(const key of ['queryRequestCount','queryCacheHits','coalesced','spaceId','dimension','queryTask','documentTask'])diagnostics[key]=result.diagnostics[key];
      }else if(!diagnostics.admittedRepresentations)diagnostics.status=result.diagnostics.status;
      let rep=result.queryInput.documentRepresentations[spec.anchorNodeId];
      const node=(graph.nodes||[]).find(n=>n.id===spec.anchorNodeId);
      let vectorBytes=0,vectorCacheHits=0;
      if(rep&&!savedRepresentation){
        const encoded=JSON.stringify(rep),parts=[];
        // Large representations use bounded common-cache pages. A query needs
        // no second full-vector cache; temporary reassembly shares its ledger.
        const scope=resources?.scope();
        try{
          scope?.retain(encoded,'semantic_vector_encoding');
          for(let offset=0;offset<encoded.length;offset+=24576){
            const text=JSON.stringify([encoded.slice(offset,offset+24576)]),size=pages.encodedSize(text);
            if(budget.bytesRead+vectorBytes+size.utf8Bytes>budget.maxBytes)return {storageStopped:true,stopReason:'storage_byte_budget',rows:[]};
            vectorBytes+=size.utf8Bytes;
            const handle=pages.open({partition:spec.partition,generation:spec.generation});let stage,lease;
            try{
              const binding={pool:'units',codec:'json_array.v1',digest:input.fingerprint(text),rows:1};
              lease=pages.acquire(handle,binding);
              if(lease){vectorCacheHits++;diagnostics.vectorCacheHits++;}else{stage=pages.reserve(handle,pages.stageCost(size));lease=pages.install(handle,binding,text,stage);}
              parts.push(pages.decode(lease)[0]);
            }finally{if(lease)pages.release(lease);if(stage)pages.releaseStage(stage);pages.close(handle);}
          }
          const joined=parts.join('');rep=resources?await resources.withValue(joined,()=>JSON.parse(joined)):JSON.parse(joined);
        }finally{scope?.close();}
      }
      const feature=rep?evaluate(node,{...result.queryInput,documentRepresentations:{[node.id]:rep},asOfTurn}):{score:null,status:'unavailable'};
      if(extra?.family==='micro'&&rep)diagnostics.microRepresentations.push({turn:extra.temporalEndTurn,similarity:feature.score});
      const items=[{nodeId:spec.anchorNodeId,semanticFeature:feature}];
      // Feature pages use the shared Cache Manager. Vectors remain scoped owner
      // payloads, with the same source I/O/retained/decode admission as before.
      const raw=JSON.stringify(items),size=pages.encodedSize(raw);
      if(budget.bytesRead+vectorBytes+size.utf8Bytes>budget.maxBytes)return {storageStopped:true,stopReason:'storage_byte_budget',rows:[]};
      if(!savedRepresentation)budget.pagesRead++;budget.bytesRead+=vectorBytes+size.utf8Bytes;
      const handle=pages.open({partition:spec.partition,generation:spec.generation});let stage,lease;
      try{
        stage=pages.reserve(handle,pages.stageCost(size));
        lease=pages.install(handle,{pool:'units',codec:'json_array.v1',digest:input.fingerprint(raw),rows:1},raw,stage);
        const decoded=pages.decode(lease);resources?.retain(decoded,'semantic_lane_features');
        return {schema:'libra.memory_graph_index_page.v1',table:'representations',generation:spec.generation,indexDigest:spec.indexDigest,
          offset:0,nextOffset:1,totalRows:1,items:decoded,serializedUtf8Bytes:vectorBytes+size.utf8Bytes,cacheHit:vectorCacheHits>0,stopReason:'frontier_exhausted'};
      }finally{if(lease)pages.release(lease);if(stage)pages.releaseStage(stage);pages.close(handle);}
    };
    return {queryInput:{semanticReferences:[...extras.keys(),...references.filter(id=>rows.has(id))],semanticBinding:input.fingerprint(JSON.stringify(config||null)),semanticSpace:null,queryEmbedding:null,documentRepresentations:{},queryVectors:{}},readPage,dependencies,diagnostics};
  };
  const buildDirectory=async input=>{
    const result=await prepare({...input,queryText:'maintenance semantic directory',collectOnly:true,maxBytes:16777216});
    if(!result.documents?.length)return null;
    const bySource=new Map();
    for(const unit of input.graph.units||[]){const source=input.graph.nodes.find(n=>n.id===unit.nodeId)?.sourceId;if(unit.family==='canonical'&&source)bySource.set(source,input.canonicalRows.find(r=>r.key===unit.recordKey));}
    // Each writer reserves the full unknown-value read allowance. Parallel
    // writes can exhaust pending durable quota before small reads settle.
    // Keep all representations and their order, with one writer in flight.
    const entries=[];
    for(const document of result.documents){input.check?.();const vector=document.vector,norm=Math.hypot(...vector),coordinates=vector.slice(0,16).map(x=>x/norm),row=bySource.get(document.nodeId);
        const rep={...document,spaceId:result.profile.descriptor.spaceId,provider:result.profile.provider,model:result.profile.model,dimension:vector.length,metric:'cosine',profileDigest:digest(result.profile.descriptor)},raw=JSON.stringify(rep);
        let payloadBytes=0;for(let offset=0;offset<raw.length;offset+=24576)payloadBytes+=input.pages?input.pages.encodedSize(JSON.stringify([raw.slice(offset,offset+24576)])).utf8Bytes:JSON.stringify([raw.slice(offset,offset+24576)]).length*3;
        entries.push({nodeId:document.nodeId,bindingId:document.bindingId,vectorKey:row.record.embedding.vectorKey,vectorHash:row.record.embedding.vectorHash,payloadBytes,...(input.writeRepresentation?await input.writeRepresentation(rep,row):{}),
          coordinates,tailNorm:Math.hypot(...vector.slice(coordinates.length))/norm});}
    return {schema:'libra.graph_semantic_directory.v1',dimension:result.documents[0].vector.length,profileId:result.profile.profileId,entries};
  };
  return Object.freeze({ prepare, prepareLazy, buildDirectory, selectAdditionalRepresentations });
};

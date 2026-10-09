/* LIBRARIAN SYSTEM EXECUTION CONTRACT v1.1.0 — BEGIN
 * Shared contracts and bounded operation lifecycle helpers. No storage, network or owner queues.
 * Provider authority and persistent corpus ownership remain inside each plugin.
 */
const MemorySuiteExecutionContract = (() => {
  'use strict';
  const VERSION = '1.1.0';
  class ContractError extends Error {
    constructor(code, message, details = {}) { super(message); this.name = 'MemorySuiteContractError'; this.code = code; this.details = details; }
  }
  const fail = (code, message, details) => { throw new ContractError(code, message, details); };
  const stable = value => {
    if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
    if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}`;
    return JSON.stringify(value) ?? 'null';
  };
  // Identity acceleration only; not authorization, signatures, or source-proof authority.
  const hash = value => {
    const s = typeof value === 'string' ? value : stable(value); let a = 2166136261, b = 0x9e3779b9;
    for (let i = 0; i < s.length; i++) { a = Math.imul(a ^ s.charCodeAt(i), 16777619); b = Math.imul(b ^ s.charCodeAt(i), 2246822519); }
    return `${(a >>> 0).toString(16).padStart(8, '0')}${(b >>> 0).toString(16).padStart(8, '0')}`;
  };
  const dimension = value => {
    const s = String(value ?? 'auto').trim().toLowerCase();
    if (!s || ['0', 'auto', 'default', 'provider_default', 'provider-default'].includes(s)) return 'auto';
    const n = Number(s);
    if (!Number.isInteger(n) || n < 1 || n > 65536) fail('DIMENSION_MISMATCH', 'Embedding dimensions must be auto or an integer in 1–65536.');
    return n;
  };
  const resolvedDimension = value => { const d = dimension(value); return d === 'auto' ? 0 : d; };
  const secretKey = key => /^(?:authorization|proxy-authorization|api[-_]?key|x[-_]api[-_]key|key|token|access[-_]token|refresh[-_]token|id[-_]token|secret|password|passwd|signature|sig|credential|credentials|x-amz-credential|x-amz-signature|x-goog-api-key|auth)$/i.test(String(key));
  const publicSemantics = value => {
    if (Array.isArray(value)) return value.map(publicSemantics);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([k]) => !secretKey(k) && !['__proto__', 'constructor', 'prototype'].includes(k)).map(([k, v]) => [k, publicSemantics(v)]));
    return value;
  };
  const parseTemplate = value => {
    if (!value) return null;
    if (typeof value === 'object') return publicSemantics(value);
    try { return publicSemantics(JSON.parse(value)); } catch (_) { return { invalidTemplate: true }; }
  };
  const sanitizedRoute = value => {
    const raw = String(value || '').trim();
    try {
      const u = new URL(raw); u.username = ''; u.password = ''; u.hash = '';
      const entries = Array.from(u.searchParams.entries()).filter(([k]) => !secretKey(k));
      entries.sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));
      u.search = ''; entries.forEach(([k, v]) => u.searchParams.append(k, v));
      u.pathname = u.pathname.replace(/\/+$/, '') || '/';
      return u.toString();
    } catch (_) {
      // A malformed URL cannot certify a compatible dense space. Never echo its credentials.
      return raw ? `invalid-route:${hash(raw.replace(/^[^:]+:\/\/[^/@]+@/, '').replace(/[?#][\s\S]*$/, ''))}` : '';
    }
  };
  const joinEndpoint = (base, suffix) => {
    try {
      const u = new URL(String(base)); const path = u.pathname.replace(/\/+$/, '');
      let tail = String(suffix).replace(/^\/+/, '');
      if (/\/v\d+$/.test(path)) tail = tail.replace(/^v\d+\//, '');
      if (!path.endsWith(`/${tail}`)) u.pathname = `${path}/${tail}`;
      return u.toString();
    } catch (_) { return `${String(base || '').replace(/\/+$/, '')}/${String(suffix).replace(/^\/+/, '')}`; }
  };
  const embeddingDescriptor = input => {
    const requested = dimension(input.dimensions);
    const actual = resolvedDimension(input.resolvedDimensions ?? requested);
    const space = Object.freeze({
      schema: 'memory-suite.embedding-space.v1', model: String(input.model || ''), modelRevision: String(input.modelRevision || ''),
      resolvedDimensions: actual || null, requestedDimensions: requested,
      queryTask: String(input.queryTask || ''), documentTask: String(input.documentTask || ''),
      queryPrefix: String(input.queryPrefix || ''), documentPrefix: String(input.documentPrefix || ''),
      normalization: input.normalize !== false ? 'l2' : 'none', dtype: 'float32-validated',
      preprocessing: String(input.preprocessing || ''), pooling: 'source-weighted-mean.v2',
      grouping: String(input.grouping || 'independent.v1')
    });
    const route = Object.freeze({
      schema: 'memory-suite.embedding-route.v1', provider: String(input.provider || ''), endpoint: sanitizedRoute(input.endpoint),
      method: String(input.method || 'POST').toUpperCase(), apiVariant: String(input.apiVariant || ''),
      semanticTemplate: parseTemplate(input.template), responsePath: String(input.responsePath || '')
    });
    return Object.freeze({ schema: 'memory-suite.embedding-descriptor.v1', space, route,
      spaceId: `mse_${hash(space)}`, routeId: `mer_${hash(route)}`,
      profileId: `mep_${hash({ space, route })}`, resolvedDimensions: actual || null });
  };
  // Volatile permission epochs are deliberately not persisted or exposed in diagnostics.
  const authorities = new Map(); let authoritySequence = 0;
  const authorityEpoch = value => {
    const k = stable(value);
    if (authorities.has(k)) return authorities.get(k);
    if (authorities.size >= 32) authorities.delete(authorities.keys().next().value);
    const epoch = ++authoritySequence; authorities.set(k, epoch); return epoch;
  };
  const cacheIdentity = input => `mec_${hash({ owner: input.owner, scope: input.scope || 'owner-local', source: input.source || '',
    purpose: input.purpose || 'document', space: input.descriptor.spaceId, route: input.descriptor.routeId,
    authorityEpoch: input.authorityEpoch || 0, epoch: input.epoch || 0,
    group: input.group || '', text: String(input.text ?? '') })}`;
  const vector = (input, options = {}) => {
    if (!Array.isArray(input) || !input.length || input.length > 65536) fail('INVALID_RESPONSE', 'Embedding vector must be a nonempty numeric array.');
    const expected = resolvedDimension(options.dimensions);
    if (expected && input.length !== expected) fail('DIMENSION_MISMATCH', `Embedding dimension mismatch: expected ${expected}, received ${input.length}.`);
    let sum = 0;
    for (const n of input) {
      if (typeof n !== 'number' || !Number.isFinite(n)) fail('INVALID_RESPONSE', 'Embedding coordinates must be finite numbers without coercion.');
      sum += n * n;
      if (!Number.isFinite(sum)) fail('INVALID_RESPONSE', 'Embedding vector norm overflow.');
    }
    if (!(sum > 0)) fail('INVALID_RESPONSE', 'Embedding provider returned a zero vector.');
    const norm = Math.sqrt(sum);
    const values = options.normalize === true ? input.map(n => n / norm) : input.slice();
    if (options.float32 !== false) {
      let storedNorm = 0;
      for (const n of values) { const f = Math.fround(n); if (!Number.isFinite(f)) fail('INVALID_RESPONSE', 'Embedding coordinate cannot be represented as Float32.'); storedNorm += f * f; }
      if (!(storedNorm > 0) || !Number.isFinite(storedNorm)) fail('INVALID_RESPONSE', 'Embedding vector loses its norm in Float32 storage.');
    }
    return values;
  };
  const batch = (vectors, count, dimensions = 0) => {
    if (!Array.isArray(vectors) || vectors.length !== count) fail('INVALID_RESPONSE', `Embedding response count mismatch: expected ${count}, received ${Array.isArray(vectors) ? vectors.length : 0}.`);
    let d = resolvedDimension(dimensions);
    for (const v of vectors) { const valid = vector(v, { dimensions: d }); d = d || valid.length; }
    return d;
  };
  const indexed = (rows, count, field = 'index') => {
    if (!Array.isArray(rows) || rows.length !== count) fail('INVALID_RESPONSE', 'Embedding indexed response count mismatch.');
    const out = new Array(count);
    for (const row of rows) {
      const index = row?.[field];
      if (!Number.isInteger(index) || index < 0 || index >= count || Object.prototype.hasOwnProperty.call(out, index)) fail('INVALID_RESPONSE', 'Embedding response indexes must form an exact bijection.');
      out[index] = row;
    }
    return out;
  };
  const pool = (parts, normalize = true) => {
    if (!Array.isArray(parts) || !parts.length) fail('INVALID_RESPONSE', 'Embedding parts are missing.');
    const d = batch(parts.map(p => p.vector), parts.length);
    if (parts.length === 1) return vector(parts[0].vector, { normalize: false });
    const weights = parts.map(p => Number.isFinite(p.weight) && p.weight > 0 ? p.weight : 1);
    const total = weights.reduce((a, b) => a + b, 0);
    const out = new Array(d).fill(0);
    for (let i = 0; i < parts.length; i++) for (let j = 0; j < d; j++) out[j] += parts[i].vector[j] * (weights[i] / total);
    return vector(out, { normalize });
  };
  const utf8Bytes = text => typeof TextEncoder === 'function' ? new TextEncoder().encode(String(text)).length : unescape(encodeURIComponent(String(text))).length;
  // Explicit conservative bound, not reported as exact provider token usage.
  const tokenBound = text => utf8Bytes(text);
  const splitSource = (value, maxTokens, estimate = tokenBound) => {
    const source = String(value ?? '');
    if (!source.length) return [];
    if (!(maxTokens > 0)) fail('INPUT_TOO_LONG', 'Embedding route has no validated input limit.');
    const parts = []; let start = 0;
    while (start < source.length) {
      let lo = start + 1, hi = source.length, end = start;
      while (lo <= hi) { const mid = (lo + hi) >>> 1; if (estimate(source.slice(start, mid)) <= maxTokens) { end = mid; lo = mid + 1; } else hi = mid - 1; }
      if (end < source.length && /[\uD800-\uDBFF]/.test(source[end - 1]) && /[\uDC00-\uDFFF]/.test(source[end])) end--;
      if (end <= start) fail('INPUT_TOO_LONG', 'Embedding budget is smaller than one Unicode code point.');
      parts.push({ text: source.slice(start, end), start, end }); start = end;
    }
    return parts;
  };
  const inputLimits = (provider, model = '', perInput = 0) => {
    const p = String(provider), m = String(model).toLowerCase();
    let input = perInput > 0 ? perInput : 7900, total = 100000, bytes = 1024 * 1024, count = 128;
    if (p === 'voyage_context') { input = 30000; total = 110000; count = 1000; }
    else if (p === 'voyageai') { input = 30000; total = /4-lite|3\.5-lite/.test(m) ? 950000 : (/voyage-4$|voyage-3\.5$|voyage-2$/.test(m) ? 300000 : 110000); count = 1000; }
    else if (p === 'openai') total = 290000;
    else if (p === 'cohere') { total = 120000; count = 96; }
    return Object.freeze({ perInputTokens: input, perRequestTokens: total, perRequestBytes: bytes, maxInputs: count, estimate: 'utf8-byte-upper-bound.v1' });
  };
  const makeBatches = (rows, limits, requestedCount = 128, getText = row => row.text) => {
    const out = []; let pending = [], tokens = 0, bytes = 2;
    const flush = () => { if (pending.length) out.push(pending); pending = []; tokens = 0; bytes = 2; };
    for (const row of rows) {
      const text = getText(row), t = tokenBound(text), b = utf8Bytes(JSON.stringify(text)) + 1;
      if (t > limits.perInputTokens || b > limits.perRequestBytes) fail('INPUT_TOO_LONG', 'Formatted embedding input exceeds its validated input/byte limit.');
      if (pending.length && (pending.length >= Math.min(limits.maxInputs, requestedCount) || tokens + t > limits.perRequestTokens || bytes + b > limits.perRequestBytes)) flush();
      pending.push(row); tokens += t; bytes += b;
    }
    flush(); return out;
  };
  const validateEmbeddingPayload = data => {
    // Inspect provider status before adapters discard everything except coordinates.
    const rows = [data, ...(Array.isArray(data?.predictions) ? data.predictions : []),
      ...(Array.isArray(data?.embeddings) ? data.embeddings : []), ...(Array.isArray(data?.data) ? data.data : [])];
    for (const row of rows) {
      for (const status of [row, row?.statistics, row?.metadata, row?.embeddings?.statistics, row?.embedding?.statistics]) {
        if (status?.truncated === true || status?.truncated === 'true') fail('INPUT_TRUNCATED', 'Provider reported truncated embedding input; the vector cannot represent the complete source.');
      }
      if (Array.isArray(row?.data)) for (const part of row.data) {
        if (part?.truncated === true || part?.statistics?.truncated === true) fail('INPUT_TRUNCATED', 'Provider reported truncated contextual input.');
      }
    }
    return data;
  };
  const createLedger = (options = {}) => {
    const limit = Number.isInteger(options.maxRequests) && options.maxRequests >= 0 ? options.maxRequests : 1024;
    const deadlineAt = Number(options.deadlineAt) > 0 ? Number(options.deadlineAt) : 0;
    const rows = []; let cancelled = false;
    const check = () => {
      if (cancelled || options.signal?.aborted) fail('ABORTED', 'Operation was cancelled before wire submission.');
      if (deadlineAt && Date.now() >= deadlineAt) fail('TIMEOUT', 'Operation deadline expired before wire submission.');
      if (typeof options.isCurrent === 'function' && options.isCurrent() !== true) fail('STALE_SOURCE', 'Operation source or route snapshot is no longer current.');
    };
    return Object.freeze({
      reserve(kind = 'embedding', meta = {}) {
        if (rows.some(row => row.state === 'outcome_unknown' && row.settledAt == null)) fail('EMBEDDING_PHYSICAL_PENDING', 'A previous submission has no confirmed physical outcome.');
        check(); if (rows.length >= limit) fail('REQUEST_BUDGET_EXHAUSTED', 'Physical request budget exhausted.', { maxRequests: limit, submitted: rows.length });
        const row = { index: rows.length + 1, kind, state: 'submitted', submittedAt: Date.now(), settledAt: null, usage: null };
        rows.push(row); return row;
      },
      settle(row, state = 'complete', usage = null) {
        if (!rows.includes(row) || row.settledAt != null) return;
        row.state = state; row.logicalSettledAt = Date.now();
        row.settledAt = state === 'outcome_unknown' ? null : Date.now();
        row.usage = usage && typeof usage === 'object' ? publicSemantics(usage) : null;
      },
      check, cancel() { cancelled = true; },
      snapshot() { return { maxRequests: limit, requestCount: rows.length, embeddingRequests: rows.filter(r => r.kind === 'embedding').length,
        metadataRequests: rows.filter(r => r.kind === 'metadata').length, unknownOutcomes: rows.filter(r => r.state === 'outcome_unknown').length,
        pendingRequests: rows.filter(r => !r.settledAt).length, attempts: rows.map(r => ({ ...r })) }; }
    });
  };
  const TASK_DEFAULTS = Object.freeze({
    canonical_memory: [32768, 65536], reaction_brief: [12000, 32768],
    sga_private_analysis: [8192, 16384], sga_full_draft: [16384, 32768], sga_patch: [8192, 16384],
    sga_final_rewrite: [16384, 32768], sga_length_rewrite: [16384, 32768],
    input_candidates: [8192, 16384], input_translation: [8192, 16384],
    prompt_studio_dialogue: [4096, 8192], prompt_studio_compile: [4096, 8192], connection_probe: [2048, 8192],
    hayaku_packet_recovery: [16384, 32768], hayaku_cold_start: [16384, 32768], hayaku_failed_analysis_resolution: [16384, 32768]
  });
  const completion = result => {
    const content = typeof result?.content === 'string' ? result.content : '';
    const finish = String(result?.finishReason || result?.finish_reason || result?.stopReason || result?.stop_reason || '').toLowerCase();
    const refusal = result?.refusal === true || ['refusal', 'content_filter', 'safety', 'recitation', 'blocklist', 'prohibited_content'].includes(finish);
    const truncated = result?.truncated === true || ['length', 'max_tokens', 'max_output_tokens', 'max_completion_tokens', 'max_token', 'token_limit'].includes(finish);
    const knownComplete = ['stop', 'end_turn', 'stop_sequence', 'completed', 'complete'].includes(finish);
    const reasonOnly = !content.trim() && !!(result?.reasoningOnly || result?.reasoningText || result?.reasoning_content || result?.reasoning);
    const state = refusal ? 'refusal' : truncated ? 'truncated' : reasonOnly ? 'reasoning_only' : knownComplete ? 'complete' : 'unknown';
    return Object.freeze({ schema: 'memory-suite.completion-envelope.v1', state, content, terminalObserved: knownComplete || truncated || refusal,
      usage: result?.usage && typeof result.usage === 'object' ? result.usage : null,
      transport: String(result?.transport || ''), finishReason: finish || null, model: result?.model || null });
  };
  const streamProtocol = (variant, endpoint = '') => {
    if (variant === 'responses' || /\/responses(?:[?#]|$)/.test(endpoint)) return 'responses';
    if (variant === 'anthropic') return 'anthropic';
    if (['gemini', 'vertex_gemini'].includes(variant)) return 'gemini';
    if (variant === 'ollama_native') return 'ollama';
    if (['openai', 'openai_compatible', 'openai_compat', 'vertex_openai'].includes(variant) || /\/chat\/completions(?:[?#]|$)/.test(endpoint)) return 'chat';
    return null;
  };
  // Bounded transport decoder. Reasoning bytes count toward limits but are never retained.
  // A provider terminal event is mandatory; an apparently complete JSON fragment is not one.
  const receiveGenerationStream = async (response, protocol, options = {}) => {
    if (!['chat','responses','anthropic','gemini','ollama'].includes(protocol)) fail('UNVERIFIED_STREAM_ROUTE','Unknown stream protocol.');
    if (response?.ok === false || Number(response?.status) >= 400) fail('STREAM_HTTP_ERROR','Streaming request failed before completion.');
    const maxBytes = Math.min(16777216, Math.max(1024, Number(options.maxBytes) || 8388608));
    const maxContent = Math.min(4194304, Math.max(128, Number(options.maxContentChars) || 2097152));
    const deadlineAt = Number(options.deadlineAt) || Date.now() + 180000;
    let bytes=0, frames=0, buffer='', content='', usage=null, model=null, finishReason='', terminal=false, refusal=false, reasoningOnly=false, reader=null;
    const decoder = new TextDecoder('utf-8', {fatal:true});
    const append = value => { if(typeof value!=='string')return; if(terminal)fail('STREAM_AFTER_TERMINAL','Content after terminal event.'); if(content.length+value.length>maxContent)fail('STREAM_CONTENT_LIMIT','Stream content limit exceeded.'); content+=value; };
    const consume = raw => {
      if(++frames>100000)fail('STREAM_EVENT_LIMIT','Stream event limit exceeded.');
      if(raw.trim()==='[DONE]'){if(protocol!=='chat'||!finishReason)fail('STREAM_TERMINAL_INVALID','Missing finish reason before DONE.');terminal=true;return;}
      let data;try{data=JSON.parse(raw);}catch(_){fail('STREAM_INVALID_JSON','Invalid stream event JSON.');}
      if(data.error || data.type==='error' || data.type==='response.failed')fail('STREAM_PROVIDER_ERROR','Provider reported a stream failure.');
      model=data.model||data.response?.model||data.message?.model||model;
      if(protocol==='chat'){
        if(data.usage)usage=data.usage;
        if(data.choices?.length>1)fail('STREAM_MULTIPLE_CHOICES','Only one completion is supported.');
        const c=data.choices?.[0];if(c){if(c.index!=null&&c.index!==0)fail('STREAM_CHOICE_INVALID','Unexpected completion index.');append(c.delta?.content);if(c.delta?.refusal)refusal=true;if(c.delta?.reasoning_content||c.delta?.reasoning)reasoningOnly=true;if(c.finish_reason)finishReason=String(c.finish_reason);}
      } else if(protocol==='responses'){
        if(data.type==='response.output_text.delta')append(data.delta);
        if(data.type==='response.refusal.delta')refusal=true;
        if(/reasoning.*delta/.test(data.type||''))reasoningOnly=true;
        if(data.type==='response.completed'||data.type==='response.incomplete'){
          if(terminal)fail('STREAM_TERMINAL_INVALID','Duplicate terminal event.');
          usage=data.response?.usage||usage;
          finishReason=data.type==='response.completed'?'completed':String(data.response?.incomplete_details?.reason||'unknown');terminal=true;
        }
      } else if(protocol==='anthropic'){
        if(data.type==='message_start')usage={...(data.message?.usage||{})};
        if(data.type==='content_block_delta'){if(data.delta?.type==='text_delta')append(data.delta.text);if(data.delta?.type==='thinking_delta')reasoningOnly=true;}
        if(data.type==='message_delta'){usage={...(usage||{}),...(data.usage||{})};finishReason=String(data.delta?.stop_reason||finishReason);}
        if(data.type==='message_stop'){if(!finishReason||terminal)fail('STREAM_TERMINAL_INVALID','Missing or duplicate terminal reason.');terminal=true;}
      } else if(protocol==='gemini'){
        if(data.usageMetadata)usage=data.usageMetadata;
        if(data.promptFeedback?.blockReason){refusal=true;finishReason='safety';terminal=true;}
        if(data.candidates?.length>1)fail('STREAM_MULTIPLE_CHOICES','Only one candidate is supported.');
        const c=data.candidates?.[0];if(c){for(const p of c.content?.parts||[]){if(p.thought)reasoningOnly=true;else append(p.text);}if(c.finishReason){finishReason=String(c.finishReason);terminal=true;}}
      } else {
        append(data.message?.content??data.response);if(data.message?.thinking||data.thinking)reasoningOnly=true;
        if(data.done===true){finishReason=String(data.done_reason||'stop');usage={prompt_tokens:data.prompt_eval_count??null,completion_tokens:data.eval_count??null};terminal=true;}
      }
    };
    const feed = (chunk, final=false) => {
      bytes+=typeof chunk==='string'?utf8Bytes(chunk):Number(chunk?.byteLength||0);
      if(bytes>maxBytes)fail('STREAM_BYTE_LIMIT','Stream byte limit exceeded.');
      buffer+=typeof chunk==='string'?chunk:decoder.decode(chunk||new Uint8Array(),{stream:!final});
      if(buffer.length>1048576)fail('STREAM_FRAME_LIMIT','Stream frame limit exceeded.');
      // Normalize CRLF only once both bytes are present, including split network chunks.
      buffer=buffer.replace(/\r\n/g,'\n');
      const separator=protocol==='ollama'?'\n':'\n\n';let at;
      while((at=buffer.indexOf(separator))>=0){const frame=buffer.slice(0,at);buffer=buffer.slice(at+separator.length);
        const raw=protocol==='ollama'?frame:frame.split('\n').filter(line=>line.startsWith('data:')).map(line=>line.slice(5).replace(/^ /,'')).join('\n');
        if(raw.trim())consume(raw);
      }
      if(final&&buffer.trim()){
        if(protocol==='ollama')consume(buffer);else fail('STREAM_INCOMPLETE_FRAME','Incomplete SSE frame at EOF.');buffer='';
      }
    };
    try {
      const body=response?.body?.getReader?response.body:response?.getReader?response:null;
      if(body){reader=body.getReader();for(;;){const part=await awaitPhysical(reader.read(),{signal:options.signal,deadlineAt});if(part.done)break;feed(part.value);}}
      else {const raw=typeof response==='string'?response:typeof response?.data==='string'?response.data:typeof response?.body==='string'?response.body:await awaitPhysical(response.text(),{signal:options.signal,deadlineAt});feed(raw);}
      feed(new Uint8Array(),true);
      if(!terminal)fail('STREAM_TERMINAL_MISSING','EOF without a verified provider terminal event.');
      if(completion({content,finishReason:refusal?'refusal':finishReason,reasoningOnly}).state==='unknown')fail('STREAM_TERMINAL_INVALID','Provider did not report an adoptable completion or a classified terminal rejection.');
      if(options.signal?.aborted||Date.now()>=deadlineAt)fail('OUTCOME_UNKNOWN_CANCELLED','Stream cancelled or deadline expired.');
      return {content,usage,model,finishReason:refusal?'refusal':finishReason,reasoningOnly:reasoningOnly&&!content.trim(),streamed:true,raw:null,
        streamMeta:{protocol,terminalObserved:true,bytes,frames,usageReported:usage!=null}};
    } catch(error){try{const cancellation=reader?.cancel?.();Promise.resolve(cancellation).catch(()=>{});}catch(_){}throw error;}
    finally{try{reader?.releaseLock?.();}catch(_){}}
  };
  const normalizeGenerationPolicy = input => {
    const p=input&&typeof input==='object'?input:{};
    if(p.version!=null&&p.version!==1)fail('GENERATION_POLICY_UNSUPPORTED','Unsupported generation policy version.');
    return Object.freeze({version:1,enabled:p.enabled===true,extraCalls:p.extraCalls===1?1:0,streaming:p.streaming===true,
      initialTotal:65536,recoveryTotal:98304,aggregateOutput:p.extraCalls===1?163840:65536,aggregateInput:p.extraCalls===1?240000:120000,wallMs:270000});
  };
  const generationPolicyPreview = (before, after) => {
    const previous=normalizeGenerationPolicy(before),next=normalizeGenerationPolicy(after);
    return {schema:'memory-suite.generation-policy-preview.v1',previous,next,changed:stable(previous)!==stable(next),
      maxPhysicalCalls:next.enabled?1+next.extraCalls:1,automaticCapIncrease:false,basis:hash(previous)};
  };
  const SAME_SPACE_REGISTRY = Object.freeze({version:1,entries:Object.freeze([
    Object.freeze({id:'voyage-4-shared-space',models:Object.freeze(['voyage-4-large','voyage-4','voyage-4-lite','voyage-4-nano']),hostname:'api.voyageai.com',evidence:'https://docs.voyageai.com/docs/embeddings'})
  ])});
  const verifiedSameSpace = (left,right) => {
    if(!left?.space||!right?.space||!left?.route||!right?.route)return null;
    for(const d of [left,right])if(d.profileId!==`mep_${hash({space:d.space,route:d.route})}`)return null;
    const a={...left.space},b={...right.space};
    if(!a.resolvedDimensions||a.resolvedDimensions!==b.resolvedDimensions)return null;
    let hostA='',hostB='';try{hostA=new URL(left.route.endpoint).hostname;hostB=new URL(right.route.endpoint).hostname;}catch(_){return null;}
    const entry=SAME_SPACE_REGISTRY.entries.find(e=>e.hostname===hostA&&hostA===hostB&&e.models.includes(a.model)&&e.models.includes(b.model));
    if(!entry)return null;
    // No exception for unknown revision, templates, task modes, pooling or preprocessing.
    delete a.model;delete b.model;
    if(stable(a)!==stable(b)||stable(left.route)!==stable(right.route))return null;
    return {registryVersion:SAME_SPACE_REGISTRY.version,entryId:entry.id,evidence:entry.evidence,sourceProfileId:left.profileId,targetProfileId:right.profileId};
  };
  const commitMetadataMigration = async (rows, owner) => {
    if(!Array.isArray(rows)||rows.length>1000)fail('MIGRATION_LIMIT','Select at most 1000 metadata records.');
    const attempted=[];
    try{
      for(const row of rows){await owner.assertCurrent();if(stable(await owner.read(row.key))!==stable(row.before))fail('MIGRATION_SOURCE_CHANGED','Metadata changed after preview.');}
      for(const row of rows){await owner.assertCurrent();if(stable(await owner.read(row.key))!==stable(row.before))fail('MIGRATION_SOURCE_CHANGED','Metadata changed before write.');attempted.push(row);await owner.write(row.key,row.after);if(stable(await owner.read(row.key))!==stable(row.after))fail('MIGRATION_READBACK_FAILED','Metadata migration physical readback mismatch.');}
      await owner.assertCurrent();
      return {ok:true,migrated:rows.length,readbackVerified:true,providerCallCount:0,registryVersion:SAME_SPACE_REGISTRY.version};
    }catch(cause){
      const rollbackErrors=[];
      for(const row of attempted.reverse())try{const current=await owner.read(row.key);if(stable(current)===stable(row.before))continue;if(stable(current)!==stable(row.after))fail('MIGRATION_ROLLBACK_CONFLICT','Concurrent metadata edit cannot be overwritten.');await owner.write(row.key,row.before);if(stable(await owner.read(row.key))!==stable(row.before))fail('MIGRATION_ROLLBACK_READBACK_FAILED','Rollback readback mismatch.');}catch(error){rollbackErrors.push({key:row.key,code:error.code||'ROLLBACK_FAILED'});}
      if(rollbackErrors.length)fail('MIGRATION_ROLLBACK_INCOMPLETE','Metadata rollback requires recovery.',{cause:cause.code,rollbackErrors});throw cause;
    }
  };
  const routeCapability = (provider, model, endpoint = '', apiVariant = '') => {
    const p = String(provider || '').toLowerCase(), m = String(model || '').toLowerCase(), route = sanitizedRoute(endpoint);
    const otherAx = ['risu', 'risuai', 'risuai_aux', 'risu_aux', 'otherax', 'other_ax', 'risuai_otherax', 'risu_otherax', 'risu_auxiliary'].includes(p);
    let hostname = ''; try { hostname = new URL(endpoint).hostname.toLowerCase(); } catch (_) {}
    let forcedReasoning = false, reasoningEfforts = [], tokenField = 'max_tokens', fixedSampling = false;
    if (/kimi-k3/.test(m) && ['api.moonshot.ai', 'api.moonshot.cn'].includes(hostname)) { forcedReasoning = true; reasoningEfforts = ['low', 'high', 'max']; tokenField = 'max_completion_tokens'; fixedSampling = true; }
    else if (/deepseek-v4/.test(m) && hostname === 'api.deepseek.com') { reasoningEfforts = ['low', 'high', 'max']; }
    else if (apiVariant === 'responses') tokenField = 'max_output_tokens';
    else if (['gemini','vertex_gemini'].includes(apiVariant)) tokenField = 'generationConfig.maxOutputTokens';
    else if (apiVariant === 'ollama_native') tokenField = 'options.num_predict';
    else if (/^(?:gpt-[5-9]|o[134](?:-|$))/.test(m)) tokenField = 'max_completion_tokens';
    return Object.freeze({ schema: 'memory-suite.route-capability.v1', routeId: `mgr_${hash({ p, m, route, apiVariant })}`, provider: p, model: m,
      otherAx, overridesSupported: !otherAx, tokenField, forcedReasoning, reasoningEfforts, fixedSampling,
      streamProtocol:otherAx?null:streamProtocol(apiVariant,endpoint),streamingValidated:!otherAx&&!!streamProtocol(apiVariant,endpoint), semanticRepairSupported: false });
  };
  const invocationPlan = options => {
    const taskKind = String(options.taskKind || '');
    if (!Object.prototype.hasOwnProperty.call(TASK_DEFAULTS, taskKind)) fail('UNKNOWN_TASK_KIND', `Unregistered generation task: ${taskKind || '(missing)'}.`);
    const [defaultVisible, defaultTotal] = TASK_DEFAULTS[taskKind];
    const explicitCap = Number(options.hardCap) > 0 ? Math.floor(Number(options.hardCap)) : defaultTotal;
    const requestedTotal = Number(options.requestedTotal) > 0 ? Math.floor(Number(options.requestedTotal)) : defaultTotal;
    const bounds = [explicitCap, requestedTotal];
    for (const value of [options.modelMax, options.contextRemaining, options.aggregateRemaining]) if (Number.isFinite(value) && value >= 0) bounds.push(Math.floor(value));
    const requestedEffective = Math.min(...bounds);
    if (requestedEffective < 1) fail('REQUEST_BUDGET_EXHAUSTED', 'No generation output budget remains.');
    const route = options.route;
    const extraCalls = options.extraCalls === 1 ? 1 : 0;
    return Object.freeze({ schema: 'memory-suite.invocation-plan.v1', taskKind, route,
      limits:{modelMax:Number.isFinite(options.modelMax)?options.modelMax:null,contextRemaining:Number.isFinite(options.contextRemaining)?options.contextRemaining:null},
      requested: { visibleHeadroom: Number(options.visibleHeadroom) > 0 ? Number(options.visibleHeadroom) : defaultVisible,
        reasoningAllowance: Number(options.reasoningAllowance) > 0 ? Number(options.reasoningAllowance) : null, total: requestedTotal, hardCap: explicitCap },
      effective: route.otherAx ? { outputCap: null, reasoningAllowance: null, effort: null, owner: 'host-managed' }
        : { outputCap: requestedEffective, effort: options.effort || null, owner: 'plugin' },
      extraCalls, maxPhysicalCalls: 1 + extraCalls, streaming: options.streaming===true&&route.streamingValidated });
  };
  const validatePayload = (payload, plan) => {
    if (plan.route.otherAx) fail('UNSUPPORTED_OVERRIDE', 'OtherAx does not accept direct API payload overrides.');
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) fail('INVALID_REQUEST', 'Generation payload must be an object.');
    const p = { ...payload }, r = plan.route;
    const aliases = ['max_tokens', 'max_completion_tokens', 'max_output_tokens', 'generationConfig.maxOutputTokens', 'options.num_predict'];
    const read = key => key.split('.').reduce((value, part) => value?.[part], p);
    const write = (key, value) => { const parts=key.split('.'); if(parts.length===1)p[key]=value; else p[parts[0]]={...(p[parts[0]]||{}),[parts[1]]:value}; };
    const remove = key => { const parts=key.split('.'); if(parts.length===1)delete p[key]; else {p[parts[0]]={...p[parts[0]]};delete p[parts[0]][parts[1]];} };
    const present = aliases.filter(k => read(k) != null);
    if (present.length > 1) fail('TOKEN_FIELD_CONFLICT', 'Multiple generation output token fields conflict after custom-body merge.');
    if (present.length) {
      const field = present[0], n = read(field);
      if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > plan.effective.outputCap) fail('OUTPUT_CAP_CONFLICT', 'Final generation payload exceeds the requested/user output cap.');
      if (field !== r.tokenField) { remove(field); write(r.tokenField,n); }
    } else write(r.tokenField,plan.effective.outputCap);
    if (r.forcedReasoning && (p.thinking?.type === 'disabled' || p.reasoning?.effort === 'none' || p.reasoning_effort === 'none' || p.enable_thinking === false)) fail('FORCED_REASONING_CONFLICT', 'This route requires reasoning; disabling it is not a valid retry.');
    const effort = p.reasoning_effort ?? p.reasoning?.effort;
    if (effort != null && r.reasoningEfforts.length && !r.reasoningEfforts.includes(String(effort))) fail('UNSUPPORTED_EFFORT', 'Reasoning effort is not supported by this route.');
    if (r.fixedSampling) for (const field of ['temperature', 'top_p', 'n', 'presence_penalty', 'frequency_penalty']) delete p[field];
    if (p.stream === true && !r.streamingValidated) fail('UNVERIFIED_STREAM_ROUTE', 'Streaming requires a validated terminal-event route.');
    return p;
  };
  // Parse exactly one JSON object, optionally wrapped in one complete JSON fence.
  // Duplicate keys (including escaped aliases) and trailing text fail closed.
  const strictJsonObject = value => {
    let source=String(value??'').replace(/^\uFEFF/,'').trim();
    const fence=source.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i); if(fence)source=fence[1].trim();
    if(source.length>4194304)fail('JSON_TOO_LARGE','Structured artifact exceeds the parser limit.');
    let i=0,depth=0; const ws=()=>{while(/\s/.test(source[i]||'')&&i<source.length)i++;};
    const parseJsonString=()=>{const start=i++;let escaped=false;while(i<source.length){const c=source[i++];if(!escaped&&c==='"')return JSON.parse(source.slice(start,i));if(!escaped&&c==='\\')escaped=true;else escaped=false;}fail('INVALID_JSON','Unterminated JSON string.');};
    const parse=()=>{ws();if(++depth>128)fail('INVALID_JSON','JSON nesting limit exceeded.');let out;
      if(source[i]==='{'){i++;out={};const keys=new Set();ws();if(source[i]!=='}'){for(;;){ws();if(source[i]!=='"')fail('INVALID_JSON','Object key expected.');const key=parseJsonString();if(keys.has(key))fail('DUPLICATE_JSON_KEY','Duplicate JSON object key.');keys.add(key);ws();if(source[i++]!==':')fail('INVALID_JSON','Missing colon.');const v=parse();Object.defineProperty(out,key,{value:v,enumerable:true,writable:true,configurable:true});ws();if(source[i]===','){i++;continue;}break;}}if(source[i++]!=='}')fail('INVALID_JSON','Incomplete JSON object.');}
      else if(source[i]==='['){i++;out=[];ws();if(source[i]!==']'){for(;;){out.push(parse());ws();if(source[i]===','){i++;continue;}break;}}if(source[i++]!==']')fail('INVALID_JSON','Incomplete JSON array.');}
      else if(source[i]==='"')out=parseJsonString();
      else {const m=source.slice(i).match(/^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/);if(!m)fail('INVALID_JSON','Invalid JSON value.');out=JSON.parse(m[0]);if(typeof out==='number'&&!Number.isFinite(out))fail('INVALID_JSON','Non-finite JSON number.');i+=m[0].length;}
      depth--;return out;};
    const result=parse();ws();if(i!==source.length||!result||typeof result!=='object'||Array.isArray(result))fail('INVALID_JSON','Expected exactly one complete JSON object.');return result;
  };
  // Logical cancellation does not release the owner's physical promise/queue.
  const drainUnverifiedStream = async stream => {
    const reader=stream.getReader();let bytes=0,chunks=0;
    try { for(;;){const part=await reader.read();if(part.done)break;chunks++;bytes+=typeof part.value==='string'?utf8Bytes(part.value):Number(part.value?.byteLength||0);/* Never accumulate unverified content/reasoning. */} }
    finally{try{reader.releaseLock?.();}catch(_){}}
    fail('UNVERIFIED_STREAM_ROUTE','Host stream was drained without adoption because its terminal-event protocol is not verified.',{bytes,chunks});
  };
  const awaitPhysical = (physical, options={}) => new Promise((resolve,reject)=>{
    let done=false,timer=null; const cleanup=()=>{if(timer)clearTimeout(timer);options.signal?.removeEventListener?.('abort',abort);};
    const finish=(fn,value)=>{if(done)return;done=true;cleanup();fn(value);};
    const abandon=code=>{try{options.onAbandon?.(code);}catch(_){}finish(reject,new ContractError(code,'Host request outcome is still unknown; no automatic resubmission.'));};
    const abort=()=>abandon('OUTCOME_UNKNOWN_CANCELLED');
    Promise.resolve(physical).then(v=>{if(done){try{options.onLate?.(v,null);}catch(_){}return;}finish(resolve,v);},e=>{if(done){try{options.onLate?.(null,e);}catch(_){}return;}finish(reject,e);});
    if(options.signal?.aborted){abort();return;}options.signal?.addEventListener?.('abort',abort,{once:true});
    if(Number(options.deadlineAt)>0){const remaining=Number(options.deadlineAt)-Date.now();if(remaining<=0)abandon('OUTCOME_UNKNOWN_TIMEOUT');else timer=setTimeout(()=>abandon('OUTCOME_UNKNOWN_TIMEOUT'),remaining);}
  });
  const retryPermitted = (plan, envelope, reason = {}) => {
    if (plan.extraCalls !== 1 || reason.attempts >= plan.maxPhysicalCalls || reason.sourceCurrent !== true || reason.routeCurrent !== true || reason.remainingBudget !== true) return false;
    if (reason.cancelled || reason.refusal || reason.semanticFailure || reason.outcomeUnknown) return false;
    if (envelope.state === 'complete' && reason.structuralOnly === true) return true;
    return !plan.route.otherAx && envelope.state === 'truncated' && envelope.terminalObserved && reason.improvedEffectiveCap === true;
  };
  return Object.freeze({ VERSION, ContractError, stable, hash, dimension, resolvedDimension, sanitizedRoute, joinEndpoint, publicSemantics,
    embeddingDescriptor, authorityEpoch, cacheIdentity, vector, batch, indexed, pool, utf8Bytes, tokenBound, splitSource, inputLimits, makeBatches, validateEmbeddingPayload, createLedger,
    TASK_DEFAULTS, completion, routeCapability, invocationPlan, validatePayload, retryPermitted, strictJsonObject, awaitPhysical, drainUnverifiedStream,
    streamProtocol, receiveGenerationStream, normalizeGenerationPolicy, generationPolicyPreview, SAME_SPACE_REGISTRY, verifiedSameSpace, commitMetadataMigration });
})();
/* LIBRARIAN SYSTEM EXECUTION CONTRACT v1.1.0 — END */

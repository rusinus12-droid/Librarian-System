'use strict';
// Model context and transport bytes are different resources. This meter uses a
// disclosed text estimate, not an exact provider tokenizer or an owner receipt.
function createGradiaModelContextBudget({ digest }) {
  if (typeof digest !== 'function') throw new TypeError('GRADIA_MODEL_BUDGET_DIGEST_REQUIRED');
  const MAX_PAYLOAD_BYTES = 16 * 1024 * 1024;
  const MAX_EVIDENCE_BYTES = 4 * 1024 * 1024;
  const issued = new WeakMap();
  const stop = reason => { throw Object.assign(new TypeError(reason), { budgetReason: reason }); };
  const integer = n => Number.isSafeInteger(n) && n > 0;
  function fields(raw, required, optional = []) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)
      || ![null,Object.prototype].includes(Object.getPrototypeOf(raw))) stop('input_invalid');
    const copy = {};
    for (const key of Reflect.ownKeys(raw)) {
      if (typeof key !== 'string' || !required.includes(key) && !optional.includes(key)) stop('input_invalid');
      const descriptor = Object.getOwnPropertyDescriptor(raw,key);
      if (!descriptor || !Object.hasOwn(descriptor,'value')) stop('input_invalid');
      copy[key] = descriptor.value;
    }
    if (required.some(key=>!Object.hasOwn(copy,key))) stop('input_invalid');
    return copy;
  }
  function snapshot(raw) {
    const input = fields(raw,['providerId','modelId','routeIdentity','requestFormat','context','baseBody','finalBody','renderedEvidence','renderedByteLimit'],['payloadByteLimit']);
    input.context = fields(input.context,['source','limit','sourceIdentity','providerId','modelId','routeIdentity']);
    return input;
  }
  function utf8(value, limit = MAX_PAYLOAD_BYTES) {
    if (typeof value !== 'string') stop('unsupported_text');
    if (value.length > limit) stop('payload_budget_exceeded');
    let size = 0;
    for (let i = 0; i < value.length; i++) {
      const c = value.charCodeAt(i);
      if (c >= 0xd800 && c <= 0xdbff) {
        const next = value.charCodeAt(++i);
        if (!(next >= 0xdc00 && next <= 0xdfff)) stop('unsupported_text');
        size += 4;
      } else if (c >= 0xdc00 && c <= 0xdfff) stop('unsupported_text');
      else size += c < 0x80 ? 1 : c < 0x800 ? 2 : 3;
      if (size > limit) stop('payload_budget_exceeded');
    }
    return size;
  }
  function estimateTextTokens(value) {
    utf8(value);
    let ascii = 0, other = 0;
    for (const char of value) {
      const c = char.codePointAt(0);
      if (c < 128) ascii++;
      else other += c > 0xffff ? 2 : 1;
    }
    return Math.ceil(ascii / 3 + other);
  }
  function textSlot(container, key) {
    if (!container || typeof container[key] !== 'string') stop('payload_format_unsupported');
    return { container, key };
  }
  function contentSlots(message, field, partType) {
    if (typeof message?.[field] === 'string') return [textSlot(message, field)];
    const parts = message?.[field];
    if (!Array.isArray(parts) || !parts.length) stop('payload_format_unsupported');
    return parts.map(part => {
      if (!part || typeof part !== 'object' || partType && part.type !== partType
        || Object.keys(part).some(key => !['type', 'text'].includes(key))) stop('payload_format_unsupported');
      return textSlot(part, 'text');
    });
  }
  function parse(serialized, format, modelId, byteLimit) {
    const serializedBytes = utf8(serialized, byteLimit);
    let body;
    try { body = JSON.parse(serialized); } catch (_) { stop('payload_format_unsupported'); }
    if (!body || typeof body !== 'object' || Array.isArray(body) || JSON.stringify(body) !== serialized) stop('payload_format_unsupported');
    const slots = [], users = [];
    let output, messages;
    const ordinaryMessages = (rows, field, partType) => {
      if (!Array.isArray(rows) || !rows.length || rows.length > 128) stop('payload_format_unsupported');
      for (const message of rows) {
        if (!['system','developer','user'].includes(message?.role)) stop('payload_format_unsupported');
        const values = contentSlots(message, field, partType);
        slots.push(...values);
        if (message.role === 'user') users.push(...values);
      }
    };
    if (format === 'chat_completions' || format === 'ollama_native') {
      if (body.model !== modelId) stop('model_identity_changed');
      messages = body.messages;
      ordinaryMessages(messages, 'content', 'text');
      if (format === 'ollama_native') output = body.options?.num_predict;
      else {
        if (Object.hasOwn(body,'max_tokens') === Object.hasOwn(body,'max_completion_tokens')) stop('output_budget_unavailable');
        output = body.max_completion_tokens ?? body.max_tokens;
      }
    } else if (format === 'responses') {
      if (body.model !== modelId) stop('model_identity_changed');
      messages = body.input;
      ordinaryMessages(messages, 'content', 'input_text');
      if (body.instructions !== undefined) slots.push(textSlot(body,'instructions'));
      output = body.max_output_tokens;
    } else if (format === 'anthropic') {
      if (body.model !== modelId) stop('model_identity_changed');
      messages = body.messages;
      ordinaryMessages(messages, 'content', 'text');
      if (body.system !== undefined) slots.push(...contentSlots(body,'system','text'));
      output = body.max_tokens;
    } else if (format === 'gemini') {
      if (body.cachedContent) stop('payload_format_unsupported');
      messages = body.contents;
      ordinaryMessages(messages,'parts',null);
      if (body.systemInstruction) slots.push(...contentSlots(body.systemInstruction,'parts',null));
      output = body.generationConfig?.maxOutputTokens;
    } else stop('payload_format_unsupported');
    if (!integer(output) || output > 4000000 || !users.length) stop('output_budget_unavailable');
    // Count every decoded text and all remaining serialized fields, including
    // schemas, tool definitions, reasoning controls and native provider options.
    const texts = slots.map(slot => slot.container[slot.key]);
    for (const slot of slots) slot.container[slot.key] = '';
    const framing = estimateTextTokens(JSON.stringify(body)) + 32 + messages.length * 12;
    for (let i = 0; i < slots.length; i++) slots[i].container[slots[i].key] = texts[i];
    return { body, user:users.at(-1), output, serializedBytes,
      framing, inputTokens:texts.reduce((sum,value)=>sum+estimateTextTokens(value),framing) };
  }
  function replaceEvidence(serialized, format, modelId, oldBlock, newBlock) {
    const parsed = parse(serialized,format,modelId,MAX_PAYLOAD_BYTES);
    const slot = parsed.user, suffix = oldBlock ? '\n\n'+oldBlock : '';
    if (suffix && !slot.container[slot.key].endsWith(suffix)) stop('payload_binding_changed');
    const base = suffix ? slot.container[slot.key].slice(0,-suffix.length) : slot.container[slot.key];
    slot.container[slot.key] = base + (newBlock ? '\n\n'+newBlock : '');
    return JSON.stringify(parsed.body);
  }
  function inspect(raw) {
    try {
      const input = snapshot(raw);
      const { providerId, modelId, routeIdentity, requestFormat, context } = input;
      if (typeof providerId !== 'string' || !providerId || typeof modelId !== 'string' || !modelId
        || typeof routeIdentity !== 'string' || !/^https?:\/\//.test(routeIdentity)) stop('model_identity_changed');
      if (!context || !['configured','catalog','provider_default'].includes(context.source)
        || !integer(context.limit) || context.limit > 4000000
        || typeof context.sourceIdentity !== 'string' || !context.sourceIdentity
        || context.providerId !== providerId || context.modelId !== modelId
        || context.routeIdentity !== routeIdentity) stop('model_context_unavailable');
      const payloadByteLimit = input.payloadByteLimit ?? MAX_PAYLOAD_BYTES;
      if (!integer(payloadByteLimit) || payloadByteLimit > MAX_PAYLOAD_BYTES
        || !integer(input.renderedByteLimit) || input.renderedByteLimit > MAX_EVIDENCE_BYTES) stop('limits_invalid');
      const renderedEvidenceBytes = utf8(input.renderedEvidence,input.renderedByteLimit);
      const base = parse(input.baseBody,requestFormat,modelId,payloadByteLimit);
      const final = parse(input.finalBody,requestFormat,modelId,payloadByteLimit);
      if (replaceEvidence(input.finalBody,requestFormat,modelId,input.renderedEvidence,'') !== input.baseBody) stop('payload_binding_changed');
      const contextLimit = formatContextLimit(requestFormat, final.body, context.limit);
      const safetyMargin = Math.max(256,Math.ceil(contextLimit * 0.10));
      const fits = final.inputTokens + final.output + safetyMargin <= contextLimit;
      return Object.freeze({ status:'available', fits, reason:fits?'fit':'model_context_exceeded',
        usage:Object.freeze({ providerId,modelId,routeIdentity,requestFormat,
          contextLimit,contextSource:context.source,contextSourceIdentity:context.sourceIdentity,
          meterId:'gradia-model-context-unicode-estimate.v1',meterKind:'unicode-text-estimate-plus-framing',
          finalInputAllowance:final.inputTokens,baseInputAllowance:base.inputTokens,
          selectedContentTokenEstimate:Math.max(0,final.inputTokens-base.inputTokens),
          framingAllowance:final.framing,effectiveOutputReserve:final.output,safetyMargin,
          serializedPayloadBytes:final.serializedBytes,payloadByteLimit,renderedEvidenceBytes }) });
    } catch (error) { return Object.freeze({status:'unavailable',reason:error?.budgetReason||'input_invalid'}); }
  }
  function formatContextLimit(format, body, configured) {
    if (format === 'ollama_native' && body.options?.num_ctx !== undefined) {
      if (!integer(body.options.num_ctx)) stop('model_context_unavailable');
      return Math.min(configured,body.options.num_ctx);
    }
    return configured;
  }
  async function evaluate(raw) {
    let input;
    try { input=snapshot(raw); } catch (error) { return Object.freeze({status:'unavailable',reason:error?.budgetReason||'input_invalid'}); }
    const decision = inspect(input);
    if (decision.status !== 'available' || !decision.fits) return decision;
    // Capture before the digest await; caller mutation cannot reseal a body.
    const body = input.finalBody, record = Object.freeze({providerId:decision.usage.providerId,
      modelId:decision.usage.modelId,routeIdentity:decision.usage.routeIdentity,
      requestFormat:decision.usage.requestFormat,method:'POST',body});
    let hash;
    try { hash = await digest(body); } catch (_) { return Object.freeze({status:'unavailable',reason:'payload_hash_unavailable'}); }
    if (typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash)) return Object.freeze({status:'unavailable',reason:'payload_hash_unavailable'});
    const witness = Object.freeze({...decision.usage,finalPayloadHash:hash});
    issued.set(witness,record);
    return Object.freeze({...decision,witness});
  }
  function assertDispatch(witness, actual) {
    const record = witness && issued.get(witness);
    if (!record || !actual || Object.keys(record).some(key=>record[key] !== actual[key])) throw new TypeError('GRADIA_MODEL_BUDGET_DISPATCH_CHANGED');
    return true;
  }
  return Object.freeze({factoryVersion:'gradia.model-context-budget.v1',inspect,evaluate,assertDispatch,
    replaceEvidence,estimateTextTokens,maxPayloadBytes:MAX_PAYLOAD_BYTES,maxEvidenceBytes:MAX_EVIDENCE_BYTES});
}

'use strict';
// Pure, locally issued budget evidence. This is not owner authentication and is
// embedded into GRADIA runtime. Content is bounded; framing is an estimate.
function createGradiaEvidenceBudget({ digest }) {
  if (typeof digest !== 'function') throw new TypeError('GRADIA_V2_BUDGET_DIGEST_REQUIRED');
  const MODEL = 'gpt-4o-mini-2024-07-18';
  const ROUTE = 'https://api.openai.com/v1/chat/completions';
  const MAX_CONTEXT = 128000;
  const PROFILE = 'openai-gpt4omini-20240718-chattext-conservative.v1';
  const STRUCTURED_PROFILE = 'openai-gpt4omini-20240718-gradia-schema-conservative.v1';
  // Exact production wrappers for successful four/eight-stage profiles only.
  // Schema, names, descriptions and serialization changes require requalification.
  const STRUCTURED_SCHEMA_PINS = Object.freeze({
    "gradia_shadow_act_analysis": "eab576bde604cd1d0eea59d5982b15ec1330cb956aa398bf889ed1a2331d4360",
    "gradia_aide_character_analysis": "87ac9b6ae219a49caab8ad84861fcc9e101a40be2a890769d1f1791922e459f7",
    "gradia_aide_character_patch": "c75cefb3ee0a1c16f54d38b8bf6e07a2101b1a1a24108fa073f8bf825b9b921f",
    "gradia_aide_world_analysis": "a86eededd2d3d47680d13dd579641cb39f87031f3a37d2656ecaf0c94d069641",
    "gradia_aide_world_patch": "f28a548fd7e02c46cc6923abc3271dc6371919c8a6f60a795b1795783d6c345f",
    "gradia_aide_plot_analysis": "3927b606ab067bb9532b997bed89cd7ef0ec866d66b9a61c2e31e60cb2e87bfb",
    "gradia_aide_plot_patch": "917ba51651879ffe86dff333a0c80a6f5c19c213235ffa25beb4d146a518d7e1"
});
  const issued = new WeakMap();
  const stop = reason => { throw Object.assign(new TypeError(reason), { budgetReason: reason }); };
  const integer = (value, positive = false) => Number.isSafeInteger(value)
    && !Object.is(value, -0) && value >= (positive ? 1 : 0);
  const add = (left, right) => {
    if (!integer(left) || !integer(right) || right > Number.MAX_SAFE_INTEGER - left) stop('limits_invalid');
    return left + right;
  };
  function fields(raw, required, optional, reason) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) stop(reason);
    const proto = Object.getPrototypeOf(raw);
    if (proto !== null && proto !== Object.prototype) stop(reason);
    const keys = Reflect.ownKeys(raw);
    if (keys.length > required.length + optional.length) stop(reason);
    const out = Object.create(null);
    for (const key of keys) {
      if (typeof key !== 'string' || (!required.includes(key) && !optional.includes(key))) stop(reason);
      const descriptor = Object.getOwnPropertyDescriptor(raw, key);
      if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) stop(reason);
      out[key] = descriptor.value;
    }
    for (const key of required) if (!Object.hasOwn(out, key)) stop(reason);
    return out;
  }
  // No encoding buffer is allocated. Reject malformed text instead of silently
  // letting TextEncoder replace it. A cap bounds the scan and later JSON parse.
  function utf8(value, cap, overflow) {
    if (typeof value !== 'string') stop('input_invalid');
    if (value.length > cap) stop(overflow);
    let size = 0;
    for (let index = 0; index < value.length; index++) {
      const code = value.charCodeAt(index);
      if (code >= 0xd800 && code <= 0xdbff) {
        const low = value.charCodeAt(++index);
        if (!(low >= 0xdc00 && low <= 0xdfff)) stop('unsupported_text');
        size += 4;
      } else if (code >= 0xdc00 && code <= 0xdfff) stop('unsupported_text');
      else size += code < 0x80 ? 1 : code < 0x800 ? 2 : 3;
      if (size > cap) stop(overflow);
    }
    return size;
  }
  function capacity(raw, identity) {
    const value = fields(raw, ['source', 'limit', 'sourceIdentity', 'providerId', 'modelId', 'routeIdentity'], [], 'model_context_unavailable');
    if (!['configured', 'catalog'].includes(value.source) || !integer(value.limit, true)
      || value.providerId !== identity.providerId || value.modelId !== identity.modelId
      || value.routeIdentity !== identity.routeIdentity || typeof value.sourceIdentity !== 'string'
      || !value.sourceIdentity.trim() || value.sourceIdentity.length > 1024) stop('model_context_unavailable');
    utf8(value.sourceIdentity, 4096, 'model_context_unavailable');
    return { limit: Math.min(value.limit, MAX_CONTEXT), source: value.source, identity: value.sourceIdentity };
  }
  function payload(serialized) {
    let body;
    try { body = JSON.parse(serialized); } catch (_) { stop('payload_format_unsupported'); }
    // Actual builder serialization round-trips exactly. This rejects duplicate
    // keys, whitespace and alternate encodings instead of interpreting ambiguity.
    if (JSON.stringify(body) !== serialized) stop('payload_format_unsupported');
    const value = fields(body, ['model', 'messages', 'temperature', 'stream'], ['max_tokens', 'max_completion_tokens', 'stream_options', 'response_format'], 'token_accounting_unavailable');
    if (value.model !== MODEL || typeof value.stream !== 'boolean'
      || typeof value.temperature !== 'number' || !Number.isFinite(value.temperature)
      || value.temperature < 0 || value.temperature > 2 || Object.is(value.temperature, -0)) stop('token_accounting_unavailable');
    const hasTokens = Object.hasOwn(value, 'max_tokens'), hasCompletion = Object.hasOwn(value, 'max_completion_tokens');
    if (hasTokens === hasCompletion) stop('token_accounting_unavailable');
    const output = hasTokens ? value.max_tokens : value.max_completion_tokens;
    if (!integer(output, true) || output > 16384) stop('token_accounting_unavailable');
    if (Object.hasOwn(value, 'stream_options')) {
      const stream = fields(value.stream_options, ['include_usage'], [], 'token_accounting_unavailable');
      if (!value.stream || stream.include_usage !== true) stop('token_accounting_unavailable');
    }
    if (!Array.isArray(value.messages) || value.messages.length < 1 || value.messages.length > 3) stop('token_accounting_unavailable');
    let content = 0;
    for (let index = 0; index < value.messages.length; index++) {
      const message = fields(value.messages[index], ['role', 'content'], [], 'token_accounting_unavailable');
      if (message.role !== (index === value.messages.length - 1 ? 'user' : 'system')
        || typeof message.content !== 'string') stop('token_accounting_unavailable');
      content = add(content, utf8(message.role, MAX_CONTEXT, 'payload_budget_exceeded'));
      content = add(content, utf8(message.content, MAX_CONTEXT, 'payload_budget_exceeded'));
    }
    let structuredName = '', structuredSerialized = '', structuredBytes = 0;
    if (Object.hasOwn(value, 'response_format')) {
      const format = fields(value.response_format, ['type', 'json_schema'], [], 'token_accounting_unavailable');
      const schema = fields(format.json_schema, ['name', 'strict', 'schema'], [], 'token_accounting_unavailable');
      if (format.type !== 'json_schema' || schema.strict !== true || typeof schema.name !== 'string'
        || !Object.hasOwn(STRUCTURED_SCHEMA_PINS, schema.name) || !schema.schema
        || typeof schema.schema !== 'object' || Array.isArray(schema.schema)) stop('token_accounting_unavailable');
      structuredName = schema.name;
      structuredSerialized = JSON.stringify(value.response_format);
      structuredBytes = utf8(structuredSerialized, MAX_CONTEXT, 'payload_budget_exceeded');
    }
    return { body, content, output, structuredName, structuredSerialized, structuredBytes };
  }
  function sameBase(base, final, evidence) {
    const left = base.body, right = final.body;
    const keys = Object.keys(left);
    if (keys.length !== Object.keys(right).length || left.messages.length !== right.messages.length) stop('payload_binding_changed');
    for (const key of keys) {
      if (key !== 'messages' && JSON.stringify(left[key]) !== JSON.stringify(right[key])) stop('payload_binding_changed');
    }
    for (let index = 0; index < left.messages.length; index++) {
      const original = left.messages[index], current = right.messages[index];
      const suffix = index === left.messages.length - 1 && evidence ? '\n\n' + evidence : '';
      if (original.role !== current.role || current.content !== original.content + suffix) stop('payload_binding_changed');
    }
  }
  async function evaluate(raw) {
    try {
      const input = fields(raw, ['providerId', 'modelId', 'routeIdentity', 'requestFormat', 'context', 'baseBody', 'finalBody', 'renderedEvidence', 'renderedByteLimit'], [], 'input_invalid');
      if (input.providerId !== 'openai' || input.modelId !== MODEL || input.routeIdentity !== ROUTE || input.requestFormat !== 'chat_completions') stop('token_accounting_unavailable');
      const context = capacity(input.context, input);
      if (!integer(input.renderedByteLimit, true) || input.renderedByteLimit > 4194304) stop('limits_invalid');
      const evidenceBytes = utf8(input.renderedEvidence, input.renderedByteLimit, 'rendered_budget_exceeded');
      // Check both immutable bodies before parsing either, including JSON escaping.
      utf8(input.baseBody, MAX_CONTEXT, 'payload_budget_exceeded');
      const serializedBytes = utf8(input.finalBody, MAX_CONTEXT, 'payload_budget_exceeded');
      const base = payload(input.baseBody), final = payload(input.finalBody);
      sameBase(base, final, input.renderedEvidence);
      if (!input.renderedEvidence && input.baseBody !== input.finalBody) stop('payload_binding_changed');
      const selectedContent = input.renderedEvidence ? add(2, evidenceBytes) : 0;
      if (final.content !== add(base.content, selectedContent)) stop('payload_binding_changed');
      let structuredSchemaSha256 = null;
      if (final.structuredBytes) {
        try { structuredSchemaSha256 = await digest(final.structuredSerialized); }
        catch (_) { stop('payload_hash_unavailable'); }
        if (structuredSchemaSha256 !== STRUCTURED_SCHEMA_PINS[final.structuredName]) stop('token_accounting_unavailable');
      }
      // The raw envelope already charges the schema once. Reserve its complete
      // UTF-8 wrapper again for structured framing; this remains a conservative
      // engineering estimate, not a provider tokenizer or server-internals proof.
      const framing = add(Math.max(3 * final.body.messages.length + 3, serializedBytes - final.content, 0), final.structuredBytes);
      const allowance = add(final.content, framing), margin = Math.max(1024, Math.ceil(context.limit * 0.05));
      const fits = add(add(allowance, final.output), margin) <= context.limit;
      const witnessFields = { providerId: input.providerId, modelId: input.modelId, routeIdentity: input.routeIdentity,
        requestFormat: input.requestFormat, contextLimit: context.limit, contextSource: context.source,
        contextSourceIdentity: context.identity, meterId: final.structuredBytes ? STRUCTURED_PROFILE : PROFILE, meterVersion: 1,
        meterKind: 'content-bound-plus-framing-estimate', baseContentTokenBound: base.content,
        framingAllowance: framing, effectiveOutputReserve: final.output, explicitReasoningReserve: 0,
        safetyMargin: margin, selectedContentTokenBound: selectedContent,
        renderedEvidenceBytes: evidenceBytes, finalInputAllowance: allowance,
        ...(final.structuredBytes ? { structuredSchemaName: final.structuredName, structuredSchemaSha256, structuredSchemaByteAllowance: final.structuredBytes } : {}) };
      // Only already captured primitives survive the await; caller mutations cannot
      // replace the body or envelope. The adapter owns cancellation/generation.
      const body = input.finalBody;
      let hash;
      try { hash = await digest(body); } catch (_) { stop('payload_hash_unavailable'); }
      if (typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash)) stop('payload_hash_unavailable');
      const witness = Object.freeze({ ...witnessFields, finalPayloadHash: hash });
      if (fits) issued.set(witness, Object.freeze({ providerId: witness.providerId, modelId: witness.modelId,
        routeIdentity: witness.routeIdentity, requestFormat: witness.requestFormat, method: 'POST', body }));
      return Object.freeze({ status: 'available', fits, reason: fits ? 'fit' : 'model_context_exceeded', witness });
    } catch (error) {
      return Object.freeze({ status: 'unavailable', reason: error?.budgetReason || 'input_invalid' });
    }
  }
  function assertDispatch(witness, raw) {
    const record = witness && typeof witness === 'object' ? issued.get(witness) : null;
    if (!record) throw new TypeError('GRADIA_V2_BUDGET_WITNESS_UNISSUED');
    let input;
    try { input = fields(raw, ['providerId', 'modelId', 'routeIdentity', 'requestFormat', 'method', 'body'], [], 'dispatch_invalid'); }
    catch (_) { throw new TypeError('GRADIA_V2_BUDGET_DISPATCH_CHANGED'); }
    for (const key of Object.keys(record)) if (input[key] !== record[key]) throw new TypeError('GRADIA_V2_BUDGET_DISPATCH_CHANGED');
    return true;
  }
  return Object.freeze({ factoryVersion: 'gradia.evidence-budget.v2', evaluate, assertDispatch });
}

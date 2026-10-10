'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createMeter, request, transformBoth, envelope, sha, MODEL, ROUTE } = require('./fixtures/gradia-budget-profile.cjs');
const bytes = text => Buffer.byteLength(text, 'utf8');
const contentBound = body => JSON.parse(body).messages.reduce((n, message) => n + bytes(message.role) + bytes(message.content), 0);
const unavailable = async (input, reason) => { const result = await createMeter().evaluate(input); assert.equal(result.status, 'unavailable'); if (reason) assert.equal(result.reason, reason); return result; };

test('named profile admits nonzero evidence and reserves all 16384 output tokens with dated framing label', async () => {
  const input = request(), meter = createMeter(), result = await meter.evaluate(input), w = result.witness;
  assert.equal(result.status, 'available'); assert.equal(result.fits, true);
  assert.equal(w.meterId, 'openai-gpt4omini-20240718-chattext-conservative.v1');
  assert.equal(w.meterKind, 'content-bound-plus-framing-estimate');
  assert.equal(w.contextSource, 'configured'); assert.equal(w.contextLimit, 128000);
  assert.equal(w.effectiveOutputReserve, 16384); assert.equal(w.explicitReasoningReserve, 0); assert.equal(w.safetyMargin, 6400);
  assert.equal(w.baseContentTokenBound, contentBound(input.baseBody));
  assert.equal(w.selectedContentTokenBound, bytes('\n\n' + input.renderedEvidence));
  assert.equal(w.renderedEvidenceBytes, bytes(input.renderedEvidence));
  const bound = contentBound(input.finalBody);
  assert.equal(w.framingAllowance, Math.max(9, bytes(input.finalBody) - bound));
  assert.equal(w.finalInputAllowance, bound + w.framingAllowance); assert.equal(w.finalPayloadHash, sha(input.finalBody));
  assert.equal(meter.assertDispatch(w, envelope(input)), true);
  assert.ok(Object.isFrozen(result)); assert.ok(Object.isFrozen(w)); assert.ok(!JSON.stringify(w).includes('COMPLETE_OWNER_ITEM'));
});

test('exact allowance fits and one additional ASCII byte fails without issuing dispatch authority', async () => {
  let input = request({ context: 20000, output: 1000, evidence: 'x' });
  const first = await createMeter().evaluate(input), remaining = 20000 - 1024 - 1000 - first.witness.finalInputAllowance;
  input = request({ context: 20000, output: 1000, evidence: 'x'.repeat(remaining + 1) });
  const meter = createMeter(), fit = await meter.evaluate(input);
  assert.equal(fit.fits, true); assert.equal(fit.witness.finalInputAllowance + 1000 + 1024, 20000);
  const over = await meter.evaluate(request({ context: 20000, output: 1000, evidence: 'x'.repeat(remaining + 2) }));
  assert.equal(over.status, 'available'); assert.equal(over.fits, false); assert.equal(over.reason, 'model_context_exceeded');
  assert.throws(() => meter.assertDispatch(over.witness, envelope(input)), /WITNESS/);
});

test('context rejects blank stale catalog identity and preserves configured versus catalog provenance', async () => {
  const input = request(); input.context.source = 'catalog'; input.context.sourceIdentity = 'catalog:fixture-7';
  const good = await createMeter().evaluate(input); assert.equal(good.fits, true); assert.equal(good.witness.contextSource, 'catalog');
  for (const field of ['modelId', 'providerId', 'routeIdentity', 'sourceIdentity']) for (const value of ['', 'stale-value']) {
    if (field === 'sourceIdentity' && value) continue;
    await unavailable({ ...input, context: { ...input.context, [field]: value } }, 'model_context_unavailable');
  }
  for (const limit of [0, -0, -1, 2.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '128000']) await unavailable({ ...input, context: { ...input.context, limit } }, 'model_context_unavailable');
  const capped = await createMeter().evaluate({ ...input, context: { ...input.context, limit: 4000000 } }); assert.equal(capped.witness.contextLimit, 128000);
});

test('unknown provider model format or exact route is unavailable', async () => {
  for (const [key, value] of [['providerId', 'custom'], ['modelId', 'gpt-4o-mini'], ['routeIdentity', ROUTE + '?proxy=1'], ['routeIdentity', ROUTE + '/'], ['routeIdentity', 'https://proxy.invalid/v1/chat/completions'], ['requestFormat', 'responses']]) await unavailable({ ...request(), [key]: value }, 'token_accounting_unavailable');
});

test('actual output requires one positive safe integer up to 16384 with no silent cap', async () => {
  for (const value of [0, -0, -1, 1.2, NaN, Infinity, 16385, '16384']) await unavailable(transformBoth(request(), b => ({ ...b, max_completion_tokens: value })), 'token_accounting_unavailable');
  await unavailable(transformBoth(request(), b => ({ ...b, max_tokens: 1000 })), 'token_accounting_unavailable');
  const alternate = transformBoth(request(), b => { b.max_tokens = b.max_completion_tokens; delete b.max_completion_tokens; return b; });
  assert.equal((await createMeter().evaluate(alternate)).witness.effectiveOutputReserve, 16384);
});

test('unqualified request fields and message structures are rejected rather than removed', async () => {
  for (const field of ['response_format', 'tools', 'reasoning', 'reasoning_effort', 'service_tier', 'prompt_cache_key', 'arbitrary']) await unavailable(transformBoth(request(), b => ({ ...b, [field]: {} })), 'token_accounting_unavailable');
  for (const change of [b => { b.messages[0].name = 'named'; return b; }, b => { b.messages[0].role = 'developer'; return b; }, b => { b.messages[1].content = [{ type: 'text', text: 'multipart' }]; return b; }, b => { b.messages.push({ role: 'assistant', content: 'prefill' }); return b; }]) await unavailable(transformBoth(request(), change), 'token_accounting_unavailable');
});

test('supported stream options are counted and unknown variants fail', async () => {
  const input = transformBoth(request(), b => ({ ...b, stream: true, stream_options: { include_usage: true } }));
  const result = await createMeter().evaluate(input); assert.equal(result.fits, true); assert.ok(result.witness.finalInputAllowance >= bytes(input.finalBody));
  await unavailable(transformBoth(request(), b => ({ ...b, stream_options: { include_usage: true } })), 'token_accounting_unavailable');
  await unavailable(transformBoth(request(), b => ({ ...b, stream: true, stream_options: { include_usage: true, unknown: true } })), 'token_accounting_unavailable');
});

test('Unicode and escaped text use independently measured serialized overhead', async () => {
  for (const text of ['가나다漢字', '😀🚀', 'e\u0301', '\u0000\n\r\t"\\', '\u2028\u2029', '<>{}[]&']) {
    const input = request({ evidence: text.repeat(11), system: text, user: text + ' previous draft' });
    const result = await createMeter().evaluate(input); assert.equal(result.fits, true);
    assert.equal(result.witness.renderedEvidenceBytes, bytes(input.renderedEvidence));
    assert.equal(result.witness.finalInputAllowance, Math.max(bytes(input.finalBody), contentBound(input.finalBody) + 9));
  }
});

test('malformed surrogate evidence native text and raw body are never normalized', async () => {
  for (const text of ['\ud800', '\udfff', '\ud800a', 'a\udfff']) {
    await unavailable(request({ evidence: text }), 'unsupported_text');
    await unavailable(request({ user: text }), 'unsupported_text');
    const input = request(); input.finalBody += text; await unavailable(input, 'unsupported_text');
  }
});

test('large native input and previous draft consume capacity with tiny evidence', async () => {
  const input = request({ context: 20000, output: 1000, user: 'PREVIOUS_DRAFT '.repeat(1800), evidence: 'one' });
  const result = await createMeter().evaluate(input); assert.equal(result.status, 'available'); assert.equal(result.fits, false); assert.ok(result.witness.baseContentTokenBound > 20000);
});

test('preflight rejects long or escape-expanded bodies before JSON.parse and digest', async () => {
  let hashes = 0; const meter = createMeter(() => { hashes++; return 'a'.repeat(64); });
  for (const input of [{ ...request(), finalBody: ' '.repeat(128001) }, request({ evidence: '\u0000'.repeat(22000) })]) {
    let parses = 0; const original = JSON.parse;
    try { JSON.parse = function (...args) { parses++; return original.apply(this, args); }; const result = await meter.evaluate(input); assert.equal(result.status, 'unavailable'); assert.equal(result.reason, 'payload_budget_exceeded'); }
    finally { JSON.parse = original; }
    assert.equal(parses, 0); assert.equal(hashes, 0);
  }
});

test('rendered cap is strict and configurable only through 4 MiB', async () => {
  const input = request({ evidence: 'abc' }); input.renderedByteLimit = 3; assert.equal((await createMeter().evaluate(input)).fits, true);
  await unavailable({ ...input, renderedByteLimit: 2 }, 'rendered_budget_exceeded');
  for (const limit of [0, -0, -1, 1.2, NaN, Infinity, 4194305, '262144']) await unavailable({ ...input, renderedByteLimit: limit }, 'limits_invalid');
  assert.equal((await createMeter().evaluate({ ...input, renderedByteLimit: 4194304 })).fits, true);
});

test('mutated native policy user output and request parameters fail exact base binding', async () => {
  for (const modify of [b => { b.messages[0].content += 'MUTATED'; }, b => { b.messages[1].content = 'replaced\n\n' + request().renderedEvidence; }, b => { b.max_completion_tokens = 1000; }, b => { b.temperature = 0.7; }]) {
    const input = request(), final = JSON.parse(input.finalBody); modify(final); input.finalBody = JSON.stringify(final); await unavailable(input, 'payload_binding_changed');
  }
  const input = request(); input.finalBody += ' '; await unavailable(input, 'payload_format_unsupported');
  input.finalBody = input.baseBody.replace('{', '{"model":"duplicate",'); await unavailable(input, 'payload_format_unsupported');
});

test('only private original fitting witness authorizes an identical POST dispatch envelope', async () => {
  const input = request(), meter = createMeter(), result = await meter.evaluate(input), w = result.witness;
  assert.equal(meter.assertDispatch(w, envelope(input)), true);
  for (const witness of [{ ...w }, { ...w, finalPayloadHash: 'a'.repeat(64) }, Object.freeze({ ...w }), null]) assert.throws(() => meter.assertDispatch(witness, envelope(input)), /WITNESS/);
  assert.throws(() => createMeter().assertDispatch(w, envelope(input)), /WITNESS/);
  for (const [key, value] of [['body', input.finalBody + ' '], ['modelId', 'other'], ['routeIdentity', ROUTE + '?changed'], ['method', 'GET'], ['providerId', 'custom'], ['requestFormat', 'responses']]) assert.throws(() => meter.assertDispatch(w, { ...envelope(input), [key]: value }), /DISPATCH/);
});

test('async local digest snapshots body context and envelope before awaiting caller mutation', async () => {
  let release; const meter = createMeter(value => new Promise(resolve => { release = () => resolve(sha(value)); }));
  const input = request(), original = structuredClone(input), pending = meter.evaluate(input);
  input.finalBody = request({ evidence: 'changed' }).finalBody; input.context.limit = 1;
  release(); const result = await pending; assert.equal(result.fits, true); assert.equal(result.witness.finalPayloadHash, sha(original.finalBody)); assert.equal(meter.assertDispatch(result.witness, envelope(original)), true);
  assert.throws(() => meter.assertDispatch(result.witness, envelope(input)), /DISPATCH/);
});

test('accessors and custom input or context prototypes fail without invoking getters', async () => {
  const input = request(); let getters = 0; Object.defineProperty(input, 'finalBody', { enumerable: true, get() { getters++; return '{}'; } });
  await unavailable(input, 'input_invalid'); assert.equal(getters, 0);
  await unavailable(Object.assign(Object.create({}), request()), 'input_invalid');
  const other = request(); other.context = Object.assign(Object.create({}), other.context); await unavailable(other, 'model_context_unavailable');
});

test('empty selection preserves native body and invalid or failed digest cannot issue authority', async () => {
  const input = request({ evidence: '' }), good = await createMeter().evaluate(input); assert.equal(good.fits, true); assert.equal(good.witness.selectedContentTokenBound, 0);
  for (const digest of [() => 'bad', () => Promise.reject(new Error('offline digest failure'))]) { const result = await createMeter(digest).evaluate(request()); assert.equal(result.status, 'unavailable'); assert.equal(result.reason, 'payload_hash_unavailable'); }
});

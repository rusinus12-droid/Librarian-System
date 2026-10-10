'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { createMeter, sha, MODEL, ROUTE, envelope } = require('./fixtures/gradia-budget-profile.cjs');
async function loadBuilder() {
  const fixture = path.join(__dirname, 'fixtures/gradia-builder-budget-host.cjs');
  assert.ok(fs.existsSync(fixture), 'actual unchanged GRADIA builder fixture must exist');
  return require(fixture).loadBuilder();
}
test('actual SHADOW plain-text builder plus real meter admits evidence and asserts prepared envelope locally', async () => {
  const fixture = await loadBuilder();
  const input = fixture.prepare({ evidence: 'OWNER_COMPLETE_UNIT 😀 history', options: { maxTokens: 16384, promptPhase: 'draft', promptCacheDisabled: true } });
  const meter = createMeter(), result = await meter.evaluate(input);
  assert.equal(result.status, 'available'); assert.equal(result.fits, true); assert.equal(result.witness.effectiveOutputReserve, 16384);
  assert.equal(result.witness.finalPayloadHash, sha(input.finalBody)); assert.equal(result.witness.renderedEvidenceBytes, Buffer.byteLength(input.renderedEvidence));
  assert.equal(result.witness.meterKind, 'content-bound-plus-framing-estimate');
  const captured = [];
  if (meter.assertDispatch(result.witness, envelope(input))) captured.push(Object.freeze(envelope(input)));
  assert.equal(captured.length, 1); assert.equal(captured[0].body, input.finalBody);
  assert.equal(fixture.networkCalls(), 0); assert.equal(fixture.sourceHash, '281d0ca7c8c3fd7d39239387b3f8a0b5d6fcadd217a968b2e1ff5b3fc374a99c');
});
test('actual shared-prefix and streaming fields fit without omitting their final payload cost', async () => {
  const f = await loadBuilder();
  for (const stream of [false, true]) {
    const input = f.prepare({ preset: { stream }, evidence: 'hist\u0000ory漢字', system: 'Native policy', user: 'Current input and previous draft', options: { sharedPromptPrefix: 'SHARED CBS source 😀', promptCacheDisabled: true, maxTokens: 1000 } });
    const body = JSON.parse(input.finalBody); assert.equal(body.messages.length, 3);
    assert.equal(body.messages[0].content, 'SHARED CBS source 😀');
    const result = await createMeter().evaluate(input); assert.equal(result.fits, true);
    assert.equal(result.witness.effectiveOutputReserve, body.max_completion_tokens ?? body.max_tokens);
    assert.ok(result.witness.finalInputAllowance >= Buffer.byteLength(input.finalBody));
    if (stream) assert.deepEqual(body.stream_options, { include_usage: true });
  }
  assert.equal(f.networkCalls(), 0);
});
test('actual structured AIDE formats remain unsupported instead of disabling structured output', async () => {
  const f = await loadBuilder();
  for (const options of [{ jsonMode: true }, { jsonMode: true, jsonSchema: { type: 'object', properties: { result: { type: 'string' } }, required: ['result'], additionalProperties: false } }]) {
    const input = f.prepare({ options }); assert.ok(JSON.parse(input.finalBody).response_format);
    const result = await createMeter().evaluate(input); assert.equal(result.status, 'unavailable'); assert.equal(result.reason, 'token_accounting_unavailable');
  }
  assert.equal(f.networkCalls(), 0);
});
test('actual Responses builder custom endpoint and extra-body transforms are unqualified', async () => {
  const f = await loadBuilder();
  for (const configuration of [{ format: 'responses' }, { preset: { provider: 'custom', url: 'https://proxy.invalid/v1/chat/completions' } }, { preset: { extra_body_json: '{"tools":[]}' } }, { preset: { extra_body_json: '{"messages":[{"role":"user","content":"replaced"}]}' } }]) {
    const input = f.prepare(configuration), result = await createMeter().evaluate(input);
    assert.equal(result.status, 'unavailable');
    assert.ok(['token_accounting_unavailable', 'payload_binding_changed'].includes(result.reason));
  }
  assert.equal(f.networkCalls(), 0);
});
test('actual output override is measured and over-limit output or reasoning fields reject', async () => {
  const f = await loadBuilder();
  const accepted = f.prepare({ preset: { max_tokens: 1000 }, options: { maxTokens: 12000, promptCacheDisabled: true } });
  const result = await createMeter().evaluate(accepted); assert.equal(result.fits, true); assert.equal(result.witness.effectiveOutputReserve, 1000);
  const larger = await createMeter().evaluate(f.prepare({ preset: { max_tokens: 16000 }, options: { maxTokens: 12000 } }));
  assert.equal(larger.witness.effectiveOutputReserve, 12000);
  for (const config of [{ preset: { max_tokens: 16385 }, options: { maxTokens: 16385 } }, { preset: { reasoning_preset: 'auto', reasoning_effort: 'high', reasoning_budget_tokens: 5000 } }]) {
    const input = f.prepare(config), decision = await createMeter().evaluate(input);
    assert.equal(decision.status, 'unavailable'); assert.equal(decision.reason, 'token_accounting_unavailable');
  }
  assert.equal(f.networkCalls(), 0);
});
test('unknown cache/service fields produced by actual builder cannot silently enter supported profile', async () => {
  const f = await loadBuilder();
  for (const config of [{ options: { sharedPromptPrefix: 'Shared prefix', promptCacheDisabled: false } }, { preset: { service_tier: 'flex' } }]) {
    const input = f.prepare(config); const result = await createMeter().evaluate(input);
    assert.equal(result.status, 'unavailable'); assert.equal(result.reason, 'token_accounting_unavailable');
  }
});
test('pinned local vocabulary has all 256 single-byte symbols without loading a tokenizer', async () => {
  const root = path.join(__dirname, './fixtures/vendor/risuai');
  const tokenizer = fs.readFileSync(path.join(root, 'src/ts/tokenizer.ts'));
  const vocabularyBytes = fs.readFileSync(path.join(root, 'src/etc/o200k_base.json'));
  assert.equal(sha(tokenizer), 'ac4abc333a1497ed5260f3dfab52b3dc65c8a964b5dc38272e8d17125259b0cc');
  assert.equal(sha(vocabularyBytes), 'a2c363f80642c0f07d916716b3940ff030121f3b5cef72b2c5bd1d4f64c14fb8');
  const words = JSON.parse(vocabularyBytes).bpe_ranks.trim().split(/\s+/), single = new Set();
  for (let index = 0; index < words.length; index++) {
    if (words[index] === '!') { index++; continue; }
    const value = Buffer.from(words[index], 'base64');
    assert.equal(value.toString('base64'), words[index], 'encoded rank must round-trip base64');
    if (value.length === 1) single.add(value[0]);
  }
  assert.equal(single.size, 256); for (let byte = 0; byte < 256; byte++) assert.ok(single.has(byte));
});

test('allowed-shaped extra-body override exposes a provenance limit of the pure meter, not runtime qualification', async () => {
  const f = await loadBuilder();
  const input = f.prepare({ preset: { extra_body_json: '{"temperature":0.2}' } });
  assert.equal(JSON.parse(input.finalBody).temperature, 0.2);
  // Origin is intentionally not fabricated: a body-only meter can measure this
  // payload but cannot prove that it came from an unmodified supported preset.
  // The future runtime adapter must reject nonempty extra-body configuration.
  const result = await createMeter().evaluate(input);
  assert.equal(result.status, 'available'); assert.equal(result.fits, true);
  assert.equal(result.witness.finalPayloadHash, sha(input.finalBody));
  assert.equal(f.networkCalls(), 0);
});

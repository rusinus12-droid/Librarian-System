'use strict';
const assert = require('node:assert/strict');
const { load } = require('../host.cjs');
const { sha, MODEL } = require('./gradia-budget-profile.cjs');
const SOURCE_HASH = '281d0ca7c8c3fd7d39239387b3f8a0b5d6fcadd217a968b2e1ff5b3fc374a99c';
async function loadBuilder() {
  const sink = {};
  const host = await load({
    // Only expose existing functions from the unchanged source. This is not a
    // runtime integration or a reimplementation of the provider payload builder.
    sourceFile: require('node:path').join(__dirname, './baselines/frozen-G2-GRADIA.js'),
    testGlobals: { __g2BuilderSink: sink },
    transformSource(source) {
      assert.equal(sha(source), SOURCE_HASH);
      const marker = '  const publicApi = Object.freeze({';
      assert.equal(source.split(marker).length, 2);
      return source.replace(marker, '  Object.assign(globalThis.__g2BuilderSink, { sanitizePreset, buildOpenAICompatPayload, buildOpenAIResponsesPayload, normalizeOpenAICompatUrl });\n' + marker);
    }
  });
  function prepare({ preset: raw = {}, options = {}, evidence = 'complete source evidence', system = 'SHADOW plain-text native system policy', user = 'Current input plus complete previous draft', format = 'chat_completions' } = {}) {
    const preset = sink.sanitizePreset({ provider: 'openai', url: 'https://api.openai.com/v1/chat/completions', model: MODEL, context_window: 128000, max_tokens: 16384, reasoning_preset: 'off', reasoning_effort: 'none', stream: false, ...raw, request_format: format });
    const settings = { promptPhase: 'draft', promptCacheDisabled: true, ...options };
    const builder = format === 'responses' ? sink.buildOpenAIResponsesPayload : sink.buildOpenAICompatPayload;
    const base = builder(preset, system, user, settings);
    const final = builder(preset, system, evidence ? user + '\n\n' + evidence : user, settings);
    const route = format === 'responses' ? 'https://api.openai.com/v1/responses' : sink.normalizeOpenAICompatUrl(preset.url, preset.provider);
    return { providerId: preset.provider, modelId: preset.model, routeIdentity: route, requestFormat: format,
      context: { source: 'configured', limit: preset.context_window, sourceIdentity: 'configured:actual-builder-offline-fixture', providerId: preset.provider, modelId: preset.model, routeIdentity: route },
      baseBody: JSON.stringify(base), finalBody: JSON.stringify(final), renderedEvidence: evidence, renderedByteLimit: 262144 };
  }
  return Object.freeze({ prepare, networkCalls: host.getCalls, sourceHash: SOURCE_HASH });
}
module.exports = { loadBuilder };

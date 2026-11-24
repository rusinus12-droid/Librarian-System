'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const PLUGINS = path.resolve(__dirname, '../plugins');

test('Stage 1A: GRADIA Gemini explicit cache includes systemInstruction on create, omits it on generateContent, and backs off on 400', () => {
  const src = fs.readFileSync(path.join(PLUGINS, 'GRADIA.js'), 'utf8');
  assert.match(src, /const geminiExplicitCacheDescriptor = \(preset = \{\}, mode = 'gemini', options = \{\}, systemPrompt = ''\)/);
  assert.match(src, /const createGeminiExplicitCache = async[\s\S]{0,600}\.\.\.\(descriptor\.systemPrompt \? \{ systemInstruction: \{ parts: \[\{ text: descriptor\.systemPrompt \}\] \} \} : \{\}\)/);
  assert.match(src, /const buildGeminiRequestBody = [\s\S]{0,600}systemInstruction: cachedContent \? undefined : \(systemParts\.length \? \{ parts: systemParts \} : undefined\)/);
  assert.match(src, /invalidateGeminiExplicitCache\(descriptor, cacheError\.message, true\)/);
  assert.match(src, /const rememberGradiaContinuityChecked = \(scopeKey, result\)/);
});

test('Stage 1B: GRADIA & LIBRA AI transport hardens SSE delta dedup, dangerous keys, Vertex header order, and post-extra temperature stripping', () => {
  for (const file of ['GRADIA.js', 'LIBRA.js']) {
    const src = fs.readFileSync(path.join(PLUGINS, file), 'utf8');
    const idx = src.indexOf('const parseStreamText =');
    assert.ok(idx >= 0, file + ' parseStreamText');
    const endIdx = src.indexOf('const applyPresetExtraBody', idx);
    assert.ok(endIdx > idx, file + ' applyPresetExtraBody');
    const snippet = src.slice(idx, endIdx);
    const ctx = vm.createContext({ text: v => String(v ?? ''), tryJsonParse: (s, fb) => { try { return JSON.parse(s); } catch { return fb; } }, providerFinishReason: () => '' });
    vm.runInContext(snippet + ';globalThis.exports={parseStreamText,deepMergeJson,normalizeExtraHeaders};', ctx);
    const sse = [
      'data: {"choices":[{"delta":{"content":"Hello "}}]}',
      'data: {"choices":[{"delta":{"content":"World"},"message":{"content":"Hello World"}}]}',
      'data: [DONE]'
    ].join('\n');
    const streamed = ctx.exports.parseStreamText(sse, 'openai');
    assert.equal(streamed.content, 'Hello World', file + ': cumulative message.content after delta must not double');
    const merged = ctx.exports.deepMergeJson({ safe: 1 }, JSON.parse('{"__proto__":{"polluted":true},"nested":{"constructor":"bad","ok":2}}'));
    assert.equal(({}).polluted, undefined);
    assert.equal(merged.nested.ok, 2);
    assert.equal(Object.hasOwn(merged.nested, 'constructor'), false);
    const headers = ctx.exports.normalizeExtraHeaders({ extra_headers_json: '{"__proto__":"x","X-Test":"1"}' });
    assert.equal(Object.hasOwn(headers, '__proto__'), false);
    assert.equal(headers['X-Test'], '1');
  }
  const gradia = fs.readFileSync(path.join(PLUGINS, 'GRADIA.js'), 'utf8');
  assert.match(gradia, /const stripTemperatureAfterExtra = !\('temperature' in body\);[\s\S]{0,160}if \(stripTemperatureAfterExtra\) delete finalBody\.temperature;/);
});

test('Stage 1C: HAYAKU registers body interceptor on runtime native mode switch, scopes circuit breaker with TTL, invalidates recoveryVaultCache, and allows v1 ledger in health/maintenance', () => {
  const src = fs.readFileSync(path.join(PLUGINS, 'HAYAKU_Locator_Continuity.js'), 'utf8');
  assert.match(src, /if \(promptCacheModeOf\(settings\) === 'native' && Memory\.promptCache\.registered !== true && !Memory\.promptCache\.registerAttempted\)/);
  assert.match(src, /const scopePart = text\(Memory\.currentScopeKey \|\| Memory\.projectionCacheScopeKey \|\| 'global'\);/);
  assert.match(src, /nowAt - Number\(state\.openedAt \|\| 0\) >= 600000/);
  assert.match(src, /Memory\.globalRoutingCatalogCache\?\.clear\?\.\(\)/);
  assert.match(src, /STORAGE_LEDGER_COMPAT_VERSIONS\.has\(value\?\.version\)/);
  assert.match(src, /!STORAGE_LEDGER_COMPAT_VERSIONS\.has\(value\.version\)/);
});

test('Stage 1D: LIBRA maintenance awaits hr.inspect/preview, story-arc waits for applied=true, same-space vector fallback/backup work, and Flashback digest/v0.1 migration hardened', () => {
  const libra = fs.readFileSync(path.join(PLUGINS, 'LIBRA.js'), 'utf8');
  assert.match(libra, /if \(hr\) derivedInspect = await hr\.inspect\(\);/);
  assert.match(libra, /const preview = await hr\.preview\(\);/);
  assert.match(libra, /if \(!applied\) \{\s*return \{ schema:__LIBRA_STORY_ARC_MIGRATION_SCHEMA, scopeKey, verified:false, status:'pending_continuity_state'/);
  assert.match(libra, /let fallbackKey = string\(row\.ref\?\.vectorKey \|\| ''\);/);
  assert.match(libra, /matchingVectorProfile\(nativeVectorKey\[3\]\)/);

  const fb = fs.readFileSync(path.join(PLUGINS, 'Flashback_Memory.js'), 'utf8');
  assert.match(fb, /text\(parsed\.digest\|\|''\)!==memorySuiteFlashbackVectorShardDigest\(\{scopeKey:parsed\.scopeKey/);
  assert.match(fb, /if \(legacy\.readFailed \|\| \(!legacy\.records\.length/);
});

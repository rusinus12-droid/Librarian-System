'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.resolve(__dirname, '..', 'plugins', 'LIBRA.js'), 'utf8');

assert.match(source, /libra\.embedding_multilingual_probe\.v1/);
assert.match(source, /Object\.freeze\(\['ko', 'en'\]\).*Object\.freeze\(\['en', 'ko'\]\)/s);
assert.match(source, /Object\.freeze\(\['ko', 'ja'\]\).*Object\.freeze\(\['ja', 'ko'\]\)/s);
assert.match(source, /Object\.freeze\(\['ko', 'zh'\]\).*Object\.freeze\(\['zh', 'ko'\]\)/s);
assert.match(source, /semanticRankingSupported/);
assert.match(source, /gateReadiness/);
assert.match(source, /options\.multilingualProbe !== false/);
assert.match(source, /testEmbeddingConnection[\s\S]*?multilingualProbe: true[\s\S]*?gateHighCosine/);
// The embedding settings page shows the multilingual diagnostic in its "다국어 · Adapter 진단 결과" fold,
// reading the probe the last real connection test recorded.
assert.match(source, /guiEl\('summary',\{text:'다국어 · Adapter 진단 결과'\}\),\(\)=>guiEl\('div',\{class:'fold__body'\},\[guiEl\('pre',\{text:JSON\.stringify\(\{probe:LibraMemoryCore\.getLastMultilingualEmbeddingProbe\?\.\(\)/);
// Before any real provider call there is no probe result: the diagnostic reads null, never a fabricated pass.
assert.match(source, /lastMultilingualEmbeddingProbe: null,/);
assert.match(source, /const getLastMultilingualEmbeddingProbe = \(\) => clone\(state\.lastMultilingualEmbeddingProbe \|\| Runtime\.lastMultilingualEmbeddingProbe \|\| null\);/);
assert.match(source, /state\.lastMultilingualEmbeddingProbe = clone\(result\?\.multilingualProbe \|\| \{[\s\S]{0,120}status: result\?\.ok \? 'unverified' : 'failed'/,
  'a connection test without a probe result is recorded as unverified/failed, not verified');
assert.doesNotMatch(source, /MULTILINGUAL_PROBE[\s\S]{0,200}writeObject|MULTILINGUAL_PROBE[\s\S]{0,200}setItem/);

process.stdout.write('libra_multilingual_recall_contract_test: PASS\n');

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
assert.match(source, /다국어 리콜 진단/);
assert.match(source, /아직 실제 provider 호출을 하지 않았습니다/);
assert.doesNotMatch(source, /MULTILINGUAL_PROBE[\s\S]{0,200}writeObject|MULTILINGUAL_PROBE[\s\S]{0,200}setItem/);

process.stdout.write('libra_multilingual_recall_contract_test: PASS\n');

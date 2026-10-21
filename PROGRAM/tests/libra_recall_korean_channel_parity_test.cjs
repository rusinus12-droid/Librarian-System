'use strict';

// LIBRA 9c03c35 retired the BM25F recall compute (plugin-local kernel and the
// `libra.recall-bm25f.v1` server operation). Lexical recall is now served only
// by the unified memory graph index, whose lexical postings are keyed by the
// index tokenizer. This test keeps the original intent against that serving
// path: the plugin-embedded index and the shipped tool module must tokenize
// identically, a particle-stripped complete Korean name is lexical evidence, a
// longer name or Latin word that merely starts with the query is not, and CJK
// a CJK word is evidence only as a complete delimited term (no CJK segmentation).

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'plugins', 'LIBRA.js'), 'utf8');
const startMarker = '(function createMemoryGraphIndex(';
const endMarker = '\n});\n    const createLibraMemoryGraphCorpus =';
const start = source.indexOf(startMarker);
const end = source.indexOf(endMarker, start);
assert.ok(start >= 0 && end > start, 'LIBRA embeds the unified memory graph index');
const createPluginIndex = vm.runInNewContext(source.slice(start, end + 3));
const createToolIndex = require('../tools/libra_memory_graph_index.cjs');
const adapter = { pages: { measure() { return 0; }, page() { return { items: [], nextOffset: 0 }; } }, fingerprint: () => 'a'.repeat(64) };
const pluginTokenize = createPluginIndex(adapter).tokenize;
const toolTokenize = createToolIndex(adapter).tokenize;
assert.match(source.slice(start, end), /tokenizerVersion = 'libra\.tokenizer\.nfkc_ko_particle_v2'/);

const plain = value => JSON.parse(JSON.stringify(value));
// A lexical posting hit exists only when a query term is also a document term.
const score = (queryText, documents) => {
  const query = plain(pluginTokenize(queryText));
  assert.deepEqual(plain(toolTokenize(queryText)), query, 'plugin and tool index must tokenize the query identically');
  return Object.fromEntries(documents.map(([id, text]) => {
    const terms = plain(pluginTokenize(text));
    assert.deepEqual(plain(toolTokenize(text)), terms, 'plugin and tool index must tokenize documents identically');
    return [id, { evidence: query.filter(term => terms.includes(term)).length }];
  }));
};

const korean = score('도현', [
  ['partial', '도현욱이 도서관에 왔다.'],
  ['complete', '도현은 도서관에 왔다.'],
  ['unrelated', '민아는 정원에 있었다.']
]);
assert.equal(korean.partial.evidence, 0, 'a longer name is not strong lexical evidence');
assert.ok(korean.complete.evidence > 0, 'particle-stripped complete name supplies evidence');
assert.equal(korean.unrelated.evidence, 0);

const latin = score('Alice', [
  ['partial', 'Aliceville is a city.'], ['complete', 'Alice visited the city.']
]);
assert.equal(latin.partial.evidence, 0);
assert.ok(latin.complete.evidence > 0);

// The unified tokenizer does not segment CJK: a kana/kanji run delimited by punctuation or spaces is one
// posting term. A complete CJK word is lexical evidence; a term merely contained in a longer run is not.
const cjk = score('図書館', [
  ['match', '図書館、赤い傘を見つけた。'], ['contained', '図書館で赤い傘を見つけた。'], ['other', '駅、青い傘を見つけた。']
]);
assert.ok(cjk.match.evidence > 0, 'a complete CJK word delimited by punctuation is lexical evidence');
assert.equal(cjk.contained.evidence, 0, 'a CJK term inside a longer unsegmented run is not lexical evidence');
assert.equal(cjk.other.evidence, 0);

console.log('PASS libra_recall_korean_channel_parity_test');

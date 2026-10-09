'use strict';

const assert = require('node:assert/strict');
const { executeOperation, definitionFor } = require('../server/compute/registry.cjs');

const text = value => {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(text).filter(Boolean).join('\n');
  if (typeof value === 'object') {
    if (typeof value.text === 'string') return value.text;
    if (typeof value.content === 'string') return value.content;
    if (Array.isArray(value.content)) return value.content.map(text).filter(Boolean).join('\n');
    if (Array.isArray(value.parts)) return value.parts.map(text).filter(Boolean).join('\n');
    try { return JSON.stringify(value); } catch (_) { return String(value); }
  }
  return String(value);
};

const fnv1a = value => {
  let hash = 0x811c9dc5;
  const source = text(value);
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
};

const pluginReferenceHashEmbedding = (value, dimensions = 384) => {
  const parsed = Number.parseInt(dimensions, 10);
  const dims = Number.isFinite(parsed) ? Math.max(64, Math.min(4096, parsed)) : 384;
  const vector = new Array(dims).fill(0);
  const source = text(value).toLowerCase();
  const tokens = source.match(/[a-z0-9가-힣一-龥ぁ-んァ-ン]{1,}/g) || [];
  let gramCount = 0;
  const addGram = gram => {
    if (gramCount >= 4000) return false;
    const hash = fnv1a(gram);
    vector[hash % dims] += (hash & 1 ? 1 : -1) * (1 + Math.min(gram.length, 8) / 8);
    gramCount += 1;
    return gramCount < 4000;
  };
  for (const token of tokens) {
    if (!addGram(token)) break;
    if (token.length >= 2) {
      const characters = Array.from(token);
      let keepGoing = true;
      for (let size = 2; size <= Math.min(4, characters.length); size += 1) {
        for (let offset = 0; offset <= characters.length - size; offset += 1) {
          keepGoing = addGram(characters.slice(offset, offset + size).join(''));
          if (!keepGoing) break;
        }
        if (!keepGoing) break;
      }
      if (!keepGoing) break;
    }
  }
  const norm = Math.sqrt(vector.reduce((sum, number) => sum + (number * number), 0)) || 1;
  return vector.map(number => number / norm);
};

const fixtures = [
  'Hello HELLO memory-suite 123',
  '도현은 보라를 믿는다. 기억 회상 테스트',
  '世界線の記憶 テスト 123',
  ['first', '두 번째', { text: 'third' }],
  { content: [{ text: 'alpha' }, '베타'], parts: ['ignored because content wins'] },
  'a'.repeat(6000)
];

for (const dimensions of [64, 384, 1024, 'invalid']) {
  const actual = executeOperation('flashback.hash-embedding-batch.v1', { texts: fixtures, dimensions });
  const expectedDimensions = Number.isFinite(Number.parseInt(dimensions, 10))
    ? Math.max(64, Math.min(4096, Number.parseInt(dimensions, 10)))
    : 384;
  assert.equal(actual.dimensions, expectedDimensions);
  assert.equal(actual.count, fixtures.length);
  assert.deepEqual(actual.vectors, fixtures.map(value => pluginReferenceHashEmbedding(value, dimensions)));
}

const definition = definitionFor('flashback.hash-embedding-batch.v1');
assert.match(definition.fingerprint, /^[a-f0-9]{64}$/);
assert.deepEqual(definition.namespaces, ['flashback']);
assert.throws(
  () => executeOperation('flashback.hash-embedding-batch.v1', { texts: new Array(513).fill('x'), dimensions: 384 }),
  /compute_flashback_hash_texts_invalid/
);
assert.throws(
  () => executeOperation('flashback.hash-embedding-batch.v1', { texts: new Array(65).fill('x'), dimensions: 4096 }),
  /compute_flashback_hash_vector_limit_exceeded/
);

process.stdout.write('compute_hash_embedding_parity_test: PASS\n');

'use strict';
// GRADIA multi-owner evidence: relevance ordering and linear packing.
// Runs the real functions extracted from plugins/GRADIA.js.
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), assert = require('node:assert/strict');
const { test } = require('node:test');
const source = fs.readFileSync(path.join(__dirname, '../plugins/GRADIA.js'), 'utf8');
const start = source.indexOf('  const escapeLibEvidenceJson ='), end = source.indexOf('  const libNativePromptView =', start);
assert.ok(start > 0 && end > start, 'GRADIA evidence helpers are present');
const context = vm.createContext({ TextEncoder, REFERENCE_BUDGET_CUSTOM_MAX_CHARS: 240000, LIB_EVIDENCE_MAX_BYTES: 4 * 1024 * 1024,
  libEvidenceError: code => Object.assign(new Error(code), { code }) });
vm.runInContext(source.slice(start, end) + '\nObject.assign(globalThis,{renderLibEvidence,createLibEvidencePacker,orderLibEvidenceCandidates,LIB_EVIDENCE_RECENT_PER_OWNER});', context);
const { renderLibEvidence, createLibEvidencePacker, LIB_EVIDENCE_RECENT_PER_OWNER } = context;
// Results come from another VM realm; copy into this realm before deep comparison.
const orderLibEvidenceCandidates = (...args) => Array.from(context.orderLibEvidenceCandidates(...args));
const SCHEMA = 'gradia.lib-server-evidence.v1';
const item = (owner, index, content) => ({ id: `${owner}:${index}`, owner, key: `k${index}`, source: { turnIds: [index] }, content });

test('newest items of every owner come first, then relevance, then newest-first', () => {
  const owners = ['libra', 'hayaku', 'flashback'];
  const queues = new Map(owners.map(owner => [owner, Array.from({ length: 6 }, (_, i) => item(owner, i, `${owner} 평범한 기록 ${i}`))]));
  queues.get('hayaku')[0] = item('hayaku', 0, '유나가 조개 목걸이를 건넸다');
  const order = orderLibEvidenceCandidates(queues, owners, '유나가 준 목걸이');
  assert.equal(LIB_EVIDENCE_RECENT_PER_OWNER, 2);
  assert.deepEqual(order.slice(0, 6).map(x => x.id), ['libra:5', 'hayaku:5', 'flashback:5', 'libra:4', 'hayaku:4', 'flashback:4'], 'two newest per owner, round robin');
  assert.equal(order[6].id, 'hayaku:0', 'the oldest but relevant record outranks newer unrelated ones');
  assert.deepEqual(order.slice(7, 10).map(x => x.id), ['libra:3', 'hayaku:3', 'flashback:3'], 'unrelated items keep newest-first round robin');
  assert.equal(new Set(order.map(x => x.id)).size, 18, 'every candidate appears exactly once');
});

test('without query overlap the order equals the previous newest-first round robin', () => {
  const owners = ['libra', 'hayaku'];
  const make = () => new Map(owners.map(owner => [owner, Array.from({ length: 4 }, (_, i) => item(owner, i, `${owner} ${i}`))]));
  const previous = []; const pending = make();
  while ([...pending.values()].some(q => q.length)) for (const owner of owners) { const x = pending.get(owner).pop(); if (x) previous.push(x.id); }
  assert.deepEqual(orderLibEvidenceCandidates(make(), owners, '전혀 관계없는 질문').map(x => x.id), previous);
  assert.deepEqual(orderLibEvidenceCandidates(make(), owners, '').map(x => x.id), previous);
});

test('linear packer makes the same accept/skip decisions as full rendering', () => {
  let seed = 7; const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let round = 0; round < 300; round += 1) {
    const items = Array.from({ length: 1 + Math.floor(random() * 30) }, (_, i) => ({ ...item(['libra', 'hayaku', 'flashback'][i % 3], i,
      '기록<&>{}[]  '.repeat(1 + Math.floor(random() * 20)) + 'x'.repeat(Math.floor(random() * 200))),
      ...(random() < 0.3 ? { provenance: [{ owner: 'hayaku', id: 'p', key: 'q', source: {} }] } : {}) }));
    const limits = { maxChars: 400 + Math.floor(random() * 4000), maxBytes: 600 + Math.floor(random() * 9000) };
    const full = [];
    for (const candidate of items) {
      try { renderLibEvidence({ schema: SCHEMA, evidenceRevision: 'r', items: [...full, candidate] }, limits); full.push(candidate); }
      catch (error) { if (error.code !== 'LIB_READ_PROMPT_BUDGET_EXCEEDED') throw error; }
    }
    const packer = createLibEvidencePacker(SCHEMA, 'r', limits);
    const linear = items.filter(candidate => packer.tryAdd(candidate));
    assert.deepEqual(linear.map(x => x.id), full.map(x => x.id), `round ${round}`);
  }
});

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./libra_recall_test_runtime.cjs');
const clone = value => JSON.parse(JSON.stringify(value));
const acorn = require('acorn');

async function setup() {
  const r = await load({ transformCode(code) {
    const nodes = [], pending = [acorn.parse(code, { ecmaVersion: 'latest' })];
    while (pending.length) {
      const node = pending.pop(); if (!node || typeof node !== 'object') continue; nodes.push(node);
      for (const value of Object.values(node)) if (Array.isArray(value)) pending.push(...value); else if (value && typeof value === 'object') pending.push(value);
    }
    const one = name => { const found = nodes.filter(n => n.type === 'VariableDeclarator' && n.id?.name === name); assert.equal(found.length, 1, 'real ' + name + ' seam'); return found[0].init.body; };
    const validation = one('validateIntegrityMetaCore'), checksum = one('computeRecordChecksum');
    assert.equal(validation.type, 'BlockStatement'); assert.notEqual(checksum.type, 'BlockStatement');
    const edits = [
      { at: validation.start + 1, text: 'globalThis.__READ_PASS_VALIDATIONS__=(globalThis.__READ_PASS_VALIDATIONS__||0)+1;' },
      { at: checksum.start, text: '(globalThis.__READ_PASS_CHECKSUMS__=(globalThis.__READ_PASS_CHECKSUMS__||0)+1,' },
      { at: checksum.end, text: ')' }
    ];
    for (const edit of edits.sort((a,b) => b.at - a.at)) code = code.slice(0,edit.at) + edit.text + code.slice(edit.at);
    const i = code.lastIndexOf('})();');
    return code.slice(0, i) + '\n;globalThis.__READ_PASS_CORPUS__=TypedRecallCorpus;\n' + code.slice(i);
  } });
  const corpus = r.context.__READ_PASS_CORPUS__;
  const scope = corpus.capture(r.char, r.chat, { currentTurn: 20 }).scopeKey;
  const signed = (record, domain) => {
    const copy = clone(record);
    r.api.IntegrityMetaManager.applyIntegrityMeta(copy, { domain, recordId: record.id, scopeKey: scope, turn: 2 });
    return copy;
  };
  const entry = (comment, record) => ({ comment, key: comment + '::' + record.id, content: JSON.stringify(signed(record, comment === 'lmai_entity' ? 'entity' : 'relation')) });
  const entities = Array.from({ length: 12 }, (_, i) => ({ id: 'person-' + i, name: 'Observer ' + i,
    meta: { created: 2, aliases: ['Witness-' + i, 'Witness-' + i] }, currentState: { summary: 'Checkpoint ' + i } }));
  const relations = Array.from({ length: 6 }, (_, i) => ({ id: 'link-' + i, entityA: 'Witness-' + (i * 2), entityB: 'Observer ' + (i * 2 + 1),
    relationType: 'survey partners', currentStatus: { summary: 'Route observation ' + i, privateLayer: 'PRIVATE-HOLDOUT-' + i }, meta: { created: 2 } }));
  r.chat.localLore = [...entities.map(e => entry('lmai_entity', e)), ...relations.map(e => entry('lmai_relation', e))];
  return { ...r, corpus, signed, entry, entities, relations, snapshot: () => corpus.capture(r.char, r.chat, { currentTurn: 20, viewerId: 'main_request' }) };
}

test('public synchronous enumeration reuses only witnessed checksums; every decision and later pass revalidates', async t => {
  const r = await setup(), before = JSON.stringify(r.chat.localLore), snapshot = r.snapshot();
  r.context.__READ_PASS_VALIDATIONS__ = 0;
  r.context.__READ_PASS_CHECKSUMS__ = 0;
  const units = r.corpus.enumerate(snapshot);
  assert.equal(units.length, r.entities.length);
  for (const [i, unit] of units.entries()) {
    assert.match(unit.text, new RegExp('Route observation ' + Math.floor(i / 2)));
    assert.ok(!unit.text.includes('PRIVATE-HOLDOUT'));
    assert.equal(unit.sourceRefs.length, 2);
  }
  assert.equal(JSON.stringify(r.chat.localLore), before);
  const count = r.context.__READ_PASS_VALIDATIONS__;
  t.diagnostic(`strict validations=${count}; checksums=${r.context.__READ_PASS_CHECKSUMS__}; unique signed sources=${r.entities.length + r.relations.length}`);
  assert.ok(count >= r.entities.length + r.relations.length, 'every public source validation still runs');
  assert.equal(r.context.__READ_PASS_CHECKSUMS__, r.entities.length + r.relations.length, 'each unchanged source hashes once within this public synchronous enumeration');
  const again = r.corpus.enumerate(snapshot);
  assert.equal(JSON.stringify(again), JSON.stringify(units));
  assert.ok(r.context.__READ_PASS_VALIDATIONS__ > count, 'a later independent pass must validate again');
  units[0].record.currentState.summary = 'tampered after enumeration';
  const resolved = r.corpus.resolve(units[0].identity, snapshot);
  assert.equal(resolved.record.currentState.summary, 'Checkpoint 0', 'later binding reads canonical source rather than a mutated derived record');
  assert.ok(!resolved.text.includes('tampered after enumeration'));
});

test('new source, alias ambiguity, corrupt relation, scope, and deletion do not reuse an earlier verdict', async () => {
  const r = await setup();
  const initial = r.corpus.enumerate(r.snapshot());
  const first = r.entities[0];
  first.meta.aliases = ['Replacement witness'];
  first.currentState.summary = 'NEW-CHECKPOINT';
  r.chat.localLore[0] = r.entry('lmai_entity', first);
  const changed = r.corpus.enumerate(r.snapshot());
  assert.match(changed[0].text, /NEW-CHECKPOINT/);
  assert.ok(!changed[0].text.includes('Route observation 0'), 'old alias no longer connects the relation');
  assert.notEqual(changed[0].dependencyHash, initial[0].dependencyHash);
  first.meta.aliases = ['Witness-0'];
  r.chat.localLore[0] = r.entry('lmai_entity', first);
  const ambiguous = clone(r.entities[2]); ambiguous.meta.aliases = ['Witness-0'];
  r.chat.localLore[2] = r.entry('lmai_entity', ambiguous);
  assert.ok(!r.corpus.enumerate(r.snapshot())[0].text.includes('Route observation 0'), 'ambiguous aliases must fail closed');
  r.chat.localLore[2] = r.entry('lmai_entity', r.entities[2]);
  const relation = JSON.parse(r.chat.localLore[12].content); relation.currentStatus.summary = 'CORRUPTED-PUBLIC';
  r.chat.localLore[12].content = JSON.stringify(relation);
  assert.ok(!r.corpus.enumerate(r.snapshot())[0].text.includes('CORRUPTED-PUBLIC'));
  r.chat.localLore[12] = r.entry('lmai_relation', r.relations[0]);
  r.chat.localLore.splice(0, 1);
  assert.ok(r.corpus.enumerate(r.snapshot()).every(u => u.locator.id !== 'person-0'));
  r.chat.id = 'foreign-current-chat';
  const foreign = r.snapshot();
  for (const u of r.corpus.enumerate(foreign)) assert.equal(r.corpus.inspect(u, foreign, {}).eligible, false);
});
